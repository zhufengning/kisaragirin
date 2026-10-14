import {type ChildProcess, spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {Logger} from '@lib/util/logger';

/** pi CLI 在 rpc 模式下的启动配置 */
export interface PiRpcClientOptions {
    /** pi CLI 命令，默认 pi */
    command?: string;
    /** 追加在 `--mode rpc` 之后的命令行参数，默认 ['--no-session'] */
    args?: string[];
    /** 子进程环境变量，覆盖 process.env 中的同名变量 */
    env?: Record<string, string>;
    /** 子进程工作目录，默认 process.cwd() */
    cwd?: string;
}

/** 一条 prompt 从提交到 agent 完成的默认超时时间（毫秒） */
export const PI_RPC_DEFAULT_TIMEOUT_MS = 1_800_000;

/** 关闭子进程时每次等待退出的时间（毫秒） */
const EXIT_WAIT_MS = 2000;

/** 错误信息中附带的最大 stderr 行数 */
const STDERR_TAIL_LINES = 20;

/** 需要客户端回应的扩展对话框方法 */
const DIALOG_METHODS = ['select', 'confirm', 'input', 'editor'];

interface PiRpcResponse {
    type: 'response';
    id?: string;
    command: string;
    success: boolean;
    error?: string;
    data?: unknown;
}

interface PendingCommand {
    resolve: (response: PiRpcResponse) => void;
    reject: (error: Error) => void;
}

type PiRpcRecord = Record<string, unknown> & {type: string};

/**
 * pi CLI rpc 模式的子进程客户端：以严格 JSONL 协议提交一条 prompt，
 * 等待 agent_settled 后取回最后一条 assistant 消息的文本。
 *
 * 无人值守运行，扩展对话框（select/confirm/input/editor）一律以 cancelled 回应，
 * 避免子进程等待终端输入而挂起。
 */
export class PiRpcClient {
    private command: string;
    private args: string[];
    private env: Record<string, string>;
    private cwd: string;
    private logger = new Logger();
    private process: ChildProcess | null = null;
    private pendingCommands = new Map<string, PendingCommand>();
    private runSettledWaiter: ((aborted: boolean) => void) | null = null;
    private nextRequestId = 0;
    private stdoutDecoder = new StringDecoder('utf8');
    private stdoutBuffer = '';
    private stderrDecoder = new StringDecoder('utf8');
    private stderrBuffer = '';
    private stderrTail: string[] = [];
    private failure: Error | null = null;
    private assistantError: Error | null = null;

    constructor (options: PiRpcClientOptions = {}) {
        this.command = options.command ?? 'pi';
        this.args = options.args ?? ['--no-session'];
        this.env = options.env ?? {};
        this.cwd = options.cwd ?? process.cwd();
    }

    async start (): Promise<void> {
        if (this.process) throw new Error('pi rpc client already started');

        const child = spawn(this.command, ['--mode', 'rpc', ...this.args], {
            cwd: this.cwd,
            env: {...process.env, ...this.env},
            stdio: ['pipe', 'pipe', 'pipe']
        });
        this.process = child;

        child.stdout!.on('data', (chunk: Buffer) => this.handleStdoutChunk(chunk));
        child.stderr!.on('data', (chunk: Buffer) => this.handleStderrChunk(chunk));

        child.on('exit', (code, signal) => {
            if (this.process !== child) return;
            this.fail(new Error(
                `pi rpc process exited (code=${code} signal=${signal})${this.stderrSuffix()}`
            ));
        });
        child.on('error', error => {
            if (this.process !== child) return;
            this.fail(new Error(`pi rpc process error: ${error.message}${this.stderrSuffix()}`));
        });
        child.stdin!.on('error', error => {
            if (this.process !== child) return;
            this.fail(new Error(`pi rpc stdin error: ${error.message}${this.stderrSuffix()}`));
        });

        await new Promise<void>((resolve, reject) => {
            child.once('spawn', () => resolve());
            child.once('error', error => reject(error));
        });
        this.logger.debug(`[PiRpc] started command=${this.command} cwd=${this.cwd}`);
    }

    /** 提交一条 prompt，等待 agent 结束并返回最后一条 assistant 消息的文本 */
    async promptAndGetText (message: string, timeoutMs: number = PI_RPC_DEFAULT_TIMEOUT_MS): Promise<string> {
        if (this.failure) throw this.failure;
        if (this.runSettledWaiter) throw new Error('pi rpc run already in progress');

        this.assistantError = null;
        const settled = new Promise<boolean>(resolve => {
            this.runSettledWaiter = resolve;
        });

        const timeout = setTimeout(() => {
            this.fail(new Error(`pi rpc prompt timed out after ${timeoutMs}ms${this.stderrSuffix()}`));
            void this.stop();
        }, timeoutMs);

        try {
            const response = await this.send({type: 'prompt', message});
            const disposition = this.getData<{disposition: string}>(response).disposition;
            if (disposition !== 'started') {
                throw new Error(`pi rpc prompt not started (disposition=${disposition})`);
            }

            const aborted = await settled;
            if (this.failure) throw this.failure;
            if (aborted) throw new Error('pi rpc run aborted');
            if (this.assistantError) throw this.assistantError;

            const text = await this.getLastAssistantText();
            if (text === null || text.trim().length === 0) {
                throw new Error('pi rpc run returned empty assistant text');
            }
            return text;
        } finally {
            clearTimeout(timeout);
            this.runSettledWaiter = null;
        }
    }

    /** 关闭子进程：先关闭 stdin 请求有序退出，超时后依次发送 SIGTERM 与 SIGKILL */
    async stop (): Promise<void> {
        const child = this.process;
        if (!child) return;

        this.process = null;
        this.rejectPendingCommands(new Error('pi rpc client stopped'));
        this.resolveRunSettled(false);

        child.stdin?.end();
        if (!await this.waitForExit(child, EXIT_WAIT_MS)) {
            child.kill('SIGTERM');
            if (!await this.waitForExit(child, EXIT_WAIT_MS)) {
                child.kill('SIGKILL');
                await this.waitForExit(child, EXIT_WAIT_MS);
            }
        }
        this.logger.debug('[PiRpc] stopped');
    }

    private async getLastAssistantText (): Promise<string | null> {
        const response = await this.send({type: 'get_last_assistant_text'});
        return this.getData<{text: string | null}>(response).text;
    }

    private handleStdoutChunk (chunk: Buffer): void {
        this.stdoutBuffer += this.stdoutDecoder.write(chunk);

        let newlineIndex = this.stdoutBuffer.indexOf('\n');
        while (newlineIndex !== -1) {
            const line = this.stdoutBuffer.slice(0, newlineIndex);
            this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
            this.handleLine(line.endsWith('\r') ? line.slice(0, -1) : line);
            newlineIndex = this.stdoutBuffer.indexOf('\n');
        }
    }

    private handleStderrChunk (chunk: Buffer): void {
        this.stderrBuffer += this.stderrDecoder.write(chunk);

        let newlineIndex = this.stderrBuffer.indexOf('\n');
        while (newlineIndex !== -1) {
            const line = this.stderrBuffer.slice(0, newlineIndex).trim();
            this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);
            if (line.length > 0) {
                this.stderrTail.push(line);
                if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
                this.logger.debug(`[PiRpc] stderr: ${line}`);
            }
            newlineIndex = this.stderrBuffer.indexOf('\n');
        }
    }

    private handleLine (line: string): void {
        if (line.trim().length === 0) return;

        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            this.fail(new Error(`pi rpc returned invalid JSON: ${line.slice(0, 200)}`));
            return;
        }

        if (typeof parsed !== 'object' || parsed === null || typeof (parsed as {type?: unknown}).type !== 'string') {
            this.fail(new Error(`pi rpc returned unexpected record: ${line.slice(0, 200)}`));
            return;
        }

        const record = parsed as PiRpcRecord;
        if (record.type === 'response') {
            this.handleResponse(record as unknown as PiRpcResponse);
        } else if (record.type === 'extension_ui_request') {
            this.handleExtensionUiRequest(record);
        } else {
            this.trackRunState(record);
        }
    }

    private handleResponse (response: PiRpcResponse): void {
        if (response.id !== undefined) {
            const pending = this.pendingCommands.get(response.id);
            if (pending !== undefined) {
                this.pendingCommands.delete(response.id);
                pending.resolve(response);
                return;
            }
        }
        const detail = typeof response.error === 'string' ? response.error : JSON.stringify(response);
        this.fail(new Error(`pi rpc returned unexpected response: ${detail}`));
    }

    private handleExtensionUiRequest (record: PiRpcRecord): void {
        const method = typeof record.method === 'string' ? record.method : 'unknown';
        if (!DIALOG_METHODS.includes(method)) return;

        this.logger.warn(`[PiRpc] extension dialog cancelled: method=${method} title=${String(record.title)}`);
        const id = record.id;
        if (typeof id === 'string') {
            this.process?.stdin?.write(`${JSON.stringify({
                type: 'extension_ui_response',
                id,
                cancelled: true
            })}\n`);
        }
    }

    private trackRunState (record: PiRpcRecord): void {
        if (record.type === 'message_end') {
            const message = record.message;
            if (typeof message === 'object' && message !== null) {
                this.trackAssistantMessage(message as {role?: unknown; stopReason?: unknown; errorMessage?: unknown});
            }
            return;
        }

        if (record.type === 'agent_settled') {
            this.resolveRunSettled(record.aborted === true);
        }
    }

    private trackAssistantMessage (message: {
        role?: unknown;
        stopReason?: unknown;
        errorMessage?: unknown;
    }): void {
        if (message.role !== 'assistant') return;

        if (message.stopReason !== 'error' && message.stopReason !== 'aborted') {
            this.assistantError = null;
            return;
        }

        const detail = typeof message.errorMessage === 'string' && message.errorMessage.length > 0 ?
            message.errorMessage :
            `assistant message stopped with ${String(message.stopReason)}`;
        this.assistantError = new Error(detail);
    }

    private send (command: Record<string, unknown>): Promise<PiRpcResponse> {
        const child = this.process;
        const stdin = child?.stdin;
        if (!child || !stdin) throw new Error('pi rpc process is not running');
        if (this.failure) throw this.failure;

        const id = `req_${++this.nextRequestId}`;
        return new Promise<PiRpcResponse>((resolve, reject) => {
            this.pendingCommands.set(id, {resolve, reject});
            stdin.write(`${JSON.stringify({...command, id})}\n`);
        });
    }

    private getData<T> (response: PiRpcResponse): T {
        if (!response.success) {
            throw new Error(response.error ?? `pi rpc command failed: ${response.command}`);
        }
        return response.data as T;
    }

    private fail (error: Error): void {
        if (!this.failure) this.failure = error;
        this.rejectPendingCommands(this.failure);
        this.resolveRunSettled(false);
    }

    private rejectPendingCommands (error: Error): void {
        for (const pending of this.pendingCommands.values()) {
            pending.reject(error);
        }
        this.pendingCommands.clear();
    }

    private resolveRunSettled (aborted: boolean): void {
        const waiter = this.runSettledWaiter;
        this.runSettledWaiter = null;
        waiter?.(aborted);
    }

    private waitForExit (child: ChildProcess, timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);

        return new Promise<boolean>(resolve => {
            const onExit = () => {
                clearTimeout(timer);
                resolve(true);
            };
            const timer = setTimeout(() => {
                child.off('exit', onExit);
                resolve(false);
            }, timeoutMs);
            child.once('exit', onExit);
        });
    }

    private stderrSuffix (): string {
        if (this.stderrTail.length === 0) return '';
        return `\nstderr:\n${this.stderrTail.join('\n')}`;
    }
}

/** 启动 pi rpc 子进程，提交一条 prompt，返回最终 assistant 文本 */
export async function runPiRpcPrompt (
    options: PiRpcClientOptions & {message: string; timeoutMs?: number}
): Promise<string> {
    const client = new PiRpcClient(options);
    try {
        await client.start();
        return await client.promptAndGetText(options.message, options.timeoutMs);
    } finally {
        await client.stop();
    }
}

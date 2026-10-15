import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {AssistantMessage} from '@earendil-works/pi-ai';
import type {AppConfig, PiRpcConfig} from '~/config';
import type {Logger} from '@lib/util/logger';

/** 将一次回复流程中的 prompt、模型输出与深度研究产物写入 data/debug/ */
export class ReplyDebugDumper {
    private readonly config: AppConfig;
    private readonly logger: Logger;
    private readonly groupId: number;
    private prefix?: string;

    constructor (options: {config: AppConfig; logger: Logger; groupId: number}) {
        this.config = options.config;
        this.logger = options.logger;
        this.groupId = options.groupId;
    }

    /** 开始新任务时清除上一轮目录；失败或不需导出时保持为空 */
    resetTurn (): void {
        this.prefix = undefined;
    }

    /** 为一个回合建立导出目录；debug_dump_prompt 关闭时不建立 */
    beginTurn (label: string): void {
        this.prefix = this.createPrefix(label);
    }

    dumpSystemPrompt (systemPrompt: string): void {
        this.write('system.txt', systemPrompt);
    }

    dumpUserMessage (index: number, text: string): void {
        this.write(`user-${index}.txt`, text);
    }

    dumpOutput (assistant: AssistantMessage): void {
        this.write('output.json', JSON.stringify(assistant, null, 2));
    }

    dumpMemoryQueryPrompt (prompt: string): void {
        if (!this.write('memory-query-prompt.txt', prompt)) return;
        this.logger.debug(
            `[ReplyAgent] [${this.groupId}] memory query prompt dumped to ` +
            `${this.prefix}/memory-query-*`);
    }

    dumpMemoryQueryResponse (response: unknown): void {
        this.write('memory-query-response.json', JSON.stringify(response, null, 2));
    }

    dumpDeepResearchPrompt (rpcConfig: PiRpcConfig, message: string): void {
        const prefix = this.ensurePrefix('deep-research');
        if (!prefix) return;

        this.write('deep-research-prompt.txt', message);
        this.write(
            'deep-research-rpc.json',
            JSON.stringify({
                command: rpcConfig.command ?? 'pi',
                args: rpcConfig.args ?? ['--no-session'],
                cwd: rpcConfig.cwd ?? process.cwd(),
                env: rpcConfig.env ?? {},
                timeout_ms: rpcConfig.timeout_ms
            }, null, 2)
        );

        this.logger.debug(
            `[ReplyAgent] [${this.groupId}] deep research prompt dumped to ` +
            `${prefix}/deep-research-*`);
    }

    dumpDeepResearchResult (text: string): void {
        const prefix = this.ensurePrefix('deep-research');
        if (!prefix) return;

        this.write('deep-research-result.txt', text);
        this.logger.debug(
            `[ReplyAgent] [${this.groupId}] deep research result dumped to ` +
            `${prefix}/deep-research-result.txt (${text.length} chars)`);
    }

    private ensurePrefix (fallbackLabel: string): string | undefined {
        if (!this.prefix) {
            this.prefix = this.createPrefix(fallbackLabel);
        }
        return this.prefix;
    }

    private createPrefix (label: string): string | undefined {
        if (!this.config.input.debug_dump_prompt) return;

        const ts = new Date().toISOString()
            .replace(/:/g, '-');
        return `${this.groupId}/${label}/${ts}`;
    }

    private write (name: string, content: string): boolean {
        if (!this.prefix) return false;

        const dir = join('data', 'debug', this.prefix);
        mkdirSync(dir, {recursive: true});
        writeFileSync(join(dir, name), content, 'utf-8');
        return true;
    }
}

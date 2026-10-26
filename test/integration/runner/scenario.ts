import {fork, type ChildProcess} from 'node:child_process';
import {createWriteStream, existsSync, readFileSync, writeFileSync, mkdirSync, type WriteStream} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import type {AppConfig} from '../../../src/config';
import {ScenarioArtifacts} from './artifacts';
import {FakeOneBotServer} from '../fakes/onebot-server';
import {FakeOpenAIServer, type ModelResponseRule} from '../fakes/openai-completions-server';
import {FakeAssetServer} from '../fakes/asset-server';
import {DatabaseInspector} from './database-inspector';
import {createTestConfig, type TestConfigOverrides} from '../app/create-test-config';
import {sleep, waitFor} from './wait-for';

const CHILD_MODULE = join(import.meta.dirname, '..', 'app', 'child.ts');
const GRAPHITI_SERVER = join(import.meta.dirname, '..', 'fakes', 'graphiti_server.py');

export interface FakeGraphitiOptions {
    searchFacts?: Array<Record<string, unknown> & {fact: string}>;
    searchNodes?: Array<{name: string; summary?: string}>;
    searchGate?: string;
    addEpisodeGate?: string;
    searchError?: {code: number; message: string};
    searchNodesError?: {code: number; message: string};
    addEpisodeDelayMs?: number;
}

export interface ScenarioOptions extends TestConfigOverrides {
    name: string;
    groups: number[];
    /** 按 channel（模型 id 或 模型id/group-<id>）配置响应序列 */
    channels?: Record<string, ModelResponseRule[]>;
    graphiti?: FakeGraphitiOptions;
}

interface ChildMessage {
    type: 'alive' | 'ready' | 'stopped' | 'error';
    detail?: string;
}

interface MessageWaiter {
    type: ChildMessage['type'];
    resolve: (message: ChildMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

/** 应用子进程：通过 IPC 控制 start/stop，stdout/stderr 写入场景目录 */
export class AppProcess {
    private child: ChildProcess | null = null;
    private waiters: MessageWaiter[] = [];
    private received: ChildMessage[] = [];
    private output: WriteStream | null = null;
    private readonly scenarioDir: string;
    private readonly config: AppConfig;
    private readonly dbPath: string;
    private readonly graphitiServerPath?: string;
    private readonly childEnv: Record<string, string>;

    constructor (options: {
        scenarioDir: string;
        config: AppConfig;
        dbPath: string;
        graphitiServerPath?: string;
        childEnv?: Record<string, string>;
    }) {
        this.scenarioDir = options.scenarioDir;
        this.config = options.config;
        this.dbPath = options.dbPath;
        this.graphitiServerPath = options.graphitiServerPath;
        this.childEnv = options.childEnv ?? {};
    }

    get isRunning (): boolean {
        return this.child !== null;
    }

    async start (timeoutMs = 60000): Promise<void> {
        if (this.child) throw new Error('application already started');
        this.output = createWriteStream(join(this.scenarioDir, 'app.out.log'), {flags: 'a'});
        const env: Record<string, string | undefined> = {...process.env, ...this.childEnv};
        // node:test 通过 NODE_TEST_CONTEXT 标记测试进程，子进程继承后会进入测试报告模式
        delete env.NODE_TEST_CONTEXT;
        const child = fork(CHILD_MODULE, [], {
            cwd: this.scenarioDir,
            execPath: process.execPath,
            execArgv: ['--import', 'tsx'],
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            env
        });
        this.child = child;
        child.stdout?.pipe(this.output);
        child.stderr?.pipe(this.output);
        child.on('message', (message: ChildMessage) => this.onMessage(message));
        child.on('exit', code => this.onExit(code));
        await new Promise<void>(resolve => {
            if (child.connected) {
                resolve();
                return;
            }
            child.once('spawn', () => resolve());
        });
        await this.waitForMessage('alive', timeoutMs);
        child.send({
            type: 'start',
            config: this.config,
            dbPath: this.dbPath,
            graphitiServerPath: this.graphitiServerPath
        });
        const message = await this.waitForMessage('ready', timeoutMs);
        if (message.type === 'error') {
            throw new Error(`application failed to start: ${message.detail}`);
        }
    }

    async stop (timeoutMs = 60000): Promise<void> {
        const child = this.child;
        if (!child) return;
        try {
            child.send({type: 'stop'});
            const message = await this.waitForMessage('stopped', timeoutMs);
            if (message.type === 'error') {
                throw new Error(`application failed to stop: ${message.detail}`);
            }
        } catch (err) {
            child.kill('SIGTERM');
            await this.waitForExit(5000);
            throw err;
        }
        await this.waitForExit(10000);
        this.cleanup();
    }

    private onMessage (message: ChildMessage): void {
        if (message.type === 'error') {
            this.received.push(message);
            this.failWaiters(new Error(`application error: ${message.detail}`));
            return;
        }
        const index = this.waiters.findIndex(waiter => waiter.type === message.type);
        if (index === -1) {
            this.received.push(message);
            return;
        }
        const waiter = this.waiters[index];
        this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
    }

    private onExit (code: number | null): void {
        if (code !== 0 && code !== null) {
            this.failWaiters(new Error(`application exited with code ${code}`));
        } else {
            this.failWaiters(new Error('application exited'));
        }
        this.cleanup();
    }

    private failWaiters (error: Error): void {
        const waiters = this.waiters;
        this.waiters = [];
        for (const waiter of waiters) {
            clearTimeout(waiter.timer);
            waiter.reject(error);
        }
    }

    private waitForMessage (type: ChildMessage['type'], timeoutMs: number): Promise<ChildMessage> {
        const errorIndex = this.received.findIndex(message => message.type === 'error');
        if (errorIndex !== -1) {
            const [errorMessage] = this.received.splice(errorIndex, 1);
            return Promise.reject(new Error(`application error: ${errorMessage.detail}`));
        }
        const bufferedIndex = this.received.findIndex(message => message.type === type);
        if (bufferedIndex !== -1) {
            const [buffered] = this.received.splice(bufferedIndex, 1);
            return Promise.resolve(buffered);
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const index = this.waiters.findIndex(waiter => waiter.timer === timer);
                if (index !== -1) this.waiters.splice(index, 1);
                reject(new Error(`timed out after ${timeoutMs}ms waiting for application message "${type}"`));
            }, timeoutMs);
            this.waiters.push({type, resolve, reject, timer});
        });
    }

    private async waitForExit (timeoutMs: number): Promise<void> {
        const child = this.child;
        if (!child || child.exitCode !== null) return;
        const exited = new Promise<void>(resolve => {
            child.once('exit', () => resolve());
        });
        const timeout = sleep(timeoutMs);
        await Promise.race([exited, timeout]);
    }

    private cleanup (): void {
        this.child = null;
        this.output?.end();
        this.output = null;
        this.received = [];
        this.failWaiters(new Error('application stopped'));
    }
}

/** 场景环境：假服务、应用子进程、数据库检查器与产物目录 */
export class ScenarioEnvironment {
    readonly name: string;
    readonly artifacts: ScenarioArtifacts;
    readonly config: AppConfig;
    readonly oneBot: FakeOneBotServer;
    readonly openAI: FakeOpenAIServer;
    readonly assets: FakeAssetServer;
    readonly graphiti?: FakeGraphitiOptions;
    private readonly graphitiGateDir: string;
    private readonly graphitiCallsPath: string;
    private readonly dbPath: string;
    private readonly childEnv: Record<string, string>;
    private appProcess: AppProcess;
    private inspector: DatabaseInspector | null = null;

    constructor (options: {
        name: string;
        artifacts: ScenarioArtifacts;
        config: AppConfig;
        oneBot: FakeOneBotServer;
        openAI: FakeOpenAIServer;
        assets: FakeAssetServer;
        graphiti?: FakeGraphitiOptions;
        graphitiGateDir: string;
        graphitiCallsPath: string;
        dbPath: string;
        childEnv: Record<string, string>;
    }) {
        this.name = options.name;
        this.artifacts = options.artifacts;
        this.config = options.config;
        this.oneBot = options.oneBot;
        this.openAI = options.openAI;
        this.assets = options.assets;
        this.graphiti = options.graphiti;
        this.graphitiGateDir = options.graphitiGateDir;
        this.graphitiCallsPath = options.graphitiCallsPath;
        this.dbPath = options.dbPath;
        this.childEnv = options.childEnv;
        this.appProcess = this.createAppProcess();
    }

    get dir (): string {
        return this.artifacts.dir;
    }

    get db (): DatabaseInspector {
        if (!this.inspector) {
            throw new Error('database inspector not opened yet');
        }
        return this.inspector;
    }

    private createAppProcess (): AppProcess {
        return new AppProcess({
            scenarioDir: this.dir,
            config: this.config,
            dbPath: this.dbPath,
            graphitiServerPath: this.graphiti ? GRAPHITI_SERVER : undefined,
            childEnv: this.childEnv
        });
    }

    async startApp (): Promise<void> {
        await this.appProcess.start();
        this.openInspector();
    }

    async stopApp (): Promise<void> {
        await this.appProcess.stop();
    }

    async restartApp (): Promise<void> {
        await this.appProcess.stop();
        this.closeInspector();
        this.appProcess = this.createAppProcess();
        await this.startApp();
    }

    private openInspector (): void {
        this.closeInspector();
        this.inspector = new DatabaseInspector(this.dbPath);
    }

    private closeInspector (): void {
        if (this.inspector) {
            this.inspector.close();
            this.inspector = null;
        }
    }

    async waitForGroupMessages (groupId: number, count: number, timeoutMs = 10000): Promise<void> {
        await waitFor(() => this.db.messageCount(groupId) >= count, {
            description: `group ${groupId} message count >= ${count}`,
            timeoutMs
        });
    }

    async waitForLastTriggerId (groupId: number, value: number, timeoutMs = 10000): Promise<void> {
        await waitFor(() => this.db.lastTriggerId(groupId) === value, {
            description: `lastTriggerId for group ${groupId} === ${value}`,
            timeoutMs
        });
    }

    /** 释放假 Graphiti server 的文件闸门 */
    releaseGraphitiGate (gate: string): void {
        writeFileSync(join(this.graphitiGateDir, `${gate}.release`), '', 'utf-8');
    }

    async waitForGraphitiGate (gate: string, timeoutMs = 10000): Promise<void> {
        await waitFor(() => existsSync(join(this.graphitiGateDir, `${gate}.started`)), {
            description: `Graphiti gate "${gate}" started`,
            timeoutMs
        });
    }

    graphitiCalls (): Array<{
        phase: 'start' | 'end';
        seq: number;
        method: string;
        params: Record<string, unknown>;
        at: number;
    }> {
        if (!existsSync(this.graphitiCallsPath)) return [];
        return readFileSync(this.graphitiCallsPath, 'utf-8')
            .split('\n')
            .filter(line => line.trim().length > 0)
            .map(line => JSON.parse(line) as {
                phase: 'start' | 'end';
                seq: number;
                method: string;
                params: Record<string, unknown>;
                at: number;
            });
    }

    async waitForGraphitiCall (
        method: string,
        predicate: (call: {params: Record<string, unknown>}) => boolean = () => true,
        timeoutMs = 10000
    ): Promise<void> {
        await waitFor(() => this.graphitiCalls()
            .some(call => call.phase === 'start' && call.method === method && predicate(call)), {
            description: `Graphiti call "${method}"`,
            timeoutMs
        });
    }

    /** 有界观察窗口：断言模型请求、OneBot 回复与数据库消息都没有增加 */
    async expectNoActivity (options: {windowMs?: number; description: string}): Promise<void> {
        const modelRequests = this.openAI.requestCount();
        const sends = this.oneBot.sentMessages.length;
        const messages = this.db.messageCount();
        await sleep(options.windowMs ?? 300);
        assert.equal(this.openAI.requestCount(), modelRequests,
            `${options.description}: model request count changed`);
        assert.equal(this.oneBot.sentMessages.length, sends,
            `${options.description}: OneBot send count changed`);
        assert.equal(this.db.messageCount(), messages,
            `${options.description}: database message count changed`);
    }

    /** 关闭一切并返回清理阶段发现的问题 */
    async close (): Promise<Error[]> {
        const errors: Error[] = [];
        const openGate = this.openAI.hasUnreleasedGate();
        const openOneBotGate = this.oneBot.hasUnreleasedGate();
        this.openAI.releaseAllGates();
        this.oneBot.releaseAllGates();

        try {
            await this.stopApp();
        } catch (err) {
            errors.push(err instanceof Error ? err : new Error(String(err)));
        }

        const violation = this.openAI.protocolViolations[0];
        if (violation) {
            errors.push(new Error(`model protocol violation: ${violation}`));
        }
        if (openGate) {
            errors.push(new Error(`unreleased model gate: ${openGate}`));
        }
        if (openOneBotGate) {
            errors.push(new Error(`unreleased OneBot gate: ${openOneBotGate}`));
        }
        if (this.openAI.activeCount() !== 0) {
            errors.push(new Error(`active model requests at shutdown: ${this.openAI.activeCount()}`));
        }

        await this.openAI.close();
        await this.oneBot.close();
        await this.assets.close();
        this.closeInspector();
        return errors;
    }

    discardArtifacts (): void {
        this.artifacts.discard();
    }
}

export async function startScenario (options: ScenarioOptions): Promise<ScenarioEnvironment> {
    const artifacts = new ScenarioArtifacts(options.name);
    const oneBot = await FakeOneBotServer.start({artifacts});
    const openAI = await FakeOpenAIServer.start(artifacts, options.channels ?? {});
    const assets = await FakeAssetServer.start();

    let graphitiGateDir = join(artifacts.dir, 'graphiti-gates');
    const graphitiCallsPath = artifacts.path('graphiti-calls.jsonl');
    const childEnv: Record<string, string> = {};

    if (options.graphiti) {
        mkdirSync(graphitiGateDir, {recursive: true});
        const graphitiConfigPath = artifacts.path('graphiti-config.json');
        const graphitiConfig = {
            search: {facts: options.graphiti.searchFacts ?? []},
            search_nodes: {nodes: options.graphiti.searchNodes ?? []},
            add_episode: {delay_ms: options.graphiti.addEpisodeDelayMs ?? 0},
            gates: {
                search: options.graphiti.searchGate,
                search_nodes: options.graphiti.searchGate,
                add_episode: options.graphiti.addEpisodeGate
            },
            errors: {
                search: options.graphiti.searchError,
                search_nodes: options.graphiti.searchNodesError
            }
        };
        const cleanedGates: Record<string, string> = {};
        for (const [method, gate] of Object.entries(graphitiConfig.gates)) {
            if (gate) cleanedGates[method] = gate;
        }
        const cleanedErrors: Record<string, {code: number; message: string}> = {};
        for (const [method, error] of Object.entries(graphitiConfig.errors)) {
            if (error) cleanedErrors[method] = error;
        }
        artifacts.writeJson('graphiti-config.json', {
            search: graphitiConfig.search,
            search_nodes: graphitiConfig.search_nodes,
            add_episode: graphitiConfig.add_episode,
            gates: cleanedGates,
            errors: cleanedErrors
        });
        childEnv.GRAPHITI_FAKE_CONFIG = graphitiConfigPath;
        childEnv.GRAPHITI_FAKE_RECORD = graphitiCallsPath;
        childEnv.GRAPHITI_FAKE_DIR = graphitiGateDir;
    } else {
        graphitiGateDir = join(artifacts.dir, 'graphiti-gates-unused');
    }

    const dbPath = artifacts.path('messages.db');
    const config = createTestConfig({
        ...options,
        onebotHost: oneBot.host,
        onebotPort: oneBot.serverPort,
        openAiBaseUrl: openAI.baseUrl,
        groups: options.groups,
        logFile: artifacts.path('app.log')
    });

    if (options.graphiti) {
        config.ai.graphiti = {
            uv_path: 'uv',
            llm: {api_key: 'graphiti-test-key', model: 'graphiti-test-model'},
            embedder: {api_key: 'embed-test-key', model: 'embed-test-model'}
        };
    }

    artifacts.writeJson('config.json', config);

    const env = new ScenarioEnvironment({
        name: options.name,
        artifacts,
        config,
        oneBot,
        openAI,
        assets,
        graphiti: options.graphiti,
        graphitiGateDir,
        graphitiCallsPath,
        dbPath,
        childEnv
    });
    await env.startApp();
    return env;
}

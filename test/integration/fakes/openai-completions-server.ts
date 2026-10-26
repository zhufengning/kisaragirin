import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {ScenarioArtifacts} from '../runner/artifacts';
import {sleep, waitFor} from '../runner/wait-for';

export interface ReplyToolParams {
    messages: Array<{ref?: number; text: string}>;
    requires_deep_research: boolean;
    deep_research_topic?: string;
}

export type ModelAction =
    | {type: 'replyTool'; params: ReplyToolParams}
    | {type: 'toolCall'; name: string; arguments: unknown}
    | {type: 'rawToolCall'; name: string; argumentsText: string}
    | {type: 'text'; text: string}
    | {type: 'json'; value: unknown}
    | {type: 'httpError'; status: number; body: unknown}
    | {type: 'streamError'; message: string}
    | {type: 'hang'};

export interface ModelResponseRule {
    match?: {
        model?: string;
        channel?: string;
        requestIncludes?: string;
    };
    action: ModelAction;
    gate?: string;
    delayMs?: number;
}

export interface OpenAIChatRequest {
    model: string;
    messages: Array<{role: string; content: unknown}>;
    stream?: boolean;
    tools?: unknown[];
    [key: string]: unknown;
}

export interface RecordedModelRequest {
    index: number;
    channel: string;
    model: string;
    stream: boolean;
    body: OpenAIChatRequest;
    serialized: string;
    ruleIndex: number;
    startedAt: number;
    endedAt?: number;
    activeAtStart: number;
    channelActiveAtStart: number;
    outcome?: string;
    gate?: string;
}

interface GateState {
    startedCount: number;
    startedResolvers: Array<() => void>;
    released: boolean;
    releaseResolvers: Array<() => void>;
}

const GROUP_MARKER_PATTERN = /测试群标记:(group-\d+)/;

/** 假 OpenAI Chat Completions server：按 channel 队列返回流式工具调用与普通文本 */
export class FakeOpenAIServer {
    private http: Server;
    private artifacts: ScenarioArtifacts;
    private channels: Map<string, ModelResponseRule[]>;
    private recorded: RecordedModelRequest[] = [];
    private active = 0;
    private channelActive = new Map<string, number>();
    private gates = new Map<string, GateState>();
    private violations: string[] = [];
    private port = 0;
    private openResponses = new Set<ServerResponse>();

    private constructor (artifacts: ScenarioArtifacts, channels: Record<string, ModelResponseRule[]>) {
        this.artifacts = artifacts;
        this.channels = new Map(
            Object.entries(channels).map(([channel, rules]) => [channel, [...rules]])
        );
        this.http = createServer((req, res) => {
            void this.handle(req, res);
        });
    }

    static async start (
        artifacts: ScenarioArtifacts,
        channels: Record<string, ModelResponseRule[]>
    ): Promise<FakeOpenAIServer> {
        const server = new FakeOpenAIServer(artifacts, channels);
        await new Promise<void>(resolve => {
            server.http.listen(0, '127.0.0.1', resolve);
        });
        server.port = (server.http.address() as AddressInfo).port;
        return server;
    }

    get baseUrl (): string {
        return `http://127.0.0.1:${this.port}/v1`;
    }

    get requests (): RecordedModelRequest[] {
        return this.recorded;
    }

    get protocolViolations (): string[] {
        return this.violations;
    }

    requestCount (): number {
        return this.recorded.length;
    }

    activeCount (): number {
        return this.active;
    }

    activeOnChannel (channel: string): number {
        return this.channelActive.get(channel) ?? 0;
    }

    /** 指定 channel 前缀下尚未消费的响应规则数量 */
    remainingRules (channelPrefix?: string): number {
        let total = 0;
        for (const [channel, rules] of this.channels) {
            if (channelPrefix === undefined || channel === channelPrefix ||
                channel.startsWith(`${channelPrefix}/`)) {
                total += rules.length;
            }
        }
        return total;
    }

    async waitForRequestCount (count: number, timeoutMs = 10000): Promise<void> {
        await waitFor(() => this.recorded.length >= count,
            {description: `model request count >= ${count}`, timeoutMs});
    }

    releaseAllGates (): void {
        for (const gate of Array.from(this.gates.keys())) {
            this.releaseGate(gate);
        }
    }

    async waitForGate (gate: string, timeoutMs = 10000): Promise<void> {
        const state = this.getGate(gate);
        if (state.startedCount > 0) return;
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`model gate "${gate}" was not started within ${timeoutMs}ms`));
            }, timeoutMs);
            state.startedResolvers.push(() => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    releaseGate (gate: string): void {
        const state = this.getGate(gate);
        state.released = true;
        const resolvers = state.releaseResolvers;
        state.releaseResolvers = [];
        resolvers.forEach(resolve => resolve());
    }

    hasUnreleasedGate (): string | undefined {
        for (const [name, state] of this.gates) {
            if (state.startedCount > 0 && !state.released) return name;
        }
        return;
    }

    private getGate (gate: string): GateState {
        let state = this.gates.get(gate);
        if (!state) {
            state = {startedCount: 0, startedResolvers: [], released: false, releaseResolvers: []};
            this.gates.set(gate, state);
        }
        return state;
    }

    private async enterGate (gate: string): Promise<void> {
        const state = this.getGate(gate);
        state.startedCount++;
        const resolvers = state.startedResolvers;
        state.startedResolvers = [];
        resolvers.forEach(resolve => resolve());
        if (state.released) return;
        await new Promise<void>(resolve => {
            state.releaseResolvers.push(resolve);
        });
    }

    private async handle (req: IncomingMessage, res: ServerResponse): Promise<void> {
        const chunks: Buffer[] = [];
        await new Promise<void>(resolve => {
            req.on('data', chunk => chunks.push(Buffer.from(chunk as Buffer)));
            req.on('end', () => resolve());
        });
        const raw = Buffer.concat(chunks).toString('utf-8');
        const body = JSON.parse(raw) as OpenAIChatRequest;
        const marker = GROUP_MARKER_PATTERN.exec(raw)?.[1];
        const channel = marker ? `${body.model}/${marker}` : body.model;

        const selection = this.selectRule(channel, body.model, raw);
        if (!selection) {
            const message = `unmatched model request for channel ${channel} (model=${body.model})`;
            this.violations.push(message);
            this.artifacts.appendJsonl('openai-requests.jsonl', {
                kind: 'violation',
                at: Date.now(),
                channel,
                model: body.model,
                body
            });
            res.writeHead(400, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({error: {message, type: 'protocol_violation'}}));
            return;
        }

        this.active++;
        this.channelActive.set(channel, (this.channelActive.get(channel) ?? 0) + 1);
        const record: RecordedModelRequest = {
            index: this.recorded.length,
            channel,
            model: body.model,
            stream: body.stream === true,
            body,
            serialized: raw,
            ruleIndex: selection.ruleIndex,
            startedAt: Date.now(),
            activeAtStart: this.active,
            channelActiveAtStart: this.channelActive.get(channel) ?? 0,
            gate: selection.rule.gate
        };
        this.recorded.push(record);
        this.artifacts.appendJsonl('openai-requests.jsonl', {
            kind: 'start',
            index: record.index,
            at: record.startedAt,
            channel,
            model: record.model,
            stream: record.stream,
            active: record.activeAtStart,
            channelActive: record.channelActiveAtStart,
            body
        });

        let clientClosed = false;
        res.on('close', () => {
            clientClosed = true;
        });

        try {
            if (selection.rule.gate) {
                await this.enterGate(selection.rule.gate);
            }
            if (selection.rule.delayMs) {
                await sleep(selection.rule.delayMs);
            }
            if (clientClosed) {
                record.outcome = 'client-disconnect';
                return;
            }
            await this.respondAction(res, selection.rule.action, body, record);
            if (record.outcome === undefined) {
                record.outcome = 'completed';
            }
        } finally {
            record.endedAt = Date.now();
            this.active--;
            const channelCount = (this.channelActive.get(channel) ?? 1) - 1;
            this.channelActive.set(channel, Math.max(0, channelCount));
            this.artifacts.appendJsonl('openai-requests.jsonl', {
                kind: 'end',
                index: record.index,
                at: record.endedAt,
                channel,
                outcome: record.outcome
            });
        }
    }

    private selectRule (
        channel: string,
        model: string,
        raw: string
    ): {rule: ModelResponseRule; ruleIndex: number} | undefined {
        const keys = [channel, model, '*'];
        for (const key of keys) {
            const rules = this.channels.get(key);
            if (!rules) continue;
            for (let index = 0; index < rules.length; index++) {
                const rule = rules[index];
                if (rule.match?.channel !== undefined && rule.match.channel !== channel) continue;
                if (rule.match?.model !== undefined && rule.match.model !== model) continue;
                if (rule.match?.requestIncludes !== undefined && !raw.includes(rule.match.requestIncludes)) {
                    continue;
                }
                rules.splice(index, 1);
                return {rule, ruleIndex: index};
            }
        }
        return;
    }

    private async respondAction (
        res: ServerResponse,
        action: ModelAction,
        body: OpenAIChatRequest,
        record: RecordedModelRequest
    ): Promise<void> {
        switch (action.type) {
        case 'hang':
            this.openResponses.add(res);
            record.outcome = 'hanging';
            await new Promise<void>(resolve => {
                res.on('close', () => resolve());
            });
            this.openResponses.delete(res);
            return;
        case 'httpError':
            res.writeHead(action.status, {'Content-Type': 'application/json'});
            res.end(JSON.stringify(action.body));
            return;
        case 'json':
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({
                id: `chatcmpl-${record.index}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: body.model,
                choices: [{
                    index: 0,
                    message: {role: 'assistant', content: JSON.stringify(action.value)},
                    finish_reason: 'stop'
                }],
                usage: {prompt_tokens: 10, completion_tokens: 10, total_tokens: 20}
            }));
            return;
        case 'text':
            this.writeStream(res, record, body.model, [
                {delta: {role: 'assistant', content: action.text}, finishReason: null},
                {delta: {}, finishReason: 'stop'}
            ]);
            return;
        case 'streamError':
            this.writeStream(res, record, body.model, [
                {delta: {}, finishReason: action.message}
            ]);
            return;
        case 'toolCall':
            this.writeToolCallStream(res, record, body.model, action.name, JSON.stringify(action.arguments));
            return;
        case 'rawToolCall':
            this.writeToolCallStream(res, record, body.model, action.name, action.argumentsText);
            return;
        case 'replyTool':
            this.writeToolCallStream(res, record, body.model, 'reply', JSON.stringify(action.params));
            return;
        default:
            throw new Error('unsupported model action');
        }
    }

    private writeToolCallStream (
        res: ServerResponse,
        record: RecordedModelRequest,
        model: string,
        name: string,
        argumentsText: string
    ): void {
        const callId = `call_${record.index}_0`;
        this.writeStream(res, record, model, [
            {
                delta: {
                    role: 'assistant',
                    tool_calls: [{
                        index: 0,
                        id: callId,
                        type: 'function',
                        function: {name, arguments: argumentsText}
                    }]
                },
                finishReason: null
            },
            {delta: {}, finishReason: 'tool_calls'}
        ]);
    }

    private writeStream (
        res: ServerResponse,
        record: RecordedModelRequest,
        model: string,
        chunks: Array<{delta: Record<string, unknown>; finishReason: string | null}>
    ): void {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });
        const base = {
            id: `chatcmpl-${record.index}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model
        };
        for (const chunk of chunks) {
            res.write(`data: ${JSON.stringify({
                ...base,
                choices: [{index: 0, delta: chunk.delta, finish_reason: chunk.finishReason}]
            })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({
            ...base,
            choices: [],
            usage: {prompt_tokens: 100, completion_tokens: 20, total_tokens: 120}
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
    }

    async close (): Promise<void> {
        for (const res of this.openResponses) {
            res.destroy();
        }
        this.openResponses.clear();
        this.http.closeAllConnections();
        await new Promise<void>(resolve => {
            this.http.close(() => resolve());
        });
    }
}

import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {WebSocketServer, WebSocket} from 'ws';
import type {Message} from '@lib/types/messages';
import {ScenarioArtifacts} from '../runner/artifacts';
import {sleep, waitFor} from '../runner/wait-for';

export interface FakeGroupMember {
    userId: number;
    nickname: string;
    card?: string;
}

export interface EmitGroupMessageOptions {
    groupId: number;
    userId?: number;
    senderName?: string;
    senderCard?: string;
    segments: Message[];
    time: number;
}

export interface SentGroupMessage {
    messageId: number;
    groupId: number;
    message: Message[];
    requestedAt: number;
    delivered: boolean;
}

export interface RegisteredMessage {
    messageId: number;
    groupId: number;
    time: number;
    sender: {user_id: number; nickname: string; card?: string};
    message: Message[];
    delayMs?: number;
}

interface FailureConfig {
    status: 'failed';
    retcode: number;
    message: string;
}

interface GateState {
    startedCount: number;
    startedResolvers: Array<() => void>;
    released: boolean;
    releaseResolvers: Array<() => void>;
}

export interface FakeOneBotOptions {
    artifacts: ScenarioArtifacts;
    selfId?: number;
    botNickname?: string;
    botCard?: string;
    groupMembers?: FakeGroupMember[];
}

/**
 * 假 OneBot server：提供 ws 连接、事件注入与 API 响应闸门。
 * 所有事件与 API 请求都记录到场景的 onebot-events.jsonl。
 */
export class FakeOneBotServer {
    private http: Server;
    private wss: WebSocketServer;
    private artifacts: ScenarioArtifacts;
    private selfId: number;
    private botNickname: string;
    private botCard: string;
    private groupMembers: FakeGroupMember[];
    private clients = new Set<WebSocket>();
    private messageIdCounter = 1;
    private sent: SentGroupMessage[] = [];
    private registered = new Map<number, RegisteredMessage>();
    private failures = new Map<string, FailureConfig>();
    private gates = new Map<string, GateState>();
    private sendGateQueue: string[] = [];
    private port = 0;

    private constructor (options: FakeOneBotOptions) {
        this.artifacts = options.artifacts;
        this.selfId = options.selfId ?? 10000;
        this.botNickname = options.botNickname ?? '测试机器人';
        this.botCard = options.botCard ?? '测试机器人';
        this.groupMembers = options.groupMembers ?? [
            {userId: 1001, nickname: '群友甲', card: '甲'},
            {userId: 1002, nickname: '群友乙'}
        ];
        this.http = createServer((_req, res) => {
            res.writeHead(404);
            res.end();
        });
        this.wss = new WebSocketServer({server: this.http});
        this.wss.on('connection', ws => this.onConnection(ws));
    }

    static async start (options: FakeOneBotOptions): Promise<FakeOneBotServer> {
        const server = new FakeOneBotServer(options);
        await new Promise<void>(resolve => {
            server.http.listen(0, '127.0.0.1', resolve);
        });
        server.port = (server.http.address() as AddressInfo).port;
        return server;
    }

    get host (): string {
        return '127.0.0.1';
    }

    get serverPort (): number {
        return this.port;
    }

    setFailure (action: string, failure: FailureConfig): void {
        this.failures.set(action, failure);
    }

    registerMessage (message: RegisteredMessage): void {
        this.registered.set(message.messageId, message);
    }

    /** 让下一次 send_group_msg 响应等待指定闸门释放 */
    gateNextSend (gate: string): void {
        this.sendGateQueue.push(gate);
    }

    async waitForGate (gate: string, timeoutMs = 10000): Promise<void> {
        const state = this.getGate(gate);
        if (state.startedCount > 0) return;
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`OneBot gate "${gate}" was not started within ${timeoutMs}ms`));
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

    releaseAllGates (): void {
        for (const gate of Array.from(this.gates.keys())) {
            this.releaseGate(gate);
        }
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

    /** 注入真实 OneBot 群消息事件，返回分配的消息 id */
    emitGroupMessage (options: EmitGroupMessageOptions): number {
        const messageId = this.messageIdCounter++;
        const event = {
            post_type: 'message',
            message_type: 'group',
            sub_type: 'normal',
            time: options.time,
            self_id: this.selfId,
            message_id: messageId,
            group_id: options.groupId,
            user_id: options.userId ?? 1001,
            message: options.segments,
            raw_message: rawMessageFromSegments(options.segments),
            font: 0,
            sender: {
                user_id: options.userId ?? 1001,
                nickname: options.senderName ?? '群友甲',
                card: options.senderCard
            },
            anonymous: null
        };
        this.artifacts.appendJsonl('onebot-events.jsonl', {kind: 'emit', at: Date.now(), event});
        this.broadcast(event);
        return messageId;
    }

    get sentMessages (): SentGroupMessage[] {
        return this.sent;
    }

    sentMessagesFor (groupId: number): SentGroupMessage[] {
        return this.sent.filter(item => item.groupId === groupId);
    }

    async waitForGroupSendCount (groupId: number, count: number, timeoutMs = 10000): Promise<void> {
        await waitFor(() => this.sentMessagesFor(groupId).length >= count,
            {description: `OneBot sent message count for group ${groupId} >= ${count}`, timeoutMs});
    }

    private broadcast (event: unknown): void {
        const payload = JSON.stringify(event);
        for (const client of this.clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        }
    }

    private onConnection (ws: WebSocket): void {
        this.clients.add(ws);

        ws.on('message', data => {
            void this.handleMessage(ws, data.toString());
        });
        ws.on('close', () => {
            this.clients.delete(ws);
        });

        ws.send(JSON.stringify({
            post_type: 'meta_event',
            meta_event_type: 'lifecycle',
            sub_type: 'connect',
            self_id: this.selfId,
            time: Math.floor(Date.now() / 1000)
        }));
    }

    private async handleMessage (ws: WebSocket, raw: string): Promise<void> {
        const request = JSON.parse(raw) as {action: string; params: Record<string, unknown>; echo: string};
        this.artifacts.appendJsonl('onebot-events.jsonl', {
            kind: 'api',
            at: Date.now(),
            action: request.action,
            params: request.params
        });

        const failure = this.failures.get(request.action);
        if (failure) {
            ws.send(JSON.stringify({
                status: failure.status,
                retcode: failure.retcode,
                message: failure.message,
                echo: request.echo
            }));
            return;
        }

        switch (request.action) {
        case 'get_login_info':
            this.respond(ws, request.echo, {user_id: this.selfId, nickname: this.botNickname});
            return;
        case 'get_group_member_info':
            this.respond(ws, request.echo, {
                group_id: request.params.group_id,
                user_id: request.params.user_id,
                nickname: this.botNickname,
                card: this.botCard,
                sex: 'unknown',
                age: 0,
                area: '',
                join_time: 0,
                last_sent_time: 0,
                level: '1',
                role: 'member',
                unfriendly: false,
                title: '',
                title_expire_time: 0,
                card_changeable: false
            });
            return;
        case 'get_group_member_list':
            this.respond(ws, request.echo, this.groupMembers.map(member => ({
                group_id: request.params.group_id,
                user_id: member.userId,
                nickname: member.nickname,
                card: member.card ?? '',
                sex: 'unknown',
                age: 0,
                area: '',
                join_time: 0,
                last_sent_time: 0,
                level: '1',
                role: 'member',
                unfriendly: false,
                title: '',
                title_expire_time: 0,
                card_changeable: false
            })));
            return;
        case 'send_group_msg':
            await this.handleSendGroupMsg(ws, request.echo, request.params);
            return;
        case 'get_msg':
            await this.handleGetMsg(ws, request.echo, request.params);
            return;
        case 'get_forward_msg':
            await this.handleGetForwardMsg(ws, request.echo, request.params);
            return;
        default:
            this.respond(ws, request.echo, {});
        }
    }

    private async handleSendGroupMsg (
        ws: WebSocket,
        echo: string,
        params: Record<string, unknown>
    ): Promise<void> {
        const gate = this.sendGateQueue.shift();
        const messageId = this.messageIdCounter++;
        const record: SentGroupMessage = {
            messageId,
            groupId: Number(params.group_id),
            message: params.message as Message[],
            requestedAt: Date.now(),
            delivered: false
        };
        this.sent.push(record);
        this.artifacts.appendJsonl('onebot-events.jsonl', {
            kind: 'send_group_msg',
            at: record.requestedAt,
            messageId,
            groupId: record.groupId,
            message: record.message,
            gate
        });
        if (gate) {
            await this.enterGate(gate);
        }

        record.delivered = true;
        this.respond(ws, echo, {message_id: messageId});
        this.artifacts.appendJsonl('onebot-events.jsonl', {
            kind: 'send_group_msg_response',
            at: Date.now(),
            messageId
        });
    }

    private async handleGetMsg (
        ws: WebSocket,
        echo: string,
        params: Record<string, unknown>
    ): Promise<void> {
        const messageId = Number(params.message_id);
        const registered = this.registered.get(messageId);
        if (!registered) {
            ws.send(JSON.stringify({
                status: 'failed', retcode: 1404, message: `unknown message ${messageId}`, echo
            }));
            return;
        }
        if (registered.delayMs) await sleep(registered.delayMs);
        this.respond(ws, echo, {
            time: registered.time,
            message_type: 'group',
            message_id: registered.messageId,
            real_id: registered.messageId,
            group_id: registered.groupId,
            sender: registered.sender,
            message: registered.message
        });
    }

    private async handleGetForwardMsg (
        ws: WebSocket,
        echo: string,
        params: Record<string, unknown>
    ): Promise<void> {
        const id = Number(params.id);
        const registered = this.registered.get(id);
        if (!registered) {
            ws.send(JSON.stringify({
                status: 'failed', retcode: 1404, message: `unknown forward ${id}`, echo
            }));
            return;
        }
        if (registered.delayMs) await sleep(registered.delayMs);
        this.respond(ws, echo, {
            messages: [{
                time: registered.time,
                message_id: registered.messageId,
                sender: registered.sender,
                group_id: registered.groupId,
                message: registered.message
            }]
        });
    }

    private respond (ws: WebSocket, echo: string, data: unknown): void {
        ws.send(JSON.stringify({status: 'ok', retcode: 0, data, echo}));
    }

    async close (): Promise<void> {
        for (const client of this.clients) {
            client.terminate();
        }
        this.clients.clear();
        await new Promise<void>(resolve => {
            this.wss.close(() => resolve());
        });
        this.http.closeAllConnections();
        await new Promise<void>(resolve => {
            this.http.close(() => resolve());
        });
    }
}

function rawMessageFromSegments (segments: Message[]): string {
    return segments.map(segment => {
        switch (segment.type) {
        case 'text':
            return segment.data.text;
        case 'at':
            return `[CQ:at,qq=${segment.data.qq}]`;
        case 'image':
            return `[CQ:image,file=${segment.data.file}]`;
        case 'reply':
            return `[CQ:reply,id=${segment.data.id}]`;
        default:
            return `[CQ:${segment.type}]`;
        }
    }).join('');
}

import {type ChildProcess, spawn} from 'node:child_process';
import {dirname} from 'node:path';
import {Logger} from '@lib/util/logger';

export interface GraphitiEdge {
    uuid: string | null;
    name: string;
    fact: string;
    source_node_uuid: string | null;
    target_node_uuid: string | null;
    group_id: string;
    created_at: string | null;
    valid_at: string | null;
    invalid_at: string | null;
    expired_at: string | null;
    attributes: Record<string, unknown>;
}

export interface GraphitiSearchResult {
    results: GraphitiEdge[];
    count: number;
}

export interface GraphitiInitConfig {
    neo4j_uri?: string;
    neo4j_user?: string;
    neo4j_password?: string;
    llm: {
        api_key: string;
        model: string;
        small_model?: string;
        base_url?: string;
        temperature?: number;
        max_tokens?: number;
    };
    embedder: {
        api_key: string;
        model: string;
        dimension?: number;
        base_url?: string;
    };
    reranker?: {
        api_key: string;
        model: string;
        base_url?: string;
    };
}

interface JsonRpcRequest {
    jsonrpc: '2.0';
    id: number;
    method: string;
    params: Record<string, unknown>;
}

interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: number;
    result?: unknown;
    error?: {code: number; message: string; data?: unknown};
}

interface PendingCall {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
}

export class GraphitiClient {
    private process: ChildProcess | null = null;
    private nextId = 1;
    private pending = new Map<number, PendingCall>();
    private buffer = '';
    private logger = new Logger();
    private serverPath: string;
    private uvPath: string;
    private ready = false;
    private initPromise: Promise<void> | null = null;

    constructor (options: {serverPath: string; uvPath?: string}) {
        this.serverPath = options.serverPath;
        this.uvPath = options.uvPath ?? 'uv';
    }

    async initialize (config: GraphitiInitConfig): Promise<void> {
        if (this.initPromise) return this.initPromise;
        this.initPromise = this._doInitialize(config);
        return this.initPromise;
    }

    private async _doInitialize (config: GraphitiInitConfig): Promise<void> {
        this.process = spawn(this.uvPath, ['run', 'python', this.serverPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: dirname(this.serverPath),
            env: {...process.env}
        });

        this.process.stdout!.on('data', (chunk: Buffer) => {
            this.buffer += chunk.toString();
            this._processBuffer();
        });

        this.process.stderr!.on('data', (chunk: Buffer) => {
            this.logger.debug(`[Graphiti] stderr: ${chunk.toString().trim()}`);
        });

        this.process.on('exit', code => {
            this.logger.warn(`[Graphiti] server exited with code ${code}`);
            this.ready = false;
            for (const [, pending] of this.pending) {
                pending.reject(new Error(`Graphiti server exited with code ${code}`));
            }
            this.pending.clear();
        });

        this.process.on('error', err => {
            this.logger.error('[Graphiti] failed to start server:', err);
            this.ready = false;
        });

        await this._call('initialize', config as unknown as Record<string, unknown>);
        this.ready = true;
        this.logger.info('[Graphiti] server initialized');
    }

    private _processBuffer (): void {
        let newlineIdx: number;
        while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, newlineIdx).trim();
            this.buffer = this.buffer.slice(newlineIdx + 1);
            if (!line) continue;

            try {
                const response = JSON.parse(line) as JsonRpcResponse;
                const pending = this.pending.get(response.id);
                if (pending) {
                    this.pending.delete(response.id);
                    if (response.error) {
                        const dataStr = response.error.data ? `\n${String(response.error.data)}` : '';
                        const err = new Error(
                            `[Graphiti] RPC error ${response.error.code}: ${response.error.message}${dataStr}`
                        );
                        pending.reject(err);
                    } else {
                        pending.resolve(response.result);
                    }
                }
            } catch {
                this.logger.warn(`[Graphiti] invalid JSON from server: ${line.slice(0, 200)}`);
            }
        }
    }

    private _call (method: string, params: Record<string, unknown> = {}): Promise<unknown> {
        return new Promise((resolve, reject) => {
            if (!this.process || !this.process.stdin) {
                reject(new Error('Graphiti server not running'));
                return;
            }

            const id = this.nextId++;
            const request: JsonRpcRequest = {jsonrpc: '2.0', id, method, params};

            this.pending.set(id, {resolve, reject});

            const timeout = setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`[Graphiti] RPC call ${method} timed out (5min)`));
                }
            }, 300_000);

            const originalResolve = resolve;
            const originalReject = reject;
            this.pending.set(id, {
                resolve: value => {
                    clearTimeout(timeout);
                    originalResolve(value);
                },
                reject: reason => {
                    clearTimeout(timeout);
                    originalReject(reason);
                }
            });

            this.process.stdin!.write(`${JSON.stringify(request)}\n`);
        });
    }

    get isReady (): boolean {
        return this.ready;
    }

    async addEpisode (groupId: string, episode: {
        name: string;
        content: string;
        source_description: string;
        reference_time: string;
    }): Promise<{status: string; episode_uuid: string | null}> {
        const result = await this._call('add_episode', {group_id: groupId, ...episode});
        return result as {status: string; episode_uuid: string | null};
    }

    async search (query: string, groupId: string, numResults = 10): Promise<GraphitiSearchResult> {
        const result = await this._call('search', {
            query,
            group_id: groupId,
            num_results: numResults
        });
        return result as GraphitiSearchResult;
    }

    async getEdges (groupId: string, limit = 50, offset = 0): Promise<{
        edges: GraphitiEdge[];
        total: number;
        offset: number;
        limit: number;
    }> {
        const result = await this._call('get_edges', {group_id: groupId, limit, offset});
        return result as {edges: GraphitiEdge[]; total: number; offset: number; limit: number};
    }

    async getEdge (uuid: string): Promise<GraphitiEdge | null> {
        const result = await this._call('get_edge', {uuid});
        return result as GraphitiEdge | null;
    }

    async deleteEdge (uuid: string): Promise<void> {
        await this._call('delete_edge', {uuid});
    }

    async deleteGroup (groupId: string): Promise<void> {
        await this._call('delete_group', {group_id: groupId});
    }

    async shutdown (): Promise<void> {
        if (!this.process) return;
        try {
            await this._call('shutdown', {});
            // 等待子进程自然退出
            await new Promise<void>(resolve => {
                this.process?.on('exit', () => resolve());
                // 超时 2 秒后强制退出
                setTimeout(() => resolve(), 2000);
            });
        } catch {
            // ignore errors during shutdown
        }
        if (this.process) {
            this.process.kill();
        }
        this.process = null;
        this.ready = false;
    }
}

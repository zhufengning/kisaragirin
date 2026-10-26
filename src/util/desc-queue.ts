import {Agent, type ThinkingLevel} from '@earendil-works/pi-agent-core';
import type {AssistantMessage, Models} from '@earendil-works/pi-ai';
import type {AppConfig, ModelEntry} from '~/config';
import {eq} from 'drizzle-orm';
import {schema, type Db} from '~/db';
import {findImagePath} from './image-store';
import {prompts} from '~/prompts';
import {withRetry} from './agent-retry';
import {preprocessImage, type ImagePreprocessOptions} from './image-preprocess';
import {Logger} from '@lib/util/logger';
import {resolveAssignmentModels} from './models-factory';

/** 单次 describe 的默认兜底超时（毫秒） */
const DEFAULT_DESCRIBE_TIMEOUT_MS = 6 * 60 * 1000;
/** abort 后等待 Agent run 完全结束的默认宽限时间（毫秒） */
const DEFAULT_ABORT_SETTLE_GRACE_MS = 5 * 1000;

function withTimeout<T> (
    promise: Promise<T>,
    ms: number,
    onTimeout: () => void | Promise<void>,
    message: string,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            void Promise.resolve(onTimeout()).finally(() => {
                reject(new Error(message));
            });
        }, ms);
        promise.then(
            value => {
                clearTimeout(timer);
                resolve(value);
            },
            err => {
                clearTimeout(timer);
                reject(err);
            }
        );
    });
}

export interface DescQueueOptions {
    db: Db;
    config: AppConfig;
    models: Models;
    /** 单次 describe 的兜底超时（毫秒） */
    describeTimeoutMs?: number;
    /** abort 后等待 Agent run 完全结束的宽限时间（毫秒） */
    abortSettleGraceMs?: number;
}

export class DescQueue {
    private queue: string[] = [];
    private processing = new Set<string>();
    private waiters = new Map<string, Array<(desc: string | undefined) => void>>();
    private db: Db;
    private running = false;
    private closing = false;
    private started = false;
    private loops: Promise<void>[] = [];
    private agents: Agent[];
    /** 回退链：API 错误时按顺序切换到下一个模型 */
    private modelEntries: ModelEntry[];
    private concurrency: number;
    private imageOptions: ImagePreprocessOptions;
    private logger: Logger;
    private describeTimeoutMs: number;
    private abortSettleGraceMs: number;
    private thinkingLevel: ThinkingLevel;
    private models: Models;

    constructor (options: DescQueueOptions) {
        const {db, config, models} = options;
        this.db = db;
        this.models = models;
        this.logger = new Logger();
        this.concurrency = config.input.vision_concurrency;
        this.describeTimeoutMs = options.describeTimeoutMs ?? DEFAULT_DESCRIBE_TIMEOUT_MS;
        this.abortSettleGraceMs = options.abortSettleGraceMs ?? DEFAULT_ABORT_SETTLE_GRACE_MS;
        this.thinkingLevel = config.input.vision_thinking_level;
        this.imageOptions = {
            maxSizeBytes: config.input.vision_max_size_bytes,
            maxFrames: config.input.vision_max_frames,
            initialQuality: config.input.vision_initial_quality,
            maxLongEdge: config.input.vision_max_long_edge,
            maxTotalPixels: config.input.vision_max_total_pixels
        };
        this.modelEntries = resolveAssignmentModels(config, config.ai.assignments.vision);
        this.agents = Array.from({length: this.concurrency}, () => this.createAgent(0));
    }

    private createAgent (modelIndex: number): Agent {
        const modelEntry = this.modelEntries[modelIndex];
        return new Agent({
            initialState: {
                systemPrompt: prompts.visionSystem,
                model: modelEntry.model,
                thinkingLevel: this.thinkingLevel
            },
            streamFn: (model, context, streamOptions) =>
                this.models.streamSimple(model, context, streamOptions),
            getApiKey: () => modelEntry.apiKey
        });
    }

    start () {
        if (this.running) return;
        this.running = true;
        this.closing = false;
        if (!this.started) {
            this.started = true;
            for (let i = 0; i < this.concurrency; i++) {
                this.loops.push(this.loop(i));
            }
        }
    }

    /** 停止接收新任务，中止进行中的请求，等待 worker 退出并通知剩余等待者 */
    async stop (): Promise<void> {
        this.running = false;
        this.closing = true;
        for (const agent of this.agents) {
            agent.abort();
        }
        await Promise.allSettled(this.loops);
        this.loops = [];
        this.started = false;
        this.queue = [];
        for (const sha256 of Array.from(this.waiters.keys())) {
            this.notify(sha256, undefined);
        }
    }

    /** 等待队列中所有任务处理结束 */
    async waitForIdle (): Promise<void> {
        while (this.queue.length > 0 || this.processing.size > 0) {
            await new Promise(r => setTimeout(r, 10));
        }
    }

    enqueue (sha256: string, toFront = false) {
        if (this.processing.has(sha256)) return;
        if (this.queue.includes(sha256)) return;
        if (toFront) {
            this.queue.unshift(sha256);
        } else {
            this.queue.push(sha256);
        }
    }

    enqueueMany (sha256s: string[], toFront = false) {
        const filtered = sha256s.filter(s => !this.processing.has(s) && !this.queue.includes(s));
        if (toFront) {
            this.queue.unshift(...filtered);
        } else {
            this.queue.push(...filtered);
        }
    }

    /** 查询描述；未生成时插到队头并等待 */
    async resolve (sha256: string): Promise<string | undefined> {
        const rows = await this.db
            .select()
            .from(schema.images)
            .where(eq(schema.images.sha256, sha256));
        if (rows[0]?.description) return rows[0].description;

        this.enqueue(sha256, true);
        return new Promise(resolve => {
            const list = this.waiters.get(sha256) ?? [];
            list.push(resolve);
            this.waiters.set(sha256, list);
        });
    }

    private async loop (workerId: number) {
        while (this.running) {
            const sha256 = this.queue.shift();
            if (!sha256) {
                await new Promise(r => setTimeout(r, 100));
                continue;
            }

            this.processing.add(sha256);
            try {
                const existing = await this.db
                    .select()
                    .from(schema.images)
                    .where(eq(schema.images.sha256, sha256));
                if (existing[0]?.description) {
                    this.logger.info(
                        `[DescQueue] [w${workerId}] description already exists for ${sha256.slice(0, 16)}, skipping`);
                    this.notify(sha256, existing[0].description);
                    continue;
                }

                const path = findImagePath(sha256);
                if (!path) {
                    this.logger.error(`[DescQueue] [w${workerId}] Image file not found: ${sha256}`);
                    this.notify(sha256, undefined);
                    continue;
                }

                const desc = await this.describe(path, workerId);
                if (desc) {
                    await this.db.insert(schema.images)
                        .values({sha256, description: desc})
                        .onConflictDoUpdate({
                            target: schema.images.sha256,
                            set: {description: desc}
                        });
                    this.logger.info(
                        `[DescQueue] [w${workerId}] description saved for ${sha256.slice(0, 16)}`);
                } else {
                    this.logger.warn(
                        `[DescQueue] [w${workerId}] describe returned empty for ${sha256.slice(0, 16)}, not saving`);
                }
                this.notify(sha256, desc);
            } catch (err) {
                this.logger.error(`[DescQueue] [w${workerId}] Failed to describe ${sha256}:`, err);
                this.notify(sha256, undefined);
            } finally {
                this.processing.delete(sha256);
            }
        }
    }

    private async describe (path: string, workerId: number): Promise<string | undefined> {
        const result = await preprocessImage(path, this.imageOptions);
        this.logger.debug(
            `[DescQueue] describe start path=${path} frames=${result.frames.length} isAnimation=${result.isAnimation}`);

        const inputText = result.isAnimation ?
            prompts.visionAnimated(result.totalFrames, result.extractedFrames) :
            prompts.visionUser;

        // 按回退链依次尝试：API 错误（或模型返回错误/空文本）时切换下一个模型
        for (let modelIndex = 0; modelIndex < this.modelEntries.length; modelIndex++) {
            if (this.closing) return;
            const modelEntry = this.modelEntries[modelIndex];
            this.agents[workerId] = this.createAgent(modelIndex);
            const agent = this.agents[workerId];

            try {
                await withRetry(
                    async () => {
                        agent.reset();
                        this.logger.debug(
                            `[DescQueue] agent reset, prompt length=${inputText.length}, image count=${result.frames.length}`);
                        const frames = result.frames.map(f => ({type: 'image' as const, data: f.base64, mimeType: f.mimeType}));
                        await withTimeout(
                            (async () => {
                                await agent.prompt(inputText, frames);
                                this.logger.debug(`[DescQueue] prompt submitted, waiting for idle...`);
                                await agent.waitForIdle();
                            })(),
                            this.describeTimeoutMs,
                            async () => {
                                agent.abort();
                                await withTimeout(
                                    agent.waitForIdle(),
                                    this.abortSettleGraceMs,
                                    () => {},
                                    `describe abort settle timed out after ${this.abortSettleGraceMs}ms`,
                                );
                            },
                            `describe timed out after ${this.describeTimeoutMs}ms`,
                        );
                        this.logger.debug(`[DescQueue] agent idle`);
                    },
                    {
                        maxRetries: 2,
                        onRetry: (attempt, maxRetries, delayMs, err) => {
                            this.logger.warn(
                                `[DescQueue] Retry ${attempt}/${maxRetries} after ${delayMs}ms:`,
                                err instanceof Error ? err.message : err,
                            );
                        }
                    },
                );
            } catch (err) {
                this.logger.error(
                    `[DescQueue] describe failed (model=${modelEntry.model.id}):`, err);
                if (modelIndex < this.modelEntries.length - 1) {
                    this.logger.warn(
                        `[DescQueue] falling back to model ${this.modelEntries[modelIndex + 1].model.id}`);
                }
                continue;
            }

            const msgs = agent.state.messages;
            const last = msgs[msgs.length - 1];
            const lastAssistant = last?.role === 'assistant' ? (last as AssistantMessage) : undefined;
            this.logger.debug(
                `[DescQueue] messages count=${msgs.length}, last role=${last?.role}, ` +
                `stopReason=${lastAssistant?.stopReason}`);
            if (lastAssistant && lastAssistant.stopReason !== 'error') {
                const text = lastAssistant.content
                    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
                    .map(c => c.text)
                    .join('')
                    .trim();
                this.logger.debug(`[DescQueue] assistant text length=${text.length}`);
                if (text) return text;
                this.logger.warn(
                    `[DescQueue] assistant text is empty, treating as failure`);
            } else {
                this.logger.warn(
                    `[DescQueue] invalid last message role=${last?.role} stopReason=${lastAssistant?.stopReason}${lastAssistant?.errorMessage ? ` error=${lastAssistant.errorMessage}` : ''}`);
            }

            if (modelIndex < this.modelEntries.length - 1) {
                this.logger.warn(
                    `[DescQueue] falling back to model ${this.modelEntries[modelIndex + 1].model.id}`);
            }
        }

        return;
    }

    private notify (sha256: string, desc: string | undefined) {
        const list = this.waiters.get(sha256);
        if (list) {
            list.forEach(r => r(desc));
            this.waiters.delete(sha256);
        }
    }

    getStatus () {
        return {
            pending: this.queue.length,
            processing: this.processing.size,
            current: this.processing.values().next().value as string | undefined
        };
    }
}

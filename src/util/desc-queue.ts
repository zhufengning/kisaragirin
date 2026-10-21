import {Agent} from '@earendil-works/pi-agent-core';
import type {AssistantMessage} from '@earendil-works/pi-ai';
import {config} from '@/config';
import type {ModelEntry} from '~/config';
import {eq} from 'drizzle-orm';
import {schema, type Db} from '~/db';
import {findImagePath} from './image-store';
import {prompts} from '~/prompts';
import {withRetry} from './agent-retry';
import {preprocessImage, type ImagePreprocessOptions} from './image-preprocess';
import {Logger} from '@lib/util/logger';
import {resolveAssignmentModels} from './models-factory';

/**
 * 单次 describe 的兜底超时（毫秒）。
 * 模型请求可能永久挂起（SDK 自带超时并不总是触发），若不加保护，
 * worker 会卡死在 describe() 里，processing 集合中的 sha256 永不释放，
 * 导致队列状态永远显示还剩 1 张。
 */
const DESCRIBE_TIMEOUT_MS = 6 * 60 * 1000;
/** abort 后等待 Agent run 完全结束的宽限时间 */
const ABORT_SETTLE_GRACE_MS = 5 * 1000;

function withTimeout<T> (promise: Promise<T>, ms: number, onTimeout: () => void | Promise<void>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            void Promise.resolve(onTimeout()).finally(() => {
                reject(new Error(`describe timed out after ${ms}ms`));
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

export class DescQueue {
    private queue: string[] = [];
    private processing = new Set<string>();
    private waiters = new Map<string, Array<(desc: string | undefined) => void>>();
    private db: Db;
    private running = false;
    private agents: Agent[];
    /** 回退链：API 错误时按顺序切换到下一个模型 */
    private modelEntries: ModelEntry[];
    private concurrency: number;
    private imageOptions: ImagePreprocessOptions;
    private logger: Logger;

    constructor (db: Db) {
        this.db = db;
        this.logger = new Logger();
        this.concurrency = config.input.vision_concurrency;
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
                thinkingLevel: config.input.vision_thinking_level
            },
            getApiKey: () => modelEntry.apiKey
        });
    }

    start () {
        if (this.running) return;
        this.running = true;
        for (let i = 0; i < this.concurrency; i++) {
            this.loop(i);
        }
    }

    stop () {
        this.running = false;
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
                            DESCRIBE_TIMEOUT_MS,
                            async () => {
                                agent.abort();
                                await withTimeout(agent.waitForIdle(), ABORT_SETTLE_GRACE_MS, () => {});
                            },
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

import {Agent, type ThinkingLevel} from '@earendil-works/pi-agent-core';
import type {AssistantMessage, Models} from '@earendil-works/pi-ai';
import type {AppConfig, ModelEntry} from '~/config';
import {eq} from 'drizzle-orm';
import {schema, type Db} from '~/db';
import type {ImageInfo} from '~/message-format';
import {findImagePath} from './image-store';
import {prompts} from '~/prompts';
import {withRetry} from './agent-retry';
import {preprocessImage, type ImagePreprocessOptions, type PreprocessResult} from './image-preprocess';
import {Logger} from '@lib/util/logger';
import {resolveAssignmentModels} from './models-factory';

/** 单次 describe 的默认兜底超时（毫秒） */
const DEFAULT_DESCRIBE_TIMEOUT_MS = 6 * 60 * 1000;
/** abort 后等待 Agent run 完全结束的默认宽限时间（毫秒） */
const DEFAULT_ABORT_SETTLE_GRACE_MS = 5 * 1000;

/** 生成图片描述 */
interface DescribeTask {
    kind: 'describe';
    sha256: string;
}

/** 向视觉模型追问图片细节，回答通过 resolve 返回给调用方 */
interface AskTask {
    kind: 'ask';
    sha256: string;
    question: string;
    resolve: (answer: string | undefined) => void;
}

type VisionTask = DescribeTask | AskTask;

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
    private queue: VisionTask[] = [];
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
        this.agents = Array.from(
            {length: this.concurrency}, () => this.createAgent(0, prompts.visionSystem));
    }

    private createAgent (modelIndex: number, systemPrompt: string): Agent {
        const modelEntry = this.modelEntries[modelIndex];
        return new Agent({
            initialState: {
                systemPrompt: systemPrompt,
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
        const pendingAsks = this.queue.filter((task): task is AskTask => task.kind === 'ask');
        this.queue = [];
        for (const task of pendingAsks) {
            task.resolve(undefined);
        }
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

    private hasDescribeTask (sha256: string): boolean {
        return this.queue.some(task => task.kind === 'describe' && task.sha256 === sha256);
    }

    enqueue (sha256: string, toFront = false) {
        if (this.processing.has(sha256)) return;
        if (this.hasDescribeTask(sha256)) return;
        const task: VisionTask = {kind: 'describe', sha256};
        if (toFront) {
            this.queue.unshift(task);
        } else {
            this.queue.push(task);
        }
    }

    enqueueMany (sha256s: string[], toFront = false) {
        const filtered = sha256s.filter(s => !this.processing.has(s) && !this.hasDescribeTask(s));
        const tasks: VisionTask[] = filtered.map(sha256 => ({kind: 'describe', sha256}));
        if (toFront) {
            this.queue.unshift(...tasks);
        } else {
            this.queue.push(...tasks);
        }
    }

    /** 查询图片信息；未生成描述时插到队头并等待 */
    async resolve (sha256: string): Promise<ImageInfo | undefined> {
        const rows = await this.db
            .select()
            .from(schema.images)
            .where(eq(schema.images.sha256, sha256));
        if (rows[0]?.description) {
            return {id: rows[0].id, description: rows[0].description};
        }

        this.enqueue(sha256, true);
        await new Promise<string | undefined>(resolve => {
            const list = this.waiters.get(sha256) ?? [];
            list.push(resolve);
            this.waiters.set(sha256, list);
        });

        // worker 可能刚插入该行，重新查询取得 id 与描述
        const after = await this.db
            .select()
            .from(schema.images)
            .where(eq(schema.images.sha256, sha256));
        const row = after[0];
        if (!row) return undefined;
        return {id: row.id, description: row.description ?? undefined};
    }

    /** 向视觉模型追问图片细节，任务插到队头，返回回答文本 */
    async ask (sha256: string, question: string): Promise<string | undefined> {
        if (!this.running) return undefined;
        return new Promise<string | undefined>(resolve => {
            this.queue.unshift({kind: 'ask', sha256, question, resolve});
        });
    }

    private async loop (workerId: number) {
        while (this.running) {
            const task = this.queue.shift();
            if (!task) {
                await new Promise(r => setTimeout(r, 100));
                continue;
            }

            if (task.kind === 'ask') {
                try {
                    const path = findImagePath(task.sha256);
                    if (!path) {
                        this.logger.error(
                            `[DescQueue] [w${workerId}] Image file not found: ${task.sha256}`);
                        task.resolve(undefined);
                        continue;
                    }
                    task.resolve(await this.askImage(path, task.question, workerId));
                } catch (err) {
                    this.logger.error(
                        `[DescQueue] [w${workerId}] Failed to ask ${task.sha256}:`, err);
                    task.resolve(undefined);
                }
                continue;
            }

            const sha256 = task.sha256;
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

    private describe (path: string, workerId: number): Promise<string | undefined> {
        return this.runVision(path, workerId, {
            systemPrompt: prompts.visionSystem,
            buildInputText: result => (result.isAnimation ?
                prompts.visionAnimated(result.totalFrames, result.extractedFrames) :
                prompts.visionUser),
            label: 'describe'
        });
    }

    private askImage (path: string, question: string, workerId: number): Promise<string | undefined> {
        return this.runVision(path, workerId, {
            systemPrompt: prompts.visionQuestionSystem,
            buildInputText: result => (result.isAnimation ?
                prompts.visionQuestionAnimated(question, result.totalFrames, result.extractedFrames) :
                prompts.visionQuestionUser(question)),
            label: 'ask'
        });
    }

    /** 按回退链依次尝试视觉模型，返回 assistant 文本 */
    private async runVision (
        path: string,
        workerId: number,
        options: {
            systemPrompt: string;
            buildInputText: (result: PreprocessResult) => string;
            label: string;
        }
    ): Promise<string | undefined> {
        const {systemPrompt, buildInputText, label} = options;
        const result = await preprocessImage(path, this.imageOptions);
        this.logger.debug(
            `[DescQueue] ${label} start path=${path} frames=${result.frames.length} isAnimation=${result.isAnimation}`);

        const inputText = buildInputText(result);

        // 按回退链依次尝试：API 错误（或模型返回错误/空文本）时切换下一个模型
        for (let modelIndex = 0; modelIndex < this.modelEntries.length; modelIndex++) {
            if (this.closing) return;
            const modelEntry = this.modelEntries[modelIndex];
            this.agents[workerId] = this.createAgent(modelIndex, systemPrompt);
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
                    `[DescQueue] ${label} failed (model=${modelEntry.model.id}):`, err);
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

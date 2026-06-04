import { Agent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { config } from '@/config';
import { eq } from 'drizzle-orm';
import type { Db } from '~/db';
import { schema } from '~/db';
import { findImagePath } from './image-store';
import { prompts } from '~/prompts';
import { withRetry } from './agent-retry';
import { preprocessImage } from './image-preprocess';
import { Logger } from '@lib/util/logger';

export class DescQueue {
    private queue: string[] = [];
    private processing = new Set<string>();
    private waiters = new Map<string, Array<(desc: string | undefined) => void>>();
    private db: Db;
    private running = false;
    private agent: Agent;
    private logger: Logger;

    constructor(db: Db) {
        this.db = db;
        this.logger = new Logger();
        const modelEntry = config.ai.models[config.ai.assignments.vision];
        this.agent = new Agent({
            initialState: {
                systemPrompt: prompts.visionSystem,
                model: modelEntry.model,
            },
            getApiKey: () => modelEntry.apiKey,
        });
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.loop();
    }

    enqueue(sha256: string, toFront = false) {
        if (this.processing.has(sha256)) return;
        if (this.queue.includes(sha256)) return;
        if (toFront) {
            this.queue.unshift(sha256);
        } else {
            this.queue.push(sha256);
        }
    }

    /** 查询描述；未生成时插到队头并等待 */
    async resolve(sha256: string): Promise<string | undefined> {
        const rows = await this.db
            .select()
            .from(schema.images)
            .where(eq(schema.images.sha256, sha256));
        if (rows[0]?.description) return rows[0].description;

        this.enqueue(sha256, true);
        return new Promise((resolve) => {
            const list = this.waiters.get(sha256) ?? [];
            list.push(resolve);
            this.waiters.set(sha256, list);
        });
    }

    private async loop() {
        while (this.running) {
            const sha256 = this.queue.shift();
            if (!sha256) {
                await new Promise(r => setTimeout(r, 100));
                continue;
            }

            this.processing.add(sha256);
            try {
                const path = findImagePath(sha256);
                if (!path) {
                    this.logger.warn(`[DescQueue] Image file not found: ${sha256}`);
                    this.notify(sha256, undefined);
                    continue;
                }

                const desc = await this.describe(path);
                if (desc) {
                    await this.db.update(schema.images)
                        .set({ description: desc })
                        .where(eq(schema.images.sha256, sha256));
                    this.logger.info(`[DescQueue] description saved for ${sha256.slice(0, 16)}`);
                } else {
                    this.logger.warn(`[DescQueue] describe returned empty for ${sha256.slice(0, 16)}, not saving`);
                }
                this.notify(sha256, desc);
            } catch (err) {
                this.logger.error(`[DescQueue] Failed to describe ${sha256}:`, err);
                this.notify(sha256, undefined);
            } finally {
                this.processing.delete(sha256);
            }
        }
    }

    private async describe(path: string): Promise<string | undefined> {
        const result = await preprocessImage(path);
        this.logger.debug(`[DescQueue] describe start path=${path} frames=${result.frames.length} isAnimation=${result.isAnimation}`);

        const inputText = result.isAnimation
            ? prompts.visionAnimated(result.totalFrames, result.extractedFrames)
            : prompts.visionUser;

        await withRetry(
            async () => {
                this.agent.reset();
                this.logger.debug(`[DescQueue] agent reset, prompt length=${inputText.length}, image count=${result.frames.length}`);
                await this.agent.prompt(
                    inputText,
                    result.frames.map(f => ({ type: 'image' as const, data: f.base64, mimeType: f.mimeType })),
                );
                this.logger.debug(`[DescQueue] prompt submitted, waiting for idle...`);
                await this.agent.waitForIdle();
                this.logger.debug(`[DescQueue] agent idle`);
            },
            {
                maxRetries: 2,
                onRetry: (attempt, maxRetries, delayMs, err) => {
                    this.logger.warn(
                        `[DescQueue] Retry ${attempt}/${maxRetries} after ${delayMs}ms:`,
                        err instanceof Error ? err.message : err,
                    );
                },
            },
        );

        const msgs = this.agent.state.messages;
        const last = msgs[msgs.length - 1];
        const lastAssistant = last?.role === 'assistant' ? (last as AssistantMessage) : undefined;
        this.logger.debug(`[DescQueue] messages count=${msgs.length}, last role=${last?.role}, stopReason=${lastAssistant?.stopReason}`);
        if (lastAssistant && lastAssistant.stopReason !== 'error') {
            const text = lastAssistant.content
                .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
                .map(c => c.text)
                .join('')
                .trim();
            this.logger.debug(`[DescQueue] assistant text length=${text.length}`);
            if (text) return text;
            this.logger.warn(`[DescQueue] assistant text is empty, treating as failure`);
        } else {
            this.logger.warn(`[DescQueue] invalid last message role=${last?.role} stopReason=${lastAssistant?.stopReason}`);
        }
        return undefined;
    }

    private notify(sha256: string, desc: string | undefined) {
        const list = this.waiters.get(sha256);
        if (list) {
            list.forEach(r => r(desc));
            this.waiters.delete(sha256);
        }
    }

    getStatus() {
        return {
            pending: this.queue.length,
            processing: this.processing.size,
            current: this.processing.values().next().value as string | undefined,
        };
    }
}

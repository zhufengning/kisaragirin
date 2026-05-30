import { Agent } from '@earendil-works/pi-agent-core';
import { config } from '../../config';
import { readFileSync } from 'fs';
import { eq } from 'drizzle-orm';
import type { Db } from '../db';
import { schema } from '../db';
import { findImagePath } from './image-store';
import { prompts } from '../prompts';

function extToMime(ext: string): string {
    const map: Record<string, string> = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
        bmp: 'image/bmp',
    };
    return map[ext.toLowerCase()] || 'application/octet-stream';
}

export class DescQueue {
    private queue: string[] = [];
    private processing = new Set<string>();
    private waiters = new Map<string, Array<(desc: string | undefined) => void>>();
    private db: Db;
    private running = false;
    private agent: Agent;

    constructor(db: Db) {
        this.db = db;
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
                    console.warn(`[DescQueue] Image file not found: ${sha256}`);
                    this.notify(sha256, undefined);
                    continue;
                }

                const desc = await this.describe(path);
                await this.db.update(schema.images)
                    .set({ description: desc })
                    .where(eq(schema.images.sha256, sha256));
                this.notify(sha256, desc);
            } catch (err) {
                console.error(`[DescQueue] Failed to describe ${sha256}:`, err);
                this.notify(sha256, undefined);
            } finally {
                this.processing.delete(sha256);
            }
        }
    }

    private async describe(path: string): Promise<string> {
        const base64 = readFileSync(path).toString('base64');
        const ext = path.split('.').pop() ?? 'jpg';
        const mimeType = extToMime(ext);

        this.agent.reset();
        await this.agent.prompt(prompts.visionUser, [
            { type: 'image', data: base64, mimeType },
        ]);
        await this.agent.waitForIdle();

        const msgs = this.agent.state.messages;
        const last = msgs[msgs.length - 1];
        if (last?.role === 'assistant' && last.stopReason !== 'error') {
            const text = last.content
                .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
                .map(c => c.text)
                .join('')
                .trim();
            if (text) return text;
        }
        return '一张图片';
    }

    private notify(sha256: string, desc: string | undefined) {
        const list = this.waiters.get(sha256);
        if (list) {
            list.forEach(r => r(desc));
            this.waiters.delete(sha256);
        }
    }
}

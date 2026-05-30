import { eq } from 'drizzle-orm';
import type { Db } from '../db';
import { schema } from '../db';
import { findImagePath } from './image-store';

/** 假函数：图片描述（待接入视觉 LLM） */
export async function describeImage(_path: string): Promise<string> {
    return '一张图片';
}

export class DescQueue {
    private queue: string[] = [];
    private processing = new Set<string>();
    private waiters = new Map<string, Array<(desc: string | undefined) => void>>();
    private db: Db;
    private running = false;

    constructor(db: Db) {
        this.db = db;
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

                const desc = await describeImage(path);
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

    private notify(sha256: string, desc: string | undefined) {
        const list = this.waiters.get(sha256);
        if (list) {
            list.forEach(r => r(desc));
            this.waiters.delete(sha256);
        }
    }
}

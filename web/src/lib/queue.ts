import { DescQueue } from '../../../src/util/desc-queue';
import { db } from './db';

let queue: DescQueue;

if ((globalThis as any).__queue__) {
    queue = (globalThis as any).__queue__;
} else {
    // fallback：独立运行时自建队列
    queue = new DescQueue(db);
    queue.start();
}

export function getQueue(): DescQueue {
    return queue;
}

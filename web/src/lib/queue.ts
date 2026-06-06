import { DescQueue } from '~/util/desc-queue';
import { db } from './db';

let queue: DescQueue;

if (globalThis.__queue__) {
    queue = globalThis.__queue__;
} else {
    // fallback：独立运行时自建队列
    queue = new DescQueue(db);
    queue.start();
}

export function getQueue(): DescQueue {
    return queue;
}

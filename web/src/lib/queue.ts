import { DescQueue } from '~/util/desc-queue';
import { registerCustomProviders } from '~/util/models-factory';
import { db } from './db';
import { config, models } from '@/config';

let queue: DescQueue;

if (globalThis.__queue__) {
    queue = globalThis.__queue__;
} else {
    // fallback：独立运行时自建队列
    registerCustomProviders(models, config);
    queue = new DescQueue({ db, config, models });
    queue.start();
}

export function getQueue(): DescQueue {
    return queue;
}

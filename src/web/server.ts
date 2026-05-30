import { createServer } from 'node:http';
import { resolve } from 'node:path';
import type { Db } from '../db';
import type { WebPanelConfig } from '../config';
import type { DescQueue } from '../util/desc-queue';

export function createWebPanel(_db: Db, config: WebPanelConfig, _queue: DescQueue) {
    return {
        start() {
            process.env.WEB_USERNAME = config.username;
            process.env.WEB_PASSWORD = config.password;

            const handlerPath = resolve('web/dist/server/entry.mjs');
            import(handlerPath)
                .then((mod: any) => {
                    const handler = mod.handler as (req: any, res: any) => void | Promise<void>;
                    const server = createServer((req, res) => {
                        handler(req, res);
                    });
                    server.listen(config.port, config.host, () => {
                        console.log(`Web panel listening on http://${config.host}:${config.port}`);
                    });
                })
                .catch((err) => {
                    console.error('Failed to load Astro handler:', err);
                });
        },
    };
}

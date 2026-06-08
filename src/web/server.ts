import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {resolve, join} from 'node:path';
import {existsSync, readFileSync} from 'node:fs';
import type {Db} from '~/db';
import type {WebPanelConfig} from '~/config';
import type {DescQueue} from '~/util/desc-queue';
import {Logger} from '@lib/util/logger';

const STATIC_DIR = resolve('web/dist/client');

function serveStatic (req: IncomingMessage, res: ServerResponse): boolean {
    const url = req.url || '';
    if (!url.startsWith('/_astro/')) return false;
    const filePath = join(STATIC_DIR, url);
    if (!existsSync(filePath)) return false;
    const content = readFileSync(filePath);
    const ext = filePath.split('.').pop();
    const mime: Record<string, string> = {
        css: 'text/css',
        js: 'application/javascript',
        svg: 'image/svg+xml',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp'
    };
    res.writeHead(200, {
        'Content-Type': mime[ext || ''] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable'
    });
    res.end(content);
    return true;
}

export function createWebPanel (_db: Db, config: WebPanelConfig, _queue: DescQueue) {
    // _db and _queue are reserved for future use
    const logger = new Logger();
    let server: ReturnType<typeof createServer> | undefined;
    return {
        start () {
            process.env.WEB_USERNAME = config.username;
            process.env.WEB_PASSWORD = config.password;

            const handlerPath = resolve('web/dist/server/entry.mjs');
            import(handlerPath)
                .then((mod: {handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>}) => {
                    const handler = mod.handler;
                    server = createServer(async (req, res) => {
                        if (serveStatic(req, res)) return;
                        try {
                            await handler(req, res);
                        } catch (err) {
                            logger.error('[Web] Unhandled error in Astro handler:', err);
                            if (!res.headersSent) {
                                res.writeHead(500, {'Content-Type': 'application/json'});
                                res.end(JSON.stringify({error: 'Internal Server Error'}));
                            }
                        }
                    });
                    server.listen(config.port, config.host, () => {
                        logger.info(`Web panel listening on http://${config.host}:${config.port}`);
                    });
                })
                .catch(err => {
                    logger.error('Failed to load Astro handler:', err);
                });
        },
        stop () {
            if (server) {
                server.close();
                logger.info('Web panel server closed.');
            }
        }
    };
}

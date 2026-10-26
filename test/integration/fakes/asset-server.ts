import {createServer, type Server, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {sleep} from '../runner/wait-for';

interface AssetEntry {
    bytes: Buffer;
    contentType: string;
    delayMs: number;
    requests: number;
}

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fakes', 'fixtures');

const CONTENT_TYPES: Record<string, string> = {
    png: 'image/png',
    gif: 'image/gif',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg'
};

export function fixtureBytes (name: string): Buffer {
    return readFileSync(join(FIXTURES_DIR, name));
}

/** 假图片资源 server：提供真实图片字节，支持按资源延迟响应 */
export class FakeAssetServer {
    private http: Server;
    private assets = new Map<string, AssetEntry>();
    private port = 0;

    private constructor () {
        this.http = createServer((req, res) => {
            void this.handle(req.url ?? '', res);
        });
    }

    static async start (): Promise<FakeAssetServer> {
        const server = new FakeAssetServer();
        await new Promise<void>(resolve => {
            server.http.listen(0, '127.0.0.1', resolve);
        });
        server.port = (server.http.address() as AddressInfo).port;
        return server;
    }

    get baseUrl (): string {
        return `http://127.0.0.1:${this.port}`;
    }

    register (name: string, bytes: Buffer, options: {
        contentType?: string;
        delayMs?: number;
    } = {}): string {
        const ext = name.split('.').pop() ?? 'png';
        this.assets.set(name, {
            bytes,
            contentType: options.contentType ?? CONTENT_TYPES[ext] ?? 'application/octet-stream',
            delayMs: options.delayMs ?? 0,
            requests: 0
        });
        return `${this.baseUrl}/assets/${name}`;
    }

    serveFixture (fixtureName: string, options: {delayMs?: number} = {}): string {
        return this.register(fixtureName, fixtureBytes(fixtureName), options);
    }

    requestCount (name: string): number {
        return this.assets.get(name)?.requests ?? 0;
    }

    private async handle (url: string, res: ServerResponse): Promise<void> {
        const name = url.replace(/^\/assets\//, '');
        const entry = this.assets.get(name);
        if (!entry) {
            res.writeHead(404);
            res.end();
            return;
        }
        entry.requests++;
        if (entry.delayMs > 0) await sleep(entry.delayMs);
        res.writeHead(200, {'Content-Type': entry.contentType});
        res.end(entry.bytes);
    }

    async close (): Promise<void> {
        this.http.closeAllConnections();
        await new Promise<void>(resolve => {
            this.http.close(() => resolve());
        });
    }
}

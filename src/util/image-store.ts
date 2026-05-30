import { createHash } from 'crypto';
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { dirname } from 'path';

export const IMAGE_DIR = './data/images';


function ensureDir(dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function extFromMime(mime: string): string {
    const map: Record<string, string> = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'image/bmp': 'bmp',
        'image/svg+xml': 'svg',
    };
    const normalized = mime.split(';')[0].trim().toLowerCase();
    return map[normalized] || 'bin';
}

export interface ImageStoreResult {
    sha256: string;
    ext: string;
    path: string;
}

export async function downloadAndStoreImage(url: string): Promise<ImageStoreResult> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download image: ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const mime = res.headers.get('content-type') || 'application/octet-stream';
    const ext = extFromMime(mime);
    const filePath = `${IMAGE_DIR}/${sha256}.${ext}`;
    if (!existsSync(filePath)) {
        ensureDir(dirname(filePath));
        writeFileSync(filePath, buf);
    }
    return { sha256, ext, path: filePath };
}

export function findImagePath(sha256: string): string | undefined {
    try {
        const files = readdirSync(IMAGE_DIR);
        const match = files.find(f => f.startsWith(sha256 + '.'));
        if (match) return `${IMAGE_DIR}/${match}`;
    } catch { /* ignore */ }
    return undefined;
}

import type { APIRoute } from 'astro';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const IMAGE_DIR = './data/images';

function extToMime(ext: string): string {
    const map: Record<string, string> = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.png': 'image/png', '.gif': 'image/gif',
        '.webp': 'image/webp', '.bmp': 'image/bmp',
    };
    return map[ext.toLowerCase()] || 'application/octet-stream';
}

export const GET: APIRoute = async ({ params }) => {
    const name = params.name!;
    let filePath = join(IMAGE_DIR, name);
    if (!existsSync(filePath)) {
        // try to find by sha256 prefix
        try {
            const files = readdirSync(IMAGE_DIR);
            const match = files.find(f => f.startsWith(name + '.'));
            if (match) filePath = join(IMAGE_DIR, match);
        } catch { /* ignore */ }
    }
    if (!existsSync(filePath)) {
        return new Response('Not found', { status: 404 });
    }
    const buf = readFileSync(filePath);
    const mime = extToMime(extname(filePath));
    return new Response(new Uint8Array(buf), {
        headers: {
            'Content-Type': mime,
            'Cache-Control': 'public, max-age=86400',
        },
    });
};

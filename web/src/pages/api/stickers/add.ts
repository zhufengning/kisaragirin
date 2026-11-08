import type {APIRoute} from 'astro';
import type {AppConfig} from '~/config';
import {db, schema} from '@lib/db';
import {getStickers, setStickers} from '~/util/sticker-store';
import {eq} from 'drizzle-orm';

function getMaxStickers (): number {
    const config = globalThis.__config__ as AppConfig | undefined;
    return config?.input.sticker_max_count ?? 50;
}

export const POST: APIRoute = async ({request, redirect}) => {
    const form = await request.formData();
    const imageId = parseInt(String(form.get('imageId') ?? ''), 10);
    const category = String(form.get('category') ?? '').trim();
    const note = String(form.get('note') ?? '').trim();

    if (!imageId || isNaN(imageId)) {
        return new Response('Invalid imageId', {status: 400});
    }

    const rows = await db
        .select({id: schema.images.id})
        .from(schema.images)
        .where(eq(schema.images.id, imageId));
    if (!rows[0]) {
        return new Response(`图片 id ${imageId} 不存在`, {status: 404});
    }

    const stickers = await getStickers(db);
    const existingIndex = stickers.findIndex(sticker => sticker.imageId === imageId);
    if (existingIndex >= 0) {
        stickers[existingIndex] = {imageId, category, note};
    } else {
        const maxStickers = getMaxStickers();
        if (stickers.length >= maxStickers) {
            return new Response(`收藏数量已达上限（${maxStickers}）`, {status: 400});
        }
        stickers.push({imageId, category, note});
    }

    await setStickers(db, stickers);
    return redirect('/stickers');
};

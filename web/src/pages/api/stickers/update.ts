import type {APIRoute} from 'astro';
import {db} from '@lib/db';
import {getStickers, setStickers} from '~/util/sticker-store';

export const POST: APIRoute = async ({request}) => {
    const body = await request.json() as {
        imageId?: unknown;
        category?: unknown;
        note?: unknown;
    };
    const imageId = typeof body.imageId === 'number' ? body.imageId : NaN;
    const category = typeof body.category === 'string' ? body.category.trim() : '';
    const note = typeof body.note === 'string' ? body.note.trim() : '';

    if (!imageId || isNaN(imageId)) {
        return new Response('Invalid imageId', {status: 400});
    }

    const stickers = await getStickers(db);
    const index = stickers.findIndex(sticker => sticker.imageId === imageId);
    if (index < 0) {
        return new Response(`图片 id ${imageId} 未收藏`, {status: 404});
    }

    stickers[index] = {imageId, category, note};
    await setStickers(db, stickers);
    return new Response(null, {status: 204});
};

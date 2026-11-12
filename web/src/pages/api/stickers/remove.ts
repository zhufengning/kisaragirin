import type {APIRoute} from 'astro';
import {db} from '@lib/db';
import {getStickers, setStickers} from '~/util/sticker-store';

export const POST: APIRoute = async ({request}) => {
    const body = await request.json() as {imageId?: unknown};
    const imageId = typeof body.imageId === 'number' ? body.imageId : NaN;

    if (!imageId || isNaN(imageId)) {
        return new Response('Invalid imageId', {status: 400});
    }

    const stickers = await getStickers(db);
    const index = stickers.findIndex(sticker => sticker.imageId === imageId);
    if (index < 0) {
        return new Response(`图片 id ${imageId} 未收藏`, {status: 404});
    }

    stickers.splice(index, 1);
    await setStickers(db, stickers);
    return new Response(null, {status: 204});
};

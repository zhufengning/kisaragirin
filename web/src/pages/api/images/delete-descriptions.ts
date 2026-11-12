import type {APIRoute} from 'astro';
import {db, schema} from '@lib/db';
import {inArray} from 'drizzle-orm';

export const POST: APIRoute = async ({request}) => {
    const body = await request.json() as {sha256?: unknown};
    if (!Array.isArray(body.sha256)) {
        return new Response('Missing sha256 list', {status: 400});
    }
    const selected = body.sha256.filter((v): v is string => typeof v === 'string');
    if (selected.length === 0) {
        return new Response('Empty sha256 list', {status: 400});
    }

    await db.update(schema.images)
        .set({description: null})
        .where(inArray(schema.images.sha256, selected));

    return new Response(null, {status: 204});
};

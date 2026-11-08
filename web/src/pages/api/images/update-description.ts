import type {APIRoute} from 'astro';
import {db, schema} from '@lib/db';
import {eq} from 'drizzle-orm';

export const POST: APIRoute = async ({request}) => {
    const body = await request.json() as {sha256?: unknown; description?: unknown};
    const sha256 = body.sha256;

    if (typeof sha256 !== 'string' || !sha256) {
        return new Response('Missing sha256', {status: 400});
    }

    const value = typeof body.description === 'string' ? body.description.trim() : '';
    await db.update(schema.images)
        .set({description: value || null})
        .where(eq(schema.images.sha256, sha256));

    return new Response(null, {status: 204});
};

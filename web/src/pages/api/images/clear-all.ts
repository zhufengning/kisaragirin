import type { APIRoute } from 'astro';
import { db, schema } from '@lib/db';

export const POST: APIRoute = async () => {
    await db.update(schema.images).set({ description: null });
    return new Response(null, {
        status: 302,
        headers: { Location: '/images' },
    });
};

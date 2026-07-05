import type { APIRoute } from 'astro';
import { db } from '@lib/db';
import { deleteMessagesByIds } from '~/db';

export const POST: APIRoute = async ({ request }) => {
    try {
        const body = await request.json() as { ids?: unknown };
        const ids = Array.isArray(body.ids)
            ? body.ids.filter((id): id is number => typeof id === 'number' && Number.isInteger(id) && id > 0)
            : [];

        if (ids.length === 0) {
            return new Response(JSON.stringify({ success: false, error: 'No valid message IDs provided' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const deleted = await deleteMessagesByIds(db, ids);

        return new Response(JSON.stringify({ success: true, deleted }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (err: unknown) {
        console.error('[Delete Messages API] POST error:', err);
        return new Response(JSON.stringify({
            success: false,
            error: err instanceof Error ? err.message : String(err)
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
};

export const prerender = false;

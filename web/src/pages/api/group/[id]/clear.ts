import type { APIRoute } from 'astro';
import { db } from '@lib/db';
import { clearGroupMessages } from '~/db';

export const POST: APIRoute = async ({ params }) => {
    try {
        const groupId = Number(params.id);
        if (!groupId || isNaN(groupId)) {
            return new Response(JSON.stringify({ success: false, error: 'Invalid group ID' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        await clearGroupMessages(db, groupId);

        return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (err: unknown) {
        console.error('[Clear Group API] POST error:', err);
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

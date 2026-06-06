import type { APIRoute } from 'astro';
import { Memory } from 'mem0ai/oss';
import type { GetAllMemoryOptions } from 'mem0ai/oss';

function getMemory(): Memory {
    const m = globalThis.__memory__;
    if (!m) throw new Error('Memory not initialized');
    return m;
}

export const GET: APIRoute = async ({ url }) => {
    try {
        const memory = getMemory();
        const page = parseInt(url.searchParams.get('page') || '1', 10);
        const pageSize = parseInt(url.searchParams.get('page_size') || '50', 10);
        const userId = url.searchParams.get('user_id') || 'default';

        const options: GetAllMemoryOptions & { page?: number; pageSize?: number } = { page, pageSize, filters: { user_id: userId } };

        const result = await memory.getAll(options);
        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (err: unknown) {
        console.error('[Mem0 API] GET /api/memories error:', err);
        return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
};

export const POST: APIRoute = async ({ request }) => {
    try {
        const memory = getMemory();
        const body = await request.json();

        const { messages, user_id, metadata } = body;

        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return new Response(JSON.stringify({ error: 'messages array is required' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const result = await memory.add(messages, {
            userId: user_id || 'default',
            metadata,
        });

        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (err: unknown) {
        console.error('[Mem0 API] POST /api/memories error:', err);
        return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
};

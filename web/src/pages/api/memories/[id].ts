import type { APIRoute } from 'astro';
import { Memory } from 'mem0ai/oss';

function getMemory(): Memory {
    const m = globalThis.__memory__;
    if (!m) throw new Error('Memory not initialized');
    return m;
}

export const GET: APIRoute = async ({ params }) => {
    try {
        const memory = getMemory();
        const id = params.id!;
        const result = await memory.get(id);
        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (err: unknown) {
        console.error(`[Mem0 API] GET /api/memories/${params.id} error:`, err);
        return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
};

export const PUT: APIRoute = async ({ params, request }) => {
    try {
        const memory = getMemory();
        const id = params.id!;
        const body = await request.json();

        const text = typeof body === 'string' ? body : body?.text;
        if (!text || typeof text !== 'string') {
            return new Response(JSON.stringify({ error: 'text is required and must be a string' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        console.log(`[Mem0 API] PUT /api/memories/${id} text="${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);
        const result = await memory.update(id, text);
        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (err: unknown) {
        console.error(`[Mem0 API] PUT /api/memories/${params.id} error:`, err);
        return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
};

export const DELETE: APIRoute = async ({ params }) => {
    try {
        const memory = getMemory();
        const id = params.id!;
        await memory.delete(id);
        return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (err: unknown) {
        console.error(`[Mem0 API] DELETE /api/memories/${params.id} error:`, err);
        return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
};

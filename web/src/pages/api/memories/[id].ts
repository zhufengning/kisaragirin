import type { APIRoute } from 'astro';
import { Memory } from 'mem0ai/oss';

function getMemory(): Memory {
    const m = (globalThis as any).__memory__;
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
    } catch (err: any) {
        console.error(`[Mem0 API] GET /api/memories/${params.id} error:`, err);
        return new Response(JSON.stringify({ error: err.message }), {
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
        
        const result = await memory.update(id, body);
        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (err: any) {
        console.error(`[Mem0 API] PUT /api/memories/${params.id} error:`, err);
        return new Response(JSON.stringify({ error: err.message }), {
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
    } catch (err: any) {
        console.error(`[Mem0 API] DELETE /api/memories/${params.id} error:`, err);
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
};

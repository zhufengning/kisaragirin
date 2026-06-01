import type { APIRoute } from 'astro';
import { Memory } from 'mem0ai/oss';

function getMemory(): Memory {
    const m = (globalThis as any).__memory__;
    if (!m) throw new Error('Memory not initialized');
    return m;
}

export const GET: APIRoute = async ({ url }) => {
    try {
        const memory = getMemory();
        const query = url.searchParams.get('q') || '';
        const userId = url.searchParams.get('user_id') || undefined;
        const topK = parseInt(url.searchParams.get('top_k') || '10', 10);

        if (!query) {
            return new Response(JSON.stringify({ error: 'Query parameter "q" is required' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const options: any = { topK };
        if (userId) {
            options.filters = { user_id: userId };
        }

        const result = await memory.search(query, options);
        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (err: any) {
        console.error('[Mem0 API] GET /api/memories/search error:', err);
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
};

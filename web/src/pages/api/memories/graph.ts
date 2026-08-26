import type { APIRoute } from 'astro';

function getGraphiti() {
    const g = globalThis.__graphiti__;
    if (!g || !g.isReady) throw new Error('Graphiti not initialized');
    return g;
}

export const GET: APIRoute = async ({ url }) => {
    try {
        const graphiti = getGraphiti();
        const groupId = url.searchParams.get('group_id') || 'default';
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 1000);

        if (!Number.isFinite(limit) || limit <= 0) {
            return new Response(JSON.stringify({ error: 'Invalid limit parameter' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const result = await graphiti.getSubgraph(groupId, limit);
        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (err: unknown) {
        console.error('[Graphiti API] GET /api/memories/graph error:', err);
        return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
};

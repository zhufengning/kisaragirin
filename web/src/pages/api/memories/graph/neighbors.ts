import type { APIRoute } from 'astro';

function getGraphiti() {
    const g = globalThis.__graphiti__;
    if (!g || !g.isReady) throw new Error('Graphiti not initialized');
    return g;
}

export const GET: APIRoute = async ({ url }) => {
    try {
        const graphiti = getGraphiti();
        const uuid = url.searchParams.get('uuid') || '';
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);

        if (!uuid) {
            return new Response(JSON.stringify({ error: 'Query parameter "uuid" is required' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const result = await graphiti.getNeighbors(uuid, limit);
        if (!result.node) {
            return new Response(JSON.stringify({ error: 'Node not found' }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (err: unknown) {
        console.error('[Graphiti API] GET /api/memories/graph/neighbors error:', err);
        return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
};

import type { APIRoute } from 'astro';

function getGraphiti() {
    const g = globalThis.__graphiti__;
    if (!g || !g.isReady) throw new Error('Graphiti not initialized');
    return g;
}

export const GET: APIRoute = async ({ url }) => {
    try {
        const graphiti = getGraphiti();
        const query = url.searchParams.get('q') || '';
        const groupId = url.searchParams.get('group_id') || 'default';
        const numResults = parseInt(url.searchParams.get('top_k') || '10', 10);

        if (!query) {
            return new Response(JSON.stringify({ error: 'Query parameter "q" is required' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const result = await graphiti.search(query, groupId, numResults);
        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (err: unknown) {
        console.error('[Graphiti API] GET /api/memories/search error:', err);
        return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
};

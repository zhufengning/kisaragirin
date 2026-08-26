import type { APIRoute } from 'astro';

function getGraphiti() {
    const g = globalThis.__graphiti__;
    if (!g || !g.isReady) throw new Error('Graphiti not initialized');
    return g;
}

export const GET: APIRoute = async ({ url }) => {
    try {
        const graphiti = getGraphiti();
        const page = parseInt(url.searchParams.get('page') || '1', 10);
        const pageSize = parseInt(url.searchParams.get('page_size') || '50', 10);
        const groupId = url.searchParams.get('group_id') || 'default';
        const offset = (page - 1) * pageSize;

        const result = await graphiti.getEdges(groupId, pageSize, offset);
        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (err: unknown) {
        console.error('[Graphiti API] GET /api/memories error:', err);
        return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
};

export const POST: APIRoute = async ({ request }) => {
    try {
        const graphiti = getGraphiti();
        const body = await request.json();

        const { content, group_id } = body;

        if (!content || typeof content !== 'string') {
            return new Response(JSON.stringify({ error: 'content is required' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const groupId = group_id || 'default';
        const now = new Date().toISOString();

        const result = await graphiti.addEpisode(groupId, {
            name: `memory_${Date.now()}`,
            content: JSON.stringify({sender: 'manual', content, timestamp: now}),
            source_description: '手动添加的记忆',
            reference_time: now
        });

        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (err: unknown) {
        console.error('[Graphiti API] POST /api/memories error:', err);
        return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
};

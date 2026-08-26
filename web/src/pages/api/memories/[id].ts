import type { APIRoute } from 'astro';

function getGraphiti() {
    const g = globalThis.__graphiti__;
    if (!g || !g.isReady) throw new Error('Graphiti not initialized');
    return g;
}

export const GET: APIRoute = async ({ params }) => {
    try {
        const graphiti = getGraphiti();
        const uuid = params.id!;
        const result = await graphiti.getEdge(uuid);
        if (!result) {
            return new Response(JSON.stringify({ error: 'Edge not found' }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (err: unknown) {
        console.error(`[Graphiti API] GET /api/memories/${params.id} error:`, err);
        return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
};

export const DELETE: APIRoute = async ({ params }) => {
    try {
        const graphiti = getGraphiti();
        const uuid = params.id!;
        await graphiti.deleteEdge(uuid);
        return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (err: unknown) {
        console.error(`[Graphiti API] DELETE /api/memories/${params.id} error:`, err);
        return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
};

// PUT 不再支持（Graphiti 的边是 LLM 提取的事实，不支持直接编辑内容）
export const PUT: APIRoute = async () => {
    return new Response(JSON.stringify({ error: 'Edge editing is not supported in Graphiti. Delete and re-add instead.' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' },
    });
};

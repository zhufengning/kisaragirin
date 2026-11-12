import type {APIRoute} from 'astro';

function jsonResponse (body: Record<string, unknown>, status: number): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {'Content-Type': 'application/json'}
    });
}

export const PUT: APIRoute = async ({params, request}) => {
    try {
        const groupId = Number(params.id);
        if (!groupId || isNaN(groupId)) {
            return jsonResponse({success: false, error: 'Invalid group ID'}, 400);
        }

        const body = await request.json() as {content?: unknown};
        const content = typeof body.content === 'string' ? body.content.trim() : '';
        if (!content) {
            return jsonResponse({success: false, error: '总体记忆内容不能为空'}, 400);
        }

        const manager = globalThis.__replyManagers__?.get(groupId);
        if (!manager) {
            return jsonResponse({success: false, error: 'Group not found or not whitelisted'}, 404);
        }

        await manager.updateOverallMemory(content);
        return jsonResponse({success: true}, 200);
    } catch (err: unknown) {
        console.error('[Overall Memory API] PUT error:', err);
        return jsonResponse({success: false, error: err instanceof Error ? err.message : String(err)}, 500);
    }
};

export const DELETE: APIRoute = async ({params}) => {
    try {
        const groupId = Number(params.id);
        if (!groupId || isNaN(groupId)) {
            return jsonResponse({success: false, error: 'Invalid group ID'}, 400);
        }

        const manager = globalThis.__replyManagers__?.get(groupId);
        if (!manager) {
            return jsonResponse({success: false, error: 'Group not found or not whitelisted'}, 404);
        }

        await manager.clearOverallMemory();
        return jsonResponse({success: true}, 200);
    } catch (err: unknown) {
        console.error('[Overall Memory API] DELETE error:', err);
        return jsonResponse({success: false, error: err instanceof Error ? err.message : String(err)}, 500);
    }
};

export const prerender = false;

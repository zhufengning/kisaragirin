import type {APIRoute} from 'astro';

export const DELETE: APIRoute = async ({params}) => {
    try {
        const groupId = Number(params.id);
        if (!groupId || isNaN(groupId)) {
            return new Response(JSON.stringify({success: false, error: 'Invalid group ID'}), {
                status: 400,
                headers: {'Content-Type': 'application/json'}
            });
        }

        const manager = globalThis.__replyManagers__?.get(groupId);
        if (!manager) {
            return new Response(JSON.stringify({
                success: false,
                error: 'Group not found or not whitelisted'
            }), {
                status: 404,
                headers: {'Content-Type': 'application/json'}
            });
        }

        await manager.clearOverallMemory();
        return new Response(JSON.stringify({success: true}), {
            status: 200,
            headers: {'Content-Type': 'application/json'}
        });
    } catch (err: unknown) {
        console.error('[Overall Memory API] DELETE error:', err);
        return new Response(JSON.stringify({
            success: false,
            error: err instanceof Error ? err.message : String(err)
        }), {
            status: 500,
            headers: {'Content-Type': 'application/json'}
        });
    }
};

export const prerender = false;

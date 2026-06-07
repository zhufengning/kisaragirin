import type { APIRoute } from 'astro';
import type { GroupReplyManager } from '~/util/reply-manager';

function getReplyManagers(): Map<number, GroupReplyManager> {
    const m = globalThis.__replyManagers__;
    if (!m) throw new Error('ReplyManagers not initialized');
    return m;
}

function getConfig(): any {
    return (globalThis as any).__config__;
}

export const POST: APIRoute = async ({ request }) => {
    try {
        const url = new URL(request.url);
        const groupId = parseInt(url.searchParams.get('groupId') || '', 10);

        if (!groupId || isNaN(groupId)) {
            return new Response(JSON.stringify({ error: 'groupId is required' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const config = getConfig();
        if (!config) {
            return new Response(JSON.stringify({ error: 'Config not available' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const replyManagers = getReplyManagers();
        const manager = replyManagers.get(groupId);
        if (!manager) {
            return new Response(JSON.stringify({ error: 'Group not found or not whitelisted' }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const agent = manager.getAgent();
        const compacted = await agent.triggerCompact(groupId, true);

        return new Response(JSON.stringify({
            success: true,
            compacted
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (err: unknown) {
        console.error('[Compact API] POST error:', err);
        return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
};
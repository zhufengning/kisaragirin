import type { APIRoute } from 'astro';
import type { SessionTreeEntry } from '@earendil-works/pi-agent-core';
import type { GroupReplyManager } from '~/util/reply-manager';

function getReplyManagers(): Map<number, GroupReplyManager> {
    const m = globalThis.__replyManagers__;
    if (!m) throw new Error('ReplyManagers not initialized');
    return m;
}

export const GET: APIRoute = async ({ url }) => {
    try {
        const groupId = parseInt(url.searchParams.get('groupId') || '', 10);

        if (!groupId || isNaN(groupId)) {
            return new Response(JSON.stringify({ error: 'groupId is required' }), {
                status: 400,
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

        const entries: SessionTreeEntry[] = await manager.getAgent().getBranch();

        return new Response(JSON.stringify({ entries }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (err: unknown) {
        console.error('[Harness API] GET /api/harness error:', err);
        return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
};

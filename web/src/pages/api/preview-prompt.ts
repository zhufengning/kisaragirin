import type { APIRoute } from 'astro';
import { db, schema } from '@lib/db';
import { eq, desc } from 'drizzle-orm';
import type { StoredMessage } from '~/message-format';
import type { ReplyTask } from '~/util/reply-manager';
import type { GroupReplyManager } from '~/util/reply-manager';

function getReplyManagers(): Map<number, GroupReplyManager> {
    const m = (globalThis as any).__replyManagers__;
    if (!m) throw new Error('ReplyManagers not initialized');
    return m;
}

export const GET: APIRoute = async ({ url }) => {
    try {
        const groupId = parseInt(url.searchParams.get('groupId') || '', 10);
        const type = url.searchParams.get('type') || 'silence';

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

        const latestRows = await db
            .select()
            .from(schema.messages)
            .where(eq(schema.messages.groupId, groupId))
            .orderBy(desc(schema.messages.id))
            .limit(1);

        if (latestRows.length === 0) {
            return new Response(JSON.stringify({ error: 'No messages in this group' }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const row = latestRows[0];
        const triggerMessage: StoredMessage = {
            time: row.time,
            messageId: row.messageId,
            senderId: row.userId,
            senderName: row.senderName,
            senderCard: row.senderCard ?? undefined,
            isBot: row.isBot,
            isAtBot: row.isAtBot,
            segments: row.segments as any,
        };

        const task: ReplyTask = {
            type: type === 'at' ? 'at' : 'silence',
            triggerDbId: row.id,
            triggerMessageId: row.messageId,
            triggerMessage,
        };

        const agent = manager.getAgent();
        const prompt = await agent.buildPrompt(groupId, manager.lastTriggerId, task);

        return new Response(JSON.stringify({ prompt }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (err: any) {
        console.error('[Preview API] GET /api/preview-prompt error:', err);
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
};

import type { APIRoute } from 'astro';
import type { GroupReplyManager } from '~/util/reply-manager';

function getReplyManagers(): Map<number, GroupReplyManager> {
    const m = globalThis.__replyManagers__;
    if (!m) throw new Error('ReplyManagers not initialized');
    return m;
}

function parseDateToTimestamp (dateStr: string, endOfDay: boolean): number | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (endOfDay) {
        return Math.floor(new Date(year, month - 1, day, 23, 59, 59, 999).getTime() / 1000);
    }
    return Math.floor(new Date(year, month - 1, day, 0, 0, 0, 0).getTime() / 1000);
}

export const POST: APIRoute = async ({ request, params }) => {
    try {
        const groupId = Number(params.id);
        if (!groupId || isNaN(groupId)) {
            return new Response(JSON.stringify({ success: false, error: 'Invalid group ID' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const body = await request.json().catch(() => null) as { startDate?: string; endDate?: string } | null;
        const startDate = body?.startDate;
        const endDate = body?.endDate;
        if (!startDate || !endDate) {
            return new Response(
                JSON.stringify({ success: false, error: 'startDate and endDate are required (YYYY-MM-DD)' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const startTime = parseDateToTimestamp(startDate, false);
        const endTime = parseDateToTimestamp(endDate, true);
        if (startTime === null || endTime === null) {
            return new Response(JSON.stringify({ success: false, error: 'Invalid date format (YYYY-MM-DD)' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        if (startTime > endTime) {
            return new Response(JSON.stringify({ success: false, error: 'startDate must be <= endDate' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const replyManagers = getReplyManagers();
        const manager = replyManagers.get(groupId);
        if (!manager) {
            return new Response(JSON.stringify({ success: false, error: 'Group not found or not whitelisted' }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const imported = await manager.getAgent().importMessagesByDateRange(startTime, endTime);

        return new Response(JSON.stringify({ success: true, imported }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (err: unknown) {
        console.error('[Import API] POST error:', err);
        return new Response(JSON.stringify({
            success: false,
            error: err instanceof Error ? err.message : String(err)
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
};

export const prerender = false;

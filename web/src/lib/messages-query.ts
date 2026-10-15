import { db, schema } from '@lib/db';
import { eq, and, or, like, sql } from 'drizzle-orm';
import { collectImageSha256FromSegment, type StoredSegment } from '~/message-format';

export const MESSAGES_PAGE_SIZE = 50;

export interface MessageImageInfo {
    sha256: string;
    description: string | null;
}

export interface MessageListItem {
    id: number;
    time: number;
    messageId: number;
    senderId: number;
    senderName: string;
    senderCard?: string;
    isBot: boolean;
    isAtBot: boolean;
    specialType: 'normal' | 'compact' | 'system';
    segments: StoredSegment[];
    images: MessageImageInfo[];
}

export interface MessagesPageData {
    messages: MessageListItem[];
    totalCount: number;
    totalPages: number;
    validPage: number;
    searchQuery: string;
    sortDesc: boolean;
}

/** 提取消息中的图片列表（含 reply/forward 嵌套），按出现顺序去重 */
function collectImages (
    segments: StoredSegment[],
    images: MessageImageInfo[],
    seen: Set<string>,
    imageDescriptions: Map<string, string | null>,
): void {
    for (const seg of segments) {
        if (seg.type === 'image') {
            if (!seen.has(seg.sha256)) {
                seen.add(seg.sha256);
                images.push({ sha256: seg.sha256, description: imageDescriptions.get(seg.sha256) ?? null });
            }
        } else if (seg.type === 'reply' && seg.message) {
            collectImages(seg.message.segments, images, seen, imageDescriptions);
        } else if (seg.type === 'forward' && seg.messages) {
            for (const m of seg.messages) collectImages(m.segments, images, seen, imageDescriptions);
        }
    }
}

export async function loadMessagesPageData (url: URL, groupId: number): Promise<MessagesPageData> {
    const currentPage = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const searchQuery = url.searchParams.get('search')?.trim() || '';
    const sortDirParam = url.searchParams.get('sort')?.toLowerCase();
    const sortDesc = sortDirParam === 'asc' ? false : true; // 默认新在前（降序）

    // 搜索条件：发送者名称/名片、原始消息文本、segments JSON
    const baseCondition = eq(schema.messages.groupId, groupId);
    let whereClause = baseCondition;

    if (searchQuery) {
        const searchPattern = `%${searchQuery}%`;
        whereClause = and(
            baseCondition,
            or(
                like(schema.messages.senderName, searchPattern),
                like(schema.messages.senderCard, searchPattern),
                like(schema.messages.rawMessage, searchPattern),
                sql`json_extract(${schema.messages.segments}, '$') LIKE ${searchPattern}`
            )
        ) ?? baseCondition;
    }

    // 总消息数
    const countResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.messages)
        .where(whereClause);
    const totalCount = countResult[0]?.count || 0;
    const totalPages = Math.max(1, Math.ceil(totalCount / MESSAGES_PAGE_SIZE));
    const validPage = Math.min(currentPage, totalPages);

    // 分页查询消息，默认按 ID 降序（新消息在前），方向可通过 sort 参数切换
    const orderColumn = schema.messages.id;
    const rows = await db
        .select()
        .from(schema.messages)
        .where(whereClause)
        .orderBy(sql`${orderColumn} ${sortDesc ? sql`DESC` : sql`ASC`}`)
        .limit(MESSAGES_PAGE_SIZE)
        .offset((validPage - 1) * MESSAGES_PAGE_SIZE);

    const messages: MessageListItem[] = rows.map(r => ({
        id: r.id,
        time: r.time,
        messageId: r.messageId,
        senderId: r.userId,
        senderName: r.senderName,
        senderCard: r.senderCard ?? undefined,
        isBot: r.isBot,
        isAtBot: r.isAtBot,
        specialType: r.specialType,
        segments: r.segments as StoredSegment[],
        images: []
    }));

    // 收集本页消息中所有图片 sha256（含 reply/forward 嵌套），批量查询图片描述
    const pageShaSet = new Set<string>();
    for (const msg of messages) {
        for (const seg of msg.segments) collectImageSha256FromSegment(seg, pageShaSet);
    }
    const pageShaList = Array.from(pageShaSet);
    const imageDescRows = pageShaList.length > 0
        ? await db.select().from(schema.images).where(sql`${schema.images.sha256} IN ${pageShaList}`)
        : [];
    const imageDescMap = new Map(imageDescRows.map(r => [r.sha256, r.description]));

    for (const msg of messages) {
        collectImages(msg.segments, msg.images, new Set(), imageDescMap);
    }

    return { messages, totalCount, totalPages, validPage, searchQuery, sortDesc };
}

export function buildSortUrl (url: URL, sortDesc: boolean): string {
    const target = new URL(url);
    target.searchParams.delete('page');
    if (sortDesc) {
        target.searchParams.set('sort', 'asc');
    } else {
        target.searchParams.delete('sort');
    }
    return target.pathname + target.search;
}

export function buildPageUrl (url: URL, page: number): string {
    const target = new URL(url);
    target.searchParams.set('page', String(page));
    return target.pathname + target.search;
}

export function buildSearchUrl (url: URL, search: string): string {
    const target = new URL(url);
    target.searchParams.delete('page');
    if (search) {
        target.searchParams.set('search', search);
    } else {
        target.searchParams.delete('search');
    }
    return target.pathname + target.search;
}

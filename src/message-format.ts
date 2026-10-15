import type {Message, GroupMessageEvent, Bot, ForwardMessage} from '@lib/types';
import {downloadAndStoreImage} from './util/image-store';

/**
 * 群成员昵称缓存
 * key: `${groupId}:${qq}`
 * value: nickname 或 card
 */
const memberNameCache = new Map<string, string>();

async function resolveAtTargetName (
    bot: Bot,
    groupId: number,
    target: string,
): Promise<string | undefined> {
    if (target === 'all') return '全体成员';

    const cacheKey = `${groupId}:${target}`;
    const cached = memberNameCache.get(cacheKey);
    if (cached) return cached;

    try {
        const members = await bot.getGroupMemberList(groupId);
        for (const m of members) {
            const name = m.card || m.nickname;
            memberNameCache.set(`${groupId}:${m.user_id}`, name);
        }
        return memberNameCache.get(cacheKey);
    } catch {
        return;
    }
}

/**
 * 消息数据结构设计与序列化实现
 * 参考 docs/消息格式.md 的 simple-id 消息格式规范
 */

export interface StoredTextSegment {
    type: 'text';
    text: string;
}

export interface StoredAtSegment {
    type: 'at';
    /** QQ 号或 'all' */
    target: string;
    targetName?: string;
}

export interface StoredImageSegment {
    type: 'image';
    /** 图片文件 sha256（文件保存在 data/images/${sha256}.${ext}） */
    sha256: string;
}

export interface StoredFaceSegment {
    type: 'face';
    id: number | string;
    name?: string;
}

export interface StoredRecordSegment {
    type: 'record';
}

export interface StoredVideoSegment {
    type: 'video';
    fileName?: string;
}

export interface StoredFileSegment {
    type: 'file';
    fileName: string;
}

export interface StoredJsonSegment {
    type: 'json';
    /** 原始 JSON 字符串（QQ 小程序/卡片消息内容） */
    data?: string;
}

export interface StoredPokeSegment {
    type: 'poke';
    pokeType: string;
    id: string;
}

export interface StoredDiceSegment {
    type: 'dice';
    result?: number;
}

export interface StoredRpsSegment {
    type: 'rps';
    result?: number;
}

export interface StoredReplySegment {
    type: 'reply';
    /** 引用消息 ID */
    id: number;
    /** 解析后的引用消息；若未解析则 toString 时回退 */
    message?: StoredMessage;
}

export interface StoredForwardSegment {
    type: 'forward';
    /** 合并转发消息 ID */
    id: number;
    /** 解析后的子消息列表；若未解析则 toString 时回退 */
    messages?: StoredMessage[];
}

export interface StoredCompactSegment {
    type: 'compact';
    text: string;
}

export interface StoredSystemSegment {
    type: 'system';
    text: string;
}

export type StoredSegment =
    | StoredTextSegment
    | StoredAtSegment
    | StoredImageSegment
    | StoredFaceSegment
    | StoredRecordSegment
    | StoredVideoSegment
    | StoredFileSegment
    | StoredJsonSegment
    | StoredPokeSegment
    | StoredDiceSegment
    | StoredRpsSegment
    | StoredReplySegment
    | StoredForwardSegment
    | StoredCompactSegment
    | StoredSystemSegment;

export interface StoredMessage {
    /** 数据库自增行 ID（仅内部使用，不序列化到 OneBot） */
    id?: number;
    /** Unix 时间戳（秒） */
    time: number;
    /** 消息 ID */
    messageId?: number;
    /** 发送者 QQ */
    senderId?: number;
    /** QQ 昵称 */
    senderName: string;
    /** 群名片，优先于昵称展示 */
    senderCard?: string;
    /** 是否为机器人自己 */
    isBot?: boolean;
    /** 是否 @ 了机器人 */
    isAtBot?: boolean;
    /** 消息正文段 */
    segments: StoredSegment[];
}

/** 渲染上下文，用于控制缩进与嵌套状态 */
interface RenderContext {
    /** 2 空格缩进层级 */
    indent: number;
    /** reply 嵌套深度；0 表示第一层，>0 表示嵌套 */
    replyDepth: number;
    /** 是否处于 forward 内部（用于重置 reply 层数） */
    inForward: boolean;
    /** 单次渲染内的图片描述缓存 sha256 -> description */
    descCache: Map<string, string | undefined>;
}

function indentStr (level: number): string {
    return '  '.repeat(level);
}

/** 格式化发送者名称 */
export function formatSender (msg: StoredMessage): string {
    const id = msg.senderId;
    const name = msg.senderCard || msg.senderName || '';
    if (id === null || typeof id === 'undefined') return 'unknown';
    if (!name) return `(${id})`;
    if (msg.isBot) return `${name}(me)(${id})`;
    return `${name}(${id})`;
}

function renderBody (segments: StoredSegment[], ctx: RenderContext): string {
    return segments.map(s => renderSegment(s, ctx)).join('');
}

export function collectImageSha256FromSegment (seg: StoredSegment, shaSet: Set<string>): void {
    switch (seg.type) {
    case 'image':
        shaSet.add(seg.sha256);
        break;
    case 'reply':
        if (seg.message) {
            for (const s of seg.message.segments) {
                collectImageSha256FromSegment(s, shaSet);
            }
        }
        break;
    case 'forward':
        if (seg.messages) {
            for (const msg of seg.messages) {
                for (const s of msg.segments) {
                    collectImageSha256FromSegment(s, shaSet);
                }
            }
        }
        break;
    }
}

function renderSegment (seg: StoredSegment, ctx: RenderContext): string {
    switch (seg.type) {
    case 'text':
        return seg.text;
    case 'at':
        return `@${seg.targetName || '未知用户'}`;
    case 'image':
        return `[image: ${ctx.descCache.get(seg.sha256) || '未知图片'}]`;
    case 'face':
        return `[face: ${seg.name || seg.id}]`;
    case 'record':
        return '[record: 语音]';
    case 'video':
        return `[video: ${seg.fileName || '未知视频'}]`;
    case 'file':
        return `[file: ${seg.fileName}]`;
    case 'json':
        return `[json: ${seg.data ?? '未知json'}]`;
    case 'poke':
        return `[poke: ${seg.pokeType},${seg.id}]`;
    case 'dice':
        return `[dice: ${seg.result ?? '未知结果'}]`;
    case 'rps':
        return `[rps: ${seg.result ?? '未知结果'}]`;
    case 'reply':
        return renderReply(seg, ctx);
    case 'forward':
        return renderForward(seg, ctx);
    case 'compact':
        return `**前情提要**: ${seg.text}`;
    case 'system':
        return `**系统消息**: ${seg.text}`;
    default:
        return '';
    }
}

function renderReply (seg: StoredReplySegment, ctx: RenderContext): string {
    const refMsg = seg.message;
    if (!refMsg) {
        return `[ref:reply-${seg.id}]`;
    }
    const sender = formatSender(refMsg);
    if (ctx.replyDepth === 0) {
        const body = renderBody(refMsg.segments, {
            indent: ctx.indent + 1,
            replyDepth: 1,
            inForward: ctx.inForward,
            descCache: ctx.descCache
        });
        const refId = typeof refMsg.id === 'number' ? `(#${refMsg.id})` : '';
        return `\n${indentStr(ctx.indent + 1)}${refId}[ref ${sender}]: ${body}\n+++\n\n`;
    }
    return `[ref ${sender}]`;
}

function renderForward (seg: StoredForwardSegment, ctx: RenderContext): string {
    if (!seg.messages || seg.messages.length === 0) {
        return `[forward:${seg.id}]`;
    }
    const lines: string[] = [];
    for (const msg of seg.messages) {
        const sender = formatSender(msg);
        const body = renderBody(msg.segments, {
            indent: ctx.indent + 1,
            replyDepth: 0,
            inForward: true,
            descCache: ctx.descCache
        });
        lines.push(`\n${indentStr(ctx.indent + 1)}[forward ${sender}]: ${body}`);
    }
    return lines.join('');
}

/** 单次渲染内批量预取图片描述并缓存 */
async function preloadDescCache (
    segmentGroups: StoredSegment[][],
    resolveDesc?: (sha256: string) => Promise<string | undefined>
): Promise<Map<string, string | undefined>> {
    const descCache = new Map<string, string | undefined>();
    if (!resolveDesc) return descCache;

    const shaSet = new Set<string>();
    for (const segments of segmentGroups) {
        for (const seg of segments) {
            collectImageSha256FromSegment(seg, shaSet);
        }
    }
    const entries = await Promise.all(
        Array.from(shaSet, async sha => [sha, await resolveDesc(sha)] as const)
    );
    for (const [sha, desc] of entries) {
        descCache.set(sha, desc);
    }
    return descCache;
}

/** 单条消息 toString（异步，支持通过 resolveDesc 查询图片描述） */
export async function singleMessageToString (
    msg: StoredMessage,
    resolveDesc?: (sha256: string) => Promise<string | undefined>
): Promise<string> {
    const descCache = await preloadDescCache([msg.segments], resolveDesc);

    const atMark = msg.isAtBot ? '(有人@我)' : '';
    const idTag = typeof msg.id === 'number' ? `(#${msg.id})` : '';
    const sender = formatSender(msg);
    const body = renderBody(msg.segments, {indent: 0, replyDepth: 0, inForward: false, descCache});
    if (!body) return `${atMark}${idTag}[${sender}]:`;
    if (body.startsWith('\n')) return `${atMark}${idTag}[${sender}]:${body}`;
    return `${atMark}${idTag}[${sender}]: ${body}`;
}

/** 消息数组 toString（异步，单次渲染内部缓存描述） */
export async function messagesToString (
    messages: StoredMessage[],
    resolveDesc?: (sha256: string) => Promise<string | undefined>
): Promise<string> {
    if (messages.length === 0) return '';

    const descCache = await preloadDescCache(messages.map(m => m.segments), resolveDesc);

    const parts: string[] = ['---'];
    let lastTime: number | null = null;

    for (const msg of messages) {
        if (lastTime === null || msg.time - lastTime > 180) {
            const d = new Date(msg.time * 1000);
            const pad = (n: number) => String(n).padStart(2, '0');
            const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}` +
                `-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
            parts.push(ts);
            parts.push('---');
        }
        lastTime = msg.time;

        const atMark = msg.isAtBot ? '(有人@我)' : '';
        const sender = formatSender(msg);
        const body = renderBody(msg.segments, {indent: 0, replyDepth: 0, inForward: false, descCache});

        // 特殊消息类型直接渲染内容，不显示发送者和消息ID
        const isSpecial = msg.segments.length === 1 &&
            (msg.segments[0].type === 'compact' || msg.segments[0].type === 'system');
        if (isSpecial) {
            parts.push(body);
        } else if (!body) {
            const idTag = typeof msg.id === 'number' ? `(#${msg.id})` : '';
            parts.push(`${atMark}${idTag}[${sender}]:`);
        } else if (body.startsWith('\n')) {
            const idTag = typeof msg.id === 'number' ? `(#${msg.id})` : '';
            parts.push(`${atMark}${idTag}[${sender}]:${body}`);
        } else {
            const idTag = typeof msg.id === 'number' ? `(#${msg.id})` : '';
            parts.push(`${atMark}${idTag}[${sender}]: ${body}`);
        }
        parts.push('');
        parts.push('---');
    }

    return `${parts.join('\n')}\n`;
}

type ForwardedMessageItem = NonNullable<ForwardMessage['data']['content']>[number];

/** 合并转发或引用消息中单条子消息的存储格式转换 */
async function toNestedStoredMessage (
    bot: Bot,
    item: ForwardedMessageItem,
): Promise<StoredMessage | null> {
    if (!Array.isArray(item.message)) return null;
    return {
        time: item.time ?? 0,
        messageId: item.message_id,
        senderId: item.sender?.user_id,
        senderName: item.sender?.nickname ?? '',
        senderCard: item.sender?.card,
        segments: await onebotMessageToSegments(bot, item.group_id ?? 0, item.message)
    };
}

async function toNestedStoredMessages (
    bot: Bot,
    items: unknown,
): Promise<StoredMessage[] | undefined> {
    if (!Array.isArray(items)) return undefined;
    const nested: StoredMessage[] = [];
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const msg = await toNestedStoredMessage(bot, item as ForwardedMessageItem);
        if (msg) nested.push(msg);
    }
    return nested;
}

/** 将 OneBot Message 数组转换为 StoredSegment 数组（不生成描述） */
export async function onebotMessageToSegments (
    bot: Bot,
    groupId: number,
    msgs: Message[],
): Promise<StoredSegment[]> {
    const out: StoredSegment[] = [];
    for (const m of msgs) {
        switch (m.type) {
        case 'text':
            out.push({type: 'text', text: m.data.text});
            break;
        case 'at': {
            const targetName = await resolveAtTargetName(bot, groupId, m.data.qq);
            out.push({type: 'at', target: m.data.qq, targetName});
            break;
        }
        case 'image': {
            const {sha256} = await downloadAndStoreImage(m.data.url);
            out.push({type: 'image', sha256});
            break;
        }
        case 'face': {
            const name = m.data.raw?.faceText as string | undefined;
            out.push({type: 'face', id: m.data.id, ...(name ? {name} : {})});
            break;
        }
        case 'record':
            out.push({type: 'record'});
            break;
        case 'video':
            out.push({type: 'video', fileName: m.data.file});
            break;
        case 'file':
            out.push({type: 'file', fileName: m.data.file});
            break;
        case 'json':
            out.push({type: 'json', data: m.data.data});
            break;
        case 'poke':
            out.push({type: 'poke', pokeType: m.data.type, id: m.data.id});
            break;
        case 'dice':
            out.push({type: 'dice'});
            break;
        case 'rps':
            out.push({type: 'rps'});
            break;
        case 'reply': {
            let nested: StoredMessage | undefined;
            try {
                const res = await bot.getMsg(m.data.id);
                const nestedMsgs = typeof res.message === 'string' ? [] : res.message;
                const nestedGroupId = 'group_id' in res ? (res as { group_id: number }).group_id : 0;
                nested = await toNestedStoredMessage(bot, {
                    time: res.time,
                    message_id: res.message_id,
                    sender: res.sender,
                    group_id: nestedGroupId,
                    message: nestedMsgs
                }) ?? undefined;
            } catch {
                // API 失败时不阻塞主消息入库
            }
            out.push({type: 'reply', id: m.data.id, ...(nested ? {message: nested} : {})});
            break;
        }
        case 'forward': {
            let nested: StoredMessage[] | undefined;
            const content = (m as ForwardMessage).data?.content;
            if (Array.isArray(content)) {
                nested = await toNestedStoredMessages(bot, content);
            } else {
                try {
                    const res = await bot.getForwardMsg(String(m.data.id));
                    type ForwardResponse = {messages?: unknown; message?: unknown};
                    const rawMessages = (res as ForwardResponse).messages ??
                        (res as ForwardResponse).message;
                    nested = await toNestedStoredMessages(bot, rawMessages);
                } catch {
                    // API 失败时不阻塞主消息入库
                }
            }
            out.push({type: 'forward', id: m.data.id, ...(nested ? {messages: nested} : {})});
            break;
        }
        default:
            out.push({type: 'text', text: `[${(m as Message).type}]`});
        }
    }
    return out;
}

/** 将 OneBot 群消息事件转换为 StoredMessage */
export async function groupMessageEventToStoredMessage (
    event: GroupMessageEvent,
    bot: Bot,
): Promise<StoredMessage> {
    const msgs = typeof event.message === 'string' ? [] : event.message;
    const segments = await onebotMessageToSegments(bot, event.group_id, msgs);
    const isAtBot = segments.some(
        s => s.type === 'at' && s.target === String(event.self_id)
    );
    return {
        time: event.time,
        messageId: event.message_id,
        senderId: event.user_id,
        senderName: event.sender.nickname ?? '',
        senderCard: event.sender.card,
        isBot: event.user_id === event.self_id,
        isAtBot,
        segments
    };
}

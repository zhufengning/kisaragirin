import {Type} from 'typebox';
import {defineTool, type ToolDefinition} from '@earendil-works/pi-coding-agent';
import type {Bot} from '@lib/types';
import {and, eq, gt, ne} from 'drizzle-orm';
import {schema, type Db} from '~/db';
import {prompts} from '~/prompts';
import {Logger} from '@lib/util/logger';

export interface CreateGroupAdminToolsOptions {
    bot: Bot;
    db: Db;
    groupId: number;
    /** bot 自己的 QQ 号 */
    selfId: number;
}

interface SetGroupBanDetails {
    userId?: number;
    duration: number;
}

interface DeleteMsgDetails {
    messageId: number;
    found: boolean;
}

interface MemberCandidate {
    userId: number;
    label: string;
    names: string[];
}

type MemberLookup =
    {kind: 'found'; userId: number; label: string} |
    {kind: 'missing'} |
    {kind: 'ambiguous'; candidates: string[]};

function isGroupAdmin (role: string): boolean {
    return role === 'admin' || role === 'owner';
}

function candidateLabel (userId: number, names: string[]): string {
    const name = names.find(value => value.length > 0) ?? '';
    return name ? `${name}(${userId})` : `(${userId})`;
}

function addCandidate (
    candidates: Map<number, MemberCandidate>,
    userId: number,
    names: string[]
): void {
    const cleaned = names
        .map(name => name.trim())
        .filter(name => name.length > 0);
    const existing = candidates.get(userId);
    if (!existing) {
        candidates.set(userId, {userId, label: candidateLabel(userId, cleaned), names: cleaned});
        return;
    }
    for (const name of cleaned) {
        if (!existing.names.includes(name)) existing.names.push(name);
    }
}

/**
 * 本群成员名称候选。
 * 优先使用消息库记录的历史昵称与群名片：qbob 等实现的群成员缓存可能滞后，
 * 但每条消息都带着当时的群名片。
 */
async function loadMemberCandidates (
    db: Db, groupId: number, selfId: number
): Promise<Map<number, MemberCandidate>> {
    const rows = await db
        .selectDistinct({
            userId: schema.messages.userId,
            senderName: schema.messages.senderName,
            senderCard: schema.messages.senderCard
        })
        .from(schema.messages)
        .where(and(
            eq(schema.messages.groupId, groupId),
            eq(schema.messages.isBot, false),
            gt(schema.messages.userId, 0),
            ne(schema.messages.userId, selfId)
        ));

    const candidates = new Map<number, MemberCandidate>();
    for (const row of rows) {
        addCandidate(candidates, row.userId, [row.senderCard ?? '', row.senderName ?? '']);
    }
    return candidates;
}

/** 合并 OneBot 当前返回的群成员；成员库没有记录时作为补充 */
async function appendApiMembers (
    candidates: Map<number, MemberCandidate>,
    bot: Bot,
    groupId: number,
    selfId: number
): Promise<void> {
    const members = await bot.getGroupMemberList(groupId);
    for (const member of members) {
        if (member.user_id === selfId) continue;
        addCandidate(candidates, member.user_id, [member.card ?? '', member.nickname ?? '']);
    }
}

function matchCandidates (
    candidates: Map<number, MemberCandidate>,
    query: string,
    mode: 'exact' | 'partial'
): MemberLookup {
    const matched = new Map<number, string>();
    for (const candidate of candidates.values()) {
        const hit = candidate.names.some(name =>
            (mode === 'exact' ? name === query : name.includes(query)));
        if (hit) matched.set(candidate.userId, candidate.label);
    }
    const ids = Array.from(matched.keys());
    if (ids.length === 1) {
        return {kind: 'found', userId: ids[0], label: matched.get(ids[0]) ?? ''};
    }
    if (ids.length > 1) {
        return {kind: 'ambiguous', candidates: Array.from(matched.values())};
    }
    return {kind: 'missing'};
}

/** 按 OneBot 用户ID 或群名片/昵称在本群成员中查找目标成员 */
async function lookupGroupMember (options: {
    bot: Bot;
    db: Db;
    groupId: number;
    selfId: number;
    userId?: number;
    userName?: string;
}): Promise<MemberLookup> {
    const candidates = await loadMemberCandidates(options.db, options.groupId, options.selfId);

    if (options.userId !== undefined) {
        const known = candidates.get(options.userId);
        if (known) return {kind: 'found', userId: known.userId, label: known.label};
        await appendApiMembers(candidates, options.bot, options.groupId, options.selfId);
        const member = candidates.get(options.userId);
        return member ?
            {kind: 'found', userId: member.userId, label: member.label} :
            {kind: 'missing'};
    }

    const query = (options.userName ?? '').trim();
    let lookup = matchCandidates(candidates, query, 'exact');
    if (lookup.kind === 'missing') lookup = matchCandidates(candidates, query, 'partial');
    if (lookup.kind !== 'missing') return lookup;

    await appendApiMembers(candidates, options.bot, options.groupId, options.selfId);
    lookup = matchCandidates(candidates, query, 'exact');
    if (lookup.kind === 'missing') lookup = matchCandidates(candidates, query, 'partial');
    return lookup;
}

/**
 * 群管理工具（set_group_ban / delete_msg）。
 * 用 get_group_member_info 查询 bot 自己在群里的平台角色，是管理员或群主时才注册这两个工具。
 * 角色在创建该群的 ReplyAgent 时确定；会话期间角色变化不会改变工具集合，具体操作是否允许由平台判定。
 */
export async function createGroupAdminTools (
    options: CreateGroupAdminToolsOptions
): Promise<ToolDefinition[]> {
    const logger = new Logger();
    const {bot, db, groupId, selfId} = options;

    let role: string;
    try {
        role = (await bot.getGroupMemberInfo(groupId, selfId, true)).role;
    } catch (err) {
        logger.warn(
            `[GroupAdminTool] [${groupId}] failed to query bot role, admin tools disabled:`, err);
        return [];
    }

    if (!isGroupAdmin(role)) {
        logger.info(`[GroupAdminTool] [${groupId}] bot role is ${role}, admin tools disabled`);
        return [];
    }
    logger.info(`[GroupAdminTool] [${groupId}] bot role is ${role}, admin tools enabled`);

    const banDescriptions = prompts.setGroupBanToolParameterDescriptions();
    const setGroupBanSchema = Type.Object({
        user_id: Type.Optional(Type.Number({description: banDescriptions.userId})),
        user_name: Type.Optional(Type.String({description: banDescriptions.userName})),
        duration: Type.Number({description: banDescriptions.duration})
    });

    const setGroupBanTool = defineTool<typeof setGroupBanSchema, SetGroupBanDetails>({
        name: 'set_group_ban',
        label: '禁言群成员',
        description: prompts.setGroupBanToolDescription(),
        parameters: setGroupBanSchema,
        async execute (_toolCallId, params) {
            const userId = typeof params.user_id === 'number' ? params.user_id : undefined;
            const userName = typeof params.user_name === 'string' ? params.user_name.trim() : '';
            if ((userId === undefined) === (userName.length === 0)) {
                return {
                    content: [{type: 'text', text: prompts.setGroupBanTargetRequired()}],
                    details: {duration: params.duration},
                    isError: true
                };
            }

            const lookup = await lookupGroupMember({
                bot,
                db,
                groupId,
                selfId,
                userId,
                userName: userName.length > 0 ? userName : undefined
            });
            if (lookup.kind === 'missing') {
                logger.warn(
                    `[GroupAdminTool] [${groupId}] ban target not found ` +
                    `(user_id=${userId ?? 'none'} user_name=${userName || 'none'})`);
                const text = userId !== undefined ?
                    prompts.setGroupBanTargetIdMissing(userId) :
                    prompts.setGroupBanTargetMissing(userName);
                return {
                    content: [{type: 'text', text}],
                    details: {duration: params.duration},
                    isError: true
                };
            }
            if (lookup.kind === 'ambiguous') {
                logger.warn(
                    `[GroupAdminTool] [${groupId}] ban target ambiguous: ` +
                    `${lookup.candidates.join('、')}`);
                return {
                    content: [{
                        type: 'text',
                        text: prompts.setGroupBanTargetAmbiguous(userName, lookup.candidates)
                    }],
                    details: {duration: params.duration},
                    isError: true
                };
            }

            await bot.setGroupBan(groupId, lookup.userId, params.duration);
            logger.info(
                `[GroupAdminTool] [${groupId}] banned ${lookup.label} for ${params.duration}s`);
            return {
                content: [{
                    type: 'text',
                    text: prompts.setGroupBanSucceeded(lookup.userId, params.duration)
                }],
                details: {userId: lookup.userId, duration: params.duration}
            };
        }
    });

    const deleteDescriptions = prompts.deleteMsgToolParameterDescriptions();
    const deleteMsgSchema = Type.Object({
        message_id: Type.Number({description: deleteDescriptions.messageId})
    });

    const deleteMsgTool = defineTool<typeof deleteMsgSchema, DeleteMsgDetails>({
        name: 'delete_msg',
        label: '撤回消息',
        description: prompts.deleteMsgToolDescription(),
        parameters: deleteMsgSchema,
        async execute (_toolCallId, params) {
            const rows = await db
                .select({messageId: schema.messages.messageId})
                .from(schema.messages)
                .where(and(
                    eq(schema.messages.id, params.message_id),
                    eq(schema.messages.groupId, groupId)
                ))
                .limit(1);
            const target = rows[0];
            if (!target || target.messageId <= 0) {
                logger.warn(
                    `[GroupAdminTool] [${groupId}] message #${params.message_id} not recallable`);
                return {
                    content: [{type: 'text', text: prompts.deleteMsgNotFound(params.message_id)}],
                    details: {messageId: params.message_id, found: false},
                    isError: true
                };
            }

            await bot.deleteMsg(target.messageId);
            logger.info(`[GroupAdminTool] [${groupId}] recalled message #${params.message_id}`);
            return {
                content: [{type: 'text', text: prompts.deleteMsgSucceeded(params.message_id)}],
                details: {messageId: params.message_id, found: true}
            };
        }
    });

    return [setGroupBanTool, deleteMsgTool];
}

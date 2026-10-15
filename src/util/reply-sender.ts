import type {Bot} from '@lib/types';
import type {Message} from '@lib/types/messages';
import {schema, type Db} from '~/db';
import type {StoredMessage, StoredSegment} from '~/message-format';
import type {DescQueue} from './desc-queue';
import type {ReplyMessageItem} from './reply-tool';
import type {ReplyTask} from './reply-task';
import type {ReplyAgent, TurnOutcome} from './reply-agent';
import type {GraphitiClient} from './graphiti-client';
import {addMessageEpisode} from './graphiti-episode';
import {prompts} from '~/prompts';
import {Logger} from '@lib/util/logger';
import {eq} from 'drizzle-orm';

/** 上一轮实际发送的信息，供下一轮回复引用与兜底定位 */
export interface TurnLocation {
    messageId?: number;
    time?: number;
    messages: ReplyMessageItem[];
}

export interface SentTurnItem {
    rowId: number | null;
    messageId?: number;
    time?: number;
}

interface ReplyRef {
    onebotId?: number;
    dbSegment?: StoredSegment;
}

/** 回复发送与落库：一条一条发送回复消息，写入数据库、harness 与 Graphiti 记忆 */
export class ReplySender {
    private readonly bot: Bot;
    private readonly db: Db;
    private readonly agent: ReplyAgent;
    private readonly descQueue: DescQueue;
    private readonly graphiti: GraphitiClient | null;
    private readonly logger: Logger;
    private readonly groupId: number;
    private readonly botSelfId: number;
    private readonly botName: string;
    private readonly onBotMessage: () => void;

    constructor (options: {
        bot: Bot;
        db: Db;
        agent: ReplyAgent;
        descQueue: DescQueue;
        graphiti: GraphitiClient | null;
        logger: Logger;
        groupId: number;
        botSelfId: number;
        botName: string;
        onBotMessage: () => void;
    }) {
        this.bot = options.bot;
        this.db = options.db;
        this.agent = options.agent;
        this.descQueue = options.descQueue;
        this.graphiti = options.graphiti;
        this.logger = options.logger;
        this.groupId = options.groupId;
        this.botSelfId = options.botSelfId;
        this.botName = options.botName;
        this.onBotMessage = options.onBotMessage;
    }

    /**
     * 回合失败时的兜底发送。
     * 消息轮失败：@ 触发回兜底文案，其他触发静默；
     * 深度研究轮失败：所有触发类型都发兜底文案（按研究是否成功区分），并引用上一轮回复
     */
    async sendFailureFallback (
        task: ReplyTask,
        outcome: TurnOutcome,
        botCard: string | null,
        prevTurn?: TurnLocation
    ): Promise<void> {
        if (outcome.researchSuccess === undefined) {
            if (task.type === 'at') {
                this.logger.info(`[ReplyManager] [${this.groupId}] message turn failed, sending fallback`);
                const segments: Message[] = [{type: 'text', data: {text: prompts.atFailureFallback}}];
                await this.bot.sendGroupMsg(this.groupId, segments);
            } else {
                this.logger.info(`[ReplyManager] [${this.groupId}] message turn failed, silent fallback`);
            }
            return;
        }

        const fallbackText = outcome.researchSuccess ?
            prompts.deepResearchFinalFailedFallback :
            prompts.deepResearchFailedFallback;
        this.logger.info(
            `[ReplyManager] [${this.groupId}] research turn failed, sending fallback: ${fallbackText}`);
        await this.sendTurn(task, {
            messages: [{text: fallbackText}],
            prevTurn,
            botCard
        });
    }

    async sendTurn (
        task: ReplyTask,
        options: {
            messages: ReplyMessageItem[];
            prevTurn?: TurnLocation;
            botCard: string | null;
        }
    ): Promise<SentTurnItem[]> {
        const {messages, prevTurn, botCard} = options;

        this.logger.info(
            `[ReplyManager] [${this.groupId}] sending reply ` +
            `${prevTurn ? '(follow-up turn)' : '(message turn)'}: ${messages.length} message(s)`);

        const results: SentTurnItem[] = [];
        for (let i = 0; i < messages.length; i++) {
            const item = messages[i];
            const ref = await this.buildReplyRef(task, item, i, prevTurn, botCard);
            results.push(await this.sendItem({
                item,
                index: i,
                total: messages.length,
                ref,
                botCard
            }));
        }

        return results;
    }

    private async sendItem (options: {
        item: ReplyMessageItem;
        index: number;
        total: number;
        ref: ReplyRef;
        botCard: string | null;
    }): Promise<SentTurnItem> {
        const {item, index, total, ref, botCard} = options;

        const onebotSegments: Message[] = [];
        const dbSegments: StoredSegment[] = [];

        if (ref.onebotId) {
            onebotSegments.push({type: 'reply', data: {id: ref.onebotId}});
        }
        onebotSegments.push({type: 'text', data: {text: item.text}});

        if (ref.dbSegment) {
            dbSegments.push(ref.dbSegment);
        }
        dbSegments.push({type: 'text', text: item.text});

        this.logger.info(
            `[ReplyManager] [${this.groupId}] sending item ${index + 1}/${total}: ` +
            `${item.text.slice(0, 80)}${item.text.length > 80 ? '...' : ''}` +
            `${ref.onebotId ? ` (ref=${item.ref})` : ''}`);

        const sendResult = await this.bot.sendGroupMsg(this.groupId, onebotSegments);
        const now = Math.floor(Date.now() / 1000);

        const insertRows = await this.db.insert(schema.messages).values({
            messageId: sendResult.message_id,
            groupId: this.groupId,
            userId: this.botSelfId,
            time: now,
            senderName: this.botName,
            senderCard: botCard,
            isBot: true,
            isAtBot: false,
            segments: dbSegments as StoredSegment[],
            rawMessage: item.text
        })
            .returning({id: schema.messages.id});

        if (!insertRows[0]) {
            return {rowId: null};
        }

        const rowId = insertRows[0].id;
        this.onBotMessage();

        const botStoredMessage: StoredMessage = {
            id: rowId,
            time: now,
            messageId: sendResult.message_id,
            senderId: this.botSelfId,
            senderName: this.botName,
            senderCard: botCard ?? undefined,
            isBot: true,
            isAtBot: false,
            segments: dbSegments
        };
        await this.agent.appendBotMessage(botStoredMessage);

        // bot 自己的回复也写入 Graphiti 记忆
        if (this.graphiti) {
            addMessageEpisode(this.graphiti, this.groupId, botStoredMessage,
                sha => this.descQueue.resolve(sha));
        }

        return {rowId, messageId: sendResult.message_id, time: now};
    }

    /**
     * 计算本轮一条回复的引用目标。
     * 显式 ref 指向数据库 id；首条消息在 @ 触发时默认引用触发消息，
     * 在后续回合时默认引用上一轮最后一条回复。
     */
    private async buildReplyRef (
        task: ReplyTask,
        item: ReplyMessageItem,
        index: number,
        prevTurn: TurnLocation | undefined,
        botCard: string | null
    ): Promise<ReplyRef> {
        if (typeof item.ref === 'number') {
            const onebotId = await this.resolveRefMessageId(item.ref);
            if (!onebotId) return {};
            return {onebotId, dbSegment: {type: 'reply', id: item.ref}};
        }

        if (index !== 0) return {};

        if (!prevTurn && task.type === 'at') {
            return {
                onebotId: task.triggerMessageId,
                dbSegment: {type: 'reply', id: task.triggerMessageId, message: task.triggerMessage}
            };
        }

        if (prevTurn?.messageId && typeof prevTurn.time === 'number') {
            return {
                onebotId: prevTurn.messageId,
                dbSegment: {
                    type: 'reply',
                    id: prevTurn.messageId,
                    message: {
                        time: prevTurn.time,
                        messageId: prevTurn.messageId,
                        senderId: this.botSelfId,
                        senderName: this.botName,
                        senderCard: botCard ?? undefined,
                        isBot: true,
                        isAtBot: false,
                        segments: [{type: 'text', text: prevTurn.messages.map(m => m.text).join('')}]
                    }
                }
            };
        }

        return {};
    }

    private async resolveRefMessageId (dbId: number): Promise<number | undefined> {
        const rows = await this.db
            .select({messageId: schema.messages.messageId})
            .from(schema.messages)
            .where(eq(schema.messages.id, dbId))
            .limit(1);
        return rows[0]?.messageId ?? undefined;
    }
}

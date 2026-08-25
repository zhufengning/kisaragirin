import type {Bot} from '@lib/types';
import type {Message} from '@lib/types/messages';
import type {Models} from '@earendil-works/pi-ai';
import {schema, type Db, getGroupLastTriggerId, setGroupLastTriggerId, insertSystemMessage} from '~/db';
import {eq, desc} from 'drizzle-orm';
import type {DescQueue} from './desc-queue';
import type {StoredMessage, StoredSegment} from '~/message-format';
import type {AppConfig} from '~/config';
import {ReplyAgent} from './reply-agent';
import type {ReplyMessageItem} from './reply-tool';
import {Logger} from '@lib/util/logger';

export interface ReplyTask {
    type: 'at' | 'silence' | 'scheduled';
    triggerDbId: number;
    triggerMessageId: number;
    triggerMessage: StoredMessage;
    lastTriggerId: number;
    scheduledTaskName?: string;
    preResearchTopic?: string;
}

export interface ScheduledReplyTask {
    name: string;
    prompt: string;
    deepResearchTopic?: string;
}

export class GroupReplyManager {
    groupId: number;
    private bot: Bot;
    private db: Db;
    private descQueue: DescQueue;
    private config: AppConfig;
    private botSelfId: number;
    private botName: string;
    private logger: Logger;
    private agent: ReplyAgent;
    private models: Models;

    private _lastTriggerId: number = 0;
    private pendingAtTimeout: NodeJS.Timeout | null = null;
    private pendingAtMessage: StoredMessage | null = null;
    private pendingAtRowId: number | null = null;
    private silenceTimeout: NodeJS.Timeout | null = null;
    private isReplying: boolean = false;
    private replyQueue: ReplyTask[] = [];
    private processingQueue: boolean = false;

    get lastTriggerId (): number {
        return this._lastTriggerId;
    }

    set lastTriggerId (value: number) {
        this._lastTriggerId = value;
        setGroupLastTriggerId(this.db, this.groupId, value)
            .catch(err => this.logger.error(`[ReplyManager] failed to save lastTriggerId:`, err));
    }

    private constructor (
        groupId: number, bot: Bot, db: Db, descQueue: DescQueue,
        config: AppConfig, botSelfId: number, botName: string,
        models: Models, agent: ReplyAgent, lastTriggerId: number = 0,
    ) {
        this.groupId = groupId;
        this.bot = bot;
        this.db = db;
        this.descQueue = descQueue;
        this.config = config;
        this.botSelfId = botSelfId;
        this.botName = botName;
        this.models = models;
        this.agent = agent;
        this._lastTriggerId = lastTriggerId;
        this.logger = new Logger();
    }

    static async create (
        groupId: number, bot: Bot, db: Db, descQueue: DescQueue,
        config: AppConfig, botSelfId: number, botName: string,
        models: Models,
    ): Promise<GroupReplyManager> {
        const agent = await ReplyAgent.create({
            groupId,
            db,
            descQueue,
            config,
            models,
            memory: config.ai.mem0 ?? null
        });

        let lastTriggerId = 0;
        try {
            lastTriggerId = await getGroupLastTriggerId(db, groupId);
        } catch (err) {
            new Logger().error(`[ReplyManager] failed to load lastTriggerId for group ${groupId}:`, err);
        }

        return new GroupReplyManager(
            groupId, bot, db, descQueue, config, botSelfId, botName, models, agent, lastTriggerId
        );
    }

    getAgent (): ReplyAgent {
        return this.agent;
    }

    getLastTriggerId (): number {
        return this._lastTriggerId;
    }

    onMessage (stored: StoredMessage, _rowId: number): void {
        // 任何消息打破沉默
        this.clearSilenceTimeout();

        // 如果消息不是 bot 的，且当前没有正在回复，启动沉默定时器
        if (!stored.isBot && !this.isReplying) {
            this.startSilenceTimer();
        }

        // @ 触发逻辑
        if (stored.isAtBot) {
            this.logger.info(`[ReplyManager] [${this.groupId}] @ detected on msg ${stored.messageId}`);
            if (this.pendingAtTimeout) {
                // 已有等待窗口，立刻触发旧的
                this.clearPendingAt();
                this.triggerAtReply(this.pendingAtMessage!, this.pendingAtRowId!);
            }
            this.pendingAtMessage = stored;
            this.pendingAtRowId = _rowId;
            this.startAtMergeWindow();
        } else if (this.pendingAtTimeout) {
            // 非 @ 消息，重新计时
            this.clearPendingAt();
            this.startAtMergeWindow();
        }
    }

    onBotMessage (_rowId: number): void {
        this.clearSilenceTimeout();
        // bot 消息不启动沉默定时器
    }

    async triggerScheduledReply (task: ScheduledReplyTask): Promise<void> {
        const prompt = task.prompt.trim();
        if (!prompt) {
            this.logger.warn(
                `[ReplyManager] [${this.groupId}] skip scheduled task "${task.name}": empty prompt`);
            return;
        }

        this.logger.info(
            `[ReplyManager] [${this.groupId}] scheduled task "${task.name}" triggered`);

        const now = Math.floor(Date.now() / 1000);
        const rowId = await insertSystemMessage(this.db, this.groupId, prompt, now);
        const segments: StoredSegment[] = [{type: 'system', text: prompt}];

        const stored: StoredMessage = {
            id: rowId,
            time: now,
            messageId: 0,
            senderId: 0,
            senderName: '系统',
            isBot: true,
            isAtBot: false,
            segments
        };

        this.onBotMessage(rowId);
        this.enqueueTask({
            type: 'scheduled',
            triggerDbId: rowId,
            triggerMessageId: 0,
            triggerMessage: stored,
            lastTriggerId: this.lastTriggerId,
            scheduledTaskName: task.name,
            preResearchTopic: task.deepResearchTopic
        });
    }

    private startAtMergeWindow (): void {
        const ms = this.config.input.merge_window * 1000;
        this.logger.debug(`[ReplyManager] [${this.groupId}] merge window started (${ms}ms)`);
        this.pendingAtTimeout = setTimeout(() => {
            const msg = this.pendingAtMessage;
            const rowId = this.pendingAtRowId;
            this.pendingAtTimeout = null;
            this.pendingAtMessage = null;
            this.pendingAtRowId = null;
            if (msg && rowId !== null) {
                this.triggerAtReply(msg, rowId);
            }
        }, ms);
    }

    private clearPendingAt (): void {
        if (this.pendingAtTimeout) {
            clearTimeout(this.pendingAtTimeout);
            this.pendingAtTimeout = null;
        }
    }

    private triggerAtReply (stored: StoredMessage, rowId: number): void {
        this.logger.info(`[ReplyManager] [${this.groupId}] triggerAtReply msg ${stored.messageId}`);
        this.enqueueTask({
            type: 'at',
            triggerDbId: rowId,
            triggerMessageId: stored.messageId!,
            triggerMessage: stored,
            lastTriggerId: this.lastTriggerId
        });
    }

    private startSilenceTimer (): void {
        const minutes = this.config.input.silence_wait_time;
        this.logger.debug(`[ReplyManager] [${this.groupId}] silence timer started (${minutes}min)`);
        this.silenceTimeout = setTimeout(() => this.onSilenceTimeout(), minutes * 60 * 1000);
    }

    private clearSilenceTimeout (): void {
        if (this.silenceTimeout) {
            this.logger.debug(`[ReplyManager] [${this.groupId}] silence timer cleared`);
            clearTimeout(this.silenceTimeout);
            this.silenceTimeout = null;
        }
    }

    private async onSilenceTimeout (): Promise<void> {
        this.silenceTimeout = null;
        this.logger.debug(`[ReplyManager] [${this.groupId}] silence timeout fired`);

        // 闲时触发前，如有正在进行的回复，则取消该闲时触发和沉默状态
        if (this.isReplying) {
            this.logger.debug(`[ReplyManager] [${this.groupId}] skip silence: replying`);
            return;
        }

        const probability = this.config.input.reply_probability;
        const roll = Math.random();
        this.logger.debug(`[ReplyManager] [${this.groupId}] silence roll=${roll.toFixed(3)} vs prob=${probability}`);
        if (roll >= probability) {
            // 没抽中，继续沉默
            this.logger.debug(`[ReplyManager] [${this.groupId}] silence missed`);
            this.startSilenceTimer();
            return;
        }
        this.logger.info(`[ReplyManager] [${this.groupId}] silence hit`);

        // 获取最新消息作为触发点
        const latest = await this.db
            .select()
            .from(schema.messages)
            .where(eq(schema.messages.groupId, this.groupId))
            .orderBy(desc(schema.messages.id))
            .limit(1);

        if (latest.length === 0) {
            this.startSilenceTimer();
            return;
        }

        const row = latest[0];
        const stored: StoredMessage = {
            time: row.time,
            messageId: row.messageId,
            senderId: row.userId,
            senderName: row.senderName,
            senderCard: row.senderCard ?? undefined,
            isBot: row.isBot,
            isAtBot: row.isAtBot,
            segments: row.segments as StoredMessage['segments']
        };

        this.enqueueTask({
            type: 'silence',
            triggerDbId: row.id,
            triggerMessageId: row.messageId,
            triggerMessage: stored,
            lastTriggerId: this.lastTriggerId
        });
    }

    private enqueueTask (task: ReplyTask): void {
        this.logger.debug(
            `[ReplyManager] [${this.groupId}] enqueueTask type=${task.type} ` +
            `msg=${task.triggerMessageId} queueLen=${this.replyQueue.length + 1}`);
        this.replyQueue.push(task);
        if (!this.processingQueue) {
            this.processQueue();
        }
    }

    private async processQueue (): Promise<void> {
        if (this.processingQueue) return;
        this.processingQueue = true;
        this.isReplying = true;
        this.logger.debug(
            `[ReplyManager] [${this.groupId}] processQueue start tasks=${this.replyQueue.length}`);

        while (this.replyQueue.length > 0) {
            const task = this.replyQueue.shift()!;
            this.logger.debug(
                `[ReplyManager] [${this.groupId}] executeTask type=${task.type} msg=${task.triggerMessageId}`);
            try {
                await this.executeTask(task);
            } catch (err) {
                this.logger.error(`[ReplyManager] Task failed for group ${this.groupId}:`, err);
            }
        }

        this.processingQueue = false;
        this.isReplying = false;
        this.logger.debug(`[ReplyManager] [${this.groupId}] processQueue done`);
    }

    private async executeTask (task: ReplyTask): Promise<void> {
        const agent = this.agent;

        if (task.type === 'scheduled' && task.preResearchTopic) {
            this.logger.info(
                `[ReplyManager] [${this.groupId}] scheduled task "${task.scheduledTaskName ?? ''}" ` +
                `pre-research: ${task.preResearchTopic}`);
        }

        const firstTurn = await agent.generateFirstTurn(task);
        if (firstTurn.failed || firstTurn.text.length === 0) {
            if (firstTurn.processedUpToId) {
                this.logger.info(
                    `[ReplyManager] [${this.groupId}] first turn failed, advancing lastTriggerId ` +
                    `to ${firstTurn.processedUpToId}`);
                this.lastTriggerId = firstTurn.processedUpToId;
            }
            if (task.type === 'at') {
                this.logger.info(`[ReplyManager] [${this.groupId}] first turn failed, sending fallback`);
                const segments: Message[] = [{type: 'text', data: {text: '@响应失败'}}];
                await this.bot.sendGroupMsg(this.groupId, segments);
            } else {
                this.logger.info(`[ReplyManager] [${this.groupId}] first turn failed, silent fallback`);
            }
            return;
        }

        this.logger.info(
            `[ReplyManager] [${this.groupId}] first turn ready, ` +
            `requiresDeepResearch=${firstTurn.requiresDeepResearch}`);

        let botCard: string | null = null;
        try {
            const memberInfo = await this.bot.getGroupMemberInfo(this.groupId, this.botSelfId);
            botCard = memberInfo.card || null;
        } catch {
            this.logger.debug(`[ReplyManager] [${this.groupId}] failed to get self group member info`);
        }

        const firstTurnSendResults = await this.sendTurn(task, {
            messages: firstTurn.text,
            isFirstTurn: true,
            isDeepResearchFinal: false,
            botCard
        });

        const firstTurnLast = firstTurnSendResults[firstTurnSendResults.length - 1];
        if (typeof firstTurnLast?.rowId === 'number') {
            this.lastTriggerId = firstTurnLast.rowId;
        }

        if (!firstTurn.requiresDeepResearch) {
            return;
        }

        const topic = firstTurn.deepResearchTopic || firstTurn.text.map(m => m.text).join('');
        const finalTurn = await agent.generateFinalTurn(task, topic, this.lastTriggerId);
        const finalTurnSendResults = await this.sendTurn(task, {
            messages: finalTurn.text,
            isFirstTurn: false,
            isDeepResearchFinal: true,
            firstTurnMessageId: firstTurnLast?.messageId,
            firstTurnReplyMessages: firstTurn.text,
            firstTurnReplyTime: firstTurnLast?.time,
            botCard
        });
        const finalTurnLast = finalTurnSendResults[finalTurnSendResults.length - 1];
        if (typeof finalTurnLast?.rowId === 'number') {
            this.lastTriggerId = finalTurnLast.rowId;
        }
    }

    private async resolveRefMessageId (dbId: number): Promise<number | undefined> {
        const rows = await this.db
            .select({messageId: schema.messages.messageId})
            .from(schema.messages)
            .where(eq(schema.messages.id, dbId))
            .limit(1);
        return rows[0]?.messageId ?? undefined;
    }

    private async sendTurn (
        task: ReplyTask,
        options: {
            messages: ReplyMessageItem[];
            isFirstTurn: boolean;
            isDeepResearchFinal: boolean;
            firstTurnMessageId?: number;
            firstTurnReplyMessages?: ReplyMessageItem[];
            firstTurnReplyTime?: number;
            botCard: string | null;
        }
    ): Promise<Array<{rowId: number | null; messageId?: number; time?: number}>> {
        const {
            messages,
            isFirstTurn,
            isDeepResearchFinal,
            firstTurnMessageId,
            firstTurnReplyMessages,
            firstTurnReplyTime,
            botCard
        } = options;

        this.logger.info(
            `[ReplyManager] [${this.groupId}] sending reply ` +
            `${isDeepResearchFinal ? '(deep research final)' : '(first turn)'}: ` +
            `${messages.length} message(s)`);

        const results: Array<{rowId: number | null; messageId?: number; time?: number}> = [];

        for (let i = 0; i < messages.length; i++) {
            const item = messages[i];

            // Determine reply reference
            let refOnebotId: number | undefined;
            let refDbSegment: StoredSegment | undefined;

            if (typeof item.ref === 'number') {
                refOnebotId = await this.resolveRefMessageId(item.ref);
                if (refOnebotId) {
                    refDbSegment = {type: 'reply', id: item.ref};
                }
            } else if (i === 0) {
                if (isFirstTurn && task.type === 'at') {
                    refOnebotId = task.triggerMessageId;
                    refDbSegment = {type: 'reply', id: task.triggerMessageId, message: task.triggerMessage};
                } else if (!isFirstTurn && firstTurnMessageId &&
                    firstTurnReplyMessages && typeof firstTurnReplyTime === 'number') {
                    refOnebotId = firstTurnMessageId;
                    refDbSegment = {
                        type: 'reply',
                        id: firstTurnMessageId,
                        message: {
                            time: firstTurnReplyTime,
                            messageId: firstTurnMessageId,
                            senderId: this.botSelfId,
                            senderName: this.botName,
                            senderCard: botCard ?? undefined,
                            isBot: true,
                            isAtBot: false,
                            segments: [{type: 'text', text: firstTurnReplyMessages.map(m => m.text).join('')}]
                        }
                    };
                }
            }

            // Build segments for this item
            const onebotSegments: Message[] = [];
            const dbSegments: StoredSegment[] = [];

            if (refOnebotId) {
                onebotSegments.push({type: 'reply', data: {id: refOnebotId}});
            }
            onebotSegments.push({type: 'text', data: {text: item.text}});

            if (refDbSegment) {
                dbSegments.push(refDbSegment);
            }
            dbSegments.push({type: 'text', text: item.text});

            // Send this item as a separate message
            this.logger.info(
                `[ReplyManager] [${this.groupId}] sending item ${i + 1}/${messages.length}: ` +
                `${item.text.slice(0, 80)}${item.text.length > 80 ? '...' : ''}` +
                `${refOnebotId ? ` (ref=${item.ref})` : ''}`);

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
                results.push({rowId: null});
                continue;
            }

            const rowId = insertRows[0].id;
            this.onBotMessage(rowId);

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

            results.push({rowId, messageId: sendResult.message_id, time: now});
        }

        return results;
    }
}

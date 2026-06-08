import type {Bot} from '@lib/types';
import type {Message} from '@lib/types/messages';
import {schema, type Db, kvGet, kvSet} from '~/db';
import {eq, desc} from 'drizzle-orm';
import type {DescQueue} from './desc-queue';
import type {StoredMessage, StoredSegment} from '~/message-format';
import type {AppConfig} from '~/config';
import {ReplyAgent} from './reply-agent';
import {Logger} from '@lib/util/logger';

export interface ReplyTask {
    type: 'at' | 'silence';
    triggerDbId: number;
    triggerMessageId: number;
    triggerMessage: StoredMessage;
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
        kvSet(this.db, `group:${this.groupId}:lastTriggerId`, String(value))
            .catch(err => this.logger.error(`[ReplyManager] failed to save lastTriggerId:`, err));
    }

    constructor (
        groupId: number, bot: Bot, db: Db, descQueue: DescQueue,
        config: AppConfig, botSelfId: number, botName: string,
    ) {
        this.groupId = groupId;
        this.bot = bot;
        this.db = db;
        this.descQueue = descQueue;
        this.config = config;
        this.botSelfId = botSelfId;
        this.botName = botName;
        this.logger = new Logger();
        this.agent = new ReplyAgent(db, descQueue, config);

        // Load lastTriggerId from kvStore
        kvGet(db, `group:${groupId}:lastTriggerId`).then(value => {
            if (value) {
                this._lastTriggerId = parseInt(value, 10);
                this.logger.debug(`[ReplyManager] [${groupId}] loaded lastTriggerId=${this._lastTriggerId}`);
            }
        })
            .catch(err => this.logger.error(`[ReplyManager] failed to load lastTriggerId:`, err));
    }

    getAgent (): ReplyAgent {
        return this.agent;
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

    private startAtMergeWindow (): void {
        const ms = (this.config.input.merge_window ?? 30) * 1000;
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
            triggerMessage: stored
        });
    }

    private startSilenceTimer (): void {
        const minutes = this.config.input.silence_wait_time ?? 30;
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

        const probability = this.config.input.reply_probability ?? 0.1;
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
            senderCard: row.senderCard ?? void 0,
            isBot: row.isBot,
            isAtBot: row.isAtBot,
            segments: row.segments as StoredMessage['segments']
        };

        this.enqueueTask({
            type: 'silence',
            triggerDbId: row.id,
            triggerMessageId: row.messageId,
            triggerMessage: stored
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
        // 获取当前最新消息的 id（用于更新 lastTriggerId）
        const latestRows = await this.db
            .select({id: schema.messages.id})
            .from(schema.messages)
            .where(eq(schema.messages.groupId, this.groupId))
            .orderBy(desc(schema.messages.id))
            .limit(1);
        const currentLatestId = latestRows[0]?.id ?? 0;

        const agent = this.agent;

        // 获取当前群里的群名片
        let botCard: string | null = null;
        try {
            const memberInfo = await this.bot.getGroupMemberInfo(this.groupId, this.botSelfId);
            botCard = memberInfo.card || null;
        } catch {
            this.logger.debug(`[ReplyManager] [${this.groupId}] failed to get self group member info`);
        }

        const result = await agent.generateReply(this.groupId, this.lastTriggerId, task);
        this.logger.info(
            `[ReplyManager] [${this.groupId}] first turn reply: ${result.texts.length} message(s)`);

        let firstTurnMessageId: number | undefined;

        for (let i = 0; i < result.texts.length; i++) {
            const replyText = result.texts[i];
            this.logger.info(
                `[ReplyManager] [${this.groupId}] sending first turn reply ${i + 1}/${result.texts.length}: ` +
                `${replyText.slice(0, 80)}${replyText.length > 80 ? '...' : ''}`);

            const segments: Message[] = [];
            if (task.type === 'at' && i === 0) {
                segments.push({type: 'reply', data: {id: task.triggerMessageId}});
            }
            segments.push({type: 'text', data: {text: replyText}});

            const sendResult = await this.bot.sendGroupMsg(this.groupId, segments);
            firstTurnMessageId = sendResult.message_id;

            const now = Math.floor(Date.now() / 1000);
            const dbSegments: StoredSegment[] = [{type: 'text', text: replyText}];
            if (task.type === 'at' && i === 0) {
                dbSegments.unshift({type: 'reply', id: task.triggerMessageId});
            }
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
                rawMessage: replyText
            })
                .returning({id: schema.messages.id});

            if (insertRows[0]) {
                this.onBotMessage(insertRows[0].id);
            }
        }

        if (result.secondTurnPromise) {
            this.logger.info(`[ReplyManager] [${this.groupId}] starting second turn in background`);
            result.secondTurnPromise.then(async secondTurnTexts => {
                if (secondTurnTexts.length === 0) return;

                this.logger.info(
                    `[ReplyManager] [${this.groupId}] second turn reply: ${secondTurnTexts.length} message(s)`);

                for (let i = 0; i < secondTurnTexts.length; i++) {
                    const replyText = secondTurnTexts[i];
                    this.logger.info(
                        `[ReplyManager] [${this.groupId}] sending second turn reply ` +
                        `${i + 1}/${secondTurnTexts.length}: ` +
                        `${replyText.slice(0, 80)}${replyText.length > 80 ? '...' : ''}`);

                    const segments: Message[] = [];
                    if (firstTurnMessageId) {
                        segments.push({type: 'reply', data: {id: firstTurnMessageId}});
                    }
                    segments.push({type: 'text', data: {text: replyText}});

                    const sendResult = await this.bot.sendGroupMsg(this.groupId, segments);

                    const now = Math.floor(Date.now() / 1000);
                    const dbSegments2: StoredSegment[] = [{type: 'text', text: replyText}];
                    if (firstTurnMessageId) {
                        dbSegments2.unshift({type: 'reply', id: firstTurnMessageId});
                    }
                    const insertRows = await this.db.insert(schema.messages).values({
                        messageId: sendResult.message_id,
                        groupId: this.groupId,
                        userId: this.botSelfId,
                        time: now,
                        senderName: this.botName,
                        senderCard: botCard,
                        isBot: true,
                        isAtBot: false,
                        segments: dbSegments2 as StoredSegment[],
                        rawMessage: replyText
                    })
                        .returning({id: schema.messages.id});

                    if (insertRows[0]) {
                        this.onBotMessage(insertRows[0].id);
                    }
                }
            }).catch(err => {
                this.logger.error(`[ReplyManager] [${this.groupId}] second turn background error:`, err);
            });
        }

        this.lastTriggerId = currentLatestId;
    }
}

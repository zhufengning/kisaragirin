import type {Bot} from '@lib/types';
import type {Models} from '@earendil-works/pi-ai';
import {
    schema,
    type Db,
    getGroupLastTriggerId,
    setGroupLastTriggerId,
    insertSystemMessage,
    rowToStoredMessage
} from '~/db';
import {eq, desc} from 'drizzle-orm';
import type {DescQueue} from './desc-queue';
import type {StoredMessage, StoredSegment} from '~/message-format';
import type {AppConfig} from '~/config';
import {ReplyAgent, type TurnOutcome} from './reply-agent';
import type {ReplyTask, ScheduledReplyTask} from './reply-task';
import {ReplySender, type TurnLocation} from './reply-sender';
import type {GraphitiClient} from './graphiti-client';
import {Logger} from '@lib/util/logger';

interface GroupReplyManagerOptions {
    groupId: number;
    bot: Bot;
    db: Db;
    descQueue: DescQueue;
    config: AppConfig;
    botSelfId: number;
    botName: string;
    models: Models;
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
    private graphiti: GraphitiClient | null;
    private sender: ReplySender;

    private _lastTriggerId: number = 0;
    private pendingAtTimeout: NodeJS.Timeout | null = null;
    private pendingAtMessage: StoredMessage | null = null;
    private pendingAtRowId: number | null = null;
    private silenceTimeout: NodeJS.Timeout | null = null;
    private isReplying: boolean = false;
    private replyQueue: ReplyTask[] = [];
    private processingQueue: boolean = false;
    private stopped: boolean = false;
    private queueIdleWaiters: Array<() => void> = [];

    get lastTriggerId (): number {
        return this._lastTriggerId;
    }

    set lastTriggerId (value: number) {
        this._lastTriggerId = value;
        setGroupLastTriggerId(this.db, this.groupId, value)
            .catch(err => this.logger.error(`[ReplyManager] failed to save lastTriggerId:`, err));
    }

    private constructor (
        options: GroupReplyManagerOptions,
        agent: ReplyAgent,
        lastTriggerId: number,
    ) {
        this.groupId = options.groupId;
        this.bot = options.bot;
        this.db = options.db;
        this.descQueue = options.descQueue;
        this.config = options.config;
        this.botSelfId = options.botSelfId;
        this.botName = options.botName;
        this.models = options.models;
        this.agent = agent;
        this.graphiti = options.config.ai.graphiti ? globalThis.__graphiti__ ?? null : null;
        this._lastTriggerId = lastTriggerId;
        this.logger = new Logger();
        this.sender = new ReplySender({
            bot: this.bot,
            db: this.db,
            agent: this.agent,
            descQueue: this.descQueue,
            graphiti: this.graphiti,
            logger: this.logger,
            groupId: this.groupId,
            botSelfId: this.botSelfId,
            botName: this.botName,
            onBotMessage: () => this.onBotMessage()
        });
    }

    static async create (options: GroupReplyManagerOptions): Promise<GroupReplyManager> {
        const {groupId, db, config} = options;

        const agent = await ReplyAgent.create({
            groupId,
            db,
            descQueue: options.descQueue,
            config,
            models: options.models,
            graphiti: config.ai.graphiti ? globalThis.__graphiti__ ?? undefined : undefined
        });

        let lastTriggerId = 0;
        try {
            lastTriggerId = await getGroupLastTriggerId(db, groupId);
        } catch (err) {
            new Logger().error(`[ReplyManager] failed to load lastTriggerId for group ${groupId}:`, err);
        }

        return new GroupReplyManager(options, agent, lastTriggerId);
    }

    getAgent (): ReplyAgent {
        return this.agent;
    }

    /** 停止接收新任务、清理定时器，并等待进行中的回复任务与 Agent 结束 */
    async shutdown (): Promise<void> {
        this.stopped = true;
        this.clearPendingAt();
        this.pendingAtMessage = null;
        this.pendingAtRowId = null;
        this.clearSilenceTimeout();
        await this.waitForQueueIdle();
        await this.agent.waitForIdle();
    }

    private waitForQueueIdle (): Promise<void> {
        if (!this.processingQueue) return Promise.resolve();
        return new Promise(resolve => {
            this.queueIdleWaiters.push(resolve);
        });
    }

    getLastTriggerId (): number {
        return this._lastTriggerId;
    }

    onMessage (stored: StoredMessage, _rowId: number): void {
        if (this.stopped) return;
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

    onBotMessage (_rowId?: number): void {
        this.clearSilenceTimeout();
        // bot 消息不启动沉默定时器
    }

    async triggerScheduledReply (task: ScheduledReplyTask): Promise<void> {
        if (this.stopped) return;
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

    /**
     * 最近 silence_recent_window 条消息中 bot 消息数是否达到 silence_recent_bot_threshold。
     * 任一项未配置（<= 0）时返回 false。better-sqlite3 为同步驱动，可直接同步查询。
     */
    private recentBotMessagesDominate (): boolean {
        const window = this.config.input.silence_recent_window;
        const threshold = this.config.input.silence_recent_bot_threshold;
        if (window <= 0 || threshold <= 0) return false;

        const rows = this.db
            .select({isBot: schema.messages.isBot})
            .from(schema.messages)
            .where(eq(schema.messages.groupId, this.groupId))
            .orderBy(desc(schema.messages.id))
            .limit(window)
            .all();

        const botCount = rows.filter(r => r.isBot).length;
        const dominated = botCount >= threshold;
        if (dominated) {
            this.logger.debug(
                `[ReplyManager] [${this.groupId}] recent ${rows.length} messages contain ` +
                `${botCount} bot message(s) (>= ${threshold}), silence wait time multiplied`);
        }
        return dominated;
    }

    private startSilenceTimer (): void {
        // 每次有新消息进来都会重新启动定时器，等待时间按当前消息构成重新计算
        const multiplier = this.recentBotMessagesDominate() ?
            this.config.input.silence_recent_bot_multiplier : 1;
        const minutes = this.config.input.silence_wait_time * multiplier;
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
        const stored = rowToStoredMessage(row);

        this.enqueueTask({
            type: 'silence',
            triggerDbId: row.id,
            triggerMessageId: row.messageId,
            triggerMessage: stored,
            lastTriggerId: this.lastTriggerId
        });
    }

    private enqueueTask (task: ReplyTask): void {
        if (this.stopped) {
            this.logger.debug(
                `[ReplyManager] [${this.groupId}] manager stopped, task discarded`);
            return;
        }
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
        const waiters = this.queueIdleWaiters;
        this.queueIdleWaiters = [];
        waiters.forEach(resolve => resolve());
        this.logger.debug(`[ReplyManager] [${this.groupId}] processQueue done`);
    }

    /** 回合链：消息轮 →（模型要求时）深度研究轮 →（可继续链式）深度研究轮 … */
    private async executeTask (task: ReplyTask): Promise<void> {
        // 队列中先执行的任务可能已推进水位线，避免本任务重复注入已处理的消息
        task.lastTriggerId = Math.max(task.lastTriggerId, this.lastTriggerId);

        if (task.type === 'scheduled' && task.preResearchTopic) {
            this.logger.info(
                `[ReplyManager] [${this.groupId}] scheduled task "${task.scheduledTaskName ?? ''}" ` +
                `pre-research: ${task.preResearchTopic}`);
        }

        const botCard = await this.fetchBotCard();

        let outcome = await this.agent.runMessageTurn(task);
        // 无新消息：触发消息已被队列中前序任务吸收进其 prompt，静默跳过
        if (outcome.noop) {
            this.logger.info(
                `[ReplyManager] [${this.groupId}] task msg=${task.triggerMessageId} has no new messages, skipped`);
            return;
        }

        let prevTurn: TurnLocation | undefined;
        let researchRounds = 0;
        const maxResearchRounds = this.config.input.max_deep_research_rounds;

        for (;;) {
            this.advanceWatermark(outcome);

            if (outcome.failed) {
                await this.sender.sendFailureFallback(task, outcome, botCard, prevTurn);
                return;
            }

            prevTurn = await this.deliverTurn(task, outcome, botCard, prevTurn) ?? prevTurn;

            if (!outcome.requiresDeepResearch) return;

            if (researchRounds >= maxResearchRounds) {
                this.logger.warn(
                    `[ReplyManager] [${this.groupId}] max deep research rounds ` +
                    `(${maxResearchRounds}) reached, ignoring requires_deep_research`);
                return;
            }
            researchRounds++;

            const topic = this.resolveResearchTopic(outcome);
            if (!topic) {
                this.logger.warn(
                    `[ReplyManager] [${this.groupId}] requires_deep_research without topic ` +
                    `and reply text, skip research`);
                return;
            }
            this.logger.info(
                `[ReplyManager] [${this.groupId}] deep research round ` +
                `${researchRounds}/${maxResearchRounds}: ${topic}`);
            outcome = await this.agent.runResearchTurn(task, topic, this.lastTriggerId);
        }
    }

    /**
     * 水位线只推进到本轮实际读入 prompt 的消息 id：回复执行期间到达的新消息
     * id 小于 bot 回复行 id，若以 bot 回复行为界会永久跳过这些消息
     */
    private advanceWatermark (outcome: TurnOutcome): void {
        if (outcome.processedUpToId) {
            this.lastTriggerId = Math.max(this.lastTriggerId, outcome.processedUpToId);
        }
    }

    /** 发送本回合的消息并返回新的上一轮位置；模型未回复时返回 undefined */
    private async deliverTurn (
        task: ReplyTask,
        outcome: TurnOutcome,
        botCard: string | null,
        prevTurn: TurnLocation | undefined
    ): Promise<TurnLocation | undefined> {
        if (outcome.messages.length === 0) {
            // 模型以空消息数组主动选择不回复
            this.logger.info(
                `[ReplyManager] [${this.groupId}] model chose not to reply (empty messages)`);
            return undefined;
        }

        const sendResults = await this.sender.sendTurn(task, {
            messages: outcome.messages,
            prevTurn,
            botCard
        });
        const last = sendResults[sendResults.length - 1];
        return {messageId: last?.messageId, time: last?.time, messages: outcome.messages};
    }

    private resolveResearchTopic (outcome: TurnOutcome): string | null {
        const topic = (outcome.deepResearchTopic || outcome.messages.map(m => m.text).join('')).trim();
        return topic || null;
    }

    private async fetchBotCard (): Promise<string | null> {
        try {
            const memberInfo = await this.bot.getGroupMemberInfo(this.groupId, this.botSelfId);
            return memberInfo.card || null;
        } catch {
            this.logger.debug(`[ReplyManager] [${this.groupId}] failed to get self group member info`);
            return null;
        }
    }
}

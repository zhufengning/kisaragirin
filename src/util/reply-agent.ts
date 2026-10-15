import {AgentHarness, type AgentMessage, type AgentTool, type Session} from '@earendil-works/pi-agent-core';
import {NodeExecutionEnv} from '@earendil-works/pi-agent-core/node';
import {type AssistantMessage, type Models} from '@earendil-works/pi-ai';
import {schema, type Db, type JsonlSessionMetadata, rowToStoredMessage, setGroupLastTriggerId} from '~/db';
import type {AppConfig, ModelEntry} from '~/config';
import {eq, asc, and, or, gt, gte, lte, ne, desc} from 'drizzle-orm';
import type {DescQueue} from './desc-queue';
import type {ReplyTask} from './reply-task';
import {messagesToString, type StoredMessage} from '~/message-format';
import {prompts} from '~/prompts';
import {Logger} from '@lib/util/logger';
import {getOrCreateGroupSession} from './harness-factory';
import {resolveAssignmentModels} from './models-factory';
import {createReplyTool, type ReplyToolParams, type ReplyMessageItem} from './reply-tool';
import {createGraphitiTools} from './graphiti-tool';
import {addMergedMessagesEpisode} from './graphiti-episode';
import {GraphitiClient} from './graphiti-client';
import {buildSystemPrompt, buildUserPromptArray, formatToolsDescription, formatUsage} from './reply-prompt';
import {ReplyDebugDumper} from './reply-debug';
import {MemoryContextBuilder} from './memory-context';
import {DeepResearchRunner} from './deep-research';

/**
 * 一个回合（消息轮或深度研究轮）的执行结果。
 * 任务由 reply-manager 编排为回合链：消息轮 →（可选）深度研究轮 →（可继续链式）深度研究轮 …
 */
export interface TurnOutcome {
    /** reply 工具提交的消息（已过滤全空白文本）；空数组 = 模型选择不回复 */
    messages: ReplyMessageItem[];
    requiresDeepResearch: boolean;
    deepResearchTopic?: string;
    /** 本轮失败（API 错误或 reminder 用尽仍未调用 reply 工具），由调用方决定兜底行为 */
    failed?: boolean;
    /** 无新消息可处理（仅消息轮可能出现），调用方应静默跳过，不视为失败 */
    noop?: boolean;
    /** 仅深度研究轮：研究本身是否成功（失败时兜底文案不同）；消息轮无此字段 */
    researchSuccess?: boolean;
    /** 本轮实际读入 prompt 的最大数据库消息 id，用于推进 lastTriggerId */
    processedUpToId?: number;
}

export class ReplyAgent {
    private db: Db;
    private descQueue: DescQueue;
    private config: AppConfig;
    private groupId: number;
    private session: Session<JsonlSessionMetadata>;
    private harness: AgentHarness;
    private logger: Logger;
    private systemPromptText: string;
    private debug: ReplyDebugDumper;
    private memoryContext: MemoryContextBuilder;
    private researchRunner: DeepResearchRunner;
    private lastReplyToolParams: ReplyToolParams | null = null;
    private toolCallRoundCount = 0;
    private graphiti: GraphitiClient | null = null;
    /** 已注入 harness 的最近一条 bot 回复的数据库 id，用于检测乱序消息（回复生成期间送达的消息 id 更小却排在回复之后） */
    private lastBotReplyId = 0;

    private constructor (options: {
        db: Db;
        descQueue: DescQueue;
        config: AppConfig;
        groupId: number;
        session: Session<JsonlSessionMetadata>;
        harness: AgentHarness;
        systemPromptText: string;
        graphiti: GraphitiClient | null;
        lastBotReplyId: number;
        models: Models;
    }) {
        this.db = options.db;
        this.descQueue = options.descQueue;
        this.config = options.config;
        this.groupId = options.groupId;
        this.session = options.session;
        this.harness = options.harness;
        this.systemPromptText = options.systemPromptText;
        this.graphiti = options.graphiti;
        this.lastBotReplyId = options.lastBotReplyId;
        this.logger = new Logger();

        this.debug = new ReplyDebugDumper({config: this.config, logger: this.logger, groupId: this.groupId});
        this.memoryContext = new MemoryContextBuilder({
            config: this.config,
            groupId: this.groupId,
            logger: this.logger,
            graphiti: this.graphiti,
            session: this.session,
            debug: this.debug
        });
        this.researchRunner = new DeepResearchRunner({
            db: this.db,
            groupId: this.groupId,
            config: this.config,
            logger: this.logger,
            descQueue: this.descQueue,
            graphiti: this.graphiti,
            debug: this.debug,
            models: options.models
        });
    }

    static async create (options: {
        groupId: number;
        db: Db;
        descQueue: DescQueue;
        config: AppConfig;
        models: Models;
        graphiti?: GraphitiClient | null;
    }): Promise<ReplyAgent> {
        const {groupId, db, descQueue, config, models, graphiti} = options;

        const logger = new Logger();
        const {session, isNew} = await getOrCreateGroupSession(groupId, config, db);

        const harnessEntry = resolveAssignmentModels(config, config.ai.assignments.agent_harness)[0];
        const env = new NodeExecutionEnv({cwd: process.cwd()});

        const agentRef: {current: ReplyAgent | null} = {current: null};

        const replyTool = createReplyTool({
            onCalled: params => {
                agentRef.current!.lastReplyToolParams = params;
            }
        });

        const graphitiTools: AgentTool[] = graphiti ? createGraphitiTools(graphiti, config.log.level, groupId) : [];
        const tools: AgentTool[] = [replyTool, ...graphitiTools];

        const systemPrompt = () => buildSystemPrompt({
            botName: config.input.bot_name || '机器人',
            botPersona: config.input.bot_persona || '',
            toolsDescription: formatToolsDescription(tools),
            groupCustomPrompt: config.input.group_custom_prompts?.[groupId]
        });

        const harness = new AgentHarness({
            env,
            session,
            models,
            model: harnessEntry.model,
            systemPrompt,
            tools,
            activeToolNames: tools.map(t => t.name),
            thinkingLevel: 'high'
        });

        const lastBotReplyId = await ReplyAgent.restoreLastBotReplyId(db, groupId);

        const agent = new ReplyAgent({
            db,
            descQueue,
            config,
            groupId,
            session,
            harness,
            systemPromptText: systemPrompt(),
            graphiti: graphiti ?? null,
            lastBotReplyId,
            models
        });

        agentRef.current = agent;
        ReplyAgent.installToolCallLimit(harness, agent, config, logger, groupId);

        if (isNew) {
            await ReplyAgent.bootstrapNewSession(db, groupId, logger);
        }

        logger.info(`[ReplyAgent] [${groupId}] harness created, isNew=${isNew}`);
        return agent;
    }

    /** 从数据库恢复该群最近一条 bot 回复行 id；重启后内存状态丢失，否则重启前送达的乱序消息无法被检测 */
    private static async restoreLastBotReplyId (db: Db, groupId: number): Promise<number> {
        const lastBotReply = await db
            .select({id: schema.messages.id})
            .from(schema.messages)
            .where(and(
                eq(schema.messages.groupId, groupId),
                eq(schema.messages.isBot, true),
                eq(schema.messages.specialType, 'normal')
            ))
            .orderBy(desc(schema.messages.id))
            .limit(1);
        return lastBotReply[0]?.id ?? 0;
    }

    private static installToolCallLimit (
        harness: AgentHarness,
        agent: ReplyAgent,
        config: AppConfig,
        logger: Logger,
        groupId: number
    ): void {
        harness.on('tool_call', event => {
            if (event.toolName === 'reply') {
                return undefined;
            }
            agent.toolCallRoundCount++;
            if (agent.toolCallRoundCount > config.input.max_tool_call_rounds) {
                logger.warn(
                    `[ReplyAgent] [${groupId}] tool call rounds exceeded ` +
                    `${config.input.max_tool_call_rounds}, blocking`);
                return {block: true, reason: 'tool call round limit exceeded'};
            }
            return undefined;
        });
    }

    private static async bootstrapNewSession (db: Db, groupId: number, logger: Logger): Promise<void> {
        logger.info(`[ReplyAgent] [${groupId}] new session created, no history imported`);
        const latest = await db
            .select({id: schema.messages.id})
            .from(schema.messages)
            .where(eq(schema.messages.groupId, groupId))
            .orderBy(desc(schema.messages.id))
            .limit(1);
        if (latest.length > 0) {
            await setGroupLastTriggerId(db, groupId, latest[0].id);
            logger.info(`[ReplyAgent] [${groupId}] lastTriggerId set to ${latest[0].id}`);
        }
    }

    /**
     * 手动导入指定时间范围内的历史消息到 harness 会话。
     * 忽略所有压缩（compact）消息。返回实际导入的消息条数。
     */
    async importMessagesByDateRange (startTime: number, endTime: number): Promise<number> {
        if (startTime > endTime) {
            throw new Error(`invalid date range: start=${startTime} > end=${endTime}`);
        }

        await this.waitForIdle();

        const rows = await this.db
            .select()
            .from(schema.messages)
            .where(
                and(
                    eq(schema.messages.groupId, this.groupId),
                    gte(schema.messages.time, startTime),
                    lte(schema.messages.time, endTime),
                    ne(schema.messages.specialType, 'compact')
                )
            )
            .orderBy(asc(schema.messages.id));

        let imported = 0;
        for (const row of rows) {
            const msg = rowToStoredMessage(row);
            const text = await messagesToString([msg], sha => this.descQueue.resolve(sha));
            if (!text.trim()) continue;

            const role = msg.isBot ? 'assistant' : 'user';
            await this.harness.appendMessage({
                role,
                content: [{type: 'text', text}],
                timestamp: msg.time * 1000
            } as AgentMessage);
            imported++;
        }

        await this.waitForIdle();
        this.logger.info(
            `[ReplyAgent] [${this.groupId}] imported ${imported} messages ` +
            `from ${startTime} to ${endTime}`);
        return imported;
    }

    private async fetchMessagesSince (lastTriggerId: number): Promise<StoredMessage[]> {
        // bot 普通聊天消息已通过 appendBotMessage 注入 harness，这里排除以避免重复；
        // system / compact 等特殊消息仍保留。这样 lastTriggerId 只需推进到实际读入
        // prompt 的消息 id，回复执行期间到达的新消息不会被 bot 自己的回复行跳过。
        const notBotChat = or(
            eq(schema.messages.isBot, false),
            ne(schema.messages.specialType, 'normal')
        );
        const rows = await this.db
            .select()
            .from(schema.messages)
            .where(
                lastTriggerId > 0 ?
                    and(
                        eq(schema.messages.groupId, this.groupId),
                        gt(schema.messages.id, lastTriggerId),
                        notBotChat
                    ) :
                    and(
                        eq(schema.messages.groupId, this.groupId),
                        notBotChat
                    )
            )
            .orderBy(asc(schema.messages.id));

        return rows.map(row => rowToStoredMessage(row));
    }

    private getReplyToolParams (): ReplyToolParams | null {
        return this.lastReplyToolParams;
    }

    /**
     * 检测乱序消息：本轮读入的消息 id 小于等于已注入 harness 的最近 bot 回复 id，
     * 说明它们是在上一轮回复生成期间送达的（bot 视角排在回复之后，实际发送更早）。
     * 返回拼在 user 消息末尾的时序提示文本，无乱序时返回 null。
     */
    private buildOutOfOrderHint (latestMessages: StoredMessage[]): string | null {
        if (this.lastBotReplyId <= 0) return null;
        const lateIds = latestMessages
            .map(m => m.id)
            .filter((id): id is number => id !== undefined && id <= this.lastBotReplyId);
        if (lateIds.length === 0) return null;
        return prompts.outOfOrderHint(lateIds.map(id => `#${id}`).join('、'));
    }

    private async syncHarnessModel (entry: ModelEntry): Promise<void> {
        const current = this.harness.getModel();
        if (current.id !== entry.model.id) {
            await this.harness.setModel(entry.model);
            this.logger.info(
                `[ReplyAgent] [${this.groupId}] harness model switched ` +
                `from ${current.id} to ${entry.model.id}`);
        }
    }

    /**
     * 消息轮（每个任务的第一个回合）：读取 task.lastTriggerId 之后的新消息构建 prompt。
     * scheduled 任务配置 preResearchTopic 时先执行预研究（结果写入系统消息，随新消息一起读入）。
     */
    async runMessageTurn (task: ReplyTask): Promise<TurnOutcome> {
        this.debug.resetTurn();

        if (task.preResearchTopic) {
            await this.researchRunner.runWithSystemMessages(task.preResearchTopic);
        }

        const latestMessages = await this.fetchMessagesSince(task.lastTriggerId ?? 0);
        const userTexts = await buildUserPromptArray(latestMessages, this.descQueue);

        if (userTexts.length === 0) {
            this.logger.info(
                `[ReplyAgent] [${this.groupId}] no new messages to process, skipping (noop)`);
            return {messages: [], requiresDeepResearch: false, noop: true};
        }

        const processedUpToId = latestMessages[latestMessages.length - 1]?.id;

        // 保存原始 userTexts（不包括记忆搜索结果与时序提示），用于 graphiti 记忆
        const originalUserTexts = [...userTexts];

        this.debug.beginTurn(task.type);

        const memories = await this.memoryContext.build(userTexts.join('\n'));
        if (memories) {
            userTexts[userTexts.length - 1] += `${prompts.memorySearchSeparator}\n${memories}`;
        }

        // 乱序消息的时序提示拼在 user 消息最后；
        // 在 originalUserTexts 快照之后追加，不进 graphiti 记忆
        const outOfOrderHint = this.buildOutOfOrderHint(latestMessages);
        if (outOfOrderHint) {
            this.logger.info(
                `[ReplyAgent] [${this.groupId}] out-of-order messages detected, ` +
                `lastBotReplyId=${this.lastBotReplyId}`);
            userTexts[userTexts.length - 1] += outOfOrderHint;
        }

        const outcome = await this.promptAndCollect({
            appendTexts: userTexts.slice(0, -1),
            promptText: userTexts[userTexts.length - 1],
            processedUpToId,
            label: 'message turn'
        });

        // 异步添加合并后的消息记忆（不阻塞回复流程）
        if (!outcome.failed && this.graphiti) {
            const mergedContent = originalUserTexts.join('\n');
            const messageIds = latestMessages.map(m => m.id).filter((id): id is number => id !== undefined);
            addMergedMessagesEpisode(this.graphiti, this.groupId, mergedContent, messageIds);
        }

        return outcome;
    }

    /**
     * 深度研究轮：先执行深度研究（开始/结果/结束写入系统消息），
     * 再读入研究期间到达的新消息，最后用引导语 prompt。
     * 模型可在本轮 reply 中再次设置 requires_deep_research 请求链式研究，
     * 是否继续由调用方（reply-manager）按轮数上限决定。
     */
    async runResearchTurn (task: ReplyTask, topic: string, boundary: number): Promise<TurnOutcome> {
        let researchSuccess = false;
        try {
            const research = await this.researchRunner.runWithSystemMessages(topic);
            researchSuccess = research.success;
        } catch (err) {
            this.logger.error(`[ReplyAgent] [${this.groupId}] deep research failed:`, err);
        }

        const latestMessages = await this.fetchMessagesSince(boundary);
        const userTexts = await buildUserPromptArray(latestMessages, this.descQueue);
        const processedUpToId = latestMessages[latestMessages.length - 1]?.id;

        // 乱序消息的时序提示拼在 user 消息最后（深度研究轮无 graphiti 合并 episode，无需额外隔离）
        if (userTexts.length > 0) {
            const outOfOrderHint = this.buildOutOfOrderHint(latestMessages);
            if (outOfOrderHint) {
                this.logger.info(
                    `[ReplyAgent] [${this.groupId}] out-of-order messages detected in research turn, ` +
                    `lastBotReplyId=${this.lastBotReplyId}`);
                userTexts[userTexts.length - 1] += outOfOrderHint;
            }
        }

        const outcome = await this.promptAndCollect({
            appendTexts: userTexts,
            promptText: prompts.deepResearchTurnGuidance,
            processedUpToId,
            label: 'research turn'
        });
        outcome.researchSuccess = researchSuccess;
        return outcome;
    }

    /**
     * 回合公共逻辑：appendTexts 依次 append 到 harness，再以 promptText 发起 prompt
     * （含 reminder 重试与模型回退链），最后解析 reply 工具结果。
     * reply 工具被调用即视为成功——空 messages 是模型主动选择不回复，不算失败。
     */
    private async promptAndCollect (options: {
        appendTexts: string[];
        promptText: string;
        processedUpToId?: number;
        label: string;
    }): Promise<TurnOutcome> {
        const {appendTexts, promptText, processedUpToId, label} = options;

        // 每个回合独立的工具调用轮数配额与 reply 结果
        this.lastReplyToolParams = null;
        this.toolCallRoundCount = 0;

        this.debug.dumpSystemPrompt(this.systemPromptText);
        const allTexts = [...appendTexts, promptText];
        for (let i = 0; i < allTexts.length; i++) {
            this.debug.dumpUserMessage(i, allTexts[i]);
        }

        for (const text of appendTexts) {
            await this.harness.appendMessage({
                role: 'user',
                content: [{type: 'text', text}],
                timestamp: Date.now()
            } as AgentMessage);
        }

        let assistant: AssistantMessage | undefined;
        try {
            assistant = await this.promptWithReminders(promptText);
        } catch (err) {
            this.logger.error(
                `[ReplyAgent] [${this.groupId}] ${label} prompt threw: ` +
                `${err instanceof Error ? err.message : String(err)}`);
        }

        if (!assistant || assistant.stopReason === 'error' || assistant.stopReason === 'aborted') {
            this.logger.error(
                `[ReplyAgent] [${this.groupId}] ${label} failed ` +
                `(stopReason=${assistant?.stopReason ?? 'undefined'})`);
            return {messages: [], requiresDeepResearch: false, failed: true, processedUpToId};
        }

        this.debug.dumpOutput(assistant);

        const params = this.getReplyToolParams();
        if (!params) {
            this.logger.warn(`[ReplyAgent] [${this.groupId}] ${label} missing reply tool call, failed`);
            return {messages: [], requiresDeepResearch: false, failed: true, processedUpToId};
        }

        // 过滤全空白文本的消息；过滤后为空表示模型选择不回复
        const messages = params.messages.filter(m => m.text.trim());
        if (messages.length === 0) {
            this.logger.info(`[ReplyAgent] [${this.groupId}] ${label} replied with empty messages (no reply)`);
        }

        return {
            messages,
            requiresDeepResearch: params.requires_deep_research,
            deepResearchTopic: params.deep_research_topic,
            failed: false,
            processedUpToId
        };
    }

    private async promptWithReminders (lastText: string): Promise<AssistantMessage | undefined> {
        let assistant: AssistantMessage | undefined;
        const MAX_REMINDERS = 2;
        let lastWasError = false;

        // 回退链：API 错误时按配置顺序切换到下一个模型
        const modelEntries = resolveAssignmentModels(this.config, this.config.ai.assignments.agent_harness);
        let fallbackIndex = 0;

        for (let i = 0; i <= MAX_REMINDERS; i++) {
            await this.syncHarnessModel(modelEntries[fallbackIndex]);
            this.lastReplyToolParams = null;
            if (i === 0) {
                assistant = await this.harness.prompt(lastText);
            } else {
                this.logger.info(
                    `[ReplyAgent] [${this.groupId}] sending reminder ${i}/${MAX_REMINDERS}...`);
                assistant = await this.harness.prompt(
                    lastWasError ? prompts.replyErrorReminder() : prompts.replyReminder());
            }

            if (!assistant) {
                continue;
            }
            this.logger.info(`[ReplyAgent] [${this.groupId}] turn usage: ${formatUsage(assistant.usage)}`);
            if (assistant.stopReason === 'error' || assistant.stopReason === 'aborted') {
                // 优先按回退链切换模型重试（不消耗 reminder 额度）；链耗尽后进入 reminder 重试（最多 MAX_REMINDERS 次）
                if (fallbackIndex < modelEntries.length - 1) {
                    fallbackIndex++;
                    this.logger.warn(
                        `[ReplyAgent] [${this.groupId}] turn error ` +
                        `(stopReason=${assistant.stopReason}): ${assistant.errorMessage ?? 'unknown'}; ` +
                        `falling back to model ${modelEntries[fallbackIndex].model.id}`);
                    lastWasError = true;
                    i--;
                    continue;
                }
                this.logger.warn(
                    `[ReplyAgent] [${this.groupId}] turn error ` +
                    `(stopReason=${assistant.stopReason}): ${assistant.errorMessage ?? 'unknown'}`);
                lastWasError = true;
                continue;
            }
            lastWasError = false;
            // reply 工具被调用即成功（空 messages 是模型主动选择不回复）；未调用才 reminder
            if (this.getReplyToolParams()) {
                return assistant;
            }
        }

        return assistant;
    }

    async appendBotMessage (storedMessage: StoredMessage): Promise<void> {
        if (typeof storedMessage.id === 'number') {
            this.lastBotReplyId = Math.max(this.lastBotReplyId, storedMessage.id);
        }
        const text = await messagesToString([storedMessage], sha => this.descQueue.resolve(sha));
        if (!text.trim()) return;
        await this.harness.appendMessage({
            role: 'assistant',
            content: [{type: 'text', text}],
            timestamp: storedMessage.time * 1000
        } as AgentMessage);
    }

    async buildPreviewPrompt (task: ReplyTask): Promise<{ systemPrompt: string; userMessages: string[] }> {
        const latestMessages = await this.fetchMessagesSince(task.lastTriggerId ?? 0);
        const userMessages = await buildUserPromptArray(latestMessages, this.descQueue);
        // 与实际回复逻辑保持一致：乱序时预览也带时序提示
        if (userMessages.length > 0) {
            const outOfOrderHint = this.buildOutOfOrderHint(latestMessages);
            if (outOfOrderHint) {
                userMessages[userMessages.length - 1] += outOfOrderHint;
            }
        }
        return {
            systemPrompt: this.systemPromptText,
            userMessages
        };
    }

    async triggerCompact (_groupId?: number, _force = false): Promise<void> {
        await this.waitForIdle();
        await this.harness.compact();
        await this.waitForIdle();
    }

    async waitForIdle (): Promise<void> {
        await this.harness.waitForIdle();
    }

    getBranch (): ReturnType<Session['getBranch']> {
        return this.session.getBranch();
    }
}

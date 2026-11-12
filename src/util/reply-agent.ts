import {
    AgentSession,
    createAgentSession,
    DefaultResourceLoader,
    getAgentDir,
    SettingsManager,
    convertToLlm,
    serializeConversation,
    type InlineExtension,
    type ModelRuntime,
    type SessionEntry,
    type SessionManager,
    type ToolDefinition
} from '@earendil-works/pi-coding-agent';
import type {AgentMessage} from '@earendil-works/pi-agent-core';
import type {AssistantMessage, Context, Message} from '@earendil-works/pi-ai';
import {
    schema,
    type Db,
    deleteGroupOverallMemory,
    getGroupOverallMemory,
    rowToStoredMessage,
    setGroupLastTriggerId,
    setGroupOverallMemory
} from '~/db';
import type {AppConfig, ModelEntry} from '~/config';
import {eq, asc, and, or, gt, gte, lte, ne, desc} from 'drizzle-orm';
import type {DescQueue} from './desc-queue';
import type {ReplyTask} from './reply-task';
import {messagesToString, type StoredMessage} from '~/message-format';
import {prompts} from '~/prompts';
import {Logger} from '@lib/util/logger';
import {
    activateGroupSession,
    createGroupSession,
    disposeAgentSession,
    getOrCreateGroupSession,
    registerAgentSession,
    emptyUsage
} from './harness-factory';
import {resolveAssignmentModels} from './models-factory';
import {createReplyTool, type ReplyToolParams, type ReplyMessageItem} from './reply-tool';
import {createGraphitiTools} from './graphiti-tool';
import {createImageTools} from './image-tool';
import {createStickerTools} from './sticker-tool';
import {getStickers, type StickerRecord} from './sticker-store';
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

interface CreateReplySessionOptions {
    config: AppConfig;
    models: ModelRuntime;
    sessionManager: SessionManager;
    tools: ToolDefinition[];
    systemPromptText: string;
    onToolCall: (toolName: string) => void;
}

async function createReplyAgentSession (options: CreateReplySessionOptions): Promise<AgentSession> {
    const runtimeExtension: InlineExtension = pi => {
        pi.on('before_agent_start', () => ({systemPrompt: options.systemPromptText}));
        pi.on('tool_call', event => options.onToolCall(event.toolName));
    };

    const settingsManager = SettingsManager.inMemory({
        retry: {enabled: false},
        compaction: {enabled: false},
        cacheWarming: 'off'
    });

    const cwd = process.cwd();
    const agentDir = getAgentDir();
    const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        extensionFactories: [runtimeExtension],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: options.systemPromptText,
        appendSystemPrompt: [],
        systemPromptOverride: () => options.systemPromptText,
        appendSystemPromptOverride: () => []
    });
    await resourceLoader.reload();

    const harnessEntry = resolveAssignmentModels(
        options.config, options.config.ai.assignments.agent_harness)[0];
    const {session} = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime: options.models,
        model: harnessEntry.model,
        thinkingLevel: 'high',
        noTools: 'builtin',
        customTools: options.tools,
        sessionManager: options.sessionManager,
        settingsManager,
        resourceLoader
    });
    await session.bindExtensions({});
    registerAgentSession(session);
    return session;
}

function buildGroupMemoryMessage (memory: string): Message {
    return {
        role: 'user',
        content: [{type: 'text', text: prompts.groupMemoryContext(memory)}],
        timestamp: Date.now()
    } as Message;
}

function buildStickerListMessage (stickers: StickerRecord[], maxCount: number): Message {
    return {
        role: 'user',
        content: [{type: 'text', text: prompts.stickerListContext(stickers, maxCount)}],
        timestamp: Date.now()
    } as Message;
}

/** 会话头部消息：总体记忆与表情包收藏列表，压缩时不计入聊天内容 */
function buildSessionHeaderMessages (memory: string | null, stickers: StickerRecord[], maxCount: number): Message[] {
    const messages: Message[] = [];
    if (memory) messages.push(buildGroupMemoryMessage(memory));
    messages.push(buildStickerListMessage(stickers, maxCount));
    return messages;
}

function messageText (message: AgentMessage): string {
    if (message.role !== 'user') return '';
    const content = message.content;
    if (typeof content === 'string') return content;
    let text = '';
    for (const block of content) {
        if (block.type === 'text') text += block.text;
    }
    return text;
}

function isSessionHeaderMessage (message: AgentMessage): boolean {
    const text = messageText(message);
    return text.startsWith(prompts.groupMemoryContextPrefix) ||
        text.startsWith(prompts.stickerListPrefix);
}

function assistantText (message: AssistantMessage): string {
    return message.content
        .filter((block): block is Extract<typeof block, {type: 'text'}> => block.type === 'text')
        .map(block => block.text)
        .join('')
        .trim();
}

export class ReplyAgent {
    private db: Db;
    private descQueue: DescQueue;
    private config: AppConfig;
    private groupId: number;
    private models: ModelRuntime;
    private tools: ToolDefinition[];
    private sessionManager: SessionManager;
    private session: AgentSession;
    private logger: Logger;
    private systemPromptText: string;
    private debug: ReplyDebugDumper;
    private memoryContext: MemoryContextBuilder;
    private researchRunner: DeepResearchRunner;
    private lastReplyToolParams: ReplyToolParams | null = null;
    private toolCallRoundCount = 0;
    private graphiti: GraphitiClient | null = null;
    /** 已注入会话的最近一条 bot 回复的数据库 id，用于检测乱序消息（回复生成期间送达的消息 id 更小却排在回复之后） */
    private lastBotReplyId = 0;
    /** 最近一轮 prompt 中最后一条 assistant 消息，由会话的 message_end 事件刷新 */
    private lastAssistantMessage: AssistantMessage | undefined;

    private constructor (options: {
        db: Db;
        descQueue: DescQueue;
        config: AppConfig;
        groupId: number;
        models: ModelRuntime;
        tools: ToolDefinition[];
        sessionManager: SessionManager;
        session: AgentSession;
        systemPromptText: string;
        graphiti: GraphitiClient | null;
        lastBotReplyId: number;
    }) {
        this.db = options.db;
        this.descQueue = options.descQueue;
        this.config = options.config;
        this.groupId = options.groupId;
        this.models = options.models;
        this.tools = options.tools;
        this.sessionManager = options.sessionManager;
        this.session = options.session;
        this.systemPromptText = options.systemPromptText;
        this.graphiti = options.graphiti;
        this.lastBotReplyId = options.lastBotReplyId;
        this.logger = new Logger();

        this.session.subscribe(event => {
            if (event.type === 'message_end' && event.message.role === 'assistant') {
                this.lastAssistantMessage = event.message;
            }
        });

        this.debug = new ReplyDebugDumper({config: this.config, logger: this.logger, groupId: this.groupId});
        this.memoryContext = new MemoryContextBuilder({
            config: this.config,
            groupId: this.groupId,
            logger: this.logger,
            graphiti: this.graphiti,
            sessionManager: this.sessionManager,
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
        models: ModelRuntime;
        graphiti?: GraphitiClient | null;
    }): Promise<ReplyAgent> {
        const {groupId, db, descQueue, config, models, graphiti} = options;

        const logger = new Logger();
        const {sessionManager, isNew} = await getOrCreateGroupSession(groupId, db);
        if (isNew) {
            const memory = await getGroupOverallMemory(db, groupId);
            const stickers = await getStickers(db);
            for (const message of buildSessionHeaderMessages(memory, stickers, config.input.sticker_max_count)) {
                sessionManager.appendMessage(message);
            }
        }

        const agentRef: {current: ReplyAgent | null} = {current: null};

        const replyTool = createReplyTool({
            db,
            onCalled: params => {
                agentRef.current!.lastReplyToolParams = params;
            }
        });

        const graphitiTools = graphiti ? createGraphitiTools(graphiti, config.log.level, groupId) : [];
        const imageTools = createImageTools({db, descQueue});
        const stickerTools = createStickerTools({
            db,
            groupId,
            maxStickers: config.input.sticker_max_count
        });
        const tools: ToolDefinition[] = [replyTool, ...imageTools, ...stickerTools, ...graphitiTools];

        const systemPromptText = buildSystemPrompt({
            botName: config.input.bot_name || '机器人',
            botPersona: config.input.bot_persona || '',
            toolsDescription: formatToolsDescription(tools),
            groupCustomPrompt: config.input.group_custom_prompts?.[groupId]
        });

        const session = await createReplyAgentSession({
            config,
            models,
            sessionManager,
            tools,
            systemPromptText,
            onToolCall: toolName => agentRef.current?.checkToolCall(toolName)
        });

        const lastBotReplyId = await ReplyAgent.restoreLastBotReplyId(db, groupId);

        const agent = new ReplyAgent({
            db,
            descQueue,
            config,
            groupId,
            models,
            tools,
            sessionManager,
            session,
            systemPromptText,
            graphiti: graphiti ?? null,
            lastBotReplyId
        });

        agentRef.current = agent;

        if (isNew) {
            await ReplyAgent.bootstrapNewSession(db, groupId, logger);
        }

        logger.info(`[ReplyAgent] [${groupId}] session created, isNew=${isNew}`);
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

    /**
     * tool_call 事件处理：reply 直接放行，其余工具计入本轮配额，
     * 超过 max_tool_call_rounds 后阻止执行，由 reminder 引导模型回复。
     */
    private checkToolCall (toolName: string): {block: true; reason: string} | undefined {
        if (toolName === 'reply') {
            return undefined;
        }
        this.toolCallRoundCount++;
        if (this.toolCallRoundCount > this.config.input.max_tool_call_rounds) {
            this.logger.warn(
                `[ReplyAgent] [${this.groupId}] tool call rounds exceeded ` +
                `${this.config.input.max_tool_call_rounds}, blocking`);
            return {block: true, reason: 'tool call round limit exceeded'};
        }
        return undefined;
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

    /** 追加一条消息到持久化会话并同步到运行中的上下文 */
    private appendSessionMessage (message: Message): void {
        this.sessionManager.appendMessage(message);
        this.session.refreshContext();
    }

    /** 构建写入会话的 assistant 消息；usage 为必填字段，缺失会让上下文估算读到 undefined */
    private buildAssistantMessage (text: string, timestamp: number): Message {
        return {
            role: 'assistant',
            content: [{type: 'text', text}],
            usage: emptyUsage(),
            stopReason: 'stop',
            timestamp
        } as Message;
    }

    /**
     * 手动导入指定时间范围内的历史消息到会话。
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

            const message: Message = msg.isBot ?
                this.buildAssistantMessage(text, msg.time * 1000) :
                {
                    role: 'user',
                    content: [{type: 'text', text}],
                    timestamp: msg.time * 1000
                } as Message;
            this.appendSessionMessage(message);
            imported++;
        }

        await this.waitForIdle();
        this.logger.info(
            `[ReplyAgent] [${this.groupId}] imported ${imported} messages ` +
            `from ${startTime} to ${endTime}`);
        return imported;
    }

    private async fetchMessagesSince (lastTriggerId: number): Promise<StoredMessage[]> {
        // bot 普通聊天消息已通过 appendBotMessage 注入会话，这里排除以避免重复；
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
     * 检测乱序消息：本轮读入的消息 id 小于等于已注入会话的最近 bot 回复 id，
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

    private async syncSessionModel (entry: ModelEntry): Promise<void> {
        const current = this.session.model;
        if (!current || current.provider !== entry.model.provider || current.id !== entry.model.id) {
            await this.session.setModel(entry.model);
            this.logger.info(
                `[ReplyAgent] [${this.groupId}] session model switched ` +
                `from ${current ? current.id : 'none'} to ${entry.model.id}`);
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
     * 回合公共逻辑：appendTexts 依次 append 到会话，再以 promptText 发起 prompt
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
            this.appendSessionMessage({
                role: 'user',
                content: [{type: 'text', text}],
                timestamp: Date.now()
            } as Message);
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

        // 过滤既无文字也无图片的消息；过滤后为空表示模型选择不回复
        const messages = params.messages.filter(m =>
            (m.text ?? '').trim().length > 0 || typeof m.image_id === 'number');
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

    /** 发起一次 prompt 并取回本轮最后一条 assistant 消息（无结果或抛错时返回 undefined） */
    private async runPrompt (text: string): Promise<AssistantMessage | undefined> {
        this.lastAssistantMessage = undefined;
        try {
            await this.session.prompt(text, {expandPromptTemplates: false});
        } catch (err) {
            this.logger.error(
                `[ReplyAgent] [${this.groupId}] prompt error: ` +
                `${err instanceof Error ? err.message : String(err)}`);
        }
        return this.lastAssistantMessage;
    }

    /**
     * 按当前会话上下文重新发起请求，不追加新的 user 消息。
     * 用于失败后的重试：失败尝试的 user 文本已经在会话里，再 prompt 一次会让模型看到重复的同一段消息。
     */
    private async continueTurn (): Promise<AssistantMessage | undefined> {
        this.lastAssistantMessage = undefined;
        try {
            await this.session.agent.continue();
        } catch (err) {
            this.logger.error(
                `[ReplyAgent] [${this.groupId}] continue error: ` +
                `${err instanceof Error ? err.message : String(err)}`);
        }
        return this.lastAssistantMessage;
    }

    /**
     * 把失败尝试留下的 assistant 消息排除出模型上下文。
     * 会话文件保留原文（Web 日志仍能看到错误详情），模型上下文不再包含这条错误消息。
     */
    private omitFailedAssistant (): void {
        const branch = this.sessionManager.getBranch();
        for (let i = branch.length - 1; i >= 0; i--) {
            const entry = branch[i];
            if (entry.type !== 'message') continue;
            const message = entry.message;
            if (message.role !== 'assistant') return;
            if (message.stopReason !== 'error' && message.stopReason !== 'aborted') return;
            this.sessionManager.appendContextEdit(entry.id, null);
            this.session.refreshContext();
            this.logger.info(
                `[ReplyAgent] [${this.groupId}] failed assistant message omitted from context ` +
                `(stopReason=${message.stopReason})`);
            return;
        }
    }

    /** 本次尝试是否已经把 user 文本写进会话（上下文末尾多出一条 user 消息） */
    private hasPendingUserMessage (messageCountBefore: number): boolean {
        const messages = this.session.messages;
        if (messages.length <= messageCountBefore) return false;
        return messages[messages.length - 1].role === 'user';
    }

    private async promptWithReminders (lastText: string): Promise<AssistantMessage | undefined> {
        let assistant: AssistantMessage | undefined;
        const MAX_REMINDERS = 2;
        let lastWasError = false;

        // 回退链：API 错误时按配置顺序切换到下一个模型
        const modelEntries = resolveAssignmentModels(this.config, this.config.ai.assignments.agent_harness);
        let fallbackIndex = 0;
        // 下一轮按当前上下文续跑（上一段的 user 文本已经在会话里，不再重复追加）
        let resumeContext = false;

        for (let i = 0; i <= MAX_REMINDERS; i++) {
            const entry = modelEntries[fallbackIndex];
            await this.syncSessionModel(entry);
            this.lastReplyToolParams = null;

            const resume = resumeContext;
            resumeContext = false;
            const messageCountBefore = this.session.messages.length;
            if (resume) {
                this.logger.info(
                    `[ReplyAgent] [${this.groupId}] retrying turn with model ${entry.model.id} ` +
                    `from the existing context`);
                assistant = await this.continueTurn();
            } else if (i === 0) {
                assistant = await this.runPrompt(lastText);
            } else {
                this.logger.info(
                    `[ReplyAgent] [${this.groupId}] sending reminder ${i}/${MAX_REMINDERS}...`);
                assistant = await this.runPrompt(
                    lastWasError ? prompts.replyErrorReminder() : prompts.replyReminder());
            }

            if (!assistant) {
                // 没有 assistant 结果（prompt 抛错或运行未产出消息）按错误处理
                if (fallbackIndex < modelEntries.length - 1) {
                    fallbackIndex++;
                    this.logger.warn(
                        `[ReplyAgent] [${this.groupId}] turn produced no assistant message; ` +
                        `falling back to model ${modelEntries[fallbackIndex].model.id}`);
                    lastWasError = true;
                    i--;
                    resumeContext = this.hasPendingUserMessage(messageCountBefore);
                    continue;
                }
                lastWasError = true;
                continue;
            }
            this.logger.info(`[ReplyAgent] [${this.groupId}] turn usage: ${formatUsage(assistant.usage)}`);
            if (assistant.stopReason === 'error' || assistant.stopReason === 'aborted') {
                this.omitFailedAssistant();
                // 优先按回退链切换模型重试（不消耗 reminder 额度）；链耗尽后进入 reminder 重试（最多 MAX_REMINDERS 次）
                if (fallbackIndex < modelEntries.length - 1) {
                    fallbackIndex++;
                    this.logger.warn(
                        `[ReplyAgent] [${this.groupId}] turn error ` +
                        `(stopReason=${assistant.stopReason}): ${assistant.errorMessage ?? 'unknown'}; ` +
                        `falling back to model ${modelEntries[fallbackIndex].model.id}`);
                    lastWasError = true;
                    i--;
                    resumeContext = this.hasPendingUserMessage(messageCountBefore);
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
        this.appendSessionMessage(this.buildAssistantMessage(text, storedMessage.time * 1000));
    }

    async buildPreviewPrompt (task: ReplyTask): Promise<{systemPrompt: string; userMessages: string[]}> {
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

    /** 上下文占用达到配置比例时更新总体记忆并更换会话 */
    async compactIfContextNeeded (): Promise<boolean> {
        const ratio = this.config.input.compact_context_ratio;
        if (ratio <= 0) return false;
        const usage = this.session.getContextUsage();
        if (usage?.percent === null || usage?.percent === undefined) return false;
        if (usage.percent < ratio * 100) return false;
        this.logger.info(
            `[ReplyAgent] [${this.groupId}] context usage ${usage.percent.toFixed(2)}% ` +
            `reached compact ratio ${ratio * 100}%`);
        return this.triggerCompact();
    }

    /** 生成群总体记忆，保存到数据库后以它为第一条消息创建新会话 */
    async triggerCompact (): Promise<boolean> {
        await this.waitForIdle();
        const contextMessages = this.sessionManager.buildSessionContext().messages;
        let headerCount = 0;
        while (headerCount < contextMessages.length && isSessionHeaderMessage(contextMessages[headerCount])) {
            headerCount++;
        }
        const chatMessages = contextMessages.slice(headerCount);
        if (!serializeConversation(convertToLlm(chatMessages)).trim()) {
            this.logger.info(`[ReplyAgent] [${this.groupId}] no chat messages to compact`);
            return false;
        }

        const conversationMessages = contextMessages.filter(message =>
            !messageText(message).startsWith(prompts.stickerListPrefix));
        const conversation = serializeConversation(convertToLlm(conversationMessages));
        const summary = await this.generateOverallMemory(conversation);
        await setGroupOverallMemory(this.db, this.groupId, summary);
        await this.replaceSession(summary);
        this.logger.info(
            `[ReplyAgent] [${this.groupId}] overall memory updated, ` +
            `chars=${Array.from(summary).length}`);
        return true;
    }

    /** 编辑总体记忆：更新数据库并替换当前会话开头的总体记忆消息 */
    async updateOverallMemory (content: string): Promise<void> {
        const trimmed = content.trim();
        if (!trimmed) throw new Error('overall memory content must not be empty');
        await this.waitForIdle();
        const memoryEntry = this.sessionManager.getBranch().find(entry =>
            entry.type === 'message' &&
            entry.message.role === 'user' &&
            messageText(entry.message).startsWith(prompts.groupMemoryContextPrefix));
        if (!memoryEntry) {
            throw new Error('overall memory message not found in the current session');
        }
        await setGroupOverallMemory(this.db, this.groupId, trimmed);
        this.sessionManager.appendContextEdit(memoryEntry.id, {
            content: [{type: 'text', text: prompts.groupMemoryContext(trimmed)}]
        });
        this.session.refreshContext();
        this.logger.info(
            `[ReplyAgent] [${this.groupId}] overall memory edited, ` +
            `chars=${Array.from(trimmed).length}`);
    }

    /** 删除总体记忆并更换为空会话，使当前上下文立即停止使用该记忆 */
    async clearOverallMemory (): Promise<void> {
        await this.waitForIdle();
        await deleteGroupOverallMemory(this.db, this.groupId);
        await this.replaceSession(null);
        this.logger.info(`[ReplyAgent] [${this.groupId}] overall memory deleted`);
    }

    private async generateOverallMemory (conversation: string): Promise<string> {
        const entries = resolveAssignmentModels(this.config, this.config.ai.assignments.agent_harness);
        for (const [index, entry] of entries.entries()) {
            try {
                return await this.generateOverallMemoryWithModel(entry, conversation);
            } catch (err) {
                this.logger.error(
                    `[ReplyAgent] [${this.groupId}] overall memory generation failed ` +
                    `(model=${entry.model.id}):`, err);
                if (index === entries.length - 1) throw err;
            }
        }
        throw new Error('overall memory generation has no available model');
    }

    private async generateOverallMemoryWithModel (
        entry: ModelEntry, conversation: string
    ): Promise<string> {
        const maxChars = this.config.input.compact_max_chars;
        if (!Number.isInteger(maxChars) || maxChars <= 0) {
            throw new Error(`compact_max_chars must be a positive integer, got ${maxChars}`);
        }

        const messages: Message[] = [{
            role: 'user',
            content: prompts.groupCompactionPrompt(conversation, maxChars),
            timestamp: Date.now()
        } as Message];

        for (;;) {
            const context: Context = {
                systemPrompt: prompts.groupCompactionSystem,
                messages
            };
            const response = await this.models.completeSimple(entry.model, context, {
                apiKey: entry.apiKey
            });
            if (response.stopReason === 'error' || response.stopReason === 'aborted') {
                throw new Error(response.errorMessage || `Compaction stopped: ${response.stopReason}`);
            }
            this.logger.info(
                `[ReplyAgent] [${this.groupId}] compaction usage: ${formatUsage(response.usage)}`);
            const text = assistantText(response);
            if (!text) throw new Error('compaction model returned empty text');
            const actualChars = Array.from(text).length;
            if (actualChars <= maxChars) return text;

            this.logger.info(
                `[ReplyAgent] [${this.groupId}] overall memory too long ` +
                `(${actualChars}/${maxChars}), requesting reduction`);
            messages.push(response, {
                role: 'user',
                content: prompts.groupCompactionReducePrompt(actualChars, maxChars),
                timestamp: Date.now()
            } as Message);
        }
    }

    private async replaceSession (memory: string | null): Promise<void> {
        const stickers = await getStickers(this.db);
        const created = createGroupSession(this.groupId);
        for (const message of buildSessionHeaderMessages(memory, stickers, this.config.input.sticker_max_count)) {
            created.sessionManager.appendMessage(message);
        }
        const session = await createReplyAgentSession({
            config: this.config,
            models: this.models,
            sessionManager: created.sessionManager,
            tools: this.tools,
            systemPromptText: this.systemPromptText,
            onToolCall: toolName => this.checkToolCall(toolName)
        });
        try {
            await activateGroupSession(this.db, this.groupId, created);
        } catch (err) {
            disposeAgentSession(session);
            throw err;
        }

        const previous = this.session;
        this.session = session;
        this.sessionManager = created.sessionManager;
        this.lastAssistantMessage = undefined;
        this.session.subscribe(event => {
            if (event.type === 'message_end' && event.message.role === 'assistant') {
                this.lastAssistantMessage = event.message;
            }
        });
        this.memoryContext = new MemoryContextBuilder({
            config: this.config,
            groupId: this.groupId,
            logger: this.logger,
            graphiti: this.graphiti,
            sessionManager: this.sessionManager,
            debug: this.debug
        });
        disposeAgentSession(previous);
        this.logger.info(
            `[ReplyAgent] [${this.groupId}] active session replaced with ${created.metadata.id}`);
    }

    async waitForIdle (): Promise<void> {
        await this.session.waitForIdle();
    }

    getBranch (): SessionEntry[] {
        return this.sessionManager.getBranch();
    }
}

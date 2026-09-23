import {AgentHarness, type AgentMessage, type AgentTool, type Session} from '@earendil-works/pi-agent-core';
import {NodeExecutionEnv} from '@earendil-works/pi-agent-core/node';
import {type AssistantMessage, type Context, type Models} from '@earendil-works/pi-ai';
import {schema, type Db, type JsonlSessionMetadata, insertSystemMessage, setGroupLastTriggerId} from '~/db';
import type {AppConfig, ModelEntry} from '~/config';
import {eq, asc, and, or, gt, gte, lte, ne, desc} from 'drizzle-orm';
import type {DescQueue} from './desc-queue';
import type {ReplyTask} from './reply-manager';
import {messagesToString, type StoredMessage} from '~/message-format';
import {prompts} from '~/prompts';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Logger} from '@lib/util/logger';
import {getOrCreateGroupSession} from './harness-factory';
import {resolveAssignmentModels} from './models-factory';
import {createReplyTool, type ReplyToolParams, type ReplyMessageItem} from './reply-tool';
import {createGraphitiTools} from './graphiti-tool';
import {addMessageEpisode, addMergedMessagesEpisode} from './graphiti-episode';
import {GraphitiClient} from './graphiti-client';
import OpenAI from 'openai';

function formatToolParameters (toolSchema: AgentTool['parameters']): string {
    return JSON.stringify(toolSchema, null, 2);
}

function formatToolsDescription (tools: AgentTool[]): string {
    if (tools.length === 0) return '无可用工具。';

    return tools
        .map(tool => {
            const params = formatToolParameters(tool.parameters);
            return `- ${tool.name}（${tool.label}）: ${tool.description}\n参数: ${params}`;
        })
        .join('\n');
}

function buildSystemPrompt ({
    botName,
    botPersona,
    toolsDescription,
    groupCustomPrompt
}: {
    botName: string;
    botPersona: string;
    toolsDescription: string;
    groupCustomPrompt?: string;
}): string {
    const parts: string[] = [
        prompts.jailBreak,
        prompts.replyIdentity(botName),
        botPersona,
        '## 可用工具',
        toolsDescription,
        prompts.replyToolInstructions
    ];

    if (groupCustomPrompt) {
        parts.push(`${prompts.groupCustomPromptStart}\n${groupCustomPrompt}\n${prompts.groupCustomPromptEnd}`);
    }

    return parts.join('\n\n');
}

async function buildUserPromptArray (
    latestMessages: StoredMessage[],
    descQueue: DescQueue
): Promise<string[]> {
    if (latestMessages.length === 0) return [];

    const body = await messagesToString(latestMessages, sha => descQueue.resolve(sha));
    if (!body.trim()) return [];

    return [body];
}

function extractText (response: AssistantMessage): string {
    return response.content
        .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
        .map(c => c.text)
        .join('')
        .trim();
}

function formatUsage (usage: AssistantMessage['usage']): string {
    const totalInput = usage.input + usage.cacheRead;
    const cacheRatio = totalInput > 0 ? ((usage.cacheRead / totalInput) * 100).toFixed(2) : '0.00';
    return `input=${usage.input} output=${usage.output} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite} cacheWrite1h=${usage.cacheWrite1h ?? 0} cacheRead/totalInput=${cacheRatio}%`;
}

function stringifyMessageContent (content: Context['messages'][number]['content']): string {
    if (typeof content === 'string') return content;
    return content
        .map(block => {
            if (block.type === 'text') return block.text;
            return JSON.stringify(block);
        })
        .join('\n');
}

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
    private models: Models;
    private groupId: number;
    private session: Session<JsonlSessionMetadata>;
    private harness: AgentHarness;
    private logger: Logger;
    private systemPromptText: string;
    private debugPrefix?: string;
    private lastReplyToolParams: ReplyToolParams | null = null;
    private toolCallRoundCount = 0;
    private graphiti: GraphitiClient | null = null;
    /** 已注入 harness 的最近一条 bot 回复的数据库 id，用于检测乱序消息（回复生成期间送达的消息 id 更小却排在回复之后） */
    private lastBotReplyId = 0;

    private constructor (options: {
        db: Db;
        descQueue: DescQueue;
        config: AppConfig;
        models: Models;
        groupId: number;
        session: Session<JsonlSessionMetadata>;
        harness: AgentHarness;
        systemPromptText: string;
        graphiti: GraphitiClient | null;
        lastBotReplyId: number;
    }) {
        this.db = options.db;
        this.descQueue = options.descQueue;
        this.config = options.config;
        this.models = options.models;
        this.groupId = options.groupId;
        this.session = options.session;
        this.harness = options.harness;
        this.systemPromptText = options.systemPromptText;
        this.graphiti = options.graphiti;
        this.lastBotReplyId = options.lastBotReplyId;
        this.logger = new Logger();
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

        const graphitiInstance = graphiti ?? null;

        // 从数据库恢复该群最近一条 bot 回复行 id：
        // 重启后 lastBotReplyId 内存状态丢失，否则重启前「回复生成期间送达」的消息无法被乱序检测覆盖
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
        const lastBotReplyId = lastBotReply[0]?.id ?? 0;

        const agent = new ReplyAgent({
            db,
            descQueue,
            config,
            models,
            groupId,
            session,
            harness,
            systemPromptText: systemPrompt(),
            graphiti: graphitiInstance,
            lastBotReplyId
        });

        agentRef.current = agent;

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

        if (isNew) {
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

        logger.info(`[ReplyAgent] [${groupId}] harness created, isNew=${isNew}`);
        return agent;
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
            const msg: StoredMessage = {
                id: row.id,
                time: row.time,
                messageId: row.messageId,
                senderId: row.userId,
                senderName: row.senderName,
                senderCard: row.senderCard ?? undefined,
                isBot: row.isBot,
                isAtBot: row.isAtBot,
                segments: row.segments as StoredMessage['segments']
            };
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

        return rows.map(row => ({
            id: row.id,
            time: row.time,
            messageId: row.messageId,
            senderId: row.userId,
            senderName: row.senderName,
            senderCard: row.senderCard ?? undefined,
            isBot: row.isBot,
            isAtBot: row.isAtBot,
            segments: row.segments as StoredMessage['segments']
        }));
    }

    private async generateMemoryQuery (
        messagesText: string,
        existingMemories: string[]
    ): Promise<{queries: string[]; entities: string[]} | null> {
        if (!this.config.ai.assignments.memory_keyword) return null;

        const modelEntries = resolveAssignmentModels(this.config, this.config.ai.assignments.memory_keyword);
        const existingBlock = existingMemories.length > 0 ?
            existingMemories.join('\n') :
            '（无）';
        // 实体搜索未启用时不生成 entities 查询：prompt 中不注入 entities 字段说明，解析结果强制为空
        const enableEntitySearch = this.config.ai.memoryKeyword?.enable_entity_search ?? false;
        const prompt = prompts.memoryQueryPrompt
            .replace('{entities_field}', enableEntitySearch ? prompts.memoryQueryPromptEntitiesField : '')
            .replace('{existing_memories}', existingBlock)
            .replace('{messages}', messagesText);

        // Debug dump memory query prompt
        if (this.config.input.debug_dump_prompt && this.debugPrefix) {
            const dir = join('data', 'debug', this.debugPrefix);
            mkdirSync(dir, {recursive: true});
            writeFileSync(join(dir, 'memory-query-prompt.txt'), prompt, 'utf-8');
            this.logger.debug(
                `[ReplyAgent] [${this.groupId}] memory query prompt dumped to ` +
                `${this.debugPrefix}/memory-query-*`);
        }

        const disableThinking = this.config.ai.memoryKeyword?.disable_thinking ?? false;
        if (disableThinking) {
            this.logger.debug(`[ReplyAgent] [${this.groupId}] memory query: disable thinking`);
        }

        // 按回退链依次尝试：API 错误时切换下一个模型
        for (const [index, modelEntry] of modelEntries.entries()) {
            try {
                // 使用 OpenAI SDK 调用模型
                const client = new OpenAI({
                    apiKey: modelEntry.apiKey,
                    baseURL: modelEntry.model.baseUrl
                });

                const completionBody: any = {
                    model: modelEntry.model.id,
                    messages: [{role: 'user', content: prompt}],
                    response_format: {type: 'json_object'},
                    temperature: 0
                };
                if (disableThinking) {
                    completionBody.thinking = {type: 'disabled'};
                }
                const response: any = await client.chat.completions.create(completionBody);

                // Debug dump memory query response
                if (this.config.input.debug_dump_prompt && this.debugPrefix) {
                    const dir = join('data', 'debug', this.debugPrefix);
                    mkdirSync(dir, {recursive: true});
                    writeFileSync(
                        join(dir, 'memory-query-response.json'),
                        JSON.stringify(response, null, 2), 'utf-8');
                }

                const text = response.choices[0]?.message?.content?.trim();
                if (!text) {
                    this.logger.debug(`[ReplyAgent] [${this.groupId}] memory query: empty response`);
                    return null;
                }

                try {
                    const parsed = JSON.parse(text);
                    const queries = Array.isArray(parsed.queries) ? parsed.queries.filter((q: unknown) => typeof q === 'string' && q.trim()) : [];
                    const entities = enableEntitySearch && Array.isArray(parsed.entities) ?
                        parsed.entities.filter((e: unknown) => typeof e === 'string' && e.trim()) :
                        [];

                    if (queries.length === 0 && entities.length === 0) {
                        this.logger.debug(`[ReplyAgent] [${this.groupId}] memory query: no queries or entities`);
                        return null;
                    }

                    this.logger.debug(`[ReplyAgent] [${this.groupId}] memory query: ${queries.length} queries, ${entities.length} entities`);
                    return {queries, entities};
                } catch {
                    this.logger.debug(`[ReplyAgent] [${this.groupId}] memory query: invalid JSON`);
                    return null;
                }
            } catch (err) {
                this.logger.error(
                    `[ReplyAgent] [${this.groupId}] memory query generation error ` +
                    `(model=${modelEntry.model.id}): ` +
                    `${err instanceof Error ? err.message : String(err)}`);
                if (index < modelEntries.length - 1) {
                    this.logger.warn(
                        `[ReplyAgent] [${this.groupId}] memory query falling back to model ${
                            modelEntries[index + 1].model.id}`);
                }
            }
        }

        return null;
    }

    private async searchMemories (queryParams: {queries: string[]; entities: string[]}): Promise<string> {
        if (!this.graphiti) return '';

        const groupName = `group-${this.groupId}`;
        const uniqueMemories = new Map<string, string | null>();

        // 搜索自然语言查询（事实）
        for (const query of queryParams.queries) {
            try {
                const results = await this.graphiti.search(query, groupName, 5);
                for (const e of results.results) {
                    if (!uniqueMemories.has(e.fact)) {
                        uniqueMemories.set(e.fact, e.valid_at);
                    }
                }
            } catch (err) {
                this.logger.error(`[ReplyAgent] [${this.groupId}] memory search error for query "${query}":`, err);
            }
        }

        const facts = Array.from(uniqueMemories.entries()).slice(0, 10);
        this.logger.debug(`[ReplyAgent] [${this.groupId}] found ${facts.length} relevant memories`);

        // 实体搜索关闭时，「--- 记忆自动检索 ---」不分节，仅注入事实列表
        if (!(this.config.ai.memoryKeyword?.enable_entity_search ?? false)) {
            return facts.map(([fact, validAt]) => {
                const timeInfo = validAt ? ` (${validAt.split('T')[0]})` : '';
                return `- ${fact}${timeInfo}`;
            }).join('\n');
        }

        // 搜索实体节点
        const uniqueEntities = new Map<string, string | null>();
        for (const entity of queryParams.entities) {
            try {
                const nodeResults = await this.graphiti.searchNodes(entity, groupName, 3);
                for (const node of nodeResults.nodes) {
                    if (!uniqueEntities.has(node.name)) {
                        uniqueEntities.set(node.name, node.summary);
                    }
                }
            } catch (err) {
                this.logger.error(`[ReplyAgent] [${this.groupId}] memory search error for entity "${entity}":`, err);
            }
        }

        const sections: string[] = [];
        if (facts.length > 0) {
            sections.push(
                `${prompts.memorySearchFactsHeader}\n${
                    facts.map(([fact, validAt]) => {
                        const timeInfo = validAt ? ` (${validAt.split('T')[0]})` : '';
                        return `- ${fact}${timeInfo}`;
                    }).join('\n')}`
            );
        }

        const entities = Array.from(uniqueEntities.entries()).slice(0, 10);
        if (entities.length > 0) {
            this.logger.debug(`[ReplyAgent] [${this.groupId}] found ${entities.length} relevant entities`);
            sections.push(
                `${prompts.memorySearchEntitiesHeader}\n${
                    entities.map(([name, summary]) => {
                        if (!summary) return `- ${name}`;
                        const trimmed = summary.length > 200 ? `${summary.slice(0, 200)}…` : summary;
                        return `- ${name}：${trimmed}`;
                    }).join('\n')}`
            );
        }

        return sections.join('\n\n');
    }

    /**
     * 从当前 session 分支中提取已注入的记忆事实。
     * 扫描所有 message entry 中 "记忆自动检索" 分割线之后的内容，
     * 提取以 "- " 开头的记忆条目，用于去重。
     */
    private async extractExistingMemories (): Promise<string[]> {
        const facts: string[] = [];
        try {
            const entries = await this.session.getBranch();
            for (const entry of entries) {
                if (entry.type !== 'message') continue;
                const msg = entry.message;
                if (msg.role !== 'user') continue;
                const text = typeof msg.content === 'string' ?
                    msg.content :
                    msg.content
                        .filter(c => c.type === 'text')
                        .map(c => c.text)
                        .join('');
                const separatorIdx = text.indexOf('--- 记忆自动检索 ---');
                if (separatorIdx === -1) continue;
                const memBlock = text.slice(separatorIdx + '--- 记忆自动检索 ---'.length);
                for (const line of memBlock.split('\n')) {
                    const trimmed = line.trim();
                    if (trimmed.startsWith('- ')) {
                        facts.push(trimmed);
                    }
                }
            }
        } catch {
            // ignore
        }
        return facts;
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
        this.debugPrefix = undefined;

        if (task.preResearchTopic) {
            await this.doDeepResearchWithSystemMessages(task.preResearchTopic);
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

        // 设置 debugPrefix，以便后续 dump 操作可以使用
        this.debugPrefix = this.createDebugPrefix(this.groupId, task.type);

        // 从最近 bot 回复中提取已有的记忆（去重），避免重复搜索
        const existingMemoryFacts = await this.extractExistingMemories();
        const queryParams = await this.generateMemoryQuery(userTexts.join('\n'), existingMemoryFacts);
        if (queryParams) {
            const memories = await this.searchMemories(queryParams);
            if (memories) {
                userTexts[userTexts.length - 1] += `${prompts.memorySearchSeparator}\n${memories}`;
            }
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
            const research = await this.doDeepResearchWithSystemMessages(topic);
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

        this.dumpSystemPrompt(this.debugPrefix, this.systemPromptText);
        const allTexts = [...appendTexts, promptText];
        for (let i = 0; i < allTexts.length; i++) {
            this.dumpUserMessage(this.debugPrefix, i, allTexts[i]);
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

        this.dumpOutput(this.debugPrefix, assistant);

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

    private async doDeepResearchWithSystemMessages (topic: string): Promise<{result: string; success: boolean}> {
        const researchTopic = topic.trim();
        const startTime = Math.floor(Date.now() / 1000);
        const startText = `开始深度研究：${researchTopic}`;
        const startId = await insertSystemMessage(this.db, this.groupId, startText, startTime);
        this.logger.info(
            `[ReplyAgent] [${this.groupId}] system message inserted, id=${startId}, ` +
            `text=${startText.slice(0, 50)}${startText.length > 50 ? '...' : ''}`);

        let researchResult: string | undefined;
        let researchError: string | undefined;

        try {
            researchResult = await this.doDeepResearch(researchTopic);
            this.logger.debug(`[ReplyAgent] [${this.groupId}] deep research done length=${researchResult.length}`);
            if (researchResult) {
                const resultTime = Math.floor(Date.now() / 1000);
                const resultText = `深度研究结果：${researchTopic}\n\n${researchResult}`;
                const resultId = await insertSystemMessage(this.db, this.groupId, resultText, resultTime);
                this.logger.info(
                    `[ReplyAgent] [${this.groupId}] deep research result message inserted, id=${resultId}, ` +
                    `topic=${researchTopic.slice(0, 50)}${researchTopic.length > 50 ? '...' : ''}`);

                // 深度研究结果也写入 Graphiti 记忆
                if (this.graphiti) {
                    const resultStored: StoredMessage = {
                        id: resultId,
                        time: resultTime,
                        messageId: 0,
                        senderId: 0,
                        senderName: '系统',
                        isBot: true,
                        isAtBot: false,
                        segments: [{type: 'system', text: resultText}]
                    };
                    addMessageEpisode(this.graphiti, this.groupId, resultStored,
                        sha => this.descQueue.resolve(sha));
                }
            } else {
                this.logger.error(`[ReplyAgent] [${this.groupId}] deep research returned empty result`);
                researchError = '深度研究未能获取结果';
                researchResult = '（深度研究未能获取结果，请根据你已有的知识直接回复。）';
            }
        } catch (err) {
            this.logger.error(`[ReplyAgent] [${this.groupId}] deep research failed:`, err);
            researchError = err instanceof Error ? err.message : String(err);
            researchResult = '（深度研究失败，请根据你已有的知识直接回复。）';
        } finally {
            const endTime = Math.floor(Date.now() / 1000);
            let endMsg: string;
            if (researchError) {
                endMsg = `深度研究结束：${researchTopic}状态：错误\n\n${researchError}`;
            } else if (researchResult) {
                endMsg = `深度研究结束：${researchTopic}状态：成功\n\n`;
            } else {
                endMsg = `深度研究结束：${researchTopic}状态：未出错但无结果\n\n`;
            }
            const endId = await insertSystemMessage(this.db, this.groupId, endMsg, endTime);
            this.logger.info(
                `[ReplyAgent] [${this.groupId}] system message inserted, id=${endId}, ` +
                `text=${endMsg.slice(0, 50)}${endMsg.length > 50 ? '...' : ''}`);
        }

        return {result: researchResult, success: researchError === undefined};
    }

    private async doDeepResearch (topic: string): Promise<string> {
        // 按回退链依次尝试：API 错误时切换下一个模型
        const modelEntries = resolveAssignmentModels(this.config, this.config.ai.assignments.deep_research);

        let lastError: unknown;
        for (const [index, modelEntry] of modelEntries.entries()) {
            try {
                return await this.completeDeepResearch(modelEntry, topic);
            } catch (err) {
                lastError = err;
                this.logger.error(
                    `[ReplyAgent] [${this.groupId}] deep research failed ` +
                    `(model=${modelEntry.model.id}):`, err);
                if (index < modelEntries.length - 1) {
                    this.logger.warn(
                        `[ReplyAgent] [${this.groupId}] deep research falling back to model ${
                            modelEntries[index + 1].model.id}`);
                }
            }
        }

        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    private async completeDeepResearch (modelEntry: ModelEntry, topic: string): Promise<string> {
        this.logger.debug(`[ReplyAgent] [${this.groupId}] doDeepResearch model=${modelEntry.model.name} topic=${topic}`);

        const context: Context = {
            messages: [{
                role: 'user',
                content: `${prompts.deepResearchSystem}\n请深度研究以下主题：\n${topic}`,
                timestamp: Date.now()
            }]
        };
        const dumpPrefix = this.dumpDeepResearchPrompt(context);

        let response: AssistantMessage | undefined;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 1_800_000);

            response = await this.models.completeSimple(modelEntry.model, context, {
                apiKey: modelEntry.apiKey,
                signal: controller.signal,
                timeoutMs: 1_800_000,
                onPayload: payload => {
                    this.dumpDeepResearchPayload(dumpPrefix, payload);
                }
            });

            clearTimeout(timeoutId);
            this.dumpDeepResearchConversation(context, response);

            if (response.stopReason === 'error' || response.stopReason === 'aborted') {
                throw new Error(response.errorMessage || `Deep research stopped: ${response.stopReason}`);
            }

            this.logger.info(`[ReplyAgent] [${this.groupId}] deep research usage: ${formatUsage(response.usage)}`);

            const text = extractText(response);
            this.logger.debug(`[ReplyAgent] [${this.groupId}] doDeepResearch done text length=${text.length}`);
            return text;
        } catch (err) {
            if (!response) {
                this.dumpDeepResearchConversation(context, undefined, err);
            }
            throw err;
        }
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

    // ==================== Debug Dump ====================

    private createDebugPrefix (groupId: number, label: string): string | undefined {
        if (!this.config.input.debug_dump_prompt) return;

        const ts = new Date().toISOString()
            .replace(/:/g, '-');
        return `${groupId}/${label}/${ts}`;
    }

    private dumpSystemPrompt (prefix: string | undefined, systemPrompt: string): void {
        if (!prefix) return;

        const dir = join('data', 'debug', prefix);
        mkdirSync(dir, {recursive: true});
        writeFileSync(join(dir, 'system.txt'), systemPrompt, 'utf-8');
    }

    private dumpUserMessage (prefix: string | undefined, index: number, text: string): void {
        if (!prefix) return;

        const dir = join('data', 'debug', prefix);
        mkdirSync(dir, {recursive: true});
        writeFileSync(join(dir, `user-${index}.txt`), text, 'utf-8');
    }

    private dumpOutput (prefix: string | undefined, assistant: AssistantMessage): void {
        if (!prefix) return;

        const dir = join('data', 'debug', prefix);
        mkdirSync(dir, {recursive: true});
        writeFileSync(
            join(dir, 'output.json'),
            JSON.stringify(assistant, null, 2),
            'utf-8'
        );
    }

    private dumpDeepResearchPrompt (context: Context): string | undefined {
        if (!this.config.input.debug_dump_prompt) return;

        const debugPrefix = this.debugPrefix || this.createDebugPrefix(this.groupId, 'deep-research');
        if (!debugPrefix) return;

        const dir = join('data', 'debug', debugPrefix);
        mkdirSync(dir, {recursive: true});

        if (context.systemPrompt) {
            writeFileSync(join(dir, 'deep-research-system.txt'), context.systemPrompt, 'utf-8');
        }
        writeFileSync(
            join(dir, 'deep-research-user.txt'),
            context.messages.map(msg => stringifyMessageContent(msg.content)).join('\n\n'),
            'utf-8'
        );
        writeFileSync(
            join(dir, 'deep-research-prompt.json'),
            JSON.stringify(context, null, 2),
            'utf-8'
        );

        this.logger.debug(
            `[ReplyAgent] [${this.groupId}] deep research prompt dumped to ` +
            `${debugPrefix}/deep-research-*`);

        return debugPrefix;
    }

    private dumpDeepResearchPayload (prefix: string | undefined, payload: unknown): void {
        if (!this.config.input.debug_dump_prompt || !prefix) return;

        const dir = join('data', 'debug', prefix);
        mkdirSync(dir, {recursive: true});

        const content = JSON.stringify(payload, null, 2);
        writeFileSync(join(dir, 'deep-research-payload.json'), content, 'utf-8');

        this.logger.debug(
            `[ReplyAgent] [${this.groupId}] deep research provider payload dumped to ` +
            `${prefix}/deep-research-payload.json (${content.length} chars)`);
    }

    private dumpDeepResearchConversation (
        context: Context,
        response?: AssistantMessage,
        error?: unknown,
    ): void {
        if (!this.config.input.debug_dump_prompt || !this.debugPrefix) return;

        const dir = join('data', 'debug', this.debugPrefix);
        mkdirSync(dir, {recursive: true});

        const messages = response ? [...context.messages, response] : context.messages;
        const content = JSON.stringify({
            systemPrompt: context.systemPrompt,
            messages,
            response,
            error: error instanceof Error ? {
                name: error.name,
                message: error.message,
                stack: error.stack
            } : error
        }, null, 2);

        writeFileSync(join(dir, 'deep-research-conversation.json'), content, 'utf-8');

        this.logger.debug(
            `[ReplyAgent] [${this.groupId}] deep research conversation dumped to ` +
            `${this.debugPrefix}/deep-research-conversation.json (${content.length} chars)`);
    }
}

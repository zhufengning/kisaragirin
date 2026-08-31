import {AgentHarness, type AgentMessage, type AgentTool, type Session} from '@earendil-works/pi-agent-core';
import {NodeExecutionEnv} from '@earendil-works/pi-agent-core/node';
import {type AssistantMessage, type Context, type Models} from '@earendil-works/pi-ai';
import {schema, type Db, type JsonlSessionMetadata, insertSystemMessage, setGroupLastTriggerId} from '~/db';
import type {AppConfig} from '~/config';
import {eq, asc, and, or, gt, gte, lte, ne, desc} from 'drizzle-orm';
import type {DescQueue} from './desc-queue';
import type {ReplyTask} from './reply-manager';
import {messagesToString, type StoredMessage} from '~/message-format';
import {prompts} from '~/prompts';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Logger} from '@lib/util/logger';
import {getOrCreateGroupSession} from './harness-factory';
import {resolveAssignmentModel} from './models-factory';
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

export interface ReplyTurn {
    text: ReplyMessageItem[];
    isDeepResearchFinal?: boolean;
    /** 本轮实际读入 prompt 的最大数据库消息 id，用于推进 lastTriggerId */
    processedUpToId?: number;
}

export interface FirstTurnResult {
    text: ReplyMessageItem[];
    requiresDeepResearch: boolean;
    deepResearchTopic?: string;
    failed?: boolean;
    /** 无新消息可处理（已被前序任务吸收），调用方应静默跳过，不视为失败 */
    noop?: boolean;
    /** 已写入 harness session 的最大数据库消息 id，失败时用于推进 lastTriggerId 避免重复发送 */
    processedUpToId?: number;
}

export interface GenerateReplyResult {
    turns: ReplyTurn[];
    failed?: boolean;
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
    private taskType: ReplyTask['type'] = 'silence';
    private systemPromptText: string;
    private debugPrefix?: string;
    private lastReplyToolParams: ReplyToolParams | null = null;
    private toolCallRoundCount = 0;
    private graphiti: GraphitiClient | null = null;

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

        const harnessEntry = resolveAssignmentModel(config, config.ai.assignments.agent_harness);
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

        const agent = new ReplyAgent({
            db,
            descQueue,
            config,
            models,
            groupId,
            session,
            harness,
            systemPromptText: systemPrompt(),
            graphiti: graphitiInstance
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

        try {
            const modelEntry = resolveAssignmentModel(this.config, this.config.ai.assignments.memory_keyword);
            const existingBlock = existingMemories.length > 0 ?
                existingMemories.join('\n') :
                '（无）';
            const prompt = prompts.memoryQueryPrompt
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

            // 使用 OpenAI SDK 调用模型
            const client = new OpenAI({
                apiKey: modelEntry.apiKey,
                baseURL: modelEntry.model.baseUrl
            });

            const response = await client.chat.completions.create({
                model: modelEntry.model.id,
                messages: [{role: 'user', content: prompt}],
                response_format: {type: 'json_object'},
                temperature: 0,
                max_tokens: 1000
            });

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
                const entities = Array.isArray(parsed.entities) ? parsed.entities.filter((e: unknown) => typeof e === 'string' && e.trim()) : [];

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
                `[ReplyAgent] [${this.groupId}] memory query generation error: ` +
                `${err instanceof Error ? err.message : String(err)}`);
            return null;
        }
    }

    private async searchMemories (queryParams: {queries: string[]; entities: string[]}): Promise<string[]> {
        if (!this.graphiti) return [];

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

        // 搜索实体节点
        for (const entity of queryParams.entities) {
            try {
                const nodeResults = await this.graphiti.searchNodes(entity, groupName, 3);
                // 对于每个找到的实体，搜索相关的事实
                for (const node of nodeResults.nodes) {
                    if (node.uuid) {
                        // 使用实体名称作为查询搜索相关事实
                        const factResults = await this.graphiti.search(node.name, groupName, 3);
                        for (const e of factResults.results) {
                            if (!uniqueMemories.has(e.fact)) {
                                uniqueMemories.set(e.fact, e.valid_at);
                            }
                        }
                    }
                }
            } catch (err) {
                this.logger.error(`[ReplyAgent] [${this.groupId}] memory search error for entity "${entity}":`, err);
            }
        }

        const sorted = Array.from(uniqueMemories.entries()).slice(0, 10);
        this.logger.debug(`[ReplyAgent] [${this.groupId}] found ${sorted.length} relevant memories`);
        return sorted.map(([fact, validAt]) => {
            const timeInfo = validAt ? ` (${validAt.split('T')[0]})` : '';
            return `- ${fact}${timeInfo}`;
        });
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

    async generateFirstTurn (task: ReplyTask): Promise<FirstTurnResult> {
        this.taskType = task.type;
        this.lastReplyToolParams = null;
        this.toolCallRoundCount = 0;
        this.debugPrefix = undefined;

        if (task.preResearchTopic) {
            await this.doDeepResearchWithSystemMessages(task.preResearchTopic);
        }

        const latestMessages = await this.fetchMessagesSince(task.lastTriggerId ?? 0);
        const userTexts = await buildUserPromptArray(latestMessages, this.descQueue);

        if (userTexts.length === 0) {
            this.logger.info(
                `[ReplyAgent] [${this.groupId}] no new messages to process, skipping (noop)`);
            return {text: [], requiresDeepResearch: false, noop: true};
        }

        const processedUpToId = latestMessages[latestMessages.length - 1]?.id;

        // 保存原始 userTexts（不包括记忆搜索结果），用于记忆添加
        const originalUserTexts = [...userTexts];

        // 设置 debugPrefix，以便后续 dump 操作可以使用
        this.debugPrefix = this.createDebugPrefix(this.groupId, task.type);

        // 从最近 bot 回复中提取已有的记忆（去重），避免重复搜索
        const existingMemoryFacts = await this.extractExistingMemories();
        const queryParams = await this.generateMemoryQuery(userTexts.join('\n'), existingMemoryFacts);
        if (queryParams) {
            const memories = await this.searchMemories(queryParams);
            if (memories.length > 0) {
                userTexts[userTexts.length - 1] += prompts.memorySearchSeparator + memories.join('\n');
            }
        }

        this.dumpSystemPrompt(this.debugPrefix, this.systemPromptText);
        for (let i = 0; i < userTexts.length; i++) {
            this.dumpUserMessage(this.debugPrefix, i, userTexts[i]);
        }

        for (let i = 0; i < userTexts.length - 1; i++) {
            await this.harness.appendMessage({
                role: 'user',
                content: [{type: 'text', text: userTexts[i]}],
                timestamp: Date.now()
            } as AgentMessage);
        }

        let assistant: AssistantMessage | undefined;
        try {
            assistant = await this.promptWithReminders(userTexts[userTexts.length - 1]);
        } catch (err) {
            this.logger.error(
                `[ReplyAgent] [${this.groupId}] first turn prompt threw: ` +
                `${err instanceof Error ? err.message : String(err)}`);
        }

        if (!assistant || assistant.stopReason === 'error' || assistant.stopReason === 'aborted') {
            this.logger.error(
                `[ReplyAgent] [${this.groupId}] first turn failed ` +
                `(stopReason=${assistant?.stopReason ?? 'undefined'})`);
            return {text: [], requiresDeepResearch: false, failed: true, processedUpToId};
        }

        this.dumpOutput(this.debugPrefix, assistant);

        const params = this.getReplyToolParams();
        if (!params || params.messages.length === 0 || !params.messages.some(m => m.text.trim())) {
            this.logger.warn(`[ReplyAgent] [${this.groupId}] first turn missing reply tool, fallback`);
            return {text: [], requiresDeepResearch: false, failed: true, processedUpToId};
        }

        // 异步添加合并后的消息记忆（不阻塞回复流程）
        if (this.graphiti) {
            const mergedContent = originalUserTexts.join('\n');
            const messageIds = latestMessages.map(m => m.id).filter((id): id is number => id !== undefined);
            addMergedMessagesEpisode(this.graphiti, this.groupId, mergedContent, messageIds);
        }

        return {
            text: params.messages,
            requiresDeepResearch: params.requires_deep_research,
            deepResearchTopic: params.deep_research_topic,
            failed: false,
            processedUpToId
        };
    }

    async generateFinalTurn (task: ReplyTask, topic: string, lastTriggerId: number): Promise<ReplyTurn> {
        const researchTopic = topic.trim() || String(task.triggerMessage);
        try {
            await this.doDeepResearchWithSystemMessages(researchTopic);
        } catch (err) {
            this.logger.error(`[ReplyAgent] [${this.groupId}] deep research failed:`, err);
        }

        const latestMessages = await this.fetchMessagesSince(lastTriggerId);
        const userTexts = await buildUserPromptArray(latestMessages, this.descQueue);
        const processedUpToId = latestMessages[latestMessages.length - 1]?.id;

        for (const text of userTexts) {
            await this.harness.appendMessage({
                role: 'user',
                content: [{type: 'text', text}],
                timestamp: Date.now()
            } as AgentMessage);
        }

        let finalAssistant: AssistantMessage | undefined;
        try {
            finalAssistant = await this.promptWithReminders('请根据深度研究结果，使用 reply 工具给出最终回复。');
        } catch (err) {
            this.logger.error(
                `[ReplyAgent] [${this.groupId}] deep research final turn prompt threw: ` +
                `${err instanceof Error ? err.message : String(err)}`);
        }

        if (!finalAssistant || finalAssistant.stopReason === 'error' || finalAssistant.stopReason === 'aborted') {
            this.logger.error(
                `[ReplyAgent] [${this.groupId}] deep research final turn failed ` +
                `(stopReason=${finalAssistant?.stopReason ?? 'undefined'})`);
            return {text: [{text: '深度研究失败'}], isDeepResearchFinal: true, processedUpToId};
        }

        this.dumpOutput(this.debugPrefix, finalAssistant);

        const finalParams = this.getReplyToolParams();
        if (!finalParams || finalParams.messages.length === 0 || !finalParams.messages.some(m => m.text.trim())) {
            this.logger.warn(`[ReplyAgent] [${this.groupId}] deep research final turn missing reply tool, fallback`);
            return {text: [{text: '深度研究失败'}], isDeepResearchFinal: true, processedUpToId};
        }

        return {text: finalParams.messages, isDeepResearchFinal: true, processedUpToId};
    }

    async generateReply (task: ReplyTask): Promise<GenerateReplyResult> {
        const first = await this.generateFirstTurn(task);
        if (first.noop) {
            return {turns: []};
        }
        if (first.failed || first.text.length === 0) {
            return {turns: first.failed ? [{text: this.taskType === 'at' ? [{text: '@响应失败'}] : []}] : [], failed: true};
        }

        const turns: ReplyTurn[] = [{text: first.text}];
        if (!first.requiresDeepResearch) {
            return {turns};
        }

        const topic = first.deepResearchTopic || first.text.map(m => m.text).join('');
        const finalTurn = await this.generateFinalTurn(task, topic, task.lastTriggerId ?? 0);
        turns.push(finalTurn);
        const finalFailed = finalTurn.text.length === 0 || finalTurn.text.every(m => !m.text.trim());
        return {turns, failed: finalFailed || finalTurn.text.some(m => m.text === '深度研究失败')};
    }

    private async promptWithReminders (lastText: string): Promise<AssistantMessage | undefined> {
        let assistant: AssistantMessage | undefined;
        const MAX_REMINDERS = 2;

        for (let i = 0; i <= MAX_REMINDERS; i++) {
            this.lastReplyToolParams = null;
            if (i === 0) {
                assistant = await this.harness.prompt(lastText);
            } else {
                this.logger.info(
                    `[ReplyAgent] [${this.groupId}] sending reminder ${i}/${MAX_REMINDERS}...`);
                assistant = await this.harness.prompt(prompts.replyReminder());
            }

            if (!assistant) {
                continue;
            }
            this.logger.info(`[ReplyAgent] [${this.groupId}] turn usage: ${formatUsage(assistant.usage)}`);
            if (assistant.stopReason === 'error' || assistant.stopReason === 'aborted') {
                return assistant;
            }
            if (this.getReplyToolParams()?.messages.some(m => m.text.trim())) {
                return assistant;
            }
        }

        return assistant;
    }

    private fallbackResult (): GenerateReplyResult {
        if (this.taskType === 'at') {
            return {turns: [{text: [{text: '@响应失败'}]}], failed: true};
        }
        return {turns: [], failed: true};
    }

    private async doDeepResearchWithSystemMessages (topic: string): Promise<string> {
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

        return researchResult;
    }

    private async doDeepResearch (topic: string): Promise<string> {
        const modelEntry = resolveAssignmentModel(this.config, this.config.ai.assignments.deep_research);
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

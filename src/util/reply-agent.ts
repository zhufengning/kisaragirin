import {AgentHarness, type AgentMessage, type AgentTool, type Session} from '@earendil-works/pi-agent-core';
import {NodeExecutionEnv} from '@earendil-works/pi-agent-core/node';
import {type AssistantMessage, type Context, type Models} from '@earendil-works/pi-ai';
import {Memory, type MemoryConfig} from 'mem0ai/oss';
import {schema, type Db, type JsonlSessionMetadata, insertSystemMessage, setGroupLastTriggerId} from '~/db';
import type {AppConfig} from '~/config';
import {eq, asc, and, gt, gte, lte, ne, desc} from 'drizzle-orm';
import type {DescQueue} from './desc-queue';
import type {ReplyTask} from './reply-manager';
import {messagesToString, type StoredMessage} from '~/message-format';
import {prompts} from '~/prompts';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Logger} from '@lib/util/logger';
import {getOrCreateGroupSession} from './harness-factory';
import {resolveModelEntry} from './models-factory';
import {createReplyTool, type ReplyToolParams, type ReplyMessageItem} from './reply-tool';
import {createMem0Tools} from './mem0-tool';

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
}

export interface FirstTurnResult {
    text: ReplyMessageItem[];
    requiresDeepResearch: boolean;
    deepResearchTopic?: string;
    failed?: boolean;
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
    private memory: Memory | null = null;

    private constructor (options: {
        db: Db;
        descQueue: DescQueue;
        config: AppConfig;
        models: Models;
        groupId: number;
        session: Session<JsonlSessionMetadata>;
        harness: AgentHarness;
        systemPromptText: string;
        memory: Memory | null;
    }) {
        this.db = options.db;
        this.descQueue = options.descQueue;
        this.config = options.config;
        this.models = options.models;
        this.groupId = options.groupId;
        this.session = options.session;
        this.harness = options.harness;
        this.systemPromptText = options.systemPromptText;
        this.memory = options.memory;
        this.logger = new Logger();
    }

    static async create (options: {
        groupId: number;
        db: Db;
        descQueue: DescQueue;
        config: AppConfig;
        models: Models;
        memory?: MemoryConfig | null;
    }): Promise<ReplyAgent> {
        const {groupId, db, descQueue, config, models, memory} = options;

        const logger = new Logger();
        const {session, isNew} = await getOrCreateGroupSession(groupId, config, db);

        const harnessEntry = resolveModelEntry(config, config.ai.assignments.agent_harness);
        const env = new NodeExecutionEnv({cwd: process.cwd()});

        const agentRef: {current: ReplyAgent | null} = {current: null};

        const replyTool = createReplyTool({
            onCalled: params => {
                agentRef.current!.lastReplyToolParams = params;
            }
        });

        const mem0Tools: AgentTool[] = memory ? createMem0Tools(memory, config.log.level, groupId) : [];
        const tools: AgentTool[] = [replyTool, ...mem0Tools];

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

        const memoryInstance = memory ? new Memory(memory) : null;

        const agent = new ReplyAgent({
            db,
            descQueue,
            config,
            models,
            groupId,
            session,
            harness,
            systemPromptText: systemPrompt(),
            memory: memoryInstance
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
        const rows = await this.db
            .select()
            .from(schema.messages)
            .where(
                lastTriggerId > 0 ?
                    and(
                        eq(schema.messages.groupId, this.groupId),
                        gt(schema.messages.id, lastTriggerId)
                    ) :
                    eq(schema.messages.groupId, this.groupId)
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

    private async generateMemoryKeywords (messagesText: string): Promise<string[]> {
        if (!this.config.ai.assignments.memory_keyword) return [];

        try {
            const modelEntry = resolveModelEntry(this.config, this.config.ai.assignments.memory_keyword);
            const context: Context = {
                messages: [{
                    role: 'user',
                    content: `${prompts.memoryKeywordPrompt}\n\n${messagesText}`,
                    timestamp: Date.now()
                }]
            };

            const response = await this.models.completeSimple(modelEntry.model, context, {
                apiKey: modelEntry.apiKey,
                timeoutMs: 30000
            });

            if (response.stopReason === 'error' || response.stopReason === 'aborted') {
                this.logger.warn(
                    `[ReplyAgent] [${this.groupId}] memory keyword generation failed: ` +
                    `stopReason=${response.stopReason} error=${response.errorMessage ?? 'none'}`);
                return [];
            }

            const text = response.content
                .filter((c): c is Extract<typeof c, {type: 'text'}> => c.type === 'text')
                .map(c => c.text)
                .join('')
                .trim();

            const keywords = text.split('\n')
                .map(k => k.trim())
                .filter(k => k.length > 0);
            this.logger.debug(`[ReplyAgent] [${this.groupId}] memory keywords: ${keywords.join(', ')}`);
            return keywords;
        } catch (err) {
            this.logger.error(
                `[ReplyAgent] [${this.groupId}] memory keyword generation error: ` +
                `${err instanceof Error ? err.message : String(err)}`);
            return [];
        }
    }

    private async searchMemories (keywords: string[]): Promise<string[]> {
        if (!this.memory || keywords.length === 0) return [];

        const userId = `group-${this.groupId}`;
        const allResults: Array<{memory: string; score: number}> = [];

        for (const keyword of keywords) {
            try {
                const results = await this.memory.search(keyword, {topK: 5, filters: {user_id: userId}});
                for (const r of results.results) {
                    allResults.push({memory: r.memory, score: r.score ?? 0});
                }
            } catch (err) {
                this.logger.error(`[ReplyAgent] [${this.groupId}] memory search error for "${keyword}":`, err);
            }
        }

        const uniqueMemories = new Map<string, number>();
        for (const r of allResults) {
            const existing = uniqueMemories.get(r.memory);
            if (!existing || r.score > existing) {
                uniqueMemories.set(r.memory, r.score);
            }
        }

        const sorted = Array.from(uniqueMemories.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);

        this.logger.debug(`[ReplyAgent] [${this.groupId}] found ${sorted.length} relevant memories`);
        return sorted.map(([memory, score]) => `- ${memory} (相关度: ${(score * 100).toFixed(1)}%)`);
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
            return {text: [], requiresDeepResearch: false, failed: true};
        }

        const processedUpToId = latestMessages[latestMessages.length - 1]?.id;

        const keywords = await this.generateMemoryKeywords(userTexts.join('\n'));
        const memories = await this.searchMemories(keywords);
        if (memories.length > 0) {
            userTexts[userTexts.length - 1] += prompts.memorySearchSeparator + memories.join('\n');
        }

        this.debugPrefix = this.createDebugPrefix(this.groupId, task.type);
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

        return {
            text: params.messages,
            requiresDeepResearch: params.requires_deep_research,
            deepResearchTopic: params.deep_research_topic,
            failed: false
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
            return {text: [{text: '深度研究失败'}], isDeepResearchFinal: true};
        }

        this.dumpOutput(this.debugPrefix, finalAssistant);

        const finalParams = this.getReplyToolParams();
        if (!finalParams || finalParams.messages.length === 0 || !finalParams.messages.some(m => m.text.trim())) {
            this.logger.warn(`[ReplyAgent] [${this.groupId}] deep research final turn missing reply tool, fallback`);
            return {text: [{text: '深度研究失败'}], isDeepResearchFinal: true};
        }

        return {text: finalParams.messages, isDeepResearchFinal: true};
    }

    async generateReply (task: ReplyTask): Promise<GenerateReplyResult> {
        const first = await this.generateFirstTurn(task);
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
        const modelEntry = resolveModelEntry(this.config, this.config.ai.assignments.deep_research);
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
        return `${groupId}-${label}-${ts}`;
    }

    private dumpSystemPrompt (prefix: string | undefined, systemPrompt: string): void {
        if (!prefix) return;

        const dir = join('data', 'debug');
        mkdirSync(dir, {recursive: true});
        writeFileSync(join(dir, `${prefix}-system.txt`), systemPrompt, 'utf-8');
    }

    private dumpUserMessage (prefix: string | undefined, index: number, text: string): void {
        if (!prefix) return;

        const dir = join('data', 'debug');
        mkdirSync(dir, {recursive: true});
        writeFileSync(join(dir, `${prefix}-user-${index}.txt`), text, 'utf-8');
    }

    private dumpOutput (prefix: string | undefined, assistant: AssistantMessage): void {
        if (!prefix) return;

        const dir = join('data', 'debug');
        mkdirSync(dir, {recursive: true});
        writeFileSync(
            join(dir, `${prefix}-output.json`),
            JSON.stringify(assistant, null, 2),
            'utf-8'
        );
    }

    private dumpDeepResearchPrompt (context: Context): string | undefined {
        if (!this.config.input.debug_dump_prompt) return;

        const debugPrefix = this.debugPrefix || this.createDebugPrefix(this.groupId, 'deep-research');
        if (!debugPrefix) return;

        const dir = join('data', 'debug');
        mkdirSync(dir, {recursive: true});

        if (context.systemPrompt) {
            writeFileSync(join(dir, `${debugPrefix}-deep-research-system.txt`), context.systemPrompt, 'utf-8');
        }
        writeFileSync(
            join(dir, `${debugPrefix}-deep-research-user.txt`),
            context.messages.map(msg => stringifyMessageContent(msg.content)).join('\n\n'),
            'utf-8'
        );
        writeFileSync(
            join(dir, `${debugPrefix}-deep-research-prompt.json`),
            JSON.stringify(context, null, 2),
            'utf-8'
        );

        this.logger.debug(
            `[ReplyAgent] [${this.groupId}] deep research prompt dumped to ` +
            `${debugPrefix}-deep-research-*`);

        return debugPrefix;
    }

    private dumpDeepResearchPayload (prefix: string | undefined, payload: unknown): void {
        if (!this.config.input.debug_dump_prompt || !prefix) return;

        const dir = join('data', 'debug');
        mkdirSync(dir, {recursive: true});

        const content = JSON.stringify(payload, null, 2);
        writeFileSync(join(dir, `${prefix}-deep-research-payload.json`), content, 'utf-8');

        this.logger.debug(
            `[ReplyAgent] [${this.groupId}] deep research provider payload dumped to ` +
            `${prefix}-deep-research-payload.json (${content.length} chars)`);
    }

    private dumpDeepResearchConversation (
        context: Context,
        response?: AssistantMessage,
        error?: unknown,
    ): void {
        if (!this.config.input.debug_dump_prompt || !this.debugPrefix) return;

        const dir = join('data', 'debug');
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

        writeFileSync(join(dir, `${this.debugPrefix}-deep-research-conversation.json`), content, 'utf-8');

        this.logger.debug(
            `[ReplyAgent] [${this.groupId}] deep research conversation dumped to ` +
            `${this.debugPrefix}-deep-research-conversation.json (${content.length} chars)`);
    }
}

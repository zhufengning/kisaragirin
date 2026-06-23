import {Agent, type AgentTool, type AgentMessage} from '@earendil-works/pi-agent-core';
import {Type, type AssistantMessage, type Usage, complete} from '@earendil-works/pi-ai';
import OpenAI from 'openai';
import {Memory} from 'mem0ai/oss';
import {schema, type Db, kvGet, kvSet} from '~/db';
import type {AppConfig, ModelEntry} from '~/config';
import {eq, desc, and, gte} from 'drizzle-orm';
import type {DescQueue} from './desc-queue';
import type {ReplyTask} from './reply-manager';
import {messagesToString, type StoredMessage, type StoredSegment} from '~/message-format';
import {prompts} from '~/prompts';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Logger} from '@lib/util/logger';
import {createMem0Tools} from './mem0-tool';

const replyFirstTurnSchema = Type.Object({
    immediate_reply: Type.String(),
    action: Type.String({enum: ['FINISH', 'DEEP_RESEARCH']}),
    deep_research_keyword: Type.Optional(Type.String())
});

type ReplyFirstTurnArgs = {
    immediate_reply: string;
    action: 'FINISH' | 'DEEP_RESEARCH';
    deep_research_keyword?: string;
};

const replySecondTurnSchema = Type.Object({
    final_reply: Type.String()
});

type ReplySecondTurnArgs = {
    final_reply: string;
};

export interface FirstTurnResult {
    texts: string[];
    secondTurnPromise?: Promise<string[]>;
}

interface UsageAnchor {
    totalTokens: number;
    time: number;
    compactId?: number;
}

interface SecondTurnContext {
    messages: AgentMessage[];
    firstTurnArgs: ReplyFirstTurnArgs;
    systemPrompt: string;
    modelEntry: ModelEntry;
    mem0Tools: AgentTool[];
    taskType: 'at' | 'silence';
}

function extractText (response: AssistantMessage): string {
    return response.content
        .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
        .map(c => c.text)
        .join('')
        .trim();
}

function parseKeywordJson (text: string): string[] {
    const cleaned = text.trim();
    let parsed: unknown;
    try {
        parsed = JSON.parse(cleaned);
    } catch {
        const start = cleaned.indexOf('[');
        const end = cleaned.lastIndexOf(']');
        if (start !== -1 && end !== -1 && end > start) {
            try {
                parsed = JSON.parse(cleaned.slice(start, end + 1));
            } catch {
                return [];
            }
        } else {
            return [];
        }
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
}

function calculateCacheStats (messages: AgentMessage[]) {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let totalTokens = 0;

    for (const msg of messages) {
        if (msg.role === 'assistant') {
            const usage = msg.usage;
            if (usage) {
                input += usage.input;
                output += usage.output;
                cacheRead += usage.cacheRead;
                cacheWrite += usage.cacheWrite;
                totalTokens += usage.totalTokens;
            }
        }
    }

    const promptTokens = input + cacheRead + cacheWrite;
    const cacheHitRate = promptTokens > 0 ? (cacheRead / promptTokens * 100).toFixed(2) : '0.00';

    return {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens,
        promptTokens,
        cacheHitRate
    };
}

function getLastAssistant (agent: Agent): AssistantMessage | undefined {
    const messages = agent.state.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === 'assistant') {
            return msg as AssistantMessage;
        }
    }
    return;
}

function isFirstTurnEmpty (result: ReplyFirstTurnArgs | null): boolean {
    return !result || !result.immediate_reply.trim();
}

function isSecondTurnEmpty (result: ReplySecondTurnArgs | null): boolean {
    return !result || !result.final_reply.trim();
}

const OVERFLOW_PATTERNS = [
    /prompt is too long/i,
    /request_too_large/i,
    /input is too long for requested model/i,
    /exceeds the context window/i,
    /exceeds (?:the )?(?:model'?s )?maximum context length of [\d,]+ tokens?/i,
    /input token count.*exceeds the maximum/i,
    /maximum prompt length is \d+/i,
    /reduce the length of the messages/i,
    /maximum context length is \d+ tokens/i,
    /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
    /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
    /exceeds the limit of \d+/i,
    /exceeds the available context size/i,
    /greater than the context length/i,
    /context window exceeds limit/i,
    /exceeded model token limit/i,
    /too large for model with \d+ maximum context length/i,
    /model_context_window_exceeded/i,
    /prompt too long; exceeded (?:max )?context length/i,
    /context[_ ]length[_ ]exceeded/i,
    /too many tokens/i,
    /token limit exceeded/i,
    /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i
];

const NON_OVERFLOW_PATTERNS = [
    /^(Throttling error|Service unavailable):/i,
    /rate limit/i,
    /too many requests/i
];

function calculateBaselineTokens (usage: Usage): number {
    return usage.input + usage.cacheRead + usage.cacheWrite;
}

function isContextOverflow (message: AssistantMessage, contextWindow?: number): boolean {
    if (message.stopReason === 'error' && message.errorMessage) {
        const isNonOverflow = NON_OVERFLOW_PATTERNS.some(p => p.test(message.errorMessage!));
        if (!isNonOverflow && OVERFLOW_PATTERNS.some(p => p.test(message.errorMessage!))) {
            return true;
        }
    }
    if (contextWindow && message.stopReason === 'stop') {
        const inputTokens = message.usage.input + message.usage.cacheRead;
        if (inputTokens > contextWindow) {
            return true;
        }
    }
    if (contextWindow && message.stopReason === 'length' && message.usage.output === 0) {
        const inputTokens = message.usage.input + message.usage.cacheRead;
        if (inputTokens >= contextWindow * 0.99) {
            return true;
        }
    }
    return false;
}

export class ReplyAgent {
    private db: Db;
    private descQueue: DescQueue;
    private config: AppConfig;
    private logger: Logger;
    private firstTurnArgs: ReplyFirstTurnArgs | null = null;
    private systemPrompt: string = '';
    private modelEntry: ModelEntry | null = null;
    private mem0Tools: AgentTool[] = [];
    private taskType: 'at' | 'silence' = 'silence';
    private agent: Agent | null = null;

    constructor (db: Db, descQueue: DescQueue, config: AppConfig) {
        this.db = db;
        this.descQueue = descQueue;
        this.config = config;
        this.logger = new Logger();
    }

    // ==================== Auto Compact ====================

    private estimateSegmentTokens (seg: StoredSegment): number {
        switch (seg.type) {
        case 'text':
            return Math.ceil(seg.text.length / 4);
        case 'at':
            return Math.ceil((seg.targetName || seg.target).length / 4) + 2;
        case 'image':
            return 1200;
        case 'face':
            return 3;
        case 'record':
            return 5;
        case 'video':
            return Math.ceil((seg.fileName || '').length / 4) + 5;
        case 'file':
            return Math.ceil(seg.fileName.length / 4) + 5;
        case 'json':
            return Math.ceil((seg.data || '').length / 4);
        case 'poke':
            return 5;
        case 'dice':
        case 'rps':
            return 3;
        case 'reply':
            if (seg.message) {
                return this.estimateMessageTokens(seg.message);
            }
            return 5;
        case 'forward':
            if (seg.messages) {
                return seg.messages.reduce((sum, m) => sum + this.estimateMessageTokens(m), 0);
            }
            return 5;
        case 'compact':
        case 'system':
            return Math.ceil(seg.text.length / 4) + 5;
        default:
            return 0;
        }
    }

    private estimateMessageTokens (msg: StoredMessage): number {
        const segmentTokens = msg.segments.reduce((sum, seg) => sum + this.estimateSegmentTokens(seg), 0);
        const senderName = msg.senderCard || msg.senderName || '';
        const senderTokens = Math.ceil(senderName.length / 4) + 4;
        return segmentTokens + senderTokens + 4;
    }

    private estimateMessagesTokens (messages: StoredMessage[]): number {
        return messages.reduce((sum, msg) => sum + this.estimateMessageTokens(msg), 0);
    }

    private async loadUsageAnchor (groupId: number): Promise<UsageAnchor | undefined> {
        const raw = await kvGet(this.db, `group:${groupId}:lastUsageAnchor`);
        if (!raw) return;
        try {
            return JSON.parse(raw) as UsageAnchor;
        } catch {
            return;
        }
    }

    private async saveUsageAnchor (groupId: number, anchor: UsageAnchor): Promise<void> {
        await kvSet(this.db, `group:${groupId}:lastUsageAnchor`, JSON.stringify(anchor));
    }

    private async estimateContextTokens (groupId: number, messages: StoredMessage[]): Promise<number> {
        const anchor = await this.loadUsageAnchor(groupId);
        if (!anchor) {
            return this.estimateMessagesTokens(messages);
        }

        const lastCompactIdStr = await kvGet(this.db, `group:${groupId}:lastCompactId`);
        const lastCompactId = lastCompactIdStr ? parseInt(lastCompactIdStr, 10) : void 0;
        if (typeof anchor.compactId !== 'undefined' && anchor.compactId !== lastCompactId) {
            return this.estimateMessagesTokens(messages);
        }

        let anchorIndex = -1;
        for (let i = 0; i < messages.length; i++) {
            if (messages[i].time >= anchor.time) {
                anchorIndex = i;
                break;
            }
        }
        if (anchorIndex === -1) {
            return this.estimateMessagesTokens(messages);
        }

        let trailingTokens = 0;
        for (let i = anchorIndex + 1; i < messages.length; i++) {
            trailingTokens += this.estimateMessageTokens(messages[i]);
        }

        return anchor.totalTokens + trailingTokens;
    }

    private async shouldCompact (messages: StoredMessage[], contextWindow: number, groupId: number): Promise<boolean> {
        const threshold = this.config.input.auto_compact_threshold;
        const reserveTokens = this.config.input.auto_compact_reserve_tokens;
        const tokens = await this.estimateContextTokens(groupId, messages);
        const limit = Math.floor((contextWindow - reserveTokens) * threshold);
        this.logger.debug(
            `[ReplyAgent] compact check: ${tokens} tokens vs limit ${limit} ` +
            `(window ${contextWindow}, threshold ${threshold})`);
        return tokens > limit;
    }

    private async generateCompactSummary (messages: StoredMessage[]): Promise<string> {
        // Direct DB query for image descriptions, bypassing DescQueue to avoid hanging
        const prompt = await messagesToString(messages, async (sha256: string) => {
            const rows = await this.db
                .select()
                .from(schema.images)
                .where(eq(schema.images.sha256, sha256));
            return rows[0]?.description ?? void 0;
        });
        const modelEntry = this.config.ai.models[this.config.ai.assignments.deep_research];
        if (!modelEntry) throw new Error('Deep research model not configured');

        this.logger.info(
            `[ReplyAgent] generating compact summary, ` +
            `prompt length=${prompt.length}, messages=${messages.length}`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 300000);

        try {
            const response = await complete(
                modelEntry.model,
                {
                    systemPrompt: prompts.compactSummarySystem,
                    messages: [{role: 'user', content: prompt, timestamp: Date.now()}]
                },
                {apiKey: modelEntry.apiKey, signal: controller.signal, timeoutMs: 300000}
            );

            clearTimeout(timeoutId);

            const text = response.content
                .filter((c): c is {type: 'text'; text: string} => c.type === 'text')
                .map(c => c.text)
                .join('\n')
                .trim();

            const usage = response.usage;
            const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
            const cacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens * 100).toFixed(2) : '0.00';
            this.logger.info(
                `[ReplyAgent] compact summary generated, length=${text.length}, ` +
                `cacheHitRate=${cacheHitRate}%, promptTokens=${promptTokens}, ` +
                `outputTokens=${usage.output}, cacheRead=${usage.cacheRead}, ` +
                `cacheWrite=${usage.cacheWrite}, totalTokens=${usage.totalTokens}`);
            return text;
        } catch (err) {
            clearTimeout(timeoutId);
            this.logger.error(`[ReplyAgent] compact summary failed:`, err);
            throw err;
        }
    }

    private async insertCompactMessage (
        groupId: number, summary: string, time: number,
    ): Promise<number> {
        const rows = await this.db.insert(schema.messages).values({
            messageId: 0,
            groupId,
            userId: 0,
            time,
            senderName: '系统',
            senderCard: null,
            isBot: true,
            isAtBot: false,
            specialType: 'compact',
            segments: [{type: 'compact', text: summary}] as StoredSegment[],
            rawMessage: summary
        })
            .returning({id: schema.messages.id});

        const compactId = rows[0].id;
        await kvSet(this.db, `group:${groupId}:lastCompactId`, String(compactId));
        this.logger.info(`[ReplyAgent] [${groupId}] compact message inserted, id=${compactId}`);
        return compactId;
    }

    private async insertSystemMessage (
        groupId: number, text: string, time: number,
    ): Promise<number> {
        const rows = await this.db.insert(schema.messages).values({
            messageId: 0,
            groupId,
            userId: 0,
            time,
            senderName: '系统',
            senderCard: null,
            isBot: true,
            isAtBot: false,
            specialType: 'system',
            segments: [{type: 'system', text}] as StoredSegment[],
            rawMessage: text
        })
            .returning({id: schema.messages.id});

        const id = rows[0].id;
        this.logger.info(`[ReplyAgent] [${groupId}] system message inserted, id=${id}, text=${text.slice(0, 50)}${text.length > 50 ? '...' : ''}`);
        return id;
    }

    async doCompact (groupId: number, messages: StoredMessage[]): Promise<StoredMessage[]> {
        const keepRecent = this.config.input.auto_compact_keep_recent;

        // 按消息条数保留最近的消息
        const cutIndex = Math.max(0, messages.length - keepRecent);

        const toSummarize = messages.slice(0, cutIndex);
        const toKeep = messages.slice(cutIndex);

        if (toSummarize.length === 0) {
            this.logger.warn(`[ReplyAgent] [${groupId}] compact skipped: no messages to summarize`);
            return messages;
        }

        this.logger.info(
            `[ReplyAgent] [${groupId}] compacting ${toSummarize.length} messages, ` +
            `keeping ${toKeep.length}`);

        const summary = await this.generateCompactSummary(toSummarize);
        if (!summary) {
            this.logger.error(`[ReplyAgent] [${groupId}] compact summary generation failed`);
            return messages;
        }

        let compactTime: number;
        if (toKeep.length > 0) {
            compactTime = toKeep[0].time - 1;
        } else if (toSummarize.length > 0) {
            compactTime = toSummarize[toSummarize.length - 1].time - 1;
        } else {
            compactTime = Math.floor(Date.now() / 1000);
        }
        await this.insertCompactMessage(groupId, summary, compactTime);

        const compactMsg: StoredMessage = {
            time: compactTime,
            messageId: 0,
            senderId: 0,
            senderName: '系统',
            senderCard: void 0,
            isBot: true,
            isAtBot: false,
            segments: [{type: 'compact', text: summary}]
        };

        return [compactMsg, ...toKeep];
    }

    // ==================== Compact ====================

    private async getAllMessages (groupId: number): Promise<StoredMessage[]> {
        const lastCompactIdStr = await kvGet(this.db, `group:${groupId}:lastCompactId`);
        const conditions = [eq(schema.messages.groupId, groupId)];
        if (lastCompactIdStr) {
            conditions.push(gte(schema.messages.id, parseInt(lastCompactIdStr, 10)));
        }

        const rows = await this.db
            .select()
            .from(schema.messages)
            .where(and(...conditions))
            .orderBy(desc(schema.messages.id));

        rows.reverse();

        return rows.map(row => ({
            id: row.id,
            time: row.time,
            messageId: row.messageId,
            senderId: row.userId,
            senderName: row.senderName,
            senderCard: row.senderCard ?? void 0,
            isBot: row.isBot,
            isAtBot: row.isAtBot,
            segments: row.segments as StoredMessage['segments']
        }));
    }

    async triggerCompact (groupId: number, force = false): Promise<boolean> {
        const modelEntry = this.config.ai.models[this.config.ai.assignments.reply];
        const contextWindow = modelEntry?.model?.contextWindow ?? 128000;

        const messages = await this.getAllMessages(groupId);

        if (force || await this.shouldCompact(messages, contextWindow, groupId)) {
            await this.doCompact(groupId, messages);
            return true;
        }

        return false;
    }

    // ==================== Build Prompt ====================

    async buildPrompt (
        groupId: number, lastTriggerId: number, task: ReplyTask,
    ): Promise<{userPrompt: string; anchorTime: number}> {
        const modelEntry = this.config.ai.models[this.config.ai.assignments.reply];
        const contextWindow = modelEntry?.model?.contextWindow ?? 128000;

        let allMessages = await this.getAllMessages(groupId);
        this.logger.debug(`[ReplyAgent] [${groupId}] fetched ${allMessages.length} total messages`);

        if (await this.shouldCompact(allMessages, contextWindow, groupId)) {
            allMessages = await this.doCompact(groupId, allMessages);
        }

        const history: StoredMessage[] = [];
        const latest: StoredMessage[] = [];
        for (const msg of allMessages) {
            if (lastTriggerId > 0 && typeof msg.id !== 'undefined' && msg.id <= lastTriggerId) {
                history.push(msg);
            } else {
                latest.push(msg);
            }
        }

        const anchorTime = allMessages.length > 0 ? allMessages[allMessages.length - 1].time : 0;
        const userPrompt = await this.buildUserPrompt(groupId, history, latest, task);
        return {userPrompt, anchorTime};
    }

    async generateReply (groupId: number, lastTriggerId: number, task: ReplyTask): Promise<FirstTurnResult> {
        this.logger.info(`[ReplyAgent] [${groupId}] generateReply start type=${task.type}`);
        this.taskType = task.type;

        this.systemPrompt = this.buildSystemPrompt(groupId);

        this.modelEntry = this.config.ai.models[this.config.ai.assignments.reply];
        if (!this.modelEntry) throw new Error('Reply model not configured');

        this.mem0Tools = this.config.ai.mem0 ?
            createMem0Tools(this.config.ai.mem0, this.config.log.level, groupId) :
            [];

        const maxAttempts = 2;
        let attempt = 0;
        let firstTurnResult: ReplyFirstTurnArgs | null = null;
        let anchorTime = 0;

        const replyFirstTurnTool: AgentTool<typeof replyFirstTurnSchema> = {
            name: 'reply_first_turn',
            label: '第一轮回复',
            description: '第一轮回复决策工具。决定是直接回复（FINISH）还是先进行深度研究（DEEP_RESEARCH）。如果选择 FINISH，immediate_reply 就是你的最终回复内容。否则将先发送immediate_reply，再为你提供深度研究结果以便发送后续消息。',
            parameters: replyFirstTurnSchema,
            async execute (_toolCallId, params) {
                firstTurnResult = params as ReplyFirstTurnArgs;
                return {
                    content: [{type: 'text', text: `决策: ${params.action}`}],
                    details: params,
                    terminate: true
                };
            }
        };

        while (attempt < maxAttempts) {
            attempt++;
            const promptResult = await this.buildPrompt(groupId, lastTriggerId, task);
            const userPrompt = promptResult.userPrompt;
            anchorTime = promptResult.anchorTime;
            this.logger.debug(`[ReplyAgent] [${groupId}] prompt built. userPrompt length=${userPrompt.length}`);

            if (attempt === 1) {
                this.dumpPrompt(groupId, task.type, this.systemPrompt, userPrompt);
            }

            firstTurnResult = null;
            const maxToolCallRounds = this.config.input.max_tool_call_rounds;
            let turnCount = 0;

            this.agent = new Agent({
                sessionId: `group-${groupId}`,
                initialState: {
                    systemPrompt: this.systemPrompt,
                    model: this.modelEntry!.model,
                    tools: [replyFirstTurnTool, ...this.mem0Tools],
                    thinkingLevel: 'high'
                },
                getApiKey: () => this.modelEntry!.apiKey,
                afterToolCall: async () => {
                    if (turnCount >= maxToolCallRounds) {
                        this.logger.warn(
                            `[ReplyAgent] [${groupId}] tool call rounds exceeded ` +
                            `${maxToolCallRounds}, forcing termination`);
                        return {terminate: true};
                    }
                },
                prepareNextTurn: async () => {
                    turnCount++;
                }
            });

            this.logger.debug(`[ReplyAgent] [${groupId}] first turn agent prompt...`);
            this.agent.reset();
            turnCount = 0;
            await this.agent.prompt(userPrompt);
            await this.agent.waitForIdle();

            let lastAssistant = getLastAssistant(this.agent);

            if (lastAssistant?.stopReason === 'error') {
                this.logger.error(
                    `[ReplyAgent] [${groupId}] first turn API error ` +
                    `(attempt ${attempt}/${maxAttempts}): ${lastAssistant.errorMessage}`);
                if (attempt >= maxAttempts) {
                    if (this.taskType === 'at') {
                        return {texts: ['@响应失败']};
                    }
                    return {texts: []};
                }
                continue;
            }

            let reminderCount = 0;
            const maxReminders = 2;

            // eslint-disable-next-line no-unmodified-loop-condition
            while (isFirstTurnEmpty(firstTurnResult) && reminderCount < maxReminders) {
                reminderCount++;
                this.logger.info(
                    `[ReplyAgent] [${groupId}] first turn no toolCall or empty reply, ` +
                    `sending reminder ${reminderCount}/${maxReminders}...`);
                turnCount = 0;
                await this.agent!.prompt(prompts.replyReminderFirstTurn);
                await this.agent!.waitForIdle();

                lastAssistant = getLastAssistant(this.agent);
                if (lastAssistant?.stopReason === 'error') {
                    this.logger.error(
                        `[ReplyAgent] [${groupId}] reminder API error: ${lastAssistant.errorMessage}`);
                    break;
                }
            }

            lastAssistant = getLastAssistant(this.agent);
            if (lastAssistant?.stopReason === 'error') {
                this.logger.error(
                    `[ReplyAgent] [${groupId}] first turn API error after reminders ` +
                    `(attempt ${attempt}/${maxAttempts}): ${lastAssistant.errorMessage}`);
                if (attempt >= maxAttempts) {
                    if (this.taskType === 'at') {
                        return {texts: ['@响应失败']};
                    }
                    return {texts: []};
                }
                continue;
            }

            const contextWindow = this.modelEntry.model.contextWindow ?? 128000;

            if (lastAssistant && isContextOverflow(lastAssistant, contextWindow)) {
                if (attempt >= maxAttempts) {
                    this.logger.error(`[ReplyAgent] [${groupId}] overflow recovery failed after retry`);
                    if (this.taskType === 'at') {
                        return {texts: ['@响应失败']};
                    }
                    return {texts: []};
                }
                const msgs = this.agent.state.messages;
                if (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') {
                    this.agent.state.messages = msgs.slice(0, -1);
                }
                const allMessages = await this.getAllMessages(groupId);
                const compacted = await this.doCompact(groupId, allMessages);
                if (compacted.length === allMessages.length) {
                    this.logger.error(`[ReplyAgent] [${groupId}] compact failed during overflow recovery`);
                    if (this.taskType === 'at') {
                        return {texts: ['@响应失败']};
                    }
                    return {texts: []};
                }
                this.logger.info(`[ReplyAgent] [${groupId}] overflow recovery: compact done, retrying...`);
                continue;
            }

            if (lastAssistant && lastAssistant.stopReason !== 'aborted') {
                const lastCompactIdStr = await kvGet(this.db, `group:${groupId}:lastCompactId`);
                await this.saveUsageAnchor(groupId, {
                    totalTokens: calculateBaselineTokens(lastAssistant.usage),
                    time: anchorTime,
                    compactId: lastCompactIdStr ? parseInt(lastCompactIdStr, 10) : void 0
                });
            }

            const firstTurnStats = calculateCacheStats(this.agent.state.messages);
            this.logger.info(
                `[ReplyAgent] [${groupId}] first turn cache stats: ` +
                `hitRate=${firstTurnStats.cacheHitRate}%, ` +
                `promptTokens=${firstTurnStats.promptTokens}, ` +
                `outputTokens=${firstTurnStats.output}, ` +
                `cacheRead=${firstTurnStats.cacheRead}, ` +
                `cacheWrite=${firstTurnStats.cacheWrite}, ` +
                `totalTokens=${firstTurnStats.totalTokens}`);

            if (isFirstTurnEmpty(firstTurnResult)) {
                const text = lastAssistant ? extractText(lastAssistant) : '';
                this.logger.info(
                    `[ReplyAgent] [${groupId}] first turn no toolCall or empty reply after ${maxReminders} reminders, ` +
                    `fallback: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`);
                if (this.taskType === 'at') {
                    return {texts: ['@响应失败']};
                }
                return {texts: []};
            }

            break;
        }

        if (isFirstTurnEmpty(firstTurnResult)) {
            if (this.taskType === 'at') {
                return {texts: ['@响应失败']};
            }
            return {texts: []};
        }

        const firstTurnArgs = firstTurnResult!;
        this.logger.info(`[ReplyAgent] [${groupId}] first turn action=${firstTurnArgs.action}`);

        if (firstTurnArgs.action === 'FINISH') {
            this.logger.info(
                `[ReplyAgent] [${groupId}] FINISH reply=${firstTurnArgs.immediate_reply.slice(0, 80)}${firstTurnArgs.immediate_reply.length > 80 ? '...' : ''}`);
            return {texts: [firstTurnArgs.immediate_reply]};
        }

        this.logger.info(
            `[ReplyAgent] [${groupId}] DEEP_RESEARCH immediate_reply=${firstTurnArgs.immediate_reply.slice(0, 80)}${firstTurnArgs.immediate_reply.length > 80 ? '...' : ''}`);

        this.firstTurnArgs = firstTurnArgs;

        const secondTurnContext: SecondTurnContext = {
            messages: [...this.agent!.state.messages],
            firstTurnArgs: {...firstTurnArgs},
            systemPrompt: this.systemPrompt,
            modelEntry: this.modelEntry!,
            mem0Tools: [...this.mem0Tools],
            taskType: this.taskType
        };

        const secondTurnPromise = this.executeSecondTurnStandalone(groupId, secondTurnContext);

        return {
            texts: [firstTurnArgs.immediate_reply],
            secondTurnPromise
        };
    }

    async generateSecondTurn (groupId: number): Promise<string[]> {
        if (!this.firstTurnArgs || this.firstTurnArgs.action !== 'DEEP_RESEARCH') {
            return [];
        }

        if (!this.agent) {
            this.logger.error(`[ReplyAgent] [${groupId}] agent not initialized in second turn`);
            return [];
        }

        const firstTurnArgs = this.firstTurnArgs;

        // 深度研究
        this.logger.info(`[ReplyAgent] [${groupId}] DEEP_RESEARCH keyword=${firstTurnArgs.deep_research_keyword || '(empty)'}`);
        let researchResult: string;
        try {
            researchResult = await this.doDeepResearch(firstTurnArgs.deep_research_keyword || '');
            this.logger.debug(`[ReplyAgent] [${groupId}] deep research done length=${researchResult.length}`);
            if (!researchResult) {
                this.logger.error(`[ReplyAgent] [${groupId}] deep research returned empty result`);
                researchResult = '（深度研究未能获取结果，请根据你已有的知识直接回复。）';
            }
        } catch (err) {
            this.logger.error(`[ReplyAgent] [${groupId}] deep research failed:`, err);
            researchResult = '（深度研究失败，请根据你已有的知识直接回复。）';
        }

        // 第二轮：复用第一轮的 agent，保留完整上下文
        let secondTurnResult: ReplySecondTurnArgs | null = null;

        const replySecondTurnTool: AgentTool<typeof replySecondTurnSchema> = {
            name: 'reply_second_turn',
            label: '第二轮回复',
            description: '第二轮回复工具。在获得深度研究结果后，给出最终回复。',
            parameters: replySecondTurnSchema,
            async execute (_toolCallId, params) {
                secondTurnResult = params as ReplySecondTurnArgs;
                return {
                    content: [{type: 'text', text: `最终回复已生成`}],
                    details: params,
                    terminate: true
                };
            }
        };

        // 复用第一轮的 agent，只替换工具列表
        this.agent.state.tools = [replySecondTurnTool, ...this.mem0Tools];

        const secondUserPrompt = `${prompts.replyReminderSecondTurn}\n\n深度研究结果：\n${researchResult}`;

        this.logger.debug(`[ReplyAgent] [${groupId}] second turn agent prompt (reusing first-turn agent)...`);
        secondTurnResult = null;
        await this.agent.prompt(secondUserPrompt);
        await this.agent.waitForIdle();

        let lastAssistant2 = getLastAssistant(this.agent);

        if (lastAssistant2?.stopReason === 'error') {
            this.logger.error(
                `[ReplyAgent] [${groupId}] second turn API error: ${lastAssistant2.errorMessage}`);
            if (this.taskType === 'at') {
                return ['@深度研究失败'];
            }
            return [];
        }

        let reminderCount2 = 0;
        const maxReminders = 2;

        // eslint-disable-next-line no-unmodified-loop-condition
        while (isSecondTurnEmpty(secondTurnResult) && reminderCount2 < maxReminders) {
            reminderCount2++;
            this.logger.info(
                `[ReplyAgent] [${groupId}] second turn no toolCall or empty reply, ` +
                `sending reminder ${reminderCount2}/${maxReminders}...`);
            await this.agent.prompt(prompts.replyReminderSecondTurn);
            await this.agent.waitForIdle();

            lastAssistant2 = getLastAssistant(this.agent);
            if (lastAssistant2?.stopReason === 'error') {
                this.logger.error(
                    `[ReplyAgent] [${groupId}] second turn reminder API error: ${lastAssistant2.errorMessage}`);
                break;
            }
        }

        lastAssistant2 = getLastAssistant(this.agent);
        if (lastAssistant2?.stopReason === 'error') {
            this.logger.error(
                `[ReplyAgent] [${groupId}] second turn API error after reminders: ${lastAssistant2.errorMessage}`);
            if (this.taskType === 'at') {
                return ['@深度研究失败'];
            }
            return [];
        }

        const secondTurnStats = calculateCacheStats(this.agent.state.messages);
        this.logger.info(
            `[ReplyAgent] [${groupId}] second turn cache stats: ` +
            `hitRate=${secondTurnStats.cacheHitRate}%, ` +
            `promptTokens=${secondTurnStats.promptTokens}, ` +
            `outputTokens=${secondTurnStats.output}, ` +
            `cacheRead=${secondTurnStats.cacheRead}, ` +
            `cacheWrite=${secondTurnStats.cacheWrite}, ` +
            `totalTokens=${secondTurnStats.totalTokens}`);

        const contextWindow2 = this.modelEntry?.model.contextWindow ?? 128000;
        if (lastAssistant2 && isContextOverflow(lastAssistant2, contextWindow2)) {
            this.logger.error(`[ReplyAgent] [${groupId}] second turn context overflow detected`);
            if (this.taskType === 'at') {
                return ['@深度研究失败'];
            }
            return [];
        }

        if (isSecondTurnEmpty(secondTurnResult)) {
            const text = lastAssistant2 ? extractText(lastAssistant2) : '';
            this.logger.info(`[ReplyAgent] [${groupId}] second turn no toolCall or empty reply after ${maxReminders} reminders, fallback: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`);
            if (this.taskType === 'at') {
                return ['@深度研究失败'];
            }
            return [];
        }

        const secondTurnArgs = secondTurnResult!;
        this.logger.info(`[ReplyAgent] [${groupId}] second turn final_reply=${secondTurnArgs.final_reply.slice(0, 80)}${secondTurnArgs.final_reply.length > 80 ? '...' : ''}`);
        return [secondTurnArgs.final_reply];
    }

    private async executeSecondTurnStandalone (groupId: number, context: SecondTurnContext): Promise<string[]> {
        const firstTurnArgs = context.firstTurnArgs;
        const researchKeyword = firstTurnArgs.deep_research_keyword || '';

        const startTime = Math.floor(Date.now() / 1000);
        await this.insertSystemMessage(groupId, `开始深度研究：${researchKeyword}`, startTime);

        let researchResult: string | undefined;
        let researchError: string | undefined;

        try {
            try {
                researchResult = await this.doDeepResearch(researchKeyword);
                this.logger.debug(`[ReplyAgent] [${groupId}] deep research done length=${researchResult.length}`);
                if (!researchResult) {
                    this.logger.error(`[ReplyAgent] [${groupId}] deep research returned empty result`);
                    researchError = '深度研究未能获取结果';
                    researchResult = '（深度研究未能获取结果，请根据你已有的知识直接回复。）';
                }
            } catch (err) {
                this.logger.error(`[ReplyAgent] [${groupId}] deep research failed:`, err);
                researchError = err instanceof Error ? err.message : String(err);
                researchResult = '（深度研究失败，请根据你已有的知识直接回复。）';
            }

            let secondTurnResult: ReplySecondTurnArgs | null = null;

            const replySecondTurnTool: AgentTool<typeof replySecondTurnSchema> = {
                name: 'reply_second_turn',
                label: '第二轮回复',
                description: '第二轮回复工具。在获得深度研究结果后，给出最终回复。',
                parameters: replySecondTurnSchema,
                async execute (_toolCallId, params) {
                    secondTurnResult = params as ReplySecondTurnArgs;
                    return {
                        content: [{type: 'text', text: `最终回复已生成`}],
                        details: params,
                        terminate: true
                    };
                }
            };

            const maxToolCallRounds = this.config.input.max_tool_call_rounds;
            let turnCount = 0;

            const agent = new Agent({
                sessionId: `group-${groupId}`,
                initialState: {
                    systemPrompt: context.systemPrompt,
                    model: context.modelEntry.model,
                    tools: [replySecondTurnTool, ...context.mem0Tools],
                    thinkingLevel: 'high'
                },
                getApiKey: () => context.modelEntry.apiKey,
                afterToolCall: async () => {
                    if (turnCount >= maxToolCallRounds) {
                        this.logger.warn(
                            `[ReplyAgent] [${groupId}] second turn tool call rounds exceeded ` +
                            `${maxToolCallRounds}, forcing termination`);
                        return {terminate: true};
                    }
                },
                prepareNextTurn: async () => {
                    turnCount++;
                }
            });

            agent.state.messages = [...context.messages];

            const secondUserPrompt = `${prompts.replyReminderSecondTurn}\n\n深度研究结果：\n${researchResult}`;

            this.logger.debug(`[ReplyAgent] [${groupId}] second turn standalone prompt...`);
            secondTurnResult = null;
            await agent.prompt(secondUserPrompt);
            await agent.waitForIdle();

            let lastAssistantStandalone = getLastAssistant(agent);

            if (lastAssistantStandalone?.stopReason === 'error') {
                this.logger.error(
                    `[ReplyAgent] [${groupId}] second turn standalone API error: ${lastAssistantStandalone.errorMessage}`);
                if (context.taskType === 'at') {
                    return ['@深度研究失败'];
                }
                return [];
            }

            let reminderCount = 0;
            const maxReminders = 2;

            // eslint-disable-next-line no-unmodified-loop-condition
            while (isSecondTurnEmpty(secondTurnResult) && reminderCount < maxReminders) {
                reminderCount++;
                this.logger.info(
                    `[ReplyAgent] [${groupId}] second turn standalone no toolCall or empty reply, ` +
                    `sending reminder ${reminderCount}/${maxReminders}...`);
                await agent.prompt(prompts.replyReminderSecondTurn);
                await agent.waitForIdle();

                lastAssistantStandalone = getLastAssistant(agent);
                if (lastAssistantStandalone?.stopReason === 'error') {
                    this.logger.error(
                        `[ReplyAgent] [${groupId}] second turn standalone reminder API error: ${lastAssistantStandalone.errorMessage}`);
                    break;
                }
            }

            lastAssistantStandalone = getLastAssistant(agent);
            if (lastAssistantStandalone?.stopReason === 'error') {
                this.logger.error(
                    `[ReplyAgent] [${groupId}] second turn standalone API error after reminders: ${lastAssistantStandalone.errorMessage}`);
                if (context.taskType === 'at') {
                    return ['@深度研究失败'];
                }
                return [];
            }

            const secondTurnStats = calculateCacheStats(agent.state.messages);
            this.logger.info(
                `[ReplyAgent] [${groupId}] second turn standalone cache stats: ` +
                `hitRate=${secondTurnStats.cacheHitRate}%, ` +
                `promptTokens=${secondTurnStats.promptTokens}, ` +
                `outputTokens=${secondTurnStats.output}, ` +
                `cacheRead=${secondTurnStats.cacheRead}, ` +
                `cacheWrite=${secondTurnStats.cacheWrite}, ` +
                `totalTokens=${secondTurnStats.totalTokens}`);

            const standaloneContextWindow = context.modelEntry.model.contextWindow ?? 128000;
            if (lastAssistantStandalone && isContextOverflow(lastAssistantStandalone, standaloneContextWindow)) {
                this.logger.error(`[ReplyAgent] [${groupId}] second turn standalone context overflow detected`);
                if (context.taskType === 'at') {
                    return ['@深度研究失败'];
                }
                return [];
            }

            if (isSecondTurnEmpty(secondTurnResult)) {
                const text = lastAssistantStandalone ? extractText(lastAssistantStandalone) : '';
                this.logger.info(`[ReplyAgent] [${groupId}] second turn standalone no toolCall or empty reply after ${maxReminders} reminders, fallback: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`);
                if (context.taskType === 'at') {
                    return ['@深度研究失败'];
                }
                return [];
            }

            const secondTurnArgs = secondTurnResult!;
            this.logger.info(`[ReplyAgent] [${groupId}] second turn standalone final_reply=${secondTurnArgs.final_reply.slice(0, 80)}${secondTurnArgs.final_reply.length > 80 ? '...' : ''}`);
            return [secondTurnArgs.final_reply];
        } finally {
            const endTime = Math.floor(Date.now() / 1000);
            let endMsg: string;
            if (researchError) {
                endMsg = `深度研究结束：${researchKeyword}\n\n${researchError}`;
            } else if (researchResult) {
                endMsg = `深度研究结束：${researchKeyword}\n\n${researchResult}`;
            } else {
                endMsg = `深度研究结束：${researchKeyword}`;
            }
            await this.insertSystemMessage(groupId, endMsg, endTime);
        }
    }

    private dumpPrompt (groupId: number, taskType: string, systemPrompt: string, userPrompt: string): void {
        if (!this.config.input.debug_dump_prompt) return;

        const dir = join('data', 'debug');
        mkdirSync(dir, {recursive: true});

        const ts = new Date().toISOString()
            .replace(/:/g, '-');
        const prefix = `${groupId}-${taskType}-${ts}`;

        writeFileSync(join(dir, `${prefix}-system.txt`), systemPrompt, 'utf-8');
        writeFileSync(join(dir, `${prefix}-user.txt`), userPrompt, 'utf-8');

        this.logger.debug(
            `[ReplyAgent] [${groupId}] prompt dumped to ` +
            `${prefix}-system.txt (${systemPrompt.length} chars) / ` +
            `${prefix}-user.txt (${userPrompt.length} chars)`);
    }

    private buildSystemPrompt (groupId?: number): string {
        const botName = this.config.input.bot_name || '机器人';
        const persona = this.config.input.bot_persona || '';
        const parts = [prompts.replyIdentity(botName)];
        if (persona) parts.push(persona);
        if (typeof groupId === 'number') {
            const groupCustomPrompts = this.config.input.group_custom_prompts;
            if (groupCustomPrompts) {
                const customPrompt = groupCustomPrompts[groupId];
                if (customPrompt) {
                    parts.push(prompts.groupCustomPromptStart);
                    parts.push(customPrompt);
                    parts.push(prompts.groupCustomPromptEnd);
                }
            }
        }
        return parts.join('\n\n');
    }

    private async buildUserPrompt (
        groupId: number, history: StoredMessage[], latest: StoredMessage[], task: ReplyTask,
    ): Promise<string> {
        const parts: string[] = [];

        if (history.length > 0) {
            parts.push(prompts.replyHistoryStart);
            parts.push(await messagesToString(history, sha => this.descQueue.resolve(sha)));
        }

        parts.push(prompts.replyLatestStart);
        parts.push(await messagesToString(latest, sha => this.descQueue.resolve(sha)));

        const memoryBlock = await this.buildMemoryBlock(groupId, latest, task);
        if (memoryBlock) {
            parts.push(memoryBlock);
        }

        if (task.type === 'at') {
            parts.push(`注意：以上最新消息中，有人@了你`);
        }

        parts.push(prompts.replyStart);

        return parts.join('\n\n');
    }

    private async generateMemoryKeywords (
        latest: StoredMessage[], task: ReplyTask,
    ): Promise<string[]> {
        const assignmentKey = this.config.ai.assignments.memory_keyword;
        if (!assignmentKey) return [];
        const modelEntry = this.config.ai.models[assignmentKey];
        if (!modelEntry) {
            this.logger.warn(`[ReplyAgent] memory_keyword model "${assignmentKey}" not found`);
            return [];
        }
        if (!this.config.ai.mem0) return [];

        const latestText = await messagesToString(latest, sha => this.descQueue.resolve(sha));
        if (!latestText.trim()) return [];

        this.logger.debug(
            `[ReplyAgent] generating memory keywords with ${modelEntry.model.name}`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);

        try {
            const response = await complete(
                modelEntry.model,
                {
                    systemPrompt: prompts.memoryKeywordSystem,
                    messages: [{
                        role: 'user',
                        content: prompts.memoryKeywordUser(latestText, task.type),
                        timestamp: Date.now()
                    }]
                },
                {apiKey: modelEntry.apiKey, signal: controller.signal, timeoutMs: 60000}
            );

            clearTimeout(timeoutId);

            const text = extractText(response);
            const keywords = parseKeywordJson(text).slice(0, 5);
            this.logger.debug(`[ReplyAgent] memory keywords: ${keywords.join(', ')}`);
            return keywords;
        } catch (err) {
            clearTimeout(timeoutId);
            this.logger.error('[ReplyAgent] generate memory keywords failed:', err);
            return [];
        }
    }

    private async searchMemories (
        groupId: number, keywords: string[],
    ): Promise<{memory: string; score: number}[]> {
        if (keywords.length === 0 || !this.config.ai.mem0) return [];

        try {
            const mem0Client = new Memory(this.config.ai.mem0);
            const userId = `group-${groupId}`;
            const query = keywords.join(' ');

            const results = await mem0Client.search(query, {
                topK: 25,
                filters: {user_id: userId}
            });

            const sorted = results.results
                .map(r => ({memory: r.memory, score: r.score ?? 0}))
                .sort((a, b) => b.score - a.score)
                .slice(0, 10);

            this.logger.debug(`[ReplyAgent] memory search returned ${sorted.length} results`);
            return sorted;
        } catch (err) {
            this.logger.error('[ReplyAgent] search memories failed:', err);
            return [];
        }
    }

    private async buildMemoryBlock (
        groupId: number, latest: StoredMessage[], task: ReplyTask,
    ): Promise<string | null> {
        if (latest.length === 0 || !this.config.ai.mem0) return null;

        const keywords = await this.generateMemoryKeywords(latest, task);
        if (keywords.length === 0) return null;

        const memories = await this.searchMemories(groupId, keywords);

        const lines: string[] = [];
        lines.push(prompts.memoryBlockHeader);
        lines.push(`${prompts.memoryBlockKeywordsPrefix}${keywords.join('、')}`);

        if (memories.length === 0) {
            lines.push(prompts.memoryBlockNoResult);
        } else {
            lines.push(prompts.memoryBlockResultPrefix);
            for (const {memory, score} of memories) {
                const percent = (score * 100).toFixed(1);
                lines.push(`- ${memory} (相关度: ${percent}%)`);
            }
        }

        lines.push(prompts.memoryBlockFooter);
        return lines.join('\n\n');
    }

    private async doDeepResearch (keyword: string): Promise<string> {
        const modelEntry = this.config.ai.models[this.config.ai.assignments.deep_research];
        if (!modelEntry) throw new Error('Deep research model not configured');
        this.logger.debug(`[ReplyAgent] doDeepResearch model=${modelEntry.model.name} keyword=${keyword}`);

        const client = new OpenAI({
            apiKey: modelEntry.apiKey,
            baseURL: modelEntry.model.baseUrl
        });

        const response = await client.chat.completions.create({
            model: modelEntry.model.id,
            messages: [
                {role: 'user', content: `${prompts.deepResearchSystem}\n请深度研究以下主题：\n${keyword}`}
            ],
            stream: false
        }, {timeout: 1800000});

        const text = response.choices[0]?.message?.content?.trim() ?? '（研究失败）\n';
        const usage = (response as any).usage;
        if (usage) {
            const promptTokens = (usage.prompt_tokens || 0) + (usage.prompt_cache_hit_tokens || 0);
            const cacheHitRate = promptTokens > 0 ?
                ((usage.prompt_cache_hit_tokens || 0) / promptTokens * 100).toFixed(2) :
                '0.00';
            this.logger.info(
                `[ReplyAgent] doDeepResearch cache stats: ` +
                `hitRate=${cacheHitRate}%, promptTokens=${promptTokens}, ` +
                `outputTokens=${usage.completion_tokens || 0}, ` +
                `cacheRead=${usage.prompt_cache_hit_tokens || 0}, ` +
                `totalTokens=${usage.total_tokens || 0}`);
        }
        this.logger.debug(`[ReplyAgent] doDeepResearch done text length=${text.length}`);
        return text;
    }
}

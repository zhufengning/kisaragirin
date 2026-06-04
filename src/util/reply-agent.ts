import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { Db } from '~/db';
import { schema } from '~/db';
import { eq, desc } from 'drizzle-orm';
import type { DescQueue } from './desc-queue';
import type { ReplyTask } from './reply-manager';
import type { StoredMessage } from '~/message-format';
import { messagesToString } from '~/message-format';
import { prompts } from '~/prompts';
import { Logger } from '@lib/util/logger';
import { createMem0Tools } from './mem0-tool';

const replyFirstTurnSchema = Type.Object({
    immediate_reply: Type.String(),
    action: Type.String({ enum: ['FINISH', 'DEEP_RESEARCH'] }),
    deep_research_keyword: Type.Optional(Type.String()),
});

type ReplyFirstTurnArgs = {
    immediate_reply: string;
    action: 'FINISH' | 'DEEP_RESEARCH';
    deep_research_keyword?: string;
};

const replySecondTurnSchema = Type.Object({
    final_reply: Type.String(),
});

type ReplySecondTurnArgs = {
    final_reply: string;
};

function extractText(response: AssistantMessage): string {
    return response.content
        .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
        .map(c => c.text)
        .join('')
        .trim();
}

function getLastAssistant(agent: Agent): AssistantMessage | undefined {
    const messages = agent.state.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === 'assistant') {
            return msg as AssistantMessage;
        }
    }
    return undefined;
}

export class ReplyAgent {
    private db: Db;
    private descQueue: DescQueue;
    private config: any;
    private logger: Logger;
    private firstTurnArgs: ReplyFirstTurnArgs | null = null;
    private systemPrompt: string = '';
    private modelEntry: any = null;
    private mem0Tools: AgentTool<any>[] = [];
    private taskType: 'at' | 'silence' = 'silence';

    constructor(db: Db, descQueue: DescQueue, config: any) {
        this.db = db;
        this.descQueue = descQueue;
        this.config = config;
        this.logger = new Logger();
    }

    async buildPrompt(groupId: number, lastTriggerId: number, task: ReplyTask): Promise<string> {
        const maxMsgCount = this.config.input.max_msg_count ?? 50;

        const rows = await this.db
            .select()
            .from(schema.messages)
            .where(eq(schema.messages.groupId, groupId))
            .orderBy(desc(schema.messages.id))
            .limit(maxMsgCount);
        this.logger.debug(`[ReplyAgent] [${groupId}] fetched ${rows.length} rows`);

        rows.reverse();

        const history: StoredMessage[] = [];
        const latest: StoredMessage[] = [];
        for (const row of rows) {
            const msg: StoredMessage = {
                time: row.time,
                messageId: row.messageId,
                senderId: row.userId,
                senderName: row.senderName,
                senderCard: row.senderCard ?? undefined,
                isBot: row.isBot,
                isAtBot: row.isAtBot,
                segments: row.segments as any,
            };
            if (lastTriggerId > 0 && row.id <= lastTriggerId) {
                history.push(msg);
            } else {
                latest.push(msg);
            }
        }

        return this.buildUserPrompt(history, latest, task);
    }

    async generateReply(groupId: number, lastTriggerId: number, task: ReplyTask): Promise<string[]> {
        this.logger.info(`[ReplyAgent] [${groupId}] generateReply start type=${task.type}`);
        this.taskType = task.type;

        this.systemPrompt = this.buildSystemPrompt();
        const userPrompt = await this.buildPrompt(groupId, lastTriggerId, task);
        this.logger.debug(`[ReplyAgent] [${groupId}] prompt built. userPrompt length=${userPrompt.length}`);

        this.modelEntry = this.config.ai.models[this.config.ai.assignments.reply];
        if (!this.modelEntry) throw new Error('Reply model not configured');

        this.mem0Tools = this.config.ai.mem0
            ? createMem0Tools(this.config.ai.mem0, this.config.log.level, groupId)
            : [];

        // 第一轮：决策 FINISH 或 DEEP_RESEARCH
        let firstTurnResult: ReplyFirstTurnArgs | null = null;

        const replyFirstTurnTool: AgentTool<typeof replyFirstTurnSchema> = {
            name: 'reply_first_turn',
            label: '第一轮回复',
            description: '第一轮回复决策工具。决定是直接回复（FINISH）还是先进行深度研究（DEEP_RESEARCH）。如果选择 FINISH，immediate_reply 就是你的最终回复内容。否则将先发送immediate_reply，再为你提供深度研究结果以便发送后续消息。',
            parameters: replyFirstTurnSchema,
            async execute(_toolCallId, params) {
                firstTurnResult = params as ReplyFirstTurnArgs;
                return {
                    content: [{ type: 'text', text: `决策: ${params.action}` }],
                    details: params,
                    terminate: true,
                };
            },
        };

        const firstTurnTools: AgentTool<any>[] = [replyFirstTurnTool, ...this.mem0Tools];

        const maxToolCallRounds = this.config.input.max_tool_call_rounds ?? 5;
        let turnCount = 0;

        const agent = new Agent({
            initialState: {
                systemPrompt: this.systemPrompt,
                model: this.modelEntry.model,
                tools: firstTurnTools,
            },
            getApiKey: () => this.modelEntry.apiKey,
            afterToolCall: async () => {
                if (turnCount >= maxToolCallRounds) {
                    this.logger.warn(`[ReplyAgent] [${groupId}] tool call rounds exceeded ${maxToolCallRounds}, forcing termination`);
                    return { terminate: true };
                }
            },
            prepareNextTurn: async () => {
                turnCount++;
            },
        });

        this.logger.debug(`[ReplyAgent] [${groupId}] first turn agent prompt...`);
        agent.reset();
        firstTurnResult = null;
        turnCount = 0;
        await agent.prompt(userPrompt);
        await agent.waitForIdle();

        let reminderCount = 0;
        const maxReminders = 2;

        while (!firstTurnResult && reminderCount < maxReminders) {
            reminderCount++;
            this.logger.info(`[ReplyAgent] [${groupId}] first turn no toolCall, sending reminder ${reminderCount}/${maxReminders}...`);
            turnCount = 0;
            await agent.prompt(prompts.replyReminderFirstTurn);
            await agent.waitForIdle();
        }

        if (!firstTurnResult) {
            const lastAssistant = getLastAssistant(agent);
            const text = lastAssistant ? extractText(lastAssistant) : '';
            this.logger.info(`[ReplyAgent] [${groupId}] first turn no toolCall after ${maxReminders} reminders, fallback: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`);
            if (this.taskType === 'at') {
                return ['@响应失败'];
            }
            return [];
        }

        const firstTurnArgs = firstTurnResult as ReplyFirstTurnArgs;
        this.logger.info(`[ReplyAgent] [${groupId}] first turn action=${firstTurnArgs.action}`);

        if (firstTurnArgs.action === 'FINISH') {
            this.logger.info(`[ReplyAgent] [${groupId}] FINISH reply=${firstTurnArgs.immediate_reply.slice(0, 80)}${firstTurnArgs.immediate_reply.length > 80 ? '...' : ''}`);
            return [firstTurnArgs.immediate_reply];
        }

        this.logger.info(`[ReplyAgent] [${groupId}] DEEP_RESEARCH immediate_reply=${firstTurnArgs.immediate_reply.slice(0, 80)}${firstTurnArgs.immediate_reply.length > 80 ? '...' : ''}`);

        this.firstTurnArgs = firstTurnArgs;

        return [firstTurnArgs.immediate_reply];
    }

    async generateSecondTurn(groupId: number): Promise<string[]> {
        if (!this.firstTurnArgs || this.firstTurnArgs.action !== 'DEEP_RESEARCH') {
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

        // 第二轮：基于研究结果生成最终回复
        let secondTurnResult: ReplySecondTurnArgs | null = null;

        const replySecondTurnTool: AgentTool<typeof replySecondTurnSchema> = {
            name: 'reply_second_turn',
            label: '第二轮回复',
            description: '第二轮回复工具。在获得深度研究结果后，给出最终回复。',
            parameters: replySecondTurnSchema,
            async execute(_toolCallId, params) {
                secondTurnResult = params as ReplySecondTurnArgs;
                return {
                    content: [{ type: 'text', text: `最终回复已生成` }],
                    details: params,
                    terminate: true,
                };
            },
        };

        const secondTurnTools: AgentTool<any>[] = [replySecondTurnTool, ...this.mem0Tools];

        const maxToolCallRounds = this.config.input.max_tool_call_rounds ?? 5;
        let turnCount = 0;

        const secondAgent = new Agent({
            initialState: {
                systemPrompt: this.systemPrompt,
                model: this.modelEntry.model,
                tools: secondTurnTools,
            },
            getApiKey: () => this.modelEntry.apiKey,
            afterToolCall: async () => {
                if (turnCount >= maxToolCallRounds) {
                    this.logger.warn(`[ReplyAgent] [${groupId}] second turn tool call rounds exceeded ${maxToolCallRounds}, forcing termination`);
                    return { terminate: true };
                }
            },
            prepareNextTurn: async () => {
                turnCount++;
            },
        });

        const secondUserPrompt = `${prompts.replyReminderSecondTurn}\n\n深度研究结果：\n${researchResult}`;

        this.logger.debug(`[ReplyAgent] [${groupId}] second turn agent prompt...`);
        secondAgent.reset();
        secondTurnResult = null;
        turnCount = 0;
        await secondAgent.prompt(secondUserPrompt);
        await secondAgent.waitForIdle();

        let reminderCount2 = 0;
        const maxReminders = 2;

        while (!secondTurnResult && reminderCount2 < maxReminders) {
            reminderCount2++;
            this.logger.info(`[ReplyAgent] [${groupId}] second turn no toolCall, sending reminder ${reminderCount2}/${maxReminders}...`);
            turnCount = 0;
            await secondAgent.prompt(prompts.replyReminderSecondTurn);
            await secondAgent.waitForIdle();
        }

        if (!secondTurnResult) {
            const lastAssistant = getLastAssistant(secondAgent);
            const text = lastAssistant ? extractText(lastAssistant) : '';
            this.logger.info(`[ReplyAgent] [${groupId}] second turn no toolCall after ${maxReminders} reminders, fallback: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`);
            if (this.taskType === 'at') {
                return ['@深度研究失败'];
            }
            return [];
        }

        const secondTurnArgs = secondTurnResult as ReplySecondTurnArgs;
        this.logger.info(`[ReplyAgent] [${groupId}] second turn final_reply=${secondTurnArgs.final_reply.slice(0, 80)}${secondTurnArgs.final_reply.length > 80 ? '...' : ''}`);
        return [secondTurnArgs.final_reply];
    }

    private buildSystemPrompt(): string {
        const botName = this.config.input.bot_name || '机器人';
        const persona = this.config.input.bot_persona || '';
        const parts = [prompts.replyIdentity(botName)];
        if (persona) parts.push(persona);
        return parts.join('\n\n');
    }

    private async buildUserPrompt(history: StoredMessage[], latest: StoredMessage[], task: ReplyTask): Promise<string> {
        const parts: string[] = [];

        if (history.length > 0) {
            parts.push(prompts.replyHistoryStart);
            parts.push(await messagesToString(history, sha => this.descQueue.resolve(sha)));
        }

        parts.push(prompts.replyLatestStart);
        parts.push(await messagesToString(latest, sha => this.descQueue.resolve(sha)));

        if (task.type === 'at') {
            parts.push(`注意：以上最新消息中，有人@了你（消息ID: ${task.triggerMessage.messageId}）。`);
        }

        parts.push(prompts.replyStart);

        return parts.join('\n\n');
    }

    private async doDeepResearch(keyword: string): Promise<string> {
        const modelEntry = this.config.ai.models[this.config.ai.assignments.deep_research];
        if (!modelEntry) throw new Error('Deep research model not configured');
        this.logger.debug(`[ReplyAgent] doDeepResearch model=${modelEntry.model.name} keyword=${keyword}`);

        const { completeSimple } = await import('@earendil-works/pi-ai');
        const response = await completeSimple(modelEntry.model, {
            systemPrompt: prompts.deepResearchSystem,
            messages: [{ role: 'user', content: `请深度研究以下主题：\n${keyword}`, timestamp: Date.now() }],
        }, { apiKey: modelEntry.apiKey });
        this.logger.debug(`[ReplyAgent] doDeepResearch response content blocks: ${
            JSON.stringify(response.content.map(c => ({ type: c.type, len: 'text' in c ? c.text?.length : 'thinking' in c ? c.thinking?.length : 'N/A', preview: 'text' in c ? c.text?.slice(0, 100) : 'thinking' in c ? c.thinking?.slice(0, 100) : 'N/A' })))
        }`);
        this.logger.debug(`[ReplyAgent] doDeepResearch stopReason=${response.stopReason} contentLength=${response.content.length}`);

        if (response.stopReason === 'error') {
            throw new Error(response.errorMessage || 'Deep research model returned error');
        }

        const text = extractText(response);
        this.logger.debug(`[ReplyAgent] doDeepResearch done text length=${text.length}`);
        return text;
    }
}

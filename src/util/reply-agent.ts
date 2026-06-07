import {Agent, type AgentTool} from '@earendil-works/pi-agent-core';
import {Type, type AssistantMessage} from '@earendil-works/pi-ai';
import OpenAI from 'openai';
import {schema, type Db} from '~/db';
import {eq, desc} from 'drizzle-orm';
import type {DescQueue} from './desc-queue';
import type {ReplyTask} from './reply-manager';
import {messagesToString, type StoredMessage} from '~/message-format';
import {prompts} from '~/prompts';
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

interface SecondTurnContext {
    messages: any[];
    firstTurnArgs: ReplyFirstTurnArgs;
    systemPrompt: string;
    modelEntry: any;
    mem0Tools: AgentTool<any>[];
    taskType: 'at' | 'silence';
}

function extractText (response: AssistantMessage): string {
    return response.content
        .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
        .map(c => c.text)
        .join('')
        .trim();
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
    private agent: Agent | null = null;

    constructor (db: Db, descQueue: DescQueue, config: any) {
        this.db = db;
        this.descQueue = descQueue;
        this.config = config;
        this.logger = new Logger();
    }

    async buildPrompt (groupId: number, lastTriggerId: number, task: ReplyTask): Promise<string> {
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
                senderCard: row.senderCard ?? void 0,
                isBot: row.isBot,
                isAtBot: row.isAtBot,
                segments: row.segments as StoredMessage['segments']
            };
            if (lastTriggerId > 0 && row.id <= lastTriggerId) {
                history.push(msg);
            } else {
                latest.push(msg);
            }
        }

        return this.buildUserPrompt(history, latest, task);
    }

    async generateReply (groupId: number, lastTriggerId: number, task: ReplyTask): Promise<FirstTurnResult> {
        this.logger.info(`[ReplyAgent] [${groupId}] generateReply start type=${task.type}`);
        this.taskType = task.type;

        this.systemPrompt = this.buildSystemPrompt();
        const userPrompt = await this.buildPrompt(groupId, lastTriggerId, task);
        this.logger.debug(`[ReplyAgent] [${groupId}] prompt built. userPrompt length=${userPrompt.length}`);

        this.modelEntry = this.config.ai.models[this.config.ai.assignments.reply];
        if (!this.modelEntry) throw new Error('Reply model not configured');

        this.mem0Tools = this.config.ai.mem0 ?
            createMem0Tools(this.config.ai.mem0, this.config.log.level, groupId) :
            [];

        // 第一轮：决策 FINISH 或 DEEP_RESEARCH
        let firstTurnResult: ReplyFirstTurnArgs | null = null;

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

        const firstTurnTools: AgentTool<any>[] = [replyFirstTurnTool, ...this.mem0Tools];

        const maxToolCallRounds = this.config.input.max_tool_call_rounds ?? 5;
        let turnCount = 0;

        this.agent = new Agent({
            initialState: {
                systemPrompt: this.systemPrompt,
                model: this.modelEntry.model,
                tools: firstTurnTools
            },
            getApiKey: () => this.modelEntry.apiKey,
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
        firstTurnResult = null;
        turnCount = 0;
        await this.agent.prompt(userPrompt);
        await this.agent.waitForIdle();

        let reminderCount = 0;
        const maxReminders = 2;

        // eslint-disable-next-line no-unmodified-loop-condition
        while (!firstTurnResult && reminderCount < maxReminders) {
            reminderCount++;
            this.logger.info(
                `[ReplyAgent] [${groupId}] first turn no toolCall, ` +
                `sending reminder ${reminderCount}/${maxReminders}...`);
            turnCount = 0;
            await this.agent!.prompt(prompts.replyReminderFirstTurn);
            await this.agent!.waitForIdle();
        }

        if (!firstTurnResult) {
            const lastAssistant = getLastAssistant(this.agent!);
            const text = lastAssistant ? extractText(lastAssistant) : '';
            this.logger.info(
                `[ReplyAgent] [${groupId}] first turn no toolCall after ${maxReminders} reminders, ` +
                `fallback: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`);
            if (this.taskType === 'at') {
                return {texts: ['@响应失败']};
            }
            return {texts: []};
        }

        const firstTurnArgs = firstTurnResult as ReplyFirstTurnArgs;
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
            modelEntry: this.modelEntry,
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

        let reminderCount2 = 0;
        const maxReminders = 2;

        // eslint-disable-next-line no-unmodified-loop-condition
        while (!secondTurnResult && reminderCount2 < maxReminders) {
            reminderCount2++;
            this.logger.info(
                `[ReplyAgent] [${groupId}] second turn no toolCall, ` +
                `sending reminder ${reminderCount2}/${maxReminders}...`);
            await this.agent.prompt(prompts.replyReminderSecondTurn);
            await this.agent.waitForIdle();
        }

        if (!secondTurnResult) {
            const lastAssistant = getLastAssistant(this.agent);
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

    private async executeSecondTurnStandalone (groupId: number, context: SecondTurnContext): Promise<string[]> {
        const firstTurnArgs = context.firstTurnArgs;

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

        const maxToolCallRounds = this.config.input.max_tool_call_rounds ?? 5;
        let turnCount = 0;

        const agent = new Agent({
            initialState: {
                systemPrompt: context.systemPrompt,
                model: context.modelEntry.model,
                tools: [replySecondTurnTool, ...context.mem0Tools]
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

        let reminderCount = 0;
        const maxReminders = 2;

        while (!secondTurnResult && reminderCount < maxReminders) {
            reminderCount++;
            this.logger.info(
                `[ReplyAgent] [${groupId}] second turn standalone no toolCall, ` +
                `sending reminder ${reminderCount}/${maxReminders}...`);
            await agent.prompt(prompts.replyReminderSecondTurn);
            await agent.waitForIdle();
        }

        if (!secondTurnResult) {
            const lastAssistant = getLastAssistant(agent);
            const text = lastAssistant ? extractText(lastAssistant) : '';
            this.logger.info(`[ReplyAgent] [${groupId}] second turn standalone no toolCall after ${maxReminders} reminders, fallback: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`);
            if (context.taskType === 'at') {
                return ['@深度研究失败'];
            }
            return [];
        }

        const secondTurnArgs = secondTurnResult as ReplySecondTurnArgs;
        this.logger.info(`[ReplyAgent] [${groupId}] second turn standalone final_reply=${secondTurnArgs.final_reply.slice(0, 80)}${secondTurnArgs.final_reply.length > 80 ? '...' : ''}`);
        return [secondTurnArgs.final_reply];
    }

    private buildSystemPrompt (): string {
        const botName = this.config.input.bot_name || '机器人';
        const persona = this.config.input.bot_persona || '';
        const parts = [prompts.replyIdentity(botName)];
        if (persona) parts.push(persona);
        return parts.join('\n\n');
    }

    private async buildUserPrompt (
        history: StoredMessage[], latest: StoredMessage[], task: ReplyTask,
    ): Promise<string> {
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
        this.logger.debug(`[ReplyAgent] doDeepResearch done text length=${text.length}`);
        return text;
    }
}

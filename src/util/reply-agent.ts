import { completeSimple, Type } from '@earendil-works/pi-ai';
import type { AssistantMessage, Context, Message, Tool, ToolCall } from '@earendil-works/pi-ai';
import type { Db } from '~/db';
import { schema } from '~/db';
import { eq, desc } from 'drizzle-orm';
import type { DescQueue } from './desc-queue';
import type { ReplyTask } from './reply-manager';
import type { StoredMessage } from '~/message-format';
import { messagesToString } from '~/message-format';
import { withRetry } from './agent-retry';
import { prompts } from '~/prompts';
import { Logger } from '@lib/util/logger';

const replyFirstTurnSchema = Type.Object({
    immediate_reply: Type.String(),
    action: Type.String({ enum: ['FINISH', 'DEEP_RESEARCH'] }),
    deep_research_keyword: Type.Optional(Type.String()),
});

const replySecondTurnSchema = Type.Object({
    final_reply: Type.String(),
});

const replyFirstTurnTool: Tool<typeof replyFirstTurnSchema> = {
    name: 'reply_first_turn',
    description: '第一轮回复决策工具。决定是直接回复（FINISH）还是先进行深度研究（DEEP_RESEARCH）。如果选择 FINISH，immediate_reply 就是你的最终回复内容。否则将先发送immediate_reply，再为你提供深度研究结果以便发送后续消息。',
    parameters: replyFirstTurnSchema,
};

const replySecondTurnTool: Tool<typeof replySecondTurnSchema> = {
    name: 'reply_second_turn',
    description: '第二轮回复工具。在获得深度研究结果后，给出最终回复。',
    parameters: replySecondTurnSchema,
};

function extractText(response: AssistantMessage): string {
    return response.content
        .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
        .map(c => c.text)
        .join('')
        .trim();
}

function extractToolCall(response: AssistantMessage, toolName: string): ToolCall | null {
    const calls = response.content.filter((c): c is ToolCall => c.type === 'toolCall' && c.name === toolName);
    return calls[0] || null;
}

export class ReplyAgent {
    private db: Db;
    private descQueue: DescQueue;
    private config: any;
    private logger: Logger;

    constructor(db: Db, descQueue: DescQueue, config: any) {
        this.db = db;
        this.descQueue = descQueue;
        this.config = config;
        this.logger = new Logger(config.onebot.log_level);
    }

    async generateReply(groupId: number, lastTriggerId: number, task: ReplyTask): Promise<string> {
        this.logger.info(`[ReplyAgent] [${groupId}] generateReply start type=${task.type}`);
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

        const systemPrompt = this.buildSystemPrompt();
        const userPrompt = await this.buildUserPrompt(history, latest, task);
        this.logger.debug(`[ReplyAgent] [${groupId}] prompt built. userPrompt length=${userPrompt.length}`);

        // 第一 turn
        this.logger.debug(`[ReplyAgent] [${groupId}] first turn calling...`);
        let response = await this.callReplyModel(systemPrompt, userPrompt, [replyFirstTurnTool]);
        let toolCall = extractToolCall(response, 'reply_first_turn');

        if (!toolCall) {
            response = await this.callReplyModel(systemPrompt, prompts.replyReminderFirstTurn, [replyFirstTurnTool], [
                { role: 'user', content: userPrompt, timestamp: Date.now() },
                response,
                { role: 'user', content: prompts.replyReminderFirstTurn, timestamp: Date.now() },
            ]);
            toolCall = extractToolCall(response, 'reply_first_turn');
        }

        if (!toolCall) {
            const text = extractText(response) || '（沉默）';
            this.logger.info(`[ReplyAgent] [${groupId}] first turn no toolCall, fallback: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`);
            return text;
        }

        const args = toolCall.arguments as { immediate_reply: string; action: 'FINISH' | 'DEEP_RESEARCH'; deep_research_keyword?: string };
        this.logger.info(`[ReplyAgent] [${groupId}] first turn action=${args.action}`);

        if (args.action === 'FINISH') {
            this.logger.info(`[ReplyAgent] [${groupId}] FINISH reply=${args.immediate_reply.slice(0, 80)}${args.immediate_reply.length > 80 ? '...' : ''}`);
            return args.immediate_reply;
        }

        // 深度研究
        this.logger.info(`[ReplyAgent] [${groupId}] DEEP_RESEARCH keyword=${args.deep_research_keyword || '(empty)'}`);
        const researchResult = await this.doDeepResearch(args.deep_research_keyword || '');
        this.logger.debug(`[ReplyAgent] [${groupId}] deep research done length=${researchResult.length}`);

        // 第二 turn
        const secondContext: Message[] = [
            { role: 'user', content: userPrompt, timestamp: Date.now() },
            response,
            { role: 'toolResult', toolCallId: toolCall.id, toolName: toolCall.name, content: [{ type: 'text', text: '已收到，请进行深度研究。' }], isError: false, timestamp: Date.now() },
            { role: 'user', content: `${prompts.replyReminderSecondTurn}\n\n深度研究结果：\n${researchResult}`, timestamp: Date.now() },
        ];

        this.logger.debug(`[ReplyAgent] [${groupId}] second turn calling...`);
        let response2 = await this.callReplyModel(systemPrompt, '', [replySecondTurnTool], secondContext);
        let toolCall2 = extractToolCall(response2, 'reply_second_turn');

        if (!toolCall2) {
            response2 = await this.callReplyModel(systemPrompt, '', [replySecondTurnTool], [
                ...secondContext,
                response2,
                { role: 'user', content: prompts.replyReminderSecondTurn, timestamp: Date.now() },
            ]);
            toolCall2 = extractToolCall(response2, 'reply_second_turn');
        }

        if (!toolCall2) {
            const text = extractText(response2) || '（沉思）';
            this.logger.info(`[ReplyAgent] [${groupId}] second turn no toolCall, fallback: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`);
            return text;
        }

        const finalReply = (toolCall2.arguments as { final_reply: string }).final_reply;
        this.logger.info(`[ReplyAgent] [${groupId}] second turn final_reply=${finalReply.slice(0, 80)}${finalReply.length > 80 ? '...' : ''}`);
        return finalReply;
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

    private async callReplyModel(systemPrompt: string, userPrompt: string, tools: Tool[], existingMessages: Message[] = []): Promise<AssistantMessage> {
        const modelEntry = this.config.ai.models[this.config.ai.assignments.reply];
        if (!modelEntry) throw new Error('Reply model not configured');
        this.logger.debug(`[ReplyAgent] callReplyModel model=${modelEntry.model.name}`);

        const messages: Message[] = existingMessages.length > 0
            ? existingMessages
            : [{ role: 'user', content: userPrompt, timestamp: Date.now() }];

        const context: Context = { systemPrompt, messages, tools };

        return await withRetry(async () => {
            const res = await completeSimple(modelEntry.model, context, { apiKey: modelEntry.apiKey });
            if (res.stopReason === 'error') {
                throw new Error(res.errorMessage || 'Reply model returned error');
            }
            this.logger.debug(`[ReplyAgent] callReplyModel done stopReason=${res.stopReason}`);
            return res;
        }, { maxRetries: 2 });
    }

    private async doDeepResearch(keyword: string): Promise<string> {
        const modelEntry = this.config.ai.models[this.config.ai.assignments.deep_research];
        if (!modelEntry) throw new Error('Deep research model not configured');
        this.logger.debug(`[ReplyAgent] doDeepResearch model=${modelEntry.model.name} keyword=${keyword}`);

        const context: Context = {
            systemPrompt: prompts.deepResearchSystem,
            messages: [{ role: 'user', content: `请深度研究以下主题：\n${keyword}`, timestamp: Date.now() }],
        };

        const response = await withRetry(async () => {
            const res = await completeSimple(modelEntry.model, context, { apiKey: modelEntry.apiKey });
            if (res.stopReason === 'error') {
                throw new Error(res.errorMessage || 'Deep research model returned error');
            }
            return res;
        }, { maxRetries: 2 });

        const text = extractText(response);
        this.logger.debug(`[ReplyAgent] doDeepResearch done text length=${text.length}`);
        return text;
    }
}

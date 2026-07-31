import {Type} from '@earendil-works/pi-ai';
import type {AgentTool} from '@earendil-works/pi-agent-core';
import {Logger} from '@lib/util/logger';
import {replyToolDescription, replyToolParameterDescriptions, replyToolResultText} from '~/prompts';

const parameterDescriptions = replyToolParameterDescriptions();

const replyToolSchema = Type.Object({
    reply: Type.String({description: parameterDescriptions.reply}),
    requires_deep_research: Type.Boolean({description: parameterDescriptions.requiresDeepResearch}),
    deep_research_topic: Type.Optional(Type.String({description: parameterDescriptions.deepResearchTopic}))
});

export interface ReplyToolParams {
    reply: string;
    requires_deep_research: boolean;
    deep_research_topic?: string;
}

export interface CreateReplyToolOptions {
    onCalled?: (params: ReplyToolParams) => void;
}

export function createReplyTool (options: CreateReplyToolOptions): AgentTool<typeof replyToolSchema> {
    const logger = new Logger();

    return {
        name: 'reply',
        label: '回复',
        description: replyToolDescription(),
        parameters: replyToolSchema,
        async execute (_toolCallId, params) {
            logger.debug(`[ReplyTool] called reply=${params.reply.slice(0, 80)} requires_deep_research=${params.requires_deep_research} deep_research_topic=${params.deep_research_topic ?? 'none'}`);

            if (options.onCalled) {
                options.onCalled(params);
            }

            return {
                content: [{type: 'text', text: replyToolResultText()}],
                details: {
                    requiresDeepResearch: params.requires_deep_research,
                    deepResearchTopic: params.deep_research_topic
                },
                terminate: true
            };
        }
    };
}

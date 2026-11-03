import {Type} from 'typebox';
import {defineTool, type ToolDefinition} from '@earendil-works/pi-coding-agent';
import {Logger} from '@lib/util/logger';
import {prompts} from '~/prompts';

export interface ReplyMessageItem {
    ref?: number;
    text: string;
}

export interface ReplyToolParams {
    messages: ReplyMessageItem[];
    requires_deep_research: boolean;
    deep_research_topic?: string;
}

export interface CreateReplyToolOptions {
    onCalled?: (params: ReplyToolParams) => void;
}

export function createReplyTool (options: CreateReplyToolOptions): ToolDefinition<typeof replyToolSchema> {
    const logger = new Logger();
    const parameterDescriptions = prompts.replyToolParameterDescriptions();

    const replyToolSchema = Type.Object({
        messages: Type.Array(Type.Object({
            ref: Type.Optional(Type.Number({description: parameterDescriptions.messageRef})),
            text: Type.String({description: parameterDescriptions.messageText})
        }), {description: parameterDescriptions.messages}),
        requires_deep_research: Type.Boolean({description: parameterDescriptions.requiresDeepResearch}),
        deep_research_topic: Type.Optional(Type.String({description: parameterDescriptions.deepResearchTopic}))
    });

    return defineTool({
        name: 'reply',
        label: '回复',
        description: prompts.replyToolDescription(),
        parameters: replyToolSchema,
        async execute (_toolCallId, params) {
            const firstText = params.messages[0]?.text ?? '';
            logger.debug(`[ReplyTool] called messages=${params.messages.length} first=${firstText.slice(0, 80)} requires_deep_research=${params.requires_deep_research} deep_research_topic=${params.deep_research_topic ?? 'none'}`);

            if (options.onCalled) {
                options.onCalled(params);
            }

            return {
                content: [{type: 'text', text: prompts.replyToolResultText()}],
                details: {
                    requiresDeepResearch: params.requires_deep_research,
                    deepResearchTopic: params.deep_research_topic
                },
                terminate: true
            };
        }
    });
}

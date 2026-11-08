import {Type} from 'typebox';
import {defineTool, type ToolDefinition} from '@earendil-works/pi-coding-agent';
import {inArray} from 'drizzle-orm';
import {Logger} from '@lib/util/logger';
import {schema, type Db} from '~/db';
import {prompts} from '~/prompts';

export interface ReplyMessageItem {
    ref?: number;
    text?: string;
    image_id?: number;
    /** 图片是否按普通图片发送；默认按表情发送 */
    not_sticker?: boolean;
}

export interface ReplyToolParams {
    messages: ReplyMessageItem[];
    requires_deep_research: boolean;
    deep_research_topic?: string;
}

export interface CreateReplyToolOptions {
    db: Db;
    onCalled?: (params: ReplyToolParams) => void;
}

export interface ReplyToolDetails {
    valid: boolean;
    violations: string[];
    requiresDeepResearch?: boolean;
    deepResearchTopic?: string;
}

/** 收集 reply 参数违反的校验规则，返回空数组表示通过 */
async function validateReplyParams (db: Db, params: ReplyToolParams): Promise<string[]> {
    const violations: string[] = [];
    const imageIds = new Set<number>();

    for (const [index, item] of params.messages.entries()) {
        const hasText = typeof item.text === 'string' && item.text.trim().length > 0;
        const hasImage = typeof item.image_id === 'number';
        if (hasText && hasImage) {
            violations.push(prompts.replyValidationImageAndText(index + 1));
        }
        if (!hasText && !hasImage) {
            violations.push(prompts.replyValidationEmptyMessage(index + 1));
        }
        if (typeof item.image_id === 'number') {
            imageIds.add(item.image_id);
        }
    }

    if (imageIds.size > 0) {
        const rows = await db
            .select({id: schema.images.id})
            .from(schema.images)
            .where(inArray(schema.images.id, Array.from(imageIds)));
        const existing = new Set(rows.map(row => row.id));
        for (const [index, item] of params.messages.entries()) {
            if (typeof item.image_id === 'number' && !existing.has(item.image_id)) {
                violations.push(prompts.replyValidationImageMissing(index + 1, item.image_id));
            }
        }
    }

    if (!params.requires_deep_research && params.deep_research_topic !== undefined) {
        violations.push(prompts.replyValidationDeepResearchTopic());
    }

    return violations;
}

export function createReplyTool (options: CreateReplyToolOptions): ToolDefinition<typeof replyToolSchema> {
    const logger = new Logger();
    const parameterDescriptions = prompts.replyToolParameterDescriptions();

    const replyToolSchema = Type.Object({
        messages: Type.Array(Type.Object({
            ref: Type.Optional(Type.Number({description: parameterDescriptions.messageRef})),
            text: Type.Optional(Type.String({description: parameterDescriptions.messageText})),
            image_id: Type.Optional(Type.Number({description: parameterDescriptions.messageImageId})),
            not_sticker: Type.Optional(Type.Boolean({description: parameterDescriptions.messageNotSticker}))
        }), {description: parameterDescriptions.messages}),
        requires_deep_research: Type.Boolean({description: parameterDescriptions.requiresDeepResearch}),
        deep_research_topic: Type.Optional(Type.String({description: parameterDescriptions.deepResearchTopic}))
    });

    return defineTool<typeof replyToolSchema, ReplyToolDetails>({
        name: 'reply',
        label: '回复',
        description: prompts.replyToolDescription(),
        parameters: replyToolSchema,
        async execute (_toolCallId, params) {
            const violations = await validateReplyParams(options.db, params);
            if (violations.length > 0) {
                logger.warn(
                    `[ReplyTool] rejected messages=${params.messages.length}: ${violations.join('; ')}`);
                return {
                    content: [{type: 'text', text: prompts.replyValidationFailed(violations)}],
                    details: {
                        valid: false,
                        violations,
                        requiresDeepResearch: params.requires_deep_research,
                        deepResearchTopic: params.deep_research_topic
                    },
                    isError: true
                };
            }

            const firstText = params.messages[0]?.text ?? '';
            logger.debug(`[ReplyTool] called messages=${params.messages.length} first=${firstText.slice(0, 80)} requires_deep_research=${params.requires_deep_research} deep_research_topic=${params.deep_research_topic ?? 'none'}`);

            if (options.onCalled) {
                options.onCalled(params);
            }

            return {
                content: [{type: 'text', text: prompts.replyToolResultText()}],
                details: {
                    valid: true,
                    violations: [],
                    requiresDeepResearch: params.requires_deep_research,
                    deepResearchTopic: params.deep_research_topic
                },
                terminate: true
            };
        }
    });
}

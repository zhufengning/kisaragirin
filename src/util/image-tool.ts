import {Type} from 'typebox';
import {defineTool, type ToolDefinition} from '@earendil-works/pi-coding-agent';
import {eq} from 'drizzle-orm';
import {schema, type Db} from '~/db';
import {prompts} from '~/prompts';
import {Logger} from '@lib/util/logger';
import type {DescQueue} from './desc-queue';

export interface CreateImageToolsOptions {
    db: Db;
    descQueue: DescQueue;
}

/** 图片追问工具：按图片 id 向视觉模型提问，返回回答文本 */
export function createImageTools (options: CreateImageToolsOptions): ToolDefinition[] {
    const logger = new Logger();
    const parameterDescriptions = prompts.askImageToolParameterDescriptions();

    const askImageTool = defineTool({
        name: 'ask_image',
        label: '追问图片',
        description: prompts.askImageToolDescription(),
        parameters: Type.Object({
            image_id: Type.Number({description: parameterDescriptions.imageId}),
            question: Type.String({description: parameterDescriptions.question})
        }),
        async execute (_toolCallId, params) {
            const rows = await options.db
                .select()
                .from(schema.images)
                .where(eq(schema.images.id, params.image_id));
            const row = rows[0];
            if (!row) {
                logger.warn(`[AskImage] unknown image id ${params.image_id}`);
                return {
                    content: [{type: 'text', text: prompts.askImageInvalidId(params.image_id)}],
                    details: {imageId: params.image_id, found: false},
                    isError: true
                };
            }

            logger.debug(
                `[AskImage] image_id=${params.image_id} question=${params.question.slice(0, 80)}`);
            const answer = await options.descQueue.ask(row.sha256, params.question);
            if (!answer) {
                logger.warn(`[AskImage] no answer for image id ${params.image_id}`);
                return {
                    content: [{type: 'text', text: prompts.askImageFailed()}],
                    details: {imageId: params.image_id, found: true},
                    isError: true
                };
            }

            return {
                content: [{type: 'text', text: answer}],
                details: {imageId: params.image_id, found: true}
            };
        }
    });

    return [askImageTool];
}

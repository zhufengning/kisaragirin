import {Type} from 'typebox';
import {defineTool, type ToolDefinition} from '@earendil-works/pi-coding-agent';
import {eq} from 'drizzle-orm';
import {schema, type Db} from '~/db';
import {prompts} from '~/prompts';
import {Logger} from '@lib/util/logger';
import {getStickers, setStickers} from './sticker-store';

export interface CreateStickerToolsOptions {
    db: Db;
    groupId: number;
    maxStickers: number;
}

interface AddStickerDetails {
    imageId: number;
    updated?: boolean;
    full?: boolean;
}

interface RemoveStickerDetails {
    imageId: number;
    found: boolean;
}

/** 表情包收藏工具：收藏与取消收藏，收藏列表全局保存在 kv_store */
export function createStickerTools (options: CreateStickerToolsOptions): ToolDefinition[] {
    const logger = new Logger();
    const addDescriptions = prompts.addStickerToolParameterDescriptions();
    const removeDescriptions = prompts.removeStickerToolParameterDescriptions();

    const addStickerSchema = Type.Object({
        image_id: Type.Number({description: addDescriptions.imageId}),
        category: Type.String({description: addDescriptions.category}),
        note: Type.String({description: addDescriptions.note})
    });

    const addStickerTool = defineTool<typeof addStickerSchema, AddStickerDetails>({
        name: 'add_sticker',
        label: '收藏表情',
        description: prompts.addStickerToolDescription(),
        parameters: addStickerSchema,
        async execute (_toolCallId, params) {
            const category = params.category.trim();
            const note = params.note.trim();
            if (!category || !note) {
                return {
                    content: [{type: 'text', text: prompts.stickerEmptyField()}],
                    details: {imageId: params.image_id},
                    isError: true
                };
            }

            const rows = await options.db
                .select({id: schema.images.id})
                .from(schema.images)
                .where(eq(schema.images.id, params.image_id));
            if (!rows[0]) {
                logger.warn(`[Sticker] unknown image id ${params.image_id}`);
                return {
                    content: [{type: 'text', text: prompts.stickerImageMissing(params.image_id)}],
                    details: {imageId: params.image_id},
                    isError: true
                };
            }

            const stickers = await getStickers(options.db);
            const existingIndex = stickers.findIndex(sticker => sticker.imageId === params.image_id);
            if (existingIndex >= 0) {
                stickers[existingIndex] = {imageId: params.image_id, category, note};
                await setStickers(options.db, stickers);
                logger.info(
                    `[Sticker] [${options.groupId}] updated image ${params.image_id}: ` +
                    `${category} / ${note}`);
                return {
                    content: [{
                        type: 'text',
                        text: prompts.stickerUpdated(params.image_id, category, note)
                    }],
                    details: {imageId: params.image_id, updated: true}
                };
            }

            if (stickers.length >= options.maxStickers) {
                logger.warn(
                    `[Sticker] [${options.groupId}] sticker list full ` +
                    `(${stickers.length}/${options.maxStickers})`);
                return {
                    content: [{
                        type: 'text',
                        text: prompts.stickerListFull(options.maxStickers)
                    }],
                    details: {imageId: params.image_id, full: true},
                    isError: true
                };
            }

            stickers.push({imageId: params.image_id, category, note});
            await setStickers(options.db, stickers);
            logger.info(
                `[Sticker] [${options.groupId}] added image ${params.image_id}: ${category} / ${note}`);
            return {
                content: [{
                    type: 'text',
                    text: prompts.stickerAdded(params.image_id, category, note)
                }],
                details: {imageId: params.image_id, updated: false}
            };
        }
    });

    const removeStickerSchema = Type.Object({
        image_id: Type.Number({description: removeDescriptions.imageId})
    });

    const removeStickerTool = defineTool<typeof removeStickerSchema, RemoveStickerDetails>({
        name: 'remove_sticker',
        label: '取消收藏表情',
        description: prompts.removeStickerToolDescription(),
        parameters: removeStickerSchema,
        async execute (_toolCallId, params) {
            const stickers = await getStickers(options.db);
            const index = stickers.findIndex(sticker => sticker.imageId === params.image_id);
            if (index < 0) {
                return {
                    content: [{type: 'text', text: prompts.stickerNotFavorited(params.image_id)}],
                    details: {imageId: params.image_id, found: false},
                    isError: true
                };
            }

            stickers.splice(index, 1);
            await setStickers(options.db, stickers);
            logger.info(`[Sticker] [${options.groupId}] removed image ${params.image_id}`);
            return {
                content: [{type: 'text', text: prompts.stickerRemoved(params.image_id)}],
                details: {imageId: params.image_id, found: true}
            };
        }
    });

    return [addStickerTool, removeStickerTool];
}

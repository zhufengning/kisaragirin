import {Logger} from '@lib/util/logger';
import {formatSender, messagesToString, type StoredMessage} from '~/message-format';
import type {GraphitiClient} from './graphiti-client';

const logger = new Logger();

/**
 * 将一条存储消息作为 episode 异步写入 Graphiti（fire-and-forget，内部捕获错误）。
 * 群消息、bot 回复、深度研究系统消息共用此入口，保证记忆格式一致。
 */
export function addMessageEpisode (
    graphiti: GraphitiClient,
    groupId: number,
    stored: StoredMessage,
    resolveDesc: (sha256: string) => Promise<string | undefined>
): void {
    void (async () => {
        const groupName = `group-${groupId}`;
        const sender = formatSender(stored);
        const content = await messagesToString([stored], resolveDesc);
        const timestamp = new Date(stored.time * 1000).toISOString();
        await graphiti.addEpisode(groupName, {
            // 系统消息 messageId 为 0，回退到数据库自增 id 保证 name 唯一
            name: `group_chat_msg_${stored.messageId || stored.id || 0}`,
            content: JSON.stringify({sender, content, timestamp, msg_id: stored.messageId}),
            source_description: `群聊 ${groupId}`,
            reference_time: timestamp
        });
    })().catch(err => {
        logger.error(`[Graphiti] [${groupId}] failed to add episode:`, err);
    });
}

/**
 * 将合并后的消息作为 episode 异步写入 Graphiti（fire-and-forget，内部捕获错误）。
 * 用于触发回复时，将多条消息合并为一个 episode，内容与模型看到的 user message 一致。
 */
export function addMergedMessagesEpisode (
    graphiti: GraphitiClient,
    groupId: number,
    mergedContent: string,
    messageIds: number[]
): void {
    void (async () => {
        const groupName = `group-${groupId}`;
        const timestamp = new Date().toISOString();
        // 使用第一条和最后一条消息 id 构建唯一 name
        const firstId = messageIds[0] || 0;
        const lastId = messageIds[messageIds.length - 1] || 0;
        const name = `group_merged_${firstId}_${lastId}`;

        await graphiti.addEpisode(groupName, {
            name,
            content: JSON.stringify({
                content: mergedContent,
                timestamp,
                message_count: messageIds.length,
                message_ids: messageIds
            }),
            source_description: `群聊 ${groupId} 合并消息`,
            reference_time: timestamp
        });
    })().catch(err => {
        logger.error(`[Graphiti] [${groupId}] failed to add merged messages episode:`, err);
    });
}

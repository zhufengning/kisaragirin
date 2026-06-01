import { Type } from '@earendil-works/pi-ai';
import type { Tool } from '@earendil-works/pi-ai';
import { Memory } from 'mem0ai/oss';
import type { MemoryConfig } from 'mem0ai/oss';
import { Logger } from '@lib/util/logger';

const searchMemorySchema = Type.Object({
    query: Type.String({ description: '搜索记忆的关键词或问题' }),
});

const addMemorySchema = Type.Object({
    content: Type.String({ description: '要记录的记忆内容，用简洁中文描述事实或偏好' }),
});

export function createMem0Tools(_config: MemoryConfig, _logLevel: string): Tool[] {
    const searchMemoryTool: Tool<typeof searchMemorySchema> = {
        name: 'search_memory',
        description: '搜索与你相关的历史记忆。当你需要回忆用户的偏好、过去提到的事实、或之前对话中的关键信息时使用此工具。',
        parameters: searchMemorySchema,
    };

    const addMemoryTool: Tool<typeof addMemorySchema> = {
        name: 'add_memory',
        description: '记录新的记忆。当你从对话中了解到关于用户的重要事实、偏好、习惯、或约定时使用此工具。内容应简洁、事实化。',
        parameters: addMemorySchema,
    };

    return [searchMemoryTool, addMemoryTool];
}

export async function executeMem0Tool(
    toolName: string,
    args: Record<string, unknown>,
    config: MemoryConfig,
    logLevel: string,
    groupId: number
): Promise<string> {
    const logger = new Logger(logLevel as 'debug' | 'info' | 'warn' | 'error');
    const userId = `group-${groupId}`;

    const memory = new Memory(config);

    if (toolName === 'search_memory') {
        try {
            const query = args.query as string;
            logger.debug(`[Mem0] search query="${query}" userId=${userId}`);
            const results = await memory.search(query, { topK: 10, filters: { user_id: userId } });
            const memories = results.results
                .map((r: { memory: string; score?: number }) => `- ${r.memory} (相关度: ${(r.score ?? 0 * 100).toFixed(1)}%)`)
                .join('\n');
            const output = memories || '未找到相关记忆。';
            logger.debug(`[Mem0] search found ${results.results.length} memories`);
            return output;
        } catch (e) {
            logger.error('[Mem0] search error:', e);
            return `搜索记忆失败: ${e instanceof Error ? e.message : String(e)}`;
        }
    }

    if (toolName === 'add_memory') {
        try {
            const content = args.content as string;
            logger.debug(`[Mem0] add content="${content}" userId=${userId}`);
            await memory.add(
                [{ role: 'user', content }],
                { userId }
            );
            logger.debug('[Mem0] add success');
            return '记忆已记录。';
        } catch (e) {
            logger.error('[Mem0] add error:', e);
            return `记录记忆失败: ${e instanceof Error ? e.message : String(e)}`;
        }
    }

    return `未知工具: ${toolName}`;
}

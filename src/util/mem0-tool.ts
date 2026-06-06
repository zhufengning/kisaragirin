import {Type} from '@earendil-works/pi-ai';
import type {AgentTool} from '@earendil-works/pi-agent-core';
import {Memory, type MemoryConfig} from 'mem0ai/oss';
import {Logger} from '@lib/util/logger';

const searchMemorySchema = Type.Object({
    query: Type.String({description: '搜索记忆的关键词或问题'})
});

const addMemorySchema = Type.Object({
    content: Type.String({description: '要记录的记忆内容，用简洁中文描述事实或偏好'})
});

export function createMem0Tools (config: MemoryConfig, _logLevel: string, groupId: number): AgentTool<any>[] {
    const logger = new Logger();
    const userId = `group-${groupId}`;
    const memory = new Memory(config);

    const searchMemoryTool: AgentTool<typeof searchMemorySchema> = {
        name: 'search_memory',
        label: '搜索记忆',
        description: '搜索与你相关的历史记忆。当你需要回忆用户的偏好、过去提到的事实、或之前对话中的关键信息时使用此工具。',
        parameters: searchMemorySchema,
        async execute (_toolCallId, params) {
            try {
                logger.debug(`[Mem0] search query="${params.query}" userId=${userId}`);
                const results = await memory.search(params.query, {topK: 10, filters: {user_id: userId}});
                const memories = results.results
                    .map((r: { memory: string; score?: number }) => {
                        const score = (r.score ?? 0) * 100;
                        return `- ${r.memory} (相关度: ${score.toFixed(1)}%)`;
                    })
                    .join('\n');
                const output = memories || '未找到相关记忆。';
                logger.debug(`[Mem0] search found ${results.results.length} memories`);
                return {
                    content: [{type: 'text', text: output}],
                    details: {count: results.results.length}
                };
            } catch (e) {
                logger.error('[Mem0] search error:', e);
                return {
                    content: [{type: 'text', text: `搜索记忆失败: ${e instanceof Error ? e.message : String(e)}`}],
                    details: {},
                    isError: true
                };
            }
        }
    };

    const addMemoryTool: AgentTool<typeof addMemorySchema> = {
        name: 'add_memory',
        label: '记录记忆',
        description: '记录新的记忆。当你从对话中了解到关于用户的重要事实、偏好、习惯、或约定时使用此工具。内容应简洁、事实化。',
        parameters: addMemorySchema,
        async execute (_toolCallId, params) {
            try {
                logger.debug(`[Mem0] add content="${params.content}" userId=${userId}`);
                await memory.add(
                    [{role: 'user', content: params.content}],
                    {userId}
                );
                logger.debug('[Mem0] add success');
                return {
                    content: [{type: 'text', text: '记忆已记录。'}],
                    details: {}
                };
            } catch (e) {
                logger.error('[Mem0] add error:', e);
                return {
                    content: [{type: 'text', text: `记录记忆失败: ${e instanceof Error ? e.message : String(e)}`}],
                    details: {},
                    isError: true
                };
            }
        }
    };

    return [searchMemoryTool, addMemoryTool];
}

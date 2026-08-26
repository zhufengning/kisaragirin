import {Type} from '@earendil-works/pi-ai';
import type {AgentTool} from '@earendil-works/pi-agent-core';
import type {GraphitiClient} from './graphiti-client';
import {Logger} from '@lib/util/logger';

const searchMemorySchema = Type.Object({
    query: Type.String({description: '搜索记忆的关键词或问题'})
});

export function createGraphitiTools (client: GraphitiClient, _logLevel: string, groupId: number): AgentTool[] {
    const logger = new Logger();
    const groupName = `group-${groupId}`;

    const searchMemoryTool: AgentTool<typeof searchMemorySchema> = {
        name: 'search_memory',
        label: '搜索记忆',
        description: '搜索与你相关的历史记忆。当你需要回忆用户的偏好、过去提到的事实、或之前对话中的关键信息时使用此工具。',
        parameters: searchMemorySchema,
        async execute (_toolCallId, params) {
            try {
                logger.debug(`[Graphiti] search query="${params.query}" group=${groupName}`);
                const results = await client.search(params.query, groupName, 10);
                const memories = results.results
                    .map(e => {
                        const timeInfo = e.valid_at ? ` (${e.valid_at.split('T')[0]})` : '';
                        return `- ${e.fact}${timeInfo}`;
                    })
                    .join('\n');
                const output = memories || '未找到相关记忆。';
                logger.debug(`[Graphiti] search found ${results.count} memories`);
                return {
                    content: [{type: 'text', text: output}],
                    details: {count: results.count}
                };
            } catch (e) {
                logger.error('[Graphiti] search error:', e);
                return {
                    content: [{type: 'text', text: `搜索记忆失败: ${e instanceof Error ? e.message : String(e)}`}],
                    details: {},
                    isError: true
                };
            }
        }
    };

    return [searchMemoryTool];
}

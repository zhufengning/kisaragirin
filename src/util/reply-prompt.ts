import type {AgentTool} from '@earendil-works/pi-agent-core';
import type {AssistantMessage} from '@earendil-works/pi-ai';
import {messagesToString, type StoredMessage} from '~/message-format';
import {prompts} from '~/prompts';
import type {DescQueue} from './desc-queue';

function formatToolParameters (toolSchema: AgentTool['parameters']): string {
    return JSON.stringify(toolSchema, null, 2);
}

export function formatToolsDescription (tools: AgentTool[]): string {
    if (tools.length === 0) return '无可用工具。';

    return tools
        .map(tool => {
            const params = formatToolParameters(tool.parameters);
            return `- ${tool.name}（${tool.label}）: ${tool.description}\n参数: ${params}`;
        })
        .join('\n');
}

export function buildSystemPrompt ({
    botName,
    botPersona,
    toolsDescription,
    groupCustomPrompt
}: {
    botName: string;
    botPersona: string;
    toolsDescription: string;
    groupCustomPrompt?: string;
}): string {
    const parts: string[] = [
        prompts.jailBreak,
        prompts.replyIdentity(botName),
        botPersona,
        '## 可用工具',
        toolsDescription,
        prompts.replyToolInstructions
    ];

    if (groupCustomPrompt) {
        parts.push(`${prompts.groupCustomPromptStart}\n${groupCustomPrompt}\n${prompts.groupCustomPromptEnd}`);
    }

    return parts.join('\n\n');
}

export async function buildUserPromptArray (
    latestMessages: StoredMessage[],
    descQueue: DescQueue
): Promise<string[]> {
    if (latestMessages.length === 0) return [];

    const body = await messagesToString(latestMessages, sha => descQueue.resolve(sha));
    if (!body.trim()) return [];

    return [body];
}

export function formatUsage (usage: AssistantMessage['usage']): string {
    const totalInput = usage.input + usage.cacheRead;
    const cacheRatio = totalInput > 0 ? ((usage.cacheRead / totalInput) * 100).toFixed(2) : '0.00';
    return `input=${usage.input} output=${usage.output} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite} cacheWrite1h=${usage.cacheWrite1h ?? 0} cacheRead/totalInput=${cacheRatio}%`;
}

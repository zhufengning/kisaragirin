import type {Model} from '@earendil-works/pi-ai';
import type {ThinkingLevel} from '@earendil-works/pi-agent-core';
import {
    InputConfig,
    type AppConfig,
    type ModelAssignmentKey,
    type ModelEntry,
    type ScheduledGroupTask
} from '../../../src/config';
import type {Prompts} from '../../../src/prompts';

export interface TestConfigOverrides {
    mergeWindowSeconds?: number;
    silenceWaitTimeMinutes?: number;
    replyProbability?: number;
    silenceRecentWindow?: number;
    silenceRecentBotThreshold?: number;
    silenceRecentBotMultiplier?: number;
    maxToolCallRounds?: number;
    maxDeepResearchRounds?: number;
    visionConcurrency?: number;
    visionMaxFrames?: number;
    visionThinkingLevel?: ThinkingLevel;
    agentHarness?: ModelAssignmentKey;
    vision?: ModelAssignmentKey;
    memoryKeyword?: ModelAssignmentKey;
    deepResearch?: string;
    enableEntitySearch?: boolean;
    scheduledTasks?: Record<number, ScheduledGroupTask[]>;
    logLevel?: 'debug' | 'info' | 'warn' | 'error';
    prompts?: Partial<Prompts>;
    debugDumpPrompt?: boolean;
}

export interface TestConfigInput extends TestConfigOverrides {
    onebotHost: string;
    onebotPort: number;
    openAiBaseUrl: string;
    groups: number[];
    logFile: string;
}

function testModel (id: string, baseUrl: string): Model<'openai-completions'> {
    return {
        id,
        name: id,
        provider: 'test-provider',
        baseUrl,
        api: 'openai-completions',
        reasoning: false,
        input: ['text', 'image'],
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
        contextWindow: 200000,
        maxTokens: 8192
    };
}

export function testGroupMarker (groupId: number): string {
    return `group-${groupId}`;
}

/** 构建指向假 OneBot、假 OpenAI 与假图床的测试配置 */
export function createTestConfig (input: TestConfigInput): AppConfig {
    const modelKeyToId: Record<string, string> = {
        'primary': 'primary',
        'secondary': 'secondary',
        'vision': 'vision',
        'vision-bad': 'vision-bad',
        'memory': 'memory',
        'research': 'research'
    };

    const models: Record<string, ModelEntry> = {};
    for (const [key, id] of Object.entries(modelKeyToId)) {
        models[key] = {model: testModel(id, input.openAiBaseUrl), apiKey: 'test-api-key'};
    }

    const groupCustomPrompts: Record<number, string> = {};
    for (const groupId of input.groups) {
        groupCustomPrompts[groupId] = `测试群标记:${testGroupMarker(groupId)}`;
    }

    const baseInput = new InputConfig();
    const appInput: InputConfig = {
        ...baseInput,
        group_whitelist: input.groups,
        merge_window: input.mergeWindowSeconds ?? 0.02,
        silence_wait_time: input.silenceWaitTimeMinutes ?? 10000,
        reply_probability: input.replyProbability ?? 0,
        silence_recent_window: input.silenceRecentWindow ?? 0,
        silence_recent_bot_threshold: input.silenceRecentBotThreshold ?? 0,
        silence_recent_bot_multiplier: input.silenceRecentBotMultiplier ?? 1,
        max_tool_call_rounds: input.maxToolCallRounds ?? 5,
        max_deep_research_rounds: input.maxDeepResearchRounds ?? 3,
        vision_concurrency: input.visionConcurrency ?? 2,
        vision_max_frames: input.visionMaxFrames ?? 5,
        vision_thinking_level: input.visionThinkingLevel ?? 'off',
        bot_name: '测试机器人',
        bot_persona: '测试用机器人',
        group_custom_prompts: groupCustomPrompts,
        scheduled_tasks: input.scheduledTasks,
        prompts: input.prompts ?? {},
        debug_dump_prompt: input.debugDumpPrompt ?? false
    };

    return {
        onebot: {
            host: input.onebotHost,
            port: input.onebotPort,
            access_token: 'test-token',
            mode: 'ws'
        },
        log: {
            level: input.logLevel ?? 'info',
            file: input.logFile
        },
        input: appInput,
        web: {
            host: '127.0.0.1',
            port: 0,
            username: 'test',
            password: 'test'
        },
        ai: {
            models,
            assignments: {
                vision: input.vision ?? 'vision',
                deep_research: input.deepResearch ?? 'research',
                agent_harness: input.agentHarness ?? 'primary',
                memory_keyword: input.memoryKeyword
            },
            memoryKeyword: input.memoryKeyword === undefined ? undefined : {
                enable_entity_search: input.enableEntitySearch ?? false
            }
        }
    };
}

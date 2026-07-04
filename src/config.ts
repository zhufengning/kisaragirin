import type {Model, Api} from '@earendil-works/pi-ai';
import type {MemoryConfig} from 'mem0ai/oss';

export interface OneBotConfig {
    host: string;
    port: number;
    access_token?: string;
    mode: 'ws' | 'ws-reverse';
}

export interface LogConfig {
    level: 'debug' | 'info' | 'warn' | 'error';
    file?: string;
}

export class InputConfig {
    group_whitelist!: number[];
    merge_window = 30;
    silence_wait_time = 30;
    reply_probability = 0.1;
    max_tool_call_rounds = 5;
    vision_concurrency = 5;
    bot_name?: string;
    bot_persona?: string;
    group_custom_prompts?: Record<number, string>;
    scheduled_tasks?: Record<number, ScheduledGroupTask[]>;
    debug_dump_prompt = false;
}

export interface ScheduledGroupTask {
    name?: string;
    cron: string;
    timezone?: string;
    prompt: string;
    deep_research_topic?: string;
    enabled?: boolean;
}

export interface WebPanelConfig {
    host: string;
    port: number;
    username: string;
    password: string;
}

export interface ModelEntry {
    model: Model<Api>;
    apiKey: string;
}

export interface AiConfig {
    models: Record<string, ModelEntry>;
    assignments: {
        vision: string;
        deep_research: string;
        /** Agent harness 模型 */
        agent_harness: string;
    };
    mem0?: MemoryConfig;
}

export interface AppConfig {
    onebot: OneBotConfig;
    log: LogConfig;
    input: InputConfig;
    web: WebPanelConfig;
    ai: AiConfig;
}

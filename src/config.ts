import type { Model, Api } from '@earendil-works/pi-ai';
import type { MemoryConfig } from 'mem0ai/oss';

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

export interface InputConfig {
    group_whitelist: number[];
    merge_window?: number;
    silence_wait_time?: number;
    reply_probability?: number;
    max_msg_count?: number;
    max_tool_call_rounds?: number;
    bot_name?: string;
    bot_persona?: string;
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
        reply: string;
        deep_research: string;
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

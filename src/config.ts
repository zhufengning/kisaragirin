import type { Model, Api } from '@earendil-works/pi-ai';

export interface OneBotConfig {
    host: string;
    port: number;
    access_token?: string;
    log_level: 'debug' | 'info' | 'warn' | 'error';
    mode: 'ws' | 'ws-reverse';
}

export interface InputConfig {
    group_whitelist: number[];
    merge_window?: number;
    silence_wait_time?: number;
    reply_probability?: number;
    max_msg_count?: number;
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
}

export interface AppConfig {
    onebot: OneBotConfig;
    input: InputConfig;
    web: WebPanelConfig;
    ai: AiConfig;
}

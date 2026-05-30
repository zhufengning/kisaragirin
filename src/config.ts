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
    assignments: Record<string, string>;
}

export interface AppConfig {
    onebot: OneBotConfig;
    input: InputConfig;
    web: WebPanelConfig;
    ai: AiConfig;
}

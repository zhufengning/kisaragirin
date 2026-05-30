import { readFileSync } from 'fs';
import { parse } from 'smol-toml';

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

export interface AppConfig {
    onebot: OneBotConfig;
    input: InputConfig;
    web: WebPanelConfig;
}

export function loadConfig(path = './config.toml'): AppConfig {
    const raw = readFileSync(path, 'utf-8');
    return parse(raw) as unknown as AppConfig;
}

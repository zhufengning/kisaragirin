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

export interface InputConfig {
    group_whitelist: number[];
    merge_window?: number;
    silence_wait_time?: number;
    reply_probability?: number;
    max_msg_count?: number;
    max_tool_call_rounds?: number;
    vision_concurrency?: number;
    bot_name?: string;
    bot_persona?: string;
    /** 触发 auto compact 的 context window 使用百分比阈值 (0.0-1.0)，默认 0.7 */
    auto_compact_threshold?: number;
    /** compact 后保留的最近消息估算 token 数，默认 20000 */
    auto_compact_keep_recent?: number;
    /** 为 LLM 响应预留的 token 数，默认 8000 */
    auto_compact_reserve_tokens?: number;
    /** 按群号配置的专属提示词，注入在 system prompt 人设之后 */
    group_custom_prompts?: Record<number, string>;
    /** 调试：每次第一轮回复前将 system/user prompt 原始数据写入文件，默认 false */
    debug_dump_prompt?: boolean;
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
        /** 预生成记忆查询关键词的模型 */
        memory_keyword: string;
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

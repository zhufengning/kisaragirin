import type {Model, Api} from '@earendil-works/pi-ai';
import type {Prompts} from './prompts';

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
    /** 覆盖 src/prompts.ts 中 `Prompts` 类的默认 prompt（如 rules、deepResearchSystem 等） */
    prompts: Partial<Prompts> = {};
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

export interface GraphitiConfig {
    /** uv 可执行文件路径，默认 uv */
    uv_path?: string;
    neo4j_uri?: string;
    neo4j_user?: string;
    neo4j_password?: string;
    llm: {
        api_key: string;
        model: string;
        small_model?: string;
        base_url?: string;
        temperature?: number;
        max_tokens?: number;
    };
    embedder: {
        api_key: string;
        model: string;
        dimension?: number;
        base_url?: string;
    };
    reranker?: {
        api_key: string;
        model: string;
        base_url?: string;
    };
}

export interface AiConfig {
    models: Record<string, ModelEntry>;
    assignments: {
        vision: string;
        deep_research: string;
        /** Agent harness 模型 */
        agent_harness: string;
        /** 记忆关键词生成模型 */
        memory_keyword?: string;
    };
    graphiti?: GraphitiConfig;
}

export interface AppConfig {
    onebot: OneBotConfig;
    log: LogConfig;
    input: InputConfig;
    web: WebPanelConfig;
    ai: AiConfig;
}

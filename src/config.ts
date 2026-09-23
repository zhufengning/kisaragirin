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
    /** 每个任务内允许的最大深度研究次数（深度研究轮可链式再次请求研究，达到上限后忽略），默认 3 */
    max_deep_research_rounds = 3;
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
    /** 是否 dump JSON-RPC 报文，默认 false */
    debug_dump_rpc?: boolean;
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
        /** 所用模型/端点默认开启深度思考时设为 true，注入 thinking=disabled，默认 false */
        disable_thinking?: boolean;
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

/**
 * 模型 assignment key 或回退链（元组）。
 * 配置为数组时，API 错误按数组顺序依次回退到下一个模型；
 * 单字符串等价于长度为 1 的数组。
 */
export type ModelAssignmentKey = string | string[];

/** 单个时段模型配置 */
export interface TimeSlot {
    /** 起始时间 HH:mm（24h） */
    start: string;
    /** 结束时间 HH:mm（24h），支持跨日（如 start=18:00 end=09:00 表示 18:00 至次日 09:00） */
    end: string;
    /** 该时段使用的模型 assignment key（或回退链），对应 ai.models 中的 key */
    model: ModelAssignmentKey;
}

/** 时段模型调度配置 */
export interface ScheduledModelAssignment {
    /** 各时段模型配置，按数组顺序匹配，第一个命中的生效 */
    slots: TimeSlot[];
    /** 不在任何 slot 范围内时的默认模型 assignment key（或回退链） */
    default: ModelAssignmentKey;
}

export interface AiConfig {
    models: Record<string, ModelEntry>;
    assignments: {
        vision: ModelAssignmentKey | ScheduledModelAssignment;
        deep_research: ModelAssignmentKey | ScheduledModelAssignment;
        /** Agent harness 模型 */
        agent_harness: ModelAssignmentKey | ScheduledModelAssignment;
        /** 记忆关键词生成模型 */
        memory_keyword?: ModelAssignmentKey | ScheduledModelAssignment;
    };
    graphiti?: GraphitiConfig;
    /** 记忆关键词生成模型的额外配置 */
    memoryKeyword?: {
        /** 所用模型/端点默认开启深度思考时设为 true，调用时注入 thinking=disabled，默认 false */
        disable_thinking?: boolean;
    };
}

export interface AppConfig {
    onebot: OneBotConfig;
    log: LogConfig;
    input: InputConfig;
    web: WebPanelConfig;
    ai: AiConfig;
}

import type { AppConfig } from './src/config';
import type { Model, Api } from '@earendil-works/pi-ai';

const openaiCompatBase = {
    api: 'openai-completions' as const,
    reasoning: false,
    input: ['text', 'image'] as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
};

const anthropicCompatBase = {
    api: 'anthropic-messages' as const,
    reasoning: false,
    input: ['text', 'image'] as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
};

const OCG_KEY = '';

function ocgOpenai(id: string, name: string): { model: Model<Api>; apiKey: string } {
    return {
        model: { id, name, provider: 'opencode', baseUrl: 'https://opencode.ai/zen/go/v1', ...openaiCompatBase } satisfies Model<Api>,
        apiKey: OCG_KEY,
    };
}

function ocgAnthropic(id: string, name: string, baseUrl = 'https://opencode.ai/zen/go'): { model: Model<Api>; apiKey: string } {
    return {
        model: { id, name, provider: 'opencode', baseUrl, ...anthropicCompatBase } satisfies Model<Api>,
        apiKey: OCG_KEY,
    };
}

export const config: AppConfig = {
    onebot: {
        host: '127.0.0.1',
        port: 6102,
        access_token: '',
        mode: 'ws',
    },
    log: {
        level: 'debug',
        file: 'data/app.log',
    },
    input: {
        group_whitelist: [],
        merge_window: 30,
        silence_wait_time: 30,
        reply_probability: 0.1,
        max_msg_count: 50,
        max_tool_call_rounds: 5,
        vision_concurrency: 5,
        bot_name: '',
        bot_persona: '',
        auto_compact_threshold: 0.7,
        auto_compact_keep_recent: 20000,
        auto_compact_reserve_tokens: 8000,
    },
    web: {
        host: '0.0.0.0',
        port: 8080,
        username: 'admin',
        password: '',
    },
    ai: {
        models: {
            qwen: {
                model: {
                    id: 'qwen-vl-max',
                    name: 'Qwen VL Max',
                    provider: 'custom',
                    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
                    ...openaiCompatBase,
                } satisfies Model<Api>,
                apiKey: '',
            },
            'ocg-glm-5.1': ocgOpenai('glm-5.1', 'OpenCode GLM 5.1'),
            'ocg-glm-5': ocgOpenai('glm-5', 'OpenCode GLM 5'),
            'ocg-kimi-k2.5': ocgOpenai('kimi-k2.5', 'OpenCode Kimi K2.5'),
            'ocg-kimi-k2.6': ocgOpenai('kimi-k2.6', 'OpenCode Kimi K2.6'),
            'ocg-deepseek-v4-pro': ocgOpenai('deepseek-v4-pro', 'OpenCode DeepSeek V4 Pro'),
            'ocg-deepseek-v4-flash': ocgOpenai('deepseek-v4-flash', 'OpenCode DeepSeek V4 Flash'),
            'ocg-mimo-v2.5': ocgOpenai('mimo-v2.5', 'OpenCode MIMO V2.5'),
            'ocg-mimo-v2.5-pro': ocgOpenai('mimo-v2.5-pro', 'OpenCode MIMO V2.5 Pro'),
            'ocg-qwen3.7-max': ocgAnthropic('qwen3.7-max', 'OpenCode Qwen 3.7 Max', 'https://opencode.ai/zen/go/'),
            'ocg-minimax-m2.7': ocgAnthropic('minimax-m2.7', 'OpenCode MiniMax M2.7'),
            'ocg-minimax-m2.5': ocgAnthropic('minimax-m2.5', 'OpenCode MiniMax M2.5'),
            'ocg-qwen3.6-plus': ocgOpenai('qwen3.6-plus', 'OpenCode Qwen 3.6 Plus'),
            'ocg-qwen3.5-plus': ocgOpenai('qwen3.5-plus', 'OpenCode Qwen 3.5 Plus'),
            'hermes': {
                model: {
                    id: 'sec-bot',
                    name: 'Hermes Sec-Bot',
                    provider: 'openai',
                    baseUrl: 'http://127.0.0.1:8642/v1',
                    ...openaiCompatBase,
                } satisfies Model<Api>,
                apiKey: '',
            },
        },
        assignments: {
            vision: 'qwen',
            reply: 'ocg-qwen3.7-max',
            deep_research: 'hermes',
            memory_keyword: 'ocg-minimax-m2.5',
        },
        mem0: {
            embedder: {
                provider: 'openai',
                config: {
                    apiKey: '',
                    model: 'Qwen/Qwen3-Embedding-8B',
                    baseURL: 'https://api.siliconflow.cn/v1',
                    embeddingDims: 2560,
                },
            },
            vectorStore: {
                provider: 'qdrant',
                config: {
                    collectionName: 'memories',
                    dimension: 2560,
                    host: '127.0.0.1',
                    port: 6333,
                },
            },
            llm: {
                provider: 'openai',
                config: {
                    apiKey: '',
                    model: 'MiniMax-M2.5',
                    baseURL: 'https://opencode.ai/zen/go/v1',
                },
            },
            historyDbPath: 'data/mem0-history.db',
        },
    },
};

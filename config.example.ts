import { InputConfig, type AppConfig } from './src/config';
import type { Model, Api } from '@earendil-works/pi-ai';

const anthropicCompatBase = {
    api: 'anthropic-messages' as const,
    reasoning: false,
    input: ['text', 'image'] as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
};

const MINIMAX_KEY = '';

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
        ...new InputConfig(),
        group_whitelist: [],
        bot_name: '',
        bot_persona: '',
        /** 按群号配置的专属提示词，注入在 system prompt 人设之后 */
        group_custom_prompts: {
            // 123456789: '本群是技术讨论群，请以技术讨论为主，减少闲聊。\n当群友讨论CTF题目时，可以使用深度研究帮助搜索writeup。',
        },
        /** 是否将每次回复的 prompt 与模型输出保存到 data/debug/，默认 false */
        debug_dump_prompt: false,
    },
    web: {
        host: '0.0.0.0',
        port: 8080,
        username: 'admin',
        password: '',
    },
    ai: {
        models: {
            'minimax-m3': {
                model: {
                    id: 'MiniMax-M3',
                    name: 'MiniMax M3',
                    provider: 'minimax',
                    baseUrl: 'https://api.minimaxi.com/anthropic',
                    ...anthropicCompatBase,
                } satisfies Model<Api>,
                apiKey: MINIMAX_KEY,
            },
            'hermes': {
                model: {
                    id: 'sec-bot',
                    name: 'Hermes Sec-Bot',
                    provider: 'openai',
                    baseUrl: 'http://127.0.0.1:8642/v1',
                    api: 'openai-completions' as const,
                    reasoning: false,
                    input: ['text', 'image'] as ('text' | 'image')[],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128000,
                    maxTokens: 8192,
                } satisfies Model<Api>,
                apiKey: '',
            },
        },
        assignments: {
            vision: 'minimax-m3',
            reply: 'minimax-m3',
            deep_research: 'hermes',
            memory_keyword: 'minimax-m3',
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
                provider: 'anthropic',
                config: {
                    apiKey: MINIMAX_KEY,
                    model: 'MiniMax-M3',
                    baseURL: 'https://api.minimaxi.com/anthropic',
                },
            },
            historyDbPath: 'data/mem0-history.db',
        },
    },
};

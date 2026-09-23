import {InputConfig, type AppConfig} from './src/config';
import type {Model, Api} from '@earendil-works/pi-ai';

const anthropicCompatBase = {
    api: 'anthropic-messages' as const,
    reasoning: false,
    input: ['text', 'image'] as ('text' | 'image')[],
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
    contextWindow: 128000,
    maxTokens: 8192
};

const MINIMAX_KEY = '';

const minimaxM3Model = {
    model: {
        id: 'MiniMax-M3',
        name: 'MiniMax M3',
        provider: 'minimax',
        baseUrl: 'https://api.minimaxi.com/anthropic',
        ...anthropicCompatBase
    } satisfies Model<Api>,
    apiKey: MINIMAX_KEY
};

export const config: AppConfig = {
    onebot: {
        host: '127.0.0.1',
        port: 6102,
        access_token: '',
        mode: 'ws'
    },
    log: {
        level: 'debug',
        file: 'data/app.log'
    },
    input: {
        ...new InputConfig(),
        group_whitelist: [],
        bot_name: '',
        bot_persona: '',
        /** 覆盖 src/prompts.ts 中 `Prompts` 类的默认 prompt（rules、deepResearchSystem 等）。未覆盖的成员使用 prompts.ts 中的通用默认值 */
        prompts: {
            // rules: `1. 认清自己的身份：你是群聊机器人，不是人类。\n2. 回复应简洁、自然，直接讨论话题本身。`,
            // deepResearchSystem: `你是一个研究助手。请对用户给出的主题进行研究，提供准确、有条理的分析报告。`,
        },
        /** 按群号配置的专属提示词，注入在 system prompt 人设之后 */
        group_custom_prompts: {
            // 123456789: '本群是技术讨论群，请以技术讨论为主，减少闲聊。\n当群友讨论CTF题目时，可以使用深度研究帮助搜索writeup。',
        },
        /** 按群号配置 crontab-like 定时任务，cron 支持 5/6/7 字段和 timezone */
        scheduled_tasks: {
            // 123456789: [
            //     {
            //         name: 'daily-news',
            //         cron: '0 9 * * *',
            //         timezone: 'Asia/Shanghai',
            //         prompt: '请结合最近群聊，发起一个今日安全新闻简评。',
            //         deep_research_topic: '今日网络安全重要新闻',
            //     },
            // ],
        },
        /** 是否将每次回复的 prompt 与模型输出保存到 data/debug/，默认 false */
        debug_dump_prompt: false
        /** 每个任务内允许的最大深度研究次数（研究轮可链式再次请求研究），默认 3 */
        // max_deep_research_rounds: 3,
    },
    web: {
        host: '0.0.0.0',
        port: 8080,
        username: 'admin',
        password: ''
    },
    ai: {
        models: {
            'minimax-m3': minimaxM3Model,
            'agent_harness': minimaxM3Model,
            'hermes': {
                model: {
                    id: 'sec-bot',
                    name: 'Hermes Sec-Bot',
                    provider: 'openai',
                    baseUrl: 'http://127.0.0.1:8642/v1',
                    api: 'openai-completions' as const,
                    reasoning: false,
                    input: ['text', 'image'] as ('text' | 'image')[],
                    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
                    contextWindow: 128000,
                    maxTokens: 8192
                } satisfies Model<Api>,
                apiKey: ''
            }
        },
        assignments: {
            vision: 'minimax-m3',
            // 简单字符串用法（直接指定模型）
            agent_harness: 'minimax-m3',
            // 元组用法：API 错误时按数组顺序回退到下一个模型
            // agent_harness: ['minimax-m3', 'hermes'],
            // 时段调度用法示例（按时段选择不同模型，支持跨日）
            // agent_harness: {
            //     slots: [
            //         {start: '12:00', end: '14:00', model: ['minimax-m3', 'hermes']},  // slot 也支持元组回退
            //         {start: '18:00', end: '09:00', model: 'minimax-m3'},  // 跨日：18:00 ~ 次日 09:00
            //     ],
            //     default: ['hermes', 'minimax-m3']  // default 也支持元组回退
            // },
            deep_research: 'hermes',
            memory_keyword: 'minimax-m3'
        },
        /** 记忆关键词生成模型配置 */
        memoryKeyword: {
            // 所用模型/端点默认开启深度思考时设为 true，调用时注入 thinking=disabled
            disable_thinking: false
        },
        graphiti: {
            debug_dump_rpc: false,
            neo4j_uri: 'bolt://127.0.0.1:7687',
            neo4j_user: 'neo4j',
            neo4j_password: 'password',
            llm: {
                api_key: MINIMAX_KEY,
                model: 'MiniMax-M3',
                base_url: 'https://api.minimaxi.com/anthropic/v1',
                // 所用模型/端点默认开启深度思考时设为 true，注入 thinking=disabled
                disable_thinking: false
            },
            embedder: {
                api_key: '',
                model: 'Qwen/Qwen3-Embedding-8B',
                dimension: 2560,
                base_url: 'https://api.siliconflow.cn/v1'
            },
            reranker: {
                api_key: '',
                model: 'Qwen/Qwen3-Reranker-8B',
                base_url: 'https://api.siliconflow.cn/v1'
            }
        }
    }
};

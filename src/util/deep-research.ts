import {insertSystemMessage, type Db} from '~/db';
import type {AppConfig, PiRpcConfig} from '~/config';
import type {StoredMessage} from '~/message-format';
import type {DescQueue} from './desc-queue';
import type {Logger} from '@lib/util/logger';
import type {ReplyDebugDumper} from './reply-debug';
import type {GraphitiClient} from './graphiti-client';
import {addMessageEpisode} from './graphiti-episode';
import {runPiRpcPrompt} from './pi-rpc-client';
import {resolveModelEntry} from './models-factory';
import {formatUsage} from './reply-prompt';
import {prompts} from '~/prompts';
import {type AssistantMessage, type Context, type Models} from '@earendil-works/pi-ai';

/** 模型路径（LLM 兼容接口）单次研究的超时时间（毫秒） */
const MODEL_DEEP_RESEARCH_TIMEOUT_MS = 1_800_000;

function extractText (response: AssistantMessage): string {
    return response.content
        .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
        .map(c => c.text)
        .join('')
        .trim();
}

/**
 * 深度研究执行：字符串 assignment 用 `ai.models` 中的模型通过 LLM 兼容接口发起单次研究，
 * 对象 assignment 用 pi rpc 子进程执行，并把开始/结果/结束写入系统消息与记忆。
 */
export class DeepResearchRunner {
    private readonly db: Db;
    private readonly groupId: number;
    private readonly config: AppConfig;
    private readonly logger: Logger;
    private readonly descQueue: DescQueue;
    private readonly graphiti: GraphitiClient | null;
    private readonly debug: ReplyDebugDumper;
    private readonly models: Models;

    constructor (options: {
        db: Db;
        groupId: number;
        config: AppConfig;
        logger: Logger;
        descQueue: DescQueue;
        graphiti: GraphitiClient | null;
        debug: ReplyDebugDumper;
        models: Models;
    }) {
        this.db = options.db;
        this.groupId = options.groupId;
        this.config = options.config;
        this.logger = options.logger;
        this.descQueue = options.descQueue;
        this.graphiti = options.graphiti;
        this.debug = options.debug;
        this.models = options.models;
    }

    async runWithSystemMessages (topic: string): Promise<{result: string; success: boolean}> {
        const researchTopic = topic.trim();
        const startTime = Math.floor(Date.now() / 1000);
        const startText = `开始深度研究：${researchTopic}`;
        const startId = await insertSystemMessage(this.db, this.groupId, startText, startTime);
        this.logger.info(
            `[ReplyAgent] [${this.groupId}] system message inserted, id=${startId}, ` +
            `text=${startText.slice(0, 50)}${startText.length > 50 ? '...' : ''}`);

        let researchResult: string | undefined;
        let researchError: string | undefined;

        try {
            researchResult = await this.invokeResearch(researchTopic);
            this.logger.debug(`[ReplyAgent] [${this.groupId}] deep research done length=${researchResult.length}`);
            if (researchResult) {
                await this.insertResultMessage(researchTopic, researchResult);
            } else {
                this.logger.error(`[ReplyAgent] [${this.groupId}] deep research returned empty result`);
                researchError = '深度研究未能获取结果';
                researchResult = '（深度研究未能获取结果，请根据你已有的知识直接回复。）';
            }
        } catch (err) {
            this.logger.error(`[ReplyAgent] [${this.groupId}] deep research failed:`, err);
            researchError = err instanceof Error ? err.message : String(err);
            researchResult = '（深度研究失败，请根据你已有的知识直接回复。）';
        } finally {
            await this.insertEndMessage(researchTopic, researchError, researchResult);
        }

        return {result: researchResult, success: researchError === undefined};
    }

    private async invokeResearch (topic: string): Promise<string> {
        const assignment = this.config.ai.assignments.deep_research;
        if (typeof assignment === 'string') {
            return this.invokeModel(assignment, topic);
        }
        return this.invokePiRpc(assignment, topic);
    }

    /** 字符串 assignment：使用 ai.models 中的模型，通过 LLM 兼容接口发起单次研究 */
    private async invokeModel (modelKey: string, topic: string): Promise<string> {
        const modelEntry = resolveModelEntry(this.config, modelKey);
        this.logger.debug(
            `[ReplyAgent] [${this.groupId}] model deep research start model=${modelEntry.model.name} topic=${topic}`);

        const context: Context = {
            messages: [{
                role: 'user',
                content: `${prompts.deepResearchSystem}\n请深度研究以下主题：\n${topic}`,
                timestamp: Date.now()
            }]
        };
        const dumpPrefix = this.debug.dumpDeepResearchModelPrompt(context);

        let response: AssistantMessage | undefined;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), MODEL_DEEP_RESEARCH_TIMEOUT_MS);

            response = await this.models.completeSimple(modelEntry.model, context, {
                apiKey: modelEntry.apiKey,
                signal: controller.signal,
                timeoutMs: MODEL_DEEP_RESEARCH_TIMEOUT_MS,
                onPayload: payload => {
                    this.debug.dumpDeepResearchModelPayload(dumpPrefix, payload);
                }
            });

            clearTimeout(timeoutId);
            this.debug.dumpDeepResearchModelConversation(context, response);

            if (response.stopReason === 'error' || response.stopReason === 'aborted') {
                throw new Error(response.errorMessage || `Deep research stopped: ${response.stopReason}`);
            }

            this.logger.info(`[ReplyAgent] [${this.groupId}] deep research usage: ${formatUsage(response.usage)}`);

            const text = extractText(response);
            this.logger.debug(`[ReplyAgent] [${this.groupId}] model deep research done text length=${text.length}`);
            return text;
        } catch (err) {
            if (!response) {
                this.debug.dumpDeepResearchModelConversation(context, undefined, err);
            }
            throw err;
        }
    }

    /** 对象 assignment：pi CLI rpc 模式子进程，使用 pi 自己的模型与工具 */
    private async invokePiRpc (rpcConfig: PiRpcConfig, topic: string): Promise<string> {
        const message = `${prompts.deepResearchSystem}\n请深度研究以下主题：\n${topic}`;

        this.debug.dumpDeepResearchRpcPrompt(rpcConfig, message);
        this.logger.debug(
            `[ReplyAgent] [${this.groupId}] pi rpc deep research start command=${
                rpcConfig.command ?? 'pi'} cwd=${rpcConfig.cwd ?? process.cwd()}`);

        const text = await runPiRpcPrompt({
            command: rpcConfig.command,
            args: rpcConfig.args,
            env: rpcConfig.env,
            cwd: rpcConfig.cwd,
            message,
            timeoutMs: rpcConfig.timeout_ms
        });

        this.debug.dumpDeepResearchRpcResult(text);
        this.logger.debug(`[ReplyAgent] [${this.groupId}] pi rpc deep research done length=${text.length}`);
        return text;
    }

    private async insertResultMessage (topic: string, result: string): Promise<void> {
        const resultTime = Math.floor(Date.now() / 1000);
        const resultText = `深度研究结果：${topic}\n\n${result}`;
        const resultId = await insertSystemMessage(this.db, this.groupId, resultText, resultTime);
        this.logger.info(
            `[ReplyAgent] [${this.groupId}] deep research result message inserted, id=${resultId}, ` +
            `topic=${topic.slice(0, 50)}${topic.length > 50 ? '...' : ''}`);

        // 深度研究结果也写入 Graphiti 记忆
        if (this.graphiti) {
            const resultStored: StoredMessage = {
                id: resultId,
                time: resultTime,
                messageId: 0,
                senderId: 0,
                senderName: '系统',
                isBot: true,
                isAtBot: false,
                segments: [{type: 'system', text: resultText}]
            };
            addMessageEpisode(this.graphiti, this.groupId, resultStored,
                sha => this.descQueue.resolve(sha));
        }
    }

    private async insertEndMessage (
        topic: string,
        researchError: string | undefined,
        researchResult: string | undefined
    ): Promise<void> {
        const endTime = Math.floor(Date.now() / 1000);
        let endMsg: string;
        if (researchError) {
            endMsg = `深度研究结束：${topic}状态：错误\n\n${researchError}`;
        } else if (researchResult) {
            endMsg = `深度研究结束：${topic}状态：成功\n\n`;
        } else {
            endMsg = `深度研究结束：${topic}状态：未出错但无结果\n\n`;
        }
        const endId = await insertSystemMessage(this.db, this.groupId, endMsg, endTime);
        this.logger.info(
            `[ReplyAgent] [${this.groupId}] system message inserted, id=${endId}, ` +
            `text=${endMsg.slice(0, 50)}${endMsg.length > 50 ? '...' : ''}`);
    }
}

import {insertSystemMessage, type Db} from '~/db';
import type {AppConfig, PiRpcConfig} from '~/config';
import type {StoredMessage} from '~/message-format';
import type {DescQueue} from './desc-queue';
import type {Logger} from '@lib/util/logger';
import type {ReplyDebugDumper} from './reply-debug';
import type {GraphitiClient} from './graphiti-client';
import {addMessageEpisode} from './graphiti-episode';
import {runPiRpcPrompt} from './pi-rpc-client';
import {prompts} from '~/prompts';

/** 深度研究执行：调用 pi rpc 子进程并把开始/结果/结束写入系统消息与记忆 */
export class DeepResearchRunner {
    private readonly db: Db;
    private readonly groupId: number;
    private readonly config: AppConfig;
    private readonly logger: Logger;
    private readonly descQueue: DescQueue;
    private readonly graphiti: GraphitiClient | null;
    private readonly debug: ReplyDebugDumper;

    constructor (options: {
        db: Db;
        groupId: number;
        config: AppConfig;
        logger: Logger;
        descQueue: DescQueue;
        graphiti: GraphitiClient | null;
        debug: ReplyDebugDumper;
    }) {
        this.db = options.db;
        this.groupId = options.groupId;
        this.config = options.config;
        this.logger = options.logger;
        this.descQueue = options.descQueue;
        this.graphiti = options.graphiti;
        this.debug = options.debug;
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
            researchResult = await this.invokePiRpc(researchTopic);
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

    private async invokePiRpc (topic: string): Promise<string> {
        const assignment = this.config.ai.assignments.deep_research;
        const rpcConfig: PiRpcConfig = typeof assignment === 'string' ? {command: assignment} : assignment;
        const message = `${prompts.deepResearchSystem}\n请深度研究以下主题：\n${topic}`;

        this.debug.dumpDeepResearchPrompt(rpcConfig, message);
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

        this.debug.dumpDeepResearchResult(text);
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

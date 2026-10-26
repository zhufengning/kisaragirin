import {createBot} from '@lib';
import type {Bot, GroupMessageEvent} from '@lib/types';
import type {MutableModels} from '@earendil-works/pi-ai';
import type {AppConfig} from './config';
import {applyPromptsOverrides} from './prompts';
import {registerCustomProviders} from './util/models-factory';
import {
    groupMessageEventToStoredMessage,
    collectImageSha256FromSegment,
    type StoredSegment
} from './message-format';
import {createDb, schema, runMigrations, closeDb, type Db} from './db';
import {createWebPanel} from './web/server';
import {DescQueue, type DescQueueOptions} from './util/desc-queue';
import {GroupReplyManager} from './util/reply-manager';
import {ScheduledTaskManager} from './util/scheduled-tasks';
import {closeAllSessions} from './util/harness-factory';
import {Logger, configureLogger} from '@lib/util/logger';
import {GraphitiClient} from './util/graphiti-client';
import {join} from 'node:path';
import {rmSync, existsSync} from 'node:fs';

export interface ApplicationOptions {
    config: AppConfig;
    models: MutableModels;
    /** 假 Graphiti server 文件路径，默认 graphiti/server.py */
    graphitiServerPath?: string;
    /** 是否启动 Astro Web 面板，默认启动 */
    enableWebPanel?: boolean;
    /** 图片描述队列的超时参数，生产使用默认值 */
    descQueue?: Pick<DescQueueOptions, 'describeTimeoutMs' | 'abortSettleGraceMs'>;
    /** SQLite 文件路径，默认 ./data.db */
    dbPath?: string;
}

export interface Application {
    start(): Promise<void>;
    ready(): Promise<void>;
    stop(): Promise<void>;
}

interface ApplicationState {
    bot: Bot;
    db: Db;
    descQueue: DescQueue;
    replyManagers: Map<number, GroupReplyManager>;
    graphiti?: GraphitiClient;
    panel: {start: () => void; stop: () => void};
    scheduledTaskManager: ScheduledTaskManager | null;
    ingressQueues: Map<number, Promise<void>>;
    botSelfId: number;
    botName: string;
    botInfoReady: boolean;
    stopping: boolean;
    readySettled: boolean;
    resolveReady: () => void;
}

export function createApplication (options: ApplicationOptions): Application {
    const {config, models} = options;
    const logger = new Logger();
    let state: ApplicationState | null = null;
    let startPromise: Promise<void> | null = null;
    let readyPromise: Promise<void> | null = null;

    const createState = async (): Promise<ApplicationState> => {
        configureLogger(config.log.level, config.log.file);
        applyPromptsOverrides(config.input.prompts);

        const debugDir = join(process.cwd(), 'data', 'debug');
        if (existsSync(debugDir)) {
            rmSync(debugDir, {recursive: true, force: true});
            logger.info('[Bot] cleaned debug dump directory');
        }

        registerCustomProviders(models, config);
        logger.debug('[Bot] registered providers from ai.models');

        const bot = createBot(config.onebot);
        const db = createDb(options.dbPath ?? './data.db');
        await runMigrations(db);
        const descQueue = new DescQueue({db, config, models, ...options.descQueue});

        globalThis.__db__ = db;
        globalThis.__queue__ = descQueue;
        globalThis.__config__ = config;
        globalThis.__models__ = models;

        let graphiti: GraphitiClient | undefined;
        if (config.ai.graphiti) {
            const graphitiConfig = config.ai.graphiti;
            const serverPath = options.graphitiServerPath ?? join(process.cwd(), 'graphiti', 'server.py');
            const debugPrefix = graphitiConfig.debug_dump_rpc ?
                'graphiti' :
                undefined;
            graphiti = new GraphitiClient({
                serverPath,
                uvPath: graphitiConfig.uv_path ?? 'uv',
                debugDumpRpc: graphitiConfig.debug_dump_rpc ?? false,
                debugPrefix
            });
            await graphiti.initialize({
                neo4j_uri: graphitiConfig.neo4j_uri,
                neo4j_user: graphitiConfig.neo4j_user,
                neo4j_password: graphitiConfig.neo4j_password,
                llm: graphitiConfig.llm,
                embedder: graphitiConfig.embedder,
                reranker: graphitiConfig.reranker
            });
            globalThis.__graphiti__ = graphiti;
            logger.info('[Graphiti] client initialized');
        }

        const panel = createWebPanel(db, config.web, descQueue);
        const replyManagers = new Map<number, GroupReplyManager>();
        globalThis.__replyManagers__ = replyManagers;

        let resolveReady = (): void => {};
        const ready = new Promise<void>(resolve => {
            resolveReady = resolve;
        });

        state = {
            bot,
            db,
            descQueue,
            replyManagers,
            graphiti,
            panel,
            scheduledTaskManager: null,
            ingressQueues: new Map(),
            botSelfId: 0,
            botName: '',
            botInfoReady: false,
            stopping: false,
            readySettled: false,
            resolveReady: () => {
                if (!state || state.readySettled) return;
                state.readySettled = true;
                resolveReady();
            }
        };
        readyPromise = ready;

        return state;
    };

    const getReplyManager = async (groupId: number): Promise<GroupReplyManager | undefined> => {
        if (!state) return undefined;
        if (!state.botInfoReady) return undefined;
        if (!config.input.group_whitelist.includes(groupId)) return undefined;
        if (!state.replyManagers.has(groupId)) {
            state.replyManagers.set(
                groupId,
                await GroupReplyManager.create({
                    groupId,
                    bot: state.bot,
                    db: state.db,
                    descQueue: state.descQueue,
                    config,
                    botSelfId: state.botSelfId,
                    botName: state.botName,
                    models
                })
            );
        }
        return state.replyManagers.get(groupId);
    };

    const handleGroupMessage = async (e: GroupMessageEvent): Promise<void> => {
        if (!state) return;
        const stored = await groupMessageEventToStoredMessage(e, state.bot);

        // 收集所有图片 sha256（包括嵌套在 reply/forward 中的），写入 images 表并插队到描述队列
        const shaSet = new Set<string>();
        for (const seg of stored.segments) {
            collectImageSha256FromSegment(seg, shaSet);
        }
        for (const sha256 of shaSet) {
            await state.db.insert(schema.images)
                .values({sha256})
                .onConflictDoNothing();
        }
        state.descQueue.enqueueMany(Array.from(shaSet), true);

        const rows = await state.db.insert(schema.messages).values({
            messageId: stored.messageId!,
            groupId: e.group_id,
            userId: stored.senderId!,
            time: stored.time,
            senderName: stored.senderName,
            senderCard: stored.senderCard ?? null,
            isBot: stored.isBot ?? false,
            isAtBot: stored.isAtBot ?? false,
            segments: stored.segments as StoredSegment[],
            rawMessage: e.raw_message
        })
            .returning({id: schema.messages.id});

        if (e.raw_message === 'Ciallo ～(∠・ω< )⌒★!') {
            await e.reply('Ciallo ～(∠・ω< )⌒★!');
        }

        const manager = await getReplyManager(e.group_id);
        if (manager) {
            manager.onMessage(stored, rows[0].id);
        } else {
            logger.debug(`[Bot] [${e.group_id}] no manager, skip reply logic`);
        }
    };

    /**
     * 群消息入库串行化队列（每群一条 promise 链）。
     * 消息事件沿单条 WebSocket 按到达顺序同步分发，但入库前的转换包含
     * 图片下载、引用解析、@ 昵称解析等 await，并发执行会导致后到的消息先落库
     * （数据库自增 id 与真实时序倒置）。
     * 串行化保证：同群消息的数据库 id 严格按到达顺序递增，
     * 且 @ 触发时之前的消息必然已完整入库。
     */
    const enqueueGroupMessage = (e: GroupMessageEvent): void => {
        if (!state || state.stopping) return;
        const prev = state.ingressQueues.get(e.group_id) ?? Promise.resolve();
        // 单条消息处理失败（如图片下载失败）不阻塞后续消息
        const next = prev.then(() => handleGroupMessage(e))
            .catch(err => logger.error(`[Bot] [${e.group_id}] failed to handle group message:`, err));
        state.ingressQueues.set(e.group_id, next);
    };

    const applyLoginInfo = (
        appState: ApplicationState,
        info: {user_id: number; nickname: string}
    ): void => {
        appState.botSelfId = info.user_id;
        appState.botName = info.nickname;
        appState.botInfoReady = true;
    };

    const start = async (): Promise<void> => {
        if (startPromise) return startPromise;
        startPromise = (async () => {
            const appState = await createState();

            appState.descQueue.start();
            appState.bot.init();
            if (options.enableWebPanel ?? true) {
                appState.panel.start();
            } else {
                logger.info('[Bot] web panel disabled');
            }

            appState.bot.on('meta_event.lifecycle.connect', async () => {
                logger.debug('[Bot] meta_event.lifecycle.connect received');
                try {
                    const info = await appState.bot.getLoginInfo();
                    applyLoginInfo(appState, info);
                    logger.debug(
                        `[Bot] login info ready selfId=${appState.botSelfId} name=${appState.botName}`);

                    for (const groupId of config.input.group_whitelist) {
                        if (!appState.replyManagers.has(groupId)) {
                            appState.replyManagers.set(
                                groupId,
                                await GroupReplyManager.create({
                                    groupId,
                                    bot: appState.bot,
                                    db: appState.db,
                                    descQueue: appState.descQueue,
                                    config,
                                    botSelfId: appState.botSelfId,
                                    botName: appState.botName,
                                    models
                                })
                            );
                            logger.debug(`[Bot] pre-initialized ReplyManager for group ${groupId}`);
                        }
                    }

                    if (!appState.scheduledTaskManager) {
                        appState.scheduledTaskManager = new ScheduledTaskManager(config, getReplyManager);
                        appState.scheduledTaskManager.start();
                    }
                    appState.resolveReady();
                } catch (e) {
                    logger.error('[Bot] Failed to get login info:', e);
                }
            });

            appState.bot.on('message.group', (e: GroupMessageEvent) => {
                if (!config.input.group_whitelist.includes(e.group_id)) return;
                enqueueGroupMessage(e);
            });
        })();
        return startPromise;
    };

    const ready = async (): Promise<void> => {
        if (readyPromise) return readyPromise;
        return Promise.reject(new Error('application not started'));
    };

    const stop = async (): Promise<void> => {
        if (!state || state.stopping) return;
        state.stopping = true;
        state.resolveReady();
        logger.info('[Shutdown] starting graceful shutdown...');

        try {
            state.scheduledTaskManager?.stop();
        } catch (err) {
            logger.error('[Shutdown] failed to stop scheduled tasks:', err);
        }

        try {
            await Promise.all(
                Array.from(state.replyManagers.values(), manager => manager.shutdown())
            );
            logger.info('[Shutdown] all reply managers stopped');
        } catch (err) {
            logger.error('[Shutdown] failed while stopping reply managers:', err);
        }

        try {
            state.bot.dispose();
            logger.info('[Shutdown] bot disposed');
        } catch (err) {
            logger.error('[Shutdown] failed to dispose bot:', err);
        }

        try {
            state.panel.stop();
            logger.info('[Shutdown] web panel stopped');
        } catch (err) {
            logger.error('[Shutdown] failed to stop web panel:', err);
        }

        try {
            await Promise.allSettled(Array.from(state.ingressQueues.values()));
        } catch (err) {
            logger.error('[Shutdown] failed while waiting for message ingress:', err);
        }

        try {
            await state.descQueue.stop();
            logger.info('[Shutdown] description queue stopped');
        } catch (err) {
            logger.error('[Shutdown] failed to stop description queue:', err);
        }

        try {
            await closeAllSessions();
            logger.info('[Shutdown] all sessions closed');
        } catch (err) {
            logger.error('[Shutdown] failed to close sessions:', err);
        }

        try {
            if (state.graphiti) {
                await state.graphiti.shutdown();
                logger.info('[Shutdown] Graphiti client shut down');
            }
        } catch (err) {
            logger.error('[Shutdown] failed to shut down Graphiti:', err);
        }

        try {
            closeDb(state.db);
            logger.info('[Shutdown] database closed');
        } catch (err) {
            logger.error('[Shutdown] failed to close database:', err);
        }

        delete globalThis.__db__;
        delete globalThis.__queue__;
        delete globalThis.__config__;
        delete globalThis.__models__;
        delete globalThis.__graphiti__;
        delete globalThis.__replyManagers__;

        logger.info('[Shutdown] graceful shutdown complete');
    };

    return {start, ready, stop};
}

import {createBot} from '@lib';
import {config, models} from '@/config';
import {applyPromptsOverrides} from './prompts';
import {registerCustomProviders} from './util/models-factory';
import {groupMessageEventToStoredMessage, collectImageSha256FromSegment, type StoredSegment} from './message-format';
import {createDb, schema, runMigrations} from './db';
import {createWebPanel} from './web/server';
import {DescQueue} from './util/desc-queue';
import {GroupReplyManager} from './util/reply-manager';
import {ScheduledTaskManager} from './util/scheduled-tasks';
import {closeAllSessions} from './util/harness-factory';
import {Logger, configureLogger} from '@lib/util/logger';
import type {GroupMessageEvent} from '@lib/types';
import {GraphitiClient} from './util/graphiti-client';
import {join} from 'node:path';
import {rmSync, existsSync} from 'node:fs';

configureLogger(config.log.level, config.log.file);
applyPromptsOverrides(config.input.prompts);
const logger = new Logger();

// 启动时清理 debug dump 目录
const debugDir = join(process.cwd(), 'data', 'debug');
if (existsSync(debugDir)) {
    rmSync(debugDir, {recursive: true, force: true});
    logger.info('[Bot] cleaned debug dump directory');
}

registerCustomProviders(models, config);
logger.debug('[Bot] registered providers from ai.models');

const bot = createBot(config.onebot);
const db = createDb();
await runMigrations(db);
const queue = new DescQueue(db);

// 把 db / queue / config / models 挂到 globalThis，让 Astro web 复用
globalThis.__db__ = db;
globalThis.__queue__ = queue;
globalThis.__config__ = config;
globalThis.__models__ = models;

let graphiti: GraphitiClient | undefined;
if (config.ai.graphiti) {
    const graphitiConfig = config.ai.graphiti;
    const serverPath = join(process.cwd(), 'graphiti', 'server.py');
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

const panel = createWebPanel(db, config.web, queue);

queue.start();
bot.init();
panel.start();

const replyManagers = new Map<number, GroupReplyManager>();
globalThis.__replyManagers__ = replyManagers;

let botSelfId = 0;
let botName = '';
let botInfoReady = false;
let scheduledTaskManager: ScheduledTaskManager | null = null;

bot.on('meta_event.lifecycle.connect', async () => {
    logger.debug('[Bot] meta_event.lifecycle.connect received');
    try {
        const info = await bot.getLoginInfo();
        botSelfId = info.user_id;
        botName = info.nickname;
        botInfoReady = true;
        logger.debug(`[Bot] login info ready selfId=${botSelfId} name=${botName}`);

        for (const groupId of config.input.group_whitelist) {
            if (!replyManagers.has(groupId)) {
                replyManagers.set(
                    groupId,
                    await GroupReplyManager.create(groupId, bot, db, queue, config, botSelfId, botName, models)
                );
                logger.debug(`[Bot] pre-initialized ReplyManager for group ${groupId}`);
            }
        }

        if (!scheduledTaskManager) {
            scheduledTaskManager = new ScheduledTaskManager(config, getReplyManager);
            scheduledTaskManager.start();
        }
    } catch (e) {
        logger.error('[Bot] Failed to get login info:', e);
    }
});

async function getReplyManager (groupId: number): Promise<GroupReplyManager | undefined> {
    logger.debug(`[Bot] getReplyManager group=${groupId} botInfoReady=${botInfoReady}`);
    if (!botInfoReady) return;
    if (!config.input.group_whitelist.includes(groupId)) return;
    if (!replyManagers.has(groupId)) {
        replyManagers.set(
            groupId,
            await GroupReplyManager.create(groupId, bot, db, queue, config, botSelfId, botName, models)
        );
    }
    return replyManagers.get(groupId)!;
}

/**
 * 群消息入库串行化队列（每群一条 promise 链）。
 * 消息事件沿单条 WebSocket 按到达顺序同步分发，但入库前的转换包含
 * 图片下载、引用解析、@ 昵称解析等 await，并发执行会导致后到的消息先落库
 * （数据库自增 id 与真实时序倒置）。
 * 串行化保证：同群消息的数据库 id 严格按到达顺序递增，
 * 且 @ 触发时之前的消息必然已完整入库。
 */
const groupIngressQueues = new Map<number, Promise<void>>();

function enqueueGroupMessage (e: GroupMessageEvent): void {
    const prev = groupIngressQueues.get(e.group_id) ?? Promise.resolve();
    // 单条消息处理失败（如图片下载失败）不阻塞后续消息
    const next = prev.then(() => handleGroupMessage(e))
        .catch(err => logger.error(`[Bot] [${e.group_id}] failed to handle group message:`, err));
    groupIngressQueues.set(e.group_id, next);
}

bot.on('message.group', e => {
    if (!config.input.group_whitelist.includes(e.group_id)) return;
    enqueueGroupMessage(e);
});

async function handleGroupMessage (e: GroupMessageEvent): Promise<void> {
    const stored = await groupMessageEventToStoredMessage(e, bot);

    // 收集所有图片 sha256（包括嵌套在 reply/forward 中的），写入 images 表并插队到描述队列
    const shaSet = new Set<string>();
    for (const seg of stored.segments) {
        collectImageSha256FromSegment(seg, shaSet);
    }
    for (const sha256 of shaSet) {
        await db.insert(schema.images)
            .values({sha256})
            .onConflictDoNothing();
    }
    queue.enqueueMany(Array.from(shaSet), true);

    const rows = await db.insert(schema.messages).values({
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

    logger.info(`[Bot] [${e.group_id}] msg ${stored.messageId} from ${stored.senderId} atBot=${stored.isAtBot}`);

    if (e.raw_message === 'Ciallo ～(∠・ω< )⌒★!') {
        await e.reply('Ciallo ～(∠・ω< )⌒★!');
    }

    const manager = await getReplyManager(e.group_id);
    if (manager) {
        manager.onMessage(stored, rows[0].id);
    } else {
        logger.debug(`[Bot] [${e.group_id}] no manager, skip reply logic`);
    }
}

let shuttingDown = false;
async function shutdown (signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[Shutdown] received ${signal}, starting graceful shutdown...`);

    try {
        bot.dispose();
        logger.info('[Shutdown] bot disposed');
    } catch (err) {
        logger.error('[Shutdown] failed to dispose bot:', err);
    }

    try {
        queue.stop();
        logger.info('[Shutdown] description queue stopped');
    } catch (err) {
        logger.error('[Shutdown] failed to stop description queue:', err);
    }

    try {
        panel.stop();
        logger.info('[Shutdown] web panel stopped');
    } catch (err) {
        logger.error('[Shutdown] failed to stop web panel:', err);
    }

    try {
        logger.info('[Shutdown] waiting for reply agents to become idle...');
        for (const manager of replyManagers.values()) {
            await manager.getAgent().waitForIdle();
        }
        logger.info('[Shutdown] all reply agents idle');
    } catch (err) {
        logger.error('[Shutdown] failed while waiting for reply agents:', err);
    }

    try {
        await closeAllSessions();
        logger.info('[Shutdown] all sessions closed');
    } catch (err) {
        logger.error('[Shutdown] failed to close sessions:', err);
    }

    try {
        if (graphiti) {
            await graphiti.shutdown();
            logger.info('[Shutdown] Graphiti client shut down');
        }
    } catch (err) {
        logger.error('[Shutdown] failed to shut down Graphiti:', err);
    }

    logger.info('[Shutdown] graceful shutdown complete');
    process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

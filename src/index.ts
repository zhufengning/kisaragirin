import './util/disable-mem0-telemetry';

import {createBot} from '@lib';
import {config} from '@/config';
import {groupMessageEventToStoredMessage, collectImageSha256FromSegment, type StoredSegment} from './message-format';
import {createDb, schema, runMigrations} from './db';
import {createWebPanel} from './web/server';
import {DescQueue} from './util/desc-queue';
import {GroupReplyManager} from './util/reply-manager';
import {ScheduledTaskManager} from './util/scheduled-tasks';
import {Logger, configureLogger} from '@lib/util/logger';
import {Memory} from 'mem0ai/oss';

configureLogger(config.log.level, config.log.file);
const logger = new Logger();

const bot = createBot(config.onebot);
const db = createDb();
await runMigrations(db);
const queue = new DescQueue(db);

// 把 db / queue / config 挂到 globalThis，让 Astro web 复用
globalThis.__db__ = db;
globalThis.__queue__ = queue;
globalThis.__config__ = config;

let memory: Memory | undefined;
if (config.ai.mem0) {
    memory = new Memory(config.ai.mem0);
    globalThis.__memory__ = memory;
    logger.info('[Mem0] Memory instance created');
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
                replyManagers.set(groupId, new GroupReplyManager(groupId, bot, db, queue, config, botSelfId, botName));
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

function getReplyManager (groupId: number): GroupReplyManager | undefined {
    logger.debug(`[Bot] getReplyManager group=${groupId} botInfoReady=${botInfoReady}`);
    if (!botInfoReady) return;
    if (!config.input.group_whitelist.includes(groupId)) return;
    if (!replyManagers.has(groupId)) {
        replyManagers.set(groupId, new GroupReplyManager(groupId, bot, db, queue, config, botSelfId, botName));
    }
    return replyManagers.get(groupId)!;
}

bot.on('message.group', async e => {
    if (!config.input.group_whitelist.includes(e.group_id)) return;

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

    const manager = getReplyManager(e.group_id);
    if (manager) {
        manager.onMessage(stored, rows[0].id);
    } else {
        logger.debug(`[Bot] [${e.group_id}] no manager, skip reply logic`);
    }
});

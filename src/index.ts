import { createBot } from '../lib';
import { config } from '../config';
import { groupMessageEventToStoredMessage } from './message-format';
import { createDb, schema } from './db';
import { createWebPanel } from './web/server';
import { DescQueue } from './util/desc-queue';
import { GroupReplyManager } from './util/reply-manager';
import { Logger } from '../lib/util/logger';

const logger = new Logger(config.onebot.log_level);

const bot = createBot(config.onebot);
const db = createDb();
const queue = new DescQueue(db);

// 把 db / queue 挂到 globalThis，让 Astro web 复用同一连接
(globalThis as any).__db__ = db;
(globalThis as any).__queue__ = queue;

const panel = createWebPanel(db, config.web, queue);

queue.start();
bot.init();
panel.start();

const replyManagers = new Map<number, GroupReplyManager>();
let botSelfId = 0;
let botName = '';
let botInfoReady = false;

bot.on('meta_event.lifecycle.connect', async () => {
    logger.debug('[Bot] meta_event.lifecycle.connect received');
    try {
        const info = await bot.getLoginInfo();
        botSelfId = info.user_id;
        botName = info.nickname;
        botInfoReady = true;
        logger.debug(`[Bot] login info ready selfId=${botSelfId} name=${botName}`);
    } catch (e) {
        logger.error('[Bot] Failed to get login info:', e);
    }
});

function getReplyManager(groupId: number): GroupReplyManager | undefined {
    logger.debug(`[Bot] getReplyManager group=${groupId} botInfoReady=${botInfoReady}`);
    if (!botInfoReady) return undefined;
    if (!config.input.group_whitelist.includes(groupId)) return undefined;
    if (!replyManagers.has(groupId)) {
        replyManagers.set(groupId, new GroupReplyManager(groupId, bot, db, queue, config, botSelfId, botName));
    }
    return replyManagers.get(groupId)!;
}

bot.on('message.group', async e => {
    if (!config.input.group_whitelist.includes(e.group_id)) return;

    const stored = await groupMessageEventToStoredMessage(e, bot);

    // 图片 sha256 写入 images 表，并加入后台描述队列
    for (const seg of stored.segments) {
        if (seg.type === 'image') {
            await db.insert(schema.images)
                .values({ sha256: seg.sha256 })
                .onConflictDoNothing();
            queue.enqueue(seg.sha256);
        }
    }

    const rows = await db.insert(schema.messages).values({
        messageId: stored.messageId!,
        groupId: e.group_id,
        userId: stored.senderId!,
        time: stored.time,
        senderName: stored.senderName,
        senderCard: stored.senderCard ?? null,
        isBot: stored.isBot ?? false,
        isAtBot: stored.isAtBot ?? false,
        segments: stored.segments as any,
        rawMessage: e.raw_message,
    }).returning({ id: schema.messages.id });

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

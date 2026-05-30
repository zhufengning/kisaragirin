import { createBot } from '../lib';
import { config } from '../config';
import { groupMessageEventToStoredMessage } from './message-format';
import { createDb, schema } from './db';
import { createWebPanel } from './web/server';
import { DescQueue } from './util/desc-queue';
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

    await db.insert(schema.messages).values({
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
    });

    if (e.raw_message === 'Ciallo ～(∠・ω< )⌒★!') {
        await e.reply('Ciallo ～(∠・ω< )⌒★!');
    }
});

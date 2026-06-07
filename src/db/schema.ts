import {sqliteTable, integer, text} from 'drizzle-orm/sqlite-core';

export const messages = sqliteTable('messages', {
    id: integer('id').primaryKey({autoIncrement: true}),
    messageId: integer('message_id').notNull(),
    groupId: integer('group_id').notNull(),
    userId: integer('user_id').notNull(),
    time: integer('time').notNull(),
    senderName: text('sender_name').notNull(),
    senderCard: text('sender_card'),
    isBot: integer('is_bot', {mode: 'boolean'}).notNull()
        .default(false),
    isAtBot: integer('is_at_bot', {mode: 'boolean'}).notNull()
        .default(false),
    /** 消息类型：normal | compact | system */
    specialType: text('special_type').$type<'normal' | 'compact' | 'system'>().notNull()
        .default('normal'),
    /** 存储为 JSON 字符串的 segments 数组；image segment 只含 sha256，不含 description */
    segments: text('segments', {mode: 'json'}).notNull(),
    rawMessage: text('raw_message'),
    createdAt: integer('created_at', {mode: 'timestamp'}).$defaultFn(() => new Date())
});

export const images = sqliteTable('images', {
    sha256: text('sha256').primaryKey(),
    description: text('description')
});

export const kvStore = sqliteTable('kv_store', {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
    updatedAt: integer('updated_at', {mode: 'timestamp'}).$defaultFn(() => new Date())
});

export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;
export type ImageRow = typeof images.$inferSelect;
export type NewImageRow = typeof images.$inferInsert;
export type KvStoreRow = typeof kvStore.$inferSelect;
export type NewKvStoreRow = typeof kvStore.$inferInsert;

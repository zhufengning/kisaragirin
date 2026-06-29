import Database from 'better-sqlite3';
import {drizzle} from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import {eq, desc} from 'drizzle-orm';
import {Logger} from '@lib/util/logger';
import {ReplyAgent} from '~/util/reply-agent';
import type {DescQueue} from '~/util/desc-queue';
import type {StoredMessage} from '~/message-format';
import type {AppConfig} from '~/config';

export {schema};

export function createDb (path = './data.db') {
    const sqlite = new Database(path);
    return drizzle(sqlite, {schema});
}

export type Db = ReturnType<typeof createDb>;

/** KV Store helpers */
export async function kvGet (db: Db, key: string): Promise<string | undefined> {
    const rows = await db.select()
        .from(schema.kvStore)
        .where(eq(schema.kvStore.key, key))
        .limit(1);
    return rows[0]?.value;
}

export async function kvSet (db: Db, key: string, value: string): Promise<void> {
    await db.insert(schema.kvStore)
        .values({key, value})
        .onConflictDoUpdate({
            target: schema.kvStore.key,
            set: {value, updatedAt: new Date()}
        });
}

export async function kvDelete (db: Db, key: string): Promise<void> {
    await db.delete(schema.kvStore).where(eq(schema.kvStore.key, key));
}

export async function clearGroupMessages (db: Db, groupId: number): Promise<void> {
    await db.delete(schema.messages)
        .where(eq(schema.messages.groupId, groupId));
    await kvDelete(db, `group:${groupId}:lastTriggerId`);
    await kvDelete(db, `group:${groupId}:lastCompactId`);
    await kvDelete(db, `group:${groupId}:lastUsageAnchor`);
}

export async function runMigrations (db: Db): Promise<void> {
    const sqlite = (db as {$client: Database.Database}).$client;

    // Check if messages table has special_type column
    const messagesColumns = sqlite.prepare(
        'PRAGMA table_info(messages)'
    ).all() as Array<{ name: string }>;
    const hasSpecialType = messagesColumns.some(c => c.name === 'special_type');
    if (!hasSpecialType) {
        sqlite.exec(`
            ALTER TABLE messages ADD COLUMN special_type TEXT NOT NULL DEFAULT 'normal'
        `);
    }

    // Check if kv_store table exists
    const tables = sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='kv_store'"
    ).all() as Array<{ name: string }>;
    if (tables.length === 0) {
        sqlite.exec(`
            CREATE TABLE kv_store (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER
            )
        `);
    }
}

/**
 * Run initial compaction for all groups that have messages.
 * This should be called once after migration.
 */
export async function runFullCompaction (
    db: Db, config: AppConfig, descQueue: DescQueue,
): Promise<void> {
    const logger = new Logger();
    logger.info('[Migration] Running full compaction for all groups...');

    const groups = await db
        .selectDistinct({groupId: schema.messages.groupId})
        .from(schema.messages);

    logger.info(`[Migration] Found ${groups.length} groups with messages`);

    for (const {groupId} of groups) {
        try {
            const agent = new ReplyAgent(db, descQueue, config);
            const allRows = await db
                .select()
                .from(schema.messages)
                .where(eq(schema.messages.groupId, groupId))
                .orderBy(desc(schema.messages.id));

            allRows.reverse();

            const messages: StoredMessage[] = allRows.map(row => ({
                time: row.time,
                messageId: row.messageId,
                senderId: row.userId,
                senderName: row.senderName,
                senderCard: row.senderCard ?? undefined,
                isBot: row.isBot,
                isAtBot: row.isAtBot,
                segments: row.segments as StoredMessage['segments']
            }));

            await agent.doCompact(groupId, messages);
            logger.info(`[Migration] [${groupId}] compact done`);
        } catch (err) {
            logger.error(`[Migration] [${groupId}] compact failed:`, err);
        }
    }

    logger.info('[Migration] Full compaction complete');
}

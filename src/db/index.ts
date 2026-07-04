import Database from 'better-sqlite3';
import {drizzle} from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import {eq} from 'drizzle-orm';
import type {StoredSegment} from '~/message-format';

export {schema};

export function createDb (path = './data.db') {
    const sqlite = new Database(path);
    return drizzle(sqlite, {schema});
}

export type Db = ReturnType<typeof createDb>;

export interface JsonlSessionMetadata {
    id: string;
    createdAt: string;
    cwd: string;
    path: string;
}

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

export async function getHarnessMetadata (
    db: Db, groupId: number
): Promise<JsonlSessionMetadata | null> {
    const raw = await kvGet(db, `harness:group:${groupId}:metadata`);
    if (!raw) return null;
    try {
        return JSON.parse(raw) as JsonlSessionMetadata;
    } catch {
        return null;
    }
}

export async function setHarnessMetadata (
    db: Db, groupId: number, metadata: JsonlSessionMetadata
): Promise<void> {
    await kvSet(db, `harness:group:${groupId}:metadata`, JSON.stringify(metadata));
}

export async function clearGroupMessages (db: Db, groupId: number): Promise<void> {
    await db.delete(schema.messages)
        .where(eq(schema.messages.groupId, groupId));
    await kvDelete(db, `group:${groupId}:lastTriggerId`);
}

export async function insertSystemMessage (
    db: Db,
    groupId: number,
    text: string,
    time?: number,
): Promise<number> {
    const segments: StoredSegment[] = [{type: 'system', text}];
    const rows = await db.insert(schema.messages).values({
        messageId: 0,
        groupId,
        userId: 0,
        time: time ?? Math.floor(Date.now() / 1000),
        senderName: '系统',
        senderCard: null,
        isBot: true,
        isAtBot: false,
        specialType: 'system',
        segments,
        rawMessage: text
    })
        .returning({id: schema.messages.id});

    return rows[0].id;
}

export async function runMigrations (db: Db): Promise<void> {
    const sqlite = (db as {$client: Database.Database}).$client;

    const tables = sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).all() as Array<{ name: string }>;
    const tableNames = new Set(tables.map(t => t.name));

    if (tableNames.has('messages')) {
        const messagesColumns = sqlite.prepare(
            'PRAGMA table_info(messages)'
        ).all() as Array<{ name: string }>;
        const hasSpecialType = messagesColumns.some(c => c.name === 'special_type');
        if (!hasSpecialType) {
            sqlite.exec(`
                ALTER TABLE messages ADD COLUMN special_type TEXT NOT NULL DEFAULT 'normal'
            `);
        }
    } else {
        sqlite.exec(`
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
                message_id INTEGER NOT NULL,
                group_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                time INTEGER NOT NULL,
                sender_name TEXT NOT NULL,
                sender_card TEXT,
                is_bot INTEGER DEFAULT false NOT NULL,
                is_at_bot INTEGER DEFAULT false NOT NULL,
                special_type TEXT DEFAULT 'normal' NOT NULL,
                segments TEXT NOT NULL,
                raw_message TEXT,
                created_at INTEGER
            );
            CREATE INDEX idx_messages_group_id ON messages(group_id);
            CREATE INDEX idx_messages_group_time ON messages(group_id, time);
        `);
    }

    if (!tableNames.has('images')) {
        sqlite.exec(`
            CREATE TABLE images (
                sha256 TEXT PRIMARY KEY NOT NULL,
                description TEXT
            );
        `);
    }

    if (!tableNames.has('kv_store')) {
        sqlite.exec(`
            CREATE TABLE kv_store (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER
            );
        `);
    }
}

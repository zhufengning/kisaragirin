import Database from 'better-sqlite3';

export interface StoredSegmentRow {
    type: string;
    text?: string;
    [key: string]: unknown;
}

export interface MessageRow {
    id: number;
    messageId: number;
    groupId: number;
    userId: number;
    time: number;
    senderName: string;
    senderCard: string | null;
    isBot: boolean;
    isAtBot: boolean;
    specialType: 'normal' | 'compact' | 'system';
    segments: StoredSegmentRow[];
    rawMessage: string | null;
}

interface RawMessageRow {
    id: number;
    message_id: number;
    group_id: number;
    user_id: number;
    time: number;
    sender_name: string;
    sender_card: string | null;
    is_bot: number;
    is_at_bot: number;
    special_type: 'normal' | 'compact' | 'system';
    segments: string;
    raw_message: string | null;
}

function toMessageRow (row: RawMessageRow): MessageRow {
    return {
        id: row.id,
        messageId: row.message_id,
        groupId: row.group_id,
        userId: row.user_id,
        time: row.time,
        senderName: row.sender_name,
        senderCard: row.sender_card,
        isBot: row.is_bot === 1,
        isAtBot: row.is_at_bot === 1,
        specialType: row.special_type,
        segments: JSON.parse(row.segments) as StoredSegmentRow[],
        rawMessage: row.raw_message
    };
}

/** 只读数据库检查器：读取场景 SQLite 中的消息、图片描述与 KV */
export class DatabaseInspector {
    private db: Database.Database;

    constructor (path: string) {
        this.db = new Database(path, {readonly: true, fileMustExist: true});
        this.db.pragma('busy_timeout = 5000');
    }

    messages (groupId?: number): MessageRow[] {
        const rows = groupId === undefined ?
            this.db.prepare('SELECT * FROM messages ORDER BY id ASC').all() :
            this.db.prepare('SELECT * FROM messages WHERE group_id = ? ORDER BY id ASC').all(groupId);
        return (rows as RawMessageRow[]).map(toMessageRow);
    }

    messageCount (groupId?: number): number {
        const row = groupId === undefined ?
            this.db.prepare('SELECT COUNT(*) AS count FROM messages').get() as {count: number} :
            this.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE group_id = ?')
                .get(groupId) as {count: number};
        return row.count;
    }

    botMessages (groupId: number): MessageRow[] {
        return this.messages(groupId)
            .filter(row => row.specialType === 'normal' && row.isBot);
    }

    systemMessages (groupId: number): MessageRow[] {
        return this.messages(groupId)
            .filter(row => row.specialType === 'system');
    }

    kvValue (key: string): string | undefined {
        const row = this.db.prepare('SELECT value FROM kv_store WHERE key = ?').get(key) as
            {value: string} | undefined;
        return row?.value;
    }

    lastTriggerId (groupId: number): number | undefined {
        const raw = this.kvValue(`group:${groupId}:lastTriggerId`);
        return raw === undefined ? undefined : parseInt(raw, 10);
    }

    harnessMetadata (groupId: number): {id: string; path: string} | undefined {
        const raw = this.kvValue(`harness:group:${groupId}:metadata`);
        return raw === undefined ? undefined : JSON.parse(raw) as {id: string; path: string};
    }

    imageDescription (sha256: string): string | undefined {
        const row = this.db.prepare('SELECT description FROM images WHERE sha256 = ?').get(sha256) as
            {description: string | null} | undefined;
        return row?.description ?? undefined;
    }

    imageCount (): number {
        const row = this.db.prepare('SELECT COUNT(*) AS count FROM images').get() as {count: number};
        return row.count;
    }

    close (): void {
        this.db.close();
    }
}

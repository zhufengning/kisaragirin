import {asc, like} from 'drizzle-orm';
import {kvGet, kvSet, schema, type Db} from '~/db';

export interface StickerRecord {
    imageId: number;
    category: string;
    note: string;
}

/** 全局表情包库，所有群共享同一个列表 */
const STICKERS_KEY = 'stickers';

/** 读取全局表情包收藏列表，未收藏过时返回空数组 */
export async function getStickers (db: Db): Promise<StickerRecord[]> {
    const raw = await kvGet(db, STICKERS_KEY);
    if (raw !== undefined) return JSON.parse(raw) as StickerRecord[];
    return migrateLegacyStickers(db);
}

export async function setStickers (db: Db, stickers: StickerRecord[]): Promise<void> {
    await kvSet(db, STICKERS_KEY, JSON.stringify(stickers));
}

/** 将旧版按群保存的收藏合并到全局列表，按图片 id 去重后删除旧键 */
async function migrateLegacyStickers (db: Db): Promise<StickerRecord[]> {
    const rows = await db
        .select({key: schema.kvStore.key, value: schema.kvStore.value})
        .from(schema.kvStore)
        .where(like(schema.kvStore.key, 'group:%:stickers'))
        .orderBy(asc(schema.kvStore.key));

    const merged = new Map<number, StickerRecord>();
    for (const row of rows) {
        const records = JSON.parse(row.value) as StickerRecord[];
        for (const record of records) {
            if (!merged.has(record.imageId)) merged.set(record.imageId, record);
        }
    }

    const stickers = Array.from(merged.values());
    await setStickers(db, stickers);
    if (rows.length > 0) {
        await db.delete(schema.kvStore)
            .where(like(schema.kvStore.key, 'group:%:stickers'));
    }
    return stickers;
}

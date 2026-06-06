import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '~/db/schema';
import type { Db } from '~/db';

let db: Db;

if (globalThis.__db__) {
    db = globalThis.__db__;
} else {
    // fallback：独立运行时（如 astro dev）自建连接
    const sqlite = new Database('./data.db');
    db = drizzle(sqlite, { schema });
}

export { db, schema };
export type { Db };

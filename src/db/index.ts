import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export { schema };

export function createDb(path = './data.db') {
    const sqlite = new Database(path);
    return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof createDb>;

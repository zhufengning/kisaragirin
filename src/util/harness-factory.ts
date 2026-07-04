import {mkdirSync, existsSync, renameSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {Logger} from '@lib/util/logger';
import {JsonlSessionRepo, Session} from '@earendil-works/pi-agent-core';
import {NodeExecutionEnv} from '@earendil-works/pi-agent-core/node';
import {getHarnessMetadata, setHarnessMetadata, type JsonlSessionMetadata, type Db} from '~/db';
import type {AppConfig} from '~/config';

const logger = new Logger();
const nodeEnv = new NodeExecutionEnv({cwd: process.cwd()});
const repo = new JsonlSessionRepo({fs: nodeEnv, sessionsRoot: 'data/harness/'});
const sessionCache = new Map<number, Session<JsonlSessionMetadata>>();

function fixedSessionPath (groupId: number): string {
    return resolve(process.cwd(), 'data/harness', `group-${groupId}.jsonl`);
}

function buildHeader (groupId: number): string {
    const header = {
        type: 'session',
        version: 3,
        id: `group-${groupId}`,
        timestamp: new Date().toISOString(),
        cwd: process.cwd()
    };
    return `${JSON.stringify(header)}\n`;
}

function parseHeaderMetadata (filePath: string): JsonlSessionMetadata | null {
    try {
        const firstLine = readFileSync(filePath, 'utf-8').split('\n')[0];
        if (!firstLine?.trim()) return null;
        const parsed = JSON.parse(firstLine);
        if (
            parsed &&
            parsed.type === 'session' &&
            parsed.version === 3 &&
            typeof parsed.id === 'string' &&
            typeof parsed.timestamp === 'string' &&
            typeof parsed.cwd === 'string'
        ) {
            return {
                id: parsed.id,
                createdAt: parsed.timestamp,
                cwd: parsed.cwd,
                path: filePath
            };
        }
        return null;
    } catch {
        return null;
    }
}

export interface GroupSessionResult {
    session: Session<JsonlSessionMetadata>;
    metadata: JsonlSessionMetadata;
    isNew: boolean;
}

export async function getOrCreateGroupSession (
    groupId: number,
    _config: AppConfig,
    db: Db
): Promise<GroupSessionResult> {
    const cached = sessionCache.get(groupId);
    if (cached) {
        const metadata = await cached.getMetadata();
        logger.debug(`[HarnessFactory] [${groupId}] using cached session ${metadata.id}`);
        return {session: cached, metadata, isNew: false};
    }

    const fixedPath = fixedSessionPath(groupId);
    mkdirSync(dirname(fixedPath), {recursive: true});

    const existing = await getHarnessMetadata(db, groupId);
    if (existing && existsSync(existing.path)) {
        const session = await repo.open(existing);
        sessionCache.set(groupId, session);
        logger.debug(`[HarnessFactory] [${groupId}] opened existing session ${existing.id}`);
        return {session, metadata: existing, isNew: false};
    }

    if (existsSync(fixedPath)) {
        const recovered = parseHeaderMetadata(fixedPath);
        if (recovered) {
            const session = await repo.open(recovered);
            await setHarnessMetadata(db, groupId, recovered);
            sessionCache.set(groupId, session);
            logger.info(`[HarnessFactory] [${groupId}] recovered existing session ${recovered.id}`);
            return {session, metadata: recovered, isNew: false};
        }
        logger.warn(`[HarnessFactory] [${groupId}] invalid session file at ${fixedPath}, backing up`);
        renameSync(fixedPath, `${fixedPath}.bak.${Date.now()}`);
    }

    writeFileSync(fixedPath, buildHeader(groupId), 'utf-8');

    const metadata: JsonlSessionMetadata = {
        id: `group-${groupId}`,
        createdAt: new Date().toISOString(),
        cwd: process.cwd(),
        path: fixedPath
    };
    await setHarnessMetadata(db, groupId, metadata);

    const session = await repo.open(metadata);
    sessionCache.set(groupId, session);
    logger.info(`[HarnessFactory] [${groupId}] created new session ${metadata.id}`);
    return {session, metadata, isNew: true};
}

export async function closeAllSessions (): Promise<void> {
    sessionCache.clear();
    if (typeof nodeEnv.cleanup === 'function') {
        await nodeEnv.cleanup();
    }
    logger.info('[HarnessFactory] all sessions closed');
}

import {mkdirSync} from 'node:fs';
import {Logger} from '@lib/util/logger';
import {JsonlSessionRepo, Session} from '@earendil-works/pi-agent-core';
import {NodeExecutionEnv} from '@earendil-works/pi-agent-core/node';
import {getHarnessMetadata, type JsonlSessionMetadata, type Db} from '~/db';
import type {AppConfig} from '~/config';

const logger = new Logger();
const nodeEnv = new NodeExecutionEnv({cwd: process.cwd()});
const repo = new JsonlSessionRepo({fs: nodeEnv, sessionsRoot: 'data/harness/'});
const sessionCache = new Map<number, Session<JsonlSessionMetadata>>();

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

    mkdirSync('data/harness', {recursive: true});

    const existing = await getHarnessMetadata(db, groupId);
    if (existing) {
        const session = await repo.open(existing);
        sessionCache.set(groupId, session);
        logger.debug(`[HarnessFactory] [${groupId}] opened existing session ${existing.id}`);
        return {session, metadata: existing, isNew: false};
    }

    const session = await repo.create({
        id: `group-${groupId}`,
        cwd: process.cwd()
    });
    const metadata = await session.getMetadata();
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

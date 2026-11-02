import {existsSync, mkdirSync, renameSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {Logger} from '@lib/util/logger';
import {SessionManager, type AgentSession, type SessionHeader} from '@earendil-works/pi-coding-agent';
import type {Usage} from '@earendil-works/pi-ai';
import {
    getHarnessMetadata,
    setHarnessMetadata,
    type JsonlSessionMetadata,
    type Db
} from '~/db';

const logger = new Logger();
const sessionCache = new Map<number, GroupSessionResult>();
const agentSessions = new Set<AgentSession>();

function sessionDirectory (): string {
    return resolve(process.cwd(), 'data/harness');
}

function legacySessionPath (groupId: number): string {
    return resolve(sessionDirectory(), `group-${groupId}.jsonl`);
}

function metadataFromHeader (header: SessionHeader, path: string): JsonlSessionMetadata {
    return {
        id: header.id,
        createdAt: header.timestamp,
        cwd: header.cwd,
        path
    };
}

/** 旧运行时写入的 bot 回复只有 role/content/timestamp；pi-ai 估算上下文时会读取 assistant 消息的 usage */
export function emptyUsage (): Usage {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}
    };
}

/** 为缺少 usage 的历史 assistant 消息补零值，避免上下文估算读取 undefined */
function normalizeAssistantUsage (sessionManager: SessionManager): void {
    for (const entry of sessionManager.getBranch()) {
        if (entry.type !== 'message') continue;
        const message = entry.message;
        if (message.role !== 'assistant' || message.usage) continue;
        message.usage = emptyUsage();
    }
}

export interface GroupSessionResult {
    sessionManager: SessionManager;
    metadata: JsonlSessionMetadata;
    isNew: boolean;
}

function metadataForSession (sessionManager: SessionManager): JsonlSessionMetadata {
    const header = sessionManager.getHeader();
    const path = sessionManager.getSessionFile();
    if (!header || !path) {
        throw new Error('persistent session must have a header and file path');
    }
    return metadataFromHeader(header, path);
}

/** 创建独立的新会话文件，但暂不替换该群正在使用的会话 */
export function createGroupSession (groupId: number): GroupSessionResult {
    mkdirSync(sessionDirectory(), {recursive: true});
    const sessionManager = SessionManager.create(process.cwd(), sessionDirectory(), {
        id: `group-${groupId}-${randomUUID()}`
    });
    return {sessionManager, metadata: metadataForSession(sessionManager), isNew: true};
}

/** 将给定会话记录为该群的活动会话 */
export async function activateGroupSession (
    db: Db, groupId: number, result: GroupSessionResult
): Promise<void> {
    await setHarnessMetadata(db, groupId, result.metadata);
    sessionCache.set(groupId, {...result, isNew: false});
}

/**
 * 打开数据库元数据指向的活动会话；元数据不存在时兼容旧版固定路径。
 * 文件已被删除或无法打开时创建新会话，由调用方从数据库恢复群总体记忆。
 */
export async function getOrCreateGroupSession (
    groupId: number,
    db: Db
): Promise<GroupSessionResult> {
    const cached = sessionCache.get(groupId);
    if (cached) {
        logger.debug(`[HarnessFactory] [${groupId}] using cached session ${cached.metadata.id}`);
        return {...cached, isNew: false};
    }

    mkdirSync(sessionDirectory(), {recursive: true});
    const savedMetadata = await getHarnessMetadata(db, groupId);
    const candidates = savedMetadata ? [savedMetadata.path] : [legacySessionPath(groupId)];

    for (const path of candidates) {
        if (!existsSync(path)) continue;
        let opened: SessionManager | undefined;
        try {
            opened = SessionManager.open(path);
        } catch (err) {
            logger.warn(
                `[HarnessFactory] [${groupId}] invalid session file at ${path}, backing up:`,
                err instanceof Error ? err.message : err);
        }
        const header = opened?.getHeader();
        if (opened && header) {
            normalizeAssistantUsage(opened);
            const result: GroupSessionResult = {
                sessionManager: opened,
                metadata: metadataFromHeader(header, path),
                isNew: false
            };
            await activateGroupSession(db, groupId, result);
            logger.info(`[HarnessFactory] [${groupId}] opened existing session ${result.metadata.id}`);
            return result;
        }
        renameSync(path, `${path}.bak.${Date.now()}`);
    }

    const result = createGroupSession(groupId);
    await activateGroupSession(db, groupId, result);
    logger.info(`[HarnessFactory] [${groupId}] created new session ${result.metadata.id}`);
    return result;
}

/** 登记由会话管理器创建的 AgentSession，供关闭时统一释放 */
export function registerAgentSession (session: AgentSession): void {
    agentSessions.add(session);
}

/** 立即释放已被替换的 AgentSession */
export function disposeAgentSession (session: AgentSession): void {
    session.dispose();
    agentSessions.delete(session);
}

export async function closeAllSessions (): Promise<void> {
    for (const session of agentSessions) {
        session.dispose();
    }
    agentSessions.clear();
    sessionCache.clear();
    logger.info('[HarnessFactory] all sessions closed');
}

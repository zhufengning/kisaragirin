import {mkdirSync, existsSync, renameSync, writeFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {Logger} from '@lib/util/logger';
import {SessionManager, type AgentSession, type SessionHeader} from '@earendil-works/pi-coding-agent';
import type {Usage} from '@earendil-works/pi-ai';
import {setHarnessMetadata, type JsonlSessionMetadata, type Db} from '~/db';
import type {AppConfig} from '~/config';

const logger = new Logger();
const sessionCache = new Map<number, SessionManager>();
const agentSessions = new Set<AgentSession>();

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

/**
 * 获取该群的持久化会话管理器。
 * 会话文件固定在 data/harness/group-{id}.jsonl，旧版本写入的同一格式文件可直接打开；
 * KV Store 中的元数据仅用于记录会话身份，实际内容以 JSONL 文件为准。
 */
export async function getOrCreateGroupSession (
    groupId: number,
    _config: AppConfig,
    db: Db
): Promise<GroupSessionResult> {
    const cached = sessionCache.get(groupId);
    if (cached) {
        const header = cached.getHeader();
        if (!header) {
            throw new Error(`session for group ${groupId} has no header`);
        }
        logger.debug(`[HarnessFactory] [${groupId}] using cached session ${header.id}`);
        return {sessionManager: cached, metadata: metadataFromHeader(header, fixedSessionPath(groupId)), isNew: false};
    }

    const fixedPath = fixedSessionPath(groupId);
    mkdirSync(dirname(fixedPath), {recursive: true});

    if (existsSync(fixedPath)) {
        let opened: SessionManager | undefined;
        try {
            opened = SessionManager.open(fixedPath);
        } catch (err) {
            logger.warn(
                `[HarnessFactory] [${groupId}] invalid session file at ${fixedPath}, backing up:`,
                err instanceof Error ? err.message : err);
        }
        const header = opened?.getHeader();
        if (opened && header) {
            normalizeAssistantUsage(opened);
            const metadata = metadataFromHeader(header, fixedPath);
            await setHarnessMetadata(db, groupId, metadata);
            sessionCache.set(groupId, opened);
            logger.info(`[HarnessFactory] [${groupId}] opened existing session ${metadata.id}`);
            return {sessionManager: opened, metadata, isNew: false};
        }
        renameSync(fixedPath, `${fixedPath}.bak.${Date.now()}`);
    }

    writeFileSync(fixedPath, buildHeader(groupId), 'utf-8');
    const sessionManager = SessionManager.open(fixedPath);
    const header = sessionManager.getHeader();
    if (!header) {
        throw new Error(`failed to initialize session file at ${fixedPath}`);
    }
    const metadata = metadataFromHeader(header, fixedPath);
    await setHarnessMetadata(db, groupId, metadata);
    sessionCache.set(groupId, sessionManager);
    logger.info(`[HarnessFactory] [${groupId}] created new session ${metadata.id}`);
    return {sessionManager, metadata, isNew: true};
}

/** 登记由会话管理器创建的 AgentSession，供关闭时统一释放 */
export function registerAgentSession (session: AgentSession): void {
    agentSessions.add(session);
}

export async function closeAllSessions (): Promise<void> {
    for (const session of agentSessions) {
        session.dispose();
    }
    agentSessions.clear();
    sessionCache.clear();
    logger.info('[HarnessFactory] all sessions closed');
}

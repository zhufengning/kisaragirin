import { config } from '@/config';
import type { GraphitiEdge } from '~/util/graphiti-client';

export const MEMORIES_PAGE_SIZE = 20;
export const GRAPH_EDGE_LIMIT_DEFAULT = 200;

export interface MemoriesPageParams {
    allGroups: string[];
    defaultGroupId: string;
    groupId: string;
    searchQuery: string;
    mode: 'idle' | 'search' | 'list';
    view: 'list' | 'graph';
    graphEdgeLimit: number;
    currentPage: number;
}

export interface MemoriesEdgesResult {
    edges: GraphitiEdge[];
    totalCount: number;
    totalPages: number;
    error: string;
}

export function parseMemoriesParams (url: URL): MemoriesPageParams {
    const allGroups = config.input.group_whitelist.map(id => `group-${id}`);
    const defaultGroupId = allGroups[0] || '';

    const searchQuery = url.searchParams.get('search')?.trim() || '';
    const groupId = url.searchParams.get('group_id')?.trim() || defaultGroupId;
    const listParam = url.searchParams.get('list');
    const view = url.searchParams.get('view') === 'graph' ? 'graph' : 'list';
    const graphEdgeLimit = parseInt(
        url.searchParams.get('limit') || String(GRAPH_EDGE_LIMIT_DEFAULT), 10);
    const currentPage = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));

    let mode: 'idle' | 'search' | 'list' = 'idle';
    if (searchQuery) {
        mode = 'search';
    } else if (listParam === '1') {
        mode = 'list';
    }

    return { allGroups, defaultGroupId, groupId, searchQuery, mode, view, graphEdgeLimit, currentPage };
}

/**
 * 处理搜索栏提交，返回 POST-Redirect-GET 的目标地址。
 * 表单解析失败时返回 null，页面继续按 URL 参数渲染。
 */
export async function resolveMemoriesPostRedirect (
    url: URL,
    request: Request,
    currentGroupId: string,
): Promise<string | null> {
    let formData: FormData;
    try {
        formData = await request.formData();
    } catch {
        return null;
    }

    const action = formData.get('action')?.toString() || 'search';
    const searchQuery = (formData.get('search')?.toString() || '').trim();
    const formGroupId = formData.get('group_id')?.toString() || '';
    const groupId = formGroupId || currentGroupId;

    const redirectUrl = new URL(url);
    redirectUrl.searchParams.delete('page');
    redirectUrl.searchParams.delete('list');
    redirectUrl.searchParams.set('group_id', groupId);

    if (action === 'list') {
        redirectUrl.searchParams.delete('search');
        redirectUrl.searchParams.set('list', '1');
    } else if (searchQuery) {
        redirectUrl.searchParams.set('search', searchQuery);
    } else {
        redirectUrl.searchParams.delete('search');
    }

    return redirectUrl.pathname + redirectUrl.search;
}

export async function loadMemoriesEdges (
    mode: 'idle' | 'search' | 'list',
    searchQuery: string,
    groupId: string,
    currentPage: number,
): Promise<MemoriesEdgesResult> {
    const result: MemoriesEdgesResult = { edges: [], totalCount: 0, totalPages: 1, error: '' };
    if (mode === 'idle') return result;

    try {
        const graphiti = globalThis.__graphiti__;
        if (!graphiti || !graphiti.isReady) {
            result.error = 'Graphiti not initialized';
        } else if (mode === 'search') {
            const searchResult = await graphiti.search(searchQuery, groupId, MEMORIES_PAGE_SIZE);
            result.edges = searchResult.results;
            result.totalCount = searchResult.count;
        } else {
            const offset = (currentPage - 1) * MEMORIES_PAGE_SIZE;
            const listResult = await graphiti.getEdges(groupId, MEMORIES_PAGE_SIZE, offset);
            result.edges = listResult.edges;
            result.totalCount = listResult.total;
            result.totalPages = Math.max(1, Math.ceil(listResult.total / MEMORIES_PAGE_SIZE));
        }
    } catch (e: unknown) {
        console.error('[Graphiti Page] Error:', e);
        result.error = e instanceof Error ? e.message : String(e);
    }

    return result;
}

export function buildMemoriesPageUrl (url: URL, page: number): string {
    const target = new URL(url);
    target.searchParams.set('page', String(page));
    target.searchParams.set('list', '1');
    return target.pathname + target.search;
}

export function buildMemoriesViewSwitchUrl (url: URL, targetView: 'list' | 'graph'): string {
    const target = new URL(url);
    if (targetView === 'graph') {
        target.searchParams.set('view', 'graph');
        target.searchParams.delete('page');
        target.searchParams.delete('list');
        target.searchParams.delete('search');
    } else {
        target.searchParams.delete('view');
        target.searchParams.delete('limit');
    }
    return target.pathname + target.search;
}

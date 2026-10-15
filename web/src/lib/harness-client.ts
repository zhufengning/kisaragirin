import { createEntryElement, matchesFilter } from './harness-entry';
import type { SessionTreeEntry } from '@earendil-works/pi-agent-core';

const PAGE_SIZE = 50;

function requireElement<T extends HTMLElement> (id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error(`element #${id} not found`);
    return el as T;
}

function readGroupId (): number {
    const root = document.querySelector<HTMLElement>('.harness-page');
    const groupId = Number(root?.dataset.groupId ?? '0');
    if (!groupId) throw new Error('group id not found');
    return groupId;
}

/** Harness 日志页客户端入口：筛选、分页与条目渲染 */
export function initHarnessPage (): void {
    const groupId = readGroupId();

    const container = requireElement('entries-container');
    const loading = requireElement('loading');
    const errorEl = requireElement('error');
    const refreshBtn = requireElement<HTMLButtonElement>('refresh-btn');
    const entryCountEl = requireElement('entry-count');
    const paginationEl = requireElement('pagination');
    const filterButtons = document.querySelectorAll<HTMLButtonElement>('.filter-btn');

    let currentFilter = 'all';
    let currentEntries: SessionTreeEntry[] = [];
    let currentPage = 0;

    function renderPagination (totalPages: number): void {
        if (totalPages <= 1) {
            paginationEl.style.display = 'none';
            return;
        }
        paginationEl.innerHTML = '';
        paginationEl.style.display = 'flex';

        const prevBtn = document.createElement('button');
        prevBtn.type = 'button';
        prevBtn.className = 'page-btn';
        prevBtn.textContent = '上一页';
        prevBtn.disabled = currentPage === 0;
        prevBtn.addEventListener('click', () => {
            if (currentPage > 0) {
                currentPage--;
                renderEntries(currentEntries);
            }
        });

        const pageInfo = document.createElement('span');
        pageInfo.className = 'page-info';
        pageInfo.textContent = `${currentPage + 1} / ${totalPages}`;

        const nextBtn = document.createElement('button');
        nextBtn.type = 'button';
        nextBtn.className = 'page-btn';
        nextBtn.textContent = '下一页';
        nextBtn.disabled = currentPage >= totalPages - 1;
        nextBtn.addEventListener('click', () => {
            if (currentPage < totalPages - 1) {
                currentPage++;
                renderEntries(currentEntries);
            }
        });

        paginationEl.appendChild(prevBtn);
        paginationEl.appendChild(pageInfo);
        paginationEl.appendChild(nextBtn);
    }

    function renderEntries (entries: SessionTreeEntry[]): void {
        currentEntries = entries;
        container.innerHTML = '';

        const filtered = entries.filter(e => matchesFilter(e, currentFilter));
        entryCountEl.textContent = filtered.length === entries.length
            ? `${entries.length} 条`
            : `${filtered.length} / ${entries.length} 条`;

        const sorted = filtered.slice().reverse();
        const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
        if (currentPage > totalPages - 1) currentPage = totalPages - 1;
        const start = currentPage * PAGE_SIZE;
        const pageItems = sorted.slice(start, start + PAGE_SIZE);

        if (filtered.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'empty';
            empty.textContent = '暂无符合条件的条目';
            container.appendChild(empty);
            container.style.display = 'block';
            paginationEl.style.display = 'none';
            return;
        }

        for (let i = 0; i < pageItems.length; i++) {
            container.appendChild(createEntryElement(pageItems[i], start + i));
        }
        container.style.display = 'block';
        renderPagination(totalPages);
    }

    async function loadEntries (): Promise<void> {
        loading.style.display = 'block';
        errorEl.style.display = 'none';
        container.style.display = 'none';
        entryCountEl.textContent = '';
        currentPage = 0;

        try {
            const res = await fetch(`/api/harness?groupId=${groupId}`);
            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || `HTTP ${res.status}`);
            }
            if (!Array.isArray(data.entries)) {
                throw new Error('返回数据格式不正确');
            }
            renderEntries(data.entries as SessionTreeEntry[]);
        } catch (err) {
            errorEl.textContent = '加载失败：' + (err as Error).message;
            errorEl.style.display = 'block';
        } finally {
            loading.style.display = 'none';
        }
    }

    filterButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            filterButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFilter = btn.dataset.filter ?? 'all';
            currentPage = 0;
            renderEntries(currentEntries);
        });
    });

    refreshBtn.addEventListener('click', () => void loadEntries());

    void loadEntries();
}

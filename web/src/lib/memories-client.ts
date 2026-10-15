import { MemoriesGraphView } from './memories-graph';

/** 记忆管理页客户端入口：列表视图删除、图谱视图启动与群组/边数切换 */
export function initMemoriesPage (): void {
    document.addEventListener('DOMContentLoaded', () => {
        initDeleteAction();
        initGraphView();
    });
}

function initDeleteAction (): void {
    document.querySelector('.memory-list')?.addEventListener('click', e => {
        const btn = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
        if (!btn || btn.dataset.action !== 'delete') return;

        const uuid = btn.dataset.uuid || '';
        if (!uuid) return;
        if (!confirm('确定删除这条记忆？')) return;

        fetch(`/api/memories/${uuid}`, { method: 'DELETE', credentials: 'same-origin' })
            .then(res => {
                if (!res.ok) throw new Error();
                alert('删除成功！');
                location.reload();
            })
            .catch(() => alert('删除失败'));
    });
}

function initGraphView (): void {
    const canvas = document.getElementById('graph-canvas');
    if (!canvas) return;

    const statusEl = document.getElementById('graph-status');
    const panelEl = document.getElementById('graph-panel');
    if (!statusEl || !panelEl) return;

    const groupId = canvas.dataset.groupId || '';
    const edgeLimit = parseInt(canvas.dataset.edgeLimit || '200', 10);
    const groupSelect = document.getElementById('graph-group') as HTMLSelectElement | null;
    const limitSelect = document.getElementById('graph-limit') as HTMLSelectElement | null;

    // 群组 / 边数上限切换 → 整页跳转
    groupSelect?.addEventListener('change', () => {
        window.location.href =
            `/memories?view=graph&group_id=${encodeURIComponent(groupSelect.value)}&limit=${edgeLimit}`;
    });
    limitSelect?.addEventListener('change', () => {
        window.location.href =
            `/memories?view=graph&group_id=${encodeURIComponent(groupId)}` +
            `&limit=${encodeURIComponent(limitSelect.value)}`;
    });

    const view = new MemoriesGraphView({ canvas, groupId, edgeLimit, statusEl, panelEl });
    void view.load();
}

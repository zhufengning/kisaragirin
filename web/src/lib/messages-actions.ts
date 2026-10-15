function formatDate (d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export async function deleteMessageIds (ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    const noun = ids.length === 1 ? '这条消息' : `${ids.length} 条消息`;
    if (!confirm(`确定要删除 ${noun} 吗？此操作不可恢复。`)) return;
    try {
        const res = await fetch('/api/messages/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids })
        });
        const data = await res.json();
        if (data.success) {
            location.reload();
        } else {
            alert('删除失败：' + (data.error || '未知错误'));
        }
    } catch (err) {
        alert('删除失败：' + (err as Error).message);
    }
}

export function initImportControls (groupId: number): void {
    const importStart = document.getElementById('import-start') as HTMLInputElement | null;
    const importEnd = document.getElementById('import-end') as HTMLInputElement | null;
    const importBtn = document.getElementById('import-btn') as HTMLButtonElement | null;

    if (importStart && importEnd) {
        const today = new Date();
        const weekAgo = new Date();
        weekAgo.setDate(today.getDate() - 7);
        importStart.value = formatDate(weekAgo);
        importEnd.value = formatDate(today);
    }

    if (!importBtn) return;

    importBtn.addEventListener('click', async () => {
        const start = importStart?.value;
        const end = importEnd?.value;
        if (!start || !end) {
            alert('请选择开始和结束日期');
            return;
        }
        if (start > end) {
            alert('开始日期不能晚于结束日期');
            return;
        }
        if (!confirm(`确定导入 ${start} 至 ${end} 的历史消息到会话吗？（忽略压缩消息）`)) return;
        importBtn.disabled = true;
        importBtn.textContent = '导入中...';
        try {
            const res = await fetch(`/api/group/${groupId}/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ startDate: start, endDate: end })
            });
            const data = await res.json();
            if (data.success) {
                alert(`已导入 ${data.imported} 条消息`);
            } else {
                alert('导入失败：' + (data.error || '未知错误'));
            }
        } catch (err) {
            alert('导入失败：' + (err as Error).message);
        } finally {
            importBtn.disabled = false;
            importBtn.textContent = '导入历史';
        }
    });
}

export function initCompactButton (groupId: number): void {
    const compactBtn = document.getElementById('compact-btn') as HTMLButtonElement | null;
    if (!compactBtn) return;

    compactBtn.addEventListener('click', async () => {
        if (!confirm('确定要手动触发 compact 吗？这将把旧消息摘要成一条「前情提要」消息。')) return;
        compactBtn.disabled = true;
        compactBtn.textContent = 'Compacting...';
        try {
            const res = await fetch(`/api/compact?groupId=${groupId}`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                alert(data.compacted ? 'Compact 成功！' : '无需 compact');
                location.reload();
            } else {
                alert('Compact 失败：' + (data.error || '未知错误'));
            }
        } catch (err) {
            alert('Compact 失败：' + (err as Error).message);
        } finally {
            compactBtn.disabled = false;
            compactBtn.textContent = '手动 Compact';
        }
    });
}

export function initClearButton (groupId: number): void {
    const clearBtn = document.getElementById('clear-btn') as HTMLButtonElement | null;
    if (!clearBtn) return;

    clearBtn.addEventListener('click', async () => {
        if (!confirm(`确定要清空群 ${groupId} 的所有消息吗？此操作不可恢复。`)) return;
        clearBtn.disabled = true;
        clearBtn.textContent = '清空中...';
        try {
            const res = await fetch(`/api/group/${groupId}/clear`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                alert('已清空所有消息');
                location.reload();
            } else {
                alert('清空失败：' + (data.error || '未知错误'));
            }
        } catch (err) {
            alert('清空失败：' + (err as Error).message);
        } finally {
            clearBtn.disabled = false;
            clearBtn.textContent = '清空全部';
        }
    });
}

export function initBatchDelete (): void {
    const selectAll = document.getElementById('select-all') as HTMLInputElement | null;
    const rowCheckboxes = document.querySelectorAll<HTMLInputElement>('.row-checkbox');
    const batchDeleteBtn = document.getElementById('batch-delete-btn') as HTMLButtonElement | null;

    function updateBatchButton (): void {
        const checked = document.querySelectorAll<HTMLInputElement>('.row-checkbox:checked');
        if (batchDeleteBtn) {
            batchDeleteBtn.disabled = checked.length === 0;
            batchDeleteBtn.textContent = checked.length > 0 ? `批量删除 (${checked.length})` : '批量删除';
        }
    }

    if (selectAll) {
        selectAll.addEventListener('change', () => {
            const checked = selectAll.checked;
            rowCheckboxes.forEach(cb => { cb.checked = checked; });
            updateBatchButton();
        });
    }

    rowCheckboxes.forEach(cb => {
        cb.addEventListener('change', updateBatchButton);
    });

    batchDeleteBtn?.addEventListener('click', () => {
        const checked = Array.from(document.querySelectorAll<HTMLInputElement>('.row-checkbox:checked'));
        const ids = checked.map(cb => Number(cb.value));
        void deleteMessageIds(ids);
    });
}

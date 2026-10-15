import {
    deleteMessageIds,
    initBatchDelete,
    initClearButton,
    initCompactButton,
    initImportControls
} from './messages-actions';
import { initDetailModal, openDetailModal } from './messages-detail-modal';

/** 群消息页客户端入口：导入、compact、清空、批量删除与详情弹窗 */
export function initMessagesPage (): void {
    const groupId = readGroupId();

    initImportControls(groupId);
    initCompactButton(groupId);
    initClearButton(groupId);
    initBatchDelete();
    initDetailModal();
    initRowActions();
}

function readGroupId (): number {
    const root = document.querySelector<HTMLElement>('.table-wrap');
    const groupId = Number(root?.dataset.groupId ?? '0');
    if (!groupId) throw new Error('group id not found');
    return groupId;
}

function initRowActions (): void {
    document.querySelector('.message-table')?.addEventListener('click', e => {
        const target = e.target as HTMLElement;

        const deleteBtn = target.closest('.delete-btn');
        if (deleteBtn) {
            const id = Number((deleteBtn as HTMLElement).dataset.id);
            void deleteMessageIds([id]);
            return;
        }

        const detailBtn = target.closest('.detail-btn');
        if (detailBtn) {
            openDetailModal(detailBtn.closest<HTMLElement>('.message-row'));
            return;
        }

        const row = target.closest('.message-row');
        if (row && !target.closest('input, button')) {
            openDetailModal(row as HTMLElement);
        }
    });
}

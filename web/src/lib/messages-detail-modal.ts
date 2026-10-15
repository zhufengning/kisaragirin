function setText (id: string, text: string | undefined): void {
    const el = document.getElementById(id);
    if (el) el.textContent = text ?? '';
}

function closeDetailModal (): void {
    document.getElementById('detail-modal')?.classList.add('hidden');
}

export function initDetailModal (): void {
    const detailModal = document.getElementById('detail-modal');
    const modalClose = document.getElementById('modal-close');
    const modalCloseBtn = document.getElementById('modal-close-btn');

    modalClose?.addEventListener('click', closeDetailModal);
    modalCloseBtn?.addEventListener('click', closeDetailModal);
    detailModal?.addEventListener('click', e => {
        if (e.target === detailModal) closeDetailModal();
    });
}

export function openDetailModal (row: HTMLElement | null): void {
    const detailModal = document.getElementById('detail-modal');
    if (!row || !detailModal) return;

    setText('modal-title', `消息详情 #${row.dataset.id ?? ''}`);
    setText('modal-id', row.dataset.id);
    setText('modal-time', row.dataset.time);
    setText('modal-sender', row.dataset.sender);
    setText('modal-type', row.dataset.type);
    setText('modal-preview', row.dataset.preview);

    let segmentsText = row.dataset.segments ?? '';
    try {
        segmentsText = JSON.stringify(JSON.parse(segmentsText), null, 2);
    } catch {
        // 保持原样
    }
    setText('modal-segments', segmentsText);

    const imagesField = document.getElementById('modal-images-field');
    const imagesContainer = document.getElementById('modal-images');
    if (imagesField && imagesContainer) {
        let images: Array<{ sha256: string; description: string | null }> = [];
        try {
            images = JSON.parse(row.dataset.images || '[]');
        } catch {
            images = [];
        }
        imagesField.style.display = images.length > 0 ? '' : 'none';
        imagesContainer.textContent = images
            .map(img => `${img.sha256}\n${img.description || '（无描述）'}`)
            .join('\n\n');
    }

    detailModal.classList.remove('hidden');
}

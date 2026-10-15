/** 统一的时间展示格式（Asia/Shanghai） */
export function formatDateTime (iso: string | null | undefined): string {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    } catch {
        return iso ?? '';
    }
}

import type {AppConfig} from '~/config';

/** 读取群名称备注，未配置时返回 undefined */
export function getGroupName (groupId: number): string | undefined {
    const config = globalThis.__config__ as AppConfig | undefined;
    const name = config?.input.group_names?.[groupId];
    return name?.trim() || undefined;
}

/** 浏览器标题使用的群标识 */
export function formatGroupTitle (groupId: number, section: string): string {
    const name = getGroupName(groupId);
    return name ? `${name}（${groupId}）${section}` : `群 ${groupId} ${section}`;
}

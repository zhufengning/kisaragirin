import { formatSender, type StoredSegment } from '~/message-format';
import type { MessageListItem } from './messages-query';

export function formatTime (timestamp: number): string {
    const d = new Date(timestamp * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatSenderCell (msg: MessageListItem): { name: string; idLabel: string } {
    const id = msg.senderId;
    const name = msg.senderCard || msg.senderName || '';
    if (id == null) return { name: 'unknown', idLabel: '' };
    if (!name) return { name: `(${id})`, idLabel: '' };
    return {
        name: msg.isBot ? `${name}(me)` : name,
        idLabel: String(id)
    };
}

export function typeBadgeClass (type: string): string {
    switch (type) {
    case 'compact': return 'type-badge type-compact';
    case 'system': return 'type-badge type-system';
    default: return 'type-badge type-normal';
    }
}

export function typeLabel (type: string): string {
    switch (type) {
    case 'compact': return 'compact';
    case 'system': return 'system';
    default: return 'normal';
    }
}

export function segmentToRaw (seg: StoredSegment): string {
    switch (seg.type) {
    case 'text': return seg.text;
    case 'at': return `@${seg.targetName || seg.target}`;
    case 'image': return `[image:${seg.sha256.slice(0, 16)}...]`;
    case 'face': return `[face:${seg.name || seg.id}]`;
    case 'record': return '[record:语音]';
    case 'video': return `[video:${seg.fileName || '未知'}]`;
    case 'file': return `[file:${seg.fileName}]`;
    case 'json': return `[json:${seg.data ?? '未知json'}]`;
    case 'poke': return `[poke:${seg.pokeType},${seg.id}]`;
    case 'dice': return `[dice:${seg.result ?? '?'}]`;
    case 'rps': return `[rps:${seg.result ?? '?'}]`;
    case 'reply': return `[reply:${seg.id}]`;
    case 'forward': return `[forward:${seg.id}]`;
    case 'compact': return `**前情提要**: ${seg.text}`;
    case 'system': return `**系统消息**: ${seg.text}`;
    default: return `[${(seg as { type: string }).type}]`;
    }
}

export function formatMessageRaw (msg: MessageListItem): string {
    const isSpecial = msg.segments.length === 1 &&
        (msg.segments[0].type === 'compact' || msg.segments[0].type === 'system');
    if (isSpecial) {
        return msg.segments.map(segmentToRaw).join('');
    }
    const atMark = msg.isAtBot ? '(有人@我) ' : '';
    const sender = formatSender(msg);
    const body = msg.segments.map(segmentToRaw).join('');
    return `${atMark}[${sender}]: ${body}`;
}

export function formatPreview (msg: MessageListItem): string {
    const raw = formatMessageRaw(msg);
    return raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
}

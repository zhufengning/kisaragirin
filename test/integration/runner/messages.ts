import type {Message} from '@lib/types/messages';

export function textSegment (text: string): Message {
    return {type: 'text', data: {text}};
}

export function atSegment (qq: number | 'all'): Message {
    return {type: 'at', data: {qq: String(qq)}};
}

export function imageSegment (url: string): Message {
    return {type: 'image', data: {file: url, url}};
}

export function replySegment (messageId: number): Message {
    return {type: 'reply', data: {id: messageId}};
}

export function nowSeconds (): number {
    return Math.floor(Date.now() / 1000);
}

/** 取模型请求中最后一条 user 消息的文本 */
export function lastUserText (body: {messages: Array<{role: string; content: unknown}>}): string {
    for (let index = body.messages.length - 1; index >= 0; index--) {
        const message = body.messages[index];
        if (message.role !== 'user') continue;
        if (typeof message.content === 'string') return message.content;
        if (!Array.isArray(message.content)) return '';
        return (message.content as Array<{type: string; text?: string}>)
            .filter(block => block.type === 'text')
            .map(block => block.text ?? '')
            .join('');
    }
    return '';
}

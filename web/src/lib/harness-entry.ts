import type { AgentMessage, SessionTreeEntry } from '@earendil-works/pi-agent-core';
import type { ImageContent, TextContent, ThinkingContent, ToolCall } from '@earendil-works/pi-ai';

const COLLAPSE_CHARS = 800;

type ContentBlock = TextContent | ThinkingContent | ToolCall | ImageContent;

export function formatTimestamp (iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function textLength (value: unknown): number {
    if (value == null) return 0;
    if (typeof value === 'string') return value.length;
    try {
        return JSON.stringify(value).length;
    } catch {
        return String(value).length;
    }
}

function makeCollapsible (contentEl: Node, charCount: number): Node {
    if (charCount <= COLLAPSE_CHARS) return contentEl;

    const wrap = document.createElement('div');
    wrap.className = 'collapsible collapsed';

    const inner = document.createElement('div');
    inner.className = 'collapsible-body';
    inner.appendChild(contentEl);
    wrap.appendChild(inner);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'collapse-toggle';
    toggle.textContent = `展开全部（约 ${charCount.toLocaleString()} 字符）`;
    toggle.addEventListener('click', () => {
        const collapsed = wrap.classList.toggle('collapsed');
        toggle.textContent = collapsed
            ? `展开全部（约 ${charCount.toLocaleString()} 字符）`
            : '收起';
    });
    wrap.appendChild(toggle);
    return wrap;
}

function appendText (parent: HTMLElement, text: unknown): void {
    if (text == null || text === '') return;
    const span = document.createElement('div');
    span.className = 'block-text';
    span.textContent = String(text);
    parent.appendChild(makeCollapsible(span, String(text).length));
}

function appendCodeBlock (
    parent: HTMLElement,
    label: string,
    value: unknown,
    opts: { variant?: string } = {}
): void {
    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    if (opts.variant) wrap.classList.add(`code-block--${opts.variant}`);

    if (label) {
        const lbl = document.createElement('div');
        lbl.className = 'code-block-label';
        lbl.textContent = label;
        wrap.appendChild(lbl);
    }

    const pre = document.createElement('pre');
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    pre.textContent = text;
    wrap.appendChild(pre);
    parent.appendChild(makeCollapsible(wrap, textLength(text)));
}

function escapeHtml (s: unknown): string {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderContentBlock (parent: HTMLElement, block: ContentBlock): void {
    switch (block.type) {
    case 'text':
        appendText(parent, block.text);
        break;
    case 'toolCall': {
        const callWrap = document.createElement('div');
        callWrap.className = 'tool-call';
        const header = document.createElement('div');
        header.className = 'tool-call-header';
        header.innerHTML = `<span class="tool-call-icon">⚙</span><span>tool-call</span><code>${escapeHtml(block.name || 'unknown')}</code>`;
        callWrap.appendChild(header);
        appendCodeBlock(callWrap, 'arguments', block.arguments || {}, { variant: 'nested' });
        parent.appendChild(callWrap);
        break;
    }
    case 'image': {
        const img = document.createElement('div');
        img.className = 'block-meta';
        img.textContent = `[image: ${block.mimeType || 'unknown'}]`;
        parent.appendChild(img);
        break;
    }
    case 'thinking':
        appendCodeBlock(parent, 'thinking', block.thinking || '', { variant: 'thinking' });
        break;
    default:
        appendCodeBlock(parent, (block as { type: string }).type, block);
        break;
    }
}

function renderMessageBody (parent: HTMLElement, message: AgentMessage): void {
    const content: unknown = (message as { content?: unknown }).content;
    if (typeof content === 'string') {
        appendText(parent, content);
    } else if (Array.isArray(content)) {
        for (const block of content) {
            renderContentBlock(parent, block as ContentBlock);
        }
    } else if (content != null) {
        appendCodeBlock(parent, 'content', content);
    }
}

function createBadge (text: string, variant: string): HTMLElement {
    const badge = document.createElement('span');
    badge.className = `badge badge-${variant}`;
    badge.textContent = text;
    return badge;
}

function roleVariant (role: string): string {
    if (role === 'user') return 'user';
    if (role === 'assistant') return 'assistant';
    if (role === 'toolResult') return 'tool';
    if (role === 'system') return 'system';
    return 'default';
}

export function createEntryElement (entry: SessionTreeEntry, index: number): HTMLElement {
    const el = document.createElement('article');
    el.className = 'entry';
    el.dataset.type = entry.type;

    const header = document.createElement('div');
    header.className = 'entry-header';

    const meta = document.createElement('div');
    meta.className = 'entry-meta';

    const indexEl = document.createElement('span');
    indexEl.className = 'entry-index';
    indexEl.textContent = String(index + 1);
    meta.appendChild(indexEl);

    const body = document.createElement('div');
    body.className = 'entry-body';

    const ts = document.createElement('span');
    ts.className = 'timestamp';
    ts.textContent = formatTimestamp(entry.timestamp);

    if (entry.type === 'message') {
        const role = entry.message.role || 'unknown';
        el.dataset.role = role;
        el.classList.add(`entry--${roleVariant(role)}`);
        meta.appendChild(createBadge(`message · ${role}`, roleVariant(role)));
        renderMessageBody(body, entry.message);
        const msg = entry.message;
        if (msg.role === 'assistant' && (msg.stopReason === 'error' || msg.stopReason === 'aborted')) {
            el.classList.add('entry--error');
            const errWrap = document.createElement('div');
            errWrap.className = 'code-block code-block--error';
            const errLabel = document.createElement('div');
            errLabel.className = 'code-block-label';
            errLabel.textContent = msg.stopReason === 'aborted' ? '已中止' : '调用错误';
            errWrap.appendChild(errLabel);
            const errPre = document.createElement('pre');
            errPre.textContent = msg.errorMessage || '(无错误详情)';
            errWrap.appendChild(errPre);
            body.appendChild(errWrap);
            if (msg.diagnostics && msg.diagnostics.length > 0) {
                appendCodeBlock(body, 'diagnostics', msg.diagnostics, { variant: 'error' });
            }
        }
    } else if (entry.type === 'compaction') {
        el.dataset.role = 'compaction';
        el.classList.add('entry--compaction');
        meta.appendChild(createBadge('compaction', 'compaction'));
        appendText(body, entry.summary || '');
    } else if (entry.type === 'model_change') {
        el.classList.add('entry--meta');
        meta.appendChild(createBadge('model-change', 'default'));
        appendText(body, `${entry.provider || 'unknown'} / ${entry.modelId || 'unknown'}`);
    } else if (entry.type === 'active_tools_change') {
        el.classList.add('entry--meta');
        meta.appendChild(createBadge('active-tools-change', 'default'));
        appendText(body, (entry.activeToolNames ?? []).join(', '));
    } else if (entry.type === 'thinking_level_change') {
        el.classList.add('entry--meta');
        meta.appendChild(createBadge('thinking-level-change', 'default'));
        appendText(body, entry.thinkingLevel || '');
    } else if (entry.type === 'branch_summary') {
        el.classList.add('entry--meta');
        meta.appendChild(createBadge('branch-summary', 'default'));
        appendText(body, entry.summary || '');
    } else if (entry.type === 'custom') {
        el.classList.add('entry--meta');
        meta.appendChild(createBadge(`custom · ${entry.customType || 'unknown'}`, 'default'));
        appendCodeBlock(body, 'data', entry.data);
    } else if (entry.type === 'custom_message') {
        el.classList.add('entry--meta');
        meta.appendChild(createBadge(`custom-message · ${entry.customType || 'unknown'}`, 'default'));
        appendText(body, typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content, null, 2));
    } else if (entry.type === 'label') {
        el.classList.add('entry--meta');
        meta.appendChild(createBadge('label', 'default'));
        appendText(body, `${entry.targetId || 'null'} → ${entry.label || '(none)'}`);
    } else if (entry.type === 'session_info') {
        el.classList.add('entry--meta');
        meta.appendChild(createBadge('session-info', 'default'));
        appendText(body, entry.name || '');
    } else if (entry.type === 'leaf') {
        el.classList.add('entry--meta');
        meta.appendChild(createBadge('leaf', 'default'));
        appendText(body, `target: ${entry.targetId || 'null'}`);
    } else {
        el.classList.add('entry--meta');
        meta.appendChild(createBadge((entry as { type: string }).type || 'unknown', 'default'));
        appendCodeBlock(body, 'entry', entry);
    }

    const idSpan = document.createElement('span');
    idSpan.className = 'entry-id';
    idSpan.title = entry.id || '';
    idSpan.textContent = entry.id ? entry.id.slice(0, 8) : '';

    const jsonBtn = document.createElement('button');
    jsonBtn.type = 'button';
    jsonBtn.className = 'json-toggle';
    jsonBtn.textContent = 'JSON';

    const jsonView = document.createElement('pre');
    jsonView.className = 'entry-json';
    jsonView.style.display = 'none';
    try {
        jsonView.textContent = JSON.stringify(entry, null, 2);
    } catch {
        jsonView.textContent = String(entry);
    }
    jsonBtn.addEventListener('click', () => {
        const hidden = jsonView.style.display === 'none' || !jsonView.style.display;
        jsonView.style.display = hidden ? 'block' : 'none';
        jsonBtn.classList.toggle('active', hidden);
        jsonBtn.textContent = hidden ? '收起' : 'JSON';
    });

    header.appendChild(meta);
    header.appendChild(ts);
    header.appendChild(jsonBtn);
    header.appendChild(idSpan);
    el.appendChild(header);
    body.appendChild(jsonView);
    el.appendChild(body);
    return el;
}

export function matchesFilter (entry: SessionTreeEntry, filter: string): boolean {
    if (filter === 'all') return true;
    if (filter === 'compaction') return entry.type === 'compaction';
    if (entry.type !== 'message') return false;

    const role = entry.message.role;
    if (filter === 'user') return role === 'user';
    if (filter === 'assistant') return role === 'assistant';
    if (filter === 'tool') {
        if (role === 'toolResult') return true;
        if (role === 'assistant' && Array.isArray(entry.message.content)) {
            return entry.message.content.some(b => b?.type === 'toolCall');
        }
        return false;
    }
    return false;
}

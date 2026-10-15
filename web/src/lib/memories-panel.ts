import { formatDateTime } from './format-date';

export interface NodeFactItem {
    edgeId: string;
    fact: string;
}

export interface NodePanelData {
    nodeId: string;
    label: string;
    summary: string;
    degree: number;
    facts: NodeFactItem[];
    expanding: boolean;
}

export interface EdgePanelData {
    edgeId: string;
    uuid: string;
    validAt: string | null;
    invalidAt: string | null;
    expiredAt: string | null;
    fact: string;
}

export interface MemoriesPanelCallbacks {
    onSelectEdge: (edgeId: string) => void;
    onPreviewEdge: (edgeId: string) => void;
    onLeaveEdge: () => void;
    onExpandNeighbors: (nodeId: string) => void;
    onDeleteEdge: (edgeId: string) => void;
}

function makeRow (label: string, value: string): HTMLElement {
    const div = document.createElement('div');
    div.className = 'panel-row';
    const key = document.createElement('span');
    key.className = 'panel-key';
    key.textContent = label;
    const val = document.createElement('span');
    val.className = 'panel-val';
    val.textContent = value;
    div.append(key, val);
    return div;
}

/** 图谱右侧详情面板：节点详情、事实详情与提示文本 */
export class MemoriesPanel {
    private readonly panelEl: HTMLElement;
    private readonly callbacks: MemoriesPanelCallbacks;

    constructor (panelEl: HTMLElement, callbacks: MemoriesPanelCallbacks) {
        this.panelEl = panelEl;
        this.callbacks = callbacks;
    }

    hint (text: string): void {
        const p = document.createElement('p');
        p.className = 'hint';
        p.textContent = text;
        this.setContent([p]);
    }

    showNode (data: NodePanelData): void {
        const content: Node[] = [];

        const title = document.createElement('h3');
        title.textContent = data.label;
        content.push(title);

        content.push(makeRow('实体', data.nodeId.slice(0, 8)));
        content.push(makeRow('度数', String(data.degree)));

        const summaryHead = document.createElement('h4');
        summaryHead.textContent = '摘要';
        content.push(summaryHead);
        const summaryP = document.createElement('p');
        summaryP.textContent = data.summary;
        content.push(summaryP);

        const relHead = document.createElement('h4');
        relHead.textContent = `关联事实 (${data.degree})`;
        content.push(relHead);

        const list = document.createElement('ul');
        list.className = 'panel-facts';
        for (const item of data.facts) {
            const li = document.createElement('li');
            li.textContent = item.fact;
            // 悬停：画布上单独预览这条边；点击：切换选中并显示详情
            li.addEventListener('click', () => this.callbacks.onSelectEdge(item.edgeId));
            li.addEventListener('mouseenter', () => this.callbacks.onPreviewEdge(item.edgeId));
            li.addEventListener('mouseleave', () => this.callbacks.onLeaveEdge());
            list.appendChild(li);
        }
        content.push(list);

        const actions = document.createElement('div');
        actions.className = 'panel-actions';
        const expandBtn = document.createElement('button');
        expandBtn.className = 'btn btn-sm';
        expandBtn.textContent = data.expanding ? '展开中...' : '展开邻居节点';
        expandBtn.disabled = data.expanding;
        expandBtn.addEventListener('click', () => this.callbacks.onExpandNeighbors(data.nodeId));
        actions.appendChild(expandBtn);
        content.push(actions);

        this.setContent(content);
    }

    showEdge (data: EdgePanelData): void {
        const content: Node[] = [];

        const title = document.createElement('h3');
        title.textContent = '事实关系';
        content.push(title);

        content.push(makeRow('ID', data.uuid.slice(0, 8)));
        content.push(makeRow('生效', formatDateTime(data.validAt) || '—'));
        content.push(makeRow('失效', formatDateTime(data.invalidAt) || '—'));
        content.push(makeRow('过期', formatDateTime(data.expiredAt) || '—'));

        const factHead = document.createElement('h4');
        factHead.textContent = '内容';
        content.push(factHead);
        const factP = document.createElement('p');
        factP.className = 'panel-fact-text';
        factP.textContent = data.fact;
        content.push(factP);

        const delBtn = document.createElement('button');
        delBtn.className = 'btn btn-sm btn-danger';
        delBtn.textContent = '删除该事实';
        delBtn.addEventListener('click', () => this.callbacks.onDeleteEdge(data.edgeId));
        content.push(delBtn);

        this.setContent(content);
    }

    private setContent (content: Node[]): void {
        this.panelEl.replaceChildren(...content);
    }
}

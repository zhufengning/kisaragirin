import cytoscape from 'cytoscape';
import type { GraphitiNode, GraphitiSubgraph, GraphitiSubgraphEdge } from '~/util/graphiti-client';
import { MemoriesPanel, type EdgePanelData, type NodeFactItem, type NodePanelData } from './memories-panel';

const IDEAL_EDGE_LENGTH = 100;
const DEGREE_SUM_CAP = 60;
const LABEL_BASE_NODE_FS = 11;
const LABEL_BASE_EDGE_FS = 10;

const GRAPH_STYLE: cytoscape.StylesheetJson = [
    {
        selector: 'node',
        style: {
            'background-color': '#6c7ae0',
            label: 'data(label)',
            color: '#e8e8ef',
            'font-size': 11,
            'text-wrap': 'ellipsis',
            'text-max-width': '80',
            'text-valign': 'bottom',
            'text-margin-y': 4,
            width: 20,
            height: 20,
            'border-width': 1,
            'border-color': '#2a2a32'
        }
    },
    {
        selector: 'node.neighbor-highlight',
        style: {
            'border-color': '#f0f0f5',
            'border-width': 2
        }
    },
    {
        selector: 'edge',
        style: {
            width: 1.5,
            'line-color': '#3d3d4d',
            'target-arrow-color': '#3d3d4d',
            'target-arrow-shape': 'triangle',
            'arrow-scale': 0.6,
            'curve-style': 'bezier',
            color: '#9090a0',
            'font-size': 8,
            'text-wrap': 'wrap',
            'text-max-width': '120',
            'z-index': 1
        }
    },
    {
        selector: 'edge.stale',
        style: {
            'line-style': 'dashed',
            opacity: 0.45
        }
    },
    {
        selector: 'node.selected',
        style: {
            'border-color': '#f5f5ff',
            'border-width': 3,
            'background-color': '#8a96ec'
        }
    },
    {
        // 节点选中时的邻接边：仅提亮加粗，不显示 fact 标签
        selector: 'edge.focus',
        style: {
            'line-color': '#8a96ec',
            'target-arrow-color': '#8a96ec',
            width: 2
        }
    },
    {
        // fact 标签只在「单条边被选中 / 悬停预览」时显示，避免多标签堆叠
        selector: 'edge.selected, edge.preview',
        style: {
            'line-color': '#b3bdf0',
            'target-arrow-color': '#b3bdf0',
            width: 2.5,
            label: 'data(fact)',
            color: '#cdd3f2',
            'text-wrap': 'wrap',
            'text-max-width': '200',
            'z-index': 5
        }
    },
    {
        selector: '.dimmed',
        style: { opacity: 0.15 }
    }
];

interface GraphSelection {
    kind: 'node' | 'edge';
    id: string;
}

interface GraphViewOptions {
    canvas: HTMLElement;
    groupId: string;
    edgeLimit: number;
    statusEl: HTMLElement;
    panelEl: HTMLElement;
}

type SubgraphPayload = GraphitiSubgraph & { total_edges?: number };
type NeighborsPayload = GraphitiSubgraph & { node: GraphitiNode | null };

/** 记忆实体事实网络视图：布局、选中高亮、悬浮提示、详情面板与邻居展开 */
export class MemoriesGraphView {
    private readonly canvas: HTMLElement;
    private readonly groupId: string;
    private readonly edgeLimit: number;
    private readonly statusEl: HTMLElement;
    private readonly panel: MemoriesPanel;
    private readonly tooltip = document.createElement('div');

    private cy: cytoscape.Core | null = null;
    private selection: GraphSelection | null = null;
    private loadingNeighbors = false;
    private zoomRaf = 0;

    constructor (options: GraphViewOptions) {
        this.canvas = options.canvas;
        this.groupId = options.groupId;
        this.edgeLimit = options.edgeLimit;
        this.statusEl = options.statusEl;
        this.tooltip.className = 'graph-tooltip';
        this.panel = new MemoriesPanel(options.panelEl, {
            onSelectEdge: edgeId => this.selectEdgeById(edgeId),
            onPreviewEdge: edgeId => this.previewEdgeById(edgeId),
            onLeaveEdge: () => this.restoreHighlight(),
            onExpandNeighbors: nodeId => void this.expandNeighbors(nodeId),
            onDeleteEdge: edgeId => this.deleteEdge(edgeId)
        });
    }

    async load (): Promise<void> {
        try {
            this.setStatus('加载图谱...');
            const res = await fetch(
                `/api/memories/graph?group_id=${encodeURIComponent(this.groupId)}&limit=${this.edgeLimit}`,
                { credentials: 'same-origin' });
            const payload = (await res.json()) as SubgraphPayload & { error?: string };
            if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);

            if (payload.nodes.length === 0) {
                this.canvas.classList.add('graph-empty');
                this.canvas.textContent = '该群组暂无可视化的实体事实网络（还没有产生任何记忆）';
                this.setStatus('暂无数据');
                return;
            }

            this.cy = cytoscape({
                container: this.canvas,
                elements: this.subgraphElements(payload.nodes, payload.edges),
                wheelSensitivity: 0.45,
                minZoom: 0.25,
                // 真正的布局由 layoutElements() 去重后执行，这里先随机铺开
                layout: { name: 'grid', padding: 30 },
                style: GRAPH_STYLE
            });

            const graph = this.cy;

            this.refreshDegrees();
            this.layoutElements();
            this.canvas.appendChild(this.tooltip);

            graph.on('zoom', () => {
                if (this.zoomRaf) return;
                this.zoomRaf = requestAnimationFrame(() => {
                    this.zoomRaf = 0;
                    this.compensateLabels();
                });
            });
            this.compensateLabels();

            this.bindEvents(graph);

            const totalInfo = payload.total_edges && payload.total_edges > payload.edges.length
                ? ` · 事实共 ${payload.total_edges} 条（仅展示最近 ${payload.edges.length} 条）`
                : '';
            this.setStatus(`节点 ${graph.nodes().length} · 显示事实边 ${graph.edges().length}${totalInfo}`);
            setTimeout(() => graph.fit(undefined, 40), 50);
        } catch (err: unknown) {
            this.setStatus(err instanceof Error ? err.message : String(err), true);
        }
    }

    private bindEvents (graph: cytoscape.Core): void {
        graph.on('mouseover', 'edge', evt => {
            const edge = evt.target;
            const p = edge.renderedMidpoint();
            this.tooltip.textContent = String(edge.data('fact'));
            this.moveTip(p.x, p.y);
            if (!this.isSelectedEdge(edge.id())) edge.addClass('preview');
        });

        graph.on('mouseout', 'edge', evt => {
            this.hideTip();
            evt.target.removeClass('preview');
        });

        graph.on('mouseover', 'node', evt => {
            const n = evt.target;
            const name = String(n.data('label') || n.id().slice(0, 8));
            const summary = n.data('summary') ? String(n.data('summary')) : '';
            this.tooltip.textContent = summary
                ? `${name}\n${summary.slice(0, 140)}${summary.length > 140 ? '…' : ''}`
                : name;
            const p = n.renderedPosition();
            this.moveTip(p.x, p.y);
        });

        graph.on('mouseout', 'node', () => this.hideTip());

        // 平移 / 缩放后旧坐标失效，直接隐藏提示
        graph.on('viewport', () => this.hideTip());

        graph.on('tap', 'node', evt => this.selectNode(evt.target));

        graph.on('tap', 'edge', evt => this.selectEdge(evt.target));

        graph.on('tap', evt => {
            if (evt.target === graph) {
                this.selection = null;
                this.clearSelection();
                this.panel.hint('点击节点或边查看详情，悬停可快速预览内容');
            }
        });
    }

    private nodeDegree (node: cytoscape.NodeSingular): number {
        return node.connectedEdges().length;
    }

    // 布局参数：按度数差异化，枢纽节点撑得更开，叶子保持紧凑
    private coseLayout (): cytoscape.LayoutOptions {
        return {
            name: 'cose',
            animate: false,
            padding: 30,
            // 枢纽间的边目标更长：两端度数之和越高，边越长（最高 3 倍）
            idealEdgeLength: (edge: cytoscape.EdgeSingular) => {
                const sum = Math.min(this.nodeDegree(edge.source()) + this.nodeDegree(edge.target()), DEGREE_SUM_CAP);
                return IDEAL_EDGE_LENGTH * (1 + sum / DEGREE_SUM_CAP * 2);
            },
            // 斥力随度数增长：枢纽点互推更强，避免重叠成团
            nodeRepulsion: (node: cytoscape.NodeSingular) => 180_000 * Math.sqrt(1 + this.nodeDegree(node)),
            // 允许围绕初始位置迭代更多轮，让强斥力充分收敛
            numIter: 1200,
            gravity: 0.8
        };
    }

    private setStatus (text: string, isError = false): void {
        this.statusEl.textContent = text;
        this.statusEl.classList.toggle('graph-status-error', isError);
    }

    private updateStatusCounts (): void {
        if (!this.cy) return;
        const nodes = this.cy.nodes().length;
        const edgesCount = this.cy.edges().length;
        this.setStatus(`节点 ${nodes} · 显示事实边 ${edgesCount}`);
    }

    private moveTip (x: number, y: number): void {
        this.tooltip.style.left = `${x}px`;
        this.tooltip.style.top = `${y}px`;
        this.tooltip.style.display = 'block';
    }

    private hideTip (): void {
        this.tooltip.style.display = 'none';
    }

    private clearSelection (): void {
        if (!this.cy) return;
        this.cy.elements().removeClass(['selected', 'dimmed', 'preview', 'focus']);
        this.cy.nodes().removeClass('neighbor-highlight');
    }

    private highlightNeighborhood (node: cytoscape.CollectionReturnValue): void {
        if (!this.cy) return;
        // 邻接边只加 focus（提亮不显标签），标签留给单独选中的边
        this.cy.elements().addClass('dimmed');
        node.removeClass('dimmed').addClass('selected neighbor-highlight');
        node.connectedEdges().removeClass('dimmed').addClass('focus');
        node.neighborhood().removeClass('dimmed').addClass('neighbor-highlight');
    }

    private isSelectedEdge (edgeId: string): boolean {
        return this.selection !== null && this.selection.kind === 'edge' && this.selection.id === edgeId;
    }

    private selectNode (node: cytoscape.CollectionReturnValue): void {
        if (!this.cy) return;
        this.selection = { kind: 'node', id: node.id() };
        this.clearSelection();
        this.highlightNeighborhood(node);
        this.showNodePanel(node.id());
    }

    private selectEdge (edge: cytoscape.CollectionReturnValue): void {
        if (!this.cy) return;
        this.selection = { kind: 'edge', id: edge.id() };
        this.clearSelection();
        this.cy.elements().addClass('dimmed');
        edge.removeClass('dimmed').addClass('selected');
        edge.connectedNodes().removeClass('dimmed').addClass('neighbor-highlight');
        this.showEdgePanel(edge.id());
    }

    // 面板行悬停：临时只突出这一条边（含标签），移开后恢复当前选区
    private previewEdge (edge: cytoscape.CollectionReturnValue): void {
        if (!this.cy || this.isSelectedEdge(edge.id())) return;
        this.clearSelection();
        this.cy.elements().addClass('dimmed');
        edge.removeClass('dimmed').addClass('preview');
        edge.connectedNodes().removeClass('dimmed').addClass('neighbor-highlight');
    }

    private restoreHighlight (): void {
        if (!this.cy) return;
        this.clearSelection();
        if (!this.selection) return;
        const el = this.cy.getElementById(this.selection.id);
        if (el.empty()) {
            this.selection = null;
            return;
        }
        if (this.selection.kind === 'node') {
            this.highlightNeighborhood(el);
        } else {
            el.addClass('selected');
            el.connectedNodes().removeClass('dimmed').addClass('neighbor-highlight');
        }
    }

    // 面板事件里拿到的是 EdgeSingular，统一走 id 中转避免类型分歧
    private selectEdgeById (edgeId: string): void {
        if (!this.cy) return;
        this.selectEdge(this.cy.getElementById(edgeId));
    }

    private previewEdgeById (edgeId: string): void {
        if (!this.cy) return;
        this.previewEdge(this.cy.getElementById(edgeId));
    }

    private refreshDegrees (): void {
        const graph = this.cy;
        if (!graph) return;
        graph.batch(() => {
            graph.nodes().forEach(node => {
                const deg = node.connectedEdges().length;
                const size = Math.min(18 + deg * 2, 46);
                node.style({ width: size, height: size });
            });
        });
    }

    private subgraphElements (
        nodes: GraphitiNode[],
        apiEdges: GraphitiSubgraphEdge[]
    ): cytoscape.ElementDefinition[] {
        const elements: cytoscape.ElementDefinition[] = [];
        for (const n of nodes) {
            if (!n.uuid) continue;
            elements.push({
                group: 'nodes',
                data: {
                    id: n.uuid,
                    kind: 'entity',
                    label: n.name || n.uuid.slice(0, 8),
                    summary: n.summary ?? null
                }
            });
        }
        for (const r of apiEdges) {
            if (!r.uuid || !r.source_node_uuid || !r.target_node_uuid) continue;
            const stale = Boolean(r.invalid_at || r.expired_at);
            elements.push({
                group: 'edges',
                data: {
                    id: r.uuid,
                    source: r.source_node_uuid,
                    target: r.target_node_uuid,
                    fact: r.fact,
                    validAt: r.valid_at,
                    invalidAt: r.invalid_at,
                    expiredAt: r.expired_at,
                    createdAt: r.created_at
                },
                classes: stale ? 'stale' : ''
            });
        }
        return elements;
    }

    private mergeSubgraph (apiNodes: GraphitiNode[], apiEdges: GraphitiSubgraphEdge[]): number {
        const graph = this.cy;
        if (!graph) return 0;
        let added = 0;
        graph.batch(() => {
            for (const el of this.subgraphElements(apiNodes, apiEdges)) {
                const id = String(el.data.id);
                if (graph.getElementById(id).nonempty()) continue;
                // 容忍悬空引用：端点尚未加入的边直接跳过
                if (el.group === 'edges'
                    && (!graph.getElementById(String(el.data.source)).nonempty()
                        || !graph.getElementById(String(el.data.target)).nonempty())) {
                    continue;
                }
                graph.add(el);
                added++;
            }
        });
        this.refreshDegrees();
        return added;
    }

    private showNodePanel (nodeId: string): void {
        const graph = this.cy;
        if (!graph) return;

        const node = graph.getElementById(nodeId);
        const entityName = nodeId.slice(0, 8);
        const degree = node.connectedEdges().length;

        const facts: NodeFactItem[] = [];
        node.connectedEdges().forEach(edge => {
            facts.push({ edgeId: edge.id(), fact: String(edge.data('fact')) });
        });

        const data: NodePanelData = {
            nodeId,
            label: node.data('label') || entityName,
            summary: node.data('summary') ? String(node.data('summary')) : '(无摘要)',
            degree,
            facts,
            expanding: this.loadingNeighbors
        };
        this.panel.showNode(data);
    }

    private showEdgePanel (edgeId: string): void {
        const graph = this.cy;
        if (!graph) return;

        const edge = graph.getElementById(edgeId);
        const data: EdgePanelData = {
            edgeId,
            uuid: String(edge.data('id')),
            validAt: edge.data('validAt') ?? null,
            invalidAt: edge.data('invalidAt') ?? null,
            expiredAt: edge.data('expiredAt') ?? null,
            fact: String(edge.data('fact'))
        };
        this.panel.showEdge(data);
    }

    private async expandNeighbors (nodeId: string): Promise<void> {
        if (!this.cy || this.loadingNeighbors) return;
        this.loadingNeighbors = true;
        try {
            this.setStatus('展开邻接中...');
            const res = await fetch(
                `/api/memories/graph/neighbors?uuid=${encodeURIComponent(nodeId)}` +
                `&limit=${Math.min(this.edgeLimit, 100)}`,
                { credentials: 'same-origin' });
            const payload = (await res.json()) as NeighborsPayload & { error?: string };
            if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);

            const added = this.mergeSubgraph(payload.nodes, payload.edges);
            this.layoutElements();
            if (added > 0) {
                if (this.cy) this.selectNode(this.cy.getElementById(nodeId));
            } else {
                this.panel.hint('没有更多可展开的邻居了');
            }
            this.updateStatusCounts();
        } catch (err: unknown) {
            this.setStatus(err instanceof Error ? err.message : String(err), true);
        } finally {
            this.loadingNeighbors = false;
        }
    }

    /**
     * 参与力学布局的元素：平行边去重且排除自环。
     * 若不处理，同一对节点间的多条边会让 cose 出现退化位移（距离 0 时方向无定义），
     * 表现为只有彼此相连的 A/B 两点在初始布局后仍然重叠。
     */
    private layoutElements (): void {
        const graph = this.cy;
        if (!graph) return;

        const seenPairs = new Set<string>();
        const uniqueEdges: cytoscape.EdgeSingular[] = [];
        graph.edges().forEach(e => {
            if (e.isLoop()) return;
            const key = [e.source().id(), e.target().id()].sort().join('~');
            if (seenPairs.has(key)) return;
            seenPairs.add(key);
            uniqueEdges.push(e);
        });
        const layoutEls = uniqueEdges.reduce<cytoscape.CollectionReturnValue>(
            (col, e) => col.union(e),
            graph.nodes() as cytoscape.CollectionReturnValue
        );
        layoutEls.layout(this.coseLayout()).run();
        setTimeout(() => this.cy?.fit(undefined, 40), 50);
    }

    // 标签缩放补偿：字号随 zoom 反向放大，屏幕上保持恒定可读
    private compensateLabels (): void {
        const graph = this.cy;
        if (!graph) return;

        const z = Math.max(graph.zoom(), 0.01);
        const nodeFs = Math.min(LABEL_BASE_NODE_FS / z, 28);
        const edgeFs = Math.min(LABEL_BASE_EDGE_FS / z, 24);
        const scaleN = nodeFs / LABEL_BASE_NODE_FS;
        const scaleE = edgeFs / LABEL_BASE_EDGE_FS;
        graph.batch(() => {
            graph.nodes().style({
                'font-size': String(nodeFs),
                'text-max-width': String(Math.min(80 * scaleN, 300))
            });
            graph.edges().style({
                'font-size': String(edgeFs),
                'text-max-width': String(Math.min(200 * scaleE, 380))
            });
        });
    }

    private deleteEdge (edgeId: string): void {
        if (!this.cy) return;
        if (!confirm('确定删除这条事实？相关节点和其余事实不受影响。')) return;
        fetch(`/api/memories/${encodeURIComponent(edgeId)}`, { method: 'DELETE', credentials: 'same-origin' })
            .then(res => {
                if (!res.ok) throw new Error();
                this.cy?.getElementById(edgeId).remove();
                this.selection = null;
                this.clearSelection();
                this.updateStatusCounts();
                this.panel.hint('已删除，点击其他元素继续查看');
            })
            .catch(() => alert('删除失败'));
    }
}

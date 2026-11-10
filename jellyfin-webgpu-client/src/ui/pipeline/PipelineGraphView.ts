import escapeHtml from 'escape-html';

import globalize from 'lib/globalize';
import type { PassRejection, PlanReport, PresentationPlan } from 'webgpu-player/presentation/passes/PassTypes';

import type { default as WebGPUPlayer, PresentationRoute } from '../../WebGPUPlayer';
import { HIDDEN_CLASS, translateToHTML } from '../SettingsPanelHTML';
import {
    formatPassRejection,
    formatPipelineGraphEdgePath,
    getPassRejectionTone,
    getPipelineGraphArrowhead,
    layoutPipelineGraph,
    PIPELINE_GRAPH_GEOMETRY,
    splitCubicBezier,
    VALUE_SEPARATOR,
    type PipelineGraphEdge,
    type PipelineGraphLayout,
    type PipelineGraphNode,
    type PipelineGraphPoint,
    type PipelineGraphSidePass
} from './PipelineGraphLayout';

import './PipelineGraph.scss';

// The active presentation plan as a flow graph from top to bottom: pass nodes positioned over an SVG of texture edges, as wide as the view,
// then the side passes, whose output never reaches the canvas, and the passes the plan left out, listed below it, since the windows that hold it are narrow

/** What one rendering of the graph shows: the plan the presenter runs, its report, and the route its source comes from. */
export type PipelineGraphInput = Readonly<{
    plan: PresentationPlan | null
    report: PlanReport
    route: PresentationRoute | null
}>;

export type PipelineGraphView = Readonly<{
    element: HTMLElement
    render: (input: PipelineGraphInput) => void
    destroy: () => void
}>;

/** The player getters the graph polls. */
export type PipelineGraphSource = Pick<WebGPUPlayer, 'getActivePresentationPlan' | 'getPresentationPlanReport' | 'getPresentationRoute'>;

const DEFAULT_UPDATE_INTERVAL_MILLISECONDS = 500;
const LINE_SEPARATOR = '\n';
const SUMMARY_PASS_SEPARATOR = ', ';
const WARNING_PREFIX = 'WebGPU pipeline graph';

/** Creates an empty pipeline graph; render shows a plan, or the empty state without one. */
export function createPipelineGraphView(): PipelineGraphView {
    const element = document.createElement('div');
    element.className = 'webgpuPipelineGraph';
    element.innerHTML = `
        <p class="webgpuPipelineGraphEmpty">${translateToHTML('WebGPUPipelineGraphEmpty')}</p>
        <div
            aria-label="${translateToHTML('WebGPUPipelineGraphLabel')}"
            class="webgpuPipelineGraphDiagram ${HIDDEN_CLASS}"
            role="group"
        >
            <p class="webgpuPipelineGraphSummary"></p>
            <div class="webgpuPipelineGraphCanvas"></div>
        </div>
        <section class="webgpuPipelineGraphSidePasses ${HIDDEN_CLASS}">
            <h3 class="webgpuPipelineGraphSidePassesTitle">${translateToHTML('WebGPUPipelineGraphSidePasses')}</h3>
            <ul class="webgpuPipelineGraphSidePassList"></ul>
        </section>
        <section class="webgpuPipelineGraphLeftOut ${HIDDEN_CLASS}">
            <h3 class="webgpuPipelineGraphLeftOutTitle">${translateToHTML('WebGPUPipelineGraphLeftOut')}</h3>
            <ul class="webgpuPipelineGraphLeftOutList"></ul>
        </section>`;
    const empty = requireChild(element, '.webgpuPipelineGraphEmpty');
    const diagram = requireChild(element, '.webgpuPipelineGraphDiagram');
    const summary = requireChild(element, '.webgpuPipelineGraphSummary');
    const canvas = requireChild(element, '.webgpuPipelineGraphCanvas');
    const sidePasses = requireChild(element, '.webgpuPipelineGraphSidePasses');
    const sidePassList = requireChild(element, '.webgpuPipelineGraphSidePassList');
    const leftOut = requireChild(element, '.webgpuPipelineGraphLeftOut');
    const leftOutList = requireChild(element, '.webgpuPipelineGraphLeftOutList');
    // The plan drawn and the view width it was drawn for; 0 while the view had no width, as while hidden or detached
    let drawn: Readonly<{ plan: PresentationPlan, route: PresentationRoute | null }> | null = null;
    let drawnWidth = 0;

    const drawGraph = (plan: PresentationPlan, route: PresentationRoute | null): void => {
        drawn = { plan, route };
        drawnWidth = Math.floor(element.clientWidth);
        // Without a width the nodes take the geometry's node width
        const layout = layoutPipelineGraph(plan, route, { orientation: 'vertical', width: drawnWidth > 0 ? drawnWidth : undefined });
        summary.textContent = globalize.translate(
            'WebGPUPipelineGraphSummary',
            layout.nodes
                .filter((node: PipelineGraphNode): boolean => node.kind === 'pass')
                .map((node: PipelineGraphNode): string => node.lines[0].text)
                .join(SUMMARY_PASS_SEPARATOR)
        );
        canvas.style.width = `${layout.width}px`;
        canvas.style.height = `${layout.height}px`;
        canvas.innerHTML = createEdgeLayerHTML(layout) + layout.nodes.map(createNodeHTML).join('');
        sidePasses.classList.toggle(HIDDEN_CLASS, layout.sidePasses.length === 0);
        sidePassList.innerHTML = layout.sidePasses.map(createSidePassHTML).join('');
    };

    // The nodes fill the view's width, so a new width lays the graph out again; a new height alone, as the graph's own, changes nothing
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver === 'function') {
        resizeObserver = new ResizeObserver((): void => {
            if (drawn !== null && Math.floor(element.clientWidth) !== drawnWidth) {
                drawGraph(drawn.plan, drawn.route);
            }
        });
        resizeObserver.observe(element);
    }

    return {
        destroy: (): void => {
            resizeObserver?.disconnect();
            element.remove();
        },
        element,
        render: (input: PipelineGraphInput): void => {
            const { plan, report, route } = input;
            empty.classList.toggle(HIDDEN_CLASS, plan !== null);
            diagram.classList.toggle(HIDDEN_CLASS, plan === null);
            leftOut.classList.toggle(HIDDEN_CLASS, report.inactivePasses.length === 0);
            if (plan === null) {
                drawn = null;
                summary.textContent = '';
                canvas.innerHTML = '';
                canvas.style.width = '';
                canvas.style.height = '';
                sidePasses.classList.add(HIDDEN_CLASS);
                sidePassList.innerHTML = '';
            } else {
                drawGraph(plan, route);
            }
            leftOutList.innerHTML = report.inactivePasses.map(createLeftOutPassHTML).join('');
        }
    };
}

/**
 * Renders the player's pipeline into the view at once, then polls it and renders again only when the plan, its report, or the route changed.
 * Returns the function that stops the polling.
 */
export function startPipelineGraphUpdates(
    source: PipelineGraphSource,
    view: PipelineGraphView,
    intervalMilliseconds: number = DEFAULT_UPDATE_INTERVAL_MILLISECONDS
): () => void {
    let shown: PipelineGraphInput | null = null;
    let warned = false;
    const update = (): void => {
        try {
            const input: PipelineGraphInput = {
                plan: source.getActivePresentationPlan(),
                report: source.getPresentationPlanReport(),
                route: source.getPresentationRoute()
            };
            if (shown !== null && isSameInput(shown, input)) {
                return;
            }
            view.render(input);
            shown = input;
        } catch (error) {
            // A failing getter or render repeats on every poll, so it is reported once
            if (!warned) {
                warned = true;
                console.warn(`${WARNING_PREFIX}: update-failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    };
    update();
    const timer = window.setInterval(update, intervalMilliseconds);
    return (): void => {
        window.clearInterval(timer);
    };
}

function requireChild(parent: HTMLElement, selector: string): HTMLElement {
    const child = parent.querySelector<HTMLElement>(selector);
    if (!child) {
        throw new Error(`${WARNING_PREFIX}: element-missing: ${selector}`);
    }
    return child;
}

function isSameInput(shown: PipelineGraphInput, input: PipelineGraphInput): boolean {
    return shown.plan === input.plan && isSameReport(shown.report, input.report) && isSameRoute(shown.route, input.route);
}

function isSameReport(shown: PlanReport, report: PlanReport): boolean {
    if (shown === report) {
        return true;
    }
    if (shown.activePasses.length !== report.activePasses.length || shown.inactivePasses.length !== report.inactivePasses.length) {
        return false;
    }
    for (const [ index, name ] of shown.activePasses.entries()) {
        if (report.activePasses[index] !== name) {
            return false;
        }
    }
    for (const [ index, rejection ] of shown.inactivePasses.entries()) {
        const other = report.inactivePasses[index];
        if (other.name !== rejection.name || other.reason !== rejection.reason || other.detail !== rejection.detail) {
            return false;
        }
    }
    return true;
}

function isSameRoute(shown: PresentationRoute | null, route: PresentationRoute | null): boolean {
    if (shown === null || route === null) {
        return shown === route;
    }
    return shown.dolbyVisionProfile === route.dolbyVisionProfile
        && shown.gpuVideoDecoderId === route.gpuVideoDecoderId
        && shown.nativeHDRTransfer === route.nativeHDRTransfer
        && shown.rawVideoFrameFormat === route.rawVideoFrameFormat
        && shown.videoDecoderBackend === route.videoDecoderBackend
        && shown.videoOutputMode === route.videoOutputMode;
}

function createNodeHTML(node: PipelineGraphNode): string {
    const geometry = PIPELINE_GRAPH_GEOMETRY;
    const lines = node.lines.map((line): string => (
        `<div class="webgpuPipelineGraphLine" data-role="${line.role}">${escapeHtml(line.text)}</div>`
    )).join('');
    // The title repeats every line, since narrow nodes cut long ones short
    const title = escapeHtml(node.lines.map((line): string => line.text).join(LINE_SEPARATOR));
    const style = [
        `left: ${node.x}px`,
        `top: ${node.y}px`,
        `width: ${node.width}px`,
        `height: ${node.height}px`,
        `padding: ${geometry.nodePadding}px`,
        `line-height: ${geometry.lineHeight}px`
    ].join('; ');
    const userClass = node.userPass ? ' webgpuPipelineGraphNodeUser' : '';
    return `<div class="webgpuPipelineGraphNode${userClass}" data-kind="${node.kind}" data-node-id="${escapeHtml(node.id)}" style="${style}" title="${title}">${lines}</div>`;
}

function createEdgeLayerHTML(layout: PipelineGraphLayout): string {
    return `<svg
            aria-hidden="true"
            class="webgpuPipelineGraphEdges"
            focusable="false"
            height="${layout.height}"
            viewBox="0 0 ${layout.width} ${layout.height}"
            width="${layout.width}"
        >${layout.edges.map(createEdgeHTML).join('')}</svg>`;
}

/** Draws an edge up to its arrowhead's base, then the arrowhead, turned along the edge's last stretch, with its tip on the edge's end. */
function createEdgeHTML(edge: PipelineGraphEdge): string {
    const history = edge.historyOffset === 0 ? '' : ` data-history="${edge.historyOffset}"`;
    const texture = edge.textureId === null ? '' : ` data-texture="${escapeHtml(edge.textureId)}"`;
    const arrowhead = getPipelineGraphArrowhead(edge);
    const [ drawnCurve ] = splitCubicBezier(edge, arrowhead.t);
    const points = [ arrowhead.tip, arrowhead.left, arrowhead.right ].map((point: PipelineGraphPoint): string => `${point.x},${point.y}`).join(' ');
    const path = `<path
            class="webgpuPipelineGraphEdge"
            d="${formatPipelineGraphEdgePath(drawnCurve)}"
            data-from="${escapeHtml(edge.fromNodeId)}"
            data-route="${edge.route}"
            data-to="${escapeHtml(edge.toNodeId)}"${history}${texture}
        ></path><polygon class="webgpuPipelineGraphArrow"${history} points="${points}"></polygon>`;
    if (edge.label === null) {
        return path;
    }
    return `${path}<text class="webgpuPipelineGraphEdgeLabel" x="${edge.labelPosition.x}" y="${edge.labelPosition.y}">${escapeHtml(edge.label)}</text>`;
}

function createSidePassHTML(sidePass: PipelineGraphSidePass): string {
    const [ title, ...details ] = sidePass.lines;
    const lines = details.map((line): string => (
        `<span class="webgpuPipelineGraphSidePassLine" data-role="${line.role}">${escapeHtml(line.text)}</span>`
    )).join('');
    const reads = sidePass.reads.length === 0 ?
        '' :
        `<span class="webgpuPipelineGraphSidePassReads">${translateToHTML('WebGPUPipelineGraphReads', sidePass.reads.join(VALUE_SEPARATOR))}</span>`;
    const userClass = sidePass.userPass ? ' webgpuPipelineGraphSidePassUser' : '';
    return `<li class="webgpuPipelineGraphSidePass${userClass}" data-pass-id="${escapeHtml(sidePass.id)}">
            <span class="webgpuPipelineGraphSidePassName">${escapeHtml(title.text)}</span>${lines}${reads}
        </li>`;
}

function createLeftOutPassHTML(rejection: PassRejection): string {
    return `<li class="webgpuPipelineGraphLeftOutPass" data-tone="${getPassRejectionTone(rejection)}">
            <span class="webgpuPipelineGraphLeftOutName">${escapeHtml(rejection.name)}</span>
            <span class="webgpuPipelineGraphLeftOutReason">${escapeHtml(formatPassRejection(rejection))}</span>
        </li>`;
}

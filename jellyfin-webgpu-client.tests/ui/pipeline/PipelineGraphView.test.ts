import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import globalize from 'lib/globalize';
import type { PlannedPass, PlanReport, PresentationPlan } from 'webgpu-player/presentation/passes/PassTypes';
import type { PresentationRoute } from 'addons/webGPUPlayer/WebGPUPlayer';
import { getPipelineGraphArrowhead, layoutPipelineGraph } from 'addons/webGPUPlayer/ui/pipeline/PipelineGraphLayout';
import {
    createPipelineGraphView,
    startPipelineGraphUpdates,
    type PipelineGraphInput,
    type PipelineGraphSource,
    type PipelineGraphView
} from 'addons/webGPUPlayer/ui/pipeline/PipelineGraphView';

// Source strings with their arguments substituted; a key the source strings lack yet renders as the key with its arguments, so every argument still shows
vi.mock('lib/globalize', async () => {
    // The factory runs before the module's imports, so it loads the source strings itself
    const globalizeMock = await import('../../host/globalizeMock');
    const sourceStrings: Readonly<Record<string, string>> = (await import('addons/webGPUPlayer/strings/en-us.json')).default;
    return {
        default: {
            translate: (key: string, ...values: Array<string | number>): string => (
                Object.prototype.hasOwnProperty.call(sourceStrings, key) ?
                    globalizeMock.translateSourceString(key, ...values) :
                    `${key}(${values.join(', ')})`
            )
        }
    };
});

const SIGNAL_TEXTURE_ID = 'signal';
const TEMPORAL_TEXTURE_ID = 'pass:Temporal';
const SIGNAL_LABEL = 'Presentation signal';
const TEMPORAL_LABEL = 'Presentation pass \'Temporal\'';
const OUTPUT_LABEL = 'Presentation output';
const BLACK_BARS_LABEL = 'Presentation black bars';
const PIXEL_PRECISION = 6;
const TONE_MAP_STEP = 'builtin.tone-map';
const SOURCE_WIDTH = 1920;
const SOURCE_HEIGHT = 1080;
const UPDATE_INTERVAL_MILLISECONDS = 500;
const VIEW_WIDTH = 400;
const WIDER_VIEW_WIDTH = 520;
const EMPTY_REPORT: PlanReport = { activePasses: [], inactivePasses: [] };
const LEFT_OUT_REPORT: PlanReport = {
    activePasses: [ 'Temporal' ],
    inactivePasses: [
        { detail: 'line 3: unknown identifier', name: 'Sharpen', reason: 'compile-error' },
        { detail: '', name: 'Grain', reason: 'condition-false' }
    ]
};

function createPass(overrides: Partial<PlannedPass> & Pick<PlannedPass, 'label'>): PlannedPass {
    return {
        bindings: [],
        code: '',
        colorSteps: [],
        coordinateMapping: 'identity',
        indirectBufferId: null,
        inputTextureId: null,
        kind: 'render',
        lineMap: [],
        target: { kind: 'output' },
        workgroupCounts: null,
        ...overrides
    };
}

/** Signal, a temporal pass that also reads its own previous output, and the output pass. */
function createTemporalPlan(): PresentationPlan {
    return {
        blackBarAnalysis: null,
        buffers: [],
        deinterlace: null,
        displayRate: false,
        historyDrawStart: 0,
        output: { colorSpace: 'srgb', format: 'bgra8unorm', toneMapping: 'standard' },
        parameterSets: [],
        passTextures: [],
        passes: [
            createPass({ label: SIGNAL_LABEL, target: { kind: 'texture', textureId: SIGNAL_TEXTURE_ID } }),
            createPass({
                bindings: [
                    { access: 'sampled', binding: 0, historyOffset: 0, kind: 'texture', textureId: SIGNAL_TEXTURE_ID },
                    { access: 'sampled', binding: 1, historyOffset: -1, kind: 'texture', textureId: TEMPORAL_TEXTURE_ID }
                ],
                inputTextureId: SIGNAL_TEXTURE_ID,
                label: TEMPORAL_LABEL,
                target: { kind: 'texture', textureId: TEMPORAL_TEXTURE_ID }
            }),
            createPass({
                bindings: [ { access: 'sampled', binding: 0, historyOffset: 0, kind: 'texture', textureId: TEMPORAL_TEXTURE_ID } ],
                colorSteps: [ TONE_MAP_STEP ],
                coordinateMapping: 'object-fit',
                inputTextureId: TEMPORAL_TEXTURE_ID,
                label: OUTPUT_LABEL
            })
        ],
        report: EMPTY_REPORT,
        sourceKind: 'planes',
        textures: [
            { format: 'rgba16float', height: SOURCE_HEIGHT, historyDepth: 0, id: SIGNAL_TEXTURE_ID, storage: false, width: SOURCE_WIDTH },
            { format: 'rgba16float', height: SOURCE_HEIGHT, historyDepth: 1, id: TEMPORAL_TEXTURE_ID, storage: false, width: SOURCE_WIDTH }
        ],
        usesRenderSettings: false
    };
}

/** The temporal plan with a black bar analysis before the output pass, which reads the source and hands its result to the CPU. */
function createSidePassPlan(): PresentationPlan {
    const plan = createTemporalPlan();
    return {
        ...plan,
        passes: [ plan.passes[0], plan.passes[1], createPass({ kind: 'compute', label: BLACK_BARS_LABEL, target: null }), plan.passes[2] ]
    };
}

function createRoute(overrides: Partial<PresentationRoute> = {}): PresentationRoute {
    return {
        dolbyVisionProfile: null,
        gpuVideoDecoderId: null,
        nativeHDRTransfer: null,
        rawVideoFrameFormat: null,
        videoDecoderBackend: 'native',
        videoOutputMode: 'video-frame',
        ...overrides
    };
}

function query<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
    const element = root.querySelector<T>(selector);
    if (!element) {
        throw new Error(`missing ${selector}`);
    }
    return element;
}

function isHidden(element: Element): boolean {
    return element.classList.contains('hide');
}

/** Gives the view the width jsdom does not lay out. */
function setViewWidth(element: HTMLElement, width: number): void {
    Object.defineProperty(element, 'clientWidth', { configurable: true, value: width });
}

// The fake observers made since the last test that stubbed ResizeObserver
const resizeObservers: FakeResizeObserver[] = [];

/** A ResizeObserver stand-in, which jsdom lacks; the tests run its callback themselves. */
class FakeResizeObserver {
    readonly disconnect = vi.fn();
    readonly observed: Element[] = [];
    private readonly callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        resizeObservers.push(this);
    }

    observe(target: Element): void {
        this.observed.push(target);
    }

    notify(): void {
        this.callback([], this as unknown as ResizeObserver);
    }
}

describe('createPipelineGraphView', () => {
    const views: PipelineGraphView[] = [];

    function createView(): PipelineGraphView {
        const view = createPipelineGraphView();
        document.body.append(view.element);
        views.push(view);
        return view;
    }

    afterEach(() => {
        for (const view of views.splice(0)) {
            view.destroy();
        }
        vi.unstubAllGlobals();
    });

    it('draws a node per row and an edge per read, with history reads dashed and labelled', () => {
        const view = createView();
        const plan = createTemporalPlan();
        const route = createRoute();
        view.render({ plan, report: EMPTY_REPORT, route });
        // jsdom lays nothing out, so the view has no width and the nodes take the geometry's node width
        const layout = layoutPipelineGraph(plan, route, { orientation: 'vertical' });

        const nodes = Array.from(view.element.querySelectorAll<HTMLElement>('.webgpuPipelineGraphNode'));
        expect(nodes.map((node: HTMLElement): string | null => node.getAttribute('data-kind'))).toEqual([ 'source', 'pass', 'pass', 'pass', 'canvas' ]);
        for (const [ index, node ] of nodes.entries()) {
            const lines = layout.nodes[index].lines.map((line): string => line.text);
            expect(node.title).toBe(lines.join('\n'));
            expect(Array.from(node.querySelectorAll('.webgpuPipelineGraphLine')).map((line: Element): string | null => line.textContent)).toEqual(lines);
            expect(node.style.left).toBe(`${layout.nodes[index].x}px`);
            expect(node.style.top).toBe(`${layout.nodes[index].y}px`);
            expect(node.style.width).toBe(`${layout.nodes[index].width}px`);
        }
        // The source is on top and the canvas at the bottom
        for (const [ index, node ] of layout.nodes.entries()) {
            if (index > 0) {
                expect(node.y).toBeGreaterThan(layout.nodes[index - 1].y);
            }
        }
        expect(query(nodes[0], '[data-role="title"]').textContent).toBe(globalize.translate('WebGPUPipelineGraphSource', 'planes'));
        expect(query(nodes[3], '[data-role="step"]').textContent).toBe(TONE_MAP_STEP);

        const edges = Array.from(view.element.querySelectorAll('path.webgpuPipelineGraphEdge'));
        expect(edges).toHaveLength(layout.edges.length);
        const historyEdges = edges.filter((edge: Element): boolean => edge.hasAttribute('data-history'));
        expect(historyEdges).toHaveLength(1);
        expect(historyEdges[0].getAttribute('data-history')).toBe('-1');
        expect(historyEdges[0].getAttribute('data-route')).toBe('backward');
        expect(historyEdges[0].getAttribute('data-texture')).toBe(TEMPORAL_TEXTURE_ID);
        expect(Array.from(view.element.querySelectorAll('.webgpuPipelineGraphEdgeLabel')).map((label: Element): string | null => label.textContent))
            .toEqual([ '[-1]' ]);
        // A shader file's pass stands out
        expect(nodes.map((node: HTMLElement): boolean => node.classList.contains('webgpuPipelineGraphNodeUser'))).toEqual([ false, false, true, false, false ]);

        const canvas = query(view.element, '.webgpuPipelineGraphCanvas');
        expect(canvas.style.width).toBe(`${layout.width}px`);
        expect(canvas.style.height).toBe(`${layout.height}px`);
        expect(query(view.element, 'svg.webgpuPipelineGraphEdges').getAttribute('viewBox')).toBe(`0 0 ${layout.width} ${layout.height}`);
    });

    it('lays the graph out as wide as the view', () => {
        const view = createView();
        const plan = createTemporalPlan();
        setViewWidth(view.element, VIEW_WIDTH);
        view.render({ plan, report: EMPTY_REPORT, route: null });
        const layout = layoutPipelineGraph(plan, null, { orientation: 'vertical', width: VIEW_WIDTH });

        expect(query(view.element, '.webgpuPipelineGraphCanvas').style.width).toBe(`${VIEW_WIDTH}px`);
        expect(Array.from(view.element.querySelectorAll<HTMLElement>('.webgpuPipelineGraphNode')).map((node: HTMLElement): string => node.style.width))
            .toEqual(layout.nodes.map((node): string => `${node.width}px`));
    });

    it('lays the graph out again when the view\'s width changes, and stops watching it once destroyed', () => {
        vi.stubGlobal('ResizeObserver', FakeResizeObserver);
        resizeObservers.splice(0);
        const view = createView();
        const [ observer ] = resizeObservers;
        expect(observer.observed).toEqual([ view.element ]);
        setViewWidth(view.element, VIEW_WIDTH);
        view.render({ plan: createTemporalPlan(), report: EMPTY_REPORT, route: null });
        const canvas = query(view.element, '.webgpuPipelineGraphCanvas');
        const firstNode = query(canvas, '.webgpuPipelineGraphNode');

        // A new height alone, as the graph's own, draws nothing again
        observer.notify();
        expect(query(canvas, '.webgpuPipelineGraphNode')).toBe(firstNode);

        setViewWidth(view.element, WIDER_VIEW_WIDTH);
        observer.notify();
        expect(canvas.style.width).toBe(`${WIDER_VIEW_WIDTH}px`);
        expect(query(canvas, '.webgpuPipelineGraphNode')).not.toBe(firstNode);

        // Without a plan there is nothing to lay out
        view.render({ plan: null, report: EMPTY_REPORT, route: null });
        setViewWidth(view.element, VIEW_WIDTH);
        observer.notify();
        expect(canvas.querySelector('.webgpuPipelineGraphNode')).toBeNull();

        view.destroy();
        expect(observer.disconnect).toHaveBeenCalledTimes(1);
        expect(view.element.isConnected).toBe(false);
    });

    it('names the graph and summarizes its passes in order for screen readers', () => {
        const view = createView();
        view.render({ plan: createTemporalPlan(), report: EMPTY_REPORT, route: null });
        const diagram = query(view.element, '.webgpuPipelineGraphDiagram');

        expect(diagram.getAttribute('role')).toBe('group');
        expect(diagram.getAttribute('aria-label')).toBe(globalize.translate('WebGPUPipelineGraphLabel'));
        expect(isHidden(diagram)).toBe(false);
        expect(query(view.element, '.webgpuPipelineGraphSummary').textContent).toBe(
            globalize.translate('WebGPUPipelineGraphSummary', [ 'Signal', 'Temporal', 'Output' ].join(', '))
        );
        expect(view.element.querySelector('[role="img"]')).toBeNull();
        expect(query(view.element, 'svg').getAttribute('aria-hidden')).toBe('true');
    });

    it('lists the passes the plan left out below the graph, failures apart from switched-off passes', () => {
        const view = createView();
        view.render({ plan: createTemporalPlan(), report: LEFT_OUT_REPORT, route: null });
        const leftOut = query(view.element, '.webgpuPipelineGraphLeftOut');
        const items = Array.from(leftOut.querySelectorAll('.webgpuPipelineGraphLeftOutPass'));

        expect(isHidden(leftOut)).toBe(false);
        expect(query(leftOut, '.webgpuPipelineGraphLeftOutTitle').textContent).toBe(globalize.translate('WebGPUPipelineGraphLeftOut'));
        // The list follows the graph, since the windows are narrow
        const diagram = query(view.element, '.webgpuPipelineGraphDiagram');
        expect(diagram.compareDocumentPosition(leftOut) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(items.map((item: Element): string | null => item.getAttribute('data-tone'))).toEqual([ 'failure', 'muted' ]);
        expect(items.map((item: Element): string | null | undefined => item.querySelector('.webgpuPipelineGraphLeftOutName')?.textContent)).toEqual([ 'Sharpen', 'Grain' ]);
        expect(items.map((item: Element): string | null | undefined => item.querySelector('.webgpuPipelineGraphLeftOutReason')?.textContent))
            .toEqual([ 'compile-error: line 3: unknown identifier', 'condition-false' ]);

        view.render({ plan: createTemporalPlan(), report: EMPTY_REPORT, route: null });
        expect(isHidden(leftOut)).toBe(true);
        expect(leftOut.querySelectorAll('.webgpuPipelineGraphLeftOutPass')).toHaveLength(0);
    });

    it('shows one muted line instead of the graph without a plan', () => {
        const view = createView();
        const empty = query(view.element, '.webgpuPipelineGraphEmpty');
        const diagram = query(view.element, '.webgpuPipelineGraphDiagram');
        view.render({ plan: createTemporalPlan(), report: EMPTY_REPORT, route: null });
        expect(isHidden(empty)).toBe(true);

        view.render({ plan: null, report: EMPTY_REPORT, route: null });

        expect(isHidden(empty)).toBe(false);
        expect(empty.textContent).toBe(globalize.translate('WebGPUPipelineGraphEmpty'));
        expect(isHidden(diagram)).toBe(true);
        expect(view.element.querySelectorAll('.webgpuPipelineGraphNode')).toHaveLength(0);
        expect(view.element.querySelector('svg')).toBeNull();
        expect(isHidden(query(view.element, '.webgpuPipelineGraphLeftOut'))).toBe(true);
    });

    it('draws each edge up to an arrowhead of its own, whose tip is the edge\'s end, dashed history reads included', () => {
        const view = createView();
        const plan = createTemporalPlan();
        view.render({ plan, report: EMPTY_REPORT, route: null });
        const layout = layoutPipelineGraph(plan, null, { orientation: 'vertical' });
        const arrows = Array.from(view.element.querySelectorAll('polygon.webgpuPipelineGraphArrow'));
        const paths = Array.from(view.element.querySelectorAll('path.webgpuPipelineGraphEdge'));

        expect(view.element.querySelector('marker')).toBeNull();
        expect(arrows).toHaveLength(layout.edges.length);
        for (const [ index, edge ] of layout.edges.entries()) {
            const arrowhead = getPipelineGraphArrowhead(edge);
            const points = arrows[index].getAttribute('points')?.split(' ') ?? [];
            expect(points).toEqual([ arrowhead.tip, arrowhead.left, arrowhead.right ].map((point): string => `${point.x},${point.y}`));
            expect(arrows[index].hasAttribute('data-history')).toBe(edge.historyOffset !== 0);
            // The drawn path stops at the arrowhead's base
            const pathNumbers = (paths[index].getAttribute('d') ?? '').split(/[\s,]+/u).map(Number);
            expect(pathNumbers[pathNumbers.length - 2]).toBeCloseTo(arrowhead.base.x, PIXEL_PRECISION);
            expect(pathNumbers[pathNumbers.length - 1]).toBeCloseTo(arrowhead.base.y, PIXEL_PRECISION);
        }
    });

    it('lists the side passes between the graph and the left-out passes, with what they read', () => {
        const view = createView();
        view.render({ plan: createSidePassPlan(), report: LEFT_OUT_REPORT, route: null });
        const diagram = query(view.element, '.webgpuPipelineGraphDiagram');
        const sidePasses = query(view.element, '.webgpuPipelineGraphSidePasses');
        const leftOut = query(view.element, '.webgpuPipelineGraphLeftOut');
        const items = Array.from(sidePasses.querySelectorAll('.webgpuPipelineGraphSidePass'));

        expect(isHidden(sidePasses)).toBe(false);
        expect(query(sidePasses, '.webgpuPipelineGraphSidePassesTitle').textContent).toBe(globalize.translate('WebGPUPipelineGraphSidePasses'));
        expect(diagram.compareDocumentPosition(sidePasses) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(sidePasses.compareDocumentPosition(leftOut) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(items).toHaveLength(1);
        expect(query(items[0], '.webgpuPipelineGraphSidePassName').textContent).toBe('Black bars');
        expect(Array.from(items[0].querySelectorAll('.webgpuPipelineGraphSidePassLine')).map((line: Element): string | null => line.textContent))
            .toEqual([ `compute, ${globalize.translate('WebGPUPipelineGraphPerSourceLine')}` ]);
        expect(query(items[0], '.webgpuPipelineGraphSidePassReads').textContent)
            .toBe(globalize.translate('WebGPUPipelineGraphReads', globalize.translate('WebGPUPipelineGraphSourceName')));
        // The side pass takes no node, so the graph keeps the source, the three passes that reach the canvas, and the canvas
        expect(view.element.querySelectorAll('.webgpuPipelineGraphNode')).toHaveLength(5);

        view.render({ plan: createTemporalPlan(), report: EMPTY_REPORT, route: null });
        expect(isHidden(sidePasses)).toBe(true);
        expect(sidePasses.querySelectorAll('.webgpuPipelineGraphSidePass')).toHaveLength(0);
        view.render({ plan: createSidePassPlan(), report: EMPTY_REPORT, route: null });
        view.render({ plan: null, report: EMPTY_REPORT, route: null });
        expect(isHidden(sidePasses)).toBe(true);
    });
});

describe('startPipelineGraphUpdates', () => {
    type SourceState = {
        plan: PresentationPlan | null
        report: PlanReport
        route: PresentationRoute | null
    };

    let state: SourceState;
    let source: PipelineGraphSource;
    let render: Mock<(input: PipelineGraphInput) => void>;
    let view: PipelineGraphView;

    beforeEach(() => {
        vi.useFakeTimers();
        state = { plan: createTemporalPlan(), report: EMPTY_REPORT, route: createRoute() };
        // Each poll returns fresh report and route objects, as the player does
        source = {
            getActivePresentationPlan: (): PresentationPlan | null => state.plan,
            getPresentationPlanReport: (): PlanReport => ({
                activePasses: [ ...state.report.activePasses ],
                inactivePasses: state.report.inactivePasses.map(rejection => ({ ...rejection }))
            }),
            getPresentationRoute: (): PresentationRoute | null => (state.route === null ? null : { ...state.route })
        };
        render = vi.fn<(input: PipelineGraphInput) => void>();
        view = { destroy: vi.fn(), element: document.createElement('div'), render };
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('renders at once, then again only when the plan, its report, or the route changed', () => {
        const stop = startPipelineGraphUpdates(source, view);
        expect(render).toHaveBeenCalledTimes(1);
        expect(render.mock.calls[0][0].plan).toBe(state.plan);

        vi.advanceTimersByTime(UPDATE_INTERVAL_MILLISECONDS * 3);
        expect(render).toHaveBeenCalledTimes(1);

        state.report = LEFT_OUT_REPORT;
        vi.advanceTimersByTime(UPDATE_INTERVAL_MILLISECONDS);
        expect(render).toHaveBeenCalledTimes(2);
        expect(render.mock.calls[1][0].report.inactivePasses).toHaveLength(LEFT_OUT_REPORT.inactivePasses.length);

        state.route = createRoute({ gpuVideoDecoderId: 'org.example.hevc-decoder', videoDecoderBackend: 'gpu', videoOutputMode: 'frame-pool' });
        vi.advanceTimersByTime(UPDATE_INTERVAL_MILLISECONDS);
        expect(render).toHaveBeenCalledTimes(3);

        // The same content in a new plan object is another plan
        state.plan = createTemporalPlan();
        vi.advanceTimersByTime(UPDATE_INTERVAL_MILLISECONDS);
        expect(render).toHaveBeenCalledTimes(4);

        state.plan = null;
        state.route = null;
        vi.advanceTimersByTime(UPDATE_INTERVAL_MILLISECONDS);
        expect(render).toHaveBeenCalledTimes(5);
        expect(render.mock.calls[4][0]).toEqual({ plan: null, report: LEFT_OUT_REPORT, route: null });

        vi.advanceTimersByTime(UPDATE_INTERVAL_MILLISECONDS * 2);
        expect(render).toHaveBeenCalledTimes(5);

        stop();
        state.report = EMPTY_REPORT;
        vi.advanceTimersByTime(UPDATE_INTERVAL_MILLISECONDS * 2);
        expect(render).toHaveBeenCalledTimes(5);
    });

    it('polls at the interval it is given', () => {
        const interval = 100;
        const stop = startPipelineGraphUpdates(source, view, interval);
        state.report = LEFT_OUT_REPORT;

        vi.advanceTimersByTime(interval - 1);
        expect(render).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1);
        expect(render).toHaveBeenCalledTimes(2);
        stop();
    });

    it('keeps polling past a failure, which it warns about once', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
        render.mockImplementation((): void => {
            throw new Error('render failed');
        });

        const stop = startPipelineGraphUpdates(source, view);
        expect((): void => {
            vi.advanceTimersByTime(UPDATE_INTERVAL_MILLISECONDS * 3);
        }).not.toThrow();

        // The failed renders never count as shown, so every poll tries again
        expect(render).toHaveBeenCalledTimes(4);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain('render failed');

        render.mockReset();
        vi.advanceTimersByTime(UPDATE_INTERVAL_MILLISECONDS);
        expect(render).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(UPDATE_INTERVAL_MILLISECONDS);
        expect(render).toHaveBeenCalledTimes(1);
        stop();
    });
});

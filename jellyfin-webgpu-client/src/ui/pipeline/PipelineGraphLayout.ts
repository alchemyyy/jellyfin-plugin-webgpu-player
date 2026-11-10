import globalize from 'lib/globalize';
import type {
    PassRejection,
    PlannedOutput,
    PlannedPass,
    PlannedTexture,
    PresentationPlan
} from 'webgpu-player/presentation/passes/PassTypes';

import type { PresentationRoute } from '../../WebGPUPlayer';
import { translateVideoDecoderBackend, translateVideoOutputMode } from '../CustomPlaybackStatsText';

// The pipeline graph's layout: a presentation plan as nodes and texture edges, positioned in plan order, left to right or top to bottom.
// Texture ids, formats, pass labels, color steps, and the engine's codes stay as the engine names them; only the words around them are translated

/** The graph's geometry in CSS pixels, sized for an in-player window; the view applies it inline, so no stylesheet restates it. */
export const PIPELINE_GRAPH_GEOMETRY = Object.freeze({
    /** How far the shallowest arc reaches beyond the nodes */
    arcDepth: 14,
    /** How much further an arc reaches for each column it spans beyond the shallowest */
    arcDepthStep: 9,
    /** How far an arrowhead reaches back along its edge from the edge's end */
    arrowLength: 7,
    /** How wide an arrowhead's base is */
    arrowWidth: 7,
    columnGap: 36,
    /** The room an edge label takes above or below its edge */
    labelHeight: 11,
    /** The room an edge label takes beside its edge, in the vertical orientation */
    labelWidth: 26,
    lineHeight: 13,
    /** The space around the nodes and arcs */
    margin: 6,
    /** The narrowest a node gets in the vertical orientation, however narrow the width it is given */
    minimumNodeWidth: 96,
    nodePadding: 5,
    nodeWidth: 172,
    /** The gap between the rows of the vertical orientation */
    rowGap: 24
});

export type PipelineGraphPoint = Readonly<{
    x: number
    y: number
}>;

/**
 * - 'title': the node's name.
 * - 'detail': its kind, mapping, or target.
 * - 'step': one color step it runs after its core.
 */
export type PipelineGraphLineRole = 'detail' | 'step' | 'title';

export type PipelineGraphLine = Readonly<{
    role: PipelineGraphLineRole
    text: string
}>;

export type PipelineGraphNodeKind = 'canvas' | 'pass' | 'source';

export type PipelineGraphNode = Readonly<{
    height: number
    id: string
    kind: PipelineGraphNodeKind
    lines: readonly PipelineGraphLine[]
    /** Whether the node is a pass from one of the user's shader files */
    userPass: boolean
    width: number
    x: number
    y: number
}>;

/**
 * - 'adjacent': to the next column or row, between the facing sides of the nodes.
 * - 'forward': past at least one column or row, arcing below the nodes, or right of them in the vertical orientation.
 * - 'backward': to the same or an earlier column or row, arcing above the nodes, or left of them in the vertical orientation, as a history read of a later
 *   pass's texture does.
 */
export type PipelineGraphEdgeRoute = 'adjacent' | 'backward' | 'forward';

/**
 * - 'horizontal': the source on the left, one column per pass, and the canvas on the right.
 * - 'vertical': the source on top, one row per pass, and the canvas at the bottom, for narrow windows.
 */
export type PipelineGraphOrientation = 'horizontal' | 'vertical';

export type PipelineGraphLayoutOptions = Readonly<{
    /** The direction the graph flows in; horizontal by default */
    orientation?: PipelineGraphOrientation
    /** The width the vertical orientation fills; without it, nodes take the geometry's node width */
    width?: number
}>;

/** One texture read, the source read, or the canvas write, as a cubic Bezier from its writer to its reader. */
export type PipelineGraphEdge = Readonly<{
    end: PipelineGraphPoint
    endControl: PipelineGraphPoint
    fromNodeId: string
    /** 0 reads the current frame, -1 the previous frame, and so on */
    historyOffset: number
    /** The history offset as a pass header writes it, such as [-1], or null for a current-frame read */
    label: string | null
    /** The center of the label, beside the edge's midpoint */
    labelPosition: PipelineGraphPoint
    route: PipelineGraphEdgeRoute
    start: PipelineGraphPoint
    startControl: PipelineGraphPoint
    /** The texture the edge carries, or null for the source read and the canvas write */
    textureId: string | null
    toNodeId: string
}>;

/**
 * A pass whose output never reaches the canvas, such as the black bar analysis, whose results go to the CPU.
 * The graph lists it apart rather than drawing it, so it adds no node and no arcs around the passes that do reach the canvas.
 */
export type PipelineGraphSidePass = Readonly<{
    id: string
    /** The lines a node of the pass would show */
    lines: readonly PipelineGraphLine[]
    /** What it reads, in read order: the source, and the titles of the passes that write the textures it samples, with a history offset as [-1] */
    reads: readonly string[]
    userPass: boolean
}>;

/** A cubic Bezier from its start to its end, through its two control points. */
export type PipelineGraphCurve = Readonly<{
    end: PipelineGraphPoint
    endControl: PipelineGraphPoint
    start: PipelineGraphPoint
    startControl: PipelineGraphPoint
}>;

/** A triangle whose tip sits on an edge's end, turned along the edge over its last stretch. */
export type PipelineGraphArrowhead = Readonly<{
    /** The center of the base, on the edge */
    base: PipelineGraphPoint
    left: PipelineGraphPoint
    right: PipelineGraphPoint
    /** The edge's parameter at the base, where its drawn curve stops */
    t: number
    tip: PipelineGraphPoint
}>;

/** A pass's title for the graph, and whether the pass comes from one of the user's shader files. */
export type PipelineGraphPassTitle = Readonly<{
    title: string
    userPass: boolean
}>;

export type PipelineGraphLayout = Readonly<{
    edges: readonly PipelineGraphEdge[]
    height: number
    nodes: readonly PipelineGraphNode[]
    orientation: PipelineGraphOrientation
    /** The passes whose output never reaches the canvas, in plan order */
    sidePasses: readonly PipelineGraphSidePass[]
    width: number
}>;

// The layout before the side passes join it
type GraphPlacement = Omit<PipelineGraphLayout, 'sidePasses'>;

/** How a left-out pass reads: a failed check, or a pass its condition only switched off. */
export type PassRejectionTone = 'failure' | 'muted';

/** Joins the parts of a compact value. */
export const VALUE_SEPARATOR = ', ';

const SOURCE_NODE_ID = 'source';
const CANVAS_NODE_ID = 'canvas';
const PASS_NODE_ID_PREFIX = 'pass-';
const SOURCE_COLUMN = 0;
const TARGET_PREFIX = '-> ';
const CANVAS_NAME = 'canvas';
// Joins the dimensions of a size or a dispatch, such as 1920x1080
const EXTENT_SEPARATOR = 'x';
// A forward edge that skips no column is adjacent, so forward arcs span at least two columns
const MINIMUM_FORWARD_ARC_SPAN = 2;
// B(1/2) of a cubic Bezier weighs its end points 1 and its control points 3, over 8
const BEZIER_MIDPOINT_CONTROL_WEIGHT = 3;
const BEZIER_MIDPOINT_DIVISOR = 8;
const HALF = 0.5;
// The engine labels its passes 'Presentation <name>', and a shader file's passes "Presentation pass '<name>'"
const USER_PASS_LABEL_PATTERN = /^Presentation pass '(.+)'$/u;
const BUILT_IN_PASS_LABEL_PATTERN = /^Presentation (.+)$/u;
// An arrowhead's base is found by stepping back from the edge's end, then narrowing the step it lies in down by halves
const ARROWHEAD_SEARCH_STEPS = 32;
const ARROWHEAD_BISECTION_STEPS = 24;

/**
 * Where an edge meets a node.
 * Adjacent edges use the facing sides.
 * Horizontally, arcs leave from the right half of a node's top or bottom and arrive on its left half;
 * vertically, they leave from the lower half of a node's left or right side and arrive on its upper half.
 */
type PortSide =
    | 'bottom'
    | 'bottom-in'
    | 'bottom-out'
    | 'left'
    | 'left-in'
    | 'left-out'
    | 'right'
    | 'right-in'
    | 'right-out'
    | 'top'
    | 'top-in'
    | 'top-out';

type PortSides = Readonly<{
    from: PortSide
    to: PortSide
}>;

const ROUTE_PORT_SIDES: Readonly<Record<PipelineGraphOrientation, Readonly<Record<PipelineGraphEdgeRoute, PortSides>>>> = Object.freeze({
    horizontal: {
        adjacent: { from: 'right', to: 'left' },
        backward: { from: 'top-out', to: 'top-in' },
        forward: { from: 'bottom-out', to: 'bottom-in' }
    },
    vertical: {
        adjacent: { from: 'bottom', to: 'top' },
        backward: { from: 'left-out', to: 'left-in' },
        forward: { from: 'right-out', to: 'right-in' }
    }
});

type GraphColumn = Readonly<{
    id: string
    kind: PipelineGraphNodeKind
    lines: readonly PipelineGraphLine[]
    userPass: boolean
}>;

type ColumnEdge = Readonly<{
    fromColumn: number
    historyOffset: number
    textureId: string | null
    toColumn: number
}>;

type RoutedEdge = ColumnEdge & Readonly<{
    /** How far its arc reaches beyond the nodes; 0 for an adjacent edge */
    depth: number
    fromPortIndex: number
    route: PipelineGraphEdgeRoute
    sides: PortSides
    toPortIndex: number
}>;

/** The box the nodes take, which arcs reach beyond. */
type NodeBounds = Readonly<{
    bottom: number
    left: number
    right: number
    top: number
}>;

/** An edge's control points and the center of its label. */
type EdgeCurve = Readonly<{
    endControl: PipelineGraphPoint
    labelPosition: PipelineGraphPoint
    startControl: PipelineGraphPoint
}>;

/** Formats the dimensions of a size or a workgroup dispatch, such as 240x135x1. */
export function formatExtent(dimensions: readonly number[]): string {
    return dimensions.join(EXTENT_SEPARATOR);
}

/** Formats a size in pixels, such as 1920x1080. */
export function formatDimensions(width: number, height: number): string {
    return formatExtent([ width, height ]);
}

/** Formats a pass the plan left out as its check and detail, as the presenter reports them, or the check alone without a detail. */
export function formatPassRejection(rejection: PassRejection): string {
    return rejection.detail === '' ? rejection.reason : `${rejection.reason}: ${rejection.detail}`;
}

/** Every reason but 'condition-false' is a failure; a false condition only switches the pass off. */
export function getPassRejectionTone(rejection: PassRejection): PassRejectionTone {
    return rejection.reason === 'condition-false' ? 'muted' : 'failure';
}

/** Names a pass by its label without the engine's prefix: a built-in pass with its first letter upper-cased, a shader file's pass by its name alone. */
export function getPipelineGraphPassTitle(label: string): PipelineGraphPassTitle {
    const userPass = USER_PASS_LABEL_PATTERN.exec(label);
    if (userPass) {
        return { title: userPass[1], userPass: true };
    }
    const builtInPass = BUILT_IN_PASS_LABEL_PATTERN.exec(label);
    if (builtInPass) {
        const name = builtInPass[1];
        return { title: `${name.charAt(0).toUpperCase()}${name.slice(1)}`, userPass: false };
    }
    return { title: label, userPass: false };
}

/**
 * Lays out a plan as the source, one node per planned pass in plan order, and the canvas: from left to right, or top to bottom in the vertical orientation.
 * Edges follow the textures from the pass that writes each to every pass that reads it, history reads included.
 * A pass the canvas cannot be reached from is a side pass: it gets no node and no edges, and the layout lists it with what it reads.
 */
export function layoutPipelineGraph(
    plan: PresentationPlan,
    route: PresentationRoute | null,
    options: PipelineGraphLayoutOptions = {}
): PipelineGraphLayout {
    const orientation = options.orientation ?? 'horizontal';
    const textures = new Map<string, PlannedTexture>();
    for (const texture of plan.textures) {
        textures.set(texture.id, texture);
    }
    const planEdges = collectColumnEdges(plan);
    const canvasColumn = plan.passes.length + 1;
    const spineColumns = findColumnsReaching(planEdges, canvasColumn);
    const passTitles = plan.passes.map((pass: PlannedPass): PipelineGraphPassTitle => getPipelineGraphPassTitle(pass.label));
    const columns: GraphColumn[] = [ { id: SOURCE_NODE_ID, kind: 'source', lines: describeSource(plan, route), userPass: false } ];
    // Each plan column that keeps a node, by its column in the graph
    const graphColumns = new Map<number, number>([ [ SOURCE_COLUMN, SOURCE_COLUMN ] ]);
    const sidePasses: PipelineGraphSidePass[] = [];
    for (const [ index, pass ] of plan.passes.entries()) {
        const planColumn = index + 1;
        const { title, userPass } = passTitles[index];
        const id = `${PASS_NODE_ID_PREFIX}${index}`;
        const lines = describePass(pass, title, textures);
        if (spineColumns.has(planColumn)) {
            graphColumns.set(planColumn, columns.length);
            columns.push({ id, kind: 'pass', lines, userPass });
        } else {
            sidePasses.push({ id, lines, reads: describeReads(planColumn, planEdges, passTitles), userPass });
        }
    }
    graphColumns.set(canvasColumn, columns.length);
    columns.push({ id: CANVAS_NODE_ID, kind: 'canvas', lines: describeCanvas(plan.output), userPass: false });
    const graphEdges: ColumnEdge[] = [];
    for (const edge of planEdges) {
        const fromColumn = graphColumns.get(edge.fromColumn);
        const toColumn = graphColumns.get(edge.toColumn);
        if (fromColumn !== undefined && toColumn !== undefined) {
            graphEdges.push({ ...edge, fromColumn, toColumn });
        }
    }
    const edges = routeEdges(graphEdges, orientation);
    const placement = orientation === 'vertical' ? layoutVertically(columns, edges, options.width) : layoutHorizontally(columns, edges);
    return { ...placement, sidePasses };
}

/** Formats a curve, such as an edge, as an SVG path. */
export function formatPipelineGraphEdgePath(curve: PipelineGraphCurve): string {
    const { end, endControl, start, startControl } = curve;
    return `M ${start.x} ${start.y} C ${startControl.x} ${startControl.y}, ${endControl.x} ${endControl.y}, ${end.x} ${end.y}`;
}

/** Returns the point of a cubic Bezier at a parameter from 0, its start, to 1, its end. */
export function getCubicBezierPoint(curve: PipelineGraphCurve, t: number): PipelineGraphPoint {
    const { end, endControl, start, startControl } = curve;
    const u = 1 - t;
    const startWeight = u * u * u;
    const startControlWeight = BEZIER_MIDPOINT_CONTROL_WEIGHT * u * u * t;
    const endControlWeight = BEZIER_MIDPOINT_CONTROL_WEIGHT * u * t * t;
    const endWeight = t * t * t;
    return {
        x: startWeight * start.x + startControlWeight * startControl.x + endControlWeight * endControl.x + endWeight * end.x,
        y: startWeight * start.y + startControlWeight * startControl.y + endControlWeight * endControl.y + endWeight * end.y
    };
}

/** Splits a cubic Bezier at a parameter into the curve before it and the curve after it, by de Casteljau's construction. */
export function splitCubicBezier(curve: PipelineGraphCurve, t: number): readonly [ PipelineGraphCurve, PipelineGraphCurve ] {
    const { end, endControl, start, startControl } = curve;
    const startSide = interpolate(start, startControl, t);
    const controlSide = interpolate(startControl, endControl, t);
    const endSide = interpolate(endControl, end, t);
    const startHalf = interpolate(startSide, controlSide, t);
    const endHalf = interpolate(controlSide, endSide, t);
    const split = interpolate(startHalf, endHalf, t);
    return [
        { end: split, endControl: startHalf, start, startControl: startSide },
        { end, endControl: endSide, start: split, startControl: endHalf }
    ];
}

/**
 * Places an arrowhead on a curve's end: its tip on the end, and its base center on the curve, a length back from the tip in a straight line.
 * It points from its base to its tip, so it turns with the curve over its last stretch; a curve shorter than the length puts the base on its start.
 */
export function getPipelineGraphArrowhead(
    curve: PipelineGraphCurve,
    length: number = PIPELINE_GRAPH_GEOMETRY.arrowLength,
    width: number = PIPELINE_GRAPH_GEOMETRY.arrowWidth
): PipelineGraphArrowhead {
    const tip = curve.end;
    const reachesLength = (t: number): boolean => getDistance(getCubicBezierPoint(curve, t), tip) >= length;
    // The step back from the end that first reaches the length holds the base; nearer steps all fall short of it
    let near = 1;
    let far: number | null = null;
    for (let step = 1; step <= ARROWHEAD_SEARCH_STEPS && far === null; step += 1) {
        const t = 1 - step / ARROWHEAD_SEARCH_STEPS;
        if (reachesLength(t)) {
            far = t;
        } else {
            near = t;
        }
    }
    let t = 0;
    if (far !== null) {
        // Bisects between the last step short of the length and the first that reaches it
        let reached: number = far;
        let short: number = near;
        for (let step = 0; step < ARROWHEAD_BISECTION_STEPS; step += 1) {
            const middle: number = (reached + short) * HALF;
            if (reachesLength(middle)) {
                reached = middle;
            } else {
                short = middle;
            }
        }
        t = reached;
    }
    const base = getCubicBezierPoint(curve, t);
    const span = getDistance(base, tip);
    // A curve that ends where it starts has no direction; its arrowhead points down
    const direction = span > 0 ? { x: (tip.x - base.x) / span, y: (tip.y - base.y) / span } : { x: 0, y: 1 };
    const halfWidth = width * HALF;
    return {
        base,
        left: { x: base.x + direction.y * halfWidth, y: base.y - direction.x * halfWidth },
        right: { x: base.x - direction.y * halfWidth, y: base.y + direction.x * halfWidth },
        t,
        tip
    };
}

/** One column per node, all on one line; backward arcs take room above the nodes, forward arcs below them. */
function layoutHorizontally(columns: readonly GraphColumn[], edges: readonly RoutedEdge[]): GraphPlacement {
    const geometry = PIPELINE_GRAPH_GEOMETRY;
    const backwardDepth = getMaximumDepth(edges, 'backward');
    const forwardDepth = getMaximumDepth(edges, 'forward');
    const nodesTop = geometry.margin + getArcRoom(backwardDepth, geometry.labelHeight);
    const nodes: PipelineGraphNode[] = [];
    let nodesBottom = nodesTop;
    for (const [ column, graphColumn ] of columns.entries()) {
        const height = getNodeHeight(graphColumn.lines.length);
        nodesBottom = Math.max(nodesBottom, nodesTop + height);
        nodes.push({
            height,
            id: graphColumn.id,
            kind: graphColumn.kind,
            lines: graphColumn.lines,
            userPass: graphColumn.userPass,
            width: geometry.nodeWidth,
            x: geometry.margin + column * (geometry.nodeWidth + geometry.columnGap),
            y: nodesTop
        });
    }
    const width = 2 * geometry.margin + columns.length * geometry.nodeWidth + (columns.length - 1) * geometry.columnGap;
    const bounds: NodeBounds = { bottom: nodesBottom, left: geometry.margin, right: width - geometry.margin, top: nodesTop };
    return {
        edges: positionEdges(edges, nodes, 'horizontal', bounds),
        height: nodesBottom + getArcRoom(forwardDepth, geometry.labelHeight) + geometry.margin,
        nodes,
        orientation: 'horizontal',
        width
    };
}

/**
 * One row per node, all as wide as the width leaves beside the arcs; backward arcs take room left of the nodes, forward arcs right of them.
 * Without a width, the nodes take the geometry's node width.
 */
function layoutVertically(columns: readonly GraphColumn[], edges: readonly RoutedEdge[], width: number | undefined): GraphPlacement {
    const geometry = PIPELINE_GRAPH_GEOMETRY;
    const leftRoom = getArcRoom(getMaximumDepth(edges, 'backward'), geometry.labelWidth);
    const rightRoom = getArcRoom(getMaximumDepth(edges, 'forward'), geometry.labelWidth);
    const nodeWidth = width === undefined ?
        geometry.nodeWidth :
        Math.max(geometry.minimumNodeWidth, width - 2 * geometry.margin - leftRoom - rightRoom);
    const nodesLeft = geometry.margin + leftRoom;
    const nodes: PipelineGraphNode[] = [];
    let nodeTop = geometry.margin;
    for (const graphColumn of columns) {
        const height = getNodeHeight(graphColumn.lines.length);
        nodes.push({
            height,
            id: graphColumn.id,
            kind: graphColumn.kind,
            lines: graphColumn.lines,
            userPass: graphColumn.userPass,
            width: nodeWidth,
            x: nodesLeft,
            y: nodeTop
        });
        nodeTop += height + geometry.rowGap;
    }
    const nodesBottom = nodeTop - geometry.rowGap;
    const bounds: NodeBounds = { bottom: nodesBottom, left: nodesLeft, right: nodesLeft + nodeWidth, top: geometry.margin };
    return {
        edges: positionEdges(edges, nodes, 'vertical', bounds),
        height: nodesBottom + geometry.margin,
        nodes,
        orientation: 'vertical',
        width: bounds.right + rightRoom + geometry.margin
    };
}

/** Returns the columns the target column can be reached from over the edges, the target included. */
function findColumnsReaching(edges: readonly ColumnEdge[], targetColumn: number): ReadonlySet<number> {
    const reaching = new Set<number>([ targetColumn ]);
    const pending = [ targetColumn ];
    for (let column = pending.pop(); column !== undefined; column = pending.pop()) {
        for (const edge of edges) {
            if (edge.toColumn === column && !reaching.has(edge.fromColumn)) {
                reaching.add(edge.fromColumn);
                pending.push(edge.fromColumn);
            }
        }
    }
    return reaching;
}

/** Names what a pass reads, once each in read order: the source, and the passes that write the textures it samples, with a history read's offset. */
function describeReads(column: number, edges: readonly ColumnEdge[], passTitles: readonly PipelineGraphPassTitle[]): string[] {
    const reads: string[] = [];
    for (const edge of edges) {
        if (edge.toColumn !== column) {
            continue;
        }
        const name = edge.fromColumn === SOURCE_COLUMN ?
            globalize.translate('WebGPUPipelineGraphSourceName') :
            passTitles[edge.fromColumn - 1].title;
        const read = edge.historyOffset === 0 ? name : `${name} [${edge.historyOffset}]`;
        if (!reads.includes(read)) {
            reads.push(read);
        }
    }
    return reads;
}

function describeSource(plan: PresentationPlan, route: PresentationRoute | null): PipelineGraphLine[] {
    const lines: PipelineGraphLine[] = [];
    lines.push({ role: 'title', text: globalize.translate('WebGPUPipelineGraphSource', plan.sourceKind) });
    if (route === null) {
        lines.push({ role: 'detail', text: globalize.translate('WebGPUPipelineGraphRouteUnknown') });
        return lines;
    }
    lines.push({ role: 'detail', text: globalize.translate('WebGPUPipelineGraphDecoder', translateVideoDecoderBackend(route.videoDecoderBackend)) });
    if (route.gpuVideoDecoderId !== null) {
        lines.push({ role: 'detail', text: globalize.translate('WebGPUPipelineGraphDecoderPackage', route.gpuVideoDecoderId) });
    }
    const transport = translateVideoOutputMode(route.videoOutputMode);
    lines.push({
        role: 'detail',
        text: route.rawVideoFrameFormat === null ?
            globalize.translate('WebGPUPipelineGraphTransport', transport) :
            globalize.translate('WebGPUPipelineGraphTransportFormat', transport, route.rawVideoFrameFormat)
    });
    if (route.dolbyVisionProfile !== null) {
        lines.push({ role: 'detail', text: globalize.translate('WebGPUPipelineGraphDolbyVisionProfile', route.dolbyVisionProfile) });
    }
    if (route.nativeHDRTransfer !== null) {
        lines.push({ role: 'detail', text: globalize.translate('WebGPUPipelineGraphNativeHDR', route.nativeHDRTransfer) });
    }
    return lines;
}

function describePass(pass: PlannedPass, title: string, textures: ReadonlyMap<string, PlannedTexture>): PipelineGraphLine[] {
    const lines: PipelineGraphLine[] = [];
    lines.push({ role: 'title', text: title });
    lines.push({ role: 'detail', text: describePassKind(pass) });
    if (pass.target?.kind === 'output') {
        lines.push({ role: 'detail', text: `${TARGET_PREFIX}${CANVAS_NAME}` });
    }
    for (const textureId of getWrittenTextureIds(pass)) {
        lines.push({ role: 'detail', text: `${TARGET_PREFIX}${textureId}` });
        const texture = textures.get(textureId);
        if (texture) {
            lines.push({ role: 'detail', text: describeTexture(texture) });
        }
    }
    for (const step of pass.colorSteps) {
        lines.push({ role: 'step', text: step });
    }
    return lines;
}

function describePassKind(pass: PlannedPass): string {
    switch (pass.kind) {
        case 'render':
            return `${pass.kind}${VALUE_SEPARATOR}${pass.coordinateMapping}`;
        case 'compute':
            if (pass.workgroupCounts !== null) {
                return `${pass.kind}${VALUE_SEPARATOR}${globalize.translate('WebGPUPipelineGraphWorkgroups', formatExtent(pass.workgroupCounts))}`;
            }
            // A pass without counts or an indirect buffer dispatches per frame, as the black bar analysis does, a workgroup per row and column
            return `${pass.kind}${VALUE_SEPARATOR}${pass.indirectBufferId === null ?
                globalize.translate('WebGPUPipelineGraphPerSourceLine') :
                globalize.translate('WebGPUPipelineGraphIndirect')}`;
    }
}

/** A texture's size and format, and the depth of its history ring when it has one. */
function describeTexture(texture: PlannedTexture): string {
    const description = `${formatDimensions(texture.width, texture.height)} ${texture.format}`;
    return texture.historyDepth > 0 ?
        `${description}${VALUE_SEPARATOR}${globalize.translate('WebGPUPipelineGraphHistory', texture.historyDepth)}` :
        description;
}

function describeCanvas(output: PlannedOutput): PipelineGraphLine[] {
    const lines: PipelineGraphLine[] = [];
    lines.push({ role: 'title', text: globalize.translate('WebGPUPipelineGraphCanvas') });
    lines.push({ role: 'detail', text: output.format });
    lines.push({ role: 'detail', text: `${output.colorSpace}${VALUE_SEPARATOR}${globalize.translate('WebGPUPipelineGraphToneMapping', output.toneMapping)}` });
    return lines;
}

/** The textures a pass writes: a render pass's target, or a compute pass's storage bindings. */
function getWrittenTextureIds(pass: PlannedPass): string[] {
    const textureIds: string[] = [];
    if (pass.target?.kind === 'texture') {
        textureIds.push(pass.target.textureId);
    }
    for (const binding of pass.bindings) {
        if (binding.kind === 'texture' && binding.access === 'storage' && !textureIds.includes(binding.textureId)) {
            textureIds.push(binding.textureId);
        }
    }
    return textureIds;
}

/** Collects each distinct read: the source by the passes that read it, every sampled texture by its reader, and the canvas by the pass that draws it. */
function collectColumnEdges(plan: PresentationPlan): ColumnEdge[] {
    const writerColumns = getWriterColumns(plan.passes);
    const canvasColumn = plan.passes.length + 1;
    const edges: ColumnEdge[] = [];
    const edgeKeys = new Set<string>();
    for (const [ index, pass ] of plan.passes.entries()) {
        const column = index + 1;
        for (const edge of getPassEdges(pass, column, writerColumns, canvasColumn)) {
            const key = `${edge.fromColumn}:${edge.toColumn}:${edge.textureId ?? ''}:${edge.historyOffset}`;
            if (!edgeKeys.has(key)) {
                edgeKeys.add(key);
                edges.push(edge);
            }
        }
    }
    return edges;
}

/** Maps each texture to the column of the first pass that writes it. */
function getWriterColumns(passes: readonly PlannedPass[]): ReadonlyMap<string, number> {
    const writerColumns = new Map<string, number>();
    for (const [ index, pass ] of passes.entries()) {
        for (const textureId of getWrittenTextureIds(pass)) {
            if (!writerColumns.has(textureId)) {
                writerColumns.set(textureId, index + 1);
            }
        }
    }
    return writerColumns;
}

function getPassEdges(
    pass: PlannedPass,
    column: number,
    writerColumns: ReadonlyMap<string, number>,
    canvasColumn: number
): ColumnEdge[] {
    const edges: ColumnEdge[] = [];
    if (pass.inputTextureId === null) {
        edges.push({ fromColumn: SOURCE_COLUMN, historyOffset: 0, textureId: null, toColumn: column });
    }
    for (const binding of pass.bindings) {
        if (binding.kind !== 'texture' || binding.access !== 'sampled') {
            continue;
        }
        const writerColumn = writerColumns.get(binding.textureId);
        if (writerColumn !== undefined) {
            edges.push({ fromColumn: writerColumn, historyOffset: binding.historyOffset, textureId: binding.textureId, toColumn: column });
        }
    }
    if (pass.target?.kind === 'output') {
        edges.push({ fromColumn: column, historyOffset: 0, textureId: null, toColumn: canvasColumn });
    }
    return edges;
}

/** Routes each edge and gives it a port on each node side it uses, in edge order. */
function routeEdges(edges: readonly ColumnEdge[], orientation: PipelineGraphOrientation): RoutedEdge[] {
    const nextPortIndexes = new Map<string, number>();
    const takePortIndex = (column: number, side: PortSide): number => {
        const key = getPortKey(column, side);
        const portIndex = nextPortIndexes.get(key) ?? 0;
        nextPortIndexes.set(key, portIndex + 1);
        return portIndex;
    };
    const routedEdges: RoutedEdge[] = [];
    for (const edge of edges) {
        const route = getEdgeRoute(edge);
        const sides = ROUTE_PORT_SIDES[orientation][route];
        routedEdges.push({
            ...edge,
            depth: getArcDepth(edge, route),
            fromPortIndex: takePortIndex(edge.fromColumn, sides.from),
            route,
            sides,
            toPortIndex: takePortIndex(edge.toColumn, sides.to)
        });
    }
    return routedEdges;
}

function getEdgeRoute(edge: ColumnEdge): PipelineGraphEdgeRoute {
    const span = edge.toColumn - edge.fromColumn;
    if (span <= 0) {
        return 'backward';
    }
    return span < MINIMUM_FORWARD_ARC_SPAN ? 'adjacent' : 'forward';
}

/** Arcs over more columns or rows reach further, so nested arcs stay apart. */
function getArcDepth(edge: ColumnEdge, route: PipelineGraphEdgeRoute): number {
    const geometry = PIPELINE_GRAPH_GEOMETRY;
    switch (route) {
        case 'adjacent':
            return 0;
        case 'forward':
            return geometry.arcDepth + (edge.toColumn - edge.fromColumn - MINIMUM_FORWARD_ARC_SPAN) * geometry.arcDepthStep;
        case 'backward':
            return geometry.arcDepth + (edge.fromColumn - edge.toColumn) * geometry.arcDepthStep;
    }
}

function getMaximumDepth(edges: readonly RoutedEdge[], route: PipelineGraphEdgeRoute): number {
    let maximumDepth = 0;
    for (const edge of edges) {
        if (edge.route === route) {
            maximumDepth = Math.max(maximumDepth, edge.depth);
        }
    }
    return maximumDepth;
}

/** The room arcs of a depth take beyond the nodes, with their labels; none without arcs. */
function getArcRoom(depth: number, labelRoom: number): number {
    return depth > 0 ? depth + labelRoom : 0;
}

function getNodeHeight(lineCount: number): number {
    return 2 * PIPELINE_GRAPH_GEOMETRY.nodePadding + lineCount * PIPELINE_GRAPH_GEOMETRY.lineHeight;
}

function getPortKey(column: number, side: PortSide): string {
    return `${column}:${side}`;
}

function countPorts(edges: readonly RoutedEdge[]): ReadonlyMap<string, number> {
    const portCounts = new Map<string, number>();
    for (const edge of edges) {
        for (const key of [ getPortKey(edge.fromColumn, edge.sides.from), getPortKey(edge.toColumn, edge.sides.to) ]) {
            portCounts.set(key, (portCounts.get(key) ?? 0) + 1);
        }
    }
    return portCounts;
}

/**
 * Spreads a side's ports evenly: along a facing side, over the left or right half of a top or bottom,
 * or over the upper or lower half of a left or right side.
 */
function getPortPoint(node: PipelineGraphNode, side: PortSide, portIndex: number, portCount: number): PipelineGraphPoint {
    const fraction = (portIndex + 1) / (portCount + 1);
    const bottom = node.y + node.height;
    const right = node.x + node.width;
    switch (side) {
        case 'left':
            return { x: node.x, y: node.y + node.height * fraction };
        case 'right':
            return { x: right, y: node.y + node.height * fraction };
        case 'top':
            return { x: node.x + node.width * fraction, y: node.y };
        case 'bottom':
            return { x: node.x + node.width * fraction, y: bottom };
        case 'bottom-in':
            return { x: node.x + node.width * HALF * fraction, y: bottom };
        case 'bottom-out':
            return { x: node.x + node.width * HALF * (1 + fraction), y: bottom };
        case 'top-in':
            return { x: node.x + node.width * HALF * fraction, y: node.y };
        case 'top-out':
            return { x: node.x + node.width * HALF * (1 + fraction), y: node.y };
        case 'left-in':
            return { x: node.x, y: node.y + node.height * HALF * fraction };
        case 'left-out':
            return { x: node.x, y: node.y + node.height * HALF * (1 + fraction) };
        case 'right-in':
            return { x: right, y: node.y + node.height * HALF * fraction };
        case 'right-out':
            return { x: right, y: node.y + node.height * HALF * (1 + fraction) };
    }
}

function positionEdges(
    edges: readonly RoutedEdge[],
    nodes: readonly PipelineGraphNode[],
    orientation: PipelineGraphOrientation,
    bounds: NodeBounds
): PipelineGraphEdge[] {
    const portCounts = countPorts(edges);
    const positionedEdges: PipelineGraphEdge[] = [];
    for (const edge of edges) {
        const fromNode = nodes[edge.fromColumn];
        const toNode = nodes[edge.toColumn];
        const { from, to } = edge.sides;
        const start = getPortPoint(fromNode, from, edge.fromPortIndex, portCounts.get(getPortKey(edge.fromColumn, from)) ?? 1);
        const end = getPortPoint(toNode, to, edge.toPortIndex, portCounts.get(getPortKey(edge.toColumn, to)) ?? 1);
        const curve = orientation === 'vertical' ? curveVertically(edge, start, end, bounds) : curveHorizontally(edge, start, end, bounds);
        positionedEdges.push({
            end,
            endControl: curve.endControl,
            fromNodeId: fromNode.id,
            historyOffset: edge.historyOffset,
            label: edge.historyOffset === 0 ? null : `[${edge.historyOffset}]`,
            labelPosition: curve.labelPosition,
            route: edge.route,
            start,
            startControl: curve.startControl,
            textureId: edge.textureId,
            toNodeId: toNode.id
        });
    }
    return positionedEdges;
}

/** Adjacent edges run sideways between the nodes; arcs bow below the nodes going forward and above them going back, labelled beyond their apex. */
function curveHorizontally(edge: RoutedEdge, start: PipelineGraphPoint, end: PipelineGraphPoint, bounds: NodeBounds): EdgeCurve {
    const labelOffset = PIPELINE_GRAPH_GEOMETRY.labelHeight * HALF;
    switch (edge.route) {
        case 'adjacent': {
            const halfSpan = (end.x - start.x) * HALF;
            return {
                endControl: { x: end.x - halfSpan, y: end.y },
                labelPosition: { x: (start.x + end.x) * HALF, y: (start.y + end.y) * HALF - labelOffset },
                startControl: { x: start.x + halfSpan, y: start.y }
            };
        }
        case 'forward': {
            const apexY = bounds.bottom + edge.depth;
            const controlY = getArcControl(apexY, start.y, end.y);
            return {
                endControl: { x: end.x, y: controlY },
                labelPosition: { x: (start.x + end.x) * HALF, y: apexY + labelOffset },
                startControl: { x: start.x, y: controlY }
            };
        }
        case 'backward': {
            const apexY = bounds.top - edge.depth;
            const controlY = getArcControl(apexY, start.y, end.y);
            return {
                endControl: { x: end.x, y: controlY },
                labelPosition: { x: (start.x + end.x) * HALF, y: apexY - labelOffset },
                startControl: { x: start.x, y: controlY }
            };
        }
    }
}

/** Adjacent edges run down between the rows; arcs bow right of the nodes going forward and left of them going back, labelled beside their apex. */
function curveVertically(edge: RoutedEdge, start: PipelineGraphPoint, end: PipelineGraphPoint, bounds: NodeBounds): EdgeCurve {
    const labelOffset = PIPELINE_GRAPH_GEOMETRY.labelWidth * HALF;
    const middleY = (start.y + end.y) * HALF;
    switch (edge.route) {
        case 'adjacent': {
            const halfSpan = (end.y - start.y) * HALF;
            return {
                endControl: { x: end.x, y: end.y - halfSpan },
                labelPosition: { x: (start.x + end.x) * HALF + labelOffset, y: middleY },
                startControl: { x: start.x, y: start.y + halfSpan }
            };
        }
        case 'forward': {
            const apexX = bounds.right + edge.depth;
            const controlX = getArcControl(apexX, start.x, end.x);
            return {
                endControl: { x: controlX, y: end.y },
                labelPosition: { x: apexX + labelOffset, y: middleY },
                startControl: { x: controlX, y: start.y }
            };
        }
        case 'backward': {
            const apexX = bounds.left - edge.depth;
            const controlX = getArcControl(apexX, start.x, end.x);
            return {
                endControl: { x: controlX, y: end.y },
                labelPosition: { x: apexX - labelOffset, y: middleY },
                startControl: { x: controlX, y: start.y }
            };
        }
    }
}

/**
 * Returns the coordinate both control points of an arc take across its span so that its midpoint reaches the apex.
 * With control points at one coordinate c, B(1/2) = (p0 + 6c + p3) / 8, so c = (8 apex - p0 - p3) / 6.
 */
function getArcControl(apex: number, start: number, end: number): number {
    return (BEZIER_MIDPOINT_DIVISOR * apex - start - end) / (2 * BEZIER_MIDPOINT_CONTROL_WEIGHT);
}

function interpolate(from: PipelineGraphPoint, to: PipelineGraphPoint, t: number): PipelineGraphPoint {
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

function getDistance(from: PipelineGraphPoint, to: PipelineGraphPoint): number {
    const deltaX = to.x - from.x;
    const deltaY = to.y - from.y;
    return Math.sqrt(deltaX * deltaX + deltaY * deltaY);
}

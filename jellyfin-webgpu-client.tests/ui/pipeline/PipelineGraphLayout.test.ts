import { describe, expect, it, vi } from 'vitest';

import globalize from 'lib/globalize';
import { createSDRColorMetadata } from 'webgpu-player/color/ColorMetadata';
import { createBuiltinChain } from 'webgpu-player/presentation/passes/builtin/BuiltinChains';
import type {
    PassRejection,
    PlannedBinding,
    PlannedOutput,
    PlannedPass,
    PlannedTexture,
    PresentationPlan
} from 'webgpu-player/presentation/passes/PassTypes';
import { planPresentation } from 'webgpu-player/presentation/passes/PresentationPlanner';
import { createDefaultRenderSettings } from 'webgpu-player/presentation/RenderSettings';
import type { PresentationRoute } from 'addons/webGPUPlayer/WebGPUPlayer';
import {
    formatPassRejection,
    formatPipelineGraphEdgePath,
    getCubicBezierPoint,
    getPassRejectionTone,
    getPipelineGraphArrowhead,
    getPipelineGraphPassTitle,
    layoutPipelineGraph,
    PIPELINE_GRAPH_GEOMETRY,
    splitCubicBezier,
    type PipelineGraphEdge,
    type PipelineGraphLayout,
    type PipelineGraphNode,
    type PipelineGraphPoint
} from 'addons/webGPUPlayer/ui/pipeline/PipelineGraphLayout';

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

type TextureRead = Readonly<{
    historyOffset: number
    textureId: string
}>;

const TEST_CANVAS_OUTPUT: PlannedOutput = { colorSpace: 'srgb', format: 'bgra8unorm', toneMapping: 'standard' };
const SOURCE_WIDTH = 1920;
const SOURCE_HEIGHT = 1080;
const OUTPUT_WIDTH = 2560;
const OUTPUT_HEIGHT = 1440;
const MAXIMUM_TEXTURE_DIMENSION = 8192;
const STORAGE_FORMAT: GPUTextureFormat = 'rgba8unorm';

const SIGNAL_TEXTURE_ID = 'signal';
const KERNEL_TEXTURE_ID = 'pass:Sharpen';
const TEMPORAL_TEXTURE_ID = 'pass:Temporal';
const COMPUTE_TEXTURE_ID = 'pass:Compute';
const SIGNAL_LABEL = 'Presentation signal';
const KERNEL_LABEL = 'Presentation pass \'Sharpen\'';
const TEMPORAL_LABEL = 'Presentation pass \'Temporal\'';
const COMPUTE_LABEL = 'Presentation pass \'Compute\'';
const OUTPUT_LABEL = 'Presentation output';
const BLACK_BARS_LABEL = 'Presentation black bars';
// The graph's titles of the labels above: a built-in pass's name upper-cased, a shader file's pass by its name
const SIGNAL_TITLE = 'Signal';
const KERNEL_TITLE = 'Sharpen';
const COMPUTE_TITLE = 'Compute';
const OUTPUT_TITLE = 'Output';
const BLACK_BARS_TITLE = 'Black bars';
const DEINTERLACE_TITLE = 'Deinterlace';
const TRANSFER_DECODE_STEP = 'builtin.transfer-decode';
const TONE_MAP_STEP = 'builtin.tone-map';
const DITHER_STEP = 'builtin.dither';
const CURRENT_FRAME = 0;
const PREVIOUS_FRAME = -1;
const PREVIOUS_FRAME_LABEL = '[-1]';
const HISTORY_DEPTH = 1;
const WORKGROUP_COUNTS = [ 240, 135, 1 ] as const;
const WORKGROUP_TEXT = '240x135x1';
const PIXEL_PRECISION = 6;
// The least an arc's arrowhead turns off the axes, as the component of its unit direction across them
const MINIMUM_TILT = 0.05;
const SDR_BIT_DEPTH = 8;
// The deinterlacing pass reads the signal's newest frame, the one before it, and the one before that, the latter two labelled
const DEINTERLACE_SIGNAL_READS: readonly [ string | null, number, string | null ][] = [
    [ SIGNAL_TEXTURE_ID, 0, null ],
    [ SIGNAL_TEXTURE_ID, -1, '[-1]' ],
    [ SIGNAL_TEXTURE_ID, -2, '[-2]' ]
];

const SOURCE_NODE_ID = 'source';
const CANVAS_NODE_ID = 'canvas';
const FIRST_PASS_NODE_ID = 'pass-0';
const SECOND_PASS_NODE_ID = 'pass-1';
const THIRD_PASS_NODE_ID = 'pass-2';
// Two ports on one side sit at a third and two thirds of it
const FIRST_OF_TWO_PORTS = 1 / 3;
const SECOND_OF_TWO_PORTS = 2 / 3;
const HALF = 0.5;

const ROUTE_RAW_FORMAT = 'I420P10';
const ROUTE_DOLBY_VISION_PROFILE = 8;
const ROUTE_HDR_TRANSFER = 'pq';
const GPU_DECODER_ID = 'org.example.hevc-decoder';

function text(key: string, ...values: Array<string | number>): string {
    return globalize.translate(key, ...values);
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

/** Returns a render pass that writes the canvas and reads the source, with the overrides applied. */
function createPlannedPass(overrides: Partial<PlannedPass> & Pick<PlannedPass, 'label'>): PlannedPass {
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

/** Returns sampled bindings for the reads, numbered from the first binding. */
function createSampledBindings(reads: readonly TextureRead[]): PlannedBinding[] {
    return reads.map((read: TextureRead, index: number): PlannedBinding => (
        { access: 'sampled', binding: index, historyOffset: read.historyOffset, kind: 'texture', textureId: read.textureId }
    ));
}

function createPlannedTexture(overrides: Partial<PlannedTexture> & Pick<PlannedTexture, 'height' | 'id' | 'width'>): PlannedTexture {
    return {
        format: 'rgba16float',
        historyDepth: 0,
        storage: false,
        ...overrides
    };
}

function createPresentationPlan(overrides: Partial<PresentationPlan> & Pick<PresentationPlan, 'passes'>): PresentationPlan {
    return {
        blackBarAnalysis: null,
        buffers: [],
        deinterlace: null,
        displayRate: false,
        historyDrawStart: 0,
        output: TEST_CANVAS_OUTPUT,
        parameterSets: [],
        passTextures: [],
        report: { activePasses: [], inactivePasses: [] },
        sourceKind: 'planes',
        textures: [],
        usesRenderSettings: false,
        ...overrides
    };
}

function createSignalPass(overrides: Partial<PlannedPass> = {}): PlannedPass {
    return createPlannedPass({ colorSteps: [ TRANSFER_DECODE_STEP ], label: SIGNAL_LABEL, target: { kind: 'texture', textureId: SIGNAL_TEXTURE_ID }, ...overrides });
}

function createOutputPass(inputTextureId: string, overrides: Partial<PlannedPass> = {}): PlannedPass {
    return createPlannedPass({
        bindings: createSampledBindings([ { historyOffset: CURRENT_FRAME, textureId: inputTextureId } ]),
        colorSteps: [ TONE_MAP_STEP, DITHER_STEP ],
        coordinateMapping: 'object-fit',
        inputTextureId,
        label: OUTPUT_LABEL,
        ...overrides
    });
}

/** Signal, a kernel over it, and the output pass over the kernel. */
function createChainPlan(): PresentationPlan {
    return createPresentationPlan({
        passes: [
            createSignalPass(),
            createPlannedPass({
                bindings: createSampledBindings([ { historyOffset: CURRENT_FRAME, textureId: SIGNAL_TEXTURE_ID } ]),
                inputTextureId: SIGNAL_TEXTURE_ID,
                label: KERNEL_LABEL,
                target: { kind: 'texture', textureId: KERNEL_TEXTURE_ID }
            }),
            createOutputPass(KERNEL_TEXTURE_ID)
        ],
        textures: [
            createPlannedTexture({ height: SOURCE_HEIGHT, id: SIGNAL_TEXTURE_ID, width: SOURCE_WIDTH }),
            createPlannedTexture({ height: SOURCE_HEIGHT, id: KERNEL_TEXTURE_ID, width: SOURCE_WIDTH })
        ]
    });
}

/** Signal, a temporal kernel that also reads its own previous output, and the output pass. */
function createTemporalPlan(): PresentationPlan {
    return createPresentationPlan({
        passes: [
            createSignalPass(),
            createPlannedPass({
                bindings: createSampledBindings([
                    { historyOffset: CURRENT_FRAME, textureId: SIGNAL_TEXTURE_ID },
                    { historyOffset: PREVIOUS_FRAME, textureId: TEMPORAL_TEXTURE_ID }
                ]),
                inputTextureId: SIGNAL_TEXTURE_ID,
                label: TEMPORAL_LABEL,
                target: { kind: 'texture', textureId: TEMPORAL_TEXTURE_ID }
            }),
            createOutputPass(TEMPORAL_TEXTURE_ID)
        ],
        textures: [
            createPlannedTexture({ height: SOURCE_HEIGHT, id: SIGNAL_TEXTURE_ID, width: SOURCE_WIDTH }),
            createPlannedTexture({ height: SOURCE_HEIGHT, historyDepth: HISTORY_DEPTH, id: TEMPORAL_TEXTURE_ID, width: SOURCE_WIDTH })
        ]
    });
}

function requireNode(layout: PipelineGraphLayout, nodeId: string): PipelineGraphNode {
    const node = layout.nodes.find((candidate: PipelineGraphNode): boolean => candidate.id === nodeId);
    if (!node) {
        throw new Error(`missing node ${nodeId}`);
    }
    return node;
}

function findEdges(layout: PipelineGraphLayout, fromNodeId: string, toNodeId: string): PipelineGraphEdge[] {
    return layout.edges.filter((edge: PipelineGraphEdge): boolean => edge.fromNodeId === fromNodeId && edge.toNodeId === toNodeId);
}

function getLineTexts(node: PipelineGraphNode): string[] {
    return node.lines.map((line): string => line.text);
}

function getNodeBottom(node: PipelineGraphNode): number {
    return node.y + node.height;
}

describe('layoutPipelineGraph', () => {
    it('places the source, each planned pass in plan order, and the canvas from left to right', () => {
        const layout = layoutPipelineGraph(createChainPlan(), null);

        expect(layout.nodes.map((node: PipelineGraphNode): string => node.id)).toEqual([
            SOURCE_NODE_ID,
            FIRST_PASS_NODE_ID,
            SECOND_PASS_NODE_ID,
            THIRD_PASS_NODE_ID,
            CANVAS_NODE_ID
        ]);
        expect(layout.nodes.map((node: PipelineGraphNode): string => node.kind)).toEqual([ 'source', 'pass', 'pass', 'pass', 'canvas' ]);
        for (const [ column, node ] of layout.nodes.entries()) {
            expect(node.x).toBe(PIPELINE_GRAPH_GEOMETRY.margin + column * (PIPELINE_GRAPH_GEOMETRY.nodeWidth + PIPELINE_GRAPH_GEOMETRY.columnGap));
            expect(node.y).toBe(PIPELINE_GRAPH_GEOMETRY.margin);
        }
    });

    it('sizes each node by its lines and the graph by its columns', () => {
        const layout = layoutPipelineGraph(createChainPlan(), null);
        const columnCount = layout.nodes.length;
        let tallestNodeHeight = 0;

        for (const node of layout.nodes) {
            expect(node.width).toBe(PIPELINE_GRAPH_GEOMETRY.nodeWidth);
            expect(node.height).toBe(2 * PIPELINE_GRAPH_GEOMETRY.nodePadding + node.lines.length * PIPELINE_GRAPH_GEOMETRY.lineHeight);
            tallestNodeHeight = Math.max(tallestNodeHeight, node.height);
        }
        expect(layout.width).toBe(2 * PIPELINE_GRAPH_GEOMETRY.margin + columnCount * PIPELINE_GRAPH_GEOMETRY.nodeWidth + (columnCount - 1) * PIPELINE_GRAPH_GEOMETRY.columnGap);
        expect(layout.height).toBe(2 * PIPELINE_GRAPH_GEOMETRY.margin + tallestNodeHeight);
    });

    it('labels the source with its kind and the route, translating the decoder and the transport', () => {
        const route = createRoute({
            dolbyVisionProfile: ROUTE_DOLBY_VISION_PROFILE,
            nativeHDRTransfer: ROUTE_HDR_TRANSFER,
            rawVideoFrameFormat: ROUTE_RAW_FORMAT,
            videoDecoderBackend: 'native',
            videoOutputMode: 'raw-planes'
        });
        const plan = createChainPlan();

        expect(getLineTexts(requireNode(layoutPipelineGraph(plan, route), SOURCE_NODE_ID))).toEqual([
            text('WebGPUPipelineGraphSource', plan.sourceKind),
            text('WebGPUPipelineGraphDecoder', text('WebGPUVideoDecoderNative')),
            text('WebGPUPipelineGraphTransportFormat', text('WebGPUVideoOutputRawPlanes'), ROUTE_RAW_FORMAT),
            text('WebGPUPipelineGraphDolbyVisionProfile', ROUTE_DOLBY_VISION_PROFILE),
            text('WebGPUPipelineGraphNativeHDR', ROUTE_HDR_TRANSFER)
        ]);
        expect(getLineTexts(requireNode(layoutPipelineGraph(plan, null), SOURCE_NODE_ID))).toEqual([
            text('WebGPUPipelineGraphSource', plan.sourceKind),
            text('WebGPUPipelineGraphRouteUnknown')
        ]);
    });

    it('names the GPU decoder package on the frame-pool route', () => {
        const route = createRoute({ gpuVideoDecoderId: GPU_DECODER_ID, videoDecoderBackend: 'gpu', videoOutputMode: 'frame-pool' });
        const lines = getLineTexts(requireNode(layoutPipelineGraph(createChainPlan(), route), SOURCE_NODE_ID));

        expect(lines).toEqual([
            text('WebGPUPipelineGraphSource', 'planes'),
            text('WebGPUPipelineGraphDecoder', text('WebGPUVideoDecoderGPU')),
            text('WebGPUPipelineGraphDecoderPackage', GPU_DECODER_ID),
            text('WebGPUPipelineGraphTransport', text('WebGPUVideoOutputFramePool'))
        ]);
        expect(lines.join('\n')).toContain(GPU_DECODER_ID);
    });

    it('describes a pass by its label, kind, coordinate mapping, target, and color steps', () => {
        const layout = layoutPipelineGraph(createChainPlan(), null);
        const kernelNode = requireNode(layout, SECOND_PASS_NODE_ID);
        const outputNode = requireNode(layout, THIRD_PASS_NODE_ID);

        expect(getLineTexts(kernelNode)).toEqual([ KERNEL_TITLE, 'render, identity', `-> ${KERNEL_TEXTURE_ID}`, `${SOURCE_WIDTH}x${SOURCE_HEIGHT} rgba16float` ]);
        expect(getLineTexts(outputNode)).toEqual([ OUTPUT_TITLE, 'render, object-fit', '-> canvas', TONE_MAP_STEP, DITHER_STEP ]);
        expect(outputNode.lines.map((line): string => line.role)).toEqual([ 'title', 'detail', 'detail', 'step', 'step' ]);
    });

    it('describes the canvas by its format, color space, and tone mapping', () => {
        const layout = layoutPipelineGraph(createChainPlan(), null);

        expect(getLineTexts(requireNode(layout, CANVAS_NODE_ID))).toEqual([
            text('WebGPUPipelineGraphCanvas'),
            TEST_CANVAS_OUTPUT.format,
            `${TEST_CANVAS_OUTPUT.colorSpace}, ${text('WebGPUPipelineGraphToneMapping', TEST_CANVAS_OUTPUT.toneMapping)}`
        ]);
    });

    it('connects the source to its reader, each texture to its readers, and the output pass to the canvas', () => {
        const layout = layoutPipelineGraph(createChainPlan(), null);

        expect(layout.edges.map((edge: PipelineGraphEdge) => [ edge.fromNodeId, edge.toNodeId, edge.textureId, edge.route ])).toEqual([
            [ SOURCE_NODE_ID, FIRST_PASS_NODE_ID, null, 'adjacent' ],
            [ FIRST_PASS_NODE_ID, SECOND_PASS_NODE_ID, SIGNAL_TEXTURE_ID, 'adjacent' ],
            [ SECOND_PASS_NODE_ID, THIRD_PASS_NODE_ID, KERNEL_TEXTURE_ID, 'adjacent' ],
            [ THIRD_PASS_NODE_ID, CANVAS_NODE_ID, null, 'adjacent' ]
        ]);
        for (const edge of layout.edges) {
            expect(edge.historyOffset).toBe(CURRENT_FRAME);
            expect(edge.label).toBeNull();
        }
    });

    it('runs an edge between adjacent columns from the writer\'s right side to the reader\'s left side', () => {
        const layout = layoutPipelineGraph(createChainPlan(), null);
        const writer = requireNode(layout, FIRST_PASS_NODE_ID);
        const reader = requireNode(layout, SECOND_PASS_NODE_ID);
        const [ edge ] = findEdges(layout, FIRST_PASS_NODE_ID, SECOND_PASS_NODE_ID);

        expect(edge.start).toEqual({ x: writer.x + writer.width, y: writer.y + writer.height * HALF });
        expect(edge.end).toEqual({ x: reader.x, y: reader.y + reader.height * HALF });
        expect(edge.startControl.y).toBe(edge.start.y);
        expect(edge.endControl.y).toBe(edge.end.y);
        expect(formatPipelineGraphEdgePath(edge)).toBe(
            `M ${edge.start.x} ${edge.start.y} C ${edge.startControl.x} ${edge.startControl.y}, ${edge.endControl.x} ${edge.endControl.y}, ${edge.end.x} ${edge.end.y}`
        );
    });

    it('marks a history read with its offset and a texture with a history ring with its depth', () => {
        const layout = layoutPipelineGraph(createTemporalPlan(), null);
        const [ historyEdge ] = findEdges(layout, SECOND_PASS_NODE_ID, SECOND_PASS_NODE_ID);

        expect(historyEdge.historyOffset).toBe(PREVIOUS_FRAME);
        expect(historyEdge.label).toBe(PREVIOUS_FRAME_LABEL);
        expect(historyEdge.textureId).toBe(TEMPORAL_TEXTURE_ID);
        expect(getLineTexts(requireNode(layout, SECOND_PASS_NODE_ID))).toContain(
            `${SOURCE_WIDTH}x${SOURCE_HEIGHT} rgba16float, ${text('WebGPUPipelineGraphHistory', HISTORY_DEPTH)}`
        );
    });

    it('arcs a read of the same or a later pass above the nodes, leaving room for the arc and its label', () => {
        const layout = layoutPipelineGraph(createTemporalPlan(), null);
        const node = requireNode(layout, SECOND_PASS_NODE_ID);
        const [ historyEdge ] = findEdges(layout, SECOND_PASS_NODE_ID, SECOND_PASS_NODE_ID);

        expect(historyEdge.route).toBe('backward');
        expect(historyEdge.start.y).toBe(node.y);
        expect(historyEdge.end.y).toBe(node.y);
        // It leaves from the right half of the top and comes back on the left half
        expect(historyEdge.start.x).toBeGreaterThan(node.x + node.width * HALF);
        expect(historyEdge.end.x).toBeLessThan(node.x + node.width * HALF);
        expect(historyEdge.startControl.y).toBeLessThan(node.y);
        expect(historyEdge.labelPosition.y).toBeLessThan(node.y - PIPELINE_GRAPH_GEOMETRY.arcDepth);
        expect(node.y).toBe(PIPELINE_GRAPH_GEOMETRY.margin + PIPELINE_GRAPH_GEOMETRY.arcDepth + PIPELINE_GRAPH_GEOMETRY.labelHeight);
    });

    it('arcs a read that skips a column below the nodes, leaving room for the arc and its label', () => {
        const chain = createChainPlan();
        const plan = createPresentationPlan({
            ...chain,
            passes: [
                chain.passes[0],
                chain.passes[1],
                createOutputPass(KERNEL_TEXTURE_ID, {
                    bindings: createSampledBindings([
                        { historyOffset: CURRENT_FRAME, textureId: KERNEL_TEXTURE_ID },
                        { historyOffset: CURRENT_FRAME, textureId: SIGNAL_TEXTURE_ID }
                    ])
                })
            ]
        });
        const layout = layoutPipelineGraph(plan, null);
        const [ skipEdge ] = findEdges(layout, FIRST_PASS_NODE_ID, THIRD_PASS_NODE_ID);
        let nodesBottom = 0;
        for (const node of layout.nodes) {
            nodesBottom = Math.max(nodesBottom, getNodeBottom(node));
        }

        expect(skipEdge.route).toBe('forward');
        expect(skipEdge.textureId).toBe(SIGNAL_TEXTURE_ID);
        expect(skipEdge.start.y).toBe(getNodeBottom(requireNode(layout, FIRST_PASS_NODE_ID)));
        expect(skipEdge.end.y).toBe(getNodeBottom(requireNode(layout, THIRD_PASS_NODE_ID)));
        expect(skipEdge.startControl.y).toBeGreaterThan(nodesBottom);
        expect(layout.height).toBe(nodesBottom + PIPELINE_GRAPH_GEOMETRY.arcDepth + PIPELINE_GRAPH_GEOMETRY.labelHeight + PIPELINE_GRAPH_GEOMETRY.margin);
    });

    it('spreads several edges between the same nodes over distinct ports', () => {
        const chain = createChainPlan();
        const plan = createPresentationPlan({
            ...chain,
            passes: [
                chain.passes[0],
                createPlannedPass({
                    bindings: createSampledBindings([
                        { historyOffset: CURRENT_FRAME, textureId: SIGNAL_TEXTURE_ID },
                        { historyOffset: PREVIOUS_FRAME, textureId: SIGNAL_TEXTURE_ID }
                    ]),
                    inputTextureId: SIGNAL_TEXTURE_ID,
                    label: KERNEL_LABEL
                })
            ]
        });
        const layout = layoutPipelineGraph(plan, null);
        const writer = requireNode(layout, FIRST_PASS_NODE_ID);
        const reader = requireNode(layout, SECOND_PASS_NODE_ID);
        const [ currentEdge, historyEdge ] = findEdges(layout, FIRST_PASS_NODE_ID, SECOND_PASS_NODE_ID);

        expect(currentEdge.start.y).toBeCloseTo(writer.y + writer.height * FIRST_OF_TWO_PORTS);
        expect(historyEdge.start.y).toBeCloseTo(writer.y + writer.height * SECOND_OF_TWO_PORTS);
        expect(currentEdge.end.y).toBeCloseTo(reader.y + reader.height * FIRST_OF_TWO_PORTS);
        expect(historyEdge.end.y).toBeCloseTo(reader.y + reader.height * SECOND_OF_TWO_PORTS);
        expect(historyEdge.label).toBe(PREVIOUS_FRAME_LABEL);
    });

    it('draws one edge for repeated reads of a texture at one offset', () => {
        const chain = createChainPlan();
        const plan = createPresentationPlan({
            ...chain,
            passes: [
                chain.passes[0],
                createOutputPass(SIGNAL_TEXTURE_ID, {
                    bindings: createSampledBindings([
                        { historyOffset: CURRENT_FRAME, textureId: SIGNAL_TEXTURE_ID },
                        { historyOffset: CURRENT_FRAME, textureId: SIGNAL_TEXTURE_ID }
                    ])
                })
            ]
        });

        expect(findEdges(layoutPipelineGraph(plan, null), FIRST_PASS_NODE_ID, SECOND_PASS_NODE_ID)).toHaveLength(1);
    });

    it('shows a compute pass\'s workgroup counts and follows its storage texture to its reader', () => {
        const plan = createPresentationPlan({
            passes: [
                createSignalPass(),
                createPlannedPass({
                    bindings: [
                        ...createSampledBindings([ { historyOffset: CURRENT_FRAME, textureId: SIGNAL_TEXTURE_ID } ]),
                        { access: 'storage', binding: 1, historyOffset: CURRENT_FRAME, kind: 'texture', textureId: COMPUTE_TEXTURE_ID }
                    ],
                    inputTextureId: SIGNAL_TEXTURE_ID,
                    kind: 'compute',
                    label: COMPUTE_LABEL,
                    target: null,
                    workgroupCounts: WORKGROUP_COUNTS
                }),
                createOutputPass(COMPUTE_TEXTURE_ID)
            ],
            textures: [
                createPlannedTexture({ height: SOURCE_HEIGHT, id: SIGNAL_TEXTURE_ID, width: SOURCE_WIDTH }),
                createPlannedTexture({ format: STORAGE_FORMAT, height: SOURCE_HEIGHT, id: COMPUTE_TEXTURE_ID, storage: true, width: SOURCE_WIDTH })
            ]
        });
        const layout = layoutPipelineGraph(plan, null);

        expect(getLineTexts(requireNode(layout, SECOND_PASS_NODE_ID))).toEqual([
            COMPUTE_TITLE,
            `compute, ${text('WebGPUPipelineGraphWorkgroups', WORKGROUP_TEXT)}`,
            `-> ${COMPUTE_TEXTURE_ID}`,
            `${SOURCE_WIDTH}x${SOURCE_HEIGHT} ${STORAGE_FORMAT}`
        ]);
        expect(findEdges(layout, SECOND_PASS_NODE_ID, THIRD_PASS_NODE_ID).map((edge: PipelineGraphEdge): string | null => edge.textureId)).toEqual([ COMPUTE_TEXTURE_ID ]);
    });

    it('lists a compute pass without counts as dispatching per source line, or indirectly with an indirect buffer, as a side pass', () => {
        const computePass = createPlannedPass({ kind: 'compute', label: COMPUTE_LABEL, target: null });
        const plan = createPresentationPlan({
            passes: [ computePass, createPlannedPass({ indirectBufferId: 'indirect', kind: 'compute', label: COMPUTE_LABEL, target: null }) ]
        });
        const layout = layoutPipelineGraph(plan, null);

        // Neither pass writes anything the canvas shows
        expect(layout.nodes.map((node: PipelineGraphNode): string => node.id)).toEqual([ SOURCE_NODE_ID, CANVAS_NODE_ID ]);
        expect(layout.sidePasses.map((sidePass): string => sidePass.lines[1].text)).toEqual([
            `compute, ${text('WebGPUPipelineGraphPerSourceLine')}`,
            `compute, ${text('WebGPUPipelineGraphIndirect')}`
        ]);
    });

    it('draws the deinterlacing pass after the signal, reading the signal\'s frame and the two before it', () => {
        const plan = planPresentation({
            chain: createBuiltinChain({
                format: 'I420',
                hdrOutput: false,
                interlacedChroma: true,
                metadata: createSDRColorMetadata(),
                route: 'raw-yuv',
                settings: createDefaultRenderSettings()
            }),
            deinterlace: { bitDepth: SDR_BIT_DEPTH, frameHeight: SOURCE_HEIGHT, frameWidth: SOURCE_WIDTH },
            device: { features: new Set<string>(), maximumTextureDimension: MAXIMUM_TEXTURE_DIMENSION },
            facts: {
                displayRate: null,
                frameRate: null,
                hdrOutput: false,
                hdrSource: false,
                outputHeight: OUTPUT_HEIGHT,
                outputWidth: OUTPUT_WIDTH,
                sampleHeight: SOURCE_HEIGHT,
                sampleWidth: SOURCE_WIDTH,
                sourceHeight: SOURCE_HEIGHT,
                sourceWidth: SOURCE_WIDTH
            },
            output: TEST_CANVAS_OUTPUT,
            passes: []
        });
        const layout = layoutPipelineGraph(plan, null);
        const signalReads = findEdges(layout, FIRST_PASS_NODE_ID, SECOND_PASS_NODE_ID);

        expect(getLineTexts(requireNode(layout, FIRST_PASS_NODE_ID))[0]).toBe(SIGNAL_TITLE);
        expect(getLineTexts(requireNode(layout, SECOND_PASS_NODE_ID))[0]).toBe(DEINTERLACE_TITLE);
        expect(layout.sidePasses).toEqual([]);
        expect(signalReads.map((edge: PipelineGraphEdge): [ string | null, number, string | null ] => [ edge.textureId, edge.historyOffset, edge.label ]))
            .toEqual(expect.arrayContaining([ ...DEINTERLACE_SIGNAL_READS ]));
        expect(signalReads).toHaveLength(DEINTERLACE_SIGNAL_READS.length);
    });
});

describe('layoutPipelineGraph vertically', () => {
    const VIEW_WIDTH = 400;
    const NARROW_VIEW_WIDTH = 50;
    const VERTICAL = { orientation: 'vertical', width: VIEW_WIDTH } as const;

    /** The chain plan with the output pass also reading the signal, two rows up. */
    function createSkipPlan(): PresentationPlan {
        const chain = createChainPlan();
        return createPresentationPlan({
            ...chain,
            passes: [
                chain.passes[0],
                chain.passes[1],
                createOutputPass(KERNEL_TEXTURE_ID, {
                    bindings: createSampledBindings([
                        { historyOffset: CURRENT_FRAME, textureId: KERNEL_TEXTURE_ID },
                        { historyOffset: CURRENT_FRAME, textureId: SIGNAL_TEXTURE_ID }
                    ])
                })
            ]
        });
    }

    it('keeps the horizontal layout by default', () => {
        const layout = layoutPipelineGraph(createChainPlan(), null);

        expect(layout.orientation).toBe('horizontal');
        expect(layoutPipelineGraph(createChainPlan(), null, { orientation: 'horizontal', width: VIEW_WIDTH })).toEqual(layout);
    });

    it('stacks the source, each planned pass in plan order, and the canvas from top to bottom, as wide as the width', () => {
        const layout = layoutPipelineGraph(createChainPlan(), null, VERTICAL);
        const geometry = PIPELINE_GRAPH_GEOMETRY;
        let nodeTop = geometry.margin;

        expect(layout.orientation).toBe('vertical');
        expect(layout.nodes.map((node: PipelineGraphNode): string => node.id)).toEqual([
            SOURCE_NODE_ID,
            FIRST_PASS_NODE_ID,
            SECOND_PASS_NODE_ID,
            THIRD_PASS_NODE_ID,
            CANVAS_NODE_ID
        ]);
        for (const node of layout.nodes) {
            // The chain has no arcs, so the nodes take the whole width inside the margins
            expect(node.x).toBe(geometry.margin);
            expect(node.width).toBe(VIEW_WIDTH - 2 * geometry.margin);
            expect(node.y).toBe(nodeTop);
            expect(node.height).toBe(2 * geometry.nodePadding + node.lines.length * geometry.lineHeight);
            nodeTop += node.height + geometry.rowGap;
        }
        expect(layout.width).toBe(VIEW_WIDTH);
        expect(layout.height).toBe(nodeTop - geometry.rowGap + geometry.margin);
    });

    it('gives the nodes the geometry\'s node width without a width, and its narrowest width when the width leaves less', () => {
        const unsized = layoutPipelineGraph(createChainPlan(), null, { orientation: 'vertical' });
        const narrow = layoutPipelineGraph(createChainPlan(), null, { orientation: 'vertical', width: NARROW_VIEW_WIDTH });

        for (const node of unsized.nodes) {
            expect(node.width).toBe(PIPELINE_GRAPH_GEOMETRY.nodeWidth);
        }
        expect(unsized.width).toBe(2 * PIPELINE_GRAPH_GEOMETRY.margin + PIPELINE_GRAPH_GEOMETRY.nodeWidth);
        for (const node of narrow.nodes) {
            expect(node.width).toBe(PIPELINE_GRAPH_GEOMETRY.minimumNodeWidth);
        }
    });

    it('runs an edge between adjacent rows from the writer\'s bottom to the reader\'s top', () => {
        const layout = layoutPipelineGraph(createChainPlan(), null, VERTICAL);
        const writer = requireNode(layout, FIRST_PASS_NODE_ID);
        const reader = requireNode(layout, SECOND_PASS_NODE_ID);
        const [ edge ] = findEdges(layout, FIRST_PASS_NODE_ID, SECOND_PASS_NODE_ID);

        expect(edge.route).toBe('adjacent');
        expect(edge.start).toEqual({ x: writer.x + writer.width * HALF, y: getNodeBottom(writer) });
        expect(edge.end).toEqual({ x: reader.x + reader.width * HALF, y: reader.y });
        expect(edge.startControl.x).toBe(edge.start.x);
        expect(edge.endControl.x).toBe(edge.end.x);
        expect(edge.startControl.y).toBeGreaterThan(edge.start.y);
        expect(edge.endControl.y).toBeLessThan(edge.end.y);
        expect(formatPipelineGraphEdgePath(edge)).toBe(
            `M ${edge.start.x} ${edge.start.y} C ${edge.startControl.x} ${edge.startControl.y}, ${edge.endControl.x} ${edge.endControl.y}, ${edge.end.x} ${edge.end.y}`
        );
    });

    it('arcs a read that skips a row right of the nodes, leaving room for the arc and its label', () => {
        const layout = layoutPipelineGraph(createSkipPlan(), null, VERTICAL);
        const geometry = PIPELINE_GRAPH_GEOMETRY;
        const writer = requireNode(layout, FIRST_PASS_NODE_ID);
        const reader = requireNode(layout, THIRD_PASS_NODE_ID);
        const [ skipEdge ] = findEdges(layout, FIRST_PASS_NODE_ID, THIRD_PASS_NODE_ID);
        const nodesRight = writer.x + writer.width;

        expect(skipEdge.route).toBe('forward');
        expect(skipEdge.textureId).toBe(SIGNAL_TEXTURE_ID);
        // It leaves from the lower half of the writer's right side and arrives on the upper half of the reader's
        expect(skipEdge.start.x).toBe(nodesRight);
        expect(skipEdge.end.x).toBe(reader.x + reader.width);
        expect(skipEdge.start.y).toBeGreaterThan(writer.y + writer.height * HALF);
        expect(skipEdge.end.y).toBeLessThan(reader.y + reader.height * HALF);
        expect(skipEdge.startControl.x).toBeGreaterThan(nodesRight);
        expect(skipEdge.endControl.x).toBe(skipEdge.startControl.x);
        expect(writer.x).toBe(geometry.margin);
        expect(writer.width).toBe(VIEW_WIDTH - 2 * geometry.margin - geometry.arcDepth - geometry.labelWidth);
        expect(layout.width).toBe(VIEW_WIDTH);
    });

    it('arcs a history read left of the nodes, with its label beside the arc\'s apex', () => {
        const layout = layoutPipelineGraph(createTemporalPlan(), null, VERTICAL);
        const geometry = PIPELINE_GRAPH_GEOMETRY;
        const node = requireNode(layout, SECOND_PASS_NODE_ID);
        const [ historyEdge ] = findEdges(layout, SECOND_PASS_NODE_ID, SECOND_PASS_NODE_ID);

        expect(historyEdge.route).toBe('backward');
        expect(historyEdge.label).toBe(PREVIOUS_FRAME_LABEL);
        expect(historyEdge.start.x).toBe(node.x);
        expect(historyEdge.end.x).toBe(node.x);
        // It leaves from the lower half of the left side and comes back on the upper half
        expect(historyEdge.start.y).toBeGreaterThan(node.y + node.height * HALF);
        expect(historyEdge.end.y).toBeLessThan(node.y + node.height * HALF);
        expect(historyEdge.startControl.x).toBeLessThan(node.x);
        expect(historyEdge.labelPosition.x).toBeLessThan(node.x - geometry.arcDepth);
        expect(historyEdge.labelPosition.y).toBe((historyEdge.start.y + historyEdge.end.y) * HALF);
        expect(node.x).toBe(geometry.margin + geometry.arcDepth + geometry.labelWidth);
        expect(node.width).toBe(VIEW_WIDTH - 2 * geometry.margin - geometry.arcDepth - geometry.labelWidth);
        expect(layout.width).toBe(VIEW_WIDTH);
    });
});

describe('side passes', () => {
    /** The chain plan with a black bar analysis between the kernel and the output pass: it reads the source and the kernel's previous output. */
    function createSidePassPlan(): PresentationPlan {
        const chain = createChainPlan();
        return createPresentationPlan({
            ...chain,
            passes: [
                chain.passes[0],
                chain.passes[1],
                createPlannedPass({
                    bindings: createSampledBindings([ { historyOffset: PREVIOUS_FRAME, textureId: KERNEL_TEXTURE_ID } ]),
                    kind: 'compute',
                    label: BLACK_BARS_LABEL,
                    target: null
                }),
                chain.passes[2]
            ]
        });
    }

    it('leaves a pass the canvas cannot be reached from out of the nodes and edges, and lists it with what it reads', () => {
        for (const orientation of [ 'horizontal', 'vertical' ] as const) {
            const layout = layoutPipelineGraph(createSidePassPlan(), null, { orientation });

            expect(layout.nodes.map((node: PipelineGraphNode): string => node.id)).toEqual([
                SOURCE_NODE_ID,
                FIRST_PASS_NODE_ID,
                SECOND_PASS_NODE_ID,
                'pass-3',
                CANVAS_NODE_ID
            ]);
            for (const edge of layout.edges) {
                expect([ edge.fromNodeId, edge.toNodeId ]).not.toContain(THIRD_PASS_NODE_ID);
                // The kernel hands its texture straight to the output pass again, with no arc around the side pass
                expect(edge.route).toBe('adjacent');
            }
            expect(findEdges(layout, SECOND_PASS_NODE_ID, 'pass-3').map((edge: PipelineGraphEdge): string | null => edge.textureId)).toEqual([ KERNEL_TEXTURE_ID ]);
            expect(layout.sidePasses).toHaveLength(1);
            const [ sidePass ] = layout.sidePasses;
            expect(sidePass.id).toBe(THIRD_PASS_NODE_ID);
            expect(sidePass.userPass).toBe(false);
            expect(sidePass.lines.map((line): string => line.text)).toEqual([ BLACK_BARS_TITLE, `compute, ${text('WebGPUPipelineGraphPerSourceLine')}` ]);
            expect(sidePass.reads).toEqual([ text('WebGPUPipelineGraphSourceName'), `${KERNEL_TITLE} ${PREVIOUS_FRAME_LABEL}` ]);
        }
    });

    it('keeps a pass whose texture reaches the canvas only through a history read', () => {
        const layout = layoutPipelineGraph(createTemporalPlan(), null);

        expect(layout.sidePasses).toEqual([]);
        expect(layout.nodes).toHaveLength(createTemporalPlan().passes.length + 2);
    });
});

describe('getPipelineGraphPassTitle', () => {
    it('drops the engine\'s prefix, upper-casing a built-in pass\'s name and naming a shader file\'s pass alone', () => {
        expect(getPipelineGraphPassTitle(BLACK_BARS_LABEL)).toEqual({ title: BLACK_BARS_TITLE, userPass: false });
        expect(getPipelineGraphPassTitle('Presentation luma plane')).toEqual({ title: 'Luma plane', userPass: false });
        expect(getPipelineGraphPassTitle('Presentation pass \'NVScaler pass\'')).toEqual({ title: 'NVScaler pass', userPass: true });
        expect(getPipelineGraphPassTitle('Custom label')).toEqual({ title: 'Custom label', userPass: false });
    });

    it('marks the nodes of a shader file\'s passes', () => {
        const layout = layoutPipelineGraph(createChainPlan(), null);

        expect(layout.nodes.map((node: PipelineGraphNode): boolean => node.userPass)).toEqual([ false, false, true, false, false ]);
        expect(requireNode(layout, SECOND_PASS_NODE_ID).lines[0].text).toBe(KERNEL_TITLE);
    });
});

describe('edge curves and arrowheads', () => {
    const VERTICAL = { orientation: 'vertical', width: 400 } as const;

    function getDirection(from: PipelineGraphPoint, to: PipelineGraphPoint): PipelineGraphPoint {
        const length = Math.sqrt((to.x - from.x) ** 2 + (to.y - from.y) ** 2);
        return { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
    }

    it('finds the points of a curve and splits it into two curves that run over the same points', () => {
        const [ edge ] = findEdges(layoutPipelineGraph(createTemporalPlan(), null, VERTICAL), SECOND_PASS_NODE_ID, SECOND_PASS_NODE_ID);
        const splitT = 0.4;
        const [ before, after ] = splitCubicBezier(edge, splitT);

        expect(getCubicBezierPoint(edge, 0)).toEqual(edge.start);
        expect(getCubicBezierPoint(edge, 1)).toEqual(edge.end);
        expect(before.start).toEqual(edge.start);
        expect(after.end).toEqual(edge.end);
        expect(before.end).toEqual(after.start);
        for (const t of [ 0.25, 0.5, 0.75 ]) {
            const original = getCubicBezierPoint(edge, t * splitT);
            const onBefore = getCubicBezierPoint(before, t);
            expect(onBefore.x).toBeCloseTo(original.x, PIXEL_PRECISION);
            expect(onBefore.y).toBeCloseTo(original.y, PIXEL_PRECISION);
        }
    });

    it('points a straight edge\'s arrowhead straight along it', () => {
        const layout = layoutPipelineGraph(createChainPlan(), null, VERTICAL);
        const [ edge ] = findEdges(layout, FIRST_PASS_NODE_ID, SECOND_PASS_NODE_ID);
        const arrowhead = getPipelineGraphArrowhead(edge);

        expect(edge.start.x).toBe(edge.end.x);
        expect(arrowhead.tip).toEqual(edge.end);
        expect(arrowhead.base.x).toBeCloseTo(edge.end.x, PIXEL_PRECISION);
        expect(arrowhead.base.y).toBeCloseTo(edge.end.y - PIPELINE_GRAPH_GEOMETRY.arrowLength, PIXEL_PRECISION);
        expect(arrowhead.left.y).toBeCloseTo(arrowhead.base.y, PIXEL_PRECISION);
        expect(arrowhead.right.y).toBeCloseTo(arrowhead.base.y, PIXEL_PRECISION);
        expect(Math.abs(arrowhead.left.x - arrowhead.right.x)).toBeCloseTo(PIPELINE_GRAPH_GEOMETRY.arrowWidth, PIXEL_PRECISION);
    });

    it('turns an arc\'s arrowhead along the arc\'s last stretch, off the axes', () => {
        const layout = layoutPipelineGraph(createTemporalPlan(), null, VERTICAL);
        const [ historyEdge ] = findEdges(layout, SECOND_PASS_NODE_ID, SECOND_PASS_NODE_ID);
        const arrowhead = getPipelineGraphArrowhead(historyEdge);
        const direction = getDirection(arrowhead.base, arrowhead.tip);
        const arrowLength = Math.sqrt((arrowhead.tip.x - arrowhead.base.x) ** 2 + (arrowhead.tip.y - arrowhead.base.y) ** 2);

        expect(arrowhead.tip).toEqual(historyEdge.end);
        expect(arrowLength).toBeCloseTo(PIPELINE_GRAPH_GEOMETRY.arrowLength, PIXEL_PRECISION);
        // The arc comes back into the node's left side from the left, still rising from the lower half it left over its last stretch
        expect(direction.x).toBeGreaterThan(0);
        expect(direction.y).toBeLessThan(-MINIMUM_TILT);
        expect(Math.abs(direction.x)).toBeLessThan(1);
        // The base lies on the arc
        const onArc = getCubicBezierPoint(historyEdge, arrowhead.t);
        expect(onArc.x).toBeCloseTo(arrowhead.base.x, PIXEL_PRECISION);
        expect(onArc.y).toBeCloseTo(arrowhead.base.y, PIXEL_PRECISION);
    });

    it('stops the drawn edge at its arrowhead\'s base', () => {
        const layout = layoutPipelineGraph(createTemporalPlan(), null, VERTICAL);
        for (const edge of layout.edges) {
            const arrowhead = getPipelineGraphArrowhead(edge);
            const [ drawn ] = splitCubicBezier(edge, arrowhead.t);

            expect(drawn.start).toEqual(edge.start);
            expect(drawn.end.x).toBeCloseTo(arrowhead.base.x, PIXEL_PRECISION);
            expect(drawn.end.y).toBeCloseTo(arrowhead.base.y, PIXEL_PRECISION);
            expect(formatPipelineGraphEdgePath(drawn)).toMatch(new RegExp(`, ${drawn.end.x} ${drawn.end.y}$`, 'u'));
        }
    });
});

describe('pass rejections', () => {
    it('formats a left-out pass as its check and detail, or the check alone, and mutes only a false condition', () => {
        const failure: PassRejection = { detail: 'line 3: unknown identifier', name: 'Sharpen', reason: 'compile-error' };
        const switchedOff: PassRejection = { detail: '', name: 'Grain', reason: 'condition-false' };

        expect(formatPassRejection(failure)).toBe('compile-error: line 3: unknown identifier');
        expect(formatPassRejection(switchedOff)).toBe('condition-false');
        expect(getPassRejectionTone(failure)).toBe('failure');
        expect(getPassRejectionTone(switchedOff)).toBe('muted');
    });
});

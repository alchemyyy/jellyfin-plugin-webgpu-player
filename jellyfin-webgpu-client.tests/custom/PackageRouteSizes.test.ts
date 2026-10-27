import { describe, expect, it } from 'vitest';

import { getPackageRouteSizeSteps, type PackageRouteSizeScope } from 'addons/webGPUPlayer/custom/PackageRouteSizes';
import type { GPUVideoDecoderSummary } from 'webgpu-player/decode/video/gpu/GPUVideoDecoderCatalog';

import { HEVC_HEADER } from './DecoderPackageHeaders';

// WebGPU's default largest storage binding, and a device that holds 2 GiB
const DEFAULT_STORAGE_BINDING_BYTE_LIMIT = 128 * 1024 * 1024;
const LARGE_BUFFER_BYTE_LIMIT = 2 ** 31;
const HEVC_SUMMARY: GPUVideoDecoderSummary = { codecs: [ 'hevc' ], header: HEVC_HEADER, outputFormats: HEVC_HEADER.outputFormats };
const MAIN_10_SCOPE: PackageRouteSizeScope = { codec: 'hevc', formats: [ 'I420P10' ], monochromeFormat: null };

describe('getPackageRouteSizeSteps', () => {
    it('steps the height down as the width grows, by the HEVC header\'s 8912896 coded samples on a 2 GiB device', () => {
        // Each height is the largest whose coded height, a multiple of 64, the header takes at the step's width
        expect(getPackageRouteSizeSteps([ { ...HEVC_SUMMARY, maximumBufferByteLength: LARGE_BUFFER_BYTE_LIMIT } ], MAIN_10_SCOPE)).toEqual([
            { maximumHeight: 4_288, maximumWidth: 1_920 },
            { maximumHeight: 3_456, maximumWidth: 2_560 },
            { maximumHeight: 2_304, maximumWidth: 3_840 },
            { maximumHeight: 2_176, maximumWidth: 4_096 },
            { maximumHeight: 1_152, maximumWidth: 7_680 },
            { maximumHeight: 1_088, maximumWidth: 8_192 }
        ]);
    });

    it('bounds Main 10 below 1080p at 1920 wide on a device of WebGPU\'s default 128 MiB storage binding, which a 29-slot I420P10 pool outgrows', () => {
        const steps = getPackageRouteSizeSteps([ { ...HEVC_SUMMARY, maximumBufferByteLength: DEFAULT_STORAGE_BINDING_BYTE_LIMIT } ], MAIN_10_SCOPE) ?? [];

        expect(steps.find(step => step.maximumWidth === 1_280)?.maximumHeight).toBeGreaterThanOrEqual(720);
        expect(steps.find(step => step.maximumWidth === 1_920)?.maximumHeight).toBeLessThan(1_080);
    });

    it('takes the tightest of a scope\'s formats, and with 4:0:0 only a package that declares monochrome', () => {
        const summary: GPUVideoDecoderSummary = { ...HEVC_SUMMARY, maximumBufferByteLength: DEFAULT_STORAGE_BINDING_BYTE_LIMIT };
        const scope: PackageRouteSizeScope = { codec: 'hevc', formats: [ 'I420P10', 'I444P10' ], monochromeFormat: null };

        expect(getPackageRouteSizeSteps([ summary ], scope)).toEqual(getPackageRouteSizeSteps([ summary ], { ...scope, formats: [ 'I444P10' ] }));
        expect(getPackageRouteSizeSteps([ summary ], { ...scope, monochromeFormat: 'I420P10' })).toEqual(getPackageRouteSizeSteps([ summary ], scope));
        expect(getPackageRouteSizeSteps([ { ...summary, header: { ...HEVC_HEADER, monochrome: false } } ], { ...scope, monochromeFormat: 'I420P10' })).toEqual([]);
    });

    it('takes the widest of several packages at each width', () => {
        const small: GPUVideoDecoderSummary = { ...HEVC_SUMMARY, maximumBufferByteLength: DEFAULT_STORAGE_BINDING_BYTE_LIMIT };
        const large: GPUVideoDecoderSummary = { ...HEVC_SUMMARY, maximumBufferByteLength: LARGE_BUFFER_BYTE_LIMIT };

        expect(getPackageRouteSizeSteps([ small, large ], MAIN_10_SCOPE)).toEqual(getPackageRouteSizeSteps([ large ], MAIN_10_SCOPE));
    });

    it('takes no size of a format no package writes, and every size from a package without a header', () => {
        expect(getPackageRouteSizeSteps([ { ...HEVC_SUMMARY, outputFormats: [ 'I420' ] } ], MAIN_10_SCOPE)).toEqual([]);
        expect(getPackageRouteSizeSteps([ { codecs: [ 'hevc' ], outputFormats: [ 'I420P10' ] } ], MAIN_10_SCOPE)).toBeNull();
    });
});

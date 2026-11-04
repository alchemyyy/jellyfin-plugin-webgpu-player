import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import vm from 'vm';
import { describe, expect, it } from 'vitest';

import type * as GPUDecoderStreamFit from 'webgpu-player/decode/video/gpu/GPUDecoderStreamFit';
import { createGPUDecodeStreamFacts } from 'webgpu-player/decode/video/gpu/GPUFramePool';

import { MPEG2_HEADER } from './custom/DecoderPackageHeaders';

// The build's ts-loader transpiles each add-on and engine file alone, with tsconfig.json's compiler options
const CLIENT_DIRECTORY = path.resolve(import.meta.dirname, '..', 'jellyfin-webgpu-client');
const BUILD_COMPILER_OPTIONS = ts.parseJsonConfigFileContent(
    ts.readConfigFile(path.join(CLIENT_DIRECTORY, 'tsconfig.json'), ts.sys.readFile).config,
    ts.sys,
    CLIENT_DIRECTORY
).options;
const FIT_CHECK_FILE = path.join(CLIENT_DIRECTORY, 'vendor', 'webgpu-player', 'src', 'decode', 'video', 'gpu', 'GPUDecoderStreamFit.ts');
// An Apple GPU's largest buffer and storage binding, 4 GiB less 4 bytes
const APPLE_GPU_BUFFER_BYTE_LIMIT = 4_294_967_292;

type BuiltModule = { exports: Record<string, unknown> };

/** Returns the exports of an engine file, and of the engine files it imports, as the build emits them, each run as CommonJS. */
function requireAsBuilt(file: string, modules: Map<string, BuiltModule>): Record<string, unknown> {
    const loaded = modules.get(file);
    if (loaded) {
        return loaded.exports;
    }
    const module: BuiltModule = { exports: {} };
    modules.set(file, module);
    const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
        compilerOptions: { ...BUILD_COMPILER_OPTIONS, module: ts.ModuleKind.CommonJS },
        fileName: file
    });
    // The engine's files import each other by relative paths without extensions
    const requireRelative = (specifier: string): Record<string, unknown> => requireAsBuilt(`${path.resolve(path.dirname(file), specifier)}.ts`, modules);
    // eslint-disable-next-line sonarjs/code-eval -- runs the engine's own source as the build emits it
    const run = vm.runInThisContext(`(function (exports, require, module) {\n${outputText}\n})`, { filename: file }) as (...parameters: unknown[]) => void;
    run(module.exports, requireRelative, module);
    return module.exports;
}

describe('the add-on build', () => {
    it('keeps the engine\'s errors their classes, so the GPU decoder fit check refuses a frame pool WGSL cannot address instead of throwing', () => {
        const { findGPUDecoderStreamFitFailure } = requireAsBuilt(FIT_CHECK_FILE, new Map()) as typeof GPUDecoderStreamFit;
        const stream = createGPUDecodeStreamFacts(16_384, 16_384, 'I422');

        // The MPEG-2 package's ten 4:2:2 slots of its largest picture take 5 GiB, past the u32 offsets WGSL addresses the pool with
        expect(findGPUDecoderStreamFitFailure(MPEG2_HEADER, stream, 'I422', APPLE_GPU_BUFFER_BYTE_LIMIT)).toBe('pool-size: 5368709120 > 4294967296');
    });
});

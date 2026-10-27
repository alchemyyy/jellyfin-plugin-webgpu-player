import { parseGPUDecoderHeader } from 'webgpu-player/decode/video/gpu/GPUDecoderManifest';
import type { GPUDecoderHeader } from 'webgpu-player/decode/video/gpu/GPUDecodeTypes';

// The headers of the engine's decoder projects as the server's catalog carries them, the `//!` lines without the WGSL body:
// every line the fit check reads, verbatim, with one dispatch in place of their error names and dispatch sequences

/** The HEVC decoder project's header: 16 references and 8 reordered frames, so a pool of 29 slots, within 8912896 coded samples. */
export const HEVC_HEADER: GPUDecoderHeader = parseGPUDecoderHeader([
    '//! id: hevc',
    '//! name: HEVC',
    '//! decoder: video',
    '//! accepts: codec in [hevc], stream.width <= 8192, stream.height <= 4320, stream.width * stream.height <= 8912896',
    '//! output: I420, I420P10, I420P12, I422, I422P10, I422P12, I444, I444P10, I444P12',
    '//! monochrome: yes',
    '//! parser: 2',
    '//! references: 16',
    '//! reorder: 8',
    '//! packet: 64 MiB',
    '//! state: 285696',
    '//! buffer: pictureState, 77056 + stream.width * stream.height * (1 + 2 / (output.chromaWidthDivisor * output.chromaHeightDivisor)) * output.bytesPerSample + 12 * stream.height',
    '//! buffer: blockData, 16 * (stream.width * stream.height / 16 + (stream.width + stream.height) / 4 + 1 + 64)',
    '//! buffer: residualData, 4 * stream.width * stream.height * (1 + 2 / (output.chromaWidthDivisor * output.chromaHeightDivisor))',
    '//! dispatch: beginPicture, 1'
].join('\n'));

/** The MPEG-2 decoder project's header, which takes 8-bit pictures up to 16384x16384 in three chroma formats with a pool of 10 slots. */
export const MPEG2_HEADER: GPUDecoderHeader = parseGPUDecoderHeader([
    '//! id: mpeg2',
    '//! name: MPEG-2 Video',
    '//! decoder: video',
    '//! accepts: codec in [mpeg2video, mpeg1video], stream.width <= 16384, stream.height <= 16384, stream.bitDepth == 8',
    '//! output: I420, I422, I444',
    '//! references: 2',
    '//! reorder: 3',
    '//! packet: 8 MiB',
    '//! state: 64',
    '//! buffer: pictureState, 2394880, indirect',
    '//! buffer: macroblocks, stream.width * stream.height / 256 * 68',
    '//! buffer: coefficients, min(stream.width * stream.height * (4 + 8 / (output.chromaWidthDivisor * output.chromaHeightDivisor)), 134217728)',
    '//! dispatch: loadLookups, 60'
].join('\n'));

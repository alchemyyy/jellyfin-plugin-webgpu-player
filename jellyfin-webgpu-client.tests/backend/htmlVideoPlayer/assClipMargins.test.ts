import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    getAssFrameCuts,
    getClippedAssStyleMargins,
    parseAssPlayResolution,
    readAssPlayResolution
} from 'addons/webGPUPlayer/backend/htmlVideoPlayer/assClipMargins';

describe('parseAssPlayResolution', () => {
    it('reads PlayResX and PlayResY from [Script Info] only', () => {
        expect(parseAssPlayResolution('\uFEFF[Script Info]\r\nTitle: x\r\nPlayResX: 1920\r\n  PlayResY:1080\r\n')).toEqual({ height: 1_080, width: 1_920 });
        // Lines before the section, in another section, and of another case are not headers to libass
        expect(parseAssPlayResolution([
            'PlayResX: 100',
            '[script info]',
            'playresx: 200',
            'PlayResX: 640',
            'PlayResY: 360',
            '[V4+ Styles]',
            'PlayResY: 999'
        ].join('\n'))).toEqual({ height: 360, width: 640 });
        // A duplicate header overwrites the earlier one, and a header past the styles in a new [Script Info] counts again
        expect(parseAssPlayResolution('[Script Info]\nPlayResX: 640\nPlayResX: 1280\nPlayResY: 720\n[Events]\n[Script Info]\nPlayResY: 960'))
            .toEqual({ height: 960, width: 1_280 });
    });

    it('reads integers as libass parse_int_header does', () => {
        expect(parseAssPlayResolution('[Script Info]\nPlayResX: +1280abc\nPlayResY:&h2D0')).toEqual({ height: 720, width: 1_280 });
        // libass tests the hexadecimal prefix before skipping spaces, so a spaced one reads as decimal 0, which is missing
        expect(parseAssPlayResolution('[Script Info]\nPlayResX: 1280\nPlayResY: &h2D0')).toEqual({ height: 1_024, width: 1_280 });
        expect(parseAssPlayResolution('[Script Info]\nPlayResX:0x500\nPlayResY: 1024.9')).toEqual({ height: 1_024, width: 1_280 });
    });

    it('completes a missing or invalid resolution as ass_lazy_track_init does', () => {
        expect(parseAssPlayResolution('[Script Info]\nTitle: none')).toEqual({ height: 288, width: 384 });
        expect(parseAssPlayResolution('[Script Info]\nPlayResX: -5\nPlayResY: x')).toEqual({ height: 288, width: 384 });
        expect(parseAssPlayResolution('[Script Info]\nPlayResX: 1280')).toEqual({ height: 1_024, width: 1_280 });
        expect(parseAssPlayResolution('[Script Info]\nPlayResX: 1920')).toEqual({ height: 1_440, width: 1_920 });
        expect(parseAssPlayResolution('[Script Info]\nPlayResX: 1922')).toEqual({ height: 1_441, width: 1_922 });
        expect(parseAssPlayResolution('[Script Info]\nPlayResX: 1')).toEqual({ height: 1, width: 1 });
        expect(parseAssPlayResolution('[Script Info]\nPlayResY: 1024')).toEqual({ height: 1_024, width: 1_280 });
        expect(parseAssPlayResolution('[Script Info]\nPlayResY: 1080')).toEqual({ height: 1_080, width: 1_440 });
    });
});

describe('readAssPlayResolution', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('reads only through [Script Info] and abandons the rest of the script', async () => {
        const encoder = new TextEncoder();
        let pulledChunks = 0;
        const chunks = [ '[Script Info]\nPlayResX: 1920\nPlay', 'ResY: 1080\n\n[V4+ Styles]\n', 'Format: Name\n', '[Events]\n' ];
        const body = new ReadableStream<Uint8Array>({
            pull(controller): void {
                if (pulledChunks >= chunks.length) {
                    controller.close();
                    return;
                }
                controller.enqueue(encoder.encode(chunks[pulledChunks]));
                pulledChunks += 1;
            }
        });
        let signal: AbortSignal | undefined;
        vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
            signal = init.signal ?? undefined;
            return Promise.resolve(new Response(body));
        }));

        await expect(readAssPlayResolution('https://example.test/subtitles.ass')).resolves.toEqual({ height: 1_080, width: 1_920 });
        expect(pulledChunks).toBeLessThan(chunks.length);
        expect(signal?.aborted).toBe(true);
    });

    it('returns null when the script cannot be read', async () => {
        const consoleWarning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))));
        await expect(readAssPlayResolution('https://example.test/missing.ass')).resolves.toBeNull();
        vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
        await expect(readAssPlayResolution('https://example.test/offline.ass')).resolves.toBeNull();
        expect(consoleWarning).toHaveBeenCalledOnce();
    });
});

describe('getAssFrameCuts', () => {
    const playResolution = { height: 1_080, width: 1_920 };

    it('cuts nothing while the frame stays within the box', () => {
        expect(getAssFrameCuts(playResolution, { height: 1_080, width: 1_920 }, { height: 1_080, width: 1_440, x: 240, y: 0 }))
            .toEqual({ bottom: 0, left: 0, right: 0, top: 0 });
        // A frame that ends at the box up to rounding cuts nothing either
        expect(getAssFrameCuts(playResolution, { height: 1_080, width: 2_560 }, { height: 1_080 + 1e-10, width: 2_560, x: 0, y: -1e-10 }))
            .toEqual({ bottom: 0, left: 0, right: 0, top: 0 });
    });

    it('converts the frame past each edge into script units, rounded out', () => {
        // A cropped 2.40:1 film on an ultrawide box: 180 of 1440px past the top and the bottom is 135 of 1080 lines
        expect(getAssFrameCuts(playResolution, { height: 1_080, width: 2_560 }, { height: 1_440, width: 2_560, x: 0, y: -180 }))
            .toEqual({ bottom: 135, left: 0, right: 0, top: 135 });
        // Cover moved by object-position cuts the sides unevenly: 100.5 and 571.5 of 2592px are 74.44 and 423.33 of 1920 columns
        expect(getAssFrameCuts(playResolution, { height: 1_080, width: 1_920 }, { height: 1_458, width: 2_592, x: -100.5, y: -189 }))
            .toEqual({ bottom: 140, left: 75, right: 424, top: 140 });
    });
});

describe('getClippedAssStyleMargins', () => {
    const styles = [
        // libass's alignments, VALIGN_* | HALIGN_*: bottom center, top right, middle left
        { Alignment: 2, MarginL: 10, MarginR: 12, MarginV: 20 },
        { Alignment: 4 | 3, MarginL: 0, MarginR: 5, MarginV: 30 },
        { Alignment: 8 | 1, MarginL: 7, MarginR: 0, MarginV: 40 }
    ];

    it('moves each style\'s margins in by the cuts at the edges it aligns to', () => {
        expect(getClippedAssStyleMargins(styles, { bottom: 135, left: 3, right: 4, top: 100 })).toEqual([
            { MarginL: 13, MarginR: 16, MarginV: 155 },
            { MarginL: 3, MarginR: 9, MarginV: 130 },
            { MarginL: 10, MarginR: 4, MarginV: 40 }
        ]);
    });

    it('returns the styles\' own margins without cuts', () => {
        expect(getClippedAssStyleMargins(styles, { bottom: 0, left: 0, right: 0, top: 0 })).toEqual([
            { MarginL: 10, MarginR: 12, MarginV: 20 },
            { MarginL: 0, MarginR: 5, MarginV: 30 },
            { MarginL: 7, MarginR: 0, MarginV: 40 }
        ]);
    });
});

// libass keeps a V4+ style's alignment as `VALIGN_* | HALIGN_*` (ass_types.h), and an SSA style's legacy alignment is that encoding already
const ASS_VERTICAL_ALIGNMENT_MASK = 12;
const ASS_VERTICAL_ALIGNMENT_SUBTITLE = 0;
const ASS_VERTICAL_ALIGNMENT_TOP = 4;

// The sections libass's process_line switches its parser to; any other line belongs to the section before it
const ASS_SECTION_PATTERN = /^\[(Script Info|V4 Styles|V4\+ Styles|Events|Fonts)\]/i;
const ASS_SCRIPT_INFO_END_PATTERN = /^[ \t]*\[(V4 Styles|V4\+ Styles|Events|Fonts)\]/im;
const ASS_HEADER_READ_LIMIT = 256 * 1024;
const UINT32_MODULUS = 2 ** 32;
const ASS_CUT_TOLERANCE_UNITS = 1e-6;

/**
 * Reads an `[Script Info]` integer as libass's parse_int_header does: hexadecimal after a leading `&h` or `0x`, decimal otherwise, after spaces and a sign,
 * modulo 2^32 as a signed 32-bit value, and 0 without digits.
 *
 * @param {string} value - Text after the header name's colon.
 * @returns {number} Header value.
 */
function parseAssIntegerHeader(value) {
    const hexadecimal = /^(&h|0x)/i.test(value);
    const match = (hexadecimal ? /^\s*([+-]?)(?:0x)?([0-9a-f]+)/i : /^\s*([+-]?)(\d+)/).exec(hexadecimal ? value.slice(2) : value);
    if (!match) {
        return 0;
    }
    const magnitude = Number.parseInt(match[2], hexadecimal ? 16 : 10) % UINT32_MODULUS;
    return (match[1] === '-' ? -magnitude : magnitude) | 0;
}

/**
 * Returns the script resolution libass lays a script out in: `PlayResX` and `PlayResY` from its `[Script Info]`, completed as ass_lazy_track_init
 * (ass.c) completes them when either is missing.
 *
 * @param {string} text - The script, or its beginning through `[Script Info]`.
 * @returns {{ height: number, width: number }} Script resolution.
 */
export function parseAssPlayResolution(text) {
    let inScriptInfo = false;
    let width = 0;
    let height = 0;
    for (const rawLine of text.split(/\r\n|\r|\n/)) {
        // libass's process_text skips byte order marks at a line's start, and process_line spaces and tabs after them
        const line = rawLine.replace(/^\uFEFF+/, '').replace(/^[ \t]+/, '');
        const section = ASS_SECTION_PATTERN.exec(line);
        if (section) {
            inScriptInfo = section[1].toLowerCase() === 'script info';
        } else if (inScriptInfo && line.startsWith('PlayResX:')) {
            width = parseAssIntegerHeader(line.slice('PlayResX:'.length));
        } else if (inScriptInfo && line.startsWith('PlayResY:')) {
            height = parseAssIntegerHeader(line.slice('PlayResY:'.length));
        }
    }

    if (width > 0 && height > 0) {
        return { height, width };
    }
    if (width <= 0 && height <= 0) {
        return { height: 288, width: 384 };
    }
    if (height <= 0) {
        // libass's overflow-safe `* 3/4`
        return { height: width === 1280 ? 1024 : Math.max(1, (width - 1) - Math.floor((width - 1) / 4)), width };
    }
    return { height, width: height === 1024 ? 1280 : Math.min(height + Math.floor(height / 3), 2 ** 31 - 1) };
}

/**
 * Fetches a script's beginning, through its `[Script Info]`, and returns its script resolution; null when the script cannot be read.
 *
 * @param {string} url - Script URL, as the libass worker fetches it.
 * @returns {Promise<{ height: number, width: number } | null>} Script resolution.
 */
export async function readAssPlayResolution(url) {
    // eslint-disable-next-line compat/compat -- Only custom playback reads scripts here, and it runs only where WebGPU does
    const controller = new AbortController();
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok || !response.body) {
            return null;
        }
        const reader = response.body.getReader();
        // eslint-disable-next-line compat/compat -- Only custom playback reads scripts here, and it runs only where WebGPU does
        const decoder = new TextDecoder();
        let text = '';
        while (!ASS_SCRIPT_INFO_END_PATTERN.test(text) && text.length < ASS_HEADER_READ_LIMIT) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            text += decoder.decode(value, { stream: true });
        }
        return parseAssPlayResolution(text);
    } catch (error) {
        console.warn('[libass] script resolution unavailable; unpositioned lines keep their margins', error);
        return null;
    } finally {
        // The rest of the script is the worker's to read
        controller.abort();
    }
}

/**
 * Returns how far the source frame reaches past each edge of the video's box, in script units, rounded out to whole units, which libass margins are.
 *
 * @param {{ height: number, width: number }} playResolution - Script resolution.
 * @param {{ height: number, width: number }} box - The video's box, in CSS pixels.
 * @param {{ height: number, width: number, x: number, y: number }} frame - The source frame's rectangle in the box, in CSS pixels.
 * @returns {{ bottom: number, left: number, right: number, top: number }} Cuts, 0 at an edge the frame stays within.
 */
export function getAssFrameCuts(playResolution, box, frame) {
    // libass lays the script out over the whole frame, PlayResX by PlayResY units
    const scaleX = playResolution.width / frame.width;
    const scaleY = playResolution.height / frame.height;
    // The tolerance keeps a frame that ends at an edge up to rounding from cutting a unit
    const toUnits = (pixels, scale) => Math.max(Math.ceil((pixels * scale) - ASS_CUT_TOLERANCE_UNITS), 0);
    return {
        bottom: toUnits(frame.y + frame.height - box.height, scaleY),
        left: toUnits(-frame.x, scaleX),
        right: toUnits(frame.x + frame.width - box.width, scaleX),
        top: toUnits(-frame.y, scaleY)
    };
}

/**
 * Returns the margins that keep a script's unpositioned lines on screen while the presentation cuts its frame: each style's margins moved in by the
 * cuts.
 * A bottom-aligned style's MarginV takes the bottom's cut and a top-aligned one's the top's, a middle-aligned one keeps it, and MarginL and MarginR take
 * the sides' cuts.
 * Positioned lines ignore margins, and a line's own non-zero margins replace its style's, so neither moves.
 *
 * @param {Array<{ Alignment: number, MarginL: number, MarginR: number, MarginV: number }>} styles - The script's own styles, in its order.
 * @param {{ bottom: number, left: number, right: number, top: number }} cuts - Cuts in script units, from `getAssFrameCuts`.
 * @returns {Array<{ MarginL: number, MarginR: number, MarginV: number }>} Margins per style; the styles' own while nothing is cut.
 */
export function getClippedAssStyleMargins(styles, cuts) {
    return styles.map((style) => {
        const verticalAlignment = style.Alignment & ASS_VERTICAL_ALIGNMENT_MASK;
        let marginV = style.MarginV;
        if (verticalAlignment === ASS_VERTICAL_ALIGNMENT_SUBTITLE) {
            marginV += cuts.bottom;
        } else if (verticalAlignment === ASS_VERTICAL_ALIGNMENT_TOP) {
            marginV += cuts.top;
        }
        return {
            MarginL: style.MarginL + cuts.left,
            MarginR: style.MarginR + cuts.right,
            MarginV: marginV
        };
    });
}

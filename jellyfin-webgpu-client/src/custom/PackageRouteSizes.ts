import type { GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import { isGPUVideoDecoderSummaryFit, type GPUVideoDecoderSummary } from 'webgpu-player/decode/video/gpu/GPUVideoDecoderCatalog';

// The picture sizes a decoder package route takes, as Jellyfin's Width and Height conditions can bound them.
// The engine judges a stream by its package's `accepts` conditions and the device's buffer limit, which may bound the area as well as each side,
// so the bound is a staircase: the height a width takes falls as the width grows, and each step bounds the widths up to its own by the height its widest takes.

/** One step of a package route's sizes: the widths past the previous step's, up to this one, take heights up to maximumHeight. */
export type PackageRouteSizeStep = Readonly<{
    maximumHeight: number
    maximumWidth: number
}>;

/** The streams of one route scope: a codec, and the output formats a stream of the scope may decode into, each of which its packages must take. */
export type PackageRouteSizeScope = Readonly<{
    codec: string
    formats: readonly GPUDecoderOutputFormat[]
    /** The 4:2:0 format a 4:0:0 stream of the scope decodes into, which a package takes only when its header declares monochrome; null when Jellyfin labels no 4:0:0 stream into the scope */
    monochromeFormat: GPUDecoderOutputFormat | null
}>;

// The widths at which a route's height bound may step down: common picture widths, so that a stream of one takes the bound of its own width
const SIZE_STEP_WIDTHS: readonly number[] = [ 1280, 1920, 2560, 3840, 4096, 7680 ];
// The largest width and height the search tries; a scope its packages take at this size in both is unbounded
const MAXIMUM_SEARCHED_DIMENSION = 65_536;

/** Returns the largest value in [1, MAXIMUM_SEARCHED_DIMENSION] the test takes, which takes every smaller one too, or 0 when it takes none. */
function findLargestTaken(takes: (value: number) => boolean): number {
    if (takes(MAXIMUM_SEARCHED_DIMENSION)) {
        return MAXIMUM_SEARCHED_DIMENSION;
    }
    let taken = 0;
    let refused = MAXIMUM_SEARCHED_DIMENSION;
    while (refused - taken > 1) {
        const middle = Math.floor((taken + refused) / 2);
        if (takes(middle)) {
            taken = middle;
        } else {
            refused = middle;
        }
    }
    return taken;
}

/** Returns whether a stream of the size decodes into every format of the scope, and as 4:0:0 where the scope holds it, on some package that writes it. */
function takesSize(summaries: readonly GPUVideoDecoderSummary[], scope: PackageRouteSizeScope, width: number, height: number): boolean {
    const takesFormat = (format: GPUDecoderOutputFormat, monochrome: boolean): boolean => summaries.some((summary: GPUVideoDecoderSummary): boolean => (
        isGPUVideoDecoderSummaryFit(summary, scope.codec, format, width, height, monochrome)
    ));
    return scope.formats.every((format: GPUDecoderOutputFormat): boolean => takesFormat(format, false))
        && (scope.monochromeFormat === null || takesFormat(scope.monochromeFormat, true));
}

/**
 * Returns the size steps of the streams the packages take in a scope, by the engine's fit check of each package's summary, widest step last.
 * An empty list means the scope takes no stream, and null that it takes every size the search tries, so its route needs no size condition.
 * The search assumes a package that takes a size takes every smaller one, as `accepts` bounds and buffer sizes that grow with the picture do.
 */
export function getPackageRouteSizeSteps(
    summaries: readonly GPUVideoDecoderSummary[],
    scope: PackageRouteSizeScope
): PackageRouteSizeStep[] | null {
    const maximumWidth = findLargestTaken((width: number): boolean => takesSize(summaries, scope, width, 1));
    if (maximumWidth === 0) {
        return [];
    }
    if (maximumWidth === MAXIMUM_SEARCHED_DIMENSION && takesSize(summaries, scope, maximumWidth, MAXIMUM_SEARCHED_DIMENSION)) {
        return null;
    }
    const steps: PackageRouteSizeStep[] = [];
    for (const width of [ ...SIZE_STEP_WIDTHS.filter((stepWidth: number): boolean => stepWidth < maximumWidth), maximumWidth ]) {
        const maximumHeight = findLargestTaken((height: number): boolean => takesSize(summaries, scope, width, height));
        const previous = steps.length > 0 ? steps[steps.length - 1] : null;
        // A step whose height matches the one before only widens it
        if (previous?.maximumHeight === maximumHeight) {
            steps[steps.length - 1] = { maximumHeight, maximumWidth: width };
        } else {
            steps.push({ maximumHeight, maximumWidth: width });
        }
    }
    return steps;
}

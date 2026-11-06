import { createServerReportQueue, getErrorMessage, type ServerReportQueue } from './ServerReportQueue';

// The playbacks that left the WebGPU route, reported to the server plugin, which writes each to the server's log, so an administrator reads
// why a client fell back without its browser's console: a WebGPU presentation that fell back to the browser's video, a lost GPU device,
// and custom playback that declined a source or fell back during a playback

const PLAYBACK_FALLBACKS_PATH = 'WebGPUPlayer/Diagnostics/PlaybackFallbacks';
const WARNING_PREFIX = 'WebGPU playback fallback report';
// The route's limits: it refuses a report beyond them whole
const MAXIMUM_FALLBACK_COUNT = 16;
const MAXIMUM_REASON_LENGTH = 64;
const MAXIMUM_DETAIL_LENGTH = 256;
// The route accepts printable ASCII only, so any other character of a browser's message becomes this one
const NON_PRINTABLE_ASCII_PATTERN = /[^\x20-\x7E]/g;
const REPLACEMENT_CHARACTER = '?';

export type PlaybackFallbackKind =
    | 'custom-playback-declined'
    | 'custom-playback-fallback'
    | 'device-lost'
    | 'presentation';

/** A fallback as the route reads it. */
type PlaybackFallbackReport = Readonly<{
    detail: string
    kind: PlaybackFallbackKind
    reason: string
}>;

let queue: ServerReportQueue<PlaybackFallbackReport> | null = null;
// Each kind and reason is sent once per page, so a browser that falls back on every play, as one without WebGPU does, logs it once
const reportedFallbacks = new Set<string>();

function toRouteString(value: string, maximumLength: number): string {
    return value.replace(NON_PRINTABLE_ASCII_PATTERN, REPLACEMENT_CHARACTER).slice(0, maximumLength);
}

/**
 * Reports a fallback to the current server, the first of its kind and reason in this page only, with a terse detail such as the failing value.
 * Nothing it does throws into the playback that calls it.
 */
export function reportPlaybackFallback(kind: PlaybackFallbackKind, reason: string, detail: string): void {
    if (!queue) {
        return;
    }
    try {
        const routeReason = toRouteString(reason, MAXIMUM_REASON_LENGTH);
        const key = `${kind} ${routeReason}`;
        if (routeReason.length === 0 || reportedFallbacks.has(key)) {
            return;
        }
        reportedFallbacks.add(key);
        queue.add([ { detail: toRouteString(detail, MAXIMUM_DETAIL_LENGTH), kind, reason: routeReason } ]);
    } catch (error) {
        console.warn(`${WARNING_PREFIX}: report-failed: ${getErrorMessage(error)}`);
    }
}

/** Starts the reports. Call it once the host's ServerConnections is bound; later calls do nothing, and a fallback before it is not reported. */
export function startPlaybackFallbackReports(): void {
    queue ??= createServerReportQueue<PlaybackFallbackReport>({
        bodyProperty: 'fallbacks',
        maximumCount: MAXIMUM_FALLBACK_COUNT,
        path: PLAYBACK_FALLBACKS_PATH,
        warningPrefix: WARNING_PREFIX
    });
}

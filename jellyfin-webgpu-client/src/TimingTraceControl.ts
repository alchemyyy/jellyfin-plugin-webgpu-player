import {
    clearTimingTrace,
    exportTimingTrace,
    isTimingTraceActive,
    startTimingTrace,
    stopTimingTrace,
    type TimingTraceExport
} from 'webgpu-player/TimingTrace';

// The engine's playback timing trace, exposed to the console and to automation as window.WebGPUPlayerTimingTrace.
// Setting the storage key to "1" starts a trace when the add-on loads, so a reload captures from the first play

export const TIMING_TRACE_STORAGE_KEY = 'webgpuPlayerTimingTrace';
const TIMING_TRACE_REQUESTED_VALUE = '1';
const TIMING_TRACE_FILE_PREFIX = 'webgpu-player-timing-';
const TIMING_TRACE_FILE_EXTENSION = '.json';
const TIMING_TRACE_MIME_TYPE = 'application/json';
const FILE_NAME_UNSAFE_CHARACTERS = /[:.]/g;

export type TimingTraceMetadata = Readonly<Record<string, unknown>>;
type TimingTraceMetadataProvider = () => TimingTraceMetadata;

/** The surface installed as window.WebGPUPlayerTimingTrace. */
export type TimingTraceControl = Readonly<{
    clear: () => void
    /** Saves the trace as a JSON file through the browser's download; false when no trace was started */
    download: () => Promise<boolean>
    export: () => Promise<TimingTraceExport | null>
    isRecording: () => boolean
    start: (capacity?: number) => void
    stop: () => void
}>;

let buildMetadata: TimingTraceMetadata = {};
let playbackMetadataProvider: TimingTraceMetadataProvider | null = null;

/** Registers the source of the playback state each export carries; null removes it. */
export function setTimingTraceMetadataProvider(provider: TimingTraceMetadataProvider | null): void {
    playbackMetadataProvider = provider;
}

async function readGPUAdapterMetadata(): Promise<TimingTraceMetadata | null> {
    const gpu = typeof navigator === 'undefined' ? undefined : navigator.gpu;
    if (!gpu) {
        return null;
    }
    try {
        // The presenter requests the default adapter too, so this names the GPU that presents
        const adapter = await gpu.requestAdapter();
        if (!adapter) {
            return null;
        }
        const { architecture, description, device, vendor } = adapter.info;
        return { architecture, description, device, vendor };
    } catch {
        return null;
    }
}

function readPlaybackMetadata(): TimingTraceMetadata {
    try {
        return playbackMetadataProvider?.() ?? {};
    } catch {
        // A trace exports even when the player cannot describe itself
        return {};
    }
}

async function exportTimingTraceWithMetadata(): Promise<TimingTraceExport | null> {
    if (!exportTimingTrace()) {
        return null;
    }
    const metadata: TimingTraceMetadata = {
        ...buildMetadata,
        devicePixelRatio: window.devicePixelRatio,
        gpuAdapter: await readGPUAdapterMetadata(),
        // eslint-disable-next-line compat/compat -- Timing traces run only where WebGPU playback runs
        hardwareConcurrency: navigator.hardwareConcurrency,
        screen: { height: window.screen.height, width: window.screen.width },
        userAgent: navigator.userAgent,
        ...readPlaybackMetadata()
    };
    return exportTimingTrace(metadata);
}

async function downloadTimingTrace(): Promise<boolean> {
    const trace = await exportTimingTraceWithMetadata();
    if (!trace) {
        return false;
    }
    const traceURL = URL.createObjectURL(new Blob([ JSON.stringify(trace) ], { type: TIMING_TRACE_MIME_TYPE }));
    const link = document.createElement('a');
    link.href = traceURL;
    link.download = TIMING_TRACE_FILE_PREFIX
        + new Date(trace.startedAtEpochMilliseconds).toISOString().replace(FILE_NAME_UNSAFE_CHARACTERS, '-')
        + TIMING_TRACE_FILE_EXTENSION;
    link.click();
    // The click has handed the blob to the download, so the URL can go once this task ends
    setTimeout((): void => URL.revokeObjectURL(traceURL));
    return true;
}

function isTimingTraceRequested(): boolean {
    try {
        return window.localStorage.getItem(TIMING_TRACE_STORAGE_KEY) === TIMING_TRACE_REQUESTED_VALUE;
    } catch {
        return false;
    }
}

/** Installs window.WebGPUPlayerTimingTrace once, and starts a trace when the page asked for one. */
export function installTimingTraceControl(metadata: TimingTraceMetadata): void {
    if (typeof window === 'undefined' || window.WebGPUPlayerTimingTrace) {
        return;
    }
    buildMetadata = metadata;
    window.WebGPUPlayerTimingTrace = {
        clear: clearTimingTrace,
        download: downloadTimingTrace,
        export: exportTimingTraceWithMetadata,
        isRecording: isTimingTraceActive,
        start: (capacity?: number): void => {
            startTimingTrace(capacity);
        },
        stop: stopTimingTrace
    };
    if (isTimingTraceRequested()) {
        startTimingTrace();
    }
}

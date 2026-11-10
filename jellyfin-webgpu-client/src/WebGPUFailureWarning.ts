import type { CustomPlaybackRuntimeFailureReason } from 'webgpu-player/capability/CustomPlaybackRuntime';
import type { PresentationFallbackReason } from 'webgpu-player/presentation/WebGPUPresenter';

import { loadAddonStrings } from './host/globalize';
import type { WebGPUDeviceLostFacts, WebGPUFailureReport } from './WebGPUFailureDiagnosis';
import { loadWebGPUUserSettings } from './WebGPUUserSettings';

// Tells the user once per page load when WebGPU itself fails, so a video plays through the browser's own player, and why.
// Each failure is diagnosed even when the warning is off, so the settings can show the last report on request.
// The diagnosis and the dialog load in a chunk of their own, since a page whose WebGPU works never needs them

/** A failure the player reports: the presenter's fallback, the custom playback runtime's, or a lost device. */
export type WebGPUFailureSource =
    | Readonly<{ kind: 'presentation', reason: PresentationFallbackReason, detail: string }>
    | Readonly<{ kind: 'runtime', reason: CustomPlaybackRuntimeFailureReason }>
    | Readonly<{ kind: 'device-lost', reason: string, message: string }>;

// The presenter's reasons that mean WebGPU itself failed; the others are about the content or the route
const PRESENTATION_FAILURE_REASONS: Readonly<Partial<Record<PresentationFallbackReason, true>>> = Object.freeze({
    'adapter-unavailable': true,
    'canvas-configuration-failed': true,
    'canvas-context-unavailable': true,
    'device-recovery-failed': true,
    'device-request-failed': true,
    'gpu-unavailable': true,
    'insecure-context': true,
    'pipeline-creation-failed': true
});
// The runtime's reasons about WebGPU; the others name a missing media API
const RUNTIME_FAILURE_REASONS: Readonly<Partial<Record<CustomPlaybackRuntimeFailureReason, true>>> = Object.freeze({
    'insecure-context': true,
    'webgpu-unavailable': true
});

// The last device loss, which the presenter may recover from, so it is only a fact for a later failure's diagnosis
let lastDeviceLost: WebGPUDeviceLostFacts | null = null;
let lastReport: WebGPUFailureReport | null = null;
// The diagnosis of the latest failure, by its kind, reason and whether a device was lost before it: the player meets the same failure on every playback
let currentDiagnosis: Readonly<{ key: string, report: Promise<WebGPUFailureReport> }> | null = null;
let warningShown = false;

function isWebGPUFailure(source: Exclude<WebGPUFailureSource, { kind: 'device-lost' }>): boolean {
    return source.kind === 'presentation' ?
        PRESENTATION_FAILURE_REASONS[source.reason] === true :
        RUNTIME_FAILURE_REASONS[source.reason] === true;
}

function isWarningEnabled(): boolean {
    try {
        return loadWebGPUUserSettings().osd.webGPUFailureWarning;
    } catch {
        // Settings that cannot be read leave the user unbothered
        return false;
    }
}

async function diagnose(source: WebGPUFailureSource, deviceLost: WebGPUDeviceLostFacts | null): Promise<WebGPUFailureReport> {
    const { collectWebGPUFailureFacts, diagnoseWebGPUFailure } = await import(
        /* webpackChunkName: "webgpu-failure-warning" */
        './WebGPUFailureDiagnosis'
    );
    const facts = await collectWebGPUFailureFacts(source, deviceLost);
    const diagnosis = diagnoseWebGPUFailure(facts);
    console.warn(`WebGPU failed (${source.kind}: ${source.reason}); diagnosis: ${diagnosis.cause} (${diagnosis.confidence})`);
    return { diagnosis, facts };
}

/** Diagnoses a failure as the current one; its report becomes the last unless a newer failure's diagnosis started meanwhile. */
function startDiagnosis(source: WebGPUFailureSource, key: string): Promise<WebGPUFailureReport> {
    const report = diagnose(source, lastDeviceLost);
    currentDiagnosis = { key, report };
    report.then((value: WebGPUFailureReport): void => {
        if (currentDiagnosis?.report === report) {
            lastReport = value;
        }
    }, (error: unknown): void => {
        console.warn('Unable to diagnose the WebGPU failure', error);
        // The next failure is diagnosed again
        if (currentDiagnosis?.report === report) {
            currentDiagnosis = null;
        }
    });
    return report;
}

/**
 * Notes a failure the player reports; never throws and never waits.
 * A failure of WebGPU itself is diagnosed, and the first one of the page shows the warning dialog when the user wants it.
 * A lost device alone shows nothing, since the presenter may recover; it is kept for the next failure's diagnosis.
 */
export function noteWebGPUFailure(source: WebGPUFailureSource): void {
    try {
        if (source.kind === 'device-lost') {
            lastDeviceLost = { message: source.message, reason: source.reason };
            return;
        }
        if (!isWebGPUFailure(source)) {
            return;
        }
        const show = !warningShown && isWarningEnabled();
        warningShown ||= show;
        const key = `${source.kind}:${source.reason}:${lastDeviceLost === null ? '' : 'device-lost'}`;
        const report = currentDiagnosis?.key === key ? currentDiagnosis.report : startDiagnosis(source, key);
        if (show) {
            report
                .then(showWebGPUFailureReport)
                .catch((error: unknown): void => {
                    console.warn('Unable to show the WebGPU failure warning', error);
                });
        }
    } catch (error) {
        console.warn('Unable to note the WebGPU failure', error);
    }
}

/** Returns the last diagnosed WebGPU failure of this page, or null before any. */
export function getLastWebGPUFailureReport(): WebGPUFailureReport | null {
    return lastReport;
}

/** Opens the warning dialog for a report, whether or not the warning is on, and resolves once it closes. */
export function showWebGPUFailureReport(report: WebGPUFailureReport): Promise<void> {
    return Promise.all([
        import(
            /* webpackChunkName: "webgpu-failure-warning" */
            './ui/WebGPUFailureDialog'
        ),
        loadAddonStrings()
    ]).then(([ dialog ]) => dialog.showWebGPUFailureDialog(report));
}

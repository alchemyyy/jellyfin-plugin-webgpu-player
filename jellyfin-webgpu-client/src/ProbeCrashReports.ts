import { onCapabilityProbeCrash, type CrashedCapabilityProbe } from 'webgpu-player/capability/CapabilityProbeStore';

import { createServerReportQueue, getErrorMessage, isRouteString, type ServerReportQueue } from './ServerReportQueue';

// The capability probes the engine finds crashed, reported to the server plugin, which writes each to the server's log.
// A crash takes its page and the page's console with it, and the next page that finds it may run where no console is read, such as on iOS,
// so the server's log is where an administrator reads it

const PROBE_CRASHES_PATH = 'WebGPUPlayer/Diagnostics/ProbeCrashes';
const WARNING_PREFIX = 'WebGPU probe crash report';
// The route's limits: it refuses a report beyond them whole
const MAXIMUM_CRASH_COUNT = 16;
const MAXIMUM_PROBE_LENGTH = 64;
const MAXIMUM_STEP_COUNT = 16;
const MAXIMUM_STEP_LENGTH = 96;

/** A crash as the route reads it. */
type ProbeCrashReport = Readonly<{
    probe: string
    steps: readonly string[]
}>;

let queue: ServerReportQueue<ProbeCrashReport> | null = null;

/** Returns a crash as the route accepts it, with the steps it refuses left out, or null when it refuses the probe's name. */
function toReport(crash: CrashedCapabilityProbe): ProbeCrashReport | null {
    if (!isRouteString(crash.probe, MAXIMUM_PROBE_LENGTH)) {
        return null;
    }
    return {
        probe: crash.probe,
        steps: crash.steps
            .filter((step: string): boolean => isRouteString(step, MAXIMUM_STEP_LENGTH))
            .slice(0, MAXIMUM_STEP_COUNT)
    };
}

/**
 * Reports each crash the engine finds to the current server, at once while a user is signed in, else with the next sign-in.
 * Call it once the host's ServerConnections is bound and before the probes start; later calls do nothing.
 */
export function startProbeCrashReports(): void {
    if (queue) {
        return;
    }
    const crashQueue = createServerReportQueue<ProbeCrashReport>({
        bodyProperty: 'crashes',
        maximumCount: MAXIMUM_CRASH_COUNT,
        path: PROBE_CRASHES_PATH,
        warningPrefix: WARNING_PREFIX
    });
    queue = crashQueue;
    onCapabilityProbeCrash((crashes: readonly CrashedCapabilityProbe[]): void => {
        // The engine calls this from its probe store; a failed report must not reach it
        try {
            crashQueue.add(crashes
                .map(toReport)
                .filter((report: ProbeCrashReport | null): report is ProbeCrashReport => report !== null));
        } catch (error) {
            console.warn(`${WARNING_PREFIX}: report-failed: ${getErrorMessage(error)}`);
        }
    });
}

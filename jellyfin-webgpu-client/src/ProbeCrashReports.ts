import { ServerConnections } from 'lib/jellyfin-apiclient';
import Events from 'utils/events';
import { onCapabilityProbeCrash, type CrashedCapabilityProbe } from 'webgpu-player/capability/CapabilityProbeStore';

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
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7E]*$/;

/** A crash as the route reads it. */
type ProbeCrashReport = Readonly<{
    probe: string
    steps: readonly string[]
}>;

/** The part of the host's API client the report uses. */
type ServerApiClient = Readonly<{
    accessToken: () => string
    getCurrentUserId: () => string | null | undefined
    getUrl: (name: string) => string
    /** Writes the authorization header Jellyfin Web sends, which names its client, device, and version beside the token */
    setRequestHeaders?: (headers: Record<string, string>) => void
}>;

let reportsStarted = false;
// Crashes found while no user was signed in, sent with the next sign-in
let pendingReports: ProbeCrashReport[] = [];

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Returns the current server's API client while a user is signed in to it, else null. */
function getSignedInApiClient(): ServerApiClient | null {
    const apiClient: ServerApiClient | null | undefined = ServerConnections.currentApiClient();
    return apiClient?.getCurrentUserId() ? apiClient : null;
}

function isRouteString(value: string, maximumLength: number): boolean {
    return value.length > 0 && value.length <= maximumLength && PRINTABLE_ASCII_PATTERN.test(value);
}

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
 * Returns the request's headers: the authorization header Jellyfin Web itself sends, so the server's log can name the client and device,
 * else the token alone, from an API client without its writer.
 */
function createRequestHeaders(apiClient: ServerApiClient): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiClient.setRequestHeaders) {
        apiClient.setRequestHeaders(headers);
    } else {
        headers.Authorization = `MediaBrowser Token="${apiClient.accessToken()}"`;
    }
    return headers;
}

/** Posts crashes to the server; a failed post is logged and not tried again. */
async function postReports(apiClient: ServerApiClient, crashes: readonly ProbeCrashReport[]): Promise<void> {
    try {
        const response = await fetch(apiClient.getUrl(PROBE_CRASHES_PATH), {
            body: JSON.stringify({ crashes }),
            headers: createRequestHeaders(apiClient),
            method: 'POST'
        });
        if (!response.ok) {
            console.warn(`${WARNING_PREFIX}: post-failed: ${PROBE_CRASHES_PATH} HTTP ${response.status}`);
        }
    } catch (error) {
        console.warn(`${WARNING_PREFIX}: post-failed: ${PROBE_CRASHES_PATH} ${getErrorMessage(error)}`);
    }
}

/** Sends the crashes waiting for a sign-in when a user is signed in now. */
function sendPendingReports(): void {
    if (pendingReports.length === 0) {
        return;
    }
    const apiClient = getSignedInApiClient();
    if (!apiClient) {
        return;
    }
    const crashes = pendingReports;
    pendingReports = [];
    void postReports(apiClient, crashes);
}

/** Queues a finding's crashes, keeping what fits one report, and sends them when a user is signed in. */
function reportCrashes(crashes: readonly CrashedCapabilityProbe[]): void {
    const reports = crashes
        .map(toReport)
        .filter((report: ProbeCrashReport | null): report is ProbeCrashReport => report !== null);
    pendingReports = [ ...pendingReports, ...reports ].slice(0, MAXIMUM_CRASH_COUNT);
    sendPendingReports();
}

/**
 * Reports each crash the engine finds to the current server, at once while a user is signed in, else with the next sign-in.
 * Call it once the host's ServerConnections is bound and before the probes start; later calls do nothing.
 */
export function startProbeCrashReports(): void {
    if (reportsStarted) {
        return;
    }
    reportsStarted = true;
    onCapabilityProbeCrash((crashes: readonly CrashedCapabilityProbe[]): void => {
        // The engine calls this from its probe store; a failed report must not reach it
        try {
            reportCrashes(crashes);
        } catch (error) {
            console.warn(`${WARNING_PREFIX}: report-failed: ${getErrorMessage(error)}`);
        }
    });
    Events.on(ServerConnections, 'localusersignedin', sendPendingReports);
}

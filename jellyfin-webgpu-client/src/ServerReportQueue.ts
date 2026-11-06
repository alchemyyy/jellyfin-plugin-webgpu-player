import { ServerConnections } from 'lib/jellyfin-apiclient';
import Events from 'utils/events';

// Posts the add-on's reports to a diagnostics route of the server plugin, which writes each to the server's log.
// A report found while no user is signed in waits for the next sign-in; a failed post is logged and not tried again.

const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7E]*$/;

/** The part of the host's API client a report uses. */
type ServerApiClient = Readonly<{
    accessToken: () => string
    getCurrentUserId: () => string | null | undefined
    getUrl: (name: string) => string
    /** Writes the authorization header Jellyfin Web sends, which names its client, device, and version beside the token */
    setRequestHeaders?: (headers: Record<string, string>) => void
}>;

export type ServerReportQueueOptions = Readonly<{
    /** The body's one property, which holds the reports, as the route reads it */
    bodyProperty: string
    /** The most reports one post holds, as the route accepts; later ones are left out */
    maximumCount: number
    /** The route, relative to the server's address */
    path: string
    /** Starts each console warning */
    warningPrefix: string
}>;

export type ServerReportQueue<Report> = Readonly<{
    /** Queues reports, keeping what fits one post, and sends them at once while a user is signed in, else with the next sign-in. */
    add: (reports: readonly Report[]) => void
}>;

export function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Returns whether a string is 1 to `maximumLength` printable ASCII characters, as the diagnostics routes accept. */
export function isRouteString(value: string, maximumLength: number): boolean {
    return value.length > 0 && value.length <= maximumLength && PRINTABLE_ASCII_PATTERN.test(value);
}

/** Returns the current server's API client while a user is signed in to it, else null. */
function getSignedInApiClient(): ServerApiClient | null {
    const apiClient: ServerApiClient | null | undefined = ServerConnections.currentApiClient();
    return apiClient?.getCurrentUserId() ? apiClient : null;
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

/**
 * Creates the queue of one route. Call it once the host's ServerConnections is bound, since it listens there for sign-ins.
 */
export function createServerReportQueue<Report>(options: ServerReportQueueOptions): ServerReportQueue<Report> {
    const { bodyProperty, maximumCount, path, warningPrefix } = options;
    let pendingReports: Report[] = [];

    const postReports = async (apiClient: ServerApiClient, reports: readonly Report[]): Promise<void> => {
        try {
            const response = await fetch(apiClient.getUrl(path), {
                body: JSON.stringify({ [bodyProperty]: reports }),
                headers: createRequestHeaders(apiClient),
                method: 'POST'
            });
            if (!response.ok) {
                console.warn(`${warningPrefix}: post-failed: ${path} HTTP ${response.status}`);
            }
        } catch (error) {
            console.warn(`${warningPrefix}: post-failed: ${path} ${getErrorMessage(error)}`);
        }
    };

    const sendPendingReports = (): void => {
        if (pendingReports.length === 0) {
            return;
        }
        const apiClient = getSignedInApiClient();
        if (!apiClient) {
            return;
        }
        const reports = pendingReports;
        pendingReports = [];
        void postReports(apiClient, reports);
    };

    Events.on(ServerConnections, 'localusersignedin', sendPendingReports);
    return {
        add: (reports: readonly Report[]): void => {
            pendingReports = [ ...pendingReports, ...reports ].slice(0, maximumCount);
            sendPendingReports();
        }
    };
}

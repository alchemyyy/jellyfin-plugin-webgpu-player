import { ServerConnections } from 'lib/jellyfin-apiclient';
import appSettings from 'scripts/settings/appSettings';
import Events from 'utils/events';

import { parseClientDefaults, setClientDefaults, type ClientDefaults } from './ClientDefaults';

// The defaults an administrator sets on the server for the add-on's settings: read once a user signs in, and kept per server so the next page starts with the last read.
// The settings follow the last defaults read until a newer read succeeds

const CLIENT_DEFAULTS_PATH = 'WebGPUPlayer/ClientDefaults';
// Not bound to a user: the defaults are the server's, the same for every user
const CACHE_KEY_PREFIX = 'webGPUPlayerClientDefaults-';
const WARNING_PREFIX = 'WebGPU client defaults';

/** The part of the host's API client the defaults use. */
type ServerApiClient = Readonly<{
    accessToken: () => string
    getCurrentUserId: () => string | null | undefined
    getUrl: (name: string) => string
    serverId: () => string
}>;

type PendingRefresh = Readonly<{
    promise: Promise<void>
    serverId: string
}>;

let syncStarted = false;
// The read in progress, of the server it reads; a read of another server starts its own
let pendingRefresh: PendingRefresh | null = null;

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Returns the current server's API client, or null when the page has none. */
function getApiClient(): ServerApiClient | null {
    return ServerConnections.currentApiClient() ?? null;
}

/** Returns the current server's API client while a user is signed in to it, else null. */
function getSignedInApiClient(): ServerApiClient | null {
    const apiClient = getApiClient();
    return apiClient?.getCurrentUserId() ? apiClient : null;
}

/** Applies a server's defaults when it is still the current server, and keeps them for the next page. */
function applyServerDefaults(serverId: string, defaults: ClientDefaults): void {
    if (getApiClient()?.serverId() === serverId) {
        setClientDefaults(defaults);
    }
    try {
        appSettings.set(CACHE_KEY_PREFIX + serverId, JSON.stringify(defaults));
    } catch (error) {
        // Local storage refuses a write once the origin's quota is full; the page still has the defaults
        console.warn(`${WARNING_PREFIX}: cache-write-failed: ${getErrorMessage(error)}`);
    }
}

/** Applies the defaults last read from the current server, else none, so another server's defaults never carry over to it. */
function applyCachedDefaults(): void {
    const apiClient = getApiClient();
    if (!apiClient) {
        return;
    }
    const cachedText = appSettings.get(CACHE_KEY_PREFIX + apiClient.serverId());
    let cachedDefaults: ClientDefaults = {};
    try {
        cachedDefaults = cachedText ? parseClientDefaults(JSON.parse(cachedText)) : {};
    } catch (error) {
        console.warn(`${WARNING_PREFIX}: cache-invalid: ${getErrorMessage(error)}`);
    }
    setClientDefaults(cachedDefaults);
}

/** Reads a response's settings envelope; a refusal rejects with the server's `<code>: <detail>`, or the HTTP status without one. */
async function readDefaultsResponse(response: Response): Promise<ClientDefaults> {
    let body: unknown = null;
    try {
        body = await response.json();
    } catch (error) {
        if (response.ok) {
            throw new Error(`response-invalid: ${getErrorMessage(error)}`);
        }
    }
    if (!response.ok) {
        if (typeof body === 'object' && body !== null && 'code' in body && typeof body.code === 'string') {
            const detail = 'detail' in body && typeof body.detail === 'string' ? body.detail : '';
            throw new Error(`${body.code}: ${detail}`);
        }
        throw new Error(`http-${response.status}`);
    }
    if (typeof body !== 'object' || body === null || !('settings' in body)
        || typeof body.settings !== 'object' || body.settings === null || Array.isArray(body.settings)) {
        throw new Error('response-invalid: no settings object');
    }
    return parseClientDefaults(body.settings);
}

/** Reads the defaults route, or stores defaults through it when given, signed in as the page's user. */
async function requestDefaults(apiClient: ServerApiClient, storedDefaults?: ClientDefaults): Promise<ClientDefaults> {
    const authorization = `MediaBrowser Token="${apiClient.accessToken()}"`;
    let response: Response;
    try {
        response = await fetch(apiClient.getUrl(CLIENT_DEFAULTS_PATH), storedDefaults === undefined ?
            { headers: { Authorization: authorization } } :
            {
                body: JSON.stringify({ settings: storedDefaults }),
                headers: { 'Authorization': authorization, 'Content-Type': 'application/json' },
                method: 'PUT'
            });
    } catch (error) {
        throw new Error(`server-request-failed: ${getErrorMessage(error)}`);
    }
    return readDefaultsResponse(response);
}

function requireSignedInApiClient(): ServerApiClient {
    const apiClient = getSignedInApiClient();
    if (!apiClient) {
        throw new Error('server-unavailable: no signed-in server');
    }
    return apiClient;
}

/** Reads the current server's defaults, for the editor that changes them; rejects with what failed. */
export async function fetchServerClientDefaults(): Promise<ClientDefaults> {
    return requestDefaults(requireSignedInApiClient());
}

/** Stores defaults on the current server, which only an administrator may, and applies what the server stored; rejects with what failed. */
export async function saveServerClientDefaults(defaults: ClientDefaults): Promise<ClientDefaults> {
    const apiClient = requireSignedInApiClient();
    const serverId = apiClient.serverId();
    const storedDefaults = await requestDefaults(apiClient, defaults);
    applyServerDefaults(serverId, storedDefaults);
    return storedDefaults;
}

/** Reads the current server's defaults and applies them; a failed read keeps the current defaults. */
async function refreshServerDefaults(apiClient: ServerApiClient): Promise<void> {
    const serverId = apiClient.serverId();
    try {
        applyServerDefaults(serverId, await requestDefaults(apiClient));
    } catch (error) {
        console.warn(`${WARNING_PREFIX}: refresh-failed: ${getErrorMessage(error)}`);
    }
}

/** Reads the current server's defaults once a user is signed in, joining a read of that server in progress; never rejects. */
export function refreshClientDefaults(): Promise<void> {
    const apiClient = getSignedInApiClient();
    if (!apiClient) {
        return Promise.resolve();
    }
    const serverId = apiClient.serverId();
    if (pendingRefresh?.serverId === serverId) {
        return pendingRefresh.promise;
    }
    const promise = refreshServerDefaults(apiClient).finally((): void => {
        if (pendingRefresh?.promise === promise) {
            pendingRefresh = null;
        }
    });
    pendingRefresh = { promise, serverId };
    return promise;
}

/** Resolves once the read in progress settles, at once without one; never rejects. */
export function whenClientDefaultsSettled(): Promise<void> {
    return pendingRefresh?.promise ?? Promise.resolve();
}

/** Applies the current server's last read defaults, then reads them again now and on each sign-in; later calls do nothing. */
export function startClientDefaultsSync(): void {
    if (syncStarted) {
        return;
    }
    syncStarted = true;
    applyCachedDefaults();
    void refreshClientDefaults();
    Events.on(ServerConnections, 'localusersignedin', (): void => {
        applyCachedDefaults();
        void refreshClientDefaults();
    });
}

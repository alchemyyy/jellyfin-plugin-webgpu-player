import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import Events from 'utils/events';

type ClientDefaultsModule = typeof import('addons/webGPUPlayer/ClientDefaults');
type ServerClientDefaultsModule = typeof import('addons/webGPUPlayer/ServerClientDefaults');

const SERVER_ADDRESS = 'https://jellyfin.example';
const SERVER_ID = 'server-1';
const OTHER_SERVER_ID = 'server-2';
const USER_ID = 'user-1';
const ACCESS_TOKEN = 'token-1';
const DEFAULTS_URL = `${SERVER_ADDRESS}/WebGPUPlayer/ClientDefaults`;
const AUTHORIZATION = `MediaBrowser Token="${ACCESS_TOKEN}"`;
// The host's appSettings key of a server's cached defaults, bound to no user
const CACHE_KEY = `webGPUPlayerClientDefaults-${SERVER_ID}`;
const INTERNAL_SERVER_ERROR_STATUS = 500;
const FORBIDDEN_STATUS = 403;
const BAD_REQUEST_STATUS = 400;
const PAYLOAD_TOO_LARGE_STATUS = 413;

const testState = vi.hoisted(() => ({
    serverId: 'server-1',
    userId: 'user-1' as string | null
}));

// The page's server connections, with an API client of the server the test names
vi.mock('lib/jellyfin-apiclient', () => {
    const apiClient = {
        accessToken: (): string => 'token-1',
        getCurrentUserId: (): string | null => testState.userId,
        getUrl: (name: string): string => `https://jellyfin.example/${name}`,
        serverId: (): string => testState.serverId
    };
    return {
        ServerConnections: {
            currentApiClient: vi.fn(() => apiClient)
        }
    };
});

type Modules = Readonly<{
    clientDefaults: ClientDefaultsModule
    serverConnections: object
    sync: ServerClientDefaultsModule
}>;

type PendingResponse = {
    promise: Promise<Response>
    resolve: (response: Response) => void
};

let fetchMock: Mock;
// The responses the server gives in request order; each test queues what it needs
let responses: Array<() => Promise<Response>>;

function respondJSON(value: unknown, status = 200): () => Promise<Response> {
    return (): Promise<Response> => Promise.resolve(new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' }, status }));
}

function respondStatus(status: number): () => Promise<Response> {
    return (): Promise<Response> => Promise.resolve(new Response(null, { status }));
}

function createPendingResponse(): PendingResponse {
    let resolve: (response: Response) => void = (): void => undefined;
    const promise = new Promise<Response>((resolvePromise): void => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

/** Loads the modules anew, so each test starts without defaults, a started sync, or a read in progress. */
async function importModules(): Promise<Modules> {
    vi.resetModules();
    const { ServerConnections } = await import('lib/jellyfin-apiclient');
    // The mocked connections outlive the reset; the host's events keep listeners on the object, so earlier tests' sign-in listeners are dropped
    Reflect.deleteProperty(ServerConnections, '_callbacks');
    const clientDefaults = await import('addons/webGPUPlayer/ClientDefaults');
    const sync = await import('addons/webGPUPlayer/ServerClientDefaults');
    return { clientDefaults, serverConnections: ServerConnections, sync };
}

function readCache(serverId = SERVER_ID): unknown {
    const cachedText = localStorage.getItem(`webGPUPlayerClientDefaults-${serverId}`);
    return cachedText === null ? null : JSON.parse(cachedText);
}

beforeEach(() => {
    localStorage.clear();
    testState.serverId = SERVER_ID;
    testState.userId = USER_ID;
    responses = [];
    fetchMock = vi.fn((): Promise<Response> => {
        const respond = responses.shift();
        return respond ? respond() : Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('ServerClientDefaults', () => {
    it('applies the current server\'s cached defaults at once, then the server\'s read, which it caches for the next page', async () => {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ brightness: 0.5 }));
        const pending = createPendingResponse();
        responses.push((): Promise<Response> => pending.promise);
        const { clientDefaults, sync } = await importModules();

        sync.startClientDefaultsSync();

        expect(clientDefaults.getClientDefaults()).toEqual({ brightness: 0.5 });
        expect(fetchMock).toHaveBeenCalledWith(DEFAULTS_URL, { headers: { Authorization: AUTHORIZATION } });
        pending.resolve(new Response(JSON.stringify({ settings: { brightness: 0.75, hdrOutput: true } }), { status: 200 }));
        await sync.whenClientDefaultsSettled();
        expect(clientDefaults.getClientDefaults()).toEqual({ brightness: 0.75, hdrOutput: true });
        expect(readCache()).toEqual({ brightness: 0.75, hdrOutput: true });
    });

    it('keeps the current defaults when a read fails, without rejecting', async () => {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ hdrOutput: true }));
        responses.push(respondStatus(INTERNAL_SERVER_ERROR_STATUS), (): Promise<Response> => Promise.reject(new TypeError('Failed to fetch')));
        const { clientDefaults, sync } = await importModules();

        sync.startClientDefaultsSync();
        await sync.whenClientDefaultsSettled();
        await expect(sync.refreshClientDefaults()).resolves.toBeUndefined();

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(clientDefaults.getClientDefaults()).toEqual({ hdrOutput: true });
        expect(readCache()).toEqual({ hdrOutput: true });
        expect(console.warn).toHaveBeenCalledWith(`WebGPU client defaults: refresh-failed: http-${INTERNAL_SERVER_ERROR_STATUS}`);
        expect(console.warn).toHaveBeenCalledWith('WebGPU client defaults: refresh-failed: server-request-failed: Failed to fetch');
    });

    it('reads the server only once a user signs in, and again on each sign-in', async () => {
        testState.userId = null;
        responses.push(respondJSON({ settings: { contrast: 1.25 } }), respondJSON({ settings: { contrast: 1.5 } }));
        const { clientDefaults, serverConnections, sync } = await importModules();

        sync.startClientDefaultsSync();
        await sync.whenClientDefaultsSettled();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(clientDefaults.getClientDefaults()).toEqual({});

        testState.userId = USER_ID;
        Events.trigger(serverConnections, 'localusersignedin', [ { Id: USER_ID } ]);
        await sync.whenClientDefaultsSettled();
        expect(clientDefaults.getClientDefaults()).toEqual({ contrast: 1.25 });

        Events.trigger(serverConnections, 'localusersignedin', [ { Id: USER_ID } ]);
        await sync.whenClientDefaultsSettled();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(clientDefaults.getClientDefaults()).toEqual({ contrast: 1.5 });
    });

    it('applies the cached defaults of the server a user signs in to', async () => {
        localStorage.setItem(`webGPUPlayerClientDefaults-${OTHER_SERVER_ID}`, JSON.stringify({ exposure: 1 }));
        responses.push(respondJSON({ settings: { exposure: 0 } }));
        const pending = createPendingResponse();
        responses.push((): Promise<Response> => pending.promise);
        const { clientDefaults, serverConnections, sync } = await importModules();
        sync.startClientDefaultsSync();
        await sync.whenClientDefaultsSettled();

        testState.serverId = OTHER_SERVER_ID;
        Events.trigger(serverConnections, 'localusersignedin', [ { Id: USER_ID } ]);

        expect(clientDefaults.getClientDefaults()).toEqual({ exposure: 1 });
        pending.resolve(new Response(JSON.stringify({ settings: { exposure: 2 } }), { status: 200 }));
        await sync.whenClientDefaultsSettled();
        expect(clientDefaults.getClientDefaults()).toEqual({ exposure: 2 });
        expect(readCache()).toEqual({ exposure: 0 });
        expect(readCache(OTHER_SERVER_ID)).toEqual({ exposure: 2 });
    });

    it('starts a server without cached defaults from none, so another server\'s defaults never carry over to it', async () => {
        responses.push(respondJSON({ settings: { exposure: 1 } }), respondStatus(INTERNAL_SERVER_ERROR_STATUS));
        const { clientDefaults, serverConnections, sync } = await importModules();
        sync.startClientDefaultsSync();
        await sync.whenClientDefaultsSettled();
        expect(clientDefaults.getClientDefaults()).toEqual({ exposure: 1 });

        // The other server's read fails, so only its own cache could give it defaults
        testState.serverId = OTHER_SERVER_ID;
        Events.trigger(serverConnections, 'localusersignedin', [ { Id: USER_ID } ]);
        await sync.whenClientDefaultsSettled();

        expect(clientDefaults.getClientDefaults()).toEqual({});
        expect(readCache()).toEqual({ exposure: 1 });
    });

    it('joins a read in progress, and starts the sync only once', async () => {
        const pending = createPendingResponse();
        responses.push((): Promise<Response> => pending.promise);
        const { clientDefaults, sync } = await importModules();

        sync.startClientDefaultsSync();
        sync.startClientDefaultsSync();
        const firstRefresh = sync.refreshClientDefaults();
        const secondRefresh = sync.refreshClientDefaults();
        let settled = false;
        void sync.whenClientDefaultsSettled().then((): void => {
            settled = true;
        });
        await Promise.resolve();

        expect(secondRefresh).toBe(firstRefresh);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(settled).toBe(false);
        pending.resolve(new Response(JSON.stringify({ settings: { saturation: 0.5 } }), { status: 200 }));
        await firstRefresh;
        await Promise.resolve();
        expect(settled).toBe(true);
        expect(clientDefaults.getClientDefaults()).toEqual({ saturation: 0.5 });
        // A settled read leaves nothing to wait for
        await expect(sync.whenClientDefaultsSettled()).resolves.toBeUndefined();
    });

    it('saves defaults in the settings envelope, then applies and caches what the server stored', async () => {
        responses.push(respondJSON({ settings: { brightness: 0.5, settingsButtonPlacement: 'controls-end' } }));
        const { clientDefaults, sync } = await importModules();

        const stored = await sync.saveServerClientDefaults({ brightness: 0.5, settingsButtonPlacement: 'controls-end' });

        expect(fetchMock).toHaveBeenCalledWith(DEFAULTS_URL, {
            body: JSON.stringify({ settings: { brightness: 0.5, settingsButtonPlacement: 'controls-end' } }),
            headers: { 'Authorization': AUTHORIZATION, 'Content-Type': 'application/json' },
            method: 'PUT'
        });
        expect(stored).toEqual({ brightness: 0.5, settingsButtonPlacement: 'controls-end' });
        expect(clientDefaults.getClientDefaults()).toEqual(stored);
        expect(readCache()).toEqual(stored);
    });

    it('rejects a refused read or save with the server\'s code and detail, else the HTTP status, and keeps the defaults', async () => {
        responses.push(
            respondJSON({ code: 'client-defaults-invalid', detail: 'settings.brightness is null' }, BAD_REQUEST_STATUS),
            respondStatus(PAYLOAD_TOO_LARGE_STATUS),
            respondStatus(FORBIDDEN_STATUS),
            respondJSON({ settings: { contrast: 1.25 } })
        );
        const { clientDefaults, sync } = await importModules();

        await expect(sync.saveServerClientDefaults({ brightness: null })).rejects.toThrow('client-defaults-invalid: settings.brightness is null');
        await expect(sync.saveServerClientDefaults({ brightness: 0.5 })).rejects.toThrow(`http-${PAYLOAD_TOO_LARGE_STATUS}`);
        await expect(sync.fetchServerClientDefaults()).rejects.toThrow(`http-${FORBIDDEN_STATUS}`);
        expect(clientDefaults.getClientDefaults()).toEqual({});
        // A read for the editor only reads
        await expect(sync.fetchServerClientDefaults()).resolves.toEqual({ contrast: 1.25 });
        expect(clientDefaults.getClientDefaults()).toEqual({});
        testState.userId = null;
        await expect(sync.fetchServerClientDefaults()).rejects.toThrow('server-unavailable: no signed-in server');
    });
});

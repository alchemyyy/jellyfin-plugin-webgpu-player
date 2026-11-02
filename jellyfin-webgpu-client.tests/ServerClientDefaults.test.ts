import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import Events from 'utils/events';

import { WEBGPU_USER_SETTINGS_STORAGE_KEY as SETTINGS_STORAGE_KEY, WEBGPU_USER_SETTINGS_VERSION } from 'addons/webGPUPlayer/WebGPUUserSettings';

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
    // The signed-in user's local settings, by name
    storage: new Map<string, string>(),
    userId: 'user-1' as string | null
}));

// The signed-in user's local settings, which the add-on build redirects to its shim
vi.mock('scripts/settings/userSettings', () => ({
    currentSettings: {
        get: (name: string): string | null => testState.storage.get(name) ?? null,
        set: (name: string, value: string): void => {
            testState.storage.set(name, value);
        }
    }
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

function readStoredSettings(): unknown {
    return JSON.parse(testState.storage.get(SETTINGS_STORAGE_KEY) ?? 'null');
}

beforeEach(() => {
    localStorage.clear();
    testState.serverId = SERVER_ID;
    testState.storage.clear();
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
        expect(readCache()).toEqual({ applied: {}, settings: { brightness: 0.75, hdrOutput: true } });
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
        expect(readCache()).toEqual({ applied: {}, settings: { exposure: 0 } });
        expect(readCache(OTHER_SERVER_ID)).toEqual({ applied: {}, settings: { exposure: 2 } });
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
        expect(readCache()).toEqual({ applied: {}, settings: { exposure: 1 } });
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
        responses.push(respondJSON({ applied: {}, settings: { brightness: 0.5, settingsButtonPlacement: 'controls-end' } }));
        const { clientDefaults, sync } = await importModules();

        const stored = await sync.saveServerClientDefaults({ brightness: 0.5, settingsButtonPlacement: 'controls-end' });

        expect(fetchMock).toHaveBeenCalledWith(DEFAULTS_URL, {
            body: JSON.stringify({ settings: { brightness: 0.5, settingsButtonPlacement: 'controls-end' } }),
            headers: { 'Authorization': AUTHORIZATION, 'Content-Type': 'application/json' },
            method: 'PUT'
        });
        expect(stored).toEqual({ applied: {}, settings: { brightness: 0.5, settingsButtonPlacement: 'controls-end' } });
        expect(clientDefaults.getClientDefaults()).toEqual(stored.settings);
        expect(readCache()).toEqual(stored);
    });

    it('names the settings a save applies to every client', async () => {
        responses.push(respondJSON({ applied: { brightness: 7 }, settings: { brightness: 0.5 } }));
        const { sync } = await importModules();

        await expect(sync.saveServerClientDefaults({ brightness: 0.5 }, [ 'brightness' ])).resolves.toEqual({ applied: { brightness: 7 }, settings: { brightness: 0.5 } });

        expect(fetchMock).toHaveBeenCalledWith(DEFAULTS_URL, expect.objectContaining({
            body: JSON.stringify({ apply: [ 'brightness' ], settings: { brightness: 0.5 } })
        }));
    });

    it('drops the user\'s own choice of each applied setting once per revision, keeping their other choices', async () => {
        testState.storage.set(SETTINGS_STORAGE_KEY, JSON.stringify({
            playback: { enableCustomDecode: false },
            render: { settings: { display: { brightness: 1.5, contrast: 1.25 } } },
            version: WEBGPU_USER_SETTINGS_VERSION
        }));
        testState.storage.set('preferredVideoPlayer', 'html');
        responses.push(
            respondJSON({ applied: { brightness: 3, preferredVideoPlayer: 3 }, settings: { brightness: 0.5 } }),
            respondJSON({ applied: { brightness: 3, preferredVideoPlayer: 3 }, settings: { brightness: 0.5 } }),
            respondJSON({ applied: { brightness: 4, preferredVideoPlayer: 3 }, settings: { brightness: 0.5 } })
        );
        const { clientDefaults, sync } = await importModules();
        const listener = vi.fn();
        clientDefaults.subscribeClientDefaults(listener);

        await sync.refreshClientDefaults();

        expect(readStoredSettings()).toEqual({
            playback: { enableCustomDecode: false },
            render: { settings: { display: { contrast: 1.25 } } },
            version: WEBGPU_USER_SETTINGS_VERSION
        });
        expect(testState.storage.get('preferredVideoPlayer')).toBe('');
        // A choice made after the apply stays the user's until the next apply
        testState.storage.set('preferredVideoPlayer', 'webgpu');
        testState.storage.set(SETTINGS_STORAGE_KEY, JSON.stringify({ render: { settings: { display: { brightness: 2 } } }, version: WEBGPU_USER_SETTINGS_VERSION }));
        await sync.refreshClientDefaults();
        expect(testState.storage.get('preferredVideoPlayer')).toBe('webgpu');
        expect(readStoredSettings()).toEqual({ render: { settings: { display: { brightness: 2 } } }, version: WEBGPU_USER_SETTINGS_VERSION });
        expect(listener).toHaveBeenCalledTimes(1);

        await sync.refreshClientDefaults();
        expect(readStoredSettings()).toEqual({ version: WEBGPU_USER_SETTINGS_VERSION });
        expect(testState.storage.get('preferredVideoPlayer')).toBe('webgpu');
        // The defaults did not change, but the user's settings did, so the page hears of it
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('drops no choice while no user is signed in', async () => {
        testState.userId = null;
        localStorage.setItem(CACHE_KEY, JSON.stringify({ applied: { hdrOutput: 1 }, settings: { hdrOutput: true } }));
        testState.storage.set(SETTINGS_STORAGE_KEY, JSON.stringify({ presentation: { hdrOutput: false }, version: WEBGPU_USER_SETTINGS_VERSION }));
        const { clientDefaults, sync } = await importModules();

        sync.startClientDefaultsSync();

        expect(clientDefaults.getClientDefaults()).toEqual({ hdrOutput: true });
        expect(readStoredSettings()).toEqual({ presentation: { hdrOutput: false }, version: WEBGPU_USER_SETTINGS_VERSION });
    });

    it('rejects a refused read or save with the server\'s code and detail, else the HTTP status, and keeps the defaults', async () => {
        responses.push(
            respondJSON({ code: 'client-defaults-invalid', detail: 'settings.brightness is null' }, BAD_REQUEST_STATUS),
            respondStatus(PAYLOAD_TOO_LARGE_STATUS),
            respondStatus(FORBIDDEN_STATUS),
            respondJSON({ applied: {}, settings: { contrast: 1.25 } })
        );
        const { clientDefaults, sync } = await importModules();

        await expect(sync.saveServerClientDefaults({ brightness: null })).rejects.toThrow('client-defaults-invalid: settings.brightness is null');
        await expect(sync.saveServerClientDefaults({ brightness: 0.5 })).rejects.toThrow(`http-${PAYLOAD_TOO_LARGE_STATUS}`);
        await expect(sync.fetchServerClientDefaults()).rejects.toThrow(`http-${FORBIDDEN_STATUS}`);
        expect(clientDefaults.getClientDefaults()).toEqual({});
        // A read for the editor only reads
        await expect(sync.fetchServerClientDefaults()).resolves.toEqual({ applied: {}, settings: { contrast: 1.25 } });
        expect(clientDefaults.getClientDefaults()).toEqual({});
        testState.userId = null;
        await expect(sync.fetchServerClientDefaults()).rejects.toThrow('server-unavailable: no signed-in server');
    });
});

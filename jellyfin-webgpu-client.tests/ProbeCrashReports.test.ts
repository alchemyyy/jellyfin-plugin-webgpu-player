import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import Events from 'utils/events';

import type { CrashedCapabilityProbe } from 'webgpu-player/capability/CapabilityProbeStore';

type ProbeCrashReportsModule = typeof import('addons/webGPUPlayer/ProbeCrashReports');

const CRASHES_URL = 'https://jellyfin.example/WebGPUPlayer/Diagnostics/ProbeCrashes';
const AUTHORIZATION = 'MediaBrowser Token="token-1"';
const USER_ID = 'user-1';
const INTERNAL_SERVER_ERROR_STATUS = 500;
const NO_CONTENT_STATUS = 204;
const ROUTE_MAXIMUM_CRASH_COUNT = 16;

const testState = vi.hoisted(() => ({
    // The listener the add-on gave the engine, which the engine calls with each finding
    crashListener: null as ((crashes: readonly CrashedCapabilityProbe[]) => void) | null,
    userId: 'user-1' as string | null,
    // Whether the API client writes Jellyfin Web's own authorization header, as the host's does; without it the report sends the token alone
    writesRequestHeaders: false
}));

// The page's server connections, with an API client signed in while the test names a user
vi.mock('lib/jellyfin-apiclient', () => {
    const apiClient = {
        accessToken: (): string => 'token-1',
        getCurrentUserId: (): string | null => testState.userId,
        getUrl: (name: string): string => `https://jellyfin.example/${name}`
    };
    const headerWritingApiClient = {
        ...apiClient,
        setRequestHeaders: (headers: Record<string, string>): void => {
            headers.Authorization = 'MediaBrowser Client="Jellyfin Web", Device="Safari", DeviceId="device-1", Version="10.11.0", Token="token-1"';
        }
    };
    return {
        ServerConnections: {
            currentApiClient: vi.fn(() => (testState.writesRequestHeaders ? headerWritingApiClient : apiClient))
        }
    };
});

vi.mock('webgpu-player/capability/CapabilityProbeStore', () => ({
    onCapabilityProbeCrash: vi.fn((listener: (crashes: readonly CrashedCapabilityProbe[]) => void): () => void => {
        testState.crashListener = listener;
        return (): void => {
            testState.crashListener = null;
        };
    })
}));

type Modules = Readonly<{
    reports: ProbeCrashReportsModule
    serverConnections: object
}>;

let fetchMock: Mock;

/** Loads the module anew, so each test starts without started reports or crashes waiting for a sign-in. */
async function importModules(): Promise<Modules> {
    vi.resetModules();
    testState.crashListener = null;
    const { ServerConnections } = await import('lib/jellyfin-apiclient');
    // The mocked connections outlive the reset; the host's events keep listeners on the object, so earlier tests' sign-in listeners are dropped
    Reflect.deleteProperty(ServerConnections, '_callbacks');
    const reports = await import('addons/webGPUPlayer/ProbeCrashReports');
    return { reports, serverConnections: ServerConnections };
}

function findCrashes(crashes: readonly CrashedCapabilityProbe[]): void {
    if (!testState.crashListener) {
        throw new Error('The add-on gave the engine no crash listener');
    }
    testState.crashListener(crashes);
}

function readPostedBody(callIndex = 0): unknown {
    const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
    return JSON.parse(init.body as string);
}

beforeEach(() => {
    testState.userId = USER_ID;
    testState.writesRequestHeaders = false;
    fetchMock = vi.fn((): Promise<Response> => Promise.resolve(new Response(null, { status: NO_CONTENT_STATUS })));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('probe crash reports', () => {
    it('posts a finding once with its crashes and the token alone, from an API client that writes no headers', async () => {
        const { reports } = await importModules();
        reports.startProbeCrashReports();
        reports.startProbeCrashReports();

        findCrashes([ { probe: 'native-audio', steps: [ 'decode aac' ] }, { probe: 'native-sdr:hevc', steps: [] } ]);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

        expect(fetchMock).toHaveBeenCalledWith(CRASHES_URL, {
            body: JSON.stringify({ crashes: [ { probe: 'native-audio', steps: [ 'decode aac' ] }, { probe: 'native-sdr:hevc', steps: [] } ] }),
            headers: { Authorization: AUTHORIZATION, 'Content-Type': 'application/json' },
            method: 'POST'
        });
        expect(console.warn).not.toHaveBeenCalled();
    });

    it('sends the authorization header Jellyfin Web sends, which names the client and device', async () => {
        testState.writesRequestHeaders = true;
        const { reports } = await importModules();
        reports.startProbeCrashReports();

        findCrashes([ { probe: 'native-audio', steps: [ 'decode aac' ] } ]);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

        expect(fetchMock).toHaveBeenCalledWith(CRASHES_URL, {
            body: JSON.stringify({ crashes: [ { probe: 'native-audio', steps: [ 'decode aac' ] } ] }),
            headers: {
                Authorization: 'MediaBrowser Client="Jellyfin Web", Device="Safari", DeviceId="device-1", Version="10.11.0", Token="token-1"',
                'Content-Type': 'application/json'
            },
            method: 'POST'
        });
    });

    it('holds a finding before sign-in and posts it with the next sign-in', async () => {
        testState.userId = null;
        const { reports, serverConnections } = await importModules();
        reports.startProbeCrashReports();

        findCrashes([ { probe: 'native-audio', steps: [ 'decode aac' ] } ]);
        findCrashes([ { probe: 'native-hdr:av1', steps: [ 'check av01.0.08M.10' ] } ]);
        Events.trigger(serverConnections, 'localusersignedin', [ { Id: USER_ID } ]);
        expect(fetchMock).not.toHaveBeenCalled();

        testState.userId = USER_ID;
        Events.trigger(serverConnections, 'localusersignedin', [ { Id: USER_ID } ]);
        Events.trigger(serverConnections, 'localusersignedin', [ { Id: USER_ID } ]);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

        expect(readPostedBody()).toEqual({
            crashes: [
                { probe: 'native-audio', steps: [ 'decode aac' ] },
                { probe: 'native-hdr:av1', steps: [ 'check av01.0.08M.10' ] }
            ]
        });
    });

    it('keeps only what the route accepts', async () => {
        const { reports } = await importModules();
        reports.startProbeCrashReports();
        const crashes = Array.from({ length: ROUTE_MAXIMUM_CRASH_COUNT + 2 }, (_value: unknown, index: number): CrashedCapabilityProbe => ({
            probe: `probe-${index}`,
            steps: index === 0 ?
                [ 'decode aac', 'x'.repeat(97), 'check \u00e9', ...Array.from({ length: 20 }, (_step: unknown, stepIndex: number): string => `step ${stepIndex}`) ] :
                []
        }));

        findCrashes([ { probe: 'p'.repeat(65), steps: [] }, ...crashes ]);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

        const body = readPostedBody() as { crashes: Array<{ probe: string, steps: string[] }> };
        expect(body.crashes.map(crash => crash.probe)).toEqual(crashes.slice(0, ROUTE_MAXIMUM_CRASH_COUNT).map(crash => crash.probe));
        expect(body.crashes[0].steps).toEqual([ 'decode aac', ...Array.from({ length: 15 }, (_step: unknown, stepIndex: number): string => `step ${stepIndex}`) ]);
    });

    it('warns once when a post fails, and neither throws nor tries again', async () => {
        const { reports, serverConnections } = await importModules();
        reports.startProbeCrashReports();
        fetchMock.mockImplementationOnce((): Promise<Response> => Promise.resolve(new Response(null, { status: INTERNAL_SERVER_ERROR_STATUS })));

        expect(() => findCrashes([ { probe: 'native-audio', steps: [ 'decode aac' ] } ])).not.toThrow();
        await vi.waitFor(() => expect(console.warn).toHaveBeenCalledOnce());
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 500'));

        fetchMock.mockImplementationOnce((): Promise<Response> => Promise.reject(new TypeError('Failed to fetch')));
        expect(() => findCrashes([ { probe: 'native-sdr:hevc', steps: [] } ])).not.toThrow();
        await vi.waitFor(() => expect(console.warn).toHaveBeenCalledTimes(2));
        expect(console.warn).toHaveBeenLastCalledWith(expect.stringContaining('Failed to fetch'));

        Events.trigger(serverConnections, 'localusersignedin', [ { Id: USER_ID } ]);
        await Promise.resolve();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

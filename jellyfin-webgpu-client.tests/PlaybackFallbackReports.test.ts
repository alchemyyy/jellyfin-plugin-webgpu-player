import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type * as PlaybackFallbackReports from 'addons/webGPUPlayer/PlaybackFallbackReports';

const FALLBACKS_URL = 'https://jellyfin.example/WebGPUPlayer/Diagnostics/PlaybackFallbacks';
const NO_CONTENT_STATUS = 204;
const ROUTE_MAXIMUM_REASON_LENGTH = 64;
const ROUTE_MAXIMUM_DETAIL_LENGTH = 256;

// The page's server connections, with an API client signed in
vi.mock('lib/jellyfin-apiclient', () => ({
    ServerConnections: {
        currentApiClient: vi.fn(() => ({
            accessToken: (): string => 'token-1',
            getCurrentUserId: (): string => 'user-1',
            getUrl: (name: string): string => `https://jellyfin.example/${name}`
        }))
    }
}));

let fetchMock: Mock;

/** Loads the module anew through a dynamic import, which a static one cannot, so each test starts without started reports or fallbacks it already sent. */
async function importReports(): Promise<typeof PlaybackFallbackReports> {
    vi.resetModules();
    const { ServerConnections } = await import('lib/jellyfin-apiclient');
    // The mocked connections outlive the reset; the host's events keep listeners on the object, so earlier tests' sign-in listeners are dropped
    Reflect.deleteProperty(ServerConnections, '_callbacks');
    return import('addons/webGPUPlayer/PlaybackFallbackReports');
}

function readPostedBodies(): unknown[] {
    return fetchMock.mock.calls.map((call: unknown[]): unknown => {
        // fetch's second argument, which every post passes
        const init = call[1] as RequestInit;
        return JSON.parse(init.body as string);
    });
}

beforeEach(() => {
    fetchMock = vi.fn((): Promise<Response> => Promise.resolve(new Response(null, { status: NO_CONTENT_STATUS })));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('playback fallback reports', () => {
    it('posts a fallback with its kind, reason, and detail', async () => {
        const reports = await importReports();
        reports.startPlaybackFallbackReports();
        reports.startPlaybackFallbackReports();

        reports.reportPlaybackFallback('presentation', 'adapter-unavailable', 'requestAdapter: null');
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

        expect(fetchMock).toHaveBeenCalledWith(FALLBACKS_URL, {
            body: JSON.stringify({ fallbacks: [ { detail: 'requestAdapter: null', kind: 'presentation', reason: 'adapter-unavailable' } ] }),
            headers: { Authorization: 'MediaBrowser Token="token-1"', 'Content-Type': 'application/json' },
            method: 'POST'
        });
    });

    it('sends each kind and reason once per page, whatever its detail', async () => {
        const reports = await importReports();
        reports.startPlaybackFallbackReports();

        reports.reportPlaybackFallback('presentation', 'adapter-unavailable', 'requestAdapter: null');
        reports.reportPlaybackFallback('presentation', 'adapter-unavailable', 'requestAdapter: timeout after 5000 ms');
        reports.reportPlaybackFallback('presentation', 'device-request-failed', 'requestDevice: timeout after 5000 ms');
        reports.reportPlaybackFallback('custom-playback-fallback', 'decode-failed', 'html-backend');
        reports.reportPlaybackFallback('custom-playback-declined', 'decode-failed', 'html-backend');
        reports.reportPlaybackFallback('custom-playback-fallback', 'decode-failed', 'source-renegotiation');
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
        await Promise.resolve();

        expect(readPostedBodies()).toEqual([
            { fallbacks: [ { detail: 'requestAdapter: null', kind: 'presentation', reason: 'adapter-unavailable' } ] },
            { fallbacks: [ { detail: 'requestDevice: timeout after 5000 ms', kind: 'presentation', reason: 'device-request-failed' } ] },
            { fallbacks: [ { detail: 'html-backend', kind: 'custom-playback-fallback', reason: 'decode-failed' } ] },
            { fallbacks: [ { detail: 'html-backend', kind: 'custom-playback-declined', reason: 'decode-failed' } ] }
        ]);
    });

    it('replaces the characters the route refuses and cuts each string to its limit', async () => {
        const reports = await importReports();
        reports.startPlaybackFallbackReports();

        reports.reportPlaybackFallback(
            'device-lost',
            `unknown\u00e9${'r'.repeat(ROUTE_MAXIMUM_REASON_LENGTH)}`,
            `D3D12 device removed\n[ERR] forged \u2014 ${'d'.repeat(ROUTE_MAXIMUM_DETAIL_LENGTH)}`
        );
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

        // Each refused character becomes one question mark, so the cut keeps the same count of the rest
        const detailPrefix = 'D3D12 device removed?[ERR] forged ? ';
        expect(readPostedBodies()).toEqual([ {
            fallbacks: [ {
                detail: detailPrefix + 'd'.repeat(ROUTE_MAXIMUM_DETAIL_LENGTH - detailPrefix.length),
                kind: 'device-lost',
                reason: `unknown?${'r'.repeat(ROUTE_MAXIMUM_REASON_LENGTH - 'unknown?'.length)}`
            } ]
        } ]);
    });

    it('reports nothing before it starts', async () => {
        const reports = await importReports();

        reports.reportPlaybackFallback('presentation', 'adapter-unavailable', 'requestAdapter: null');
        await Promise.resolve();

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('warns when a post fails, and never throws into the playback', async () => {
        const reports = await importReports();
        reports.startPlaybackFallbackReports();
        fetchMock.mockImplementationOnce((): Promise<Response> => Promise.reject(new TypeError('Failed to fetch')));

        expect(() => reports.reportPlaybackFallback('presentation', 'adapter-unavailable', 'requestAdapter: null')).not.toThrow();
        await vi.waitFor(() => expect(console.warn).toHaveBeenCalledOnce());

        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch'));
    });
});

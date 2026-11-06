import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { PLAYBACK_SUPERSEDED } from 'addons/webGPUPlayer/constants/playbackResult';

type Deferred = {
    promise: Promise<unknown>
    reject: (reason?: unknown) => void
    resolve: (value?: unknown) => void
};

/** The head reads of one player, as the stand-in for DirectPlayHeadPrefetches records them */
type FakeHeadPrefetches = {
    cancelCount: number
    claims: unknown[]
    releases: unknown[]
    starts: { predict: () => unknown, ready: Promise<void> }[]
};

const testState = vi.hoisted(() => {
    const stopActiveEncodings = vi.fn((): Promise<void> => Promise.resolve());
    const apiClient = { stopActiveEncodings };
    return {
        apiClient,
        claimedRead: { name: 'claimed read' },
        clientDefaultsSettled: Promise.resolve(),
        customDecodeEnabled: vi.fn((): boolean => true),
        ensureInterceptors: vi.fn((): boolean => true),
        getApiClient: vi.fn((): unknown => apiClient),
        headPrefetches: [] as FakeHeadPrefetches[],
        markNegotiation: vi.fn((profile: unknown): unknown => ({ ...(profile as object), marked: true })),
        prediction: { eTag: null, itemId: 'item', mediaSourceId: 'source', url: 'https://jellyfin.example/Videos/item/stream.mkv' },
        predictDirectPlayStream: vi.fn<(...predictArguments: unknown[]) => unknown>(() => null),
        preferredVideoPlayer: vi.fn((): string => 'auto'),
        runtimeAvailability: vi.fn((): { available: boolean } => ({ available: true })),
        stopActiveEncodings
    };
});

vi.mock('lib/jellyfin-apiclient', () => ({
    ServerConnections: {
        getApiClient: testState.getApiClient
    }
}));
vi.mock('addons/webGPUPlayer/shims/userSettings', () => ({
    preferredVideoPlayer: testState.preferredVideoPlayer
}));
vi.mock('addons/webGPUPlayer/compat/PlaybackInfoInterceptor', () => ({
    ensurePlaybackInfoInterceptors: testState.ensureInterceptors,
    markPlaybackInfoNegotiation: testState.markNegotiation
}));
vi.mock('addons/webGPUPlayer/ServerClientDefaults', () => ({
    whenClientDefaultsSettled: (): Promise<void> => testState.clientDefaultsSettled
}));
vi.mock('addons/webGPUPlayer/WebGPUPlaybackPreferences', () => ({
    isStoredWebGPUCustomDecodeEnabled: testState.customDecodeEnabled
}));
vi.mock('webgpu-player/capability/CustomPlaybackRuntime', () => ({
    getCustomPlaybackRuntimeAvailability: testState.runtimeAvailability
}));
// The head reads are covered by their own suite; this stand-in records what the player asks of them
vi.mock('addons/webGPUPlayer/DirectPlayHeadPrefetch', () => {
    class FakeDirectPlayHeadPrefetches implements FakeHeadPrefetches {
        cancelCount = 0;
        claims: unknown[] = [];
        releases: unknown[] = [];
        starts: { predict: () => unknown, ready: Promise<void> }[] = [];

        constructor() {
            testState.headPrefetches.push(this);
        }

        start(ready: Promise<void>, predict: () => unknown): void {
            this.starts.push({ predict, ready });
        }

        claim(options: unknown): unknown {
            this.claims.push(options);
            return testState.claimedRead;
        }

        release(prefetch: unknown): void {
            this.releases.push(prefetch);
        }

        cancel(): void {
            this.cancelCount += 1;
        }
    }
    return {
        DirectPlayHeadPrefetches: FakeDirectPlayHeadPrefetches,
        predictDirectPlayStream: testState.predictDirectPlayStream
    };
});
// The fork player is covered by its own suite; this stand-in exposes the members the subclass builds on
vi.mock('addons/webGPUPlayer/WebGPUPlayer', () => {
    class FakeWebGPUPlayer {
        name = 'WebGPU Player';
        id = 'webgpuplayer';
        priority = 0;
        pendingPlay = false;
        cancelPendingPlayCount = 0;
        playResult: Promise<unknown> = Promise.resolve(undefined);
        canPlayItemResult = true;
        baseStop = vi.fn<(destroyPlayer: boolean) => Promise<void>>(() => Promise.resolve());
        baseDestroy = vi.fn();

        getMaxStreamingBitrate(bitrateRequest?: { fallbackBitrate?: number | null, purpose?: string }): number | null {
            return bitrateRequest?.purpose === 'transcode-output' ? bitrateRequest.fallbackBitrate ?? null : null;
        }

        canPlayItem(): boolean {
            return this.canPlayItemResult;
        }

        getDeviceProfile(): Promise<unknown> {
            return Promise.resolve({ Name: 'profile' });
        }

        play(): Promise<unknown> {
            return this.playResult;
        }

        stop(destroyPlayer: boolean): Promise<unknown> {
            return this.baseStop(destroyPlayer);
        }

        destroy(): void {
            this.baseDestroy();
        }

        hasPendingPlay(): boolean {
            return this.pendingPlay;
        }

        cancelPendingPlay(): void {
            this.cancelPendingPlayCount += 1;
            this.pendingPlay = false;
        }
    }
    return { default: FakeWebGPUPlayer };
});

import HostCompatibleWebGPUPlayer from 'addons/webGPUPlayer/HostCompatibleWebGPUPlayer';

type FakeBase = {
    baseDestroy: Mock
    baseStop: Mock
    canPlayItemResult: boolean
    cancelPendingPlayCount: number
    pendingPlay: boolean
    playResult: Promise<unknown>
};

const STREAM_INFO = {
    item: { ServerId: 'server' },
    playSessionId: 'session'
};

function createDeferred(): Deferred {
    let resolve: (value?: unknown) => void = () => undefined;
    let reject: (reason?: unknown) => void = () => undefined;
    const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, reject, resolve };
}

/** Resolves true once the promise settles, or false if it is still pending after a macrotask. */
async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
    const pending = Symbol('pending');
    const outcome = await Promise.race([
        promise.then(() => true, () => true),
        new Promise<symbol>(resolve => {
            setTimeout(() => resolve(pending), 0);
        })
    ]);
    return outcome !== pending;
}

function createPlayer(): HostCompatibleWebGPUPlayer & FakeBase {
    return new HostCompatibleWebGPUPlayer() as HostCompatibleWebGPUPlayer & FakeBase;
}

/** Returns the head reads of the player created last. */
function getHeadPrefetches(): FakeHeadPrefetches {
    const headPrefetches = testState.headPrefetches.at(-1);
    if (!headPrefetches) {
        throw new Error('no player created');
    }
    return headPrefetches;
}

const ITEM = { Id: 'item', MediaType: 'Video', ServerId: 'server' };

describe('HostCompatibleWebGPUPlayer', () => {
    beforeEach(() => {
        testState.ensureInterceptors.mockReturnValue(true);
        testState.preferredVideoPlayer.mockReturnValue('auto');
        testState.predictDirectPlayStream.mockReturnValue(testState.prediction);
        testState.headPrefetches.length = 0;
    });

    afterEach(() => {
        delete (window as { NativeShell?: unknown }).NativeShell;
    });

    describe('getMaxStreamingBitrate', () => {
        it('returns the cap PlaybackManager stored when asked without a purpose', () => {
            const player = createPlayer();
            player.maxStreamingBitrate = 12_000_000;

            expect(player.getMaxStreamingBitrate()).toBe(12_000_000);
        });

        it('returns null without a usable stored cap', () => {
            const player = createPlayer();
            expect(player.getMaxStreamingBitrate()).toBeNull();
            player.maxStreamingBitrate = 0;
            expect(player.getMaxStreamingBitrate()).toBeNull();
            player.maxStreamingBitrate = Number.NaN;
            expect(player.getMaxStreamingBitrate()).toBeNull();
        });

        it('keeps the fork semantics for purpose requests', () => {
            const player = createPlayer();
            player.maxStreamingBitrate = 12_000_000;

            expect(player.getMaxStreamingBitrate({ fallbackBitrate: 8_000_000, purpose: 'playback-selection' })).toBeNull();
            expect(player.getMaxStreamingBitrate({ fallbackBitrate: 8_000_000, purpose: 'transcode-output' })).toBe(8_000_000);
        });
    });

    describe('canPlayItem', () => {
        it('declines when the user prefers the HTML player', () => {
            testState.preferredVideoPlayer.mockReturnValue('html');

            expect(createPlayer().canPlayItem({ Id: 'item' })).toBe(false);
        });

        it('declines inside native app shells', () => {
            (window as { NativeShell?: unknown }).NativeShell = {};

            expect(createPlayer().canPlayItem({ Id: 'item' })).toBe(false);
        });

        it('otherwise defers to the fork player', () => {
            const player = createPlayer();
            expect(player.canPlayItem({ Id: 'item' })).toBe(true);
            player.canPlayItemResult = false;
            expect(player.canPlayItem({ Id: 'item' })).toBe(false);
            testState.preferredVideoPlayer.mockReturnValue('webgpu');
            player.canPlayItemResult = true;
            expect(player.canPlayItem({ Id: 'item' })).toBe(true);
        });
    });

    describe('getDeviceProfile', () => {
        it('marks the profile for the PlaybackInfo interceptor', async () => {
            const player = createPlayer();
            const item = { Id: 'item', ServerId: 'server' };
            const options = { isRetry: false };

            await expect(player.getDeviceProfile(item, options)).resolves.toEqual({ Name: 'profile', marked: true });
            expect(testState.ensureInterceptors).toHaveBeenCalledWith('server');
            expect(testState.markNegotiation).toHaveBeenCalledWith({ Name: 'profile' }, player, item, options);
        });

        it('returns the fork profile unmarked when interceptors are unavailable', async () => {
            testState.ensureInterceptors.mockReturnValue(false);

            await expect(createPlayer().getDeviceProfile({ Id: 'item' })).resolves.toEqual({ Name: 'profile' });
        });
    });

    describe('play', () => {
        it('passes a completed start through', async () => {
            const player = createPlayer();
            player.playResult = Promise.resolve('started');

            await expect(player.play(STREAM_INFO)).resolves.toBe('started');
            expect(testState.stopActiveEncodings).not.toHaveBeenCalled();
        });

        it('never settles a superseded start and stops its encodings', async () => {
            const player = createPlayer();
            player.playResult = Promise.resolve(PLAYBACK_SUPERSEDED);

            await expect(hasSettled(player.play(STREAM_INFO))).resolves.toBe(false);
            expect(testState.stopActiveEncodings).toHaveBeenCalledWith('session');
        });

        it('treats a start that completes after a stop as superseded', async () => {
            const player = createPlayer();
            const startup = createDeferred();
            player.playResult = startup.promise;

            const playPromise = player.play(STREAM_INFO);
            void player.stop(true);
            startup.resolve(undefined);

            await expect(hasSettled(playPromise)).resolves.toBe(false);
            expect(testState.stopActiveEncodings).toHaveBeenCalledWith('session');
        });

        it('swallows the failure of a start a newer request superseded', async () => {
            const player = createPlayer();
            const startup = createDeferred();
            player.playResult = startup.promise;

            const playPromise = player.play(STREAM_INFO);
            player.cancelPendingPlayForNewRequest();
            startup.reject(new Error('aborted'));

            await expect(hasSettled(playPromise)).resolves.toBe(false);
        });

        it('rejects a current start that fails', async () => {
            const player = createPlayer();
            player.playResult = Promise.reject(new Error('failed'));

            await expect(player.play(STREAM_INFO)).rejects.toThrow('failed');
        });

        it('does not stop encodings without a play session', async () => {
            const player = createPlayer();
            player.playResult = Promise.resolve(PLAYBACK_SUPERSEDED);

            await expect(hasSettled(player.play({ item: { ServerId: 'server' } }))).resolves.toBe(false);
            expect(testState.stopActiveEncodings).not.toHaveBeenCalled();
        });
    });

    describe('stop', () => {
        it('clears the stream change flag PlaybackManager would otherwise leave set', async () => {
            const player = createPlayer();
            player.isChangingStream = true;

            await player.stop(true);

            expect(player.isChangingStream).toBe(false);
            expect(player.baseStop).toHaveBeenCalledWith(true);
        });
    });

    describe('cancelPendingPlayForNewRequest', () => {
        it('cancels and reports whether a start was pending', () => {
            const player = createPlayer();
            player.pendingPlay = true;

            expect(player.cancelPendingPlayForNewRequest()).toBe(true);
            expect(player.cancelPendingPlayForNewRequest()).toBe(false);
            expect(player.cancelPendingPlayCount).toBe(2);
        });
    });

    describe('isRequestStartPending', () => {
        it('reports a request that has yet to start, or is still starting, as pending', () => {
            const player = createPlayer();
            player.playResult = createDeferred().promise;

            player.cancelPendingPlayForNewRequest();
            expect(player.isRequestStartPending()).toBe(true);

            void player.play(STREAM_INFO);
            player.pendingPlay = true;
            expect(player.isRequestStartPending()).toBe(true);
        });

        it('stops reporting a request once its start is no longer pending', () => {
            const player = createPlayer();
            player.playResult = createDeferred().promise;
            player.cancelPendingPlayForNewRequest();
            void player.play(STREAM_INFO);

            // The start completed, or a stream change, stop, or destroy superseded it without a new request
            player.pendingPlay = false;
            expect(player.isRequestStartPending()).toBe(false);

            player.cancelPendingPlayForNewRequest();
            expect(player.isRequestStartPending()).toBe(true);
        });
    });

    describe('head reads', () => {
        it('begin at the request\'s first negotiation for playback, before PlaybackInfo reaches the player', async () => {
            const player = createPlayer();
            const headPrefetches = getHeadPrefetches();
            player.beginPlaybackRequest('source');

            await player.getDeviceProfile(ITEM);

            // PlaybackManager hands the player the PlaybackInfo response only through play(), which has not run
            expect(headPrefetches.claims).toHaveLength(0);
            expect(headPrefetches.starts).toHaveLength(1);
            expect(headPrefetches.starts[0].ready).toBe(testState.clientDefaultsSettled);
            expect(testState.predictDirectPlayStream).not.toHaveBeenCalled();

            expect(headPrefetches.starts[0].predict()).toBe(testState.prediction);
            expect(testState.getApiClient).toHaveBeenCalledWith('server');
            expect(testState.predictDirectPlayStream).toHaveBeenCalledWith(ITEM, 'source', testState.apiClient);
        });

        it('are claimed by the start and released once it settles', async () => {
            const player = createPlayer();
            const headPrefetches = getHeadPrefetches();
            const startup = createDeferred();
            player.playResult = startup.promise;
            player.beginPlaybackRequest(null);
            await player.getDeviceProfile(ITEM);

            const playPromise = player.play(STREAM_INFO);
            expect(headPrefetches.claims).toEqual([ STREAM_INFO ]);
            await expect(hasSettled(playPromise)).resolves.toBe(false);
            expect(headPrefetches.releases).toHaveLength(0);

            startup.resolve('started');
            await expect(playPromise).resolves.toBe('started');
            expect(headPrefetches.releases).toEqual([ testState.claimedRead ]);
        });

        it('are released once a start fails', async () => {
            const player = createPlayer();
            const headPrefetches = getHeadPrefetches();
            player.playResult = Promise.reject(new Error('failed'));

            await expect(player.play(STREAM_INFO)).rejects.toThrow('failed');
            expect(headPrefetches.releases).toEqual([ testState.claimedRead ]);
        });

        it('do not begin without a playback request', async () => {
            const player = createPlayer();

            await player.getDeviceProfile(ITEM);

            expect(getHeadPrefetches().starts).toHaveLength(0);
        });

        it('do not begin for a stream change or retry', async () => {
            const player = createPlayer();
            player.beginPlaybackRequest(null);

            await player.getDeviceProfile(ITEM, { isRetry: false });
            await player.getDeviceProfile(ITEM, { isRetry: true });

            expect(getHeadPrefetches().starts).toHaveLength(0);
        });

        it('begin only at a request\'s first negotiation', async () => {
            const player = createPlayer();
            player.beginPlaybackRequest(null);

            await player.getDeviceProfile(ITEM);
            await player.getDeviceProfile({ ...ITEM, Id: 'next' });

            expect(getHeadPrefetches().starts).toHaveLength(1);
        });

        it('do not begin once the request started', async () => {
            const player = createPlayer();
            player.beginPlaybackRequest(null);

            void player.play(STREAM_INFO);
            await player.getDeviceProfile(ITEM);

            expect(getHeadPrefetches().starts).toHaveLength(0);
        });

        it.each([
            [ 'the user prefers the HTML player', (): void => {
                testState.preferredVideoPlayer.mockReturnValue('html');
            } ],
            [ 'a native app shell hosts the page', (): void => {
                (window as { NativeShell?: unknown }).NativeShell = {};
            } ],
            [ 'custom decode is off', (): void => {
                testState.customDecodeEnabled.mockReturnValue(false);
            } ],
            [ 'the custom playback runtime is unavailable', (): void => {
                testState.runtimeAvailability.mockReturnValue({ available: false });
            } ],
            [ 'the server has no API client', (): void => {
                testState.getApiClient.mockReturnValue(undefined);
            } ]
        ])('predict nothing when %s', async (_description, arrange) => {
            const player = createPlayer();
            player.beginPlaybackRequest(null);
            await player.getDeviceProfile(ITEM);

            arrange();

            expect(getHeadPrefetches().starts[0].predict()).toBeNull();
            expect(testState.predictDirectPlayStream).not.toHaveBeenCalled();
        });

        it('predict nothing for an item the fork player declines or one without a server', async () => {
            const player = createPlayer();
            const headPrefetches = getHeadPrefetches();
            player.beginPlaybackRequest(null);
            await player.getDeviceProfile({ Id: 'item', MediaType: 'Video' });
            player.beginPlaybackRequest(null);
            await player.getDeviceProfile(ITEM);

            expect(headPrefetches.starts[0].predict()).toBeNull();
            player.canPlayItemResult = false;
            expect(headPrefetches.starts[1].predict()).toBeNull();
            expect(testState.predictDirectPlayStream).not.toHaveBeenCalled();
        });

        it('are canceled by a stop, which keeps the request for its negotiation', async () => {
            const player = createPlayer();
            const headPrefetches = getHeadPrefetches();
            player.beginPlaybackRequest(null);

            await player.stop(false);
            expect(headPrefetches.cancelCount).toBe(1);

            await player.getDeviceProfile(ITEM);
            expect(headPrefetches.starts).toHaveLength(1);
        });

        it.each([
            [ 'a new request', (player: HostCompatibleWebGPUPlayer): void => {
                player.cancelPendingPlayForNewRequest();
            } ],
            [ 'a destroyed player', (player: HostCompatibleWebGPUPlayer): void => {
                player.destroy();
            } ]
        ])('are canceled by %s, which ends the request', async (_description, end) => {
            const player = createPlayer();
            const headPrefetches = getHeadPrefetches();
            player.beginPlaybackRequest(null);

            end(player);
            expect(headPrefetches.cancelCount).toBe(1);

            await player.getDeviceProfile(ITEM);
            expect(headPrefetches.starts).toHaveLength(0);
        });

        it('end only with the request that began them', async () => {
            const player = createPlayer();
            const headPrefetches = getHeadPrefetches();
            const endFirstRequest = player.beginPlaybackRequest('first');
            const endSecondRequest = player.beginPlaybackRequest('second');

            endFirstRequest();
            await player.getDeviceProfile(ITEM);
            expect(headPrefetches.starts).toHaveLength(1);
            headPrefetches.starts[0].predict();
            expect(testState.predictDirectPlayStream).toHaveBeenCalledWith(ITEM, 'second', testState.apiClient);

            player.beginPlaybackRequest(null);
            const endThirdRequest = player.beginPlaybackRequest('third');
            endSecondRequest();
            endThirdRequest();
            await player.getDeviceProfile(ITEM);
            expect(headPrefetches.starts).toHaveLength(1);
        });
    });
});

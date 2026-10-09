import { describe, expect, it, vi } from 'vitest';

import {
    getPlayRequestIdentity,
    installPlaybackManagerHooks,
    SUPERSEDING_PLAYBACK_MANAGER_METHODS
} from 'addons/webGPUPlayer/compat/PlaybackManagerHooks';

type CallRecord = {
    methodArguments: unknown[]
    receiver: unknown
};

type HookCallbacks = Parameters<typeof installPlaybackManagerHooks>[1];

type Deferred = {
    promise: Promise<unknown>
    reject: (reason?: unknown) => void
    resolve: (value?: unknown) => void
};

/** A PlaybackManager stand-in with instance methods and a prototype stop(), like the stock one. */
class FakePlaybackManager {
    readonly calls = new Map<string, CallRecord[]>();
    readonly order: string[] = [];

    play = this.createMethod('play');
    nextTrack = this.createMethod('nextTrack');
    previousTrack = this.createMethod('previousTrack');
    setCurrentPlaylistItem = this.createMethod('setCurrentPlaylistItem');

    stop(...methodArguments: unknown[]): string {
        this.record('stop', this, methodArguments);
        return 'stop-result';
    }

    private createMethod(methodName: string): (...methodArguments: unknown[]) => string {
        const recordCall = this.record.bind(this);
        return function (this: unknown, ...methodArguments: unknown[]): string {
            recordCall(methodName, this, methodArguments);
            return `${methodName}-result`;
        };
    }

    private record(methodName: string, receiver: unknown, methodArguments: unknown[]): void {
        this.order.push(methodName);
        const calls = this.calls.get(methodName) ?? [];
        calls.push({ methodArguments, receiver });
        this.calls.set(methodName, calls);
    }
}

type CallableManager = Record<string, (...methodArguments: unknown[]) => unknown>;

/** A PlaybackManager stand-in whose play() settles only when a test settles its start, like the stock async play(). */
type AsyncPlaybackManager = {
    play: (options?: unknown) => Promise<unknown>
    stop: () => Promise<void>
    // One start per play() the hooks forwarded
    readonly playStarts: Deferred[]
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

function createAsyncPlaybackManager(): AsyncPlaybackManager {
    const playStarts: Deferred[] = [];
    return {
        playStarts,
        play: (): Promise<unknown> => {
            const playStart = createDeferred();
            playStarts.push(playStart);
            return playStart.promise;
        },
        stop: (): Promise<void> => Promise.resolve()
    };
}

/** Returns callbacks for a host where no start was pending and the latest request is still starting. */
function createCallbacks(overrides: Partial<HookCallbacks> = {}): HookCallbacks {
    return {
        cancelPendingPlays: vi.fn((): boolean => false),
        hideLoading: vi.fn(),
        isRequestStartPending: vi.fn((): boolean => true),
        ...overrides
    };
}

/** A home card's Resume request, as Jellyfin Web's shortcuts send it. */
function createResumeRequest(): Record<string, unknown> {
    return {
        ids: [ 'item' ],
        startPositionTicks: 36_000_000_000,
        serverId: 'server',
        queryOptions: { SortBy: 'SortName', SortOrder: 'Ascending' }
    };
}

describe('installPlaybackManagerHooks', () => {
    it('cancels pending WebGPU starts before every superseding request', () => {
        const playbackManager = new FakePlaybackManager();
        const cancelPendingPlays = vi.fn((): boolean => {
            playbackManager.order.push('cancel');
            return false;
        });
        const hideLoading = vi.fn();

        expect(installPlaybackManagerHooks(playbackManager, createCallbacks({ cancelPendingPlays, hideLoading }))).toBe(true);
        for (const methodName of SUPERSEDING_PLAYBACK_MANAGER_METHODS) {
            (playbackManager as unknown as CallableManager)[methodName]('argument', 2);
        }

        expect(playbackManager.order).toEqual([
            'cancel', 'play',
            'cancel', 'nextTrack',
            'cancel', 'previousTrack',
            'cancel', 'setCurrentPlaylistItem',
            'cancel', 'stop'
        ]);
        expect(hideLoading).not.toHaveBeenCalled();
    });

    it('preserves the receiver, arguments, and return values', () => {
        const playbackManager = new FakePlaybackManager();
        installPlaybackManagerHooks(playbackManager, createCallbacks());

        expect(playbackManager.play({ ids: [ 'item' ] }, 'extra')).toBe('play-result');
        expect(playbackManager.stop('player')).toBe('stop-result');

        expect(playbackManager.calls.get('play')).toEqual([
            { methodArguments: [ { ids: [ 'item' ] }, 'extra' ], receiver: playbackManager }
        ]);
        expect(playbackManager.calls.get('stop')).toEqual([
            { methodArguments: [ 'player' ], receiver: playbackManager }
        ]);
    });

    it('hides the loading indicator only when a pending start was cancelled', () => {
        const playbackManager = new FakePlaybackManager();
        const cancelPendingPlays = vi.fn()
            .mockReturnValueOnce(true)
            .mockReturnValueOnce(false);
        const hideLoading = vi.fn();
        installPlaybackManagerHooks(playbackManager, createCallbacks({ cancelPendingPlays, hideLoading }));

        playbackManager.stop();
        playbackManager.nextTrack();

        expect(hideLoading).toHaveBeenCalledTimes(1);
    });

    it('installs once per PlaybackManager', () => {
        const playbackManager = new FakePlaybackManager();
        const cancelPendingPlays = vi.fn((): boolean => false);
        installPlaybackManagerHooks(playbackManager, createCallbacks({ cancelPendingPlays }));

        expect(installPlaybackManagerHooks(playbackManager, createCallbacks({ cancelPendingPlays }))).toBe(false);
        playbackManager.play();

        expect(cancelPendingPlays).toHaveBeenCalledTimes(1);
        expect(playbackManager.calls.get('play')).toHaveLength(1);
    });

    it('still runs the request when cancellation throws', () => {
        const playbackManager = new FakePlaybackManager();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        installPlaybackManagerHooks(playbackManager, createCallbacks({
            cancelPendingPlays: () => {
                throw new Error('cancel failed');
            }
        }));

        expect(playbackManager.play()).toBe('play-result');
    });

    it('skips methods a host does not define', () => {
        const playbackManager: Record<string, unknown> = { play: vi.fn(() => 'played') };

        installPlaybackManagerHooks(playbackManager, createCallbacks());

        expect(Object.keys(playbackManager)).toEqual([ 'play' ]);
        expect((playbackManager.play as () => unknown)()).toBe('played');
    });

    describe('identical play requests', () => {
        it('join the pending start instead of cancelling and repeating it', async () => {
            vi.spyOn(console, 'debug').mockImplementation(() => undefined);
            const playbackManager = createAsyncPlaybackManager();
            const callbacks = createCallbacks();
            installPlaybackManagerHooks(playbackManager, callbacks);

            const firstRequest = playbackManager.play(createResumeRequest());
            const secondRequest = playbackManager.play(createResumeRequest());

            expect(secondRequest).toBe(firstRequest);
            expect(playbackManager.playStarts).toHaveLength(1);
            expect(callbacks.cancelPendingPlays).toHaveBeenCalledTimes(1);
            expect(callbacks.hideLoading).not.toHaveBeenCalled();

            playbackManager.playStarts[0].resolve('started');
            await expect(secondRequest).resolves.toBe('started');
        });

        it('ask the players whether the start is pending only when one is identical', () => {
            vi.spyOn(console, 'debug').mockImplementation(() => undefined);
            const playbackManager = createAsyncPlaybackManager();
            const isRequestStartPending = vi.fn((): boolean => true);
            installPlaybackManagerHooks(playbackManager, createCallbacks({ isRequestStartPending }));

            const firstRequest = playbackManager.play(createResumeRequest());
            expect(isRequestStartPending).not.toHaveBeenCalled();
            expect(playbackManager.play(createResumeRequest())).toBe(firstRequest);
            expect(isRequestStartPending).toHaveBeenCalledTimes(1);
            void playbackManager.play({ ...createResumeRequest(), startPositionTicks: 0 });

            expect(isRequestStartPending).toHaveBeenCalledTimes(1);
            expect(playbackManager.playStarts).toHaveLength(2);
        });

        it('match passed items by ID and server, ignoring the rest of each item', () => {
            vi.spyOn(console, 'debug').mockImplementation(() => undefined);
            const playbackManager = createAsyncPlaybackManager();
            installPlaybackManagerHooks(playbackManager, createCallbacks());

            const firstRequest = playbackManager.play({
                items: [ { Id: 'item', ServerId: 'server', Name: 'Movie' } ],
                startPositionTicks: 10
            });
            const secondRequest = playbackManager.play({
                items: [ { Id: 'item', ServerId: 'server', UserData: { PlaybackPositionTicks: 10 } } ],
                startPositionTicks: 10
            });

            expect(secondRequest).toBe(firstRequest);
            expect(playbackManager.playStarts).toHaveLength(1);
        });

        it('share the failure of the pending request, then run again', async () => {
            vi.spyOn(console, 'debug').mockImplementation(() => undefined);
            const playbackManager = createAsyncPlaybackManager();
            installPlaybackManagerHooks(playbackManager, createCallbacks());

            const firstRequest = playbackManager.play(createResumeRequest());
            const joinedRequest = playbackManager.play(createResumeRequest());
            playbackManager.playStarts[0].reject(new Error('serverId required!'));

            await expect(joinedRequest).rejects.toThrow('serverId required!');
            await expect(firstRequest).rejects.toThrow('serverId required!');
            void playbackManager.play(createResumeRequest());
            expect(playbackManager.playStarts).toHaveLength(2);
        });

        it('run again once the pending request has started playback', async () => {
            const playbackManager = createAsyncPlaybackManager();
            const callbacks = createCallbacks();
            installPlaybackManagerHooks(playbackManager, callbacks);

            const firstRequest = playbackManager.play(createResumeRequest());
            playbackManager.playStarts[0].resolve(undefined);
            await firstRequest;
            const secondRequest = playbackManager.play(createResumeRequest());

            expect(secondRequest).not.toBe(firstRequest);
            expect(playbackManager.playStarts).toHaveLength(2);
            expect(callbacks.cancelPendingPlays).toHaveBeenCalledTimes(2);
        });

        it('run again once the player no longer has the start pending', () => {
            const playbackManager = createAsyncPlaybackManager();
            const isRequestStartPending = vi.fn((): boolean => true);
            const callbacks = createCallbacks({ isRequestStartPending });
            installPlaybackManagerHooks(playbackManager, callbacks);

            const firstRequest = playbackManager.play(createResumeRequest());
            // A stream change, stop, or destroy superseded the start, so PlaybackManager's promise never settles
            isRequestStartPending.mockReturnValue(false);
            const secondRequest = playbackManager.play(createResumeRequest());

            expect(secondRequest).not.toBe(firstRequest);
            expect(playbackManager.playStarts).toHaveLength(2);
            expect(callbacks.cancelPendingPlays).toHaveBeenCalledTimes(2);
        });

        it('run again when the pending-start check throws', () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            const playbackManager = createAsyncPlaybackManager();
            installPlaybackManagerHooks(playbackManager, createCallbacks({
                isRequestStartPending: () => {
                    throw new Error('check failed');
                }
            }));

            void playbackManager.play(createResumeRequest());
            void playbackManager.play(createResumeRequest());

            expect(playbackManager.playStarts).toHaveLength(2);
            expect(warn).toHaveBeenCalledTimes(1);
        });

        it.each([
            [ 'a stop', (playbackManager: AsyncPlaybackManager): Promise<unknown> => playbackManager.stop(), 2 ],
            [ 'another play request', (playbackManager: AsyncPlaybackManager): Promise<unknown> => playbackManager.play({ ids: [ 'other' ], serverId: 'server' }), 3 ]
        ])('run again after %s superseded the pending one', (_description, supersede, expectedStartCount) => {
            const playbackManager = createAsyncPlaybackManager();
            const callbacks = createCallbacks();
            installPlaybackManagerHooks(playbackManager, callbacks);

            const firstRequest = playbackManager.play(createResumeRequest());
            void supersede(playbackManager);
            const thirdRequest = playbackManager.play(createResumeRequest());

            expect(thirdRequest).not.toBe(firstRequest);
            expect(playbackManager.playStarts).toHaveLength(expectedStartCount);
            expect(callbacks.cancelPendingPlays).toHaveBeenCalledTimes(3);
        });
    });

    describe('differing play requests', () => {
        it.each([
            [ 'other items', {}, { ids: [ 'other' ] } ],
            [ 'the same items in another order', { ids: [ 'item', 'next' ] }, { ids: [ 'next', 'item' ] } ],
            [ 'another start position', {}, { startPositionTicks: 0 } ],
            [ 'another server', {}, { serverId: 'other-server' } ],
            [ 'another media source', {}, { mediaSourceId: 'version' } ],
            [ 'another audio stream', {}, { audioStreamIndex: 2 } ],
            [ 'another subtitle stream', {}, { subtitleStreamIndex: -1 } ],
            [ 'another start index', {}, { startIndex: 1 } ],
            [ 'shuffle', {}, { shuffle: true } ],
            [ 'other query options', {}, { queryOptions: { SortBy: 'DateCreated' } } ],
            [ 'windowed playback', {}, { fullscreen: false } ],
            [ 'passed items instead of IDs', {}, { ids: undefined, items: [ { Id: 'item', ServerId: 'server' } ] } ]
        ])('supersede the pending start for %s', (_description, firstChanges, secondChanges) => {
            const playbackManager = createAsyncPlaybackManager();
            const callbacks = createCallbacks({ cancelPendingPlays: vi.fn((): boolean => true) });
            installPlaybackManagerHooks(playbackManager, callbacks);

            const firstRequest = playbackManager.play({ ...createResumeRequest(), ...firstChanges });
            const secondRequest = playbackManager.play({ ...createResumeRequest(), ...firstChanges, ...secondChanges });

            expect(secondRequest).not.toBe(firstRequest);
            expect(playbackManager.playStarts).toHaveLength(2);
            expect(callbacks.cancelPendingPlays).toHaveBeenCalledTimes(2);
            expect(callbacks.hideLoading).toHaveBeenCalledTimes(2);
        });
    });

    describe('play requests without an identity', () => {
        const cyclicQueryOptions: Record<string, unknown> = {};
        cyclicQueryOptions.self = cyclicQueryOptions;

        it.each([
            [ 'no options', undefined ],
            [ 'neither IDs nor items', { serverId: 'server' } ],
            [ 'an empty ID list', { ids: [], serverId: 'server' } ],
            [ 'an ID that is not a string', { ids: [ 7 ], serverId: 'server' } ],
            [ 'an item without an ID', { items: [ { Name: 'Trailer', Url: 'https://example.com/trailer.mp4' } ] } ],
            [ 'query options that cannot serialize', { ids: [ 'item' ], serverId: 'server', queryOptions: cyclicQueryOptions } ]
        ])('run every time for %s', (_description, options) => {
            const playbackManager = createAsyncPlaybackManager();
            const callbacks = createCallbacks();
            installPlaybackManagerHooks(playbackManager, callbacks);

            expect(getPlayRequestIdentity(options)).toBeNull();
            void playbackManager.play(options);
            void playbackManager.play(options);

            expect(playbackManager.playStarts).toHaveLength(2);
            expect(callbacks.cancelPendingPlays).toHaveBeenCalledTimes(2);
        });
    });
});

describe('getPlayRequestIdentity', () => {
    it('treats absent and null options alike', () => {
        expect(getPlayRequestIdentity({ ids: [ 'item' ], serverId: 'server' })).toBe(getPlayRequestIdentity({
            ids: [ 'item' ],
            serverId: 'server',
            startPositionTicks: null,
            mediaSourceId: undefined,
            audioStreamIndex: null,
            subtitleStreamIndex: undefined
        }));
    });

    it('reads fullscreen and remote players as on unless they are false', () => {
        const request = { ids: [ 'item' ], serverId: 'server' };

        expect(getPlayRequestIdentity({ ...request, fullscreen: true, enableRemotePlayers: true })).toBe(getPlayRequestIdentity(request));
        expect(getPlayRequestIdentity({ ...request, fullscreen: false })).not.toBe(getPlayRequestIdentity(request));
        expect(getPlayRequestIdentity({ ...request, enableRemotePlayers: false })).not.toBe(getPlayRequestIdentity(request));
    });

    it('ignores options PlaybackManager does not read', () => {
        expect(getPlayRequestIdentity({ ...createResumeRequest(), autoplay: true })).toBe(getPlayRequestIdentity(createResumeRequest()));
    });

    it('tells passed items on different servers apart', () => {
        expect(getPlayRequestIdentity({ items: [ { Id: 'item', ServerId: 'server' } ] }))
            .not.toBe(getPlayRequestIdentity({ items: [ { Id: 'item', ServerId: 'other-server' } ] }));
    });
});

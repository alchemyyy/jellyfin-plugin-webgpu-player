import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLAYBACK_SUPERSEDED } from 'addons/webGPUPlayer/constants/playbackResult';

type Deferred = {
    promise: Promise<unknown>
    reject: (reason?: unknown) => void
    resolve: (value?: unknown) => void
};

const testState = vi.hoisted(() => ({
    ensureInterceptors: vi.fn((): boolean => true),
    markNegotiation: vi.fn((profile: unknown): unknown => ({ ...(profile as object), marked: true })),
    preferredVideoPlayer: vi.fn((): string => 'auto'),
    stopActiveEncodings: vi.fn((): Promise<void> => Promise.resolve())
}));

vi.mock('lib/jellyfin-apiclient', () => ({
    ServerConnections: {
        getApiClient: vi.fn(() => ({ stopActiveEncodings: testState.stopActiveEncodings }))
    }
}));
vi.mock('addons/webGPUPlayer/shims/userSettings', () => ({
    preferredVideoPlayer: testState.preferredVideoPlayer
}));
vi.mock('addons/webGPUPlayer/compat/PlaybackInfoInterceptor', () => ({
    ensurePlaybackInfoInterceptors: testState.ensureInterceptors,
    markPlaybackInfoNegotiation: testState.markNegotiation
}));
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
    baseDestroy: ReturnType<typeof vi.fn>
    baseStop: ReturnType<typeof vi.fn>
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

describe('HostCompatibleWebGPUPlayer', () => {
    beforeEach(() => {
        testState.ensureInterceptors.mockReturnValue(true);
        testState.preferredVideoPlayer.mockReturnValue('auto');
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
});

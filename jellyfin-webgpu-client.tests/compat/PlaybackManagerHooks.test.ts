import { describe, expect, it, vi } from 'vitest';

import { installPlaybackManagerHooks, SUPERSEDING_PLAYBACK_MANAGER_METHODS } from 'addons/webGPUPlayer/compat/PlaybackManagerHooks';

type CallRecord = {
    methodArguments: unknown[]
    receiver: unknown
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

describe('installPlaybackManagerHooks', () => {
    it('cancels pending WebGPU starts before every superseding request', () => {
        const playbackManager = new FakePlaybackManager();
        const cancelPendingPlays = vi.fn((): boolean => {
            playbackManager.order.push('cancel');
            return false;
        });
        const hideLoading = vi.fn();

        expect(installPlaybackManagerHooks(playbackManager, { cancelPendingPlays, hideLoading })).toBe(true);
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
        installPlaybackManagerHooks(playbackManager, {
            cancelPendingPlays: () => false,
            hideLoading: vi.fn()
        });

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
        installPlaybackManagerHooks(playbackManager, { cancelPendingPlays, hideLoading });

        playbackManager.stop();
        playbackManager.nextTrack();

        expect(hideLoading).toHaveBeenCalledTimes(1);
    });

    it('installs once per PlaybackManager', () => {
        const playbackManager = new FakePlaybackManager();
        const cancelPendingPlays = vi.fn((): boolean => false);
        installPlaybackManagerHooks(playbackManager, { cancelPendingPlays, hideLoading: vi.fn() });

        expect(installPlaybackManagerHooks(playbackManager, { cancelPendingPlays, hideLoading: vi.fn() })).toBe(false);
        playbackManager.play();

        expect(cancelPendingPlays).toHaveBeenCalledTimes(1);
        expect(playbackManager.calls.get('play')).toHaveLength(1);
    });

    it('still runs the request when cancellation throws', () => {
        const playbackManager = new FakePlaybackManager();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        installPlaybackManagerHooks(playbackManager, {
            cancelPendingPlays: () => {
                throw new Error('cancel failed');
            },
            hideLoading: vi.fn()
        });

        expect(playbackManager.play()).toBe('play-result');
    });

    it('skips methods a host does not define', () => {
        const playbackManager: Record<string, unknown> = { play: vi.fn(() => 'played') };

        installPlaybackManagerHooks(playbackManager, { cancelPendingPlays: () => false, hideLoading: vi.fn() });

        expect(Object.keys(playbackManager)).toEqual([ 'play' ]);
        expect((playbackManager.play as () => unknown)()).toBe('played');
    });
});

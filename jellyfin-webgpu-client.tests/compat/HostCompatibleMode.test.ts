import { describe, expect, it, vi } from 'vitest';

type HookCallbacks = {
    cancelPendingPlays: () => boolean
    hideLoading: () => void
    isRequestStartPending: () => boolean
};

const testState = vi.hoisted(() => ({
    hide: vi.fn(),
    installHooks: vi.fn(),
    installSettingsEntryPoints: vi.fn(),
    playbackManager: { name: 'playbackManager' }
}));

vi.mock('components/loading/loading', () => ({ default: { hide: testState.hide } }));
vi.mock('components/playback/playbackmanager', () => ({ playbackManager: testState.playbackManager }));
vi.mock('addons/webGPUPlayer/compat/PlaybackManagerHooks', () => ({
    installPlaybackManagerHooks: testState.installHooks
}));
vi.mock('addons/webGPUPlayer/compat/SettingsEntryPoints', () => ({
    installSettingsEntryPoints: testState.installSettingsEntryPoints
}));

import { installHostCompatibleMode, type HostCompatiblePlayer } from 'addons/webGPUPlayer/compat/HostCompatibleMode';

function createPlayer(pending: boolean, requestStartPending = true): HostCompatiblePlayer {
    return {
        cancelPendingPlayForNewRequest: vi.fn(() => pending),
        getSettingsMenuItems: () => [],
        isRequestStartPending: vi.fn(() => requestStartPending)
    };
}

describe('installHostCompatibleMode', () => {
    it('hooks the bridged PlaybackManager and cancels every add-on player', () => {
        const idlePlayer = createPlayer(false);
        const pendingPlayer = createPlayer(true);

        installHostCompatibleMode(idlePlayer);
        installHostCompatibleMode(pendingPlayer);

        expect(testState.installHooks).toHaveBeenCalledTimes(2);
        expect(testState.installHooks.mock.calls[0][0]).toBe(testState.playbackManager);
        expect(testState.installSettingsEntryPoints).toHaveBeenCalledWith(idlePlayer);

        const callbacks = testState.installHooks.mock.calls[0][1] as HookCallbacks;
        expect(callbacks.cancelPendingPlays()).toBe(true);
        expect(idlePlayer.cancelPendingPlayForNewRequest).toHaveBeenCalledTimes(1);
        expect(pendingPlayer.cancelPendingPlayForNewRequest).toHaveBeenCalledTimes(1);

        callbacks.hideLoading();
        expect(testState.hide).toHaveBeenCalledTimes(1);
    });

    it('reports the latest request as starting only while every add-on player does', () => {
        const startingPlayer = createPlayer(true);
        const startedPlayer = createPlayer(false, false);

        installHostCompatibleMode(startingPlayer);
        const callbacks = testState.installHooks.mock.calls[0][1] as HookCallbacks;
        expect(callbacks.isRequestStartPending()).toBe(true);

        installHostCompatibleMode(startedPlayer);
        expect(callbacks.isRequestStartPending()).toBe(false);
        expect(startedPlayer.isRequestStartPending).toHaveBeenCalledTimes(1);
    });
});

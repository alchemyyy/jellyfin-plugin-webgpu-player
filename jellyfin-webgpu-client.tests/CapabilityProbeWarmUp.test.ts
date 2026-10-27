import { describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
    configureBackground: vi.fn(),
    customDecodeEnabled: true,
    isPlaying: vi.fn(() => false),
    runtimeAvailable: true,
    warmUp: vi.fn(() => true)
}));

vi.mock('components/playback/playbackmanager', () => ({ playbackManager: { isPlaying: testState.isPlaying } }));
vi.mock('webgpu-player/capability/CustomDecodeCapabilities', () => ({
    configureCustomDecodeCapabilityBackground: testState.configureBackground,
    warmCustomDecodeCapabilities: testState.warmUp
}));
vi.mock('webgpu-player/capability/CustomPlaybackRuntime', () => ({
    getCustomPlaybackRuntimeAvailability: () => ({ available: testState.runtimeAvailable })
}));
vi.mock('addons/webGPUPlayer/WebGPUPlaybackPreferences', () => ({
    isStoredWebGPUCustomDecodeEnabled: () => testState.customDecodeEnabled
}));

import { startCapabilityProbeWarmUp } from 'addons/webGPUPlayer/CapabilityProbeWarmUp';

type BackgroundConfiguration = { isPlaybackActive: () => boolean };

describe('startCapabilityProbeWarmUp', () => {
    it('warms the probes at load and holds them while the host plays', () => {
        testState.customDecodeEnabled = true;
        testState.runtimeAvailable = true;
        testState.warmUp.mockReturnValue(true);

        expect(startCapabilityProbeWarmUp()).toBe(true);

        expect(testState.warmUp).toHaveBeenCalledOnce();
        const configuration = testState.configureBackground.mock.calls[0][0] as BackgroundConfiguration;
        testState.isPlaying.mockReturnValue(true);
        expect(configuration.isPlaybackActive()).toBe(true);
        testState.isPlaying.mockReturnValue(false);
        expect(configuration.isPlaybackActive()).toBe(false);
    });

    it('reads no playback before the host binds its PlaybackManager', () => {
        startCapabilityProbeWarmUp();
        const configuration = testState.configureBackground.mock.calls[0][0] as BackgroundConfiguration;
        testState.isPlaying.mockImplementation(() => {
            throw new TypeError('playbackManager is undefined');
        });

        expect(configuration.isPlaybackActive()).toBe(false);
    });

    it('starts nothing when custom decode is off or cannot run', () => {
        testState.customDecodeEnabled = false;
        testState.runtimeAvailable = true;
        expect(startCapabilityProbeWarmUp()).toBe(false);

        testState.customDecodeEnabled = true;
        testState.runtimeAvailable = false;
        expect(startCapabilityProbeWarmUp()).toBe(false);

        expect(testState.warmUp).not.toHaveBeenCalled();
        // Background probes still learn about playbacks, for the reruns of stored verdicts
        expect(testState.configureBackground).toHaveBeenCalledTimes(2);
    });
});

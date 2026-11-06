import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
    appName: 'Jellyfin Web',
    browser: {} as Record<string, boolean>,
    configureBackground: vi.fn(),
    customDecodeEnabled: true,
    isPlaying: vi.fn(() => false),
    runtimeAvailable: true,
    storedSettings: null as string | null,
    whenSettled: vi.fn((): Promise<void> => Promise.resolve()),
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
vi.mock('addons/webGPUPlayer/ServerClientDefaults', () => ({ whenClientDefaultsSettled: testState.whenSettled }));
vi.mock('scripts/settings/userSettings', () => ({
    currentSettings: {
        get: (): string | null => testState.storedSettings,
        set: (_name: string, value: string): void => {
            testState.storedSettings = value;
        }
    }
}));
// The device type reads the host's browser detection, and rules the host's app values
vi.mock('scripts/browser', () => ({
    default: new Proxy({}, { get: (_target: object, flag: string): boolean => testState.browser[flag] === true })
}));
vi.mock('addons/webGPUPlayer/host/appHost', () => ({
    appHost: {
        appName: (): string => testState.appName,
        appVersion: (): string => '10.11.0',
        deviceName: (): string => 'Firefox'
    }
}));

import { setClientDefaults } from 'addons/webGPUPlayer/ClientDefaults';
import { startCapabilityProbeWarmUp } from 'addons/webGPUPlayer/CapabilityProbeWarmUp';
import { WEBGPU_USER_SETTINGS_VERSION } from 'addons/webGPUPlayer/WebGPUUserSettings';

type BackgroundConfiguration = { isPlaybackActive: () => boolean, refreshAfterUse?: boolean };

function getConfiguration(callIndex: number): BackgroundConfiguration {
    return testState.configureBackground.mock.calls[callIndex][0] as BackgroundConfiguration;
}

describe('startCapabilityProbeWarmUp', () => {
    beforeEach(() => {
        testState.appName = 'Jellyfin Web';
        testState.browser = {};
        testState.customDecodeEnabled = true;
        testState.runtimeAvailable = true;
        testState.storedSettings = null;
        vi.spyOn(console, 'info').mockImplementation((): void => undefined);
        vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
    });

    afterEach(() => {
        setClientDefaults({});
    });

    it('warms the probes on a desktop by default and holds them while the host plays', async () => {
        await expect(startCapabilityProbeWarmUp()).resolves.toBe(true);

        expect(testState.warmUp).toHaveBeenCalledOnce();
        expect(getConfiguration(1).refreshAfterUse).toBe(true);
        expect(console.info).toHaveBeenCalledWith('WebGPU decoder tests: background (device type desktop)');
        const configuration = getConfiguration(0);
        testState.isPlaying.mockReturnValue(true);
        expect(configuration.isPlaybackActive()).toBe(true);
        testState.isPlaying.mockReturnValue(false);
        expect(configuration.isPlaybackActive()).toBe(false);
    });

    it('reads no playback before the host binds its PlaybackManager', async () => {
        await startCapabilityProbeWarmUp();
        const configuration = getConfiguration(0);
        testState.isPlaying.mockImplementation(() => {
            throw new TypeError('playbackManager is undefined');
        });

        expect(configuration.isPlaybackActive()).toBe(false);
    });

    it('starts nothing, and waits for nothing, when custom decode is off or cannot run', async () => {
        testState.customDecodeEnabled = false;
        await expect(startCapabilityProbeWarmUp()).resolves.toBe(false);

        testState.customDecodeEnabled = true;
        testState.runtimeAvailable = false;
        await expect(startCapabilityProbeWarmUp()).resolves.toBe(false);

        expect(testState.warmUp).not.toHaveBeenCalled();
        expect(testState.whenSettled).not.toHaveBeenCalled();
        // Background probes still learn about playbacks, for the reruns of stored verdicts
        expect(testState.configureBackground).toHaveBeenCalledTimes(2);
        expect(getConfiguration(0)).toEqual({ isPlaybackActive: expect.any(Function) });
    });

    it('decides once the server\'s defaults settle, from the defaults they settle on', async () => {
        let settle: () => void = (): void => undefined;
        testState.whenSettled.mockReturnValue(new Promise<void>((resolve: () => void): void => {
            settle = resolve;
        }));

        const started = startCapabilityProbeWarmUp();
        // Playbacks are known at once, before the decision
        expect(testState.configureBackground).toHaveBeenCalledOnce();
        await Promise.resolve();
        expect(testState.warmUp).not.toHaveBeenCalled();
        setClientDefaults({ decoderTestBackgroundDevices: [ 'mobile' ] });
        settle();

        await expect(started).resolves.toBe(false);
        expect(testState.warmUp).not.toHaveBeenCalled();
        expect(testState.configureBackground).toHaveBeenCalledTimes(2);
        expect(getConfiguration(1).refreshAfterUse).toBe(false);
        expect(console.info).toHaveBeenCalledWith('WebGPU decoder tests: playback (device type desktop)');
    });

    it('runs the tests only at playback on a TV unless the administrator checks TVs', async () => {
        testState.browser = { tv: true };
        await expect(startCapabilityProbeWarmUp()).resolves.toBe(false);
        expect(getConfiguration(1).refreshAfterUse).toBe(false);

        setClientDefaults({ decoderTestBackgroundDevices: [ 'tv' ] });
        await expect(startCapabilityProbeWarmUp()).resolves.toBe(true);
        expect(getConfiguration(3).refreshAfterUse).toBe(true);
    });

    it('follows the user\'s own setting over the server\'s default', async () => {
        setClientDefaults({ decoderTestTiming: 'background' });
        testState.storedSettings = JSON.stringify({ playback: { decoderTestTiming: 'playback' }, version: WEBGPU_USER_SETTINGS_VERSION });

        await expect(startCapabilityProbeWarmUp()).resolves.toBe(false);

        expect(testState.warmUp).not.toHaveBeenCalled();
        expect(getConfiguration(1).refreshAfterUse).toBe(false);
        expect(console.info).toHaveBeenCalledWith('WebGPU decoder tests: playback (setting)');
    });

    it('follows the server\'s default timing when the user chose none', async () => {
        testState.browser = { mobile: true };
        setClientDefaults({ decoderTestTiming: 'background' });

        await expect(startCapabilityProbeWarmUp()).resolves.toBe(true);

        expect(console.info).toHaveBeenCalledWith('WebGPU decoder tests: background (setting)');
    });

    it('applies the first matching rule, skipping invalid lines with one warning', async () => {
        setClientDefaults({
            decoderTestRules: [
                'run everything',
                'playback client: jellyfin web',
                'background nowhere: *',
                'background client: *'
            ].join('\n')
        });

        await expect(startCapabilityProbeWarmUp()).resolves.toBe(false);

        expect(testState.warmUp).not.toHaveBeenCalled();
        expect(console.info).toHaveBeenCalledWith('WebGPU decoder tests: playback (rule on line 2)');
        expect(console.warn).toHaveBeenCalledOnce();
        expect(console.warn).toHaveBeenCalledWith('WebGPU decoder tests: rules-invalid: lines 1 (syntax), 3 (field) ignored');
    });

    it('takes the built-in device types and no rules for server values clients refuse', async () => {
        setClientDefaults({
            decoderTestBackgroundDevices: [ 'phone' ],
            decoderTestRules: `playback client: *\n${'#'.repeat(4_096)}`
        });

        await expect(startCapabilityProbeWarmUp()).resolves.toBe(true);

        expect(console.info).toHaveBeenCalledWith('WebGPU decoder tests: background (device type desktop)');
        expect(console.warn).not.toHaveBeenCalled();
    });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const storageMockState = vi.hoisted(() => ({
    value: null as string | null
}));

// WebGPUUserSettings persists through the host user settings, which the add-on build redirects to its shim
vi.mock('scripts/settings/userSettings', () => ({
    currentSettings: {
        get: vi.fn((): string | null => storageMockState.value),
        set: vi.fn((_name: string, value: string): void => {
            storageMockState.value = value;
        })
    }
}));

import { createDefaultWebGPUUserSettings } from 'addons/webGPUPlayer/WebGPUUserSettings';

type PlaybackPreferencesModule = typeof import('addons/webGPUPlayer/WebGPUPlaybackPreferences');

function storePlaybackPreferences(enableCustomDecode: boolean, enableHDRToneMapping: boolean): void {
    storageMockState.value = JSON.stringify({
        ...createDefaultWebGPUUserSettings(),
        playback: { enableCustomDecode, enableHDRToneMapping }
    });
}

/** Loads a fresh module, because the negotiated preferences live for the page lifetime. */
async function loadPlaybackPreferences(): Promise<PlaybackPreferencesModule> {
    vi.resetModules();
    return import('addons/webGPUPlayer/WebGPUPlaybackPreferences');
}

describe('WebGPUPlaybackPreferences', () => {
    beforeEach(() => {
        storageMockState.value = null;
    });

    it('enables both features when this browser stored no preferences', async () => {
        const preferences = await loadPlaybackPreferences();

        expect(preferences.isStoredWebGPUCustomDecodeEnabled()).toBe(true);
        expect(preferences.isWebGPUCustomDecodeEnabled()).toBe(true);
        await expect(preferences.getWebGPUCustomDecodeEnabled()).resolves.toBe(true);
        await expect(preferences.getWebGPUHDRToneMappingEnabled()).resolves.toBe(true);
    });

    it('reads the stored preferences on first use, before any negotiation', async () => {
        storePlaybackPreferences(true, false);
        const preferences = await loadPlaybackPreferences();

        expect(preferences.isWebGPUCustomDecodeEnabled()).toBe(true);
        await expect(preferences.getWebGPUHDRToneMappingEnabled()).resolves.toBe(false);
    });

    it('keeps the negotiated preferences until the next negotiation adopts a stored change', async () => {
        storePlaybackPreferences(true, true);
        const preferences = await loadPlaybackPreferences();
        preferences.refreshWebGPUPlaybackPreferences();

        storePlaybackPreferences(false, false);

        // Player selection sees the change at once; the playback in progress keeps what it negotiated
        expect(preferences.isStoredWebGPUCustomDecodeEnabled()).toBe(false);
        expect(preferences.isWebGPUCustomDecodeEnabled()).toBe(true);
        await expect(preferences.getWebGPUCustomDecodeEnabled()).resolves.toBe(true);
        await expect(preferences.getWebGPUHDRToneMappingEnabled()).resolves.toBe(true);

        preferences.refreshWebGPUPlaybackPreferences();

        expect(preferences.isWebGPUCustomDecodeEnabled()).toBe(false);
        await expect(preferences.getWebGPUCustomDecodeEnabled()).resolves.toBe(false);
        await expect(preferences.getWebGPUHDRToneMappingEnabled()).resolves.toBe(false);
    });
});

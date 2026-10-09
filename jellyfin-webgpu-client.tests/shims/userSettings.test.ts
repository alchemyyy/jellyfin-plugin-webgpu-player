import { beforeEach, describe, expect, it, vi } from 'vitest';

import { VideoPlayerPreference } from 'addons/webGPUPlayer/PreferredVideoPlayer';
import {
    CUSTOM_AUDIO_DOWNMIX_ALGORITHMS,
    DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM
} from 'webgpu-player/audio/processing/CustomAudioDownmixAlgorithm';

type ApiClientMock = {
    getCurrentUserId: () => string
};

const serverConnectionsMockState = vi.hoisted(() => ({
    currentUserId: undefined as string | undefined
}));

// The shim scopes keys to the signed-in user of the current API client
vi.mock('lib/jellyfin-apiclient', () => ({
    ServerConnections: {
        currentApiClient: (): ApiClientMock | undefined => {
            const userId = serverConnectionsMockState.currentUserId;
            return userId === undefined ? undefined : { getCurrentUserId: () => userId };
        }
    }
}));

// NOTE: The host appSettings is not mocked, so stored keys are checked against the host's real '<userId>-<name>' format
import {
    currentSettings,
    get as getSetting,
    getSubtitleAppearanceSettings,
    preferredVideoPlayer,
    selectAudioNormalization,
    set as setSetting,
    UserSettings,
    webGPUAudioDownmixAlgorithm
} from 'addons/webGPUPlayer/shims/userSettings';

beforeEach(() => {
    localStorage.clear();
    serverConnectionsMockState.currentUserId = 'user-1';
});

describe('UserSettings shim preferred video player', () => {
    it('defaults to automatic selection', () => {
        const settings = new UserSettings();

        expect(settings.preferredVideoPlayer()).toBe(VideoPlayerPreference.Auto);
    });

    it('persists the selection for the current user on this client', () => {
        const settings = new UserSettings();

        expect(settings.preferredVideoPlayer(VideoPlayerPreference.HTML)).toBe(VideoPlayerPreference.HTML);

        expect(localStorage.getItem('user-1-preferredVideoPlayer')).toBe(VideoPlayerPreference.HTML);
        expect(settings.preferredVideoPlayer()).toBe(VideoPlayerPreference.HTML);
    });

    it('normalizes invalid persisted values to automatic selection', () => {
        const settings = new UserSettings();
        localStorage.setItem('user-1-preferredVideoPlayer', 'unsupported');

        expect(settings.preferredVideoPlayer()).toBe(VideoPlayerPreference.Auto);
    });

    it('normalizes invalid assigned values to automatic selection', () => {
        const settings = new UserSettings();
        localStorage.setItem('user-1-preferredVideoPlayer', VideoPlayerPreference.WEBGPU);

        expect(settings.preferredVideoPlayer('native')).toBe(VideoPlayerPreference.Auto);
        expect(localStorage.getItem('user-1-preferredVideoPlayer')).toBe(VideoPlayerPreference.Auto);
    });
});

describe('UserSettings shim WebGPU audio downmix algorithm', () => {
    it('defaults to standard Lo/Ro with dynamic peak limiting', () => {
        const settings = new UserSettings();

        expect(settings.webGPUAudioDownmixAlgorithm()).toBe(DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM);
    });

    it('persists a supported selection for the current user on this client', () => {
        const settings = new UserSettings();

        expect(settings.webGPUAudioDownmixAlgorithm(
            CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845
        )).toBe(CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845);

        expect(localStorage.getItem('user-1-webGPUAudioDownmixAlgorithm')).toBe(CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845);
        expect(settings.webGPUAudioDownmixAlgorithm()).toBe(CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845);
    });

    it('normalizes invalid persisted and assigned values to the default', () => {
        const settings = new UserSettings();
        localStorage.setItem('user-1-webGPUAudioDownmixAlgorithm', 'unsupported');

        expect(settings.webGPUAudioDownmixAlgorithm()).toBe(DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM);

        expect(settings.webGPUAudioDownmixAlgorithm('also-unsupported')).toBe(DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM);
        expect(localStorage.getItem('user-1-webGPUAudioDownmixAlgorithm')).toBe(DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM);
    });
});

describe('UserSettings shim audio normalization', () => {
    it('defaults to track gain when the mode is unset or empty', () => {
        const settings = new UserSettings();

        expect(settings.selectAudioNormalization()).toBe('TrackGain');
        localStorage.setItem('user-1-selectAudioNormalization', '');
        expect(settings.selectAudioNormalization()).toBe('TrackGain');
    });

    it('persists the mode for the current user on this client', () => {
        const settings = new UserSettings();

        expect(settings.selectAudioNormalization('AlbumGain')).toBe('AlbumGain');

        expect(localStorage.getItem('user-1-selectAudioNormalization')).toBe('AlbumGain');
        expect(settings.selectAudioNormalization()).toBe('AlbumGain');
    });
});

describe('UserSettings shim subtitle appearance', () => {
    it('returns the host defaults when nothing is stored', () => {
        expect(new UserSettings().getSubtitleAppearanceSettings()).toEqual({
            aspectMode: 'contain',
            verticalPosition: -3
        });
    });

    it('merges the current user appearance over the host defaults', () => {
        localStorage.setItem('user-1-localplayersubtitleappearance3', JSON.stringify({
            aspectMode: 'cover',
            textSize: 'larger'
        }));

        expect(new UserSettings().getSubtitleAppearanceSettings()).toEqual({
            aspectMode: 'cover',
            textSize: 'larger',
            verticalPosition: -3
        });
    });

    it('reads an explicit appearance key', () => {
        localStorage.setItem('user-1-customsubtitleappearance', JSON.stringify({
            verticalPosition: 2
        }));

        expect(new UserSettings().getSubtitleAppearanceSettings('customsubtitleappearance')).toEqual({
            aspectMode: 'contain',
            verticalPosition: 2
        });
    });

    it('does not leak one user appearance into the defaults of another', () => {
        const settings = new UserSettings();
        localStorage.setItem('user-1-localplayersubtitleappearance3', JSON.stringify({
            aspectMode: 'cover'
        }));
        expect(settings.getSubtitleAppearanceSettings()).toMatchObject({ aspectMode: 'cover' });

        serverConnectionsMockState.currentUserId = 'user-2';

        expect(settings.getSubtitleAppearanceSettings()).toEqual({
            aspectMode: 'contain',
            verticalPosition: -3
        });
    });
});

describe('UserSettings shim storage scope', () => {
    it('reads and writes host-format keys for the signed-in user', () => {
        const settings = new UserSettings();

        settings.set('webgpuPlayerSettings', 'stored');

        expect(localStorage.getItem('user-1-webgpuPlayerSettings')).toBe('stored');
        expect(settings.get('webgpuPlayerSettings')).toBe('stored');
        expect(settings.get('missingSetting')).toBeNull();
    });

    it('uses unscoped keys without a signed-in API client', () => {
        serverConnectionsMockState.currentUserId = undefined;
        const settings = new UserSettings();

        settings.preferredVideoPlayer(VideoPlayerPreference.WEBGPU);

        expect(localStorage.getItem('preferredVideoPlayer')).toBe(VideoPlayerPreference.WEBGPU);
        expect(localStorage.getItem('user-1-preferredVideoPlayer')).toBeNull();
    });

    it('exports accessors bound to the shared instance', () => {
        expect(preferredVideoPlayer(VideoPlayerPreference.HTML)).toBe(VideoPlayerPreference.HTML);
        expect(currentSettings.preferredVideoPlayer()).toBe(VideoPlayerPreference.HTML);
        expect(webGPUAudioDownmixAlgorithm(CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.AC4)).toBe(CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.AC4);
        expect(currentSettings.webGPUAudioDownmixAlgorithm()).toBe(CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.AC4);
        expect(selectAudioNormalization('Off')).toBe('Off');
        expect(currentSettings.selectAudioNormalization()).toBe('Off');

        setSetting('webgpuPlayerSettings', 'shared');
        expect(getSetting('webgpuPlayerSettings')).toBe('shared');
        expect(currentSettings.get('webgpuPlayerSettings')).toBe('shared');
        expect(getSubtitleAppearanceSettings()).toEqual(currentSettings.getSubtitleAppearanceSettings());
    });
});

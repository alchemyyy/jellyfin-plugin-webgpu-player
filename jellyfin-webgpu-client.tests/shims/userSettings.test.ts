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
import { setClientDefaults } from 'addons/webGPUPlayer/ClientDefaults';
import {
    currentSettings,
    get as getSetting,
    getDefaultAudioDownmixAlgorithm,
    getDefaultVideoPlayerPreference,
    getSubtitleAppearanceSettings,
    preferredVideoPlayer,
    readVideoPlayerPreference,
    selectAudioNormalization,
    set as setSetting,
    UserSettings,
    webGPUAudioDownmixAlgorithm,
    writeVideoPlayerPreference
} from 'addons/webGPUPlayer/shims/userSettings';

beforeEach(() => {
    localStorage.clear();
    serverConnectionsMockState.currentUserId = 'user-1';
    setClientDefaults({});
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

    it('stores an invalid assigned value as automatic selection, the default, which then follows the default', () => {
        const settings = new UserSettings();
        localStorage.setItem('user-1-preferredVideoPlayer', VideoPlayerPreference.WEBGPU);

        expect(settings.preferredVideoPlayer('native')).toBe(VideoPlayerPreference.Auto);
        expect(localStorage.getItem('user-1-preferredVideoPlayer')).toBe('');
    });

    it('follows the server\'s default, else automatic selection, unless the user stored a choice', () => {
        const settings = new UserSettings();
        setClientDefaults({ preferredVideoPlayer: VideoPlayerPreference.HTML });

        expect(getDefaultVideoPlayerPreference()).toBe(VideoPlayerPreference.HTML);
        expect(settings.preferredVideoPlayer()).toBe(VideoPlayerPreference.HTML);
        localStorage.setItem('user-1-preferredVideoPlayer', 'unsupported');
        expect(settings.preferredVideoPlayer()).toBe(VideoPlayerPreference.HTML);
        localStorage.setItem('user-1-preferredVideoPlayer', VideoPlayerPreference.Auto);
        expect(settings.preferredVideoPlayer()).toBe(VideoPlayerPreference.Auto);
        // A value no preference has leaves the built-in default
        setClientDefaults({ preferredVideoPlayer: 'native' });
        expect(getDefaultVideoPlayerPreference()).toBe(VideoPlayerPreference.Auto);
    });

    it('stores a choice equal to the server\'s default empty, so it follows a later default', () => {
        setClientDefaults({ preferredVideoPlayer: VideoPlayerPreference.WEBGPU });

        expect(writeVideoPlayerPreference(VideoPlayerPreference.WEBGPU, 'user-2')).toBe(VideoPlayerPreference.WEBGPU);
        expect(localStorage.getItem('user-2-preferredVideoPlayer')).toBe('');
        expect(writeVideoPlayerPreference(VideoPlayerPreference.Auto, 'user-2')).toBe(VideoPlayerPreference.Auto);
        expect(localStorage.getItem('user-2-preferredVideoPlayer')).toBe(VideoPlayerPreference.Auto);
        writeVideoPlayerPreference(VideoPlayerPreference.WEBGPU, 'user-2');
        setClientDefaults({ preferredVideoPlayer: VideoPlayerPreference.HTML });

        expect(readVideoPlayerPreference('user-2')).toBe(VideoPlayerPreference.HTML);
        // Another user's choice is their own
        expect(readVideoPlayerPreference('user-1')).toBe(VideoPlayerPreference.HTML);
        writeVideoPlayerPreference(VideoPlayerPreference.WEBGPU, 'user-1');
        expect(readVideoPlayerPreference('user-1')).toBe(VideoPlayerPreference.WEBGPU);
        expect(readVideoPlayerPreference('user-2')).toBe(VideoPlayerPreference.HTML);
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

    it('normalizes invalid persisted and assigned values to the default, storing the default empty', () => {
        const settings = new UserSettings();
        localStorage.setItem('user-1-webGPUAudioDownmixAlgorithm', 'unsupported');

        expect(settings.webGPUAudioDownmixAlgorithm()).toBe(DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM);

        expect(settings.webGPUAudioDownmixAlgorithm('also-unsupported')).toBe(DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM);
        expect(localStorage.getItem('user-1-webGPUAudioDownmixAlgorithm')).toBe('');
    });

    it('follows the server\'s default unless the user stored another algorithm', () => {
        const settings = new UserSettings();
        setClientDefaults({ audioDownmixAlgorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750 });

        expect(getDefaultAudioDownmixAlgorithm()).toBe(CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750);
        expect(settings.webGPUAudioDownmixAlgorithm()).toBe(CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750);
        expect(settings.webGPUAudioDownmixAlgorithm(DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM)).toBe(DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM);
        expect(localStorage.getItem('user-1-webGPUAudioDownmixAlgorithm')).toBe(DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM);
        expect(settings.webGPUAudioDownmixAlgorithm(CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750)).toBe(CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750);
        expect(localStorage.getItem('user-1-webGPUAudioDownmixAlgorithm')).toBe('');
        // A value no algorithm has leaves the engine's default
        setClientDefaults({ audioDownmixAlgorithm: 'surround' });
        expect(settings.webGPUAudioDownmixAlgorithm()).toBe(DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM);
    });
});

describe('UserSettings shim choices stored by earlier versions', () => {
    it('lets a stored built-in player preference or downmix algorithm follow the server\'s default once, and keeps every later choice', () => {
        // Earlier versions stored the built-in values themselves on a restore, a reset, or a save of the Playback page
        localStorage.setItem('user-1-preferredVideoPlayer', VideoPlayerPreference.Auto);
        localStorage.setItem('user-1-webGPUAudioDownmixAlgorithm', DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM);
        localStorage.setItem('user-2-preferredVideoPlayer', VideoPlayerPreference.WEBGPU);
        setClientDefaults({ audioDownmixAlgorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750, preferredVideoPlayer: VideoPlayerPreference.HTML });
        const settings = new UserSettings();

        expect(settings.preferredVideoPlayer()).toBe(VideoPlayerPreference.HTML);
        expect(settings.webGPUAudioDownmixAlgorithm()).toBe(CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750);
        // Any other stored value was a choice
        expect(readVideoPlayerPreference('user-2')).toBe(VideoPlayerPreference.WEBGPU);

        // The built-in values chosen from now on stay the user's
        settings.preferredVideoPlayer(VideoPlayerPreference.Auto);
        settings.webGPUAudioDownmixAlgorithm(DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM);
        expect(settings.preferredVideoPlayer()).toBe(VideoPlayerPreference.Auto);
        expect(settings.webGPUAudioDownmixAlgorithm()).toBe(DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM);
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

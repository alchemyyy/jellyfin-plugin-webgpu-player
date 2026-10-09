import { ServerConnections } from 'lib/jellyfin-apiclient';
import appSettings from 'scripts/settings/appSettings';
import {
    normalizeCustomAudioDownmixAlgorithm,
    type CustomAudioDownmixAlgorithm
} from 'webgpu-player/audio/processing/CustomAudioDownmixAlgorithm';

import { normalizeVideoPlayerPreference, VideoPlayerPreference } from '../PreferredVideoPlayer';

// Shim for scripts/settings/userSettings: the host instance is not in the plugin bag
// NOTE: Every setting the add-on reads is local (enableOnServer false), which the host stores through appSettings under '<userId>-<name>', so these reads match the host

const SUBTITLE_APPEARANCE_KEY = 'localplayersubtitleappearance3';
const AUDIO_NORMALIZATION_KEY = 'selectAudioNormalization';
const DEFAULT_AUDIO_NORMALIZATION = 'TrackGain';
// The fork's storage key, so a preference saved by the fork carries over
export const PREFERRED_VIDEO_PLAYER_KEY = 'preferredVideoPlayer';
const WEBGPU_AUDIO_DOWNMIX_ALGORITHM_KEY = 'webGPUAudioDownmixAlgorithm';

type SubtitleAppearanceSettings = Record<string, unknown>;

const DEFAULT_SUBTITLE_APPEARANCE_SETTINGS: Readonly<SubtitleAppearanceSettings> = {
    verticalPosition: -3,
    aspectMode: 'contain'
};

/** Returns the signed-in user, which the host also binds its user settings to. */
function getCurrentUserId(): string | undefined {
    const apiClient = ServerConnections.currentApiClient();
    return apiClient?.getCurrentUserId() || undefined;
}

/**
 * Local per-user settings with the host's storage keys.
 * The host's enableOnServer argument is accepted and ignored: server-synced display preferences are not reachable from the add-on.
 */
export class UserSettings {
    /** Reads a setting from local storage. */
    get(name: string): string | null {
        return appSettings.get(name, getCurrentUserId());
    }

    /** Writes a setting to local storage. */
    set(name: string, value: string): void {
        appSettings.set(name, value, getCurrentUserId());
    }

    /** Returns the local subtitle appearance, merged over the host defaults. */
    getSubtitleAppearanceSettings(key?: string): SubtitleAppearanceSettings {
        const storedValue = this.get(key || SUBTITLE_APPEARANCE_KEY);
        return {
            ...DEFAULT_SUBTITLE_APPEARANCE_SETTINGS,
            ...(JSON.parse(storedValue || '{}') as SubtitleAppearanceSettings)
        };
    }

    /** Gets or sets the local audio normalization mode, as the host does. */
    selectAudioNormalization(value?: unknown): string {
        if (value !== undefined) {
            const normalization = String(value);
            this.set(AUDIO_NORMALIZATION_KEY, normalization);
            return normalization;
        }
        return this.get(AUDIO_NORMALIZATION_KEY) || DEFAULT_AUDIO_NORMALIZATION;
    }

    /** Gets or sets the local video player used for new playback sessions. */
    preferredVideoPlayer(value?: unknown): VideoPlayerPreference {
        if (value !== undefined) {
            const preference = normalizeVideoPlayerPreference(value);
            this.set(PREFERRED_VIDEO_PLAYER_KEY, preference);
            return preference;
        }
        return normalizeVideoPlayerPreference(this.get(PREFERRED_VIDEO_PLAYER_KEY) ?? VideoPlayerPreference.Auto);
    }

    /** Gets or sets the local WebGPU stereo downmix algorithm. */
    webGPUAudioDownmixAlgorithm(value?: unknown): CustomAudioDownmixAlgorithm {
        if (value !== undefined) {
            const algorithm = normalizeCustomAudioDownmixAlgorithm(value);
            this.set(WEBGPU_AUDIO_DOWNMIX_ALGORITHM_KEY, algorithm);
            return algorithm;
        }
        return normalizeCustomAudioDownmixAlgorithm(this.get(WEBGPU_AUDIO_DOWNMIX_ALGORITHM_KEY));
    }
}

export const currentSettings = new UserSettings();

export const get = currentSettings.get.bind(currentSettings);
export const set = currentSettings.set.bind(currentSettings);
export const getSubtitleAppearanceSettings = currentSettings.getSubtitleAppearanceSettings.bind(currentSettings);
export const selectAudioNormalization = currentSettings.selectAudioNormalization.bind(currentSettings);
export const preferredVideoPlayer = currentSettings.preferredVideoPlayer.bind(currentSettings);
export const webGPUAudioDownmixAlgorithm = currentSettings.webGPUAudioDownmixAlgorithm.bind(currentSettings);

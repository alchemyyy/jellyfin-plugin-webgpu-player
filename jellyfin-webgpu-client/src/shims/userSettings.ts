import { ServerConnections } from 'lib/jellyfin-apiclient';
import appSettings from 'scripts/settings/appSettings';
import {
    DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM,
    isCustomAudioDownmixAlgorithm,
    normalizeCustomAudioDownmixAlgorithm,
    type CustomAudioDownmixAlgorithm
} from 'webgpu-player/audio/processing/CustomAudioDownmixAlgorithm';

import { getClientDefaults } from '../ClientDefaults';
import { normalizeVideoPlayerPreference, VideoPlayerPreference } from '../PreferredVideoPlayer';

// Shim for scripts/settings/userSettings: the host instance is not in the plugin bag
// NOTE: Every setting the add-on reads is local (enableOnServer false), which the host stores through appSettings under '<userId>-<name>', so these reads match the host

const SUBTITLE_APPEARANCE_KEY = 'localplayersubtitleappearance3';
const AUDIO_NORMALIZATION_KEY = 'selectAudioNormalization';
const DEFAULT_AUDIO_NORMALIZATION = 'TrackGain';
// The fork's storage key, so a preference saved by the fork carries over
export const PREFERRED_VIDEO_PLAYER_KEY = 'preferredVideoPlayer';
const WEBGPU_AUDIO_DOWNMIX_ALGORITHM_KEY = 'webGPUAudioDownmixAlgorithm';
// Marks a user whose player preference and downmix algorithm were read since a choice equal to its default started to follow the default
const LEGACY_CHOICES_MIGRATED_KEY = 'webGPULegacyChoicesMigrated';
const LEGACY_CHOICES_MIGRATED = 'true';

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

/** Returns the video player new playback sessions use unless the user chose one: the server's default, else automatic selection. */
export function getDefaultVideoPlayerPreference(): VideoPlayerPreference {
    return normalizeVideoPlayerPreference(getClientDefaults().preferredVideoPlayer);
}

/** Returns the WebGPU stereo downmix algorithm unless the user chose one: the server's default, else the engine's. */
export function getDefaultAudioDownmixAlgorithm(): CustomAudioDownmixAlgorithm {
    return normalizeCustomAudioDownmixAlgorithm(getClientDefaults().audioDownmixAlgorithm);
}

/**
 * Empties, once per user, a stored player preference or downmix algorithm that holds the built-in default.
 * Earlier versions stored the built-in value itself on a restore, a reset, or a save of the Playback page, which the user could not tell from a choice;
 * so it follows the default, as version 4 settings migrate, and a choice made from now on stays the user's.
 */
function migrateLegacyChoices(userId: string | undefined): void {
    if (appSettings.get(LEGACY_CHOICES_MIGRATED_KEY, userId) === LEGACY_CHOICES_MIGRATED) {
        return;
    }
    if (appSettings.get(PREFERRED_VIDEO_PLAYER_KEY, userId) === VideoPlayerPreference.Auto) {
        appSettings.set(PREFERRED_VIDEO_PLAYER_KEY, '', userId);
    }
    if (appSettings.get(WEBGPU_AUDIO_DOWNMIX_ALGORITHM_KEY, userId) === DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM) {
        appSettings.set(WEBGPU_AUDIO_DOWNMIX_ALGORITHM_KEY, '', userId);
    }
    appSettings.set(LEGACY_CHOICES_MIGRATED_KEY, LEGACY_CHOICES_MIGRATED, userId);
}

/** Reads a user's video player preference: the stored choice, else the default. */
export function readVideoPlayerPreference(userId: string | undefined): VideoPlayerPreference {
    migrateLegacyChoices(userId);
    const storedValue = appSettings.get(PREFERRED_VIDEO_PLAYER_KEY, userId);
    const preference = normalizeVideoPlayerPreference(storedValue);
    return preference === storedValue ? preference : getDefaultVideoPlayerPreference();
}

/** Stores a user's video player preference; a choice equal to the default is stored empty, so it follows the default. */
export function writeVideoPlayerPreference(value: unknown, userId: string | undefined): VideoPlayerPreference {
    migrateLegacyChoices(userId);
    const preference = normalizeVideoPlayerPreference(value);
    appSettings.set(PREFERRED_VIDEO_PLAYER_KEY, preference === getDefaultVideoPlayerPreference() ? '' : preference, userId);
    return preference;
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

    /** Gets or sets the local video player used for new playback sessions; a choice equal to the default follows the default. */
    preferredVideoPlayer(value?: unknown): VideoPlayerPreference {
        if (value !== undefined) {
            return writeVideoPlayerPreference(value, getCurrentUserId());
        }
        return readVideoPlayerPreference(getCurrentUserId());
    }

    /** Gets or sets the local WebGPU stereo downmix algorithm; a choice equal to the default follows the default. */
    webGPUAudioDownmixAlgorithm(value?: unknown): CustomAudioDownmixAlgorithm {
        // A write follows the migration too, so a later first read never takes the new choice for an earlier version's built-in value
        migrateLegacyChoices(getCurrentUserId());
        if (value !== undefined) {
            const algorithm = normalizeCustomAudioDownmixAlgorithm(value);
            this.set(WEBGPU_AUDIO_DOWNMIX_ALGORITHM_KEY, algorithm === getDefaultAudioDownmixAlgorithm() ? '' : algorithm);
            return algorithm;
        }
        const storedValue = this.get(WEBGPU_AUDIO_DOWNMIX_ALGORITHM_KEY);
        return isCustomAudioDownmixAlgorithm(storedValue) ? storedValue : getDefaultAudioDownmixAlgorithm();
    }
}

export const currentSettings = new UserSettings();

export const get = currentSettings.get.bind(currentSettings);
export const set = currentSettings.set.bind(currentSettings);
export const getSubtitleAppearanceSettings = currentSettings.getSubtitleAppearanceSettings.bind(currentSettings);
export const selectAudioNormalization = currentSettings.selectAudioNormalization.bind(currentSettings);
export const preferredVideoPlayer = currentSettings.preferredVideoPlayer.bind(currentSettings);
export const webGPUAudioDownmixAlgorithm = currentSettings.webGPUAudioDownmixAlgorithm.bind(currentSettings);

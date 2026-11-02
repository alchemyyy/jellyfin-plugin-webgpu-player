import { currentSettings } from 'scripts/settings/userSettings';

import { CLIENT_DEFAULT_KEYS, parseAppliedRevisions, type AppliedRevisions, type ClientDefaultKey } from './ClientDefaults';
import { getDefaultPresentationFiles } from './DefaultPresentationFiles';
import { deletePassSources, getStoredFileSourceKeys } from './PresentationPassStore';
import { PREFERRED_VIDEO_PLAYER_KEY, WEBGPU_AUDIO_DOWNMIX_ALGORITHM_KEY } from './shims/userSettings';
import { clearWebGPUUserSettingChoices } from './WebGPUUserSettings';

// An administrator applies a default to every client: each client then drops its user's own choice of that setting once, so the user follows the default again.
// The user may choose anew afterwards; only a later apply drops that choice

// The revision of each key this user's choices last followed an apply of, per user as the host's local user settings are
const HONORED_STORAGE_KEY = 'webGPUHonoredClientDefaults';
const WARNING_PREFIX = 'WebGPU client defaults';

// The settings stored apart from the WebGPU user settings, each by its storage key
const SEPARATE_SETTING_KEYS: Readonly<Partial<Record<ClientDefaultKey, string>>> = Object.freeze({
    audioDownmixAlgorithm: WEBGPU_AUDIO_DOWNMIX_ALGORITHM_KEY,
    preferredVideoPlayer: PREFERRED_VIDEO_PLAYER_KEY
});

function readHonoredRevisions(): AppliedRevisions {
    try {
        return parseAppliedRevisions(JSON.parse(currentSettings.get(HONORED_STORAGE_KEY, false) || '{}'));
    } catch {
        return {};
    }
}

/**
 * Drops the signed-in user's own choice of each setting applied since this user last followed an apply of it, and returns whether any was applied.
 * The user's own shader files go with their preset, unless the default files hold them.
 */
export function honorAppliedClientDefaults(applied: AppliedRevisions): boolean {
    const honored = readHonoredRevisions();
    const keys = CLIENT_DEFAULT_KEYS.filter((key: ClientDefaultKey): boolean => (applied[key] ?? 0) > (honored[key] ?? 0));
    if (keys.length === 0) {
        return false;
    }
    for (const key of keys) {
        const storageKey = SEPARATE_SETTING_KEYS[key];
        if (storageKey !== undefined) {
            currentSettings.set(storageKey, '', false);
        }
    }
    const droppedFiles = clearWebGPUUserSettingChoices(keys);
    const nextHonored: Partial<Record<ClientDefaultKey, number>> = { ...honored };
    for (const key of keys) {
        nextHonored[key] = applied[key];
    }
    currentSettings.set(HONORED_STORAGE_KEY, JSON.stringify(nextHonored), false);
    const heldKeys = new Set<number>(getStoredFileSourceKeys(getDefaultPresentationFiles()));
    const droppedKeys = getStoredFileSourceKeys(droppedFiles).filter((key: number): boolean => !heldKeys.has(key));
    if (droppedKeys.length > 0) {
        void deletePassSources(droppedKeys).catch((error: unknown): void => {
            console.warn(`${WARNING_PREFIX}: sources-not-deleted: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
    return true;
}

import { currentSettings } from 'scripts/settings/userSettings';

import {
    HDR_RENDER_SETTING_RANGES,
    createHDRToSDRRenderSettings,
    type HDRToSDRRenderSettings,
    type ToneMapOperator
} from 'webgpu-player/presentation/RenderSettings';
import {
    AUDIO_DOWNMIX_SETTING_RANGES,
    AUDIO_DOWNMIX_SETTINGS_VERSION,
    createDefaultAudioDownmixSettings,
    type AudioDownmixSettings
} from 'webgpu-player/audio/processing/CustomAudioDownmix';
import {
    DEFAULT_CUSTOM_AUDIO_SPEAKER_LAYOUT,
    isCustomAudioSpeakerLayout,
    type CustomAudioSpeakerLayout
} from 'webgpu-player/audio/NativeMultichannelAudioOutput';
import { MAXIMUM_PARAMETER_COUNT } from 'webgpu-player/presentation/passes/PassLanguage';
import {
    DEFAULT_DEINTERLACE_MODE,
    DEINTERLACE_MODES,
    type DeinterlaceMode
} from 'webgpu-player/presentation/DeinterlaceTimeline';

import { getClientDefaults } from './ClientDefaults';
import {
    DEFAULT_SETTINGS_BUTTON_PLACEMENT,
    isSettingsButtonPlacement,
    type SettingsButtonPlacement
} from './SettingsButtonPlacement';

// Each save stores only the settings that differ from the defaults, so the others follow the defaults the server sets
export const WEBGPU_USER_SETTINGS_VERSION = 5;
// The full snapshot each save stored before; its values equal to the built-in defaults are read as following the defaults
const FULL_SNAPSHOT_SETTINGS_VERSION = 4;
export const WEBGPU_USER_SETTINGS_STORAGE_KEY = 'webGPUPlaybackSettings';
const MAXIMUM_AUDIO_OUTPUT_DEVICE_ID_LENGTH = 1_024;
/** The shader files a preset holds at most. */
export const MAXIMUM_PRESENTATION_FILE_COUNT = 16;
/** The characters one shader file holds at most; sources live in IndexedDB, so this only keeps a mistaken pick, such as a media file, out of it. */
export const MAXIMUM_PRESENTATION_PASS_SOURCE_LENGTH = 16_777_216;
/** The characters a stored parameter name holds at most; a longer name is no identifier a pass would declare, so it is dropped. */
export const MAXIMUM_PRESENTATION_PARAMETER_NAME_LENGTH = 256;
/** The characters a server pass file name holds at most, the server plugin's own limit. */
export const MAXIMUM_SERVER_PASS_FILE_NAME_LENGTH = 128;
const NULL_CHARACTER = '\0';
// A content hash: the lowercase hexadecimal SHA-256 the server names each file version by
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** The server pass file a stored source came from: its name, which identifies it on the server, and the content hash of the version the source is. */
export type StoredPresentationFileOrigin = Readonly<{
    contentHash: string
    fileName: string
}>;

/** One shader file of the user's preset as the settings keep it: its parameter values, its source's key in the pass source store, and the server file it came from. */
export type StoredPresentationFile = Readonly<{
    parameters: Readonly<Record<string, number>>
    /** The server pass file the source came from, whose newer versions replace it; absent for a file the user added from this device */
    server?: StoredPresentationFileOrigin
    sourceKey: number
}>;

export type WebGPUUserSettings = Readonly<{
    audio: Readonly<{
        /** Binaural rendering of Dolby Atmos objects for headphones, when the output is stereo */
        binauralHeadphones: boolean
        downmix: AudioDownmixSettings
        forceStereoDownmix: boolean
        outputDeviceId: string | null
        /** The speakers decoded audio plays to: `auto` follows the output's channel count */
        speakerLayout: CustomAudioSpeakerLayout
    }>
    // Applies live: the video OSD places its entry to the settings panel anew
    osd: Readonly<{
        settingsButtonPlacement: SettingsButtonPlacement
    }>
    // Each applies from the next playback: custom decode and HDR tone mapping shape what the player negotiates with the server,
    // and GPU decode slicing how a decoder package's GPU decoder submits its work
    playback: Readonly<{
        enableCustomDecode: boolean
        enableGPUDecodeSlicing: boolean
        enableHDRToneMapping: boolean
    }>
    // Each applies live: the presenter replans the active session and keeps them for later ones
    presentation: Readonly<{
        /** How interlaced video presents: a frame per field, a frame per frame, or woven frames as decoded */
        deinterlaceMode: DeinterlaceMode
        /** The user's own shader preset; null follows the server's default preset */
        files: readonly StoredPresentationFile[] | null
        hdrOutput: boolean
    }>
    render: Readonly<{
        automaticInputPeakNits: boolean
        settings: HDRToSDRRenderSettings
    }>
    version: typeof WEBGPU_USER_SETTINGS_VERSION
}>;

export type WebGPUUserSettingsStorage = {
    get: (name: string, enableOnServer?: boolean) => string | null | undefined
    set: (name: string, value: string, enableOnServer?: boolean) => unknown
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getRecord(value: unknown, key: string): Record<string, unknown> {
    if (!isRecord(value)) {
        return {};
    }
    const child = value[key];
    return isRecord(child) ? child : {};
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function normalizeAudioOutputDeviceId(value: unknown): string | null {
    if (value === null || value === undefined || value === '' || value === 'default') {
        return null;
    }
    if (typeof value !== 'string'
        || value.length > MAXIMUM_AUDIO_OUTPUT_DEVICE_ID_LENGTH
        || value.includes(NULL_CHARACTER)) {
        return null;
    }
    return value;
}

function normalizeNumber(
    value: unknown,
    fallback: number,
    minimum: number,
    maximum: number
): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(Math.max(value, minimum), maximum);
}

/** Returns whether a value can be a stored pass source: nonblank text within the size limit, without null characters. */
export function isPresentationPassSource(value: unknown): value is string {
    return typeof value === 'string'
        && value.trim().length > 0
        && value.length <= MAXIMUM_PRESENTATION_PASS_SOURCE_LENGTH
        && !value.includes(NULL_CHARACTER);
}

/** Returns whether a value can be a key of the pass source store, whose keys count up from 1. */
export function isPresentationPassSourceKey(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Keeps a pass's finite parameter values under nonblank names, up to the parameters a pass declares at most. */
export function normalizePresentationParameters(value: unknown): Readonly<Record<string, number>> {
    const parameterEntries: Array<[string, number]> = [];
    if (!isRecord(value)) {
        return Object.fromEntries(parameterEntries);
    }
    for (const [ name, parameterValue ] of Object.entries(value)) {
        if (parameterEntries.length >= MAXIMUM_PARAMETER_COUNT) {
            break;
        }
        if (name.trim().length === 0
            || name.length > MAXIMUM_PRESENTATION_PARAMETER_NAME_LENGTH
            || typeof parameterValue !== 'number'
            || !Number.isFinite(parameterValue)) {
            continue;
        }
        parameterEntries.push([ name, parameterValue ]);
    }
    return Object.fromEntries(parameterEntries);
}

/** Returns a stored file's server origin, or null for a value that names no server file version. */
function normalizePresentationFileOrigin(value: unknown): StoredPresentationFileOrigin | null {
    if (!isRecord(value)
        || typeof value.fileName !== 'string'
        || value.fileName.trim().length === 0
        || value.fileName.length > MAXIMUM_SERVER_PASS_FILE_NAME_LENGTH
        || typeof value.contentHash !== 'string'
        || !CONTENT_HASH_PATTERN.test(value.contentHash)) {
        return null;
    }
    return { contentHash: value.contentHash, fileName: value.fileName };
}

/** Keeps the stored files with a valid source key, in order, up to the files a preset holds at most; an origin that names no server file version is dropped. */
export function normalizePresentationFiles(value: unknown): StoredPresentationFile[] {
    const files: StoredPresentationFile[] = [];
    if (!Array.isArray(value)) {
        return files;
    }
    for (const candidate of value) {
        if (files.length >= MAXIMUM_PRESENTATION_FILE_COUNT) {
            break;
        }
        if (isRecord(candidate) && isPresentationPassSourceKey(candidate.sourceKey)) {
            const server = normalizePresentationFileOrigin(candidate.server);
            files.push({
                parameters: normalizePresentationParameters(candidate.parameters),
                ...(server ? { server } : {}),
                sourceKey: candidate.sourceKey
            });
        }
    }
    return files;
}

function normalizeToneMapOperator(value: unknown, fallback: ToneMapOperator): ToneMapOperator {
    switch (value) {
        case 'aces':
        case 'reinhard':
        case 'spline':
            return value;
        default:
            return fallback;
    }
}

/** Returns the add-on's own defaults, independent objects backed by renderer and downmix defaults. */
export function createBuiltInWebGPUUserSettings(): WebGPUUserSettings {
    return {
        audio: {
            binauralHeadphones: false,
            downmix: createDefaultAudioDownmixSettings(),
            forceStereoDownmix: false,
            outputDeviceId: null,
            speakerLayout: DEFAULT_CUSTOM_AUDIO_SPEAKER_LAYOUT
        },
        osd: {
            settingsButtonPlacement: DEFAULT_SETTINGS_BUTTON_PLACEMENT
        },
        playback: {
            enableCustomDecode: true,
            enableGPUDecodeSlicing: false,
            enableHDRToneMapping: true
        },
        presentation: {
            deinterlaceMode: DEFAULT_DEINTERLACE_MODE,
            files: null,
            hdrOutput: false
        },
        render: {
            automaticInputPeakNits: true,
            settings: createHDRToSDRRenderSettings()
        },
        version: WEBGPU_USER_SETTINGS_VERSION
    };
}

/**
 * Returns the defaults the user's settings follow: the built-in defaults, each overlaid with the server's default for it.
 * A server default is read as a stored value is, so one the setting refuses leaves the built-in default.
 */
export function createDefaultWebGPUUserSettings(): WebGPUUserSettings {
    const serverDefaults = getClientDefaults();
    return normalizeSettingsOver({
        audio: {
            binauralHeadphones: serverDefaults.binauralHeadphones,
            downmix: {
                centerLevel: serverDefaults.centerLevel,
                outputGain: serverDefaults.outputGain,
                surroundLevel: serverDefaults.surroundLevel
            },
            forceStereoDownmix: serverDefaults.forceStereoDownmix,
            speakerLayout: serverDefaults.speakerLayout
        },
        osd: {
            settingsButtonPlacement: serverDefaults.settingsButtonPlacement
        },
        playback: {
            enableCustomDecode: serverDefaults.enableCustomDecode,
            enableGPUDecodeSlicing: serverDefaults.enableGPUDecodeSlicing,
            enableHDRToneMapping: serverDefaults.enableHDRToneMapping
        },
        presentation: {
            deinterlaceMode: serverDefaults.deinterlaceMode,
            hdrOutput: serverDefaults.hdrOutput
        },
        render: {
            automaticInputPeakNits: serverDefaults.automaticInputPeakNits,
            settings: {
                display: {
                    brightness: serverDefaults.brightness,
                    contrast: serverDefaults.contrast,
                    saturation: serverDefaults.saturation
                },
                toneMapping: {
                    desaturationStrength: serverDefaults.desaturationStrength,
                    exposure: serverDefaults.exposure,
                    inputPeakNits: serverDefaults.inputPeakNits,
                    operator: serverDefaults.toneMapOperator,
                    outputPeakNits: serverDefaults.outputPeakNits,
                    paperWhiteNits: serverDefaults.paperWhiteNits
                }
            }
        }
    }, createBuiltInWebGPUUserSettings());
}

/** Normalizes the current version's settings through the same ranges consumed by renderer validation; another version is not read. */
export function normalizeWebGPUUserSettings(value: unknown): WebGPUUserSettings {
    const defaults = createDefaultWebGPUUserSettings();
    if (!isRecord(value) || value.version !== WEBGPU_USER_SETTINGS_VERSION) {
        return defaults;
    }
    return normalizeSettingsOver(value, defaults);
}

/** Reads each setting a value holds, a missing or refused one taking the given default. */
function normalizeSettingsOver(value: Record<string, unknown>, defaults: WebGPUUserSettings): WebGPUUserSettings {
    const render = getRecord(value, 'render');
    const persistedRenderSettings = getRecord(render, 'settings');
    const display = getRecord(persistedRenderSettings, 'display');
    const toneMapping = getRecord(persistedRenderSettings, 'toneMapping');
    const defaultRenderSettings = defaults.render.settings;
    const inputPeakNits = normalizeNumber(
        toneMapping.inputPeakNits,
        defaultRenderSettings.toneMapping.inputPeakNits,
        HDR_RENDER_SETTING_RANGES.inputPeakNits.minimum,
        HDR_RENDER_SETTING_RANGES.inputPeakNits.maximum
    );
    const paperWhiteNits = Math.min(inputPeakNits, normalizeNumber(
        toneMapping.paperWhiteNits,
        defaultRenderSettings.toneMapping.paperWhiteNits,
        HDR_RENDER_SETTING_RANGES.paperWhiteNits.minimum,
        HDR_RENDER_SETTING_RANGES.paperWhiteNits.maximum
    ));
    const settings = createHDRToSDRRenderSettings({
        display: {
            brightness: normalizeNumber(
                display.brightness,
                defaultRenderSettings.display.brightness,
                HDR_RENDER_SETTING_RANGES.brightness.minimum,
                HDR_RENDER_SETTING_RANGES.brightness.maximum
            ),
            contrast: normalizeNumber(
                display.contrast,
                defaultRenderSettings.display.contrast,
                HDR_RENDER_SETTING_RANGES.contrast.minimum,
                HDR_RENDER_SETTING_RANGES.contrast.maximum
            ),
            saturation: normalizeNumber(
                display.saturation,
                defaultRenderSettings.display.saturation,
                HDR_RENDER_SETTING_RANGES.saturation.minimum,
                HDR_RENDER_SETTING_RANGES.saturation.maximum
            )
        },
        toneMapping: {
            desaturationStrength: normalizeNumber(
                toneMapping.desaturationStrength,
                defaultRenderSettings.toneMapping.desaturationStrength,
                HDR_RENDER_SETTING_RANGES.desaturationStrength.minimum,
                HDR_RENDER_SETTING_RANGES.desaturationStrength.maximum
            ),
            exposure: normalizeNumber(
                toneMapping.exposure,
                defaultRenderSettings.toneMapping.exposure,
                HDR_RENDER_SETTING_RANGES.exposure.minimum,
                HDR_RENDER_SETTING_RANGES.exposure.maximum
            ),
            inputPeakNits,
            operator: normalizeToneMapOperator(
                toneMapping.operator,
                defaultRenderSettings.toneMapping.operator
            ),
            outputPeakNits: normalizeNumber(
                toneMapping.outputPeakNits,
                defaultRenderSettings.toneMapping.outputPeakNits,
                HDR_RENDER_SETTING_RANGES.outputPeakNits.minimum,
                HDR_RENDER_SETTING_RANGES.outputPeakNits.maximum
            ),
            paperWhiteNits
        }
    });

    const audio = getRecord(value, 'audio');
    const downmix = getRecord(audio, 'downmix');
    const defaultDownmix = defaults.audio.downmix;
    const osd = getRecord(value, 'osd');
    const playback = getRecord(value, 'playback');
    const presentation = getRecord(value, 'presentation');
    return {
        audio: {
            binauralHeadphones: normalizeBoolean(
                audio.binauralHeadphones,
                defaults.audio.binauralHeadphones
            ),
            downmix: {
                centerLevel: normalizeNumber(
                    downmix.centerLevel,
                    defaultDownmix.centerLevel,
                    AUDIO_DOWNMIX_SETTING_RANGES.centerLevel.minimum,
                    AUDIO_DOWNMIX_SETTING_RANGES.centerLevel.maximum
                ),
                outputGain: normalizeNumber(
                    downmix.outputGain,
                    defaultDownmix.outputGain,
                    AUDIO_DOWNMIX_SETTING_RANGES.outputGain.minimum,
                    AUDIO_DOWNMIX_SETTING_RANGES.outputGain.maximum
                ),
                surroundLevel: normalizeNumber(
                    downmix.surroundLevel,
                    defaultDownmix.surroundLevel,
                    AUDIO_DOWNMIX_SETTING_RANGES.surroundLevel.minimum,
                    AUDIO_DOWNMIX_SETTING_RANGES.surroundLevel.maximum
                ),
                version: AUDIO_DOWNMIX_SETTINGS_VERSION
            },
            forceStereoDownmix: normalizeBoolean(
                audio.forceStereoDownmix,
                defaults.audio.forceStereoDownmix
            ),
            outputDeviceId: normalizeAudioOutputDeviceId(audio.outputDeviceId),
            speakerLayout: isCustomAudioSpeakerLayout(audio.speakerLayout) ?
                audio.speakerLayout :
                defaults.audio.speakerLayout
        },
        osd: {
            settingsButtonPlacement: isSettingsButtonPlacement(osd.settingsButtonPlacement) ?
                osd.settingsButtonPlacement :
                defaults.osd.settingsButtonPlacement
        },
        playback: {
            enableCustomDecode: normalizeBoolean(
                playback.enableCustomDecode,
                defaults.playback.enableCustomDecode
            ),
            enableGPUDecodeSlicing: normalizeBoolean(
                playback.enableGPUDecodeSlicing,
                defaults.playback.enableGPUDecodeSlicing
            ),
            enableHDRToneMapping: normalizeBoolean(
                playback.enableHDRToneMapping,
                defaults.playback.enableHDRToneMapping
            )
        },
        presentation: {
            deinterlaceMode: DEINTERLACE_MODES.find((mode: DeinterlaceMode): boolean => mode === presentation.deinterlaceMode)
                ?? defaults.presentation.deinterlaceMode,
            files: Array.isArray(presentation.files) ? normalizePresentationFiles(presentation.files) : defaults.presentation.files,
            hdrOutput: normalizeBoolean(presentation.hdrOutput, defaults.presentation.hdrOutput)
        },
        render: {
            automaticInputPeakNits: normalizeBoolean(
                render.automaticInputPeakNits,
                defaults.render.automaticInputPeakNits
            ),
            settings
        },
        version: WEBGPU_USER_SETTINGS_VERSION
    };
}

/** Returns the leaves of settings that differ from the defaults, nested as in the settings; an array is one leaf. */
function getChangedSettings(settings: Record<string, unknown>, defaults: Record<string, unknown>): Record<string, unknown> {
    const changedSettings: Record<string, unknown> = {};
    for (const [ key, value ] of Object.entries(settings)) {
        const defaultValue = defaults[key];
        if (isRecord(value) && isRecord(defaultValue)) {
            const changedChild = getChangedSettings(value, defaultValue);
            if (Object.keys(changedChild).length > 0) {
                changedSettings[key] = changedChild;
            }
        } else if (Array.isArray(value) ? JSON.stringify(value) !== JSON.stringify(defaultValue) : value !== defaultValue) {
            changedSettings[key] = value;
        }
    }
    return changedSettings;
}

/** Reads stored settings over the current defaults; a version that stores no choice of the user's reads as the defaults. */
function readStoredSettings(value: unknown): WebGPUUserSettings {
    if (!isRecord(value)) {
        return createDefaultWebGPUUserSettings();
    }
    switch (value.version) {
        case WEBGPU_USER_SETTINGS_VERSION:
            return normalizeSettingsOver(value, createDefaultWebGPUUserSettings());
        case FULL_SNAPSHOT_SETTINGS_VERSION: {
            // A snapshot held every setting, so only its values that differ from the built-in defaults were the user's own choices
            const builtInSettings = createBuiltInWebGPUUserSettings();
            const snapshot = normalizeSettingsOver(value, builtInSettings);
            // Its empty preset was the default then, so it follows the server's default preset now
            const files = snapshot.presentation.files?.length === 0 ? null : snapshot.presentation.files;
            return normalizeSettingsOver(
                getChangedSettings({ ...snapshot, presentation: { ...snapshot.presentation, files } }, builtInSettings),
                createDefaultWebGPUUserSettings()
            );
        }
        default:
            return createDefaultWebGPUUserSettings();
    }
}

/** Loads local player settings: the user's own choices over the defaults. */
export function loadWebGPUUserSettings(storage: WebGPUUserSettingsStorage = currentSettings): WebGPUUserSettings {
    try {
        const serializedSettings = storage.get(WEBGPU_USER_SETTINGS_STORAGE_KEY, false);
        if (!serializedSettings) {
            return createDefaultWebGPUUserSettings();
        }
        return readStoredSettings(JSON.parse(serializedSettings));
    } catch {
        return createDefaultWebGPUUserSettings();
    }
}

/**
 * Persists only the settings that differ from the current defaults, so the others keep following the defaults, and returns the normalized settings.
 * A setting equal to its default at save time follows the default from then on.
 */
export function saveWebGPUUserSettings(
    settings: WebGPUUserSettings,
    storage: WebGPUUserSettingsStorage = currentSettings
): WebGPUUserSettings {
    const normalizedSettings = normalizeWebGPUUserSettings(settings);
    storage.set(
        WEBGPU_USER_SETTINGS_STORAGE_KEY,
        JSON.stringify({
            version: WEBGPU_USER_SETTINGS_VERSION,
            ...getChangedSettings(normalizedSettings, createDefaultWebGPUUserSettings())
        }),
        false
    );
    return normalizedSettings;
}

/** Builds a source's HDR render settings: automatic mode takes the detected input peak, clamped to the setting's range, and paper white never exceeds the input peak. */
export function createConfiguredHDRRenderSettings(
    settings: WebGPUUserSettings,
    detectedInputPeakNits: number
): HDRToSDRRenderSettings {
    const normalizedSettings = normalizeWebGPUUserSettings(settings);
    const configuredRenderSettings = normalizedSettings.render.settings;
    const inputPeakNits = normalizedSettings.render.automaticInputPeakNits ?
        normalizeNumber(
            detectedInputPeakNits,
            configuredRenderSettings.toneMapping.inputPeakNits,
            HDR_RENDER_SETTING_RANGES.inputPeakNits.minimum,
            HDR_RENDER_SETTING_RANGES.inputPeakNits.maximum
        ) :
        configuredRenderSettings.toneMapping.inputPeakNits;
    return createHDRToSDRRenderSettings({
        display: configuredRenderSettings.display,
        toneMapping: {
            ...configuredRenderSettings.toneMapping,
            inputPeakNits,
            paperWhiteNits: Math.min(
                configuredRenderSettings.toneMapping.paperWhiteNits,
                inputPeakNits
            )
        }
    });
}

/** Resets only tone-mapping and display settings. */
export function resetWebGPURenderSettings(settings: WebGPUUserSettings): WebGPUUserSettings {
    const defaults = createDefaultWebGPUUserSettings();
    const normalizedSettings = normalizeWebGPUUserSettings(settings);
    return {
        ...normalizedSettings,
        render: defaults.render
    };
}

/** Resets only audio output and downmix settings. */
export function resetWebGPUAudioSettings(settings: WebGPUUserSettings): WebGPUUserSettings {
    const defaults = createDefaultWebGPUUserSettings();
    const normalizedSettings = normalizeWebGPUUserSettings(settings);
    return {
        ...normalizedSettings,
        audio: defaults.audio
    };
}

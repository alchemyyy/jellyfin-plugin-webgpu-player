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
import { MAXIMUM_PARAMETER_COUNT } from 'webgpu-player/presentation/passes/PassLanguage';
import {
    DEFAULT_DEINTERLACE_MODE,
    DEINTERLACE_MODES,
    type DeinterlaceMode
} from 'webgpu-player/presentation/DeinterlaceTimeline';

export const WEBGPU_USER_SETTINGS_VERSION = 4;
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
        downmix: AudioDownmixSettings
        forceStereoDownmix: boolean
        outputDeviceId: string | null
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
        files: readonly StoredPresentationFile[]
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
function normalizePresentationParameters(value: unknown): Readonly<Record<string, number>> {
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
function normalizePresentationFiles(value: unknown): StoredPresentationFile[] {
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

/** Returns independent plugin defaults backed by renderer and downmix defaults. */
export function createDefaultWebGPUUserSettings(): WebGPUUserSettings {
    return {
        audio: {
            downmix: createDefaultAudioDownmixSettings(),
            forceStereoDownmix: false,
            outputDeviceId: null
        },
        playback: {
            enableCustomDecode: true,
            enableGPUDecodeSlicing: false,
            enableHDRToneMapping: true
        },
        presentation: {
            deinterlaceMode: DEFAULT_DEINTERLACE_MODE,
            files: [],
            hdrOutput: false
        },
        render: {
            automaticInputPeakNits: true,
            settings: createHDRToSDRRenderSettings()
        },
        version: WEBGPU_USER_SETTINGS_VERSION
    };
}

/** Normalizes persisted input through the same ranges consumed by renderer validation. */
export function normalizeWebGPUUserSettings(value: unknown): WebGPUUserSettings {
    const defaults = createDefaultWebGPUUserSettings();
    // Settings of any other version are not read
    if (!isRecord(value) || value.version !== WEBGPU_USER_SETTINGS_VERSION) {
        return defaults;
    }

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
    const playback = getRecord(value, 'playback');
    const presentation = getRecord(value, 'presentation');
    return {
        audio: {
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
            outputDeviceId: normalizeAudioOutputDeviceId(audio.outputDeviceId)
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
            files: normalizePresentationFiles(presentation.files),
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

/** Loads local player settings without adding server-side profile state. */
export function loadWebGPUUserSettings(storage: WebGPUUserSettingsStorage = currentSettings): WebGPUUserSettings {
    try {
        const serializedSettings = storage.get(WEBGPU_USER_SETTINGS_STORAGE_KEY, false);
        if (!serializedSettings) {
            return createDefaultWebGPUUserSettings();
        }
        return normalizeWebGPUUserSettings(JSON.parse(serializedSettings));
    } catch {
        return createDefaultWebGPUUserSettings();
    }
}

/** Persists a normalized local snapshot and returns that detached snapshot. */
export function saveWebGPUUserSettings(
    settings: WebGPUUserSettings,
    storage: WebGPUUserSettingsStorage = currentSettings
): WebGPUUserSettings {
    const normalizedSettings = normalizeWebGPUUserSettings(settings);
    storage.set(
        WEBGPU_USER_SETTINGS_STORAGE_KEY,
        JSON.stringify(normalizedSettings),
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

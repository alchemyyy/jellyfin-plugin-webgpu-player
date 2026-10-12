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
import type { PresentationPresetPass } from 'webgpu-player/presentation/WebGPUPresenter';

export const WEBGPU_USER_SETTINGS_VERSION = 3;
export const WEBGPU_USER_SETTINGS_STORAGE_KEY = 'webGPUPlaybackSettings';
// The versions the settings migrate from: version 1 had no audio output device, and neither had presentation settings
const PREVIOUS_WEBGPU_USER_SETTINGS_VERSIONS: readonly unknown[] = [ 1, 2 ];
const FIRST_AUDIO_OUTPUT_DEVICE_SETTINGS_VERSION = 2;
const MAXIMUM_AUDIO_OUTPUT_DEVICE_ID_LENGTH = 1_024;
/** The shader passes a preset holds at most. */
export const MAXIMUM_PRESENTATION_PASS_COUNT = 16;
/** The characters one pass's source holds at most, which keeps a full preset well inside local storage. */
export const MAXIMUM_PRESENTATION_PASS_SOURCE_LENGTH = 262_144;
/** The characters a stored parameter name holds at most; a longer name is no identifier a pass would declare, so it is dropped. */
export const MAXIMUM_PRESENTATION_PARAMETER_NAME_LENGTH = 256;
const NULL_CHARACTER = '\0';

export type WebGPUUserSettings = Readonly<{
    audio: Readonly<{
        downmix: AudioDownmixSettings
        forceStereoDownmix: boolean
        outputDeviceId: string | null
    }>
    // Both shape what the player negotiates with the server, so a change applies from the next playback
    playback: Readonly<{
        enableCustomDecode: boolean
        enableHDRToneMapping: boolean
    }>
    // Both apply live: the presenter replans the active session and keeps them for later ones
    presentation: Readonly<{
        hdrOutput: boolean
        passes: readonly PresentationPresetPass[]
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

/** Keeps the stored passes that hold a valid source, in order, up to the passes a preset holds at most. */
function normalizePresentationPasses(value: unknown): PresentationPresetPass[] {
    const passes: PresentationPresetPass[] = [];
    if (!Array.isArray(value)) {
        return passes;
    }
    for (const candidate of value) {
        if (passes.length >= MAXIMUM_PRESENTATION_PASS_COUNT) {
            break;
        }
        if (!isRecord(candidate) || !isPresentationPassSource(candidate.source)) {
            continue;
        }
        passes.push({ parameters: normalizePresentationParameters(candidate.parameters), source: candidate.source });
    }
    return passes;
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
            enableHDRToneMapping: true
        },
        presentation: {
            hdrOutput: false,
            passes: []
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
    if (!isRecord(value)
        || (value.version !== WEBGPU_USER_SETTINGS_VERSION
            && !PREVIOUS_WEBGPU_USER_SETTINGS_VERSIONS.includes(value.version))) {
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
            outputDeviceId: typeof value.version === 'number' && value.version >= FIRST_AUDIO_OUTPUT_DEVICE_SETTINGS_VERSION ?
                normalizeAudioOutputDeviceId(audio.outputDeviceId) :
                null
        },
        playback: {
            enableCustomDecode: normalizeBoolean(
                playback.enableCustomDecode,
                defaults.playback.enableCustomDecode
            ),
            enableHDRToneMapping: normalizeBoolean(
                playback.enableHDRToneMapping,
                defaults.playback.enableHDRToneMapping
            )
        },
        presentation: {
            hdrOutput: normalizeBoolean(presentation.hdrOutput, defaults.presentation.hdrOutput),
            passes: normalizePresentationPasses(presentation.passes)
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

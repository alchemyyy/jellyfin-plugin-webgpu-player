import { describe, expect, it, vi } from 'vitest';

vi.mock('scripts/settings/userSettings', () => ({
    currentSettings: {
        get: vi.fn(() => null),
        set: vi.fn()
    }
}));

import { MAXIMUM_PARAMETER_COUNT } from 'webgpu-player/presentation/passes/PassLanguage';
import {
    MAXIMUM_PRESENTATION_PARAMETER_NAME_LENGTH,
    MAXIMUM_PRESENTATION_FILE_COUNT,
    WEBGPU_USER_SETTINGS_STORAGE_KEY,
    WEBGPU_USER_SETTINGS_VERSION,
    createConfiguredHDRRenderSettings,
    createDefaultWebGPUUserSettings,
    loadWebGPUUserSettings,
    normalizeWebGPUUserSettings,
    resetWebGPUAudioSettings,
    resetWebGPURenderSettings,
    saveWebGPUUserSettings,
    type StoredPresentationFile,
    type WebGPUUserSettingsStorage
} from 'addons/webGPUPlayer/WebGPUUserSettings';
import { INVERT_PASS_SOURCE, SATURATION_PARAMETER_NAME, STORED_SATURATION } from './presentationPassSources';

const SELECTED_OUTPUT_DEVICE_ID = 'selected-output';
// Settings of any other version are not read
const EARLIER_SETTINGS_VERSION = WEBGPU_USER_SETTINGS_VERSION - 1;
// Stored parameter names and values that no pass parameter can have
const BLANK_PARAMETER_NAME = ' ';
const OVERSIZED_PARAMETER_NAME = 'p'.repeat(MAXIMUM_PRESENTATION_PARAMETER_NAME_LENGTH + 1);
const NON_FINITE_PARAMETER_VALUE = Number.POSITIVE_INFINITY;
const TEXT_PARAMETER_VALUE = '0.5';
// Keys of the pass source store, which count up from 1, and values no key can be
const SATURATION_SOURCE_KEY = 1;
const INVERT_SOURCE_KEY = 2;
const INVALID_SOURCE_KEYS: readonly unknown[] = [ 0, -1, 1.5, String(SATURATION_SOURCE_KEY), Number.NaN, Number.MAX_SAFE_INTEGER + 1 ];

function createStorage(initialValue: string | null = null): WebGPUUserSettingsStorage {
    let value = initialValue;
    return {
        get: vi.fn(() => value),
        set: vi.fn((_name: string, nextValue: string): void => {
            value = nextValue;
        })
    };
}

describe('WebGPUUserSettings', () => {
    it('uses independent qualified defaults for missing and malformed storage', () => {
        const first = loadWebGPUUserSettings(createStorage());
        const second = loadWebGPUUserSettings(createStorage('{bad json'));

        expect(first).toEqual(createDefaultWebGPUUserSettings());
        expect(second).toEqual(createDefaultWebGPUUserSettings());
        expect(first).not.toBe(second);
        expect(first.audio.downmix).not.toBe(second.audio.downmix);
    });

    it('falls back to defaults when local storage cannot be read', () => {
        const storage: WebGPUUserSettingsStorage = {
            get: vi.fn((): string => {
                throw new DOMException('Storage is unavailable', 'SecurityError');
            }),
            set: vi.fn()
        };

        expect(loadWebGPUUserSettings(storage)).toEqual(createDefaultWebGPUUserSettings());
    });

    it('normalizes persisted fields through renderer and downmix ranges', () => {
        const normalized = normalizeWebGPUUserSettings({
            audio: {
                downmix: {
                    centerLevel: 4,
                    outputGain: 30,
                    surroundLevel: -2
                },
                forceStereoDownmix: true,
                outputDeviceId: SELECTED_OUTPUT_DEVICE_ID
            },
            render: {
                automaticInputPeakNits: false,
                settings: {
                    display: {
                        brightness: 2,
                        contrast: 1.5,
                        saturation: Number.NaN
                    },
                    toneMapping: {
                        desaturationStrength: 0.6,
                        exposure: -20,
                        inputPeakNits: 120,
                        operator: 'aces',
                        outputPeakNits: 80,
                        paperWhiteNits: 203
                    }
                }
            },
            version: WEBGPU_USER_SETTINGS_VERSION
        });

        expect(normalized.audio).toEqual({
            downmix: {
                centerLevel: 2,
                outputGain: 10,
                surroundLevel: 0,
                version: 1
            },
            forceStereoDownmix: true,
            outputDeviceId: SELECTED_OUTPUT_DEVICE_ID
        });
        expect(normalized.render.settings.display).toEqual({
            brightness: 1,
            contrast: 1.5,
            saturation: 1
        });
        expect(normalized.render.settings.toneMapping).toEqual({
            desaturationStrength: 0.6,
            exposure: -16,
            inputPeakNits: 120,
            operator: 'aces',
            outputPeakNits: 80,
            paperWhiteNits: 120
        });
    });

    it('round-trips a normalized versioned snapshot in local storage', () => {
        const storage = createStorage();
        const settings = createDefaultWebGPUUserSettings();
        const changedSettings = {
            ...settings,
            audio: {
                ...settings.audio,
                forceStereoDownmix: true,
                outputDeviceId: 'per-origin-output-id'
            },
            presentation: {
                files: [ { parameters: { [SATURATION_PARAMETER_NAME]: STORED_SATURATION }, sourceKey: SATURATION_SOURCE_KEY } ],
                hdrOutput: true
            }
        };

        const saved = saveWebGPUUserSettings(changedSettings, storage);

        expect(storage.set).toHaveBeenCalledWith(WEBGPU_USER_SETTINGS_STORAGE_KEY, JSON.stringify(saved), false);
        expect(loadWebGPUUserSettings(storage)).toEqual(saved);
    });

    it('loads settings of any other version as the defaults', () => {
        const defaults = createDefaultWebGPUUserSettings();
        const earlierSettings = normalizeWebGPUUserSettings({
            ...defaults,
            audio: { ...defaults.audio, forceStereoDownmix: true, outputDeviceId: SELECTED_OUTPUT_DEVICE_ID },
            render: { ...defaults.render, automaticInputPeakNits: false },
            version: EARLIER_SETTINGS_VERSION
        });

        expect(earlierSettings).toEqual(defaults);
    });

    it('keeps valid stored shader files in order and drops invalid files and parameters', () => {
        const defaults = createDefaultWebGPUUserSettings();
        const normalized = normalizeWebGPUUserSettings({
            ...defaults,
            presentation: {
                files: [
                    {
                        parameters: {
                            [SATURATION_PARAMETER_NAME]: STORED_SATURATION,
                            [BLANK_PARAMETER_NAME]: STORED_SATURATION,
                            [OVERSIZED_PARAMETER_NAME]: STORED_SATURATION,
                            nonFinite: NON_FINITE_PARAMETER_VALUE,
                            text: TEXT_PARAMETER_VALUE
                        },
                        sourceKey: SATURATION_SOURCE_KEY
                    },
                    ...INVALID_SOURCE_KEYS.map((sourceKey: unknown): Record<string, unknown> => ({ parameters: {}, sourceKey })),
                    // A source is never part of the settings
                    { parameters: {}, source: INVERT_PASS_SOURCE },
                    { parameters: {} },
                    INVERT_PASS_SOURCE,
                    // Parameters that are not a record are dropped, not the file
                    { parameters: [ STORED_SATURATION ], sourceKey: INVERT_SOURCE_KEY }
                ],
                hdrOutput: true
            }
        });
        const malformed = normalizeWebGPUUserSettings({
            ...defaults,
            presentation: { files: INVERT_PASS_SOURCE, hdrOutput: String(true) }
        });

        expect(normalized.presentation).toEqual({
            files: [
                { parameters: { [SATURATION_PARAMETER_NAME]: STORED_SATURATION }, sourceKey: SATURATION_SOURCE_KEY },
                { parameters: {}, sourceKey: INVERT_SOURCE_KEY }
            ],
            hdrOutput: true
        });
        expect(malformed.presentation).toEqual(defaults.presentation);
    });

    it('caps stored shader files and their parameters at the first ones within the limits', () => {
        const parameters: Record<string, number> = {};
        for (let parameterIndex = 0; parameterIndex <= MAXIMUM_PARAMETER_COUNT; parameterIndex += 1) {
            parameters[`parameter${parameterIndex}`] = parameterIndex;
        }
        const files: StoredPresentationFile[] = [];
        for (let fileIndex = 0; fileIndex <= MAXIMUM_PRESENTATION_FILE_COUNT; fileIndex += 1) {
            // Distinct keys show the kept files' order
            files.push({ parameters, sourceKey: SATURATION_SOURCE_KEY + fileIndex });
        }
        const normalized = normalizeWebGPUUserSettings({
            ...createDefaultWebGPUUserSettings(),
            presentation: { files, hdrOutput: false }
        });

        expect(normalized.presentation.files).toHaveLength(MAXIMUM_PRESENTATION_FILE_COUNT);
        expect(normalized.presentation.files.map((file: StoredPresentationFile): number => file.sourceKey))
            .toEqual(files.slice(0, MAXIMUM_PRESENTATION_FILE_COUNT).map((file: StoredPresentationFile): number => file.sourceKey));
        expect(Object.keys(normalized.presentation.files[0].parameters))
            .toEqual(Object.keys(parameters).slice(0, MAXIMUM_PARAMETER_COUNT));
    });

    it('enables both playback features unless this browser stored a boolean choice', () => {
        const defaults = createDefaultWebGPUUserSettings();
        // Saved before the playback preferences existed
        const settingsWithoutPlayback = {
            audio: defaults.audio,
            render: defaults.render,
            version: defaults.version
        };

        expect(defaults.playback).toEqual({ enableCustomDecode: true, enableHDRToneMapping: true });
        expect(normalizeWebGPUUserSettings(settingsWithoutPlayback).playback).toEqual(defaults.playback);
        expect(normalizeWebGPUUserSettings({
            ...defaults,
            playback: { enableCustomDecode: false, enableHDRToneMapping: 'false' }
        }).playback).toEqual({ enableCustomDecode: false, enableHDRToneMapping: true });
    });

    it('keeps playback and presentation preferences across render and audio resets', () => {
        const defaults = createDefaultWebGPUUserSettings();
        const changed = normalizeWebGPUUserSettings({
            ...defaults,
            playback: { enableCustomDecode: false, enableHDRToneMapping: false },
            presentation: { files: [ { parameters: {}, sourceKey: INVERT_SOURCE_KEY } ], hdrOutput: true }
        });

        expect(resetWebGPURenderSettings(changed).playback).toEqual(changed.playback);
        expect(resetWebGPUAudioSettings(changed).playback).toEqual(changed.playback);
        expect(resetWebGPURenderSettings(changed).presentation).toEqual(changed.presentation);
        expect(resetWebGPUAudioSettings(changed).presentation).toEqual(changed.presentation);
    });

    it('rejects malformed and synthetic output device IDs', () => {
        const defaults = createDefaultWebGPUUserSettings();
        const syntheticDefault = normalizeWebGPUUserSettings({
            ...defaults,
            audio: { ...defaults.audio, outputDeviceId: 'default' }
        });
        const oversized = normalizeWebGPUUserSettings({
            ...defaults,
            audio: { ...defaults.audio, outputDeviceId: 'x'.repeat(1_025) }
        });

        expect(syntheticDefault.audio.outputDeviceId).toBeNull();
        expect(oversized.audio.outputDeviceId).toBeNull();
    });

    it('applies detected input peaks only in automatic mode', () => {
        const defaults = createDefaultWebGPUUserSettings();
        const automaticSettings = createConfiguredHDRRenderSettings(defaults, 4_000);
        const manualSettings = createConfiguredHDRRenderSettings({
            ...defaults,
            render: {
                automaticInputPeakNits: false,
                settings: defaults.render.settings
            }
        }, 4_000);

        expect(automaticSettings.toneMapping.inputPeakNits).toBe(4_000);
        expect(manualSettings.toneMapping.inputPeakNits).toBe(1_000);
    });

    it('clamps configured paper white to a lower detected input peak', () => {
        const defaults = createDefaultWebGPUUserSettings();
        const configuredSettings = createConfiguredHDRRenderSettings(defaults, 100);

        expect(configuredSettings.toneMapping).toMatchObject({
            inputPeakNits: 100,
            paperWhiteNits: 100
        });
    });

    it('resets render and audio sections independently', () => {
        const defaults = createDefaultWebGPUUserSettings();
        const changed = normalizeWebGPUUserSettings({
            ...defaults,
            audio: {
                downmix: {
                    centerLevel: 0.5,
                    outputGain: 0.7,
                    surroundLevel: 0.2,
                    version: 1
                },
                forceStereoDownmix: true,
                outputDeviceId: SELECTED_OUTPUT_DEVICE_ID
            },
            render: {
                automaticInputPeakNits: false,
                settings: {
                    ...defaults.render.settings,
                    display: {
                        ...defaults.render.settings.display,
                        brightness: 0.25
                    }
                }
            }
        });

        expect(resetWebGPURenderSettings(changed).render).toEqual(defaults.render);
        expect(resetWebGPURenderSettings(changed).audio).toEqual(changed.audio);
        expect(resetWebGPUAudioSettings(changed).audio).toEqual(defaults.audio);
        expect(resetWebGPUAudioSettings(changed).render).toEqual(changed.render);
    });
});

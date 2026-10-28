import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('scripts/settings/userSettings', () => ({
    currentSettings: {
        get: vi.fn(() => null),
        set: vi.fn()
    }
}));

import { DEINTERLACE_MODES } from 'webgpu-player/presentation/DeinterlaceTimeline';
import { MAXIMUM_PARAMETER_COUNT } from 'webgpu-player/presentation/passes/PassLanguage';
import { setClientDefaults } from 'addons/webGPUPlayer/ClientDefaults';
import {
    MAXIMUM_PRESENTATION_PARAMETER_NAME_LENGTH,
    MAXIMUM_PRESENTATION_FILE_COUNT,
    MAXIMUM_SERVER_PASS_FILE_NAME_LENGTH,
    WEBGPU_USER_SETTINGS_STORAGE_KEY,
    WEBGPU_USER_SETTINGS_VERSION,
    createBuiltInWebGPUUserSettings,
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
// The full snapshot each save stored before the settings followed the server's defaults
const FULL_SNAPSHOT_SETTINGS_VERSION = 4;
// Versions that store no choice of the user's: earlier ones, a later one, and none
const UNREAD_SETTINGS_VERSIONS: readonly unknown[] = [ 3, WEBGPU_USER_SETTINGS_VERSION + 1, String(WEBGPU_USER_SETTINGS_VERSION), undefined ];
// Stored parameter names and values that no pass parameter can have
const BLANK_PARAMETER_NAME = ' ';
const OVERSIZED_PARAMETER_NAME = 'p'.repeat(MAXIMUM_PRESENTATION_PARAMETER_NAME_LENGTH + 1);
const NON_FINITE_PARAMETER_VALUE = Number.POSITIVE_INFINITY;
const TEXT_PARAMETER_VALUE = '0.5';
// Keys of the pass source store, which count up from 1, and values no key can be
const SATURATION_SOURCE_KEY = 1;
const INVERT_SOURCE_KEY = 2;
const INVALID_SOURCE_KEYS: readonly unknown[] = [ 0, -1, 1.5, String(SATURATION_SOURCE_KEY), Number.NaN, Number.MAX_SAFE_INTEGER + 1 ];
// A server pass file version a stored file came from, and origins that name none
const SERVER_PASS_FILE_NAME = 'sharpen.wgsl';
const SERVER_CONTENT_HASH = 'c'.repeat(64);
const INVALID_SERVER_ORIGINS: readonly unknown[] = [
    null,
    SERVER_PASS_FILE_NAME,
    { contentHash: SERVER_CONTENT_HASH, fileName: ' ' },
    { contentHash: SERVER_CONTENT_HASH, fileName: 'p'.repeat(MAXIMUM_SERVER_PASS_FILE_NAME_LENGTH + 1) },
    { contentHash: 'C'.repeat(64), fileName: SERVER_PASS_FILE_NAME },
    { contentHash: SERVER_CONTENT_HASH.slice(1), fileName: SERVER_PASS_FILE_NAME }
];

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
    afterEach(() => {
        setClientDefaults({});
    });

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

    it('stores only the settings that differ from the defaults, and reads them back over the defaults', () => {
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
                deinterlaceMode: 'single-rate' as const,
                files: [ { parameters: { [SATURATION_PARAMETER_NAME]: STORED_SATURATION }, sourceKey: SATURATION_SOURCE_KEY } ],
                hdrOutput: true
            }
        };

        const saved = saveWebGPUUserSettings(changedSettings, storage);

        expect(storage.set).toHaveBeenCalledWith(WEBGPU_USER_SETTINGS_STORAGE_KEY, expect.any(String), false);
        expect(JSON.parse(storage.get(WEBGPU_USER_SETTINGS_STORAGE_KEY) ?? '')).toEqual({
            audio: { forceStereoDownmix: true, outputDeviceId: 'per-origin-output-id' },
            presentation: changedSettings.presentation,
            version: WEBGPU_USER_SETTINGS_VERSION
        });
        expect(loadWebGPUUserSettings(storage)).toEqual(saved);
        expect(saved.presentation).toEqual(changedSettings.presentation);
    });

    it('follows the server\'s default for each setting the user did not choose, and keeps the user\'s own choices', () => {
        const storage = createStorage(JSON.stringify({
            render: { settings: { display: { brightness: 0.75 } } },
            version: WEBGPU_USER_SETTINGS_VERSION
        }));
        const builtIn = createBuiltInWebGPUUserSettings();
        setClientDefaults({
            brightness: 0.5,
            contrast: 1.25,
            enableCustomDecode: false,
            settingsButtonPlacement: 'controls-end',
            toneMapOperator: 'aces'
        });

        const settings = loadWebGPUUserSettings(storage);

        expect(settings.render.settings.display).toEqual({ ...builtIn.render.settings.display, brightness: 0.75, contrast: 1.25 });
        expect(settings.render.settings.toneMapping).toEqual({ ...builtIn.render.settings.toneMapping, operator: 'aces' });
        expect(settings.playback).toEqual({ ...builtIn.playback, enableCustomDecode: false });
        expect(settings.osd.settingsButtonPlacement).toBe('controls-end');
        expect(settings.audio).toEqual(builtIn.audio);
    });

    it('reads a server default as a stored value: one out of range is clamped, and one the setting refuses leaves the built-in default', () => {
        const builtIn = createBuiltInWebGPUUserSettings();
        setClientDefaults({
            brightness: 5,
            centerLevel: 1.5,
            deinterlaceMode: 'bob',
            enableHDRToneMapping: 'false',
            exposure: 'bright',
            settingsButtonPlacement: 'top',
            toneMapOperator: 'hable'
        });

        const defaults = createDefaultWebGPUUserSettings();

        expect(defaults.render.settings.display.brightness).toBe(1);
        expect(defaults.audio.downmix.centerLevel).toBe(1.5);
        expect(defaults.presentation.deinterlaceMode).toBe(builtIn.presentation.deinterlaceMode);
        expect(defaults.playback.enableHDRToneMapping).toBe(builtIn.playback.enableHDRToneMapping);
        expect(defaults.render.settings.toneMapping.exposure).toBe(builtIn.render.settings.toneMapping.exposure);
        expect(defaults.osd.settingsButtonPlacement).toBe('before-settings');
        expect(defaults.render.settings.toneMapping.operator).toBe(builtIn.render.settings.toneMapping.operator);
    });

    it('drops a setting saved equal to its default, which then follows the default', () => {
        const storage = createStorage();
        setClientDefaults({ hdrOutput: true });
        const defaults = createDefaultWebGPUUserSettings();

        saveWebGPUUserSettings({ ...defaults, presentation: { ...defaults.presentation, hdrOutput: false } }, storage);
        expect(JSON.parse(storage.get(WEBGPU_USER_SETTINGS_STORAGE_KEY) ?? '')).toEqual({
            presentation: { hdrOutput: false },
            version: WEBGPU_USER_SETTINGS_VERSION
        });
        saveWebGPUUserSettings({ ...defaults, presentation: { ...defaults.presentation, hdrOutput: true } }, storage);
        expect(JSON.parse(storage.get(WEBGPU_USER_SETTINGS_STORAGE_KEY) ?? '')).toEqual({ version: WEBGPU_USER_SETTINGS_VERSION });
        setClientDefaults({ hdrOutput: false });

        expect(loadWebGPUUserSettings(storage).presentation.hdrOutput).toBe(false);
    });

    it('reads a full snapshot of version 4 as the user\'s choices where it differs from the built-in defaults', () => {
        const builtIn = createBuiltInWebGPUUserSettings();
        const storage = createStorage(JSON.stringify({
            ...builtIn,
            audio: { ...builtIn.audio, forceStereoDownmix: true },
            osd: undefined,
            version: FULL_SNAPSHOT_SETTINGS_VERSION
        }));
        setClientDefaults({ brightness: 0.5, forceStereoDownmix: false, hdrOutput: true });

        const settings = loadWebGPUUserSettings(storage);

        expect(settings.version).toBe(WEBGPU_USER_SETTINGS_VERSION);
        expect(settings.audio.forceStereoDownmix).toBe(true);
        // The snapshot held the built-in values, which follow the server's defaults now
        expect(settings.render.settings.display.brightness).toBe(0.5);
        expect(settings.presentation.hdrOutput).toBe(true);
    });

    it('loads settings of any other version as the defaults', () => {
        setClientDefaults({ brightness: 0.5 });
        const defaults = createDefaultWebGPUUserSettings();

        for (const version of UNREAD_SETTINGS_VERSIONS) {
            const storage = createStorage(JSON.stringify({
                ...defaults,
                audio: { ...defaults.audio, forceStereoDownmix: true, outputDeviceId: SELECTED_OUTPUT_DEVICE_ID },
                render: { ...defaults.render, automaticInputPeakNits: false },
                version
            }));

            expect(loadWebGPUUserSettings(storage)).toEqual(defaults);
        }
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
            deinterlaceMode: defaults.presentation.deinterlaceMode,
            files: [
                { parameters: { [SATURATION_PARAMETER_NAME]: STORED_SATURATION }, sourceKey: SATURATION_SOURCE_KEY },
                { parameters: {}, sourceKey: INVERT_SOURCE_KEY }
            ],
            hdrOutput: true
        });
        expect(malformed.presentation).toEqual(defaults.presentation);
    });

    it('follows the server\'s default shader preset until the user stores a preset of their own, even an empty one', () => {
        const storage = createStorage();
        const defaults = createDefaultWebGPUUserSettings();
        expect(defaults.presentation.files).toBeNull();

        saveWebGPUUserSettings({ ...defaults, presentation: { ...defaults.presentation, files: [] } }, storage);
        expect(JSON.parse(storage.get(WEBGPU_USER_SETTINGS_STORAGE_KEY) ?? '')).toEqual({
            presentation: { files: [] },
            version: WEBGPU_USER_SETTINGS_VERSION
        });
        expect(loadWebGPUUserSettings(storage).presentation.files).toEqual([]);

        saveWebGPUUserSettings({ ...defaults, presentation: { ...defaults.presentation, files: null } }, storage);
        expect(JSON.parse(storage.get(WEBGPU_USER_SETTINGS_STORAGE_KEY) ?? '')).toEqual({ version: WEBGPU_USER_SETTINGS_VERSION });
        expect(loadWebGPUUserSettings(storage).presentation.files).toBeNull();
        // A stored value that is no list of files follows the default too
        expect(normalizeWebGPUUserSettings({
            ...defaults,
            presentation: { files: { parameters: {}, sourceKey: SATURATION_SOURCE_KEY } }
        }).presentation.files).toBeNull();
    });

    it('reads an empty preset of a version 4 snapshot as following the server\'s default preset, and a preset with files as the user\'s own', () => {
        const builtIn = createBuiltInWebGPUUserSettings();
        const loadSnapshotFiles = (files: unknown): unknown => loadWebGPUUserSettings(createStorage(JSON.stringify({
            ...builtIn,
            presentation: { ...builtIn.presentation, files },
            version: FULL_SNAPSHOT_SETTINGS_VERSION
        }))).presentation.files;
        const files = [ { parameters: { [SATURATION_PARAMETER_NAME]: STORED_SATURATION }, sourceKey: SATURATION_SOURCE_KEY } ];

        expect(loadSnapshotFiles([])).toBeNull();
        expect(loadSnapshotFiles(files)).toEqual(files);
    });

    it('keeps a stored file\'s server origin only when it names one server file version', () => {
        const origin = { contentHash: SERVER_CONTENT_HASH, fileName: SERVER_PASS_FILE_NAME };
        const normalized = normalizeWebGPUUserSettings({
            ...createDefaultWebGPUUserSettings(),
            presentation: {
                files: [
                    { parameters: {}, server: origin, sourceKey: SATURATION_SOURCE_KEY },
                    ...INVALID_SERVER_ORIGINS.map((server: unknown, index: number): Record<string, unknown> => ({
                        parameters: {},
                        server,
                        sourceKey: INVERT_SOURCE_KEY + index
                    }))
                ],
                hdrOutput: false
            }
        });

        const files = normalized.presentation.files ?? [];
        expect(files[0]).toEqual({ parameters: {}, server: origin, sourceKey: SATURATION_SOURCE_KEY });
        expect(files.slice(1).every((file: StoredPresentationFile): boolean => file.server === undefined)).toBe(true);
        expect(files).toHaveLength(INVALID_SERVER_ORIGINS.length + 1);
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

        const normalizedFiles = normalized.presentation.files ?? [];
        expect(normalizedFiles).toHaveLength(MAXIMUM_PRESENTATION_FILE_COUNT);
        expect(normalizedFiles.map((file: StoredPresentationFile): number => file.sourceKey))
            .toEqual(files.slice(0, MAXIMUM_PRESENTATION_FILE_COUNT).map((file: StoredPresentationFile): number => file.sourceKey));
        expect(Object.keys(normalizedFiles[0].parameters))
            .toEqual(Object.keys(parameters).slice(0, MAXIMUM_PARAMETER_COUNT));
    });

    it('deinterlaces at double rate unless this browser stored one of the deinterlacing modes', () => {
        const defaults = createDefaultWebGPUUserSettings();
        const normalizeMode = (deinterlaceMode: unknown): unknown => normalizeWebGPUUserSettings({
            ...defaults,
            presentation: { ...defaults.presentation, deinterlaceMode }
        }).presentation.deinterlaceMode;

        expect(defaults.presentation.deinterlaceMode).toBe('double-rate');
        expect(DEINTERLACE_MODES.map(normalizeMode)).toEqual(DEINTERLACE_MODES);
        // Saved before the choice existed, or a value no presenter takes
        expect(normalizeWebGPUUserSettings({ ...defaults, presentation: { files: [], hdrOutput: true } }).presentation)
            .toEqual({ deinterlaceMode: 'double-rate', files: [], hdrOutput: true });
        for (const invalidMode of [ 'bob', 'Off', '', null, 1, true ]) {
            expect(normalizeMode(invalidMode)).toBe('double-rate');
        }
    });

    it('enables custom decode and HDR tone mapping, and leaves GPU decode slicing off, unless this browser stored a boolean choice', () => {
        const defaults = createDefaultWebGPUUserSettings();
        // Saved before the playback preferences existed
        const settingsWithoutPlayback = {
            audio: defaults.audio,
            render: defaults.render,
            version: defaults.version
        };

        expect(defaults.playback).toEqual({ enableCustomDecode: true, enableGPUDecodeSlicing: false, enableHDRToneMapping: true });
        expect(normalizeWebGPUUserSettings(settingsWithoutPlayback).playback).toEqual(defaults.playback);
        expect(normalizeWebGPUUserSettings({
            ...defaults,
            playback: { enableCustomDecode: false, enableGPUDecodeSlicing: 'true', enableHDRToneMapping: 'false' }
        }).playback).toEqual({ enableCustomDecode: false, enableGPUDecodeSlicing: false, enableHDRToneMapping: true });
        expect(normalizeWebGPUUserSettings({
            ...defaults,
            playback: { ...defaults.playback, enableGPUDecodeSlicing: true }
        }).playback.enableGPUDecodeSlicing).toBe(true);
    });

    it('keeps playback and presentation preferences across render and audio resets', () => {
        const defaults = createDefaultWebGPUUserSettings();
        const changed = normalizeWebGPUUserSettings({
            ...defaults,
            playback: { enableCustomDecode: false, enableGPUDecodeSlicing: true, enableHDRToneMapping: false },
            presentation: { deinterlaceMode: 'off', files: [ { parameters: {}, sourceKey: INVERT_SOURCE_KEY } ], hdrOutput: true }
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

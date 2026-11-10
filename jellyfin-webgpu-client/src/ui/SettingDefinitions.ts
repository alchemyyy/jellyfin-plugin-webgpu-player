import { AUDIO_DOWNMIX_SETTING_RANGES } from 'webgpu-player/audio/processing/CustomAudioDownmix';
import {
    CUSTOM_AUDIO_DOWNMIX_ALGORITHMS,
    type CustomAudioDownmixAlgorithm
} from 'webgpu-player/audio/processing/CustomAudioDownmixAlgorithm';
import type { CustomAudioSpeakerLayout } from 'webgpu-player/audio/NativeMultichannelAudioOutput';
import type { DeinterlaceMode } from 'webgpu-player/presentation/DeinterlaceTimeline';
import { HDR_RENDER_SETTING_RANGES, type ToneMapOperator } from 'webgpu-player/presentation/RenderSettings';

import type { DecoderTestDeviceType, DecoderTestTiming } from '../DecoderTestTiming';
import type { AddonStringKey } from '../host/globalize';
import { VideoPlayerPreference } from '../PreferredVideoPlayer';
import type { SettingsButtonPlacement } from '../SettingsButtonPlacement';
import { translateToHTML } from './SettingsPanelHTML';

// What the settings controls show: each numeric setting's label, description, slider span, range, and unit, and each select's options.
// The in-player settings windows render their controls from these, and so does every other surface that edits the same settings

export type NumericSettingKey =
    | 'brightness'
    | 'centerLevel'
    | 'contrast'
    | 'desaturationStrength'
    | 'exposure'
    | 'inputPeakNits'
    | 'outputGain'
    | 'outputPeakNits'
    | 'paperWhiteNits'
    | 'saturation'
    | 'surroundLevel';

export type NumericSettingRange = Readonly<{
    maximum: number
    minimum: number
    step: number
}>;

export type NumericControlConfiguration = Readonly<{
    descriptionKey: AddonStringKey
    key: NumericSettingKey
    labelKey: AddonStringKey
    // The engine's hard range, which a typed value may reach
    range: NumericSettingRange
    section: 'audio' | 'render'
    // The slider's span: the values worth sweeping through, inside the hard range, at its step
    sliderRange: NumericSettingRange
    unitKey?: AddonStringKey
}>;

/** One option of a select: its value, and its label's string key, or the name it shows untranslated, as a technology's name is. */
export type SettingOption<Value extends string> = Readonly<{
    labelKey?: string
    name?: string
    value: Value
}>;

/** Returns a slider's span over a hard range: the given bounds, at the hard range's step. */
function createSliderRange(range: NumericSettingRange, minimum: number, maximum: number): NumericSettingRange {
    return Object.freeze({ maximum, minimum, step: range.step });
}

/** The numeric settings, in the order the settings windows show them within each section. */
export const NUMERIC_CONTROL_CONFIGURATIONS: readonly NumericControlConfiguration[] = Object.freeze([
    {
        descriptionKey: 'WebGPUManualInputPeakHelp',
        key: 'inputPeakNits',
        labelKey: 'WebGPUManualInputPeak',
        range: HDR_RENDER_SETTING_RANGES.inputPeakNits,
        section: 'render',
        sliderRange: createSliderRange(HDR_RENDER_SETTING_RANGES.inputPeakNits, 100, 4000),
        unitKey: 'WebGPUUnitNits'
    },
    {
        descriptionKey: 'WebGPUOutputPeakHelp',
        key: 'outputPeakNits',
        labelKey: 'WebGPUOutputPeak',
        range: HDR_RENDER_SETTING_RANGES.outputPeakNits,
        section: 'render',
        sliderRange: createSliderRange(HDR_RENDER_SETTING_RANGES.outputPeakNits, 50, 1000),
        unitKey: 'WebGPUUnitNits'
    },
    {
        descriptionKey: 'WebGPUPaperWhiteHelp',
        key: 'paperWhiteNits',
        labelKey: 'WebGPUPaperWhite',
        range: HDR_RENDER_SETTING_RANGES.paperWhiteNits,
        section: 'render',
        sliderRange: createSliderRange(HDR_RENDER_SETTING_RANGES.paperWhiteNits, 50, 500),
        unitKey: 'WebGPUUnitNits'
    },
    {
        descriptionKey: 'WebGPUExposureHelp',
        key: 'exposure',
        labelKey: 'WebGPUExposure',
        range: HDR_RENDER_SETTING_RANGES.exposure,
        section: 'render',
        sliderRange: createSliderRange(HDR_RENDER_SETTING_RANGES.exposure, -4, 4),
        unitKey: 'WebGPUUnitStops'
    },
    {
        descriptionKey: 'WebGPUHighlightDesaturationHelp',
        key: 'desaturationStrength',
        labelKey: 'WebGPUHighlightDesaturation',
        range: HDR_RENDER_SETTING_RANGES.desaturationStrength,
        section: 'render',
        sliderRange: createSliderRange(HDR_RENDER_SETTING_RANGES.desaturationStrength, 0, 1)
    },
    {
        descriptionKey: 'WebGPUBrightnessHelp',
        key: 'brightness',
        labelKey: 'WebGPUBrightness',
        range: HDR_RENDER_SETTING_RANGES.brightness,
        section: 'render',
        sliderRange: createSliderRange(HDR_RENDER_SETTING_RANGES.brightness, -0.5, 0.5)
    },
    {
        descriptionKey: 'WebGPUContrastHelp',
        key: 'contrast',
        labelKey: 'WebGPUContrast',
        range: HDR_RENDER_SETTING_RANGES.contrast,
        section: 'render',
        sliderRange: createSliderRange(HDR_RENDER_SETTING_RANGES.contrast, 0.5, 2)
    },
    {
        descriptionKey: 'WebGPUSaturationHelp',
        key: 'saturation',
        labelKey: 'WebGPUSaturation',
        range: HDR_RENDER_SETTING_RANGES.saturation,
        section: 'render',
        sliderRange: createSliderRange(HDR_RENDER_SETTING_RANGES.saturation, 0, 2)
    },
    {
        descriptionKey: 'WebGPUCenterLevelHelp',
        key: 'centerLevel',
        labelKey: 'WebGPUCenterLevel',
        range: AUDIO_DOWNMIX_SETTING_RANGES.centerLevel,
        section: 'audio',
        sliderRange: createSliderRange(AUDIO_DOWNMIX_SETTING_RANGES.centerLevel, 0, 2)
    },
    {
        descriptionKey: 'WebGPUSurroundLevelHelp',
        key: 'surroundLevel',
        labelKey: 'WebGPUSurroundLevel',
        range: AUDIO_DOWNMIX_SETTING_RANGES.surroundLevel,
        section: 'audio',
        sliderRange: createSliderRange(AUDIO_DOWNMIX_SETTING_RANGES.surroundLevel, 0, 2)
    },
    {
        descriptionKey: 'WebGPUDownmixOutputGainHelp',
        key: 'outputGain',
        labelKey: 'WebGPUDownmixOutputGain',
        range: AUDIO_DOWNMIX_SETTING_RANGES.outputGain,
        section: 'audio',
        sliderRange: createSliderRange(AUDIO_DOWNMIX_SETTING_RANGES.outputGain, 0, 3)
    }
] satisfies NumericControlConfiguration[]);

export const TONE_MAP_OPERATOR_OPTIONS: ReadonlyArray<SettingOption<ToneMapOperator>> = Object.freeze([
    { labelKey: 'WebGPUToneMapOperatorSpline', value: 'spline' },
    { name: 'ACES', value: 'aces' },
    { name: 'Reinhard', value: 'reinhard' }
] satisfies Array<SettingOption<ToneMapOperator>>);

export const AUDIO_DOWNMIX_ALGORITHM_OPTIONS: ReadonlyArray<SettingOption<CustomAudioDownmixAlgorithm>> = Object.freeze([
    { labelKey: 'WebGPUDownmixAlgorithmStandardLORO', value: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.StandardLORO },
    { labelKey: 'WebGPUDownmixAlgorithmPeakNormalizedLORO', value: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.PeakNormalizedLORO },
    { name: 'AC-4', value: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.AC4 },
    { name: 'RFC 7845', value: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845 },
    { name: 'Dave750', value: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750 },
    { labelKey: 'WebGPUDownmixAlgorithmNightModeDialogue', value: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.NightModeDialogue }
] satisfies Array<SettingOption<CustomAudioDownmixAlgorithm>>);

// Auto is Jellyfin Web's own word; the channel layouts are names Jellyfin leaves untranslated
export const AUDIO_SPEAKER_LAYOUT_OPTIONS: ReadonlyArray<SettingOption<CustomAudioSpeakerLayout>> = Object.freeze([
    { labelKey: 'Auto', value: 'auto' },
    { labelKey: 'WebGPUSpeakerLayoutStereo', value: 'stereo' },
    { name: '5.1', value: '5.1' },
    { name: '7.1', value: '7.1' },
    { name: '5.1.2', value: '5.1.2' },
    { name: '5.1.4', value: '5.1.4' },
    { name: '7.1.2', value: '7.1.2' },
    { name: '7.1.4', value: '7.1.4' }
] satisfies Array<SettingOption<CustomAudioSpeakerLayout>>);

export const DECODER_TEST_TIMING_OPTIONS: ReadonlyArray<SettingOption<DecoderTestTiming>> = Object.freeze([
    { labelKey: 'WebGPUDecoderTestTimingAutomatic', value: 'automatic' },
    { labelKey: 'WebGPUDecoderTestTimingBackground', value: 'background' },
    { labelKey: 'WebGPUDecoderTestTimingPlayback', value: 'playback' }
] satisfies Array<SettingOption<DecoderTestTiming>>);

// The device types that rules and the administrator's checked types name, in the order of DECODER_TEST_DEVICE_TYPES
export const DECODER_TEST_DEVICE_TYPE_OPTIONS: ReadonlyArray<SettingOption<DecoderTestDeviceType>> = Object.freeze([
    { labelKey: 'WebGPUDecoderTestDeviceTypeDesktop', value: 'desktop' },
    { labelKey: 'WebGPUDecoderTestDeviceTypeMobile', value: 'mobile' },
    { labelKey: 'WebGPUDecoderTestDeviceTypeTV', value: 'tv' }
] satisfies Array<SettingOption<DecoderTestDeviceType>>);

// Off is Jellyfin Web's own word
export const DEINTERLACE_MODE_OPTIONS: ReadonlyArray<SettingOption<DeinterlaceMode>> = Object.freeze([
    { labelKey: 'WebGPUDeinterlaceDoubleRate', value: 'double-rate' },
    { labelKey: 'WebGPUDeinterlaceSingleRate', value: 'single-rate' },
    { labelKey: 'Off', value: 'off' }
] satisfies Array<SettingOption<DeinterlaceMode>>);

export const SETTINGS_BUTTON_PLACEMENT_OPTIONS: ReadonlyArray<SettingOption<SettingsButtonPlacement>> = Object.freeze([
    { labelKey: 'WebGPUSettingsButtonPlacementBeforeSettings', value: 'before-settings' },
    { labelKey: 'WebGPUSettingsButtonPlacementAfterSettings', value: 'after-settings' },
    { labelKey: 'WebGPUSettingsButtonPlacementControlsEnd', value: 'controls-end' },
    { labelKey: 'WebGPUSettingsButtonPlacementSettingsMenu', value: 'settings-menu' }
] satisfies Array<SettingOption<SettingsButtonPlacement>>);

// Auto is Jellyfin Web's own word; WebGPU and HTML name the two players, like the technology names Jellyfin leaves untranslated
export const VIDEO_PLAYER_PREFERENCE_OPTIONS: ReadonlyArray<SettingOption<VideoPlayerPreference>> = Object.freeze([
    { labelKey: 'Auto', value: VideoPlayerPreference.Auto },
    { name: 'WebGPU', value: VideoPlayerPreference.WEBGPU },
    { name: 'HTML', value: VideoPlayerPreference.HTML }
] satisfies Array<SettingOption<VideoPlayerPreference>>);

/** Returns a select's option elements, labelled through the strings, or with their untranslated names. */
export function createSettingOptionsHTML(options: ReadonlyArray<SettingOption<string>>): string {
    return options.map((option: SettingOption<string>): string => {
        const label = option.labelKey === undefined ? option.name ?? option.value : translateToHTML(option.labelKey);
        return `<option value="${option.value}">${label}</option>`;
    }).join('');
}

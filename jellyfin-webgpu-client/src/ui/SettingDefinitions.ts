import { AUDIO_DOWNMIX_SETTING_RANGES } from 'webgpu-player/audio/processing/CustomAudioDownmix';
import {
    CUSTOM_AUDIO_DOWNMIX_ALGORITHMS,
    type CustomAudioDownmixAlgorithm
} from 'webgpu-player/audio/processing/CustomAudioDownmixAlgorithm';
import type { CustomAudioSpeakerLayout } from 'webgpu-player/audio/NativeMultichannelAudioOutput';
import type { DeinterlaceMode } from 'webgpu-player/presentation/DeinterlaceTimeline';
import { HDR_RENDER_SETTING_RANGES, type ToneMapOperator } from 'webgpu-player/presentation/RenderSettings';

import type { AddonStringKey } from '../host/globalize';
import { VideoPlayerPreference } from '../PreferredVideoPlayer';
import type { SettingsButtonPlacement } from '../SettingsButtonPlacement';
import { translateToHTML } from './SettingsPanelHTML';

// What the settings controls show: each numeric setting's label, description, range, and unit, and each select's options.
// The playback settings panel renders its controls from these, and so does every other surface that edits the same settings

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
    range: NumericSettingRange
    section: 'audio' | 'render'
    unitKey?: AddonStringKey
}>;

/** One option of a select: its value, and its label's string key, or the name it shows untranslated, as a technology's name is. */
export type SettingOption<Value extends string> = Readonly<{
    labelKey?: string
    name?: string
    value: Value
}>;

/** The numeric settings, in the order the panel shows them within each section. */
export const NUMERIC_CONTROL_CONFIGURATIONS: readonly NumericControlConfiguration[] = Object.freeze([
    {
        descriptionKey: 'WebGPUManualInputPeakHelp',
        key: 'inputPeakNits',
        labelKey: 'WebGPUManualInputPeak',
        range: HDR_RENDER_SETTING_RANGES.inputPeakNits,
        section: 'render',
        unitKey: 'WebGPUUnitNits'
    },
    {
        descriptionKey: 'WebGPUOutputPeakHelp',
        key: 'outputPeakNits',
        labelKey: 'WebGPUOutputPeak',
        range: HDR_RENDER_SETTING_RANGES.outputPeakNits,
        section: 'render',
        unitKey: 'WebGPUUnitNits'
    },
    {
        descriptionKey: 'WebGPUPaperWhiteHelp',
        key: 'paperWhiteNits',
        labelKey: 'WebGPUPaperWhite',
        range: HDR_RENDER_SETTING_RANGES.paperWhiteNits,
        section: 'render',
        unitKey: 'WebGPUUnitNits'
    },
    {
        descriptionKey: 'WebGPUExposureHelp',
        key: 'exposure',
        labelKey: 'WebGPUExposure',
        range: HDR_RENDER_SETTING_RANGES.exposure,
        section: 'render',
        unitKey: 'WebGPUUnitStops'
    },
    {
        descriptionKey: 'WebGPUHighlightDesaturationHelp',
        key: 'desaturationStrength',
        labelKey: 'WebGPUHighlightDesaturation',
        range: HDR_RENDER_SETTING_RANGES.desaturationStrength,
        section: 'render'
    },
    {
        descriptionKey: 'WebGPUBrightnessHelp',
        key: 'brightness',
        labelKey: 'WebGPUBrightness',
        range: HDR_RENDER_SETTING_RANGES.brightness,
        section: 'render'
    },
    {
        descriptionKey: 'WebGPUContrastHelp',
        key: 'contrast',
        labelKey: 'WebGPUContrast',
        range: HDR_RENDER_SETTING_RANGES.contrast,
        section: 'render'
    },
    {
        descriptionKey: 'WebGPUSaturationHelp',
        key: 'saturation',
        labelKey: 'WebGPUSaturation',
        range: HDR_RENDER_SETTING_RANGES.saturation,
        section: 'render'
    },
    {
        descriptionKey: 'WebGPUCenterLevelHelp',
        key: 'centerLevel',
        labelKey: 'WebGPUCenterLevel',
        range: AUDIO_DOWNMIX_SETTING_RANGES.centerLevel,
        section: 'audio'
    },
    {
        descriptionKey: 'WebGPUSurroundLevelHelp',
        key: 'surroundLevel',
        labelKey: 'WebGPUSurroundLevel',
        range: AUDIO_DOWNMIX_SETTING_RANGES.surroundLevel,
        section: 'audio'
    },
    {
        descriptionKey: 'WebGPUDownmixOutputGainHelp',
        key: 'outputGain',
        labelKey: 'WebGPUDownmixOutputGain',
        range: AUDIO_DOWNMIX_SETTING_RANGES.outputGain,
        section: 'audio'
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

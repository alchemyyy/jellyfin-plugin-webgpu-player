import escapeHtml from 'escape-html';

import layoutManager from 'components/layoutManager';
import globalize from 'lib/globalize';

import type { AddonStringKey } from '../host/globalize';
import { webGPUAudioDownmixAlgorithm } from '../shims/userSettings';
import { scheduleSelectLabelFallback } from './SelectLabelFallback';

import 'elements/emby-button/emby-button';
import 'elements/emby-button/paper-icon-button-light';
import 'elements/emby-checkbox/emby-checkbox';
import 'elements/emby-input/emby-input';
import 'elements/emby-select/emby-select';
import 'elements/emby-slider/emby-slider';
import 'material-design-icons-iconfont';

import {
    HDR_RENDER_SETTING_RANGES,
    type RenderSettings
} from 'webgpu-player/presentation/RenderSettings';
import type WebGPUPlayer from '../WebGPUPlayer';
import {
    getWebGPUAudioOutputManager,
    type WebGPUAudioOutputMessageCode,
    type WebGPUAudioOutputSnapshot
} from 'webgpu-player/audio/output/WebGPUAudioOutputManager';
import {
    createConfiguredHDRRenderSettings,
    createDefaultWebGPUUserSettings,
    loadWebGPUUserSettings,
    normalizeWebGPUUserSettings,
    resetWebGPUAudioSettings,
    resetWebGPURenderSettings,
    saveWebGPUUserSettings,
    type WebGPUUserSettings
} from '../WebGPUUserSettings';
import { AUDIO_DOWNMIX_SETTING_RANGES } from 'webgpu-player/audio/processing/CustomAudioDownmix';
import {
    CUSTOM_AUDIO_DOWNMIX_ALGORITHMS,
    DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM,
    normalizeCustomAudioDownmixAlgorithm,
    type CustomAudioDownmixAlgorithm
} from 'webgpu-player/audio/processing/CustomAudioDownmixAlgorithm';

import './WebGPUPlaybackSettingsDialog.scss';

type NumericSettingKey =
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

type DefaultSettingKey =
    | NumericSettingKey
    | 'audioDownmixAlgorithm'
    | 'automaticInputPeakNits'
    | 'enableCustomDecode'
    | 'enableHDRToneMapping'
    | 'forceStereoDownmix'
    | 'operator';

type NumericSettingRange = Readonly<{
    maximum: number
    minimum: number
    step: number
}>;

type NumericControlConfiguration = Readonly<{
    descriptionKey: AddonStringKey
    key: NumericSettingKey
    labelKey: AddonStringKey
    range: NumericSettingRange
    section: 'audio' | 'render'
    unitKey?: AddonStringKey
}>;

type ActivePanel = {
    close: () => void
    element: HTMLElement
    promise: Promise<void>
};

const PLAYBACK_INFO_GAP_PX = 8;
const PLAYBACK_INFO_SELECTOR = '.playerStats';
const PANEL_TOP_PROPERTY = '--webgpu-settings-top';

const NUMERIC_CONTROL_CONFIGURATIONS: NumericControlConfiguration[] = [];
NUMERIC_CONTROL_CONFIGURATIONS.push(
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
);

let activePanel: ActivePanel | null = null;

function getNumericSetting(
    settings: WebGPUUserSettings,
    key: NumericSettingKey
): number {
    switch (key) {
        case 'brightness':
            return settings.render.settings.display.brightness;
        case 'centerLevel':
            return settings.audio.downmix.centerLevel;
        case 'contrast':
            return settings.render.settings.display.contrast;
        case 'desaturationStrength':
            return settings.render.settings.toneMapping.desaturationStrength;
        case 'exposure':
            return settings.render.settings.toneMapping.exposure;
        case 'inputPeakNits':
            return settings.render.settings.toneMapping.inputPeakNits;
        case 'outputGain':
            return settings.audio.downmix.outputGain;
        case 'outputPeakNits':
            return settings.render.settings.toneMapping.outputPeakNits;
        case 'paperWhiteNits':
            return settings.render.settings.toneMapping.paperWhiteNits;
        case 'saturation':
            return settings.render.settings.display.saturation;
        case 'surroundLevel':
            return settings.audio.downmix.surroundLevel;
    }
}

function updateNumericSetting(
    settings: WebGPUUserSettings,
    key: NumericSettingKey,
    value: number
): WebGPUUserSettings {
    const renderSettings = settings.render.settings;
    switch (key) {
        case 'brightness':
        case 'contrast':
        case 'saturation':
            return normalizeWebGPUUserSettings({
                ...settings,
                render: {
                    ...settings.render,
                    settings: {
                        ...renderSettings,
                        display: {
                            ...renderSettings.display,
                            [key]: value
                        }
                    }
                }
            });
        case 'desaturationStrength':
        case 'exposure':
        case 'inputPeakNits':
        case 'outputPeakNits':
        case 'paperWhiteNits':
            return normalizeWebGPUUserSettings({
                ...settings,
                render: {
                    ...settings.render,
                    settings: {
                        ...renderSettings,
                        toneMapping: {
                            ...renderSettings.toneMapping,
                            [key]: value
                        }
                    }
                }
            });
        case 'centerLevel':
        case 'outputGain':
        case 'surroundLevel':
            return normalizeWebGPUUserSettings({
                ...settings,
                audio: {
                    ...settings.audio,
                    downmix: {
                        ...settings.audio.downmix,
                        [key]: value
                    }
                }
            });
    }
}

/** Translates a key for the panel's HTML, escaped because translations may contain markup characters. */
function translateToHTML(key: string, ...replacements: unknown[]): string {
    return escapeHtml(globalize.translate(key, ...replacements));
}

function createDefaultButtonHTML(
    settingKey: DefaultSettingKey,
    settingName: string
): string {
    return `
        <button
            aria-label="${translateToHTML('WebGPURestoreSettingDefault', settingName)}"
            class="raised webgpuSettingsDefaultButton"
            data-default-setting="${settingKey}"
            is="emby-button"
            type="button"
        >${translateToHTML('Default')}</button>`;
}

function createNumericControlHTML(configuration: NumericControlConfiguration): string {
    const settingKey = configuration.key;
    const range = configuration.range;
    const label = globalize.translate(configuration.labelKey);
    const description = translateToHTML(configuration.descriptionKey);
    const labelText = configuration.unitKey ?
        translateToHTML('WebGPUSettingWithUnit', label, globalize.translate(configuration.unitKey)) :
        escapeHtml(label);
    return `
        <div
            class="webgpuSettingsNumericControl"
            data-setting="${settingKey}"
            title="${description}"
        >
            <div class="webgpuSettingsNumericRow">
                <label class="webgpuSettingsControlLabel" for="webgpu-${settingKey}-slider">
                    ${labelText}
                </label>
                <div class="webgpuSettingsSliderContainer">
                    <input
                        aria-describedby="webgpu-${settingKey}-description"
                        id="webgpu-${settingKey}-slider"
                        class="webgpuSettingsSlider"
                        data-setting-slider="${settingKey}"
                        is="emby-slider"
                        max="${range.maximum}"
                        min="${range.minimum}"
                        step="${range.step}"
                        type="range"
                    />
                </div>
                <div class="webgpuSettingsNumberContainer">
                    <input
                        aria-describedby="webgpu-${settingKey}-description"
                        aria-label="${translateToHTML('WebGPUSettingNumericValue', label)}"
                        class="webgpuSettingsNumber"
                        data-setting-number="${settingKey}"
                        is="emby-input"
                        max="${range.maximum}"
                        min="${range.minimum}"
                        step="${range.step}"
                        type="number"
                    />
                </div>
                ${createDefaultButtonHTML(settingKey, label)}
            </div>
            <div
                class="webgpuSettingsControlDescription"
                id="webgpu-${settingKey}-description"
            >${description}</div>
        </div>`;
}

function createSectionControlsHTML(section: 'audio' | 'render'): string {
    let controlsHTML = '';
    for (const configuration of NUMERIC_CONTROL_CONFIGURATIONS) {
        if (configuration.section === section) {
            controlsHTML += createNumericControlHTML(configuration);
        }
    }
    return controlsHTML;
}

function createPanelHTML(): string {
    return `
        <button
            aria-label="${translateToHTML('WebGPUCloseSettings')}"
            class="webgpuSettingsClose"
            is="paper-icon-button-light"
            title="${translateToHTML('ButtonClose')}"
            type="button"
        ><span class="material-icons close" aria-hidden="true"></span></button>
        <div class="webgpuSettingsContent">
                <h2 class="webgpuSettingsTitle" id="webgpu-settings-title">${translateToHTML('WebGPUSettings')}</h2>
                <section class="webgpuSettingsSection" aria-labelledby="webgpu-playback-title">
                    <h3 class="webgpuSettingsSectionTitle" id="webgpu-playback-title">
                        ${translateToHTML('WebGPUPlayback')}
                    </h3>
                    <div class="webgpuSettingsCheckboxRow">
                        <label class="checkboxContainer">
                            <input
                                data-setting-checkbox="enableCustomDecode"
                                is="emby-checkbox"
                                type="checkbox"
                            />
                            <span>${translateToHTML('WebGPUEnableCustomDecode')}</span>
                        </label>
                        ${createDefaultButtonHTML(
                            'enableCustomDecode',
                            globalize.translate('WebGPUSettingNameCustomDecode')
                        )}
                    </div>
                    <div class="fieldDescription webgpuSettingsCheckboxDescription">
                        ${translateToHTML('WebGPUEnableCustomDecodeHelp')}
                    </div>
                    <div class="webgpuSettingsCheckboxRow">
                        <label class="checkboxContainer">
                            <input
                                data-setting-checkbox="enableHDRToneMapping"
                                is="emby-checkbox"
                                type="checkbox"
                            />
                            <span>${translateToHTML('WebGPUEnableHDRToneMapping')}</span>
                        </label>
                        ${createDefaultButtonHTML(
                            'enableHDRToneMapping',
                            globalize.translate('WebGPUSettingNameHDRToneMapping')
                        )}
                    </div>
                    <div class="fieldDescription webgpuSettingsCheckboxDescription">
                        ${translateToHTML('WebGPUEnableHDRToneMappingHelp')}
                    </div>
                    <div class="webgpuSettingsStatus" data-playback-status role="status">
                        ${translateToHTML('WebGPUPlaybackChangesRestartRequired')}
                    </div>
                </section>

                <section class="webgpuSettingsSection" aria-labelledby="webgpu-tone-mapping-title">
                    <h3 class="webgpuSettingsSectionTitle" id="webgpu-tone-mapping-title">
                        ${translateToHTML('WebGPUToneMappingAndDisplay')}
                    </h3>
                    <div class="webgpuSettingsSelectRow">
                        <div class="selectContainer webgpuSettingsSelectContainer">
                            <select
                                data-setting-select="operator"
                                id="webgpu-tone-map-operator"
                                is="emby-select"
                                label="${translateToHTML('WebGPUToneMapOperator')}"
                            >
                                <option value="spline">${translateToHTML('WebGPUToneMapOperatorSpline')}</option>
                                <option value="aces">ACES</option>
                                <option value="reinhard">Reinhard</option>
                            </select>
                        </div>
                        ${createDefaultButtonHTML(
                            'operator',
                            globalize.translate('WebGPUSettingNameToneMapOperator')
                        )}
                    </div>
                    <div class="webgpuSettingsCheckboxRow">
                        <label class="checkboxContainer">
                            <input
                                data-setting-checkbox="automaticInputPeakNits"
                                is="emby-checkbox"
                                type="checkbox"
                            />
                            <span>${translateToHTML('WebGPUTrackSourcePeakMetadata')}</span>
                        </label>
                        ${createDefaultButtonHTML(
                            'automaticInputPeakNits',
                            globalize.translate('WebGPUSettingNameSourcePeakTracking')
                        )}
                    </div>
                    <div class="fieldDescription webgpuSettingsCheckboxDescription">
                        ${translateToHTML('WebGPUTrackSourcePeakMetadataHelp')}
                    </div>
                    ${createSectionControlsHTML('render')}
                    <div class="webgpuSettingsStatus" data-render-status role="status"></div>
                    <button
                        class="raised webgpuSettingsResetRender"
                        is="emby-button"
                        type="button"
                    >${translateToHTML('WebGPUResetToneMappingAndDisplay')}</button>
                </section>

                <section class="webgpuSettingsSection" aria-labelledby="webgpu-audio-title">
                    <h3 class="webgpuSettingsSectionTitle" id="webgpu-audio-title">
                        ${translateToHTML('WebGPUAudioOutputAndDownmix')}
                    </h3>
                    <div class="webgpuSettingsSelectRow">
                        <div class="selectContainer webgpuSettingsSelectContainer">
                            <select
                                aria-describedby="webgpu-audio-output-description"
                                data-audio-output-select
                                id="webgpu-audio-output"
                                is="emby-select"
                                label="${translateToHTML('WebGPUAudioOutput')}"
                            ></select>
                        </div>
                        <button
                            class="raised webgpuSettingsChooseAudioOutput"
                            data-audio-output-picker
                            is="emby-button"
                            type="button"
                        >${translateToHTML('WebGPUChooseAudioOutput')}</button>
                        <button
                            class="raised webgpuSettingsRedetectAudioOutput"
                            data-audio-output-redetect
                            is="emby-button"
                            title="${translateToHTML('WebGPURedetectAudioOutputHelp')}"
                            type="button"
                        >${translateToHTML('WebGPURedetectAudioOutput')}</button>
                    </div>
                    <div
                        class="fieldDescription"
                        id="webgpu-audio-output-description"
                    >${translateToHTML('WebGPUAudioOutputDescription')}</div>
                    <div
                        aria-live="polite"
                        class="webgpuSettingsStatus"
                        data-audio-output-status
                        role="status"
                    ></div>
                    <div class="webgpuSettingsSelectRow">
                        <div class="selectContainer webgpuSettingsSelectContainer">
                            <select
                                aria-describedby="webgpu-audio-downmix-algorithm-description"
                                data-setting-select="audioDownmixAlgorithm"
                                id="webgpu-audio-downmix-algorithm"
                                is="emby-select"
                                label="${translateToHTML('WebGPUDownmixAlgorithm')}"
                            >
                                <option value="${CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.StandardLORO}">
                                    ${translateToHTML('WebGPUDownmixAlgorithmStandardLORO')}
                                </option>
                                <option value="${CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.PeakNormalizedLORO}">
                                    ${translateToHTML('WebGPUDownmixAlgorithmPeakNormalizedLORO')}
                                </option>
                                <option value="${CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.AC4}">AC-4</option>
                                <option value="${CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845}">
                                    RFC 7845
                                </option>
                                <option value="${CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750}">
                                    Dave750
                                </option>
                                <option value="${CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.NightModeDialogue}">
                                    ${translateToHTML('WebGPUDownmixAlgorithmNightModeDialogue')}
                                </option>
                            </select>
                        </div>
                        ${createDefaultButtonHTML(
                            'audioDownmixAlgorithm',
                            globalize.translate('WebGPUSettingNameDownmixAlgorithm')
                        )}
                    </div>
                    <div
                        class="fieldDescription"
                        id="webgpu-audio-downmix-algorithm-description"
                    >${translateToHTML('WebGPUAudioDownmixAlgorithmHelp')}</div>
                    <div class="webgpuSettingsCheckboxRow">
                        <label class="checkboxContainer">
                            <input
                                data-setting-checkbox="forceStereoDownmix"
                                is="emby-checkbox"
                                type="checkbox"
                            />
                            <span>${translateToHTML('WebGPUForceStereo')}</span>
                        </label>
                        ${createDefaultButtonHTML(
                            'forceStereoDownmix',
                            globalize.translate('WebGPUSettingNameForceStereo')
                        )}
                    </div>
                    <div class="fieldDescription webgpuSettingsCheckboxDescription">
                        ${translateToHTML('WebGPUForceStereoHelp')}
                    </div>
                    ${createSectionControlsHTML('audio')}
                    <div class="fieldDescription webgpuSettingsSafetyDescription">
                        ${translateToHTML('WebGPUDownmixGainsHelp')}
                    </div>
                    <div class="webgpuSettingsStatus" data-audio-status role="status">
                        ${translateToHTML('WebGPUAudioSettingsApplyHelp')}
                    </div>
                    <button
                        class="raised webgpuSettingsResetAudio"
                        is="emby-button"
                        type="button"
                    >${translateToHTML('WebGPUResetAudio')}</button>
                </section>

                <div class="webgpuSettingsFooter">
                    <button
                        class="raised webgpuSettingsResetAll"
                        is="emby-button"
                        type="button"
                    >${translateToHTML('WebGPUResetAll')}</button>
                </div>
        </div>`;
}

function requireElement<ElementType extends Element>(
    parent: ParentNode,
    selector: string
): ElementType {
    const element = parent.querySelector<ElementType>(selector);
    if (!element) {
        throw new Error(`WebGPU settings panel is missing ${selector}`);
    }
    return element;
}

function setStatus(element: HTMLElement, message: string): void {
    element.textContent = message;
}

function getAudioOutputMessageTranslationKey(
    messageCode: WebGPUAudioOutputMessageCode
): AddonStringKey {
    switch (messageCode) {
        case 'applying':
            return 'WebGPUAudioOutputStatusApplying';
        case 'default-active':
            return 'WebGPUAudioOutputStatusDefaultActive';
        case 'default-enumeration-failed':
            return 'WebGPUAudioOutputStatusDefaultEnumerationFailed';
        case 'default-fallback':
            return 'WebGPUAudioOutputStatusDefaultFallback';
        case 'default-saved':
            return 'WebGPUAudioOutputStatusDefaultSaved';
        case 'picker-cancelled':
            return 'WebGPUAudioOutputStatusPickerCancelled';
        case 'picker-failed':
            return 'WebGPUAudioOutputStatusPickerFailed';
        case 'picker-invalid-device':
            return 'WebGPUAudioOutputStatusPickerInvalidDevice';
        case 'picker-not-allowed':
            return 'WebGPUAudioOutputStatusPickerNotAllowed';
        case 'picker-not-found':
            return 'WebGPUAudioOutputStatusPickerNotFound';
        case 'picker-unavailable':
            return 'WebGPUAudioOutputStatusPickerUnavailable';
        case 'picker-user-action-required':
            return 'WebGPUAudioOutputStatusPickerUserActionRequired';
        case 'route-failed':
            return 'WebGPUAudioOutputStatusRouteFailed';
        case 'selected-active':
            return 'WebGPUAudioOutputStatusSelectedActive';
        case 'selected-enumeration-failed':
            return 'WebGPUAudioOutputStatusSelectedEnumerationFailed';
        case 'selected-fallback':
            return 'WebGPUAudioOutputStatusSelectedFallback';
        case 'selected-saved':
            return 'WebGPUAudioOutputStatusSelectedSaved';
        case 'selected-unavailable-default':
            return 'WebGPUAudioOutputStatusSelectedUnavailableDefault';
        case 'selected-unavailable-fallback':
            return 'WebGPUAudioOutputStatusSelectedUnavailableFallback';
    }
}

function getMissingSelectedOutputLabel(snapshot: WebGPUAudioOutputSnapshot): string {
    const selectedDeviceActive = snapshot.selectedDeviceId !== null
        && snapshot.activeDeviceId === snapshot.selectedDeviceId;
    if (selectedDeviceActive || snapshot.selectedDeviceAvailability === 'active') {
        return globalize.translate('WebGPUSelectedAudioOutputActive');
    }
    switch (snapshot.selectedDeviceAvailability) {
        case 'available':
            return globalize.translate('WebGPUSelectedAudioOutputAvailable');
        case 'unavailable':
            return globalize.translate('WebGPUPreviouslySelectedAudioOutputUnavailable');
        case 'unknown':
            return globalize.translate('WebGPUSelectedAudioOutputAvailabilityUnknown');
    }
}

function positionPanelBelowPlaybackInfo(panel: HTMLElement): void {
    let playbackInfoBottom: number | null = null;
    const playbackInfoElements = document.querySelectorAll<HTMLElement>(
        PLAYBACK_INFO_SELECTOR
    );
    for (const playbackInfoElement of playbackInfoElements) {
        if (playbackInfoElement.classList.contains('hide')) {
            continue;
        }
        const playbackInfoBounds = playbackInfoElement.getBoundingClientRect();
        if (playbackInfoBounds.width <= 0 || playbackInfoBounds.height <= 0) {
            continue;
        }
        playbackInfoBottom = Math.max(
            playbackInfoBottom ?? 0,
            playbackInfoBounds.bottom
        );
    }

    if (playbackInfoBottom === null) {
        panel.style.removeProperty(PANEL_TOP_PROPERTY);
        return;
    }
    panel.style.setProperty(
        PANEL_TOP_PROPERTY,
        `${Math.ceil(playbackInfoBottom + PLAYBACK_INFO_GAP_PX)}px`
    );
}

function createPanelController(
    player: WebGPUPlayer,
    invokingElement: HTMLElement | null
): ActivePanel {
    const panel = document.createElement('aside');
    panel.classList.add('webgpuSettingsPanel');
    if (layoutManager.tv) {
        panel.classList.add('webgpuSettingsPanel-tv');
    }
    panel.setAttribute('aria-labelledby', 'webgpu-settings-title');
    panel.innerHTML = createPanelHTML();

    const cleanupCallbacks: Array<() => void> = [];
    const renderStatus = requireElement<HTMLElement>(panel, '[data-render-status]');
    const audioStatus = requireElement<HTMLElement>(panel, '[data-audio-status]');
    const audioOutputStatus = requireElement<HTMLElement>(
        panel,
        '[data-audio-output-status]'
    );
    const audioOutputSelect = requireElement<HTMLSelectElement>(
        panel,
        '[data-audio-output-select]'
    );
    const audioOutputPicker = requireElement<HTMLButtonElement>(
        panel,
        '[data-audio-output-picker]'
    );
    const audioOutputRedetect = requireElement<HTMLButtonElement>(
        panel,
        '[data-audio-output-redetect]'
    );
    const automaticInputPeakCheckbox = requireElement<HTMLInputElement>(
        panel,
        '[data-setting-checkbox="automaticInputPeakNits"]'
    );
    const forceStereoCheckbox = requireElement<HTMLInputElement>(
        panel,
        '[data-setting-checkbox="forceStereoDownmix"]'
    );
    const customDecodeCheckbox = requireElement<HTMLInputElement>(
        panel,
        '[data-setting-checkbox="enableCustomDecode"]'
    );
    const HDRToneMappingCheckbox = requireElement<HTMLInputElement>(
        panel,
        '[data-setting-checkbox="enableHDRToneMapping"]'
    );
    const playbackStatus = requireElement<HTMLElement>(panel, '[data-playback-status]');
    const operatorSelect = requireElement<HTMLSelectElement>(
        panel,
        '[data-setting-select="operator"]'
    );
    const audioDownmixAlgorithmSelect = requireElement<HTMLSelectElement>(
        panel,
        '[data-setting-select="audioDownmixAlgorithm"]'
    );
    let settings = loadWebGPUUserSettings();
    const audioOutputManager = getWebGPUAudioOutputManager();
    let audioDownmixAlgorithm: CustomAudioDownmixAlgorithm =
        webGPUAudioDownmixAlgorithm();
    let renderFrameRequest: number | null = null;
    let audioOutputSelectionRevision = 0;
    let panelActive = true;

    const invalidatePendingAudioOutputSelection = (): void => {
        audioOutputSelectionRevision += 1;
        audioOutputManager.cancelAudioOutputSelectionRequest();
    };

    const synchronizeAudioOutputControls = (
        snapshot: WebGPUAudioOutputSnapshot
    ): void => {
        if (!panelActive) {
            return;
        }
        while (audioOutputSelect.firstChild) {
            audioOutputSelect.removeChild(audioOutputSelect.firstChild);
        }
        const defaultOption = document.createElement('option');
        defaultOption.textContent = globalize.translate('Default');
        defaultOption.value = '';
        audioOutputSelect.appendChild(defaultOption);
        let outputNumber = 1;
        for (const device of snapshot.devices) {
            const option = document.createElement('option');
            option.textContent = device.label || globalize.translate(
                'WebGPUUnnamedAudioOutput',
                outputNumber
            );
            option.value = device.deviceId;
            audioOutputSelect.appendChild(option);
            outputNumber += 1;
        }
        const selectedDeviceListed = snapshot.selectedDeviceId === null
            || snapshot.devices.some(device => device.deviceId === snapshot.selectedDeviceId);
        if (snapshot.selectedDeviceId && !selectedDeviceListed) {
            const selectedOption = document.createElement('option');
            selectedOption.disabled = snapshot.selectedDeviceAvailability === 'unavailable'
                && snapshot.activeDeviceId !== snapshot.selectedDeviceId;
            selectedOption.textContent = getMissingSelectedOutputLabel(snapshot);
            selectedOption.value = snapshot.selectedDeviceId;
            audioOutputSelect.appendChild(selectedOption);
        }
        audioOutputSelect.value = snapshot.selectedDeviceId ?? '';
        audioOutputPicker.disabled = !snapshot.pickerAvailable;
        audioOutputPicker.title = snapshot.pickerAvailable ?
            globalize.translate('WebGPUAuthorizeAudioOutput') :
            globalize.translate('WebGPUAudioOutputPickerUnavailable');
        const statusMessage = globalize.translate(
            getAudioOutputMessageTranslationKey(snapshot.messageCode)
        );
        setStatus(audioOutputStatus, snapshot.pickerAvailable ?
            statusMessage :
            globalize.translate(
                'WebGPUJoinedSentences',
                statusMessage,
                globalize.translate('WebGPUAudioOutputPickerUnavailableHelp')
            ));
    };

    const synchronizeControls = (): void => {
        for (const configuration of NUMERIC_CONTROL_CONFIGURATIONS) {
            const value = getNumericSetting(settings, configuration.key).toString();
            const slider = requireElement<HTMLInputElement>(
                panel,
                `[data-setting-slider="${configuration.key}"]`
            );
            const numberInput = requireElement<HTMLInputElement>(
                panel,
                `[data-setting-number="${configuration.key}"]`
            );
            slider.value = value;
            numberInput.value = value;
        }
        automaticInputPeakCheckbox.checked = settings.render.automaticInputPeakNits;
        forceStereoCheckbox.checked = settings.audio.forceStereoDownmix;
        customDecodeCheckbox.checked = settings.playback.enableCustomDecode;
        HDRToneMappingCheckbox.checked = settings.playback.enableHDRToneMapping;
        // HDR tone mapping runs only on the custom decode path
        HDRToneMappingCheckbox.disabled = !settings.playback.enableCustomDecode;
        audioDownmixAlgorithmSelect.value = audioDownmixAlgorithm;
        operatorSelect.value = settings.render.settings.toneMapping.operator;
        const inputPeakSlider = requireElement<HTMLInputElement>(
            panel,
            '[data-setting-slider="inputPeakNits"]'
        );
        const inputPeakNumber = requireElement<HTMLInputElement>(
            panel,
            '[data-setting-number="inputPeakNits"]'
        );
        inputPeakSlider.disabled = settings.render.automaticInputPeakNits;
        inputPeakNumber.disabled = settings.render.automaticInputPeakNits;
    };

    const applyRenderSettings = (): void => {
        renderFrameRequest = null;
        const currentRenderSettings: RenderSettings = player.getRenderSettings();
        if (currentRenderSettings.mode !== 'hdr-to-sdr') {
            setStatus(renderStatus, globalize.translate('WebGPURenderStatusInactive'));
            return;
        }
        const detectedInputPeakNits = player.getDetectedInputPeakNits();
        if (settings.render.automaticInputPeakNits && detectedInputPeakNits === null) {
            setStatus(renderStatus, globalize.translate('WebGPURenderStatusPeakUnavailable'));
            return;
        }
        const configuredRenderSettings = createConfiguredHDRRenderSettings(
            settings,
            detectedInputPeakNits ?? currentRenderSettings.toneMapping.inputPeakNits
        );
        if (player.updateRenderSettings(
            configuredRenderSettings,
            settings.render.automaticInputPeakNits
        )) {
            setStatus(renderStatus, globalize.translate('WebGPURenderStatusApplied'));
            return;
        }
        setStatus(renderStatus, globalize.translate('WebGPURenderStatusPending'));
    };

    const scheduleRenderSettings = (): void => {
        if (renderFrameRequest !== null) {
            cancelAnimationFrame(renderFrameRequest);
        }
        renderFrameRequest = requestAnimationFrame(applyRenderSettings);
    };

    const persistSettings = (): void => {
        settings = saveWebGPUUserSettings(settings);
        synchronizeControls();
    };

    const commitAudioOutputDevice = (deviceId: string | null): void => {
        settings = normalizeWebGPUUserSettings({
            ...settings,
            audio: {
                ...settings.audio,
                outputDeviceId: deviceId
            }
        });
        persistSettings();
        void audioOutputManager.setSelectedDeviceId(settings.audio.outputDeviceId);
        synchronizeAudioOutputControls(audioOutputManager.getSnapshot());
    };

    const onAudioOutputChange = (): void => {
        invalidatePendingAudioOutputSelection();
        commitAudioOutputDevice(audioOutputSelect.value || null);
    };
    audioOutputSelect.addEventListener('change', onAudioOutputChange);
    cleanupCallbacks.push((): void => {
        audioOutputSelect.removeEventListener('change', onAudioOutputChange);
    });

    const onChooseAudioOutput = (): void => {
        const selectionRevision = audioOutputSelectionRevision + 1;
        audioOutputSelectionRevision = selectionRevision;
        const selectionPromise = audioOutputManager.requestAudioOutputSelection();
        void selectionPromise.then((selectedDeviceId): void => {
            if (!panelActive
                || audioOutputSelectionRevision !== selectionRevision
                || !selectedDeviceId) {
                return;
            }
            commitAudioOutputDevice(selectedDeviceId);
        });
    };
    audioOutputPicker.addEventListener('click', onChooseAudioOutput);
    cleanupCallbacks.push((): void => {
        audioOutputPicker.removeEventListener('click', onChooseAudioOutput);
    });

    // Rebuilding the sink re-reads the device; a new speaker layout then switches live audio
    const onRedetectAudioOutput = (): void => {
        void audioOutputManager.redetectAudioOutputs();
    };
    audioOutputRedetect.addEventListener('click', onRedetectAudioOutput);
    cleanupCallbacks.push((): void => {
        audioOutputRedetect.removeEventListener('click', onRedetectAudioOutput);
    });

    const unsubscribeAudioOutput = audioOutputManager.subscribe(
        synchronizeAudioOutputControls
    );
    cleanupCallbacks.push(unsubscribeAudioOutput);
    if (audioOutputManager.getSnapshot().selectedDeviceId !== settings.audio.outputDeviceId) {
        void audioOutputManager.setSelectedDeviceId(settings.audio.outputDeviceId);
    }

    // A layout result arriving after a newer status must not overwrite it
    let audioStatusRevision = 0;
    const setAudioStatus = (message: string): number => {
        audioStatusRevision += 1;
        setStatus(audioStatus, message);
        return audioStatusRevision;
    };

    // Force stereo and the algorithm switch active decoded audio in place when they change it.
    // formatStatus places the layout sentence in the full status, which translations may order freely.
    const applyAudioOutputLayout = (formatStatus: (layoutStatus: string) => string): void => {
        const statusRevision = setAudioStatus(
            formatStatus(globalize.translate('WebGPUAudioLayoutStatusApplying'))
        );
        void player.applyAudioOutputSettings(
            settings.audio.forceStereoDownmix,
            audioDownmixAlgorithm
        ).then((appliedLive: boolean): void => {
            if (!panelActive || statusRevision !== audioStatusRevision) {
                return;
            }
            const layoutStatus = appliedLive ?
                globalize.translate('WebGPUAudioLayoutStatusLive') :
                globalize.translate('WebGPUAudioLayoutStatusPending');
            setStatus(audioStatus, formatStatus(layoutStatus));
        });
    };

    const formatLayoutChangeStatus = (layoutStatus: string): string => (
        globalize.translate('WebGPUAudioLayoutChangeStatus', layoutStatus)
    );

    const applyAudioDownmixSettings = (includeLayoutStatus: boolean): void => {
        const appliedLive = player.updateAudioDownmixSettings(settings.audio.downmix);
        const downmixStatus = appliedLive ?
            globalize.translate('WebGPUAudioDownmixStatusLive') :
            globalize.translate('WebGPUAudioDownmixStatusPending');
        if (includeLayoutStatus) {
            applyAudioOutputLayout((layoutStatus: string): string => (
                globalize.translate('WebGPUJoinedSentences', downmixStatus, layoutStatus)
            ));
            return;
        }
        setAudioStatus(downmixStatus);
    };

    const commitSectionSettings = (section: 'audio' | 'render'): void => {
        persistSettings();
        switch (section) {
            case 'audio':
                applyAudioDownmixSettings(false);
                break;
            case 'render':
                scheduleRenderSettings();
                break;
        }
    };

    const bindDefaultButton = (
        settingKey: DefaultSettingKey,
        onClick: () => void
    ): void => {
        const button = requireElement<HTMLButtonElement>(
            panel,
            `[data-default-setting="${settingKey}"]`
        );
        button.addEventListener('click', onClick);
        cleanupCallbacks.push((): void => {
            button.removeEventListener('click', onClick);
        });
    };

    for (const configuration of NUMERIC_CONTROL_CONFIGURATIONS) {
        const slider = requireElement<HTMLInputElement>(
            panel,
            `[data-setting-slider="${configuration.key}"]`
        );
        const numberInput = requireElement<HTMLInputElement>(
            panel,
            `[data-setting-number="${configuration.key}"]`
        );
        const onSliderInput = (): void => {
            settings = updateNumericSetting(settings, configuration.key, Number(slider.value));
            commitSectionSettings(configuration.section);
        };
        const onNumberChange = (): void => {
            settings = updateNumericSetting(
                settings,
                configuration.key,
                Number(numberInput.value)
            );
            commitSectionSettings(configuration.section);
        };
        slider.addEventListener('input', onSliderInput);
        numberInput.addEventListener('change', onNumberChange);
        cleanupCallbacks.push((): void => {
            slider.removeEventListener('input', onSliderInput);
            numberInput.removeEventListener('change', onNumberChange);
        });
        bindDefaultButton(configuration.key, (): void => {
            const defaults = createDefaultWebGPUUserSettings();
            settings = updateNumericSetting(
                settings,
                configuration.key,
                getNumericSetting(defaults, configuration.key)
            );
            commitSectionSettings(configuration.section);
        });
    }

    const onPlaybackPreferenceChange = (): void => {
        settings = normalizeWebGPUUserSettings({
            ...settings,
            playback: {
                enableCustomDecode: customDecodeCheckbox.checked,
                enableHDRToneMapping: HDRToneMappingCheckbox.checked
            }
        });
        persistSettings();
        setStatus(playbackStatus, globalize.translate('WebGPUPlaybackChangesSavedStatus'));
    };
    customDecodeCheckbox.addEventListener('change', onPlaybackPreferenceChange);
    HDRToneMappingCheckbox.addEventListener('change', onPlaybackPreferenceChange);
    cleanupCallbacks.push((): void => {
        customDecodeCheckbox.removeEventListener('change', onPlaybackPreferenceChange);
        HDRToneMappingCheckbox.removeEventListener('change', onPlaybackPreferenceChange);
    });
    bindDefaultButton('enableCustomDecode', (): void => {
        customDecodeCheckbox.checked =
            createDefaultWebGPUUserSettings().playback.enableCustomDecode;
        onPlaybackPreferenceChange();
    });
    bindDefaultButton('enableHDRToneMapping', (): void => {
        HDRToneMappingCheckbox.checked =
            createDefaultWebGPUUserSettings().playback.enableHDRToneMapping;
        onPlaybackPreferenceChange();
    });

    const onAutomaticInputPeakChange = (): void => {
        settings = normalizeWebGPUUserSettings({
            ...settings,
            render: {
                ...settings.render,
                automaticInputPeakNits: automaticInputPeakCheckbox.checked
            }
        });
        commitSectionSettings('render');
    };
    automaticInputPeakCheckbox.addEventListener('change', onAutomaticInputPeakChange);
    cleanupCallbacks.push((): void => {
        automaticInputPeakCheckbox.removeEventListener('change', onAutomaticInputPeakChange);
    });
    bindDefaultButton('automaticInputPeakNits', (): void => {
        automaticInputPeakCheckbox.checked =
            createDefaultWebGPUUserSettings().render.automaticInputPeakNits;
        onAutomaticInputPeakChange();
    });

    const onForceStereoChange = (): void => {
        settings = normalizeWebGPUUserSettings({
            ...settings,
            audio: {
                ...settings.audio,
                forceStereoDownmix: forceStereoCheckbox.checked
            }
        });
        persistSettings();
        applyAudioOutputLayout(formatLayoutChangeStatus);
    };
    forceStereoCheckbox.addEventListener('change', onForceStereoChange);
    cleanupCallbacks.push((): void => {
        forceStereoCheckbox.removeEventListener('change', onForceStereoChange);
    });
    bindDefaultButton('forceStereoDownmix', (): void => {
        forceStereoCheckbox.checked =
            createDefaultWebGPUUserSettings().audio.forceStereoDownmix;
        onForceStereoChange();
    });

    const persistAudioDownmixAlgorithm = (value: unknown): void => {
        audioDownmixAlgorithm = normalizeCustomAudioDownmixAlgorithm(value);
        webGPUAudioDownmixAlgorithm(audioDownmixAlgorithm);
        audioDownmixAlgorithmSelect.value = audioDownmixAlgorithm;
        applyAudioOutputLayout(formatLayoutChangeStatus);
    };
    const onAudioDownmixAlgorithmChange = (): void => {
        persistAudioDownmixAlgorithm(audioDownmixAlgorithmSelect.value);
    };
    audioDownmixAlgorithmSelect.addEventListener(
        'change',
        onAudioDownmixAlgorithmChange
    );
    cleanupCallbacks.push((): void => {
        audioDownmixAlgorithmSelect.removeEventListener(
            'change',
            onAudioDownmixAlgorithmChange
        );
    });
    bindDefaultButton('audioDownmixAlgorithm', (): void => {
        persistAudioDownmixAlgorithm(DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM);
    });

    const onOperatorChange = (): void => {
        settings = normalizeWebGPUUserSettings({
            ...settings,
            render: {
                ...settings.render,
                settings: {
                    ...settings.render.settings,
                    toneMapping: {
                        ...settings.render.settings.toneMapping,
                        operator: operatorSelect.value
                    }
                }
            }
        });
        commitSectionSettings('render');
    };
    operatorSelect.addEventListener('change', onOperatorChange);
    cleanupCallbacks.push((): void => {
        operatorSelect.removeEventListener('change', onOperatorChange);
    });
    bindDefaultButton('operator', (): void => {
        operatorSelect.value =
            createDefaultWebGPUUserSettings().render.settings.toneMapping.operator;
        onOperatorChange();
    });

    const resetRenderButton = requireElement<HTMLButtonElement>(
        panel,
        '.webgpuSettingsResetRender'
    );
    const onResetRender = (): void => {
        settings = resetWebGPURenderSettings(settings);
        commitSectionSettings('render');
    };
    resetRenderButton.addEventListener('click', onResetRender);
    cleanupCallbacks.push((): void => {
        resetRenderButton.removeEventListener('click', onResetRender);
    });

    const resetAudioButton = requireElement<HTMLButtonElement>(
        panel,
        '.webgpuSettingsResetAudio'
    );
    const onResetAudio = (): void => {
        invalidatePendingAudioOutputSelection();
        settings = resetWebGPUAudioSettings(settings);
        audioDownmixAlgorithm = DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM;
        webGPUAudioDownmixAlgorithm(audioDownmixAlgorithm);
        persistSettings();
        void audioOutputManager.setSelectedDeviceId(settings.audio.outputDeviceId);
        synchronizeAudioOutputControls(audioOutputManager.getSnapshot());
        applyAudioDownmixSettings(true);
    };
    resetAudioButton.addEventListener('click', onResetAudio);
    cleanupCallbacks.push((): void => {
        resetAudioButton.removeEventListener('click', onResetAudio);
    });

    const resetAllButton = requireElement<HTMLButtonElement>(panel, '.webgpuSettingsResetAll');
    const onResetAll = (): void => {
        invalidatePendingAudioOutputSelection();
        settings = createDefaultWebGPUUserSettings();
        audioDownmixAlgorithm = DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM;
        webGPUAudioDownmixAlgorithm(audioDownmixAlgorithm);
        persistSettings();
        void audioOutputManager.setSelectedDeviceId(settings.audio.outputDeviceId);
        synchronizeAudioOutputControls(audioOutputManager.getSnapshot());
        scheduleRenderSettings();
        applyAudioDownmixSettings(true);
        setStatus(playbackStatus, globalize.translate('WebGPUPlaybackChangesSavedStatus'));
    };
    resetAllButton.addEventListener('click', onResetAll);
    cleanupCallbacks.push((): void => {
        resetAllButton.removeEventListener('click', onResetAll);
    });

    synchronizeControls();
    applyRenderSettings();

    let resolved = false;
    let resolvePanel: (() => void) | null = null;
    const promise = new Promise<void>((resolve): void => {
        resolvePanel = resolve;
    });
    const finish = (): void => {
        if (resolved) {
            return;
        }
        resolved = true;
        panelActive = false;
        invalidatePendingAudioOutputSelection();
        if (renderFrameRequest !== null) {
            cancelAnimationFrame(renderFrameRequest);
            applyRenderSettings();
        }
        for (const cleanupCallback of cleanupCallbacks) {
            cleanupCallback();
        }
        if (invokingElement?.isConnected) {
            invokingElement.focus();
        }
        resolvePanel?.();
        resolvePanel = null;
    };

    const closePanel = (): void => {
        panel.remove();
        finish();
    };
    const closeButton = requireElement<HTMLButtonElement>(panel, '.webgpuSettingsClose');
    closeButton.addEventListener('click', closePanel);
    cleanupCallbacks.push((): void => {
        closeButton.removeEventListener('click', closePanel);
    });

    const onPanelKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape') {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        closePanel();
    };
    panel.addEventListener('keydown', onPanelKeyDown);
    cleanupCallbacks.push((): void => {
        panel.removeEventListener('keydown', onPanelKeyDown);
    });

    // The video OSD changes the volume on wheel events that reach the document.
    // Stopping them at the panel keeps its native scrolling and leaves the volume alone.
    const onPanelWheel = (event: WheelEvent): void => {
        event.stopPropagation();
    };
    panel.addEventListener('wheel', onPanelWheel, { passive: true });
    cleanupCallbacks.push((): void => {
        panel.removeEventListener('wheel', onPanelWheel);
    });

    const updatePanelPosition = (): void => {
        positionPanelBelowPlaybackInfo(panel);
    };
    window.addEventListener('resize', updatePanelPosition);
    cleanupCallbacks.push((): void => {
        window.removeEventListener('resize', updatePanelPosition);
    });

    let playbackInfoResizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver === 'function') {
        playbackInfoResizeObserver = new ResizeObserver(updatePanelPosition);
        const playbackInfoElements = document.querySelectorAll<HTMLElement>(
            PLAYBACK_INFO_SELECTOR
        );
        for (const playbackInfoElement of playbackInfoElements) {
            playbackInfoResizeObserver.observe(playbackInfoElement);
        }
        cleanupCallbacks.push((): void => {
            playbackInfoResizeObserver?.disconnect();
            playbackInfoResizeObserver = null;
        });
    }

    const playbackPage = document.getElementById('videoOsdPage');
    if (playbackPage) {
        playbackPage.addEventListener('viewbeforehide', closePanel);
        cleanupCallbacks.push((): void => {
            playbackPage.removeEventListener('viewbeforehide', closePanel);
        });
    }

    document.body.appendChild(panel);
    scheduleSelectLabelFallback(panel);
    updatePanelPosition();
    closeButton.focus();

    return { close: closePanel, element: panel, promise };
}

/** Opens or focuses the one active plugin-owned playback settings panel. */
export function showWebGPUPlaybackSettingsPanel(player: WebGPUPlayer): Promise<void> {
    if (activePanel) {
        const focusTarget = activePanel.element.querySelector<HTMLElement>(
            '.webgpuSettingsClose'
        );
        focusTarget?.focus();
        return activePanel.promise;
    }

    const activeElement = document.activeElement;
    const invokingElement = activeElement instanceof HTMLElement ? activeElement : null;
    const createdPanel = createPanelController(player, invokingElement);
    const promise = createdPanel.promise.finally((): void => {
        if (activePanel?.element === createdPanel.element) {
            activePanel = null;
        }
    });
    activePanel = {
        close: createdPanel.close,
        element: createdPanel.element,
        promise
    };
    return promise;
}

/** Closes the active playback settings panel, or opens one when none is active. */
export function toggleWebGPUPlaybackSettingsPanel(player: WebGPUPlayer): Promise<void> {
    if (!activePanel) {
        return showWebGPUPlaybackSettingsPanel(player);
    }

    // Cleared now rather than when the promise settles, so an immediate toggle reopens
    const closingPanel = activePanel;
    activePanel = null;
    closingPanel.close();
    return closingPanel.promise;
}

import layoutManager from 'components/layoutManager';
import globalize from 'lib/globalize';
import { handleCommand } from 'scripts/inputManager';

import { applySettingsButtonPlacement } from '../compat/SettingsEntryPoints';
import type { AddonStringKey } from '../host/globalize';
import { loadServerModuleCatalog } from '../ServerModules';
import { getDefaultAudioDownmixAlgorithm, webGPUAudioDownmixAlgorithm } from '../shims/userSettings';
import { getLastWebGPUFailureReport, showWebGPUFailureReport } from '../WebGPUFailureWarning';
import {
    bindControlInfo,
    bindControlKeys,
    bindNumericControl,
    bindSelectTitles,
    createActionControlHTML,
    createButtonHTML,
    createCheckboxControlHTML,
    createNumericControlHTML,
    createSelectControlHTML,
    refreshSelectTitles,
    type ControlText,
    type NumericControlBinding
} from './controls/SettingControls';
import { bindDecoderPackageSection, createDecoderPackageSectionHTML } from './DecoderPackageSection';
import { createPipelineGraphView, startPipelineGraphUpdates } from './pipeline/PipelineGraphView';
import {
    bindPresentationSection,
    createHDROutputControlHTML,
    createPipelineControlsHTML,
    createShaderPassesHTML,
    type PresentationSectionController
} from './PresentationSettingsSection';
import {
    AUDIO_DOWNMIX_ALGORITHM_OPTIONS,
    AUDIO_SPEAKER_LAYOUT_OPTIONS,
    createSettingOptionsHTML,
    DECODER_TEST_TIMING_OPTIONS,
    NUMERIC_CONTROL_CONFIGURATIONS,
    SETTINGS_BUTTON_PLACEMENT_OPTIONS,
    TONE_MAP_OPERATOR_OPTIONS,
    type NumericSettingKey
} from './SettingDefinitions';
import { HIDDEN_CLASS, setStatus, translateToHTML } from './SettingsPanelHTML';
import {
    createSettingsWindowManager,
    createWindowActionHTML,
    type HostedSettingsWindow,
    type SettingsWindowDefinition,
    type SettingsWindowManager
} from './windows/SettingsWindowManager';

import {
    clearStoredCapabilityProbeVerdicts,
    readStoredCapabilityProbeVerdictState,
    type CrashedCapabilityProbe
} from 'webgpu-player/capability/CapabilityProbeStore';
import type { RenderSettings } from 'webgpu-player/presentation/RenderSettings';
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
import {
    normalizeCustomAudioDownmixAlgorithm,
    type CustomAudioDownmixAlgorithm
} from 'webgpu-player/audio/processing/CustomAudioDownmixAlgorithm';

import './WebGPUPlaybackSettingsDialog.scss';

// The WebGPU settings as windows over the player: a pinned master window with the playback settings and the list of the other windows,
// and the picture, pipeline, audio, and interface windows, which the user shows, hides, collapses, and moves; the host's playback info joins them

type DefaultSettingKey =
    | NumericSettingKey
    | 'audioDownmixAlgorithm'
    | 'automaticInputPeakNits'
    | 'binauralHeadphones'
    | 'decoderTestTiming'
    | 'enableCustomDecode'
    | 'enableGPUDecodeSlicing'
    | 'enableHDRToneMapping'
    | 'forceStereoDownmix'
    | 'operator'
    | 'settingsButtonPlacement'
    | 'speakerLayout'
    | 'webGPUFailureWarning';

type ActivePanel = {
    close: () => void
    element: HTMLElement
    promise: Promise<void>
};

const MASTER_WINDOW_ID = 'playback';
const PICTURE_WINDOW_ID = 'picture';
const PIPELINE_WINDOW_ID = 'pipeline';
const AUDIO_WINDOW_ID = 'audio';
const INTERFACE_WINDOW_ID = 'interface';
const PLAYBACK_INFO_WINDOW_ID = 'playbackInfo';
const PLAYBACK_INFO_CLASS = 'playerStats';
const PLAYBACK_INFO_SELECTOR = `.${PLAYBACK_INFO_CLASS}`;
// The video OSD's input command that shows or hides the host's playback info
const TOGGLE_PLAYBACK_INFO_COMMAND = 'togglestats';
// The video OSD page; the host's view manager keeps pages of earlier views in the document, hidden by class, so more than one can match
const VIDEO_OSD_PAGE_SELECTOR = '#videoOsdPage';
// The video OSD's bottom controls: the title, the timeline, and the buttons, which only fade while the pointer idles
const OSD_CONTROLS_SELECTOR = '.videoOsdBottom-maincontrols .osdControls';
const LIST_SEPARATOR = ', ';

let activePanel: ActivePanel | null = null;

function getNumericSetting(settings: WebGPUUserSettings, key: NumericSettingKey): number {
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

/** Returns a control's texts from its label, description, and in-sentence name keys. */
function getControlText(labelKey: AddonStringKey, descriptionKey: AddonStringKey | null, nameKey: AddonStringKey): ControlText {
    return {
        description: descriptionKey === null ? null : globalize.translate(descriptionKey),
        label: globalize.translate(labelKey),
        name: globalize.translate(nameKey)
    };
}

function createNumericControlsHTML(section: 'audio' | 'render'): string {
    return NUMERIC_CONTROL_CONFIGURATIONS
        .filter((configuration): boolean => configuration.section === section)
        .map(createNumericControlHTML)
        .join('');
}

/** Returns a window's reset button for its title bar, which restores the window's settings to their defaults. */
function createWindowResetHTML(windowId: string, className: string, label: string): string {
    return createWindowActionHTML({ attributes: `data-reset-window="${windowId}"`, className, icon: 'settings_backup_restore', label });
}

/** The master window: the list of the other windows, the playback settings, the decoder test results, the keys, and the full reset. */
function createMasterContentHTML(): string {
    return `
        <ul aria-label="${translateToHTML('WebGPUSettingsWindowList')}" class="webgpuWindowList" data-settings-window-list></ul>
        <h3 class="webgpuGroupTitle">${translateToHTML('WebGPUPlayback')}</h3>
        ${createCheckboxControlHTML('enableCustomDecode', getControlText('WebGPUEnableCustomDecode', 'WebGPUEnableCustomDecodeHelp', 'WebGPUSettingNameCustomDecode'), { reset: true })}
        ${createCheckboxControlHTML('enableHDRToneMapping', getControlText('WebGPUEnableHDRToneMapping', 'WebGPUEnableHDRToneMappingHelp', 'WebGPUSettingNameHDRToneMapping'), { reset: true })}
        ${createCheckboxControlHTML('enableGPUDecodeSlicing', getControlText('WebGPUEnableGPUDecodeSlicing', 'WebGPUEnableGPUDecodeSlicingHelp', 'WebGPUSettingNameGPUDecodeSlicing'), { reset: true })}
        ${createSelectControlHTML(
            'decoderTestTiming',
            getControlText('WebGPUDecoderTestTiming', 'WebGPUDecoderTestTimingDialogHelp', 'WebGPUSettingNameDecoderTestTiming'),
            createSettingOptionsHTML(DECODER_TEST_TIMING_OPTIONS),
            { reset: true }
        )}
        <div class="webgpuStatus" data-playback-status role="status">${translateToHTML('WebGPUPlaybackChangesRestartRequired')}</div>
        ${createActionControlHTML(
            'probeCache',
            getControlText('WebGPUClearProbeCache', 'WebGPUClearProbeCacheHelp', 'WebGPUSettingNameDecoderTestResults'),
            createButtonHTML({ className: 'webgpuSettingsClearProbeCache', icon: 'restart_alt', label: globalize.translate('WebGPUClearProbeCache') })
        )}
        <div class="webgpuStatus webgpuSettingsCrashedProbes ${HIDDEN_CLASS}" data-crashed-probes></div>
        ${createActionControlHTML(
            'keyboardShortcuts',
            getControlText('WebGPUKeyboardShortcuts', 'WebGPUKeyboardShortcutsHelp', 'WebGPUSettingNameKeyboardShortcuts'),
            `<span class="webgpuSettingsKeysLabel"><span class="material-icons keyboard" aria-hidden="true"></span>${translateToHTML('WebGPUKeyboardShortcuts')}</span>`
        )}
        <div class="webgpuButtonRow webgpuWindowFooter">
            ${createButtonHTML({ className: 'webgpuSettingsResetAll', icon: 'settings_backup_restore', label: globalize.translate('WebGPUResetAll'), variant: 'danger' })}
        </div>`;
}

/** The picture window: tone mapping, the display controls, and HDR output. */
function createPictureContentHTML(): string {
    return `
        ${createSelectControlHTML(
            'operator',
            getControlText('WebGPUToneMapOperator', 'WebGPUToneMapOperatorHelp', 'WebGPUSettingNameToneMapOperator'),
            createSettingOptionsHTML(TONE_MAP_OPERATOR_OPTIONS),
            { reset: true }
        )}
        ${createCheckboxControlHTML('automaticInputPeakNits', getControlText('WebGPUTrackSourcePeakMetadata', 'WebGPUTrackSourcePeakMetadataHelp', 'WebGPUSettingNameSourcePeakTracking'), { reset: true })}
        ${createNumericControlsHTML('render')}
        <div aria-live="polite" class="webgpuStatus" data-render-status role="status"></div>
        ${createHDROutputControlHTML()}`;
}

/** The pipeline window: the deinterlacing and black bar switches, the graph of the passes the picture runs through, the shader pass selector, and the decoders. */
function createPipelineContentHTML(): string {
    return `
        ${createPipelineControlsHTML()}
        <div class="webgpuSettingsPipelineGraph" data-pipeline-graph></div>
        ${createShaderPassesHTML()}
        ${createDecoderPackageSectionHTML()}`;
}

/** The audio window: the output, the speaker layout and its renderings, and the downmix. */
function createAudioContentHTML(): string {
    return `
        ${createSelectControlHTML('audioOutput', getControlText('WebGPUAudioOutput', 'WebGPUAudioOutputDescription', 'WebGPUSettingNameAudioOutput'), '', {
            selectAttributes: 'data-audio-output-select'
        })}
        <div class="webgpuButtonRow">
            ${createButtonHTML({
                attributes: `data-audio-output-redetect title="${translateToHTML('WebGPURedetectAudioOutputHelp')}"`,
                className: 'webgpuSettingsRedetectAudioOutput',
                icon: 'refresh',
                label: globalize.translate('WebGPURedetectAudioOutput')
            })}
            ${createButtonHTML({
                attributes: 'data-audio-output-picker',
                className: 'webgpuSettingsChooseAudioOutput',
                icon: 'speaker',
                label: globalize.translate('WebGPUChooseAudioOutput')
            })}
        </div>
        <div aria-live="polite" class="webgpuStatus" data-audio-output-status role="status"></div>
        ${createSelectControlHTML(
            'speakerLayout',
            getControlText('WebGPUSpeakerLayout', 'WebGPUSpeakerLayoutHelp', 'WebGPUSettingNameSpeakerLayout'),
            createSettingOptionsHTML(AUDIO_SPEAKER_LAYOUT_OPTIONS),
            { reset: true }
        )}
        ${createCheckboxControlHTML('binauralHeadphones', getControlText('WebGPUBinauralHeadphones', 'WebGPUBinauralHeadphonesHelp', 'WebGPUSettingNameBinauralHeadphones'), { reset: true })}
        ${createSelectControlHTML(
            'audioDownmixAlgorithm',
            getControlText('WebGPUDownmixAlgorithm', 'WebGPUAudioDownmixAlgorithmHelp', 'WebGPUSettingNameDownmixAlgorithm'),
            createSettingOptionsHTML(AUDIO_DOWNMIX_ALGORITHM_OPTIONS),
            { reset: true }
        )}
        ${createCheckboxControlHTML('forceStereoDownmix', getControlText('WebGPUForceStereo', 'WebGPUForceStereoHelp', 'WebGPUSettingNameForceStereo'), { reset: true })}
        ${createNumericControlsHTML('audio')}
        <div class="webgpuStatus webgpuSettingsSafetyDescription">${translateToHTML('WebGPUDownmixGainsHelp')}</div>
        <div aria-live="polite" class="webgpuStatus" data-audio-status role="status">${translateToHTML('WebGPUAudioSettingsApplyHelp')}</div>`;
}

/** The interface window: where the player offers these settings, and the warning when WebGPU fails, with its last report. */
function createInterfaceContentHTML(): string {
    return `
        ${createSelectControlHTML(
            'settingsButtonPlacement',
            getControlText('WebGPUSettingsButtonPlacement', 'WebGPUSettingsButtonPlacementHelp', 'WebGPUSettingNameSettingsButtonPlacement'),
            createSettingOptionsHTML(SETTINGS_BUTTON_PLACEMENT_OPTIONS),
            { reset: true }
        )}
        ${createCheckboxControlHTML('webGPUFailureWarning', getControlText('WebGPUFailureWarningSetting', 'WebGPUFailureWarningSettingHelp', 'WebGPUSettingNameFailureWarning'), { reset: true })}
        ${createActionControlHTML(
            'failureReport',
            getControlText('WebGPUShowFailureReport', 'WebGPUShowFailureReportHelp', 'WebGPUSettingNameFailureReport'),
            createButtonHTML({ className: 'webgpuSettingsShowFailureReport', icon: 'warning_amber', label: globalize.translate('WebGPUShowFailureReport') })
        )}`;
}

function createWindowDefinitions(): SettingsWindowDefinition[] {
    const section = (
        id: string,
        titleKey: AddonStringKey,
        contentHTML: string,
        actionsHTML: string,
        widths: Readonly<{ minimumWidthEm: number; widthEm: number }>
    ): SettingsWindowDefinition => ({
        actionsHTML,
        contentHTML,
        // Until the user shows it from the master's list, a section window stays hidden, so the settings open as the master window alone
        defaultVisible: false,
        id,
        role: 'section',
        title: globalize.translate(titleKey),
        ...widths
    });
    return [
        {
            actionsHTML: createWindowResetHTML(MASTER_WINDOW_ID, 'webgpuSettingsResetPlayback', globalize.translate('WebGPUResetPlayback')),
            contentHTML: createMasterContentHTML(),
            defaultVisible: true,
            id: MASTER_WINDOW_ID,
            minimumWidthEm: 16,
            role: 'master',
            title: globalize.translate('WebGPUSettings'),
            widthEm: 21
        },
        section(PICTURE_WINDOW_ID, 'WebGPUWindowPicture', createPictureContentHTML(),
            createWindowResetHTML(PICTURE_WINDOW_ID, 'webgpuSettingsResetRender', globalize.translate('WebGPUResetToneMappingAndDisplay')),
            { minimumWidthEm: 18, widthEm: 26 }),
        section(PIPELINE_WINDOW_ID, 'WebGPUWindowPipeline', createPipelineContentHTML(),
            createWindowResetHTML(PIPELINE_WINDOW_ID, 'webgpuSettingsResetPipeline', globalize.translate('WebGPUResetPipeline')),
            { minimumWidthEm: 20, widthEm: 34 }),
        section(AUDIO_WINDOW_ID, 'WebGPUWindowAudio', createAudioContentHTML(),
            createWindowResetHTML(AUDIO_WINDOW_ID, 'webgpuSettingsResetAudio', globalize.translate('WebGPUResetAudio')),
            { minimumWidthEm: 18, widthEm: 26 }),
        section(INTERFACE_WINDOW_ID, 'WebGPUWindowInterface', createInterfaceContentHTML(),
            createWindowResetHTML(INTERFACE_WINDOW_ID, 'webgpuSettingsResetInterface', globalize.translate('WebGPUResetInterface')),
            { minimumWidthEm: 17, widthEm: 23 })
    ];
}

function requireElement<ElementType extends Element>(parent: ParentNode, selector: string): ElementType {
    const element = parent.querySelector<ElementType>(selector);
    if (!element) {
        throw new Error(`WebGPU settings windows are missing ${selector}`);
    }
    return element;
}

function getAudioOutputMessageTranslationKey(messageCode: WebGPUAudioOutputMessageCode): AddonStringKey {
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
    const selectedDeviceActive = snapshot.selectedDeviceId !== null && snapshot.activeDeviceId === snapshot.selectedDeviceId;
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

/** Returns the host's playback info overlay while it shows, else null. */
function findShownPlaybackInfo(): HTMLElement | null {
    for (const playbackInfoElement of document.querySelectorAll<HTMLElement>(PLAYBACK_INFO_SELECTOR)) {
        if (!playbackInfoElement.classList.contains(HIDDEN_CLASS)) {
            return playbackInfoElement;
        }
    }
    return null;
}

/** Returns the video OSD page that shows, else null. */
function findShownVideoOsdPage(): HTMLElement | null {
    for (const page of document.querySelectorAll<HTMLElement>(VIDEO_OSD_PAGE_SELECTOR)) {
        if (!page.classList.contains(HIDDEN_CLASS)) {
            return page;
        }
    }
    return null;
}

/**
 * The host's playback info as a window of the settings: the host adds it to the body on its first toggle, then shows and hides it by class.
 * The host toggles in request order once its overlay module loads, so a request remembers where it leads until the host gets there.
 */
function createPlaybackInfoWindow(): HostedSettingsWindow {
    let expectedShown: boolean | null = null;
    return {
        // Hidden until the user shows it from the master's list, as the section windows are
        defaultVisible: false,
        findShown: findShownPlaybackInfo,
        id: PLAYBACK_INFO_WINDOW_ID,
        setShown: (shown: boolean): void => {
            if ((expectedShown ?? findShownPlaybackInfo() !== null) !== shown) {
                expectedShown = shown;
                handleCommand(TOGGLE_PLAYBACK_INFO_COMMAND);
            }
        },
        subscribe: (listener: () => void): (() => void) => {
            const notify = (): void => {
                if (expectedShown !== null && (findShownPlaybackInfo() !== null) === expectedShown) {
                    expectedShown = null;
                }
                listener();
            };
            let resizeObserver: ResizeObserver | null = null;
            if (typeof ResizeObserver === 'function') {
                resizeObserver = new ResizeObserver(notify);
            }
            const mutationObserver = new MutationObserver((mutations: MutationRecord[]): void => {
                for (const mutation of mutations) {
                    for (const addedNode of mutation.addedNodes) {
                        if (addedNode instanceof HTMLElement && addedNode.classList.contains(PLAYBACK_INFO_CLASS)) {
                            observe(addedNode);
                        }
                    }
                }
                notify();
            });
            function observe(playbackInfoElement: HTMLElement): void {
                mutationObserver.observe(playbackInfoElement, { attributeFilter: [ 'class' ], attributes: true });
                resizeObserver?.observe(playbackInfoElement);
            }
            mutationObserver.observe(document.body, { childList: true });
            for (const playbackInfoElement of document.querySelectorAll<HTMLElement>(PLAYBACK_INFO_SELECTOR)) {
                observe(playbackInfoElement);
            }
            return (): void => {
                mutationObserver.disconnect();
                resizeObserver?.disconnect();
            };
        },
        title: globalize.translate('PlaybackData')
    };
}

function createPanelController(player: WebGPUPlayer, invokingElement: HTMLElement | null): ActivePanel {
    const cleanupCallbacks: Array<() => void> = [];
    let panelActive = true;
    // The pipeline graph follows the player only while its window shows it
    let stopGraphUpdates: (() => void) | null = null;
    const graphView = createPipelineGraphView();
    const updateGraphFollowing = (): void => {
        const following = panelActive && manager.isExpanded(PIPELINE_WINDOW_ID);
        if (following && stopGraphUpdates === null) {
            stopGraphUpdates = startPipelineGraphUpdates(player, graphView);
        } else if (!following && stopGraphUpdates !== null) {
            stopGraphUpdates();
            stopGraphUpdates = null;
        }
    };

    const playbackPage = findShownVideoOsdPage();
    const OSDControls = playbackPage?.querySelector<HTMLElement>(OSD_CONTROLS_SELECTOR) ?? null;
    // The OSD controls hide while the pointer idles, anchored to the viewport's bottom edge, so the windows keep the height they take there, measured while they showed;
    // otherwise the windows would move each time the controls show and hide
    let OSDControlsReservedHeight: number | null = null;
    const manager: SettingsWindowManager = createSettingsWindowManager({
        definitions: createWindowDefinitions(),
        direction: getComputedStyle(document.documentElement).direction === 'rtl' ? 'rtl' : 'ltr',
        findReservedBottom: (): number | null => {
            const viewportHeight = document.documentElement.clientHeight;
            const bounds = OSDControls?.getBoundingClientRect();
            if (bounds && bounds.height > 0) {
                OSDControlsReservedHeight = viewportHeight - bounds.top;
            }
            return OSDControlsReservedHeight === null ? null : viewportHeight - OSDControlsReservedHeight;
        },
        hosted: createPlaybackInfoWindow(),
        onClose: (): void => {
            closePanel();
        },
        onWindowsChange: updateGraphFollowing,
        tv: layoutManager.tv
    });
    const panel = manager.element;
    requireElement<HTMLElement>(panel, '[data-pipeline-graph]').appendChild(graphView.element);

    const renderStatus = requireElement<HTMLElement>(panel, '[data-render-status]');
    const audioStatus = requireElement<HTMLElement>(panel, '[data-audio-status]');
    const audioOutputStatus = requireElement<HTMLElement>(panel, '[data-audio-output-status]');
    const audioOutputSelect = requireElement<HTMLSelectElement>(panel, '[data-audio-output-select]');
    const audioOutputPicker = requireElement<HTMLButtonElement>(panel, '[data-audio-output-picker]');
    const audioOutputRedetect = requireElement<HTMLButtonElement>(panel, '[data-audio-output-redetect]');
    const automaticInputPeakCheckbox = requireElement<HTMLInputElement>(panel, '[data-setting-checkbox="automaticInputPeakNits"]');
    const forceStereoCheckbox = requireElement<HTMLInputElement>(panel, '[data-setting-checkbox="forceStereoDownmix"]');
    const binauralHeadphonesCheckbox = requireElement<HTMLInputElement>(panel, '[data-setting-checkbox="binauralHeadphones"]');
    const customDecodeCheckbox = requireElement<HTMLInputElement>(panel, '[data-setting-checkbox="enableCustomDecode"]');
    const HDRToneMappingCheckbox = requireElement<HTMLInputElement>(panel, '[data-setting-checkbox="enableHDRToneMapping"]');
    const GPUDecodeSlicingCheckbox = requireElement<HTMLInputElement>(panel, '[data-setting-checkbox="enableGPUDecodeSlicing"]');
    const failureWarningCheckbox = requireElement<HTMLInputElement>(panel, '[data-setting-checkbox="webGPUFailureWarning"]');
    const failureReportButton = requireElement<HTMLButtonElement>(panel, '.webgpuSettingsShowFailureReport');
    const playbackStatus = requireElement<HTMLElement>(panel, '[data-playback-status]');
    const operatorSelect = requireElement<HTMLSelectElement>(panel, '[data-setting-select="operator"]');
    const audioDownmixAlgorithmSelect = requireElement<HTMLSelectElement>(panel, '[data-setting-select="audioDownmixAlgorithm"]');
    const speakerLayoutSelect = requireElement<HTMLSelectElement>(panel, '[data-setting-select="speakerLayout"]');
    const settingsButtonPlacementSelect = requireElement<HTMLSelectElement>(panel, '[data-setting-select="settingsButtonPlacement"]');
    const decoderTestTimingSelect = requireElement<HTMLSelectElement>(panel, '[data-setting-select="decoderTestTiming"]');
    let settings = loadWebGPUUserSettings();
    const audioOutputManager = getWebGPUAudioOutputManager();
    let audioDownmixAlgorithm: CustomAudioDownmixAlgorithm = webGPUAudioDownmixAlgorithm();
    let renderFrameRequest: number | null = null;
    let audioOutputSelectionRevision = 0;
    // Bound once persistSettings exists, which its saves go through
    let presentationSection: PresentationSectionController | null = null;
    const numericControls = new Map<NumericSettingKey, NumericControlBinding>();

    bindControlInfo(panel, cleanupCallbacks);
    bindSelectTitles(panel, cleanupCallbacks);
    bindControlKeys(panel, cleanupCallbacks);

    const invalidatePendingAudioOutputSelection = (): void => {
        audioOutputSelectionRevision += 1;
        audioOutputManager.cancelAudioOutputSelectionRequest();
    };

    const synchronizeAudioOutputControls = (snapshot: WebGPUAudioOutputSnapshot): void => {
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
            option.textContent = device.label || globalize.translate('WebGPUUnnamedAudioOutput', outputNumber);
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
        refreshSelectTitles(audioOutputSelect.parentElement ?? panel);
        audioOutputPicker.disabled = !snapshot.pickerAvailable;
        audioOutputPicker.title = snapshot.pickerAvailable ?
            globalize.translate('WebGPUAuthorizeAudioOutput') :
            globalize.translate('WebGPUAudioOutputPickerUnavailable');
        const statusMessage = globalize.translate(getAudioOutputMessageTranslationKey(snapshot.messageCode));
        setStatus(audioOutputStatus, snapshot.pickerAvailable ?
            statusMessage :
            globalize.translate(
                'WebGPUJoinedSentences',
                statusMessage,
                globalize.translate('WebGPUAudioOutputPickerUnavailableHelp')
            ));
    };

    const synchronizeFailureReport = (): void => {
        failureReportButton.disabled = getLastWebGPUFailureReport() === null;
    };

    const synchronizeControls = (): void => {
        for (const binding of numericControls.values()) {
            binding.synchronize();
        }
        automaticInputPeakCheckbox.checked = settings.render.automaticInputPeakNits;
        forceStereoCheckbox.checked = settings.audio.forceStereoDownmix;
        binauralHeadphonesCheckbox.checked = settings.audio.binauralHeadphones;
        customDecodeCheckbox.checked = settings.playback.enableCustomDecode;
        HDRToneMappingCheckbox.checked = settings.playback.enableHDRToneMapping;
        GPUDecodeSlicingCheckbox.checked = settings.playback.enableGPUDecodeSlicing;
        failureWarningCheckbox.checked = settings.osd.webGPUFailureWarning;
        // HDR tone mapping and GPU decode run only on the custom decode path
        HDRToneMappingCheckbox.disabled = !settings.playback.enableCustomDecode;
        GPUDecodeSlicingCheckbox.disabled = !settings.playback.enableCustomDecode;
        decoderTestTimingSelect.value = settings.playback.decoderTestTiming;
        audioDownmixAlgorithmSelect.value = audioDownmixAlgorithm;
        speakerLayoutSelect.value = settings.audio.speakerLayout;
        operatorSelect.value = settings.render.settings.toneMapping.operator;
        settingsButtonPlacementSelect.value = settings.osd.settingsButtonPlacement;
        numericControls.get('inputPeakNits')?.setDisabled(settings.render.automaticInputPeakNits);
        presentationSection?.synchronize();
        synchronizeFailureReport();
        refreshSelectTitles(panel);
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
        if (player.updateRenderSettings(configuredRenderSettings, settings.render.automaticInputPeakNits)) {
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

    /** Persists the settings, which apply to this page either way; returns what failed when the browser refused the write, else null. */
    const persistSettings = (): string | null => {
        settings = normalizeWebGPUUserSettings(settings);
        let failure: string | null = null;
        try {
            saveWebGPUUserSettings(settings);
        } catch (error) {
            // Local storage refuses a write once the origin's quota is full
            const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
            failure = `settings-save-failed: ${detail}`;
            console.warn(`WebGPU ${failure}`);
        }
        synchronizeControls();
        return failure;
    };

    // The pipeline window shows what the server offers, read once as the windows open; each part reports a failed read itself
    const serverCatalog = loadServerModuleCatalog(null, true);
    serverCatalog.catch((): void => undefined);
    presentationSection = bindPresentationSection({
        cleanupCallbacks,
        getSettings: (): WebGPUUserSettings => settings,
        isActive: (): boolean => panelActive,
        panel,
        player,
        saveSettings: (nextSettings: WebGPUUserSettings): string | null => {
            settings = nextSettings;
            return persistSettings();
        },
        serverCatalog
    });
    bindDecoderPackageSection({
        cleanupCallbacks,
        isActive: (): boolean => panelActive,
        panel,
        serverCatalog
    });

    const listen = <EventType extends Event>(target: EventTarget, type: string, listener: (event: EventType) => void): void => {
        target.addEventListener(type, listener as EventListener);
        cleanupCallbacks.push((): void => {
            target.removeEventListener(type, listener as EventListener);
        });
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

    listen(audioOutputSelect, 'change', (): void => {
        invalidatePendingAudioOutputSelection();
        commitAudioOutputDevice(audioOutputSelect.value || null);
    });

    listen(audioOutputPicker, 'click', (): void => {
        const selectionRevision = audioOutputSelectionRevision + 1;
        audioOutputSelectionRevision = selectionRevision;
        const selectionPromise = audioOutputManager.requestAudioOutputSelection();
        void selectionPromise.then((selectedDeviceId): void => {
            if (!panelActive || audioOutputSelectionRevision !== selectionRevision || !selectedDeviceId) {
                return;
            }
            commitAudioOutputDevice(selectedDeviceId);
        });
    });

    // Rebuilding the sink re-reads the device; a new speaker layout then switches live audio
    listen(audioOutputRedetect, 'click', (): void => {
        void audioOutputManager.redetectAudioOutputs();
    });

    cleanupCallbacks.push(audioOutputManager.subscribe(synchronizeAudioOutputControls));
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

    // Force stereo, the speaker layout, binaural rendering, and the algorithm switch active decoded audio in place when they change it.
    // formatStatus places the layout sentence in the full status, which translations may order freely
    const applyAudioOutputLayout = (formatStatus: (layoutStatus: string) => string): void => {
        const statusRevision = setAudioStatus(formatStatus(globalize.translate('WebGPUAudioLayoutStatusApplying')));
        void player.applyAudioOutputSettings(settings.audio, audioDownmixAlgorithm).then((appliedLive: boolean): void => {
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

    const bindDefaultButton = (settingKey: DefaultSettingKey, onClick: () => void): void => {
        listen(requireElement<HTMLButtonElement>(panel, `[data-default-setting="${settingKey}"]`), 'click', onClick);
    };

    for (const configuration of NUMERIC_CONTROL_CONFIGURATIONS) {
        numericControls.set(configuration.key, bindNumericControl(panel, configuration, {
            commit: (value: number): void => {
                settings = updateNumericSetting(settings, configuration.key, value);
                commitSectionSettings(configuration.section);
            },
            getValue: (): number => getNumericSetting(settings, configuration.key)
        }, cleanupCallbacks));
        bindDefaultButton(configuration.key, (): void => {
            const defaults = createDefaultWebGPUUserSettings();
            settings = updateNumericSetting(settings, configuration.key, getNumericSetting(defaults, configuration.key));
            commitSectionSettings(configuration.section);
        });
    }

    const onPlaybackPreferenceChange = (): void => {
        settings = normalizeWebGPUUserSettings({
            ...settings,
            playback: {
                ...settings.playback,
                enableCustomDecode: customDecodeCheckbox.checked,
                enableGPUDecodeSlicing: GPUDecodeSlicingCheckbox.checked,
                enableHDRToneMapping: HDRToneMappingCheckbox.checked
            }
        });
        persistSettings();
        setStatus(playbackStatus, globalize.translate('WebGPUPlaybackChangesSavedStatus'));
    };
    for (const checkbox of [ customDecodeCheckbox, HDRToneMappingCheckbox, GPUDecodeSlicingCheckbox ]) {
        listen(checkbox, 'change', onPlaybackPreferenceChange);
    }
    bindDefaultButton('enableCustomDecode', (): void => {
        customDecodeCheckbox.checked = createDefaultWebGPUUserSettings().playback.enableCustomDecode;
        onPlaybackPreferenceChange();
    });
    bindDefaultButton('enableHDRToneMapping', (): void => {
        HDRToneMappingCheckbox.checked = createDefaultWebGPUUserSettings().playback.enableHDRToneMapping;
        onPlaybackPreferenceChange();
    });
    bindDefaultButton('enableGPUDecodeSlicing', (): void => {
        GPUDecodeSlicingCheckbox.checked = createDefaultWebGPUUserSettings().playback.enableGPUDecodeSlicing;
        onPlaybackPreferenceChange();
    });

    // The choice applies from the next page load, which runs the tests in the background or leaves them to a playback
    const onDecoderTestTimingChange = (): void => {
        settings = normalizeWebGPUUserSettings({
            ...settings,
            playback: {
                ...settings.playback,
                decoderTestTiming: decoderTestTimingSelect.value
            }
        });
        persistSettings();
        setStatus(playbackStatus, globalize.translate('WebGPUDecoderTestTimingSavedStatus'));
    };
    listen(decoderTestTimingSelect, 'change', onDecoderTestTimingChange);
    bindDefaultButton('decoderTestTiming', (): void => {
        decoderTestTimingSelect.value = createDefaultWebGPUUserSettings().playback.decoderTestTiming;
        onDecoderTestTimingChange();
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
    listen(automaticInputPeakCheckbox, 'change', onAutomaticInputPeakChange);
    bindDefaultButton('automaticInputPeakNits', (): void => {
        automaticInputPeakCheckbox.checked = createDefaultWebGPUUserSettings().render.automaticInputPeakNits;
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
    listen(forceStereoCheckbox, 'change', onForceStereoChange);
    bindDefaultButton('forceStereoDownmix', (): void => {
        forceStereoCheckbox.checked = createDefaultWebGPUUserSettings().audio.forceStereoDownmix;
        onForceStereoChange();
    });

    const onSpeakerLayoutChange = (): void => {
        settings = normalizeWebGPUUserSettings({
            ...settings,
            audio: {
                ...settings.audio,
                speakerLayout: speakerLayoutSelect.value
            }
        });
        persistSettings();
        applyAudioOutputLayout(formatLayoutChangeStatus);
    };
    listen(speakerLayoutSelect, 'change', onSpeakerLayoutChange);
    bindDefaultButton('speakerLayout', (): void => {
        speakerLayoutSelect.value = createDefaultWebGPUUserSettings().audio.speakerLayout;
        onSpeakerLayoutChange();
    });

    const onBinauralHeadphonesChange = (): void => {
        settings = normalizeWebGPUUserSettings({
            ...settings,
            audio: {
                ...settings.audio,
                binauralHeadphones: binauralHeadphonesCheckbox.checked
            }
        });
        persistSettings();
        applyAudioOutputLayout(formatLayoutChangeStatus);
    };
    listen(binauralHeadphonesCheckbox, 'change', onBinauralHeadphonesChange);
    bindDefaultButton('binauralHeadphones', (): void => {
        binauralHeadphonesCheckbox.checked = createDefaultWebGPUUserSettings().audio.binauralHeadphones;
        onBinauralHeadphonesChange();
    });

    const persistAudioDownmixAlgorithm = (value: unknown): void => {
        audioDownmixAlgorithm = normalizeCustomAudioDownmixAlgorithm(value);
        webGPUAudioDownmixAlgorithm(audioDownmixAlgorithm);
        audioDownmixAlgorithmSelect.value = audioDownmixAlgorithm;
        refreshSelectTitles(audioDownmixAlgorithmSelect.parentElement ?? panel);
        applyAudioOutputLayout(formatLayoutChangeStatus);
    };
    listen(audioDownmixAlgorithmSelect, 'change', (): void => {
        persistAudioDownmixAlgorithm(audioDownmixAlgorithmSelect.value);
    });
    bindDefaultButton('audioDownmixAlgorithm', (): void => {
        persistAudioDownmixAlgorithm(getDefaultAudioDownmixAlgorithm());
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
    listen(operatorSelect, 'change', onOperatorChange);
    bindDefaultButton('operator', (): void => {
        operatorSelect.value = createDefaultWebGPUUserSettings().render.settings.toneMapping.operator;
        onOperatorChange();
    });

    // The video OSD places its entry to these settings anew at once
    const onSettingsButtonPlacementChange = (): void => {
        settings = normalizeWebGPUUserSettings({
            ...settings,
            osd: { ...settings.osd, settingsButtonPlacement: settingsButtonPlacementSelect.value }
        });
        persistSettings();
        applySettingsButtonPlacement();
    };
    listen(settingsButtonPlacementSelect, 'change', onSettingsButtonPlacementChange);
    bindDefaultButton('settingsButtonPlacement', (): void => {
        settingsButtonPlacementSelect.value = createDefaultWebGPUUserSettings().osd.settingsButtonPlacement;
        onSettingsButtonPlacementChange();
    });

    const onFailureWarningChange = (): void => {
        settings = normalizeWebGPUUserSettings({
            ...settings,
            osd: { ...settings.osd, webGPUFailureWarning: failureWarningCheckbox.checked }
        });
        persistSettings();
    };
    listen(failureWarningCheckbox, 'change', onFailureWarningChange);
    bindDefaultButton('webGPUFailureWarning', (): void => {
        failureWarningCheckbox.checked = createDefaultWebGPUUserSettings().osd.webGPUFailureWarning;
        onFailureWarningChange();
    });
    listen(failureReportButton, 'click', (): void => {
        const report = getLastWebGPUFailureReport();
        if (report) {
            void showWebGPUFailureReport(report);
        }
    });

    const crashedProbesElement = requireElement<HTMLElement>(panel, '[data-crashed-probes]');
    // Probe names and step labels are the engine's, shown as they are
    const showCrashedProbes = (): void => {
        const crashedProbes = readStoredCapabilityProbeVerdictState()?.crashedProbes ?? [];
        const probeTexts = crashedProbes.map((crash: CrashedCapabilityProbe): string => (
            crash.steps.length === 0 ?
                crash.probe :
                globalize.translate('WebGPUCrashedProbeSteps', crash.probe, crash.steps.join(LIST_SEPARATOR))
        ));
        setStatus(crashedProbesElement, probeTexts.length === 0 ? '' : globalize.translate('WebGPUCrashedProbes', probeTexts.join(LIST_SEPARATOR)));
        crashedProbesElement.classList.toggle(HIDDEN_CLASS, probeTexts.length === 0);
    };
    showCrashedProbes();
    listen(requireElement<HTMLButtonElement>(panel, '.webgpuSettingsClearProbeCache'), 'click', (): void => {
        clearStoredCapabilityProbeVerdicts();
        showCrashedProbes();
        setStatus(playbackStatus, globalize.translate('WebGPUProbeCacheClearedStatus'));
    });

    // Each window's reset in its title bar restores the window's settings
    const resetAudio = (): void => {
        invalidatePendingAudioOutputSelection();
        settings = resetWebGPUAudioSettings(settings);
        audioDownmixAlgorithm = getDefaultAudioDownmixAlgorithm();
        webGPUAudioDownmixAlgorithm(audioDownmixAlgorithm);
        persistSettings();
        void audioOutputManager.setSelectedDeviceId(settings.audio.outputDeviceId);
        synchronizeAudioOutputControls(audioOutputManager.getSnapshot());
        applyAudioDownmixSettings(true);
    };
    const windowResets: Readonly<Record<string, () => void>> = {
        [AUDIO_WINDOW_ID]: resetAudio,
        [INTERFACE_WINDOW_ID]: (): void => {
            settings = normalizeWebGPUUserSettings({ ...settings, osd: createDefaultWebGPUUserSettings().osd });
            persistSettings();
            applySettingsButtonPlacement();
        },
        [MASTER_WINDOW_ID]: (): void => {
            settings = normalizeWebGPUUserSettings({ ...settings, playback: createDefaultWebGPUUserSettings().playback });
            persistSettings();
            setStatus(playbackStatus, globalize.translate('WebGPUPlaybackChangesSavedStatus'));
        },
        [PICTURE_WINDOW_ID]: (): void => {
            settings = resetWebGPURenderSettings(settings);
            commitSectionSettings('render');
            // HDR output saves and applies through its own restore, which reports in its status line
            requireElement<HTMLButtonElement>(panel, '[data-default-setting="hdrOutput"]').click();
        },
        [PIPELINE_WINDOW_ID]: (): void => {
            presentationSection?.restorePipelineDefaults();
        }
    };
    listen(panel, 'click', (event: MouseEvent): void => {
        const resetButton = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-reset-window]') : null;
        const reset = resetButton ? windowResets[resetButton.dataset.resetWindow ?? ''] : undefined;
        reset?.();
    });

    listen(requireElement<HTMLButtonElement>(panel, '.webgpuSettingsResetAll'), 'click', (): void => {
        invalidatePendingAudioOutputSelection();
        settings = createDefaultWebGPUUserSettings();
        audioDownmixAlgorithm = getDefaultAudioDownmixAlgorithm();
        webGPUAudioDownmixAlgorithm(audioDownmixAlgorithm);
        persistSettings();
        void audioOutputManager.setSelectedDeviceId(settings.audio.outputDeviceId);
        synchronizeAudioOutputControls(audioOutputManager.getSnapshot());
        scheduleRenderSettings();
        applyAudioDownmixSettings(true);
        presentationSection?.apply();
        applySettingsButtonPlacement();
        setStatus(playbackStatus, globalize.translate('WebGPUPlaybackChangesSavedStatus'));
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
        updateGraphFollowing();
        graphView.destroy();
        for (const cleanupCallback of cleanupCallbacks) {
            cleanupCallback();
        }
        manager.destroy();
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

    // The OSD controls resize as they wrap; the windows keep above them
    if (OSDControls && typeof ResizeObserver === 'function') {
        const controlsObserver = new ResizeObserver(manager.requestLayout);
        controlsObserver.observe(OSDControls);
        cleanupCallbacks.push((): void => {
            controlsObserver.disconnect();
        });
    }
    if (playbackPage) {
        listen(playbackPage, 'viewbeforehide', closePanel);
    }

    document.body.appendChild(panel);
    manager.requestLayout();
    updateGraphFollowing();
    requireElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').focus();

    return { close: closePanel, element: panel, promise };
}

/** Opens or focuses the one active set of plugin-owned settings windows, with the host's playback info among them. */
export function showWebGPUPlaybackSettingsPanel(player: WebGPUPlayer): Promise<void> {
    if (activePanel) {
        const focusTarget = activePanel.element.querySelector<HTMLElement>('.webgpuSettingsClose');
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

/** Closes the active settings windows, or opens them when none are active. */
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

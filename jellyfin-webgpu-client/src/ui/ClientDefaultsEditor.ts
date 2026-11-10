import escapeHtml from 'escape-html';

import globalize from 'lib/globalize';
import {
    DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM,
    normalizeCustomAudioDownmixAlgorithm,
    type CustomAudioDownmixAlgorithm
} from 'webgpu-player/audio/processing/CustomAudioDownmixAlgorithm';
import { parsePassFile } from 'webgpu-player/presentation/passes/PassManifest';
import type { PassParameter } from 'webgpu-player/presentation/passes/PassTypes';

import { CLIENT_DEFAULT_KEYS, type ClientDefaultKey } from '../ClientDefaults';
import {
    DECODER_TEST_DEVICE_TYPES,
    DEFAULT_DECODER_TEST_BACKGROUND_DEVICES,
    describeDecoderTestClient,
    MAXIMUM_DECODER_TEST_RULE_COUNT,
    MAXIMUM_DECODER_TEST_RULES_LENGTH,
    normalizeDecoderTestBackgroundDevices,
    normalizeDecoderTestRules,
    parseDecoderTestRules,
    type DecoderTestDeviceType,
    type DecoderTestRuleProblem
} from '../DecoderTestTiming';
import { normalizeVideoPlayerPreference, VideoPlayerPreference } from '../PreferredVideoPlayer';
import {
    applyClientDefaults,
    fetchServerClientDefaults,
    saveServerClientDefaults,
    type ServerClientDefaults
} from '../ServerClientDefaults';
import { fetchServerPassSource, loadServerModuleCatalog, type ServerModuleCatalog, type ServerPassFile } from '../ServerModules';
import { getServerFileKey } from '../ServerPresentationPasses';
import {
    createBuiltInWebGPUUserSettings,
    createDefaultWebGPUUserSettings,
    MAXIMUM_PRESENTATION_FILE_COUNT,
    type WebGPUUserSettings
} from '../WebGPUUserSettings';
import { scheduleSelectLabelFallback } from './SelectLabelFallback';
import {
    AUDIO_DOWNMIX_ALGORITHM_OPTIONS,
    AUDIO_SPEAKER_LAYOUT_OPTIONS,
    createSettingOptionsHTML,
    DECODER_TEST_DEVICE_TYPE_OPTIONS,
    DECODER_TEST_TIMING_OPTIONS,
    DEINTERLACE_MODE_OPTIONS,
    NUMERIC_CONTROL_CONFIGURATIONS,
    SETTINGS_BUTTON_PLACEMENT_OPTIONS,
    TONE_MAP_OPERATOR_OPTIONS,
    VIDEO_PLAYER_PREFERENCE_OPTIONS,
    type NumericControlConfiguration,
    type SettingOption
} from './SettingDefinitions';
import { setStatus, translateToHTML } from './SettingsPanelHTML';

import './ClientDefaultsEditor.scss';

// The administrator's editor of the defaults the server sets for every user's client settings, which the plugin's settings page renders.
// Each setting shows its default: the server's value, else the add-on's built-in one; only a value that differs from the built-in one is stored.
// Each setting can also return to its built-in default, or be applied to every client, which then drops its users' own choices of it

/** A flat key the editor shows as one row; the default shader preset has a list of its own. */
type SettingKey = Exclude<ClientDefaultKey, 'presentationFiles'>;
// The device types that test in the background are the one value that is a list
type SettingValue = boolean | number | string | readonly DecoderTestDeviceType[];
type SettingValues = Readonly<Record<SettingKey, SettingValue>>;

/** The defaults stored apart from a user's settings, or set by the administrator alone, which the editor reads beside them. */
type SeparateValues = Readonly<{
    audioDownmixAlgorithm: CustomAudioDownmixAlgorithm
    decoderTestBackgroundDevices: readonly DecoderTestDeviceType[]
    decoderTestRules: string
    preferredVideoPlayer: VideoPlayerPreference
}>;

// A devices row is a checkbox per device type, and a rules row a text box of decoder test rules; neither is a user's choice
type SettingRow =
    | Readonly<{ descriptionKey: string, key: SettingKey, kind: 'boolean', labelKey: string }>
    | Readonly<{ descriptionKey?: string, key: SettingKey, kind: 'select', labelKey: string, options: ReadonlyArray<SettingOption<string>> }>
    | Readonly<{ configuration: NumericControlConfiguration, key: SettingKey, kind: 'number' }>
    | Readonly<{
        descriptionKey: string
        key: SettingKey
        kind: 'devices'
        labelKey: string
        options: ReadonlyArray<SettingOption<DecoderTestDeviceType>>
    }>
    | Readonly<{ descriptionKey: string, key: SettingKey, kind: 'rules', labelKey: string }>;

type SettingSection = Readonly<{ descriptionKey?: string, rows: readonly SettingRow[], titleKey: string }>;

/** One file of the default shader preset: its server file name, and the parameter values set for it, by name. */
type PresetFile = Readonly<{
    fileName: string
    parameters: Readonly<Record<string, number>>
}>;

/** A preset file as the editor lists it: the parameters and constants its passes declare once its source is read, else why it could not be read. */
type PresetFileView = PresetFile & Readonly<{
    declared: readonly PassParameter[] | null
    failure: string | null
}>;

/** The server's defaults as the editor shows them: each value the server sets, the preset, and the labels of the values clients refuse. */
type EditorState = Readonly<{
    presetFiles: readonly PresetFileView[]
    refusedLabels: readonly string[]
    setValues: Readonly<Partial<Record<SettingKey, SettingValue>>>
}>;

const PRESET_FILES_KEY = 'presentationFiles';
// A float parameter steps freely; integer parameters step by whole numbers
const FLOAT_PARAMETER_STEP = 'any';
const INTEGER_PARAMETER_STEP = '1';
const LIST_SEPARATOR = ', ';
const ID_PREFIX = 'webgpu-client-default-';
// The add-on's built-in decoder test rules: none, so the device types decide
const BUILT_IN_DECODER_TEST_RULES = '';
// The sentence of each problem of a rules line, which names the line, and the rule limit where the line is past it
const RULE_PROBLEM_KEYS: Readonly<Record<DecoderTestRuleProblem['reason'], string>> = Object.freeze({
    field: 'WebGPUDecoderTestRuleField',
    pattern: 'WebGPUDecoderTestRulePattern',
    syntax: 'WebGPUDecoderTestRuleSyntax',
    timing: 'WebGPUDecoderTestRuleTiming',
    'too-many': 'WebGPUDecoderTestRuleTooMany'
});

/** Returns the rows of a section's numeric settings, in the settings windows' order. */
function getNumericRows(section: NumericControlConfiguration['section']): SettingRow[] {
    return NUMERIC_CONTROL_CONFIGURATIONS
        .filter((configuration: NumericControlConfiguration): boolean => configuration.section === section)
        .map((configuration: NumericControlConfiguration): SettingRow => ({ configuration, key: configuration.key, kind: 'number' }));
}

// The decoder tests lead the page; then the sections and rows of the in-player settings, in their order, where the shader preset follows the presentation section
const LEADING_SECTIONS: readonly SettingSection[] = Object.freeze([
    {
        descriptionKey: 'WebGPUDecoderTestsHelp',
        rows: [
            {
                descriptionKey: 'WebGPUDecoderTestTimingHelp',
                key: 'decoderTestTiming',
                kind: 'select',
                labelKey: 'WebGPUDecoderTestTiming',
                options: DECODER_TEST_TIMING_OPTIONS
            },
            {
                descriptionKey: 'WebGPUDecoderTestBackgroundDevicesHelp',
                key: 'decoderTestBackgroundDevices',
                kind: 'devices',
                labelKey: 'WebGPUDecoderTestBackgroundDevices',
                options: DECODER_TEST_DEVICE_TYPE_OPTIONS
            },
            { descriptionKey: 'WebGPUDecoderTestRulesHelp', key: 'decoderTestRules', kind: 'rules', labelKey: 'WebGPUDecoderTestRules' }
        ],
        titleKey: 'WebGPUDecoderTests'
    },
    {
        rows: [
            {
                descriptionKey: 'WebGPUPreferredVideoPlayerHelp',
                key: 'preferredVideoPlayer',
                kind: 'select',
                labelKey: 'WebGPUPreferredVideoPlayer',
                options: VIDEO_PLAYER_PREFERENCE_OPTIONS
            },
            {
                descriptionKey: 'WebGPUSettingsButtonPlacementHelp',
                key: 'settingsButtonPlacement',
                kind: 'select',
                labelKey: 'WebGPUSettingsButtonPlacement',
                options: SETTINGS_BUTTON_PLACEMENT_OPTIONS
            },
            {
                descriptionKey: 'WebGPUFailureWarningSettingHelp',
                key: 'webGPUFailureWarning',
                kind: 'boolean',
                labelKey: 'WebGPUFailureWarningSetting'
            }
        ],
        titleKey: 'WebGPUPlayerControls'
    },
    {
        rows: [
            { descriptionKey: 'WebGPUEnableCustomDecodeHelp', key: 'enableCustomDecode', kind: 'boolean', labelKey: 'WebGPUEnableCustomDecode' },
            { descriptionKey: 'WebGPUEnableHDRToneMappingHelp', key: 'enableHDRToneMapping', kind: 'boolean', labelKey: 'WebGPUEnableHDRToneMapping' },
            { descriptionKey: 'WebGPUEnableGPUDecodeSlicingHelp', key: 'enableGPUDecodeSlicing', kind: 'boolean', labelKey: 'WebGPUEnableGPUDecodeSlicing' }
        ],
        titleKey: 'WebGPUPlayback'
    },
    {
        rows: [
            { key: 'toneMapOperator', kind: 'select', labelKey: 'WebGPUToneMapOperator', options: TONE_MAP_OPERATOR_OPTIONS },
            {
                descriptionKey: 'WebGPUTrackSourcePeakMetadataHelp',
                key: 'automaticInputPeakNits',
                kind: 'boolean',
                labelKey: 'WebGPUTrackSourcePeakMetadata'
            },
            ...getNumericRows('render')
        ],
        titleKey: 'WebGPUToneMappingAndDisplay'
    },
    {
        rows: [
            { descriptionKey: 'WebGPUHDROutputHelp', key: 'hdrOutput', kind: 'boolean', labelKey: 'WebGPUHDROutput' },
            { descriptionKey: 'WebGPUBlackBarCropHelp', key: 'blackBarCrop', kind: 'boolean', labelKey: 'WebGPUBlackBarCrop' },
            { descriptionKey: 'WebGPUDeinterlaceHelp', key: 'deinterlaceMode', kind: 'select', labelKey: 'WebGPUDeinterlace', options: DEINTERLACE_MODE_OPTIONS }
        ],
        titleKey: 'WebGPUPresentation'
    }
] satisfies SettingSection[]);

const TRAILING_SECTIONS: readonly SettingSection[] = Object.freeze([
    {
        rows: [
            {
                descriptionKey: 'WebGPUSpeakerLayoutHelp',
                key: 'speakerLayout',
                kind: 'select',
                labelKey: 'WebGPUSpeakerLayout',
                options: AUDIO_SPEAKER_LAYOUT_OPTIONS
            },
            {
                descriptionKey: 'WebGPUBinauralHeadphonesHelp',
                key: 'binauralHeadphones',
                kind: 'boolean',
                labelKey: 'WebGPUBinauralHeadphones'
            },
            {
                descriptionKey: 'WebGPUAudioDownmixAlgorithmHelp',
                key: 'audioDownmixAlgorithm',
                kind: 'select',
                labelKey: 'WebGPUDownmixAlgorithm',
                options: AUDIO_DOWNMIX_ALGORITHM_OPTIONS
            },
            { descriptionKey: 'WebGPUForceStereoHelp', key: 'forceStereoDownmix', kind: 'boolean', labelKey: 'WebGPUForceStereo' },
            ...getNumericRows('audio')
        ],
        titleKey: 'WebGPUAudioOutputAndDownmix'
    }
] satisfies SettingSection[]);

const SETTING_ROWS: readonly SettingRow[] = [ ...LEADING_SECTIONS, ...TRAILING_SECTIONS ]
    .flatMap((section: SettingSection): readonly SettingRow[] => section.rows);

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function joinSentences(first: string | null, second: string | null): string | null {
    if (first === null || second === null) {
        return first ?? second;
    }
    return globalize.translate('WebGPUJoinedSentences', first, second);
}

function getRowLabel(row: SettingRow): string {
    return globalize.translate(row.kind === 'number' ? row.configuration.labelKey : row.labelKey);
}

/** Whether a value equals a setting's value; a list of device types equals another that holds the same ones, in any order. */
function isSameValue(value: unknown, settingValue: SettingValue): boolean {
    if (typeof settingValue !== 'object') {
        return value === settingValue;
    }
    const entries: readonly unknown[] = Array.isArray(value) ? value : [];
    return Array.isArray(value)
        && entries.length === settingValue.length
        && settingValue.every((deviceType: DecoderTestDeviceType): boolean => entries.includes(deviceType));
}

/** Returns each flat setting's value in a client's settings, and the values stored apart from them. */
function getSettingValues(settings: WebGPUUserSettings, separateValues: SeparateValues): SettingValues {
    const display = settings.render.settings.display;
    const toneMapping = settings.render.settings.toneMapping;
    const downmix = settings.audio.downmix;
    return {
        audioDownmixAlgorithm: separateValues.audioDownmixAlgorithm,
        automaticInputPeakNits: settings.render.automaticInputPeakNits,
        binauralHeadphones: settings.audio.binauralHeadphones,
        blackBarCrop: settings.presentation.blackBarCrop,
        brightness: display.brightness,
        centerLevel: downmix.centerLevel,
        contrast: display.contrast,
        decoderTestBackgroundDevices: separateValues.decoderTestBackgroundDevices,
        decoderTestRules: separateValues.decoderTestRules,
        decoderTestTiming: settings.playback.decoderTestTiming,
        deinterlaceMode: settings.presentation.deinterlaceMode,
        desaturationStrength: toneMapping.desaturationStrength,
        enableCustomDecode: settings.playback.enableCustomDecode,
        enableGPUDecodeSlicing: settings.playback.enableGPUDecodeSlicing,
        enableHDRToneMapping: settings.playback.enableHDRToneMapping,
        exposure: toneMapping.exposure,
        forceStereoDownmix: settings.audio.forceStereoDownmix,
        hdrOutput: settings.presentation.hdrOutput,
        inputPeakNits: toneMapping.inputPeakNits,
        outputGain: downmix.outputGain,
        outputPeakNits: toneMapping.outputPeakNits,
        paperWhiteNits: toneMapping.paperWhiteNits,
        preferredVideoPlayer: separateValues.preferredVideoPlayer,
        saturation: display.saturation,
        settingsButtonPlacement: settings.osd.settingsButtonPlacement,
        speakerLayout: settings.audio.speakerLayout,
        surroundLevel: downmix.surroundLevel,
        toneMapOperator: toneMapping.operator,
        webGPUFailureWarning: settings.osd.webGPUFailureWarning
    };
}

/** Reads a preset file's stored parameter values, keeping the finite ones; refused is set when a value, or the values themselves, are left out. */
function readPresetParameters(value: unknown): Readonly<{ parameters: Record<string, number>, refused: boolean }> {
    const parameters: Record<string, number> = {};
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { parameters, refused: value !== undefined };
    }
    let refused = false;
    for (const [ name, parameterValue ] of Object.entries(value as Record<string, unknown>)) {
        if (typeof parameterValue === 'number' && Number.isFinite(parameterValue)) {
            parameters[name] = parameterValue;
        } else {
            refused = true;
        }
    }
    return { parameters, refused };
}

/** Reads the server's preset: each entry naming a file, with its finite parameter values; refused is set when an entry, a value, or a file past the limit is left out. */
function readPresetFiles(value: unknown): Readonly<{ files: PresetFile[], refused: boolean }> {
    if (value === undefined) {
        return { files: [], refused: false };
    }
    if (!Array.isArray(value)) {
        return { files: [], refused: true };
    }
    const files: PresetFile[] = [];
    let refused = value.length > MAXIMUM_PRESENTATION_FILE_COUNT;
    for (const entry of value.slice(0, MAXIMUM_PRESENTATION_FILE_COUNT) as unknown[]) {
        const record = typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : {};
        const fileName = record.fileName;
        if (typeof fileName !== 'string' || fileName.length === 0) {
            refused = true;
            continue;
        }
        const parameters = readPresetParameters(record.parameters);
        refused ||= parameters.refused;
        files.push({ fileName, parameters: parameters.parameters });
    }
    return { files, refused };
}

/** Returns each parameter or constant a file's passes declare, once, since the passes share its value; a pass whose header fails declares none. */
function getDeclaredParameters(source: string): PassParameter[] {
    const parameters: PassParameter[] = [];
    for (const entry of parsePassFile(source)) {
        const declared = entry.manifest === null ? [] : [ ...entry.manifest.parameters, ...entry.manifest.constants ];
        for (const parameter of declared) {
            if (!parameters.some((known: PassParameter): boolean => known.name === parameter.name)) {
                parameters.push(parameter);
            }
        }
    }
    return parameters;
}

/** Keeps a parameter value inside its declared range, whole for an integer parameter; a value that is no number keeps the fallback. */
function normalizeParameterValue(value: number, parameter: PassParameter, fallback: number): number {
    if (!Number.isFinite(value)) {
        return fallback;
    }
    const clamped = Math.min(Math.max(value, parameter.minimum), parameter.maximum);
    return parameter.type === 'f32' ? clamped : Math.round(clamped);
}

/** Returns the values set for the parameters a file declares, leaving out each one equal to its pass default. */
function getChangedParameters(parameters: Readonly<Record<string, number>>, declared: readonly PassParameter[]): Record<string, number> {
    const changed: Record<string, number> = {};
    for (const parameter of declared) {
        const value = normalizeParameterValue(parameters[parameter.name] ?? parameter.defaultValue, parameter, parameter.defaultValue);
        if (value !== parameter.defaultValue) {
            changed[parameter.name] = value;
        }
    }
    return changed;
}

/** Returns a row's control, with its description beneath it as the host's settings pages place one. */
function createRowControlHTML(row: SettingRow, descriptionKey: string | undefined): string {
    const id = `${ID_PREFIX}${row.key}`;
    const description = descriptionKey === undefined ? '' : translateToHTML(descriptionKey);
    switch (row.kind) {
        case 'boolean':
            return `
                <div class="checkboxContainer checkboxContainer-withDescription">
                    <label>
                        <input data-client-default-value="${row.key}" id="${id}" is="emby-checkbox" type="checkbox" />
                        <span>${translateToHTML(row.labelKey)}</span>
                    </label>
                    ${description === '' ? '' : `<div class="fieldDescription checkboxFieldDescription">${description}</div>`}
                </div>`;
        case 'select':
            return `
                <div class="selectContainer">
                    <select
                        data-client-default-value="${row.key}"
                        id="${id}"
                        is="emby-select"
                        label="${translateToHTML(row.labelKey)}"
                    >${createSettingOptionsHTML(row.options)}</select>
                    ${description === '' ? '' : `<div class="fieldDescription">${description}</div>`}
                </div>`;
        case 'number': {
            const configuration = row.configuration;
            const label = globalize.translate(configuration.labelKey);
            const labelHTML = configuration.unitKey ?
                translateToHTML('WebGPUSettingWithUnit', label, globalize.translate(configuration.unitKey)) :
                escapeHtml(label);
            return `
                <div class="inputContainer">
                    <input
                        data-client-default-value="${row.key}"
                        id="${id}"
                        is="emby-input"
                        label="${labelHTML}"
                        max="${configuration.range.maximum}"
                        min="${configuration.range.minimum}"
                        step="${configuration.range.step}"
                        type="number"
                    />
                    ${description === '' ? '' : `<div class="fieldDescription">${description}</div>`}
                </div>`;
        }
        case 'devices':
            return `
                <div class="webgpuClientDefaultsDevices">
                    <div class="checkboxListLabel">${translateToHTML(row.labelKey)}</div>
                    <div class="checkboxList">
                        ${row.options.map((option: SettingOption<DecoderTestDeviceType>): string => `
                            <label>
                                <input
                                    data-client-default-value="${row.key}"
                                    id="${id}-${option.value}"
                                    is="emby-checkbox"
                                    type="checkbox"
                                    value="${option.value}"
                                />
                                <span>${translateToHTML(option.labelKey ?? option.value)}</span>
                            </label>`).join('')}
                    </div>
                    <div class="fieldDescription">${description}</div>
                </div>`;
        case 'rules':
            // The text box wraps no line, so each rule shows on a line of its own, and the problems name lines as written
            return `
                <div class="inputContainer webgpuClientDefaultsRules">
                    <label class="textareaLabel" for="${id}">${translateToHTML(row.labelKey)}</label>
                    <textarea
                        autocomplete="off"
                        class="emby-textarea"
                        data-client-default-value="${row.key}"
                        id="${id}"
                        rows="6"
                        spellcheck="false"
                        wrap="off"
                    ></textarea>
                    <div aria-live="polite" class="fieldDescription" data-client-defaults-rule-problems></div>
                    <div class="fieldDescription">${translateToHTML(
                        row.descriptionKey,
                        MAXIMUM_DECODER_TEST_RULE_COUNT,
                        MAXIMUM_DECODER_TEST_RULES_LENGTH
                    )}</div>
                    ${createClientValuesHTML()}
                </div>`;
    }
}

/** Returns this browser's values that rules match, and its device type, for an administrator to copy into a rule, each line written as a rule's field. */
function createClientValuesHTML(): string {
    const client = describeDecoderTestClient();
    const deviceTypeKey = DECODER_TEST_DEVICE_TYPE_OPTIONS
        .find((option: SettingOption<DecoderTestDeviceType>): boolean => option.value === client.deviceType)?.labelKey;
    const fields: ReadonlyArray<readonly [ string, string ]> = [
        [ 'client', client.client ],
        [ 'device', client.device ],
        [ 'version', client.version ],
        [ 'ua', client.userAgent ]
    ];
    return `
        <div class="fieldDescription webgpuClientDefaultsClientValues" data-client-defaults-client-values>
            <div>${translateToHTML('WebGPUDecoderTestClientValues')}</div>
            <ul>
                <li>${translateToHTML('WebGPUDecoderTestClientDeviceType', globalize.translate(deviceTypeKey ?? client.deviceType))}</li>
                ${fields.map(([ field, value ]: readonly [ string, string ]): string => (
                    `<li data-client-defaults-client-value="${field}">${field}: <code>${escapeHtml(value)}</code></li>`
                )).join('')}
            </ul>
        </div>`;
}

/** Returns the text of each problem of decoder test rules, as sentences: a text past the length limit, then each invalid line. */
function describeRuleProblems(text: string): string[] {
    const sentences: string[] = [];
    if (text.length > MAXIMUM_DECODER_TEST_RULES_LENGTH) {
        sentences.push(globalize.translate('WebGPUDecoderTestRulesTooLong', text.length, MAXIMUM_DECODER_TEST_RULES_LENGTH));
    }
    for (const problem of parseDecoderTestRules(text).problems) {
        sentences.push(globalize.translate(RULE_PROBLEM_KEYS[problem.reason], problem.line, MAXIMUM_DECODER_TEST_RULE_COUNT));
    }
    return sentences;
}

/** Returns a setting's buttons that apply its default to every client, when users choose it themselves, and return it to the built-in default, each named by the setting's label. */
function createActionsHTML(key: ClientDefaultKey, label: string, applicable: boolean): string {
    const applyHTML = applicable ? `
            <button
                aria-label="${translateToHTML('WebGPUClientDefaultsApplyLabel', label)}"
                class="raised button-alt"
                data-client-default-apply="${key}"
                is="emby-button"
                type="button"
            ><span>${translateToHTML('WebGPUClientDefaultsApply')}</span></button>` : '';
    return `
        <div class="webgpuClientDefaultActions">
            ${applyHTML}
            <button
                aria-label="${translateToHTML('WebGPUClientDefaultsResetLabel', label)}"
                class="raised"
                data-client-default-reset="${key}"
                is="emby-button"
                type="button"
            ><span>${translateToHTML('WebGPUClientDefaultsReset')}</span></button>
        </div>`;
}

function createRowHTML(row: SettingRow): string {
    const descriptionKey = row.kind === 'number' ? row.configuration.descriptionKey : row.descriptionKey;
    const label = getRowLabel(row);
    // The decoder test device types and rules are the administrator's alone, so no user's choice of them exists to drop
    const applicable = row.kind !== 'devices' && row.kind !== 'rules';
    return `
        <div aria-label="${escapeHtml(label)}" class="verticalSection webgpuClientDefaultRow" data-client-default="${row.key}" role="group">
            ${createRowControlHTML(row, descriptionKey)}
            ${createActionsHTML(row.key, label, applicable)}
        </div>`;
}

function createSectionHTML(section: SettingSection): string {
    return `
        <div class="verticalSection">
            <h3 class="sectionTitle">${translateToHTML(section.titleKey)}</h3>
            ${section.descriptionKey === undefined ? '' : `<div class="fieldDescription">${translateToHTML(section.descriptionKey)}</div>`}
            ${section.rows.map(createRowHTML).join('')}
        </div>`;
}

function createPresetSectionHTML(): string {
    return `
        <div class="verticalSection" data-client-defaults-preset>
            <h3 class="sectionTitle">${translateToHTML('WebGPUShaderPasses')}</h3>
            <div class="fieldDescription">${translateToHTML('WebGPUClientDefaultsShaderPassesHelp', MAXIMUM_PRESENTATION_FILE_COUNT)}</div>
            <div data-client-defaults-preset-files></div>
            <div class="selectContainer">
                <select
                    data-client-defaults-preset-choice
                    id="${ID_PREFIX}preset-choice"
                    is="emby-select"
                    label="${translateToHTML('WebGPUServerPasses')}"
                ></select>
            </div>
            <div class="webgpuClientDefaultRow">
                <div>
                    <button class="raised" data-client-defaults-preset-add is="emby-button" type="button">
                        <span>${translateToHTML('Add')}</span>
                    </button>
                </div>
                ${createActionsHTML(PRESET_FILES_KEY, globalize.translate('WebGPUShaderPasses'), true)}
            </div>
        </div>`;
}

function createEditorHTML(): string {
    return `
        <div class="fieldDescription">${translateToHTML('WebGPUClientDefaultsHelp')}</div>
        ${LEADING_SECTIONS.map(createSectionHTML).join('')}
        ${createPresetSectionHTML()}
        ${TRAILING_SECTIONS.map(createSectionHTML).join('')}
        <div aria-live="polite" class="fieldDescription" data-client-defaults-status role="status"></div>
        <button class="raised button-submit block" data-client-defaults-save is="emby-button" type="button">
            <span>${translateToHTML('Save')}</span>
        </button>`;
}

function createParameterHTML(file: PresetFileView, fileIndex: number, parameter: PassParameter): string {
    const value = file.parameters[parameter.name] ?? parameter.defaultValue;
    const step = parameter.type === 'f32' ? FLOAT_PARAMETER_STEP : INTEGER_PARAMETER_STEP;
    return `
        <div class="inputContainer">
            <input
                aria-label="${translateToHTML('WebGPUShaderPassParameter', file.fileName, parameter.name)}"
                data-client-defaults-parameter="${escapeHtml(parameter.name)}"
                data-file-index="${fileIndex}"
                is="emby-input"
                label="${escapeHtml(parameter.name)}"
                max="${parameter.maximum}"
                min="${parameter.minimum}"
                step="${step}"
                type="number"
                value="${value}"
            />
            <div class="fieldDescription">${translateToHTML(
                'WebGPUClientDefaultsParameterRange',
                parameter.defaultValue,
                parameter.minimum,
                parameter.maximum
            )}</div>
        </div>`;
}

function createPresetFileHTML(file: PresetFileView, index: number, catalog: ServerModuleCatalog | null): string {
    const fileKey = getServerFileKey(file.fileName);
    const offered = catalog === null || catalog.passes.some((entry: ServerPassFile): boolean => getServerFileKey(entry.fileName) === fileKey);
    const removeLabel = translateToHTML('WebGPURemoveShaderPass', file.fileName);
    const notes: string[] = [];
    if (!offered) {
        notes.push(globalize.translate('WebGPUClientDefaultsPassNotOffered'));
    }
    if (file.failure !== null) {
        notes.push(globalize.translate('WebGPUClientDefaultsPassUnreadable', file.failure));
    }
    const parametersHTML = (file.declared ?? [])
        .map((parameter: PassParameter): string => createParameterHTML(file, index, parameter))
        .join('');
    return `
        <div class="verticalSection" data-client-defaults-preset-file="${index}">
            <div class="flex align-items-center">
                <h4 class="flex-grow">${escapeHtml(file.fileName)}</h4>
                <button
                    aria-label="${removeLabel}"
                    data-client-defaults-preset-remove="${index}"
                    is="paper-icon-button-light"
                    title="${removeLabel}"
                    type="button"
                ><span class="material-icons delete" aria-hidden="true"></span></button>
            </div>
            ${notes.map((note: string): string => `<div class="fieldDescription">${escapeHtml(note)}</div>`).join('')}
            ${parametersHTML}
        </div>`;
}

function requireElement<ElementType extends Element>(root: ParentNode, selector: string): ElementType {
    const element = root.querySelector<ElementType>(selector);
    if (!element) {
        throw new Error(`client-defaults-editor-invalid: ${selector}`);
    }
    return element;
}

/** Returns the control that holds a row's value; a devices row holds it in a checkbox per device type, of which this is the first. */
function getValueControl(root: ParentNode, key: SettingKey): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
    return requireElement<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(root, `[data-client-default-value="${key}"]`);
}

/** Shows a value in a row's control; a number input also keeps it as the value an entry that is no number returns to. */
function showRowValue(root: ParentNode, row: SettingRow, value: SettingValue): void {
    if (row.kind === 'devices') {
        const deviceTypes: readonly unknown[] = typeof value === 'object' ? value : [];
        for (const checkbox of Array.from(root.querySelectorAll<HTMLInputElement>(`[data-client-default-value="${row.key}"]`))) {
            checkbox.checked = deviceTypes.includes(checkbox.value);
        }
        return;
    }
    const control = getValueControl(root, row.key);
    if (row.kind === 'boolean') {
        (control as HTMLInputElement).checked = value === true;
    } else if (row.kind === 'number') {
        (control as HTMLInputElement).defaultValue = String(value);
        control.value = String(value);
    } else {
        control.value = String(value);
    }
}

/** Reads a row's control: its checkbox, its option, its text, its number kept inside the setting's range, else the number it last showed, or its checked device types in their order. */
function readRowValue(root: ParentNode, row: SettingRow): SettingValue {
    let value: SettingValue;
    if (row.kind === 'devices') {
        const checkedTypes = Array.from(root.querySelectorAll<HTMLInputElement>(`[data-client-default-value="${row.key}"]`))
            .filter((checkbox: HTMLInputElement): boolean => checkbox.checked)
            .map((checkbox: HTMLInputElement): string => checkbox.value);
        value = DECODER_TEST_DEVICE_TYPES.filter((deviceType: DecoderTestDeviceType): boolean => checkedTypes.includes(deviceType));
    } else {
        const control = getValueControl(root, row.key);
        value = control.value;
        if (row.kind === 'boolean') {
            value = (control as HTMLInputElement).checked;
        } else if (row.kind === 'number') {
            const range = row.configuration.range;
            const entered = control.value === '' ? Number.NaN : Number(control.value);
            value = Number.isFinite(entered) ?
                Math.min(Math.max(entered, range.minimum), range.maximum) :
                Number((control as HTMLInputElement).defaultValue);
        }
    }
    return value;
}

/** Downloads a file's source once per editor, and reads what its passes declare; a failed download names what failed. */
async function describePresetFile(file: PresetFile, sources: Map<string, Promise<string>>): Promise<PresetFileView> {
    const fileKey = getServerFileKey(file.fileName);
    let source = sources.get(fileKey);
    if (source === undefined) {
        source = fetchServerPassSource(file.fileName);
        sources.set(fileKey, source);
        // A failed download is tried again by the next render
        source.catch((): void => {
            sources.delete(fileKey);
        });
    }
    try {
        return { ...file, declared: getDeclaredParameters(await source), failure: null };
    } catch (error) {
        return { ...file, declared: null, failure: getErrorMessage(error) };
    }
}

/**
 * Reads the server's defaults into what the editor shows, and applies them to the page, which follows them from now on, as a refresh applies them.
 * Each value reads through its setting's own normalization, as clients read it; a value that reads otherwise shows what clients use and is named.
 */
async function readEditorState(serverDefaults: ServerClientDefaults, sources: Map<string, Promise<string>>): Promise<EditorState> {
    applyClientDefaults(serverDefaults);
    const defaults = serverDefaults.settings;
    const clientValues = getSettingValues(createDefaultWebGPUUserSettings(), {
        audioDownmixAlgorithm: normalizeCustomAudioDownmixAlgorithm(defaults.audioDownmixAlgorithm),
        decoderTestBackgroundDevices: normalizeDecoderTestBackgroundDevices(defaults.decoderTestBackgroundDevices)
            ?? DEFAULT_DECODER_TEST_BACKGROUND_DEVICES,
        decoderTestRules: normalizeDecoderTestRules(defaults.decoderTestRules) ?? BUILT_IN_DECODER_TEST_RULES,
        preferredVideoPlayer: normalizeVideoPlayerPreference(defaults.preferredVideoPlayer)
    });
    const setValues: Partial<Record<SettingKey, SettingValue>> = {};
    const refusedLabels: string[] = [];
    for (const row of SETTING_ROWS) {
        const serverValue = defaults[row.key];
        if (serverValue === undefined) {
            continue;
        }
        setValues[row.key] = clientValues[row.key];
        if (!isSameValue(serverValue, clientValues[row.key])) {
            refusedLabels.push(getRowLabel(row));
        }
    }
    const preset = readPresetFiles(defaults[PRESET_FILES_KEY]);
    if (preset.refused) {
        refusedLabels.push(globalize.translate('WebGPUShaderPasses'));
    }
    const presetFiles = await Promise.all(preset.files.map((file: PresetFile): Promise<PresetFileView> => describePresetFile(file, sources)));
    return { presetFiles, refusedLabels, setValues };
}

function describeRefusedValues(state: EditorState): string | null {
    return state.refusedLabels.length === 0 ?
        null :
        globalize.translate('WebGPUClientDefaultsRefused', state.refusedLabels.join(LIST_SEPARATOR));
}

/**
 * Renders the editor of the server's client defaults into an element, replacing its content, and resolves once it shows the server's defaults.
 * A failed read of the server's pass files shows in the status line, and the rest of the form stays usable.
 * A failed read of the defaults shows there too, and the form cannot save: a save replaces every default, so it would drop the ones the form never showed.
 */
export async function renderClientDefaultsEditor(element: HTMLElement): Promise<void> {
    const builtInValues = getSettingValues(createBuiltInWebGPUUserSettings(), {
        audioDownmixAlgorithm: DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM,
        decoderTestBackgroundDevices: DEFAULT_DECODER_TEST_BACKGROUND_DEVICES,
        decoderTestRules: BUILT_IN_DECODER_TEST_RULES,
        preferredVideoPlayer: VideoPlayerPreference.Auto
    });
    // Each pass file's source by its server key, downloaded once for this editor
    const sources = new Map<string, Promise<string>>();
    const [ defaultsResult, catalogResult ] = await Promise.allSettled([
        fetchServerClientDefaults(),
        loadServerModuleCatalog(null, true)
    ]);
    const catalog = catalogResult.status === 'fulfilled' ? catalogResult.value : null;
    const catalogFailure = catalogResult.status === 'rejected' ?
        globalize.translate('WebGPUServerPassesUnavailable', getErrorMessage(catalogResult.reason)) :
        null;
    const readFailure = defaultsResult.status === 'rejected' ?
        globalize.translate('WebGPUClientDefaultsReadFailed', getErrorMessage(defaultsResult.reason)) :
        null;
    // Without the server's defaults the form starts with the built-in values and cannot save, and the page keeps the defaults it follows
    const defaultsRead = defaultsResult.status === 'fulfilled';
    const initialState: EditorState = defaultsRead ?
        await readEditorState(defaultsResult.value, sources) :
        { presetFiles: [], refusedLabels: [], setValues: {} };

    // A fresh root each render, since the page renders the editor into the same element on each visit
    const root = document.createElement('div');
    root.className = 'webgpuClientDefaultsEditor';
    root.innerHTML = createEditorHTML();
    element.textContent = '';
    element.appendChild(root);
    // The host may not have registered emby-select on its dashboard
    scheduleSelectLabelFallback(root);
    const statusElement = requireElement<HTMLElement>(root, '[data-client-defaults-status]');
    const saveButton = requireElement<HTMLButtonElement>(root, '[data-client-defaults-save]');
    const applyButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-client-default-apply]'));
    const presetFilesElement = requireElement<HTMLElement>(root, '[data-client-defaults-preset-files]');
    const presetChoice = requireElement<HTMLSelectElement>(root, '[data-client-defaults-preset-choice]');
    const presetAddButton = requireElement<HTMLButtonElement>(root, '[data-client-defaults-preset-add]');
    const rulesControl = requireElement<HTMLTextAreaElement>(root, '[data-client-default-value="decoderTestRules"]');
    const ruleProblemsElement = requireElement<HTMLElement>(root, '[data-client-defaults-rule-problems]');
    let presetFiles: PresetFileView[] = [];
    let saving = false;
    let adding = false;

    const renderPreset = (): void => {
        presetFilesElement.innerHTML = presetFiles.length === 0 ?
            `<div class="fieldDescription">${translateToHTML('WebGPUShaderPassesNone')}</div>` :
            presetFiles.map((file: PresetFileView, index: number): string => createPresetFileHTML(file, index, catalog)).join('');
        const listedKeys = new Set<string>(presetFiles.map((file: PresetFileView): string => getServerFileKey(file.fileName)));
        const addable = (catalog?.passes ?? []).filter((entry: ServerPassFile): boolean => !listedKeys.has(getServerFileKey(entry.fileName)));
        const full = presetFiles.length >= MAXIMUM_PRESENTATION_FILE_COUNT;
        let emptyText: string | null = null;
        if (full) {
            emptyText = globalize.translate('WebGPUClientDefaultsShaderPassesFull', MAXIMUM_PRESENTATION_FILE_COUNT);
        } else if (addable.length === 0) {
            emptyText = catalogFailure ?? globalize.translate('WebGPUServerPassesNone');
        }
        presetChoice.innerHTML = emptyText === null ?
            addable.map((entry: ServerPassFile): string => (
                `<option value="${escapeHtml(entry.fileName)}">${translateToHTML('WebGPUServerPassOption', entry.fileName, entry.passNames.join(LIST_SEPARATOR))}</option>`
            )).join('') :
            `<option value="">${escapeHtml(emptyText)}</option>`;
        presetChoice.disabled = emptyText !== null || adding;
        presetAddButton.disabled = emptyText !== null || adding;
    };

    /** Shows the problems of the rules in the text box beneath it, a line each. */
    const showRuleProblems = (): void => {
        ruleProblemsElement.innerHTML = describeRuleProblems(rulesControl.value)
            .map((problem: string): string => `<div>${escapeHtml(problem)}</div>`)
            .join('');
    };

    /** Shows the server's defaults: each value the server sets, else the built-in one. */
    const showState = (state: EditorState): void => {
        for (const row of SETTING_ROWS) {
            showRowValue(root, row, state.setValues[row.key] ?? builtInValues[row.key]);
        }
        showRuleProblems();
        presetFiles = [ ...state.presetFiles ];
        renderPreset();
    };

    /** Returns the defaults the form sets: each row's value that differs from its built-in one, and the preset when it lists a file. */
    const readForm = (): Record<string, unknown> => {
        const settings: Record<string, unknown> = {};
        for (const row of SETTING_ROWS) {
            const value = readRowValue(root, row);
            if (!isSameValue(value, builtInValues[row.key])) {
                settings[row.key] = value;
            }
        }
        if (presetFiles.length > 0) {
            settings[PRESET_FILES_KEY] = presetFiles.map((file: PresetFileView): PresetFile => ({
                fileName: file.fileName,
                // A file whose source could not be read keeps the values the server holds for it
                parameters: file.declared === null ? file.parameters : getChangedParameters(file.parameters, file.declared)
            }));
        }
        return settings;
    };

    const setSaving = (value: boolean): void => {
        saving = value;
        for (const button of [ saveButton, ...applyButtons ]) {
            button.disabled = value || !defaultsRead;
        }
    };

    /** Stores the form, applying the given setting to every client when one is given; rules with problems store nothing, and the status line names each problem. */
    const save = async (applied: ClientDefaultKey | null): Promise<void> => {
        const ruleProblems = describeRuleProblems(rulesControl.value);
        if (ruleProblems.length > 0) {
            const problemsText = ruleProblems.reduce<string | null>(joinSentences, null);
            setStatus(statusElement, joinSentences(globalize.translate('WebGPUDecoderTestRulesNotSaved'), problemsText) ?? '');
            return;
        }
        setSaving(true);
        try {
            const stored = await saveServerClientDefaults(readForm(), applied === null ? [] : [ applied ]);
            const state = await readEditorState(stored, sources);
            showState(state);
            const appliedRow = SETTING_ROWS.find((row: SettingRow): boolean => row.key === applied);
            const appliedLabel = appliedRow === undefined ? globalize.translate('WebGPUShaderPasses') : getRowLabel(appliedRow);
            const savedText = applied === null ?
                globalize.translate('SettingsSaved') :
                globalize.translate('WebGPUClientDefaultsApplied', appliedLabel);
            setStatus(statusElement, joinSentences(savedText, describeRefusedValues(state)) ?? '');
        } catch (error) {
            setStatus(statusElement, globalize.translate('WebGPUClientDefaultsSaveFailed', getErrorMessage(error)));
        } finally {
            setSaving(false);
        }
    };

    /** Shows a setting's built-in default, which a save stores as no server default. */
    const resetSetting = (key: string | undefined): void => {
        if (key === PRESET_FILES_KEY) {
            presetFiles = [];
            renderPreset();
            return;
        }
        const row = SETTING_ROWS.find((settingRow: SettingRow): boolean => settingRow.key === key);
        if (row !== undefined) {
            showRowValue(root, row, builtInValues[row.key]);
            showRuleProblems();
        }
    };

    const addPresetFile = async (): Promise<void> => {
        const entry = catalog?.passes.find((pass: ServerPassFile): boolean => pass.fileName === presetChoice.value);
        if (!entry || presetFiles.length >= MAXIMUM_PRESENTATION_FILE_COUNT) {
            return;
        }
        adding = true;
        renderPreset();
        const file = await describePresetFile({ fileName: entry.fileName, parameters: {} }, sources);
        adding = false;
        presetFiles = [ ...presetFiles, file ];
        renderPreset();
    };

    root.addEventListener('input', (event: Event): void => {
        if (event.target === rulesControl) {
            showRuleProblems();
        }
    });

    root.addEventListener('change', (event: Event): void => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) {
            return;
        }
        const row = SETTING_ROWS.find((settingRow: SettingRow): boolean => settingRow.key === target.dataset.clientDefaultValue);
        if (row !== undefined && row.kind === 'number') {
            showRowValue(root, row, readRowValue(root, row));
            return;
        }
        const parameterName = target.dataset.clientDefaultsParameter;
        const file = presetFiles.at(Number(target.dataset.fileIndex));
        const parameter = file?.declared?.find((declared: PassParameter): boolean => declared.name === parameterName);
        if (file === undefined || parameter === undefined) {
            return;
        }
        const value = normalizeParameterValue(
            target.value === '' ? Number.NaN : Number(target.value),
            parameter,
            file.parameters[parameter.name] ?? parameter.defaultValue
        );
        target.value = String(value);
        presetFiles = presetFiles.map((presetFile: PresetFileView): PresetFileView => (
            presetFile === file ? { ...presetFile, parameters: { ...presetFile.parameters, [parameter.name]: value } } : presetFile
        ));
    });

    root.addEventListener('click', (event: Event): void => {
        const target = event.target instanceof Element ? event.target : null;
        const removeButton = target?.closest<HTMLElement>('[data-client-defaults-preset-remove]');
        const applyButton = target?.closest<HTMLElement>('[data-client-default-apply]');
        const resetButton = target?.closest<HTMLElement>('[data-client-default-reset]');
        if (removeButton) {
            const removedIndex = Number(removeButton.dataset.clientDefaultsPresetRemove);
            presetFiles = presetFiles.filter((_file: PresetFileView, index: number): boolean => index !== removedIndex);
            renderPreset();
        } else if (resetButton) {
            resetSetting(resetButton.dataset.clientDefaultReset);
        } else if (applyButton && !saving && defaultsRead) {
            const key = CLIENT_DEFAULT_KEYS.find((defaultKey: ClientDefaultKey): boolean => defaultKey === applyButton.dataset.clientDefaultApply);
            if (key !== undefined) {
                void save(key);
            }
        } else if (target?.closest('[data-client-defaults-preset-add]') && !adding) {
            void addPresetFile();
        } else if (target?.closest('[data-client-defaults-save]') && !saving && defaultsRead) {
            void save(null);
        }
    });

    showState(initialState);
    setSaving(false);
    setStatus(statusElement, joinSentences(joinSentences(readFailure, catalogFailure), describeRefusedValues(initialState)) ?? '');
}

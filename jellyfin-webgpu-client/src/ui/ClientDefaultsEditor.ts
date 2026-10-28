import escapeHtml from 'escape-html';

import globalize from 'lib/globalize';
import {
    DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM,
    normalizeCustomAudioDownmixAlgorithm,
    type CustomAudioDownmixAlgorithm
} from 'webgpu-player/audio/processing/CustomAudioDownmixAlgorithm';
import { parsePassFile } from 'webgpu-player/presentation/passes/PassManifest';
import type { PassParameter } from 'webgpu-player/presentation/passes/PassTypes';

import { setClientDefaults, type ClientDefaultKey, type ClientDefaults } from '../ClientDefaults';
import { normalizeVideoPlayerPreference, VideoPlayerPreference } from '../PreferredVideoPlayer';
import { fetchServerClientDefaults, saveServerClientDefaults } from '../ServerClientDefaults';
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
    createSettingOptionsHTML,
    DEINTERLACE_MODE_OPTIONS,
    NUMERIC_CONTROL_CONFIGURATIONS,
    SETTINGS_BUTTON_PLACEMENT_OPTIONS,
    TONE_MAP_OPERATOR_OPTIONS,
    VIDEO_PLAYER_PREFERENCE_OPTIONS,
    type NumericControlConfiguration,
    type SettingOption
} from './SettingDefinitions';
import { setStatus, translateToHTML } from './SettingsPanelHTML';

// The administrator's editor of the defaults the server sets for every user's client settings, which the plugin's settings page renders.
// Each setting is either set on the server, holding its value, or not set, showing the add-on's built-in default that clients then use

/** A flat key the editor shows as one row; the default shader preset has a list of its own. */
type SettingKey = Exclude<ClientDefaultKey, 'presentationFiles'>;
type SettingValue = boolean | number | string;
type SettingValues = Readonly<Record<SettingKey, SettingValue>>;

type SettingRow =
    | Readonly<{ descriptionKey: string, key: SettingKey, kind: 'boolean', labelKey: string }>
    | Readonly<{ descriptionKey?: string, key: SettingKey, kind: 'select', labelKey: string, options: ReadonlyArray<SettingOption<string>> }>
    | Readonly<{ configuration: NumericControlConfiguration, key: SettingKey, kind: 'number' }>;

type SettingSection = Readonly<{ rows: readonly SettingRow[], titleKey: string }>;

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

/** The server's defaults as the editor shows them: each set row's value, the preset, and the labels of the values clients refuse. */
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

/** Returns the rows of a section's numeric settings, in the panel's order. */
function getNumericRows(section: NumericControlConfiguration['section']): SettingRow[] {
    return NUMERIC_CONTROL_CONFIGURATIONS
        .filter((configuration: NumericControlConfiguration): boolean => configuration.section === section)
        .map((configuration: NumericControlConfiguration): SettingRow => ({ configuration, key: configuration.key, kind: 'number' }));
}

// The sections and rows of the playback settings panel, in its order; the shader preset follows the presentation section
const LEADING_SECTIONS: readonly SettingSection[] = Object.freeze([
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
            { descriptionKey: 'WebGPUDeinterlaceHelp', key: 'deinterlaceMode', kind: 'select', labelKey: 'WebGPUDeinterlace', options: DEINTERLACE_MODE_OPTIONS }
        ],
        titleKey: 'WebGPUPresentation'
    }
] satisfies SettingSection[]);

const TRAILING_SECTIONS: readonly SettingSection[] = Object.freeze([
    {
        rows: [
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

/** Returns each flat setting's value in a client's settings. */
function getSettingValues(
    settings: WebGPUUserSettings,
    preferredVideoPlayer: VideoPlayerPreference,
    audioDownmixAlgorithm: CustomAudioDownmixAlgorithm
): SettingValues {
    const display = settings.render.settings.display;
    const toneMapping = settings.render.settings.toneMapping;
    const downmix = settings.audio.downmix;
    return {
        audioDownmixAlgorithm,
        automaticInputPeakNits: settings.render.automaticInputPeakNits,
        brightness: display.brightness,
        centerLevel: downmix.centerLevel,
        contrast: display.contrast,
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
        preferredVideoPlayer,
        saturation: display.saturation,
        settingsButtonPlacement: settings.osd.settingsButtonPlacement,
        surroundLevel: downmix.surroundLevel,
        toneMapOperator: toneMapping.operator
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
                        <input data-client-default-value="${row.key}" disabled id="${id}" is="emby-checkbox" type="checkbox" />
                        <span>${translateToHTML(row.labelKey)}</span>
                    </label>
                    ${description === '' ? '' : `<div class="fieldDescription checkboxFieldDescription">${description}</div>`}
                </div>`;
        case 'select':
            return `
                <div class="selectContainer">
                    <select
                        data-client-default-value="${row.key}"
                        disabled
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
                        disabled
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
    }
}

function createRowHTML(row: SettingRow): string {
    const descriptionKey = row.kind === 'number' ? row.configuration.descriptionKey : row.descriptionKey;
    return `
        <div aria-label="${escapeHtml(getRowLabel(row))}" class="verticalSection" data-client-default="${row.key}" role="group">
            ${createRowControlHTML(row, descriptionKey)}
            <label class="checkboxContainer">
                <input data-client-default-set="${row.key}" is="emby-checkbox" type="checkbox" />
                <span>${translateToHTML('WebGPUClientDefaultsSetOnServer')}</span>
            </label>
        </div>`;
}

function createSectionHTML(section: SettingSection): string {
    return `
        <div class="verticalSection">
            <h3 class="sectionTitle">${translateToHTML(section.titleKey)}</h3>
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
            <button class="raised" data-client-defaults-preset-add is="emby-button" type="button">
                <span>${translateToHTML('Add')}</span>
            </button>
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

/** Returns the control that holds a row's value. */
function getValueControl(root: ParentNode, key: SettingKey): HTMLInputElement | HTMLSelectElement {
    return requireElement<HTMLInputElement | HTMLSelectElement>(root, `[data-client-default-value="${key}"]`);
}

function getSetCheckbox(root: ParentNode, key: SettingKey): HTMLInputElement {
    return requireElement<HTMLInputElement>(root, `[data-client-default-set="${key}"]`);
}

/** Shows a value in a row's control; a number input also keeps it as the value an entry that is no number returns to. */
function showRowValue(root: ParentNode, row: SettingRow, value: SettingValue): void {
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

/** Reads a row's control: its checkbox, its option, or its number kept inside the setting's range, else the number it last showed. */
function readRowValue(root: ParentNode, row: SettingRow): SettingValue {
    const control = getValueControl(root, row.key);
    let value: SettingValue = control.value;
    if (row.kind === 'boolean') {
        value = (control as HTMLInputElement).checked;
    } else if (row.kind === 'number') {
        const range = row.configuration.range;
        const entered = control.value === '' ? Number.NaN : Number(control.value);
        value = Number.isFinite(entered) ?
            Math.min(Math.max(entered, range.minimum), range.maximum) :
            Number((control as HTMLInputElement).defaultValue);
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
 * Reads the server's defaults into what the editor shows, which the page follows from now on, as a refresh applies them.
 * Each value reads through its setting's own normalization, as clients read it; a value that reads otherwise shows what clients use and is named.
 */
async function readEditorState(defaults: ClientDefaults, sources: Map<string, Promise<string>>): Promise<EditorState> {
    setClientDefaults(defaults);
    const clientValues = getSettingValues(
        createDefaultWebGPUUserSettings(),
        normalizeVideoPlayerPreference(defaults.preferredVideoPlayer),
        normalizeCustomAudioDownmixAlgorithm(defaults.audioDownmixAlgorithm)
    );
    const setValues: Partial<Record<SettingKey, SettingValue>> = {};
    const refusedLabels: string[] = [];
    for (const row of SETTING_ROWS) {
        const serverValue = defaults[row.key];
        if (serverValue === undefined) {
            continue;
        }
        setValues[row.key] = clientValues[row.key];
        if (serverValue !== clientValues[row.key]) {
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
    const builtInValues = getSettingValues(createBuiltInWebGPUUserSettings(), VideoPlayerPreference.Auto, DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM);
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
    // Without the server's defaults the form starts with no row set and saves nothing, and the page keeps the defaults it follows
    const defaultsRead = defaultsResult.status === 'fulfilled';
    const initialState: EditorState = defaultsRead ?
        await readEditorState(defaultsResult.value, sources) :
        { presetFiles: [], refusedLabels: [], setValues: {} };

    // A fresh root each render, since the page renders the editor into the same element on each visit
    const root = document.createElement('div');
    root.innerHTML = createEditorHTML();
    element.textContent = '';
    element.appendChild(root);
    // The host may not have registered emby-select on its dashboard, as in the playback settings panel
    scheduleSelectLabelFallback(root);
    const statusElement = requireElement<HTMLElement>(root, '[data-client-defaults-status]');
    const saveButton = requireElement<HTMLButtonElement>(root, '[data-client-defaults-save]');
    const presetFilesElement = requireElement<HTMLElement>(root, '[data-client-defaults-preset-files]');
    const presetChoice = requireElement<HTMLSelectElement>(root, '[data-client-defaults-preset-choice]');
    const presetAddButton = requireElement<HTMLButtonElement>(root, '[data-client-defaults-preset-add]');
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

    /** Shows the server's defaults: each set row checked with its value, every other row disabled with its built-in value. */
    const showState = (state: EditorState): void => {
        for (const row of SETTING_ROWS) {
            const setValue = state.setValues[row.key];
            getSetCheckbox(root, row.key).checked = setValue !== undefined;
            getValueControl(root, row.key).disabled = setValue === undefined;
            showRowValue(root, row, setValue ?? builtInValues[row.key]);
        }
        presetFiles = [ ...state.presetFiles ];
        renderPreset();
    };

    /** Returns the defaults the form sets: each checked row's value, and the preset when it lists a file. */
    const readForm = (): Record<string, unknown> => {
        const settings: Record<string, unknown> = {};
        for (const row of SETTING_ROWS) {
            if (getSetCheckbox(root, row.key).checked) {
                settings[row.key] = readRowValue(root, row);
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

    const save = async (): Promise<void> => {
        saving = true;
        saveButton.disabled = true;
        try {
            const stored = await saveServerClientDefaults(readForm());
            const state = await readEditorState(stored, sources);
            showState(state);
            setStatus(statusElement, joinSentences(globalize.translate('SettingsSaved'), describeRefusedValues(state)) ?? '');
        } catch (error) {
            setStatus(statusElement, globalize.translate('WebGPUClientDefaultsSaveFailed', getErrorMessage(error)));
        } finally {
            saving = false;
            saveButton.disabled = false;
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

    root.addEventListener('change', (event: Event): void => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) {
            return;
        }
        const setKey = target.dataset.clientDefaultSet;
        const row = SETTING_ROWS.find((settingRow: SettingRow): boolean => settingRow.key === (setKey ?? target.dataset.clientDefaultValue));
        if (row !== undefined && setKey !== undefined) {
            // A row the server does not set shows the built-in value clients then use
            const control = getValueControl(root, row.key);
            control.disabled = !(target as HTMLInputElement).checked;
            if (control.disabled) {
                showRowValue(root, row, builtInValues[row.key]);
            }
            return;
        }
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
        if (removeButton) {
            const removedIndex = Number(removeButton.dataset.clientDefaultsPresetRemove);
            presetFiles = presetFiles.filter((_file: PresetFileView, index: number): boolean => index !== removedIndex);
            renderPreset();
        } else if (target?.closest('[data-client-defaults-preset-add]') && !adding) {
            void addPresetFile();
        } else if (target?.closest('[data-client-defaults-save]') && !saving && defaultsRead) {
            void save();
        }
    });

    showState(initialState);
    saveButton.disabled = !defaultsRead;
    setStatus(statusElement, joinSentences(joinSentences(readFailure, catalogFailure), describeRefusedValues(initialState)) ?? '');
}

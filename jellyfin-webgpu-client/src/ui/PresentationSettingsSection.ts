import escapeHtml from 'escape-html';

import globalize from 'lib/globalize';

import type { DeinterlaceMode } from 'webgpu-player/presentation/DeinterlaceTimeline';
import { getPresetPassPosition, PASS_FILE_EXTENSION } from 'webgpu-player/presentation/passes/PassLanguage';
import { parsePassFile, type PassFileEntry } from 'webgpu-player/presentation/passes/PassManifest';
import type { PassManifest, PassParameter, PassRejection, PlanReport } from 'webgpu-player/presentation/passes/PassTypes';

import { ensureDefaultPresentationFiles, getDefaultPresentationFiles } from '../DefaultPresentationFiles';
import {
    addPassSource,
    createStoredPresentationPreset,
    deletePassSources,
    getStoredFileSource,
    getStoredFileSourceKeys,
    readPassSources
} from '../PresentationPassStore';
import type { ServerModuleCatalog, ServerPassFile } from '../ServerModules';
import {
    addServerPassFile,
    getAddableServerPassFiles,
    isServerPassFileOffered,
    updateServerPassFiles
} from '../ServerPresentationPasses';
import type WebGPUPlayer from '../WebGPUPlayer';
import {
    createDefaultWebGPUUserSettings,
    isPresentationPassSource,
    loadWebGPUUserSettings,
    MAXIMUM_PRESENTATION_FILE_COUNT,
    MAXIMUM_PRESENTATION_PASS_SOURCE_LENGTH,
    normalizeWebGPUUserSettings,
    type StoredPresentationFile,
    type WebGPUUserSettings
} from '../WebGPUUserSettings';
import { createSettingOptionsHTML, DEINTERLACE_MODE_OPTIONS } from './SettingDefinitions';
import { createDefaultButtonHTML, HIDDEN_CLASS, setStatus, translateToHTML } from './SettingsPanelHTML';

// The presentation and shader pass sections of the playback settings panel: HDR output, deinterlacing, and the user's WGSL shader files in this browser.
// A file comes from this device or from the passes the server offers, which download when the user adds one.
// Until the user edits the list, it shows the server's default preset, and any edit makes the list the user's own; restoring the default follows the server's preset again.
// The files' sources live in the pass source store in IndexedDB, and the settings hold each file's key

const HDR_OUTPUT_SETTING_KEY = 'hdrOutput';
const DEINTERLACE_MODE_SETTING_KEY = 'deinterlaceMode';
// The pass files the picker offers: WGSL sources, which are plain text
const PASS_FILE_TYPES = `${PASS_FILE_EXTENSION},text/plain`;
// A float parameter steps freely; integer parameters step by whole numbers
const FLOAT_PARAMETER_STEP = 'any';
const INTEGER_PARAMETER_STEP = '1';
const DUPLICATE_NAME_REASON = 'duplicate-name';
const LIST_SEPARATOR = ', ';

export type PresentationSectionContext = Readonly<{
    cleanupCallbacks: Array<() => void>
    getSettings: () => WebGPUUserSettings
    isActive: () => boolean
    panel: HTMLElement
    player: WebGPUPlayer
    /** Persists settings and synchronizes every control of the panel; returns what failed when the browser refused the write, else null */
    saveSettings: (settings: WebGPUUserSettings) => string | null
    /** What the server offers, read once as the panel opens; it rejects when the server cannot be reached */
    serverCatalog: Promise<ServerModuleCatalog>
}>;

export type PresentationSectionController = Readonly<{
    /** Hands the settings' HDR output, deinterlacing, and shader files to the player */
    apply: () => void
    /** Shows the settings' HDR output, deinterlacing, and shader files, and deletes the sources of files the settings no longer hold */
    synchronize: () => void
}>;

/** One pass of a stored file as the panel shows it: its manifest when its header parses, else what failed. */
type PassView = Readonly<{
    headerFailure: string | null
    manifest: PassManifest | null
    name: string
}>;

/** One pass's line in its file's entry: what the report says about it, naming it when the file holds several passes. */
type PassStateLine = Readonly<{
    name: string
    state: string
}>;

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Joins two status sentences, either of which may be absent. */
function joinSentences(first: string | null, second: string | null): string | null {
    if (first === null || second === null) {
        return first ?? second;
    }
    return globalize.translate('WebGPUJoinedSentences', first, second);
}

function describeSaveFailure(failure: string | null): string | null {
    return failure === null ? null : globalize.translate('WebGPUSettingsSaveFailed', failure);
}

function describeStorageFailure(error: unknown): string {
    return globalize.translate('WebGPUShaderPassesStorageFailed', getErrorMessage(error));
}

function requireSectionElement<ElementType extends Element>(panel: ParentNode, selector: string): ElementType {
    const element = panel.querySelector<ElementType>(selector);
    if (!element) {
        throw new Error(`WebGPU settings panel is missing ${selector}`);
    }
    return element;
}

/**
 * Describes each pass of a stored file's source in file order.
 * An unnamed pass takes its preset position, as the player's report names it, which counts only the files the player receives.
 */
function describePassFile(source: string, presetIndex: number): PassView[] {
    const entries = parsePassFile(source);
    return entries.map((entry: PassFileEntry, passIndex: number): PassView => {
        if (entry.manifest !== null) {
            return { headerFailure: null, manifest: entry.manifest, name: entry.manifest.name };
        }
        return {
            headerFailure: `header-invalid: line ${entry.error.line}: ${entry.error.message}`,
            manifest: null,
            name: entry.error.passName
                ?? globalize.translate('WebGPUShaderPassUnnamed', getPresetPassPosition(presetIndex, passIndex, entries.length))
        };
    });
}

/** Returns a pass's parameters and constants, which the engine takes values for alike; a constant's change plans again. */
function getTunableParameters(view: PassView): readonly PassParameter[] {
    return view.manifest === null ? [] : [ ...view.manifest.parameters, ...view.manifest.constants ];
}

/** Returns a file's title: its only pass's name, or its first pass's name with its pass count. */
function getPassFileTitle(views: readonly PassView[]): string {
    return views.length === 1 ? views[0].name : globalize.translate('WebGPUShaderPassFile', views[0].name, views.length);
}

/** Returns each parameter or constant the file's passes declare, once, since the passes share its value; a constant tunes as a parameter does. */
function getPassFileParameters(views: readonly PassView[]): PassParameter[] {
    const parameters: PassParameter[] = [];
    for (const view of views) {
        for (const parameter of getTunableParameters(view)) {
            if (!parameters.some((declared: PassParameter): boolean => declared.name === parameter.name)) {
                parameters.push(parameter);
            }
        }
    }
    return parameters;
}

/** Returns what the report says about a pass; a later pass with an earlier pass's name is its duplicate. */
function getPassState(view: PassView, report: PlanReport, duplicate: boolean): string {
    if (view.headerFailure !== null) {
        return view.headerFailure;
    }
    const rejection = report.inactivePasses.find((candidate: PassRejection): boolean => (
        candidate.name === view.name && (candidate.reason === DUPLICATE_NAME_REASON) === duplicate
    ));
    if (rejection) {
        return rejection.detail ? `${rejection.reason}: ${rejection.detail}` : rejection.reason;
    }
    if (!duplicate && report.activePasses.includes(view.name)) {
        return globalize.translate('WebGPUShaderPassActive');
    }
    return globalize.translate('WebGPUShaderPassWaiting');
}

function createParameterHTML(file: StoredPresentationFile, fileTitle: string, parameter: PassParameter, fileIndex: number): string {
    const value = file.parameters[parameter.name] ?? parameter.defaultValue;
    const step = parameter.type === 'f32' ? FLOAT_PARAMETER_STEP : INTEGER_PARAMETER_STEP;
    return `
        <label class="webgpuSettingsPassParameter">
            <span>${escapeHtml(parameter.name)}</span>
            <input
                aria-label="${translateToHTML('WebGPUShaderPassParameter', fileTitle, parameter.name)}"
                class="webgpuSettingsNumber"
                data-parameter-name="${escapeHtml(parameter.name)}"
                data-file-index="${fileIndex}"
                is="emby-input"
                max="${parameter.maximum}"
                min="${parameter.minimum}"
                step="${step}"
                type="number"
                value="${value}"
            />
        </label>`;
}

function createPassStateHTML(text: string): string {
    return `<div class="fieldDescription webgpuSettingsPassState">${escapeHtml(text)}</div>`;
}

/** Returns a file's entry: its title with its remove button, then its state lines and its parameters. */
function createFileEntryHTML(title: string, index: number, contentHTML: string): string {
    return `
        <div class="webgpuSettingsPass">
            <div class="webgpuSettingsPassHeader">
                <span class="webgpuSettingsPassName">${escapeHtml(title)}</span>
                <button
                    aria-label="${translateToHTML('WebGPURemoveShaderPass', title)}"
                    class="webgpuSettingsRemovePass"
                    data-remove-file="${index}"
                    is="paper-icon-button-light"
                    title="${translateToHTML('WebGPURemoveShaderPass', title)}"
                    type="button"
                ><span class="material-icons delete" aria-hidden="true"></span></button>
            </div>
            ${contentHTML}
        </div>`;
}

/** Returns a file's entry: its passes' states, where it came from when that was the server, and its parameters. */
function createFileHTML(
    file: StoredPresentationFile,
    views: readonly PassView[],
    stateLines: readonly PassStateLine[],
    index: number,
    originLine: string | null
): string {
    const title = getPassFileTitle(views);
    const parametersHTML = getPassFileParameters(views)
        .map((parameter: PassParameter): string => createParameterHTML(file, title, parameter, index))
        .join('');
    const statesHTML = stateLines
        .map((line: PassStateLine): string => createPassStateHTML(views.length === 1 ? line.state : `${line.name}: ${line.state}`))
        .join('');
    const originHTML = originLine === null ? '' : createPassStateHTML(originLine);
    return createFileEntryHTML(title, index, `${statesHTML}${originHTML}${parametersHTML}`);
}

/** Returns the option of a pass file the server offers: its name, and its passes'. */
function createServerPassOptionHTML(entry: ServerPassFile): string {
    return `<option value="${escapeHtml(entry.fileName)}">${translateToHTML('WebGPUServerPassOption', entry.fileName, entry.passNames.join(LIST_SEPARATOR))}</option>`;
}

/** Returns the entry of a file whose source the pass source store does not hold, which the player leaves out, so it can be removed. */
function createMissingSourceFileHTML(file: StoredPresentationFile, index: number): string {
    return createFileEntryHTML(
        globalize.translate('WebGPUShaderPassSourceMissing'),
        index,
        createPassStateHTML(`source-missing: key ${file.sourceKey}`)
    );
}

/** Returns the presentation section's HTML, the HDR output switch and the deinterlacing choice, then the shader pass section's: the file list, the server's passes, and the file buttons. */
export function createPresentationSectionHTML(): string {
    return `
        <section class="webgpuSettingsSection" aria-labelledby="webgpu-presentation-title">
            <h3 class="webgpuSettingsSectionTitle" id="webgpu-presentation-title">
                ${translateToHTML('WebGPUPresentation')}
            </h3>
            <div class="webgpuSettingsCheckboxRow">
                <label class="checkboxContainer">
                    <input
                        data-setting-checkbox="${HDR_OUTPUT_SETTING_KEY}"
                        is="emby-checkbox"
                        type="checkbox"
                    />
                    <span>${translateToHTML('WebGPUHDROutput')}</span>
                </label>
                ${createDefaultButtonHTML(HDR_OUTPUT_SETTING_KEY, globalize.translate('WebGPUSettingNameHDROutput'))}
            </div>
            <div class="fieldDescription webgpuSettingsCheckboxDescription">
                ${translateToHTML('WebGPUHDROutputHelp')}
            </div>
            <div aria-live="polite" class="webgpuSettingsStatus" data-hdr-output-status role="status"></div>
            <div class="webgpuSettingsSelectRow">
                <div class="selectContainer webgpuSettingsSelectContainer">
                    <select
                        aria-describedby="webgpu-deinterlace-mode-description"
                        data-setting-select="${DEINTERLACE_MODE_SETTING_KEY}"
                        id="webgpu-deinterlace-mode"
                        is="emby-select"
                        label="${translateToHTML('WebGPUDeinterlace')}"
                    >
                        ${createSettingOptionsHTML(DEINTERLACE_MODE_OPTIONS)}
                    </select>
                </div>
                ${createDefaultButtonHTML(DEINTERLACE_MODE_SETTING_KEY, globalize.translate('WebGPUSettingNameDeinterlace'))}
            </div>
            <div
                class="fieldDescription"
                id="webgpu-deinterlace-mode-description"
            >${translateToHTML('WebGPUDeinterlaceHelp')}</div>
            <div aria-live="polite" class="webgpuSettingsStatus" data-deinterlace-mode-status role="status"></div>
        </section>

        <section class="webgpuSettingsSection" aria-labelledby="webgpu-shader-passes-title">
            <h3 class="webgpuSettingsSectionTitle" id="webgpu-shader-passes-title">
                ${translateToHTML('WebGPUShaderPasses')}
            </h3>
            <div class="fieldDescription">${translateToHTML('WebGPUShaderPassesHelp')}</div>
            <div class="webgpuSettingsPasses" data-presentation-passes></div>
            <div class="webgpuSettingsSelectRow">
                <div class="selectContainer webgpuSettingsSelectContainer">
                    <select
                        data-server-passes
                        id="webgpu-server-passes"
                        is="emby-select"
                        label="${translateToHTML('WebGPUServerPasses')}"
                    ></select>
                </div>
                <button
                    class="raised webgpuSettingsAddServerPass"
                    is="emby-button"
                    type="button"
                >${translateToHTML('WebGPUAddServerPass')}</button>
            </div>
            <input
                accept="${PASS_FILE_TYPES}"
                class="${HIDDEN_CLASS}"
                data-presentation-pass-files
                multiple
                type="file"
            />
            <div aria-live="polite" class="webgpuSettingsStatus" data-presentation-status role="status"></div>
            <div class="webgpuSettingsButtonRow">
                <button
                    class="raised webgpuSettingsAddPasses"
                    is="emby-button"
                    type="button"
                >${translateToHTML('WebGPUAddShaderPasses')}</button>
                <button
                    class="raised webgpuSettingsRemovePasses"
                    is="emby-button"
                    type="button"
                >${translateToHTML('WebGPURemoveShaderPasses')}</button>
                <button
                    class="raised webgpuSettingsRestoreDefaultPasses"
                    is="emby-button"
                    type="button"
                >${translateToHTML('WebGPURestoreDefaultShaderPasses')}</button>
            </div>
        </section>`;
}

/** Binds the presentation section's controls; every change persists, then applies to the player live. */
export function bindPresentationSection(context: PresentationSectionContext): PresentationSectionController {
    const { panel, player } = context;
    const HDROutputCheckbox = requireSectionElement<HTMLInputElement>(panel, `[data-setting-checkbox="${HDR_OUTPUT_SETTING_KEY}"]`);
    const HDROutputStatusElement = requireSectionElement<HTMLElement>(panel, '[data-hdr-output-status]');
    const fileList = requireSectionElement<HTMLElement>(panel, '[data-presentation-passes]');
    const passFileInput = requireSectionElement<HTMLInputElement>(panel, '[data-presentation-pass-files]');
    const statusElement = requireSectionElement<HTMLElement>(panel, '[data-presentation-status]');
    const addFilesButton = requireSectionElement<HTMLButtonElement>(panel, '.webgpuSettingsAddPasses');
    const removeFilesButton = requireSectionElement<HTMLButtonElement>(panel, '.webgpuSettingsRemovePasses');
    const restoreDefaultFilesButton = requireSectionElement<HTMLButtonElement>(panel, '.webgpuSettingsRestoreDefaultPasses');
    const serverPassSelect = requireSectionElement<HTMLSelectElement>(panel, '[data-server-passes]');
    const addServerPassButton = requireSectionElement<HTMLButtonElement>(panel, '.webgpuSettingsAddServerPass');
    const HDROutputDefaultButton = requireSectionElement<HTMLButtonElement>(panel, `[data-default-setting="${HDR_OUTPUT_SETTING_KEY}"]`);
    const deinterlaceModeSelect = requireSectionElement<HTMLSelectElement>(panel, `[data-setting-select="${DEINTERLACE_MODE_SETTING_KEY}"]`);
    const deinterlaceModeStatusElement = requireSectionElement<HTMLElement>(panel, '[data-deinterlace-mode-status]');
    const deinterlaceModeDefaultButton = requireSectionElement<HTMLButtonElement>(panel, `[data-default-setting="${DEINTERLACE_MODE_SETTING_KEY}"]`);
    let report = player.getPresentationPlanReport();
    // A preset result arriving after a newer change must not overwrite it
    let presetRevision = 0;
    // What the file list shows; a save that changes neither keeps the list's inputs, and the focused one
    let renderedReport: PlanReport | null = null;
    let renderedSources: readonly (string | null)[] = [];
    let renderedCatalog: ServerModuleCatalog | null = null;
    // The stored files' sources from the pass source store; null until they are read
    let sources: Map<number, string> | null = null;
    // What the server offers, read when the panel opens; null until it is read, or when it cannot be
    let serverCatalog: ServerModuleCatalog | null = null;
    let serverCatalogFailure: string | null = null;
    // A server pass downloads one at a time
    let serverPassPending = false;
    /** Returns the files the panel's settings resolve to: the user's own preset, else the server's default files. */
    const getEffectiveFiles = (): readonly StoredPresentationFile[] => context.getSettings().presentation.files ?? getDefaultPresentationFiles();
    // The store keys the settings held while the panel was open, whose sources go once neither these, the stored settings, nor the default files hold them
    const knownSourceKeys = new Set<number>(getStoredFileSourceKeys(getEffectiveFiles()));

    /** Returns where a file came from when that was the server, and whether the server still offers it once its catalog is read. */
    const describeOrigin = (file: StoredPresentationFile): string | null => {
        if (!file.server) {
            return null;
        }
        return serverCatalog !== null && !isServerPassFileOffered(serverCatalog, file) ?
            globalize.translate('WebGPUShaderPassWithdrawn', file.server.fileName) :
            globalize.translate('WebGPUShaderPassFromServer', file.server.fileName);
    };

    /** Lists the server's passes the preset does not hold; the picker waits for the sources and the catalog, and one download at a time. */
    const renderServerPasses = (): void => {
        const addable = serverCatalog === null || sources === null ?
            [] :
            getAddableServerPassFiles(serverCatalog, getEffectiveFiles());
        const selectedFileName = serverPassSelect.value;
        serverPassSelect.innerHTML = addable.length === 0 ?
            `<option value="">${escapeHtml(serverCatalogFailure ?? globalize.translate('WebGPUServerPassesNone'))}</option>` :
            addable.map(createServerPassOptionHTML).join('');
        if (addable.some((entry: ServerPassFile): boolean => entry.fileName === selectedFileName)) {
            serverPassSelect.value = selectedFileName;
        }
        serverPassSelect.disabled = addable.length === 0 || serverPassPending;
        addServerPassButton.disabled = addable.length === 0 || serverPassPending;
    };

    const renderFiles = (): void => {
        const files = getEffectiveFiles();
        // The buttons and the list wait for the sources
        addFilesButton.disabled = sources === null;
        removeFilesButton.disabled = sources === null || files.length === 0;
        restoreDefaultFilesButton.disabled = sources === null || context.getSettings().presentation.files === null;
        renderServerPasses();
        if (sources === null) {
            return;
        }
        const loadedSources = sources;
        const fileSources = files.map((file: StoredPresentationFile): string | null => getStoredFileSource(file, loadedSources));
        if (report === renderedReport
            && serverCatalog === renderedCatalog
            && fileSources.length === renderedSources.length
            && fileSources.every((source: string | null, index: number): boolean => source === renderedSources[index])) {
            return;
        }
        renderedReport = report;
        renderedSources = fileSources;
        renderedCatalog = serverCatalog;
        const seenNames = new Set<string>();
        const filesHTML: string[] = [];
        // The player receives only the files with sources, so an unnamed pass's preset position counts only those
        let presetIndex = 0;
        for (const [ index, file ] of files.entries()) {
            const source = fileSources[index];
            if (source === null) {
                filesHTML.push(createMissingSourceFileHTML(file, index));
                continue;
            }
            const views = describePassFile(source, presetIndex);
            presetIndex += 1;
            const stateLines: PassStateLine[] = [];
            for (const view of views) {
                stateLines.push({ name: view.name, state: getPassState(view, report, seenNames.has(view.name)) });
                seenNames.add(view.name);
            }
            filesHTML.push(createFileHTML(file, views, stateLines, index, describeOrigin(file)));
        }
        fileList.innerHTML = filesHTML.join('');
    };

    const deleteSources = (keys: readonly number[]): void => {
        for (const key of keys) {
            knownSourceKeys.delete(key);
            sources?.delete(key);
        }
        void deletePassSources(keys).catch((error: unknown): void => {
            console.warn(`WebGPU shader files: ${getErrorMessage(error)}`);
            if (context.isActive()) {
                setStatus(statusElement, describeStorageFailure(error));
            }
        });
    };

    /**
     * Deletes the sources of files that neither these settings, the stored ones, nor the default files hold, so a refused save never loses a source the stored settings need.
     */
    const releaseDroppedSources = (): void => {
        const heldKeys = new Set<number>([
            ...getStoredFileSourceKeys(getEffectiveFiles()),
            ...getStoredFileSourceKeys(loadWebGPUUserSettings().presentation.files ?? []),
            ...getStoredFileSourceKeys(getDefaultPresentationFiles())
        ]);
        const droppedKeys = [ ...knownSourceKeys ].filter((key: number): boolean => !heldKeys.has(key));
        if (droppedKeys.length > 0) {
            deleteSources(droppedKeys);
        }
    };

    const describeReport = (planReport: PlanReport): string => {
        if (getEffectiveFiles().length === 0) {
            return globalize.translate('WebGPUShaderPassesNone');
        }
        return globalize.translate('WebGPUShaderPassesSummary', planReport.activePasses.length, planReport.inactivePasses.length);
    };

    const savePresentation = (presentation: WebGPUUserSettings['presentation']): string | null => (
        context.saveSettings(normalizeWebGPUUserSettings({ ...context.getSettings(), presentation }))
    );

    /** Reads the sources of the stored files and of the default files, which restoring the default shows; the list shows once they are read. */
    const loadSources = async (): Promise<void> => {
        let loadedSources = new Map<number, string>();
        let failure: string | null = null;
        try {
            loadedSources = await readPassSources([
                ...getStoredFileSourceKeys(context.getSettings().presentation.files ?? []),
                ...getStoredFileSourceKeys(getDefaultPresentationFiles())
            ]);
        } catch (error) {
            failure = describeStorageFailure(error);
        }
        sources = loadedSources;
        if (!context.isActive()) {
            return;
        }
        renderFiles();
        if (failure !== null) {
            console.warn(`WebGPU shader files: ${failure}`);
            setStatus(statusElement, failure);
        }
    };
    const sourcesLoaded = loadSources();

    /**
     * Returns the files the settings resolve to once the sources are read.
     * Following the default makes sure the default files match the server's default preset first, and reads the sources of new default files.
     */
    const loadEffectiveFiles = async (): Promise<readonly StoredPresentationFile[]> => {
        await sourcesLoaded;
        const ownFiles = context.getSettings().presentation.files;
        if (ownFiles !== null) {
            return ownFiles;
        }
        const files = await ensureDefaultPresentationFiles();
        const unreadKeys = getStoredFileSourceKeys(files).filter((key: number): boolean => !sources?.has(key));
        for (const [ key, source ] of await readPassSources(unreadKeys)) {
            sources?.set(key, source);
        }
        return files;
    };

    /** Hands the files with sources to the player once the sources are read; a file without one stays out, and its entry says so. */
    const applyPreset = (notice: string | null): void => {
        presetRevision += 1;
        const revision = presetRevision;
        setStatus(statusElement, globalize.translate('WebGPUShaderPassesApplying'));
        void loadEffectiveFiles().then((files: readonly StoredPresentationFile[]): Promise<PlanReport> => {
            const preset = createStoredPresentationPreset(files, sources ?? new Map<number, string>());
            return player.setPresentationPreset(preset.files);
        }).then((planReport: PlanReport): void => {
            if (!context.isActive() || revision !== presetRevision) {
                return;
            }
            report = planReport;
            renderFiles();
            const summary = describeReport(planReport);
            setStatus(statusElement, joinSentences(notice, summary) ?? summary);
        }, (error: unknown): void => {
            if (!context.isActive() || revision !== presetRevision) {
                return;
            }
            setStatus(statusElement, globalize.translate('WebGPUShaderPassesFailed', getErrorMessage(error)));
        });
    };

    const applyHDROutput = (notice: string | null): void => {
        void player.setHDROutputEnabled(context.getSettings().presentation.hdrOutput).then((): void => {
            if (context.isActive()) {
                const applied = globalize.translate('WebGPUHDROutputApplied');
                setStatus(HDROutputStatusElement, joinSentences(applied, notice) ?? applied);
            }
        }, (error: unknown): void => {
            if (context.isActive()) {
                setStatus(HDROutputStatusElement, globalize.translate('WebGPUHDROutputFailed', getErrorMessage(error)));
            }
        });
    };

    const applyDeinterlaceMode = (notice: string | null): void => {
        void player.setDeinterlaceMode(context.getSettings().presentation.deinterlaceMode).then((): void => {
            if (context.isActive()) {
                const applied = globalize.translate('WebGPUDeinterlaceApplied');
                setStatus(deinterlaceModeStatusElement, joinSentences(applied, notice) ?? applied);
            }
        }, (error: unknown): void => {
            if (context.isActive()) {
                setStatus(deinterlaceModeStatusElement, globalize.translate('WebGPUDeinterlaceFailed', getErrorMessage(error)));
            }
        });
    };

    /** Saves the files as the user's own preset, or null to follow the server's default preset, then applies them. */
    const updateFiles = (files: readonly StoredPresentationFile[] | null, notice: string | null): void => {
        const saveFailure = savePresentation({ ...context.getSettings().presentation, files });
        applyPreset(joinSentences(notice, describeSaveFailure(saveFailure)));
    };

    /**
     * Reads what the server offers once the sources are read, then replaces the sources of the user's own preset's server files the server now has newer versions of.
     * The default files follow the server's versions themselves; a server that cannot be reached leaves every file as stored, and the picker says why it offers nothing.
     */
    const loadServerPasses = async (): Promise<void> => {
        await sourcesLoaded;
        let catalog: ServerModuleCatalog;
        try {
            catalog = await context.serverCatalog;
        } catch (error) {
            serverCatalogFailure = globalize.translate('WebGPUServerPassesUnavailable', getErrorMessage(error));
            if (context.isActive()) {
                renderServerPasses();
            }
            return;
        }
        if (!context.isActive()) {
            return;
        }
        serverCatalog = catalog;
        renderFiles();
        const ownFiles = context.getSettings().presentation.files;
        if (ownFiles === null) {
            return;
        }
        const update = await updateServerPassFiles(ownFiles, catalog);
        if (!context.isActive() || (update.updatedFileNames.length === 0 && update.failures.length === 0)) {
            return;
        }
        for (const [ sourceKey, source ] of update.sources) {
            sources?.set(sourceKey, source);
        }
        const failureNotice = update.failures.length === 0 ?
            null :
            globalize.translate('WebGPUServerPassesNotUpdated', update.failures.join(LIST_SEPARATOR));
        if (update.updatedFileNames.length === 0) {
            setStatus(statusElement, failureNotice ?? '');
            return;
        }
        // The default restored meanwhile no longer holds the user's preset, whose versions then matter no more
        const currentFiles = context.getSettings().presentation.files;
        if (currentFiles === null) {
            return;
        }
        // Each updated file keeps its key, place, and parameters; only its version changes
        const updatedOrigins = new Map<number, StoredPresentationFile>(update.files.map((file: StoredPresentationFile): [ number, StoredPresentationFile ] => [ file.sourceKey, file ]));
        const files = currentFiles.map((file: StoredPresentationFile): StoredPresentationFile => {
            const updatedFile = updatedOrigins.get(file.sourceKey);
            return updatedFile?.server ? { ...file, server: updatedFile.server } : file;
        });
        updateFiles(files, joinSentences(globalize.translate('WebGPUServerPassesUpdated', update.updatedFileNames.join(LIST_SEPARATOR)), failureNotice));
    };

    /** Downloads the chosen server pass and adds it after the preset's files; a failure, or a full preset, is named in the status. */
    const addServerPass = async (entry: ServerPassFile): Promise<void> => {
        if (getEffectiveFiles().length >= MAXIMUM_PRESENTATION_FILE_COUNT) {
            setStatus(statusElement, globalize.translate(
                'WebGPUShaderPassFilesSkipped',
                entry.fileName,
                MAXIMUM_PRESENTATION_FILE_COUNT,
                MAXIMUM_PRESENTATION_PASS_SOURCE_LENGTH
            ));
            return;
        }
        serverPassPending = true;
        renderServerPasses();
        try {
            const added = await addServerPassFile(entry);
            if (!context.isActive()) {
                // The panel closed meanwhile, so the file is not added, and its stored source goes
                void deletePassSources([ added.file.sourceKey ]);
                return;
            }
            sources?.set(added.file.sourceKey, added.source);
            knownSourceKeys.add(added.file.sourceKey);
            updateFiles([ ...getEffectiveFiles(), added.file ], globalize.translate('WebGPUServerPassAdded', entry.fileName));
        } catch (error) {
            console.warn(`WebGPU shader files: server-pass-unavailable: ${entry.fileName} ${getErrorMessage(error)}`);
            if (context.isActive()) {
                setStatus(statusElement, globalize.translate('WebGPUServerPassNotAdded', entry.fileName, getErrorMessage(error)));
            }
        } finally {
            serverPassPending = false;
            if (context.isActive()) {
                renderServerPasses();
            }
        }
    };

    /** Stores each chosen file's source and adds the files in order; a file past the limits, or one the store refused, is named in the notice. */
    const addPassFiles = async (chosenFiles: readonly File[]): Promise<void> => {
        const addedFiles: StoredPresentationFile[] = [];
        const skippedNames: string[] = [];
        let failureNotice: string | null = null;
        for (const chosenFile of chosenFiles) {
            const fileCount = getEffectiveFiles().length + addedFiles.length;
            // The size check comes before the read, so a mistaken pick, such as a media file, is never read
            if (fileCount >= MAXIMUM_PRESENTATION_FILE_COUNT || chosenFile.size > MAXIMUM_PRESENTATION_PASS_SOURCE_LENGTH) {
                skippedNames.push(chosenFile.name);
                continue;
            }
            try {
                const source = await chosenFile.text();
                if (!isPresentationPassSource(source)) {
                    skippedNames.push(chosenFile.name);
                    continue;
                }
                const sourceKey = await addPassSource(source);
                sources?.set(sourceKey, source);
                knownSourceKeys.add(sourceKey);
                addedFiles.push({ parameters: {}, sourceKey });
            } catch (error) {
                skippedNames.push(chosenFile.name);
                failureNotice ??= describeStorageFailure(error);
            }
        }
        if (!context.isActive()) {
            // The panel closed meanwhile, so the files are not added, and their stored sources go
            deleteSources(getStoredFileSourceKeys(addedFiles));
            return;
        }
        const skippedNotice = skippedNames.length === 0 ?
            null :
            globalize.translate(
                'WebGPUShaderPassFilesSkipped',
                skippedNames.join(', '),
                MAXIMUM_PRESENTATION_FILE_COUNT,
                MAXIMUM_PRESENTATION_PASS_SOURCE_LENGTH
            );
        updateFiles([ ...getEffectiveFiles(), ...addedFiles ], joinSentences(skippedNotice, failureNotice));
    };

    const onHDROutputChange = (): void => {
        const saveFailure = savePresentation({ ...context.getSettings().presentation, hdrOutput: HDROutputCheckbox.checked });
        applyHDROutput(describeSaveFailure(saveFailure));
    };

    const onHDROutputDefault = (): void => {
        HDROutputCheckbox.checked = createDefaultWebGPUUserSettings().presentation.hdrOutput;
        onHDROutputChange();
    };

    const onDeinterlaceModeChange = (): void => {
        // The select offers only the modes; the settings' normalization keeps any other value out of storage
        const saveFailure = savePresentation({ ...context.getSettings().presentation, deinterlaceMode: deinterlaceModeSelect.value as DeinterlaceMode });
        applyDeinterlaceMode(describeSaveFailure(saveFailure));
    };

    const onDeinterlaceModeDefault = (): void => {
        deinterlaceModeSelect.value = createDefaultWebGPUUserSettings().presentation.deinterlaceMode;
        onDeinterlaceModeChange();
    };

    const onAddFiles = (): void => {
        passFileInput.value = '';
        passFileInput.click();
    };

    const onPassFilesChosen = (): void => {
        const chosenFiles = Array.from(passFileInput.files ?? []);
        if (chosenFiles.length > 0) {
            void addPassFiles(chosenFiles);
        }
    };

    const onRemoveFiles = (): void => {
        updateFiles([], null);
    };

    const onRestoreDefaultFiles = (): void => {
        // The default files may hold the user's sources under other parameter values, so the list renders anew
        renderedReport = null;
        updateFiles(null, null);
    };

    const onAddServerPass = (): void => {
        const entry = serverCatalog?.passes.find((candidate: ServerPassFile): boolean => candidate.fileName === serverPassSelect.value);
        if (entry && !serverPassPending) {
            void addServerPass(entry);
        }
    };

    const onFileListClick = (event: Event): void => {
        const target = event.target;
        const removeButton = target instanceof Element ? target.closest<HTMLElement>('[data-remove-file]') : null;
        if (!removeButton) {
            return;
        }
        const removedIndex = Number(removeButton.dataset.removeFile);
        updateFiles(getEffectiveFiles().filter(
            (_file: StoredPresentationFile, index: number): boolean => index !== removedIndex
        ), null);
    };

    const onFileListChange = (event: Event): void => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || input.dataset.parameterName === undefined) {
            return;
        }
        const fileIndex = Number(input.dataset.fileIndex);
        const parameterName = input.dataset.parameterName;
        const value = Number(input.value);
        const files = getEffectiveFiles();
        const changedFile = files.at(fileIndex);
        if (!changedFile || !Number.isFinite(value)) {
            return;
        }
        const saveFailure = savePresentation({
            ...context.getSettings().presentation,
            files: files.map((file: StoredPresentationFile, index: number): StoredPresentationFile => (
                index === fileIndex ? { ...file, parameters: { ...file.parameters, [parameterName]: value } } : file
            ))
        });
        // The file's passes share the value, so each pass that declares the parameter or constant takes it; only names matter here, so any preset position does
        const source = sources === null ? null : getStoredFileSource(changedFile, sources);
        const declaringViews = (source === null ? [] : describePassFile(source, fileIndex)).filter((view: PassView): boolean => (
            getTunableParameters(view).some((parameter: PassParameter): boolean => parameter.name === parameterName)
        ));
        let failure: string | null = declaringViews.length === 0 ? `parameter-unknown: '${parameterName}'` : null;
        for (const view of declaringViews) {
            // A pass that is not running yet takes the stored value when its preset next applies
            try {
                player.setPresentationParameter(view.name, parameterName, value);
            } catch (error) {
                failure ??= getErrorMessage(error);
            }
        }
        const message = failure === null ?
            globalize.translate('WebGPUShaderPassParameterApplied') :
            globalize.translate('WebGPUShaderPassParameterPending', failure);
        setStatus(statusElement, joinSentences(message, describeSaveFailure(saveFailure)) ?? message);
    };

    const listeners: Array<[EventTarget, string, (event: Event) => void]> = [
        [ HDROutputCheckbox, 'change', onHDROutputChange ],
        [ HDROutputDefaultButton, 'click', onHDROutputDefault ],
        [ deinterlaceModeSelect, 'change', onDeinterlaceModeChange ],
        [ deinterlaceModeDefaultButton, 'click', onDeinterlaceModeDefault ],
        [ addFilesButton, 'click', onAddFiles ],
        [ passFileInput, 'change', onPassFilesChosen ],
        [ removeFilesButton, 'click', onRemoveFiles ],
        [ restoreDefaultFilesButton, 'click', onRestoreDefaultFiles ],
        [ addServerPassButton, 'click', onAddServerPass ],
        [ fileList, 'click', onFileListClick ],
        [ fileList, 'change', onFileListChange ]
    ];
    for (const [ target, type, listener ] of listeners) {
        target.addEventListener(type, listener);
    }
    context.cleanupCallbacks.push((): void => {
        for (const [ target, type, listener ] of listeners) {
            target.removeEventListener(type, listener);
        }
    });

    void loadServerPasses();

    return {
        apply: (): void => {
            applyHDROutput(null);
            applyDeinterlaceMode(null);
            // A reset's default files may hold the user's sources under other parameter values, so the list renders anew
            renderedReport = null;
            applyPreset(null);
        },
        synchronize: (): void => {
            HDROutputCheckbox.checked = context.getSettings().presentation.hdrOutput;
            deinterlaceModeSelect.value = context.getSettings().presentation.deinterlaceMode;
            renderFiles();
            releaseDroppedSources();
        }
    };
}

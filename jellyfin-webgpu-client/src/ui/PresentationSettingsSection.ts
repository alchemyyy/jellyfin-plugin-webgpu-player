import escapeHtml from 'escape-html';

import globalize from 'lib/globalize';

import { getPresetPassPosition, PASS_FILE_EXTENSION } from 'webgpu-player/presentation/passes/PassLanguage';
import { parsePassFile, type PassFileEntry } from 'webgpu-player/presentation/passes/PassManifest';
import type { PassManifest, PassParameter, PassRejection, PlanReport } from 'webgpu-player/presentation/passes/PassTypes';

import {
    addPassSource,
    createStoredPresentationPreset,
    deletePassSources,
    getStoredFileSource,
    getStoredFileSourceKeys,
    readPassSources
} from '../PresentationPassStore';
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
import { createDefaultButtonHTML, HIDDEN_CLASS, setStatus, translateToHTML } from './SettingsPanelHTML';

// The presentation section of the playback settings panel: HDR output, and the user's WGSL shader files in this browser
// The files' sources live in the pass source store in IndexedDB, and the settings hold each file's key

const HDR_OUTPUT_SETTING_KEY = 'hdrOutput';
// The pass files the picker offers: WGSL sources, which are plain text
const PASS_FILE_TYPES = `${PASS_FILE_EXTENSION},text/plain`;
// A float parameter steps freely; integer parameters step by whole numbers
const FLOAT_PARAMETER_STEP = 'any';
const INTEGER_PARAMETER_STEP = '1';
const DUPLICATE_NAME_REASON = 'duplicate-name';

export type PresentationSectionContext = Readonly<{
    cleanupCallbacks: Array<() => void>
    getSettings: () => WebGPUUserSettings
    isActive: () => boolean
    panel: HTMLElement
    player: WebGPUPlayer
    /** Persists settings and synchronizes every control of the panel; returns what failed when the browser refused the write, else null */
    saveSettings: (settings: WebGPUUserSettings) => string | null
}>;

export type PresentationSectionController = Readonly<{
    /** Hands the settings' HDR output and shader files to the player */
    apply: () => void
    /** Shows the settings' HDR output and shader files, and deletes the sources of files the settings no longer hold */
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

/** Returns a file's title: its only pass's name, or its first pass's name with its pass count. */
function getPassFileTitle(views: readonly PassView[]): string {
    return views.length === 1 ? views[0].name : globalize.translate('WebGPUShaderPassFile', views[0].name, views.length);
}

/** Returns each parameter the file's passes declare, once, since the passes share its value. */
function getPassFileParameters(views: readonly PassView[]): PassParameter[] {
    const parameters: PassParameter[] = [];
    for (const view of views) {
        for (const parameter of view.manifest?.parameters ?? []) {
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

function createFileHTML(file: StoredPresentationFile, views: readonly PassView[], stateLines: readonly PassStateLine[], index: number): string {
    const title = getPassFileTitle(views);
    const parametersHTML = getPassFileParameters(views)
        .map((parameter: PassParameter): string => createParameterHTML(file, title, parameter, index))
        .join('');
    const statesHTML = stateLines
        .map((line: PassStateLine): string => createPassStateHTML(views.length === 1 ? line.state : `${line.name}: ${line.state}`))
        .join('');
    return createFileEntryHTML(title, index, `${statesHTML}${parametersHTML}`);
}

/** Returns the entry of a file whose source the pass source store does not hold, which the player leaves out, so it can be removed. */
function createMissingSourceFileHTML(file: StoredPresentationFile, index: number): string {
    return createFileEntryHTML(
        globalize.translate('WebGPUShaderPassSourceMissing'),
        index,
        createPassStateHTML(`source-missing: key ${file.sourceKey}`)
    );
}

/** Returns the presentation section's HTML: the HDR output switch, the file list, and the file buttons. */
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
            <div class="fieldDescription">${translateToHTML('WebGPUShaderPassesHelp')}</div>
            <div class="webgpuSettingsPasses" data-presentation-passes></div>
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
            </div>
        </section>`;
}

/** Binds the presentation section's controls; every change persists, then applies to the player live. */
export function bindPresentationSection(context: PresentationSectionContext): PresentationSectionController {
    const { panel, player } = context;
    const HDROutputCheckbox = requireSectionElement<HTMLInputElement>(panel, `[data-setting-checkbox="${HDR_OUTPUT_SETTING_KEY}"]`);
    const fileList = requireSectionElement<HTMLElement>(panel, '[data-presentation-passes]');
    const passFileInput = requireSectionElement<HTMLInputElement>(panel, '[data-presentation-pass-files]');
    const statusElement = requireSectionElement<HTMLElement>(panel, '[data-presentation-status]');
    const addFilesButton = requireSectionElement<HTMLButtonElement>(panel, '.webgpuSettingsAddPasses');
    const removeFilesButton = requireSectionElement<HTMLButtonElement>(panel, '.webgpuSettingsRemovePasses');
    const HDROutputDefaultButton = requireSectionElement<HTMLButtonElement>(panel, `[data-default-setting="${HDR_OUTPUT_SETTING_KEY}"]`);
    let report = player.getPresentationPlanReport();
    // A preset result arriving after a newer change must not overwrite it
    let presetRevision = 0;
    // What the file list shows; a save that changes neither keeps the list's inputs, and the focused one
    let renderedReport: PlanReport | null = null;
    let renderedSources: readonly (string | null)[] = [];
    // The stored files' sources from the pass source store; null until they are read
    let sources: Map<number, string> | null = null;
    // The store keys the settings held while the panel was open, whose sources go once neither these nor the stored settings hold them
    const knownSourceKeys = new Set<number>(getStoredFileSourceKeys(context.getSettings().presentation.files));

    const renderFiles = (): void => {
        const files = context.getSettings().presentation.files;
        // The buttons and the list wait for the sources
        addFilesButton.disabled = sources === null;
        removeFilesButton.disabled = sources === null || files.length === 0;
        if (sources === null) {
            return;
        }
        const loadedSources = sources;
        const fileSources = files.map((file: StoredPresentationFile): string | null => getStoredFileSource(file, loadedSources));
        if (report === renderedReport
            && fileSources.length === renderedSources.length
            && fileSources.every((source: string | null, index: number): boolean => source === renderedSources[index])) {
            return;
        }
        renderedReport = report;
        renderedSources = fileSources;
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
            filesHTML.push(createFileHTML(file, views, stateLines, index));
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

    /** Deletes the sources of files that neither these settings nor the stored ones hold, so a refused save never loses a source the stored settings need. */
    const releaseDroppedSources = (): void => {
        const heldKeys = new Set<number>([
            ...getStoredFileSourceKeys(context.getSettings().presentation.files),
            ...getStoredFileSourceKeys(loadWebGPUUserSettings().presentation.files)
        ]);
        const droppedKeys = [ ...knownSourceKeys ].filter((key: number): boolean => !heldKeys.has(key));
        if (droppedKeys.length > 0) {
            deleteSources(droppedKeys);
        }
    };

    const describeReport = (planReport: PlanReport): string => {
        if (context.getSettings().presentation.files.length === 0) {
            return globalize.translate('WebGPUShaderPassesNone');
        }
        return globalize.translate('WebGPUShaderPassesSummary', planReport.activePasses.length, planReport.inactivePasses.length);
    };

    const savePresentation = (presentation: WebGPUUserSettings['presentation']): string | null => (
        context.saveSettings(normalizeWebGPUUserSettings({ ...context.getSettings(), presentation }))
    );

    /** Reads the stored files' sources; the list shows once they are read. */
    const loadSources = async (): Promise<void> => {
        let loadedSources = new Map<number, string>();
        let failure: string | null = null;
        try {
            loadedSources = await readPassSources(getStoredFileSourceKeys(context.getSettings().presentation.files));
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

    /** Hands the files with sources to the player once the sources are read; a file without one stays out, and its entry says so. */
    const applyPreset = (notice: string | null): void => {
        presetRevision += 1;
        const revision = presetRevision;
        setStatus(statusElement, globalize.translate('WebGPUShaderPassesApplying'));
        void sourcesLoaded.then((): Promise<PlanReport> => {
            const preset = createStoredPresentationPreset(context.getSettings().presentation.files, sources ?? new Map<number, string>());
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
                setStatus(statusElement, joinSentences(applied, notice) ?? applied);
            }
        }, (error: unknown): void => {
            if (context.isActive()) {
                setStatus(statusElement, globalize.translate('WebGPUHDROutputFailed', getErrorMessage(error)));
            }
        });
    };

    const updateFiles = (files: readonly StoredPresentationFile[], notice: string | null): void => {
        const saveFailure = savePresentation({ ...context.getSettings().presentation, files });
        applyPreset(joinSentences(notice, describeSaveFailure(saveFailure)));
    };

    /** Stores each chosen file's source and adds the files in order; a file past the limits, or one the store refused, is named in the notice. */
    const addPassFiles = async (chosenFiles: readonly File[]): Promise<void> => {
        const addedFiles: StoredPresentationFile[] = [];
        const skippedNames: string[] = [];
        let failureNotice: string | null = null;
        for (const chosenFile of chosenFiles) {
            const fileCount = context.getSettings().presentation.files.length + addedFiles.length;
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
        updateFiles([ ...context.getSettings().presentation.files, ...addedFiles ], joinSentences(skippedNotice, failureNotice));
    };

    const onHDROutputChange = (): void => {
        const saveFailure = savePresentation({ ...context.getSettings().presentation, hdrOutput: HDROutputCheckbox.checked });
        applyHDROutput(describeSaveFailure(saveFailure));
    };

    const onHDROutputDefault = (): void => {
        HDROutputCheckbox.checked = createDefaultWebGPUUserSettings().presentation.hdrOutput;
        onHDROutputChange();
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

    const onFileListClick = (event: Event): void => {
        const target = event.target;
        const removeButton = target instanceof Element ? target.closest<HTMLElement>('[data-remove-file]') : null;
        if (!removeButton) {
            return;
        }
        const removedIndex = Number(removeButton.dataset.removeFile);
        updateFiles(context.getSettings().presentation.files.filter(
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
        const files = context.getSettings().presentation.files;
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
        // The file's passes share the value, so each pass that declares the parameter takes it; only names matter here, so any preset position does
        const source = sources === null ? null : getStoredFileSource(changedFile, sources);
        const declaringViews = (source === null ? [] : describePassFile(source, fileIndex)).filter((view: PassView): boolean => (
            view.manifest?.parameters.some((parameter: PassParameter): boolean => parameter.name === parameterName) ?? false
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
        [ addFilesButton, 'click', onAddFiles ],
        [ passFileInput, 'change', onPassFilesChosen ],
        [ removeFilesButton, 'click', onRemoveFiles ],
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

    return {
        apply: (): void => {
            applyHDROutput(null);
            applyPreset(null);
        },
        synchronize: (): void => {
            HDROutputCheckbox.checked = context.getSettings().presentation.hdrOutput;
            renderFiles();
            releaseDroppedSources();
        }
    };
}

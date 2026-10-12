import escapeHtml from 'escape-html';

import globalize from 'lib/globalize';

import { parsePassManifest, PassManifestError } from 'webgpu-player/presentation/passes/PassManifest';
import type { PassManifest, PassParameter, PassRejection, PlanReport } from 'webgpu-player/presentation/passes/PassTypes';
import type { PresentationPresetPass } from 'webgpu-player/presentation/WebGPUPresenter';

import type WebGPUPlayer from '../WebGPUPlayer';
import {
    createDefaultWebGPUUserSettings,
    isPresentationPassSource,
    MAXIMUM_PRESENTATION_PASS_COUNT,
    MAXIMUM_PRESENTATION_PASS_SOURCE_LENGTH,
    normalizeWebGPUUserSettings,
    type WebGPUUserSettings
} from '../WebGPUUserSettings';
import { createDefaultButtonHTML, HIDDEN_CLASS, setStatus, translateToHTML } from './SettingsPanelHTML';

// The presentation section of the playback settings panel: HDR output, and the user's WGSL shader passes in this browser

const HDR_OUTPUT_SETTING_KEY = 'hdrOutput';
// The pass files the picker offers: WGSL sources, which are plain text
const PASS_FILE_TYPES = '.wgsl,text/plain';
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
    /** Persists settings and synchronizes every control of the panel */
    saveSettings: (settings: WebGPUUserSettings) => void
}>;

export type PresentationSectionController = Readonly<{
    /** Hands the settings' HDR output and shader passes to the player */
    apply: () => void
    /** Shows the settings' HDR output and shader passes */
    synchronize: () => void
}>;

/** A stored pass as the panel shows it: its manifest when the header parses, else what failed. */
type PassView = Readonly<{
    headerFailure: string | null
    manifest: PassManifest | null
    name: string
}>;

type PassFile = Readonly<{
    name: string
    source: string
}>;

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function requireSectionElement<ElementType extends Element>(panel: ParentNode, selector: string): ElementType {
    const element = panel.querySelector<ElementType>(selector);
    if (!element) {
        throw new Error(`WebGPU settings panel is missing ${selector}`);
    }
    return element;
}

function describePass(pass: PresentationPresetPass, index: number): PassView {
    try {
        const manifest = parsePassManifest(pass.source);
        return { headerFailure: null, manifest, name: manifest.name };
    } catch (error) {
        if (!(error instanceof PassManifestError)) {
            throw error;
        }
        return {
            headerFailure: `header-invalid: line ${error.line}: ${error.message}`,
            manifest: null,
            name: error.passName ?? globalize.translate('WebGPUShaderPassUnnamed', index + 1)
        };
    }
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

function createParameterHTML(pass: PresentationPresetPass, passName: string, parameter: PassParameter, passIndex: number): string {
    const value = pass.parameters[parameter.name] ?? parameter.defaultValue;
    const step = parameter.type === 'f32' ? FLOAT_PARAMETER_STEP : INTEGER_PARAMETER_STEP;
    return `
        <label class="webgpuSettingsPassParameter">
            <span>${escapeHtml(parameter.name)}</span>
            <input
                aria-label="${translateToHTML('WebGPUShaderPassParameter', passName, parameter.name)}"
                class="webgpuSettingsNumber"
                data-parameter-name="${escapeHtml(parameter.name)}"
                data-pass-index="${passIndex}"
                is="emby-input"
                max="${parameter.maximum}"
                min="${parameter.minimum}"
                step="${step}"
                type="number"
                value="${value}"
            />
        </label>`;
}

function createPassHTML(pass: PresentationPresetPass, view: PassView, state: string, index: number): string {
    const parametersHTML = (view.manifest?.parameters ?? [])
        .map((parameter: PassParameter): string => createParameterHTML(pass, view.name, parameter, index))
        .join('');
    return `
        <div class="webgpuSettingsPass">
            <div class="webgpuSettingsPassHeader">
                <span class="webgpuSettingsPassName">${escapeHtml(view.name)}</span>
                <button
                    aria-label="${translateToHTML('WebGPURemoveShaderPass', view.name)}"
                    class="webgpuSettingsRemovePass"
                    data-remove-pass="${index}"
                    is="paper-icon-button-light"
                    title="${translateToHTML('WebGPURemoveShaderPass', view.name)}"
                    type="button"
                ><span class="material-icons delete" aria-hidden="true"></span></button>
            </div>
            <div class="fieldDescription webgpuSettingsPassState">${escapeHtml(state)}</div>
            ${parametersHTML}
        </div>`;
}

function readPassFile(file: File): Promise<PassFile> {
    return file.text().then((source: string): PassFile => ({ name: file.name, source }));
}

/** Returns the presentation section's HTML: the HDR output switch, the pass list, and the pass buttons. */
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
    const passList = requireSectionElement<HTMLElement>(panel, '[data-presentation-passes]');
    const passFileInput = requireSectionElement<HTMLInputElement>(panel, '[data-presentation-pass-files]');
    const statusElement = requireSectionElement<HTMLElement>(panel, '[data-presentation-status]');
    const addPassesButton = requireSectionElement<HTMLButtonElement>(panel, '.webgpuSettingsAddPasses');
    const removePassesButton = requireSectionElement<HTMLButtonElement>(panel, '.webgpuSettingsRemovePasses');
    const HDROutputDefaultButton = requireSectionElement<HTMLButtonElement>(panel, `[data-default-setting="${HDR_OUTPUT_SETTING_KEY}"]`);
    let report = player.getPresentationPlanReport();
    // A preset result arriving after a newer change must not overwrite it
    let presetRevision = 0;
    // What the pass list shows; a save that changes neither keeps the list's inputs, and the focused one
    let renderedReport: PlanReport | null = null;
    let renderedSources: readonly string[] = [];

    const renderPasses = (): void => {
        const passes = context.getSettings().presentation.passes;
        removePassesButton.disabled = passes.length === 0;
        if (report === renderedReport
            && passes.length === renderedSources.length
            && passes.every((pass: PresentationPresetPass, index: number): boolean => pass.source === renderedSources[index])) {
            return;
        }
        renderedReport = report;
        renderedSources = passes.map((pass: PresentationPresetPass): string => pass.source);
        const seenNames = new Set<string>();
        const passesHTML: string[] = [];
        for (let index = 0; index < passes.length; index += 1) {
            const view = describePass(passes[index], index);
            passesHTML.push(createPassHTML(passes[index], view, getPassState(view, report, seenNames.has(view.name)), index));
            seenNames.add(view.name);
        }
        passList.innerHTML = passesHTML.join('');
    };

    const describeReport = (planReport: PlanReport): string => {
        if (context.getSettings().presentation.passes.length === 0) {
            return globalize.translate('WebGPUShaderPassesNone');
        }
        return globalize.translate('WebGPUShaderPassesSummary', planReport.activePasses.length, planReport.inactivePasses.length);
    };

    const applyPreset = (notice: string | null): void => {
        presetRevision += 1;
        const revision = presetRevision;
        setStatus(statusElement, globalize.translate('WebGPUShaderPassesApplying'));
        void player.setPresentationPreset(context.getSettings().presentation.passes).then((planReport: PlanReport): void => {
            if (!context.isActive() || revision !== presetRevision) {
                return;
            }
            report = planReport;
            renderPasses();
            const summary = describeReport(planReport);
            setStatus(statusElement, notice === null ? summary : globalize.translate('WebGPUJoinedSentences', notice, summary));
        }, (error: unknown): void => {
            if (!context.isActive() || revision !== presetRevision) {
                return;
            }
            setStatus(statusElement, globalize.translate('WebGPUShaderPassesFailed', getErrorMessage(error)));
        });
    };

    const applyHDROutput = (): void => {
        void player.setHDROutputEnabled(context.getSettings().presentation.hdrOutput).then((): void => {
            if (context.isActive()) {
                setStatus(statusElement, globalize.translate('WebGPUHDROutputApplied'));
            }
        }, (error: unknown): void => {
            if (context.isActive()) {
                setStatus(statusElement, globalize.translate('WebGPUHDROutputFailed', getErrorMessage(error)));
            }
        });
    };

    const savePresentation = (presentation: WebGPUUserSettings['presentation']): void => {
        context.saveSettings(normalizeWebGPUUserSettings({ ...context.getSettings(), presentation }));
    };

    const updatePasses = (passes: readonly PresentationPresetPass[], notice: string | null): void => {
        savePresentation({ ...context.getSettings().presentation, passes });
        applyPreset(notice);
    };

    const onHDROutputChange = (): void => {
        savePresentation({ ...context.getSettings().presentation, hdrOutput: HDROutputCheckbox.checked });
        applyHDROutput();
    };

    const onHDROutputDefault = (): void => {
        HDROutputCheckbox.checked = createDefaultWebGPUUserSettings().presentation.hdrOutput;
        onHDROutputChange();
    };

    const onAddPasses = (): void => {
        passFileInput.value = '';
        passFileInput.click();
    };

    const onPassFilesChosen = (): void => {
        const files = Array.from(passFileInput.files ?? []);
        if (files.length === 0) {
            return;
        }
        void Promise.all(files.map(readPassFile)).then((chosenFiles: PassFile[]): void => {
            if (!context.isActive()) {
                return;
            }
            const passes = [ ...context.getSettings().presentation.passes ];
            const skippedNames: string[] = [];
            for (const chosenFile of chosenFiles) {
                if (passes.length >= MAXIMUM_PRESENTATION_PASS_COUNT || !isPresentationPassSource(chosenFile.source)) {
                    skippedNames.push(chosenFile.name);
                    continue;
                }
                passes.push({ parameters: {}, source: chosenFile.source });
            }
            const notice = skippedNames.length === 0 ?
                null :
                globalize.translate(
                    'WebGPUShaderPassFilesSkipped',
                    skippedNames.join(', '),
                    MAXIMUM_PRESENTATION_PASS_COUNT,
                    MAXIMUM_PRESENTATION_PASS_SOURCE_LENGTH
                );
            updatePasses(passes, notice);
        }, (error: unknown): void => {
            if (context.isActive()) {
                setStatus(statusElement, globalize.translate('WebGPUShaderPassesFailed', getErrorMessage(error)));
            }
        });
    };

    const onRemovePasses = (): void => {
        updatePasses([], null);
    };

    const onPassListClick = (event: Event): void => {
        const target = event.target;
        const removeButton = target instanceof Element ? target.closest<HTMLElement>('[data-remove-pass]') : null;
        if (!removeButton) {
            return;
        }
        const removedIndex = Number(removeButton.dataset.removePass);
        updatePasses(context.getSettings().presentation.passes.filter(
            (_pass: PresentationPresetPass, index: number): boolean => index !== removedIndex
        ), null);
    };

    const onPassListChange = (event: Event): void => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || input.dataset.parameterName === undefined) {
            return;
        }
        const passIndex = Number(input.dataset.passIndex);
        const parameterName = input.dataset.parameterName;
        const value = Number(input.value);
        const passes = context.getSettings().presentation.passes;
        const changedPass = passes.at(passIndex);
        if (!changedPass || !Number.isFinite(value)) {
            return;
        }
        savePresentation({
            ...context.getSettings().presentation,
            passes: passes.map((pass: PresentationPresetPass, index: number): PresentationPresetPass => (
                index === passIndex ? { ...pass, parameters: { ...pass.parameters, [parameterName]: value } } : pass
            ))
        });
        // A pass that is not running yet takes the stored value when its preset next applies
        try {
            player.setPresentationParameter(describePass(changedPass, passIndex).name, parameterName, value);
            setStatus(statusElement, globalize.translate('WebGPUShaderPassParameterApplied'));
        } catch (error) {
            setStatus(statusElement, globalize.translate('WebGPUShaderPassParameterPending', getErrorMessage(error)));
        }
    };

    const listeners: Array<[EventTarget, string, (event: Event) => void]> = [
        [ HDROutputCheckbox, 'change', onHDROutputChange ],
        [ HDROutputDefaultButton, 'click', onHDROutputDefault ],
        [ addPassesButton, 'click', onAddPasses ],
        [ passFileInput, 'change', onPassFilesChosen ],
        [ removePassesButton, 'click', onRemovePasses ],
        [ passList, 'click', onPassListClick ],
        [ passList, 'change', onPassListChange ]
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
            applyHDROutput();
            applyPreset(null);
        },
        synchronize: (): void => {
            HDROutputCheckbox.checked = context.getSettings().presentation.hdrOutput;
            renderPasses();
        }
    };
}

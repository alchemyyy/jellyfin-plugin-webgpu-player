import escapeHtml from 'escape-html';

import globalize from 'lib/globalize';

import { BROWSER_GUIDES, GUIDE_BROWSER_IDS, type GuideBrowserId } from '../BrowserIdentity';
import {
    diagnoseWebGPUFailure,
    formatWebGPUFailureReport,
    formatWebGPUFailureText,
    translateWebGPUFailureExplanation,
    WEBGPU_FAILURE_CAUSE_KEYS,
    WEBGPU_FAILURE_CONFIDENCE_KEYS,
    WEBGPU_FIX_STEP_KEYS,
    type WebGPUFailureDiagnosis,
    type WebGPUFailureFactLine,
    type WebGPUFailureReport,
    type WebGPUFixStep,
    type WebGPUFixStepArgument
} from '../WebGPUFailureDiagnosis';
import { loadWebGPUUserSettings, saveWebGPUUserSettings } from '../WebGPUUserSettings';
import { HIDDEN_CLASS, translateToHTML } from './SettingsPanelHTML';
import './WebGPUTheme.scss';
import './WebGPUFailureDialog.scss';

// The warning window that tells why WebGPU failed and how to fix it, centered over the player.
// It is not modal: the video keeps playing through the browser's own player behind it.
// Keys pressed inside it stay inside, since the video OSD reacts to Space, digits and arrows, and the wheel would change the volume

type ActiveDialog = Readonly<{ element: HTMLElement, promise: Promise<void> }>;

const TITLE_ID = 'webgpu-failure-title';
const SUMMARY_ID = 'webgpu-failure-summary';
const BROWSER_SELECT_ID = 'webgpu-failure-browser';
const KEY_EVENTS = [ 'keydown', 'keyup', 'keypress' ] as const;

let activeDialog: ActiveDialog | null = null;

function requireElement<ElementType extends Element>(root: ParentNode, selector: string): ElementType {
    const element = root.querySelector<ElementType>(selector);
    if (!element) {
        throw new Error(`WebGPU failure dialog element is missing: ${selector}`);
    }
    return element;
}

function createArgumentHTML(argument: WebGPUFixStepArgument): string {
    const value = escapeHtml(argument.value);
    switch (argument.kind) {
        case 'code': {
            const copyLabel = translateToHTML('WebGPUFailureCopyValue', argument.value);
            return `<span class="webgpuFailureChip"><code class="webgpuFailureChipValue">${value}</code><button
                aria-label="${copyLabel}"
                class="webgpuFailureChipCopy"
                data-copy-value="${value}"
                title="${copyLabel}"
                type="button"
            ><span class="material-icons content_copy" aria-hidden="true"></span></button></span>`;
        }
        case 'label':
            return `<strong class="webgpuFailureUiLabel">${value}</strong>`;
        default:
            return value;
    }
}

function createStepHTML(fixStep: WebGPUFixStep): string {
    return `<li class="webgpuFailureStep">${formatWebGPUFailureText(WEBGPU_FIX_STEP_KEYS[fixStep.code], fixStep.args, escapeHtml, createArgumentHTML)}</li>`;
}

function createBrowserSelectHTML(browser: GuideBrowserId): string {
    const options = GUIDE_BROWSER_IDS.map((id: GuideBrowserId): string => (
        `<option value="${id}"${id === browser ? ' selected' : ''}>${escapeHtml(BROWSER_GUIDES[id].name)}</option>`
    )).join('');
    return `<select aria-label="${translateToHTML('WebGPUFailureBrowser')}" class="webgpuFailureBrowser" id="${BROWSER_SELECT_ID}">${options}</select>`;
}

function createFactHTML(line: WebGPUFailureFactLine): string {
    return `<dt class="webgpuFailureFactLabel">${escapeHtml(line.label)}</dt><dd class="webgpuFailureFactValue">${escapeHtml(line.value)}</dd>`;
}

function createDiagnosisHTML(diagnosis: WebGPUFailureDiagnosis): string {
    return `
        <h3 class="webgpuFailureCauseHeadline">${translateToHTML(WEBGPU_FAILURE_CAUSE_KEYS[diagnosis.cause])}</h3>
        <p class="webgpuFailureCauseText">${escapeHtml(translateWebGPUFailureExplanation(diagnosis))}</p>
        <p class="webgpuFailureConfidence" data-confidence="${diagnosis.confidence}">${translateToHTML(WEBGPU_FAILURE_CONFIDENCE_KEYS[diagnosis.confidence])}</p>`;
}

function createDialogHTML(report: WebGPUFailureReport, warningEnabled: boolean): string {
    const { diagnosis } = report;
    const closeLabel = translateToHTML('ButtonClose');
    const fixHeading = formatWebGPUFailureText('WebGPUFailureFixHeading', [ diagnosis.browser ], escapeHtml, createBrowserSelectHTML);
    return `
        <div class="webgpuFailureTitleBar">
            <span class="material-icons warning webgpuFailureTitleIcon" aria-hidden="true"></span>
            <h2 class="webgpuFailureTitle" id="${TITLE_ID}">${translateToHTML('WebGPUFailureDialogTitle')}</h2>
            <button aria-label="${closeLabel}" class="webgpuFailureIconButton webgpuFailureClose" title="${closeLabel}" type="button">
                <span class="material-icons close" aria-hidden="true"></span>
            </button>
        </div>
        <div class="webgpuFailureBody">
            <p class="webgpuFailureSummary" id="${SUMMARY_ID}">${translateToHTML('WebGPUFailureSummary')}</p>
            <section class="webgpuFailureCause" data-failure-cause="${diagnosis.cause}">${createDiagnosisHTML(diagnosis)}</section>
            <section class="webgpuFailureFix">
                <h3 class="webgpuFailureFixHeading">${fixHeading}</h3>
                <p class="webgpuFailureCopyHint">${translateToHTML('WebGPUFailureCopyHint')}</p>
                <ol class="webgpuFailureSteps">${diagnosis.steps.map(createStepHTML).join('')}</ol>
            </section>
            <details class="webgpuFailureDetails">
                <summary class="webgpuFailureDetailsSummary">${translateToHTML('WebGPUFailureDetails')}</summary>
                <dl class="webgpuFailureFacts">${diagnosis.facts.map(createFactHTML).join('')}</dl>
            </details>
            <textarea aria-label="${translateToHTML('WebGPUFailureReportText')}" class="webgpuFailureReportText ${HIDDEN_CLASS}" readonly></textarea>
            <label class="webgpuFailureShowWarning">
                <input class="webgpuFailureShowWarningCheckbox" type="checkbox"${warningEnabled ? ' checked' : ''}>
                <span>${translateToHTML('WebGPUFailureShowWarning')}</span>
            </label>
            <p aria-live="polite" class="webgpuFailureStatus" role="status"></p>
        </div>
        <div class="webgpuFailureButtons">
            <button class="webgpuFailureButton webgpuFailureCopyReport" type="button">
                <span class="material-icons content_copy" aria-hidden="true"></span>
                <span>${translateToHTML('WebGPUFailureCopyReport')}</span>
            </button>
            <button class="webgpuFailureButton webgpuFailureButtonPrimary webgpuFailureCloseButton" type="button">${closeLabel}</button>
        </div>`;
}

function readWarningEnabled(): boolean {
    try {
        return loadWebGPUUserSettings().osd.webGPUFailureWarning;
    } catch {
        return true;
    }
}

/** Copies text through the clipboard API; false where the page may not write the clipboard. */
async function writeClipboard(text: string): Promise<boolean> {
    // eslint-disable-next-line compat/compat -- Browsers without the async clipboard take the selection fallback
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (typeof clipboard?.writeText !== 'function') {
        return false;
    }
    try {
        await clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
}

/** Copies a text area's selected text the old way; false where the browser refuses. */
function copySelection(textArea: HTMLTextAreaElement): boolean {
    textArea.focus();
    textArea.select();
    try {
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- The fallback for pages the async clipboard refuses
        return typeof document.execCommand === 'function' && document.execCommand('copy');
    } catch {
        return false;
    }
}

function createDialogController(report: WebGPUFailureReport, invokingElement: HTMLElement | null): ActiveDialog {
    const dialog = document.createElement('div');
    dialog.className = 'webgpuUi webgpuFailureDialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'false');
    dialog.setAttribute('aria-labelledby', TITLE_ID);
    dialog.setAttribute('aria-describedby', SUMMARY_ID);
    dialog.tabIndex = -1;
    dialog.innerHTML = createDialogHTML(report, readWarningEnabled());

    const causeSection = requireElement<HTMLElement>(dialog, '.webgpuFailureCause');
    const stepList = requireElement<HTMLOListElement>(dialog, '.webgpuFailureSteps');
    const browserSelect = requireElement<HTMLSelectElement>(dialog, '.webgpuFailureBrowser');
    const reportText = requireElement<HTMLTextAreaElement>(dialog, '.webgpuFailureReportText');
    const warningCheckbox = requireElement<HTMLInputElement>(dialog, '.webgpuFailureShowWarningCheckbox');
    const status = requireElement<HTMLElement>(dialog, '.webgpuFailureStatus');
    let browser = report.diagnosis.browser;
    let resolveDialog: (() => void) | null = null;
    const promise = new Promise<void>((resolve): void => {
        resolveDialog = resolve;
    });

    const close = (): void => {
        if (!dialog.isConnected) {
            return;
        }
        dialog.remove();
        if (invokingElement?.isConnected) {
            invokingElement.focus();
        }
        resolveDialog?.();
        resolveDialog = null;
    };

    const onBrowserChange = (): void => {
        browser = browserSelect.value as GuideBrowserId;
        const diagnosis = diagnoseWebGPUFailure(report.facts, browser);
        causeSection.dataset.failureCause = diagnosis.cause;
        causeSection.innerHTML = createDiagnosisHTML(diagnosis);
        stepList.innerHTML = diagnosis.steps.map(createStepHTML).join('');
    };

    const onCopyReport = async (): Promise<void> => {
        const text = formatWebGPUFailureReport(report, browser);
        if (await writeClipboard(text)) {
            status.textContent = globalize.translate('WebGPUFailureReportCopied');
            return;
        }
        // The page may not write the clipboard, so the report shows selected for the user to copy
        reportText.value = text;
        reportText.classList.remove(HIDDEN_CLASS);
        status.textContent = globalize.translate(copySelection(reportText) ? 'WebGPUFailureReportCopied' : 'WebGPUFailureReportCopyManual');
    };

    const onCopyValue = async (value: string): Promise<void> => {
        status.textContent = globalize.translate(await writeClipboard(value) ? 'WebGPUFailureValueCopied' : 'WebGPUFailureValueCopyFailed', value);
    };

    const onWarningChange = (): void => {
        try {
            const settings = loadWebGPUUserSettings();
            saveWebGPUUserSettings({ ...settings, osd: { ...settings.osd, webGPUFailureWarning: warningCheckbox.checked } });
            status.textContent = '';
        } catch (error) {
            status.textContent = globalize.translate('WebGPUFailureShowWarningSaveFailed', error instanceof Error ? error.message : String(error));
        }
    };

    dialog.addEventListener('click', (event: MouseEvent): void => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('.webgpuFailureClose, .webgpuFailureCloseButton')) {
            close();
            return;
        }
        if (target?.closest('.webgpuFailureCopyReport')) {
            void onCopyReport();
            return;
        }
        const copyButton = target?.closest<HTMLElement>('[data-copy-value]');
        if (copyButton) {
            void onCopyValue(copyButton.dataset.copyValue ?? '');
        }
    });
    browserSelect.addEventListener('change', onBrowserChange);
    warningCheckbox.addEventListener('change', onWarningChange);
    for (const type of KEY_EVENTS) {
        dialog.addEventListener(type, (event: KeyboardEvent): void => {
            event.stopPropagation();
            if (type === 'keydown' && event.key === 'Escape') {
                event.preventDefault();
                close();
            }
        });
    }
    // The video OSD changes the volume on wheel events that reach the document; the dialog keeps its own scrolling
    dialog.addEventListener('wheel', (event: WheelEvent): void => {
        event.stopPropagation();
    }, { passive: true });

    document.body.appendChild(dialog);
    dialog.focus();
    return { element: dialog, promise };
}

/** Shows the WebGPU failure dialog for a report, and resolves once it closes; while one is open, it takes the focus and its promise is returned. */
export function showWebGPUFailureDialog(report: WebGPUFailureReport): Promise<void> {
    if (activeDialog) {
        activeDialog.element.focus();
        return activeDialog.promise;
    }
    const activeElement = document.activeElement;
    const created = createDialogController(report, activeElement instanceof HTMLElement ? activeElement : null);
    const promise = created.promise.finally((): void => {
        if (activeDialog?.element === created.element) {
            activeDialog = null;
        }
    });
    activeDialog = { element: created.element, promise };
    return promise;
}

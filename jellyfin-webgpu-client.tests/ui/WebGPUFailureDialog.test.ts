import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storageMockState = vi.hoisted(() => ({ value: null as string | null }));

vi.mock('lib/globalize', async () => {
    // The factory runs before the module's imports, so it loads the source strings itself
    const globalizeMock = await import('../host/globalizeMock');
    return { default: { translate: globalizeMock.translateSourceString } };
});

// WebGPUUserSettings persists through the host user settings, which the add-on build redirects to its shim
vi.mock('scripts/settings/userSettings', () => ({
    currentSettings: {
        get: vi.fn((): string | null => storageMockState.value),
        set: vi.fn((_name: string, value: string): void => {
            storageMockState.value = value;
        })
    }
}));

vi.mock('addons/webGPUPlayer/ui/WebGPUTheme.scss', () => ({}));
vi.mock('addons/webGPUPlayer/ui/WebGPUFailureDialog.scss', () => ({}));

import { showWebGPUFailureDialog } from 'addons/webGPUPlayer/ui/WebGPUFailureDialog';
import {
    diagnoseWebGPUFailure,
    formatWebGPUFailureReport,
    type WebGPUFailureFacts,
    type WebGPUFailureReport
} from 'addons/webGPUPlayer/WebGPUFailureDiagnosis';
import { WEBGPU_USER_SETTINGS_VERSION } from 'addons/webGPUPlayer/WebGPUUserSettings';

// Chrome on Windows without WebGL or an adapter: hardware acceleration is off
const FACTS: WebGPUFailureFacts = {
    adapter: { result: 'null' },
    browser: { browser: 'chrome', family: 'chromium', majorVersion: 141, os: 'windows' },
    cpuArchitecture: 'x86',
    deviceLost: null,
    fallbackAdapter: { result: 'null' },
    gpuPresent: true,
    origin: 'https://jellyfin.example',
    secureContext: true,
    source: { detail: 'requestAdapter: null', kind: 'presentation', reason: 'adapter-unavailable' },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0 <long user agent>',
    webGL: { result: 'unavailable' }
};
const REPORT: WebGPUFailureReport = { diagnosis: diagnoseWebGPUFailure(FACTS), facts: FACTS };

function requireDialogElement<ElementType extends Element>(selector: string): ElementType {
    const element = document.querySelector<ElementType>(selector);
    if (!element) {
        throw new Error(`Missing ${selector}`);
    }
    return element;
}

function getChipValues(): string[] {
    return Array.from(document.querySelectorAll('.webgpuFailureSteps .webgpuFailureChipValue'), (element: Element): string => element.textContent ?? '');
}

function setClipboard(writeText: ((text: string) => Promise<void>) | null): void {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: writeText === null ? undefined : { writeText } });
}

function pressKey(target: Element, key: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key });
    target.dispatchEvent(event);
    return event;
}

describe('WebGPU failure dialog', () => {
    let invokingButton: HTMLButtonElement;

    beforeEach(() => {
        storageMockState.value = null;
        invokingButton = document.createElement('button');
        document.body.appendChild(invokingButton);
        invokingButton.focus();
    });

    afterEach(() => {
        document.body.innerHTML = '';
        setClipboard(null);
    });

    it('opens a labelled, non-modal window over the settings windows, and the close button closes it and returns the focus', async () => {
        const dialogPromise = showWebGPUFailureDialog(REPORT);
        const dialog = requireDialogElement<HTMLElement>('.webgpuFailureDialog');

        expect(dialog.classList.contains('webgpuUi')).toBe(true);
        expect(dialog.getAttribute('role')).toBe('dialog');
        expect(dialog.getAttribute('aria-modal')).toBe('false');
        expect(document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.classList.contains('webgpuFailureTitle')).toBe(true);
        expect(dialog.contains(document.activeElement)).toBe(true);
        expect(requireDialogElement<HTMLElement>('.webgpuFailureCause').dataset.failureCause).toBe('hardware-acceleration-off');
        expect(requireDialogElement<HTMLElement>('.webgpuFailureConfidence').dataset.confidence).toBe('likely');
        // One dialog at a time
        expect(showWebGPUFailureDialog(REPORT)).toBe(dialogPromise);
        expect(document.querySelectorAll('.webgpuFailureDialog')).toHaveLength(1);

        requireDialogElement<HTMLButtonElement>('.webgpuFailureClose').click();

        await expect(dialogPromise).resolves.toBeUndefined();
        expect(document.querySelector('.webgpuFailureDialog')).toBeNull();
        expect(document.activeElement).toBe(invokingButton);
    });

    it('closes on the Close button too', async () => {
        const dialogPromise = showWebGPUFailureDialog(REPORT);

        requireDialogElement<HTMLButtonElement>('.webgpuFailureCloseButton').click();

        await expect(dialogPromise).resolves.toBeUndefined();
        expect(document.querySelector('.webgpuFailureDialog')).toBeNull();
    });

    it('closes on Escape, and keeps every key and wheel event inside from the video OSD', async () => {
        const documentKeyDown = vi.fn();
        const documentWheel = vi.fn();
        document.addEventListener('keydown', documentKeyDown);
        document.addEventListener('wheel', documentWheel);
        const dialogPromise = showWebGPUFailureDialog(REPORT);
        const browserSelect = requireDialogElement<HTMLSelectElement>('.webgpuFailureBrowser');

        pressKey(browserSelect, ' ');
        pressKey(browserSelect, 'ArrowUp');
        browserSelect.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }));
        expect(document.querySelector('.webgpuFailureDialog')).not.toBeNull();

        const escape = pressKey(browserSelect, 'Escape');

        await expect(dialogPromise).resolves.toBeUndefined();
        expect(escape.defaultPrevented).toBe(true);
        expect(documentKeyDown).not.toHaveBeenCalled();
        expect(documentWheel).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(invokingButton);
        document.removeEventListener('keydown', documentKeyDown);
        document.removeEventListener('wheel', documentWheel);
    });

    it('prefills the detected browser, and writes the steps anew for the browser picked', async () => {
        const dialogPromise = showWebGPUFailureDialog(REPORT);
        const browserSelect = requireDialogElement<HTMLSelectElement>('.webgpuFailureBrowser');

        expect(browserSelect.value).toBe('chrome');
        expect(browserSelect.options).toHaveLength(9);
        expect(getChipValues()).toEqual([ 'chrome://settings/system', 'chrome://gpu' ]);

        browserSelect.value = 'edge';
        browserSelect.dispatchEvent(new Event('change', { bubbles: true }));
        expect(getChipValues()).toEqual([ 'edge://settings/system', 'edge://gpu' ]);

        // Vivaldi keeps the setting in its own settings, a path through its menus
        browserSelect.value = 'vivaldi';
        browserSelect.dispatchEvent(new Event('change', { bubbles: true }));
        expect(getChipValues()).toEqual([ 'vivaldi://gpu' ]);
        expect(requireDialogElement<HTMLElement>('.webgpuFailureSteps').textContent).toContain('Settings > Performance');

        requireDialogElement<HTMLButtonElement>('.webgpuFailureClose').click();
        await dialogPromise;
    });

    it('lists the engine\'s reason and the observed facts in the details', async () => {
        const dialogPromise = showWebGPUFailureDialog(REPORT);

        const labels = Array.from(document.querySelectorAll('.webgpuFailureFactLabel'), (element: Element): string => element.textContent ?? '');
        const values = Array.from(document.querySelectorAll('.webgpuFailureFactValue'), (element: Element): string => element.textContent ?? '');
        expect(labels).toContain('failure');
        expect(values).toContain('presentation: adapter-unavailable');
        expect(values).toContain(FACTS.userAgent);

        requireDialogElement<HTMLButtonElement>('.webgpuFailureClose').click();
        await dialogPromise;
    });

    it('copies the report for the picked browser, and a step\'s address from its chip', async () => {
        const writeText = vi.fn((): Promise<void> => Promise.resolve());
        setClipboard(writeText);
        const dialogPromise = showWebGPUFailureDialog(REPORT);
        const browserSelect = requireDialogElement<HTMLSelectElement>('.webgpuFailureBrowser');
        browserSelect.value = 'brave';
        browserSelect.dispatchEvent(new Event('change', { bubbles: true }));

        requireDialogElement<HTMLButtonElement>('.webgpuFailureCopyReport').click();

        await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(formatWebGPUFailureReport(REPORT, 'brave')));
        await vi.waitFor(() => expect(requireDialogElement<HTMLElement>('.webgpuFailureStatus').textContent).not.toBe(''));
        expect(requireDialogElement<HTMLTextAreaElement>('.webgpuFailureReportText').classList.contains('hide')).toBe(true);

        requireDialogElement<HTMLButtonElement>('.webgpuFailureSteps [data-copy-value="brave://gpu"]').click();
        await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith('brave://gpu'));

        requireDialogElement<HTMLButtonElement>('.webgpuFailureClose').click();
        await dialogPromise;
    });

    it('shows the report selected for copying where the page may not write the clipboard', async () => {
        setClipboard((): Promise<void> => Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError')));
        const dialogPromise = showWebGPUFailureDialog(REPORT);

        requireDialogElement<HTMLButtonElement>('.webgpuFailureCopyReport').click();

        const reportText = requireDialogElement<HTMLTextAreaElement>('.webgpuFailureReportText');
        await vi.waitFor(() => expect(reportText.classList.contains('hide')).toBe(false));
        expect(reportText.value).toBe(formatWebGPUFailureReport(REPORT));
        expect(document.activeElement).toBe(reportText);

        requireDialogElement<HTMLButtonElement>('.webgpuFailureClose').click();
        await dialogPromise;
    });

    it('saves the choice not to show the warning, and to show it again', async () => {
        const dialogPromise = showWebGPUFailureDialog(REPORT);
        const checkbox = requireDialogElement<HTMLInputElement>('.webgpuFailureShowWarningCheckbox');
        expect(checkbox.checked).toBe(true);

        checkbox.checked = false;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        expect(JSON.parse(storageMockState.value ?? 'null')).toEqual({
            osd: { webGPUFailureWarning: false },
            version: WEBGPU_USER_SETTINGS_VERSION
        });

        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        expect(JSON.parse(storageMockState.value ?? 'null')).toEqual({ version: WEBGPU_USER_SETTINGS_VERSION });

        requireDialogElement<HTMLButtonElement>('.webgpuFailureClose').click();
        await dialogPromise;
    });

    it('shows the warning choice as stored', async () => {
        storageMockState.value = JSON.stringify({ osd: { webGPUFailureWarning: false }, version: WEBGPU_USER_SETTINGS_VERSION });
        const dialogPromise = showWebGPUFailureDialog(REPORT);

        expect(requireDialogElement<HTMLInputElement>('.webgpuFailureShowWarningCheckbox').checked).toBe(false);

        requireDialogElement<HTMLButtonElement>('.webgpuFailureClose').click();
        await dialogPromise;
    });
});

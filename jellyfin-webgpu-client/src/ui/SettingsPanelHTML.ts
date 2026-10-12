import escapeHtml from 'escape-html';

import globalize from 'lib/globalize';

/** The host's class that hides an element. */
export const HIDDEN_CLASS = 'hide';

/** Shows a status message in a panel's status line. */
export function setStatus(element: HTMLElement, message: string): void {
    element.textContent = message;
}

/** Translates a key for the panel's HTML, escaped because translations may contain markup characters. */
export function translateToHTML(key: string, ...replacements: unknown[]): string {
    return escapeHtml(globalize.translate(key, ...replacements));
}

/** Returns the button that restores one setting's default; the panel finds it by its data-default-setting value. */
export function createDefaultButtonHTML(settingKey: string, settingName: string): string {
    return `
        <button
            aria-label="${translateToHTML('WebGPURestoreSettingDefault', settingName)}"
            class="raised webgpuSettingsDefaultButton"
            data-default-setting="${settingKey}"
            is="emby-button"
            type="button"
        >${translateToHTML('Default')}</button>`;
}

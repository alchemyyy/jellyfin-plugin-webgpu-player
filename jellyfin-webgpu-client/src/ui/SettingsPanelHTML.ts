import escapeHtml from 'escape-html';

import globalize from 'lib/globalize';

/** The host's class that hides an element. */
export const HIDDEN_CLASS = 'hide';

// The material icon of a button that restores one setting's default
const DEFAULT_SETTING_ICON = 'settings_backup_restore';

/** Shows a status message in a panel's status line. */
export function setStatus(element: HTMLElement, message: string): void {
    element.textContent = message;
}

/** Translates a key for the panel's HTML, escaped because translations may contain markup characters. */
export function translateToHTML(key: string, ...replacements: unknown[]): string {
    return escapeHtml(globalize.translate(key, ...replacements));
}

/** Returns the icon button that restores one setting's default, named by its label and tooltip; the panel finds it by its data-default-setting value. */
export function createDefaultButtonHTML(settingKey: string, settingName: string): string {
    const label = translateToHTML('WebGPURestoreSettingDefault', settingName);
    return `
        <button
            aria-label="${label}"
            class="webgpuSettingsDefaultButton"
            data-default-setting="${settingKey}"
            is="paper-icon-button-light"
            title="${label}"
            type="button"
        ><span class="material-icons ${DEFAULT_SETTING_ICON}" aria-hidden="true"></span></button>`;
}

import escapeHtml from 'escape-html';

import globalize from 'lib/globalize';

/** The host's class that hides an element. */
export const HIDDEN_CLASS = 'hide';

/** Shows a status message in a status line of the settings. */
export function setStatus(element: HTMLElement, message: string): void {
    element.textContent = message;
}

/** Translates a key for the settings' HTML, escaped because translations may contain markup characters. */
export function translateToHTML(key: string, ...replacements: unknown[]): string {
    return escapeHtml(globalize.translate(key, ...replacements));
}

/** Returns the id of a setting's description, which its info button shows or hides. */
export function getSettingDescriptionId(settingKey: string): string {
    return `webgpu-${settingKey}-description`;
}

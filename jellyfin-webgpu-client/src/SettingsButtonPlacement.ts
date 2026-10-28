// Where the video OSD offers the WebGPU Settings panel: a button in the OSD's control bar, beside the host's settings button or at the bar's end,
// or an item of the host's player settings menu instead of a button

export type SettingsButtonPlacement = 'after-settings' | 'before-settings' | 'controls-end' | 'settings-menu';

/** The placements a stored or server value may name. */
export const SETTINGS_BUTTON_PLACEMENTS: readonly SettingsButtonPlacement[] = Object.freeze([
    'before-settings',
    'after-settings',
    'controls-end',
    'settings-menu'
]);

/** The add-on's own placement: the button just before the host's settings button, where it has always been. */
export const DEFAULT_SETTINGS_BUTTON_PLACEMENT: SettingsButtonPlacement = 'before-settings';

/** Returns whether a stored or server value is one of the placements. */
export function isSettingsButtonPlacement(value: unknown): value is SettingsButtonPlacement {
    return SETTINGS_BUTTON_PLACEMENTS.some((placement: SettingsButtonPlacement): boolean => placement === value);
}

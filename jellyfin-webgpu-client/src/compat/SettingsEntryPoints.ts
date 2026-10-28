import escapeHtml from 'escape-html';

import { playbackManager } from 'components/playback/playbackmanager';
import globalize from 'lib/globalize';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { pageIdOn } from 'utils/dashboard';
import Events from 'utils/events';

import { subscribeClientDefaults } from '../ClientDefaults';
import { loadAddonStrings } from '../host/globalize';
import type { SettingsButtonPlacement } from '../SettingsButtonPlacement';
import { readVideoPlayerPreference, writeVideoPlayerPreference } from '../shims/userSettings';
import { createSettingOptionsHTML, VIDEO_PLAYER_PREFERENCE_OPTIONS } from '../ui/SettingDefinitions';
import { loadWebGPUUserSettings } from '../WebGPUUserSettings';

// The stock host has no player settings menu seam and lacks the fork's preference control, so both entry points are added to the host pages through the DOM when those pages show

type SettingsMenuItem = Readonly<{
    id: string
    name: string
    onSelect: () => unknown
}>;

/** The player whose settings panel the OSD button opens and closes */
export type SettingsEntryPlayer = {
    getSettingsMenuItems: () => readonly SettingsMenuItem[]
};

const VIEW_SHOW_EVENT = 'viewshow';
const HIDDEN_CLASS = 'hide';
export const VIDEO_OSD_PAGE_ID = 'videoOsdPage';
// The host's user Playback settings page (route mypreferencesplayback)
const PLAYBACK_SETTINGS_PAGE_ID = 'languagePreferencesPage';
const PLAYER_STATE_EVENTS = [ 'playerchange', 'playbackstart', 'playbackstop' ];

const OSD_SETTINGS_BUTTON_CLASS = 'btnWebGPUPlayerSettings';
export const OSD_SETTINGS_ANCHOR_SELECTOR = '.btnVideoOsdSettings';
// The OSD's control bar, which holds the host's settings button
const OSD_BUTTONS_BAR_SELECTOR = '.buttons';
const OSD_SETTINGS_ICON = 'tune';
const SETTINGS_MENU_ITEM_ID = 'webgpu-playback-settings';

const PREFERENCE_FIELD_CLASS = 'fldWebGPUPreferredVideoPlayer';
const PREFERENCE_SELECT_CLASS = 'selectWebGPUPreferredVideoPlayer';
// The fork placed the preference first in the advanced video section
const PREFERENCE_ANCHOR_SELECTOR = '.fldEnableDts';
const PREFERENCE_FALLBACK_ANCHOR_SELECTOR = 'form .btnSave';
const USER_ID_PARAMETER = 'userId';

// Each OSD page's button, kept while the placement leaves it out of the page
const osdSettingsButtons = new WeakMap<HTMLElement, HTMLElement>();
let installedPlayer: SettingsEntryPlayer | null = null;

function getSettingsMenuItem(player: SettingsEntryPlayer): SettingsMenuItem | undefined {
    return player.getSettingsMenuItems().find(menuItem => menuItem.id === SETTINGS_MENU_ITEM_ID);
}

/** Returns the player's WebGPU Settings menu item name, or null when the player offers no settings panel. */
export function getSettingsPanelName(player: SettingsEntryPlayer): string | null {
    return getSettingsMenuItem(player)?.name ?? null;
}

/** Opens or closes the WebGPU settings panel through the player's menu item. */
export function toggleSettingsPanel(player: SettingsEntryPlayer): void {
    Promise.resolve(getSettingsMenuItem(player)?.onSelect()).catch((error: unknown): void => {
        console.error('[WebGPUPlayer] unable to toggle the WebGPU settings panel', error);
    });
}

/** Returns where the video OSD offers the WebGPU settings panel. */
export function getSettingsButtonPlacement(): SettingsButtonPlacement {
    return loadWebGPUUserSettings().osd.settingsButtonPlacement;
}

/** Shows the OSD button only while this player is PlaybackManager's current player. */
function updateOsdSettingsButtons(player: SettingsEntryPlayer): void {
    const isCurrentPlayer = playbackManager.getCurrentPlayer() === player;
    const buttons = document.querySelectorAll(`#${VIDEO_OSD_PAGE_ID} .${OSD_SETTINGS_BUTTON_CLASS}`);
    for (const button of Array.from(buttons)) {
        button.classList.toggle(HIDDEN_CLASS, !isCurrentPlayer);
    }
}

function createOsdSettingsButton(player: SettingsEntryPlayer, menuItem: SettingsMenuItem): HTMLElement {
    const container = document.createElement('div');
    const title = escapeHtml(menuItem.name);
    container.innerHTML = `<button is="paper-icon-button-light" class="${OSD_SETTINGS_BUTTON_CLASS} autoSize ${HIDDEN_CLASS}"`
        + ` title="${title}" aria-label="${title}">`
        + `<span class="largePaperIconButton material-icons ${OSD_SETTINGS_ICON}" aria-hidden="true"></span>`
        + '</button>';
    const button = container.firstElementChild as HTMLElement;
    button.addEventListener('click', (): void => {
        toggleSettingsPanel(player);
    });
    return button;
}

/** Moves the button to its placement in the OSD page's control bar, or out of the page for the settings menu placement. */
function placeOsdSettingsButton(page: HTMLElement, button: HTMLElement, placement: SettingsButtonPlacement): void {
    const anchor = page.querySelector(OSD_SETTINGS_ANCHOR_SELECTOR);
    const buttonsBar = anchor?.closest(OSD_BUTTONS_BAR_SELECTOR);
    if (!anchor || !buttonsBar || placement === 'settings-menu') {
        button.remove();
        return;
    }
    switch (placement) {
        case 'after-settings':
            anchor.after(button);
            break;
        case 'controls-end':
            buttonsBar.appendChild(button);
            break;
        case 'before-settings':
            anchor.before(button);
            break;
    }
}

/** Creates the WebGPU Settings button once per OSD page and places it where the settings place it. */
export function ensureOsdSettingsButton(page: HTMLElement, player: SettingsEntryPlayer): void {
    let button = osdSettingsButtons.get(page);
    if (!button) {
        const menuItem = getSettingsMenuItem(player);
        if (!menuItem) {
            return;
        }
        button = createOsdSettingsButton(player, menuItem);
        osdSettingsButtons.set(page, button);
    }
    placeOsdSettingsButton(page, button, getSettingsButtonPlacement());
    updateOsdSettingsButtons(player);
}

/** Places the WebGPU Settings button anew on every OSD page in the document, after a placement change. */
export function applySettingsButtonPlacement(): void {
    const player = installedPlayer;
    if (!player) {
        return;
    }
    for (const page of Array.from(document.querySelectorAll<HTMLElement>(`#${VIDEO_OSD_PAGE_ID}`))) {
        ensureOsdSettingsButton(page, player);
    }
}

/** Returns the user whose settings the page edits: its userId parameter, else the signed-in user. */
function getSettingsPageUserId(): string | undefined {
    const hash = window.location.hash;
    const hashQueryIndex = hash.indexOf('?');
    const hashQuery = hashQueryIndex < 0 ? '' : hash.slice(hashQueryIndex + 1);
    const pageUserId = new URLSearchParams(hashQuery).get(USER_ID_PARAMETER)
        || new URLSearchParams(window.location.search).get(USER_ID_PARAMETER);
    return pageUserId || ServerConnections.currentApiClient()?.getCurrentUserId() || undefined;
}

function createPreferenceField(): HTMLElement {
    const field = document.createElement('div');
    field.className = `selectContainer ${PREFERENCE_FIELD_CLASS}`;
    field.innerHTML = `<select is="emby-select" class="${PREFERENCE_SELECT_CLASS}"`
        + ` label="${escapeHtml(globalize.translate('WebGPUPreferredVideoPlayer'))}">`
        + createSettingOptionsHTML(VIDEO_PLAYER_PREFERENCE_OPTIONS)
        + '</select>'
        + `<div class="fieldDescription">${escapeHtml(globalize.translate('WebGPUPreferredVideoPlayerHelp'))}</div>`;
    return field;
}

/** Adds the preferred video player control to the Playback settings page and loads its value. */
export function ensurePreferredPlayerControl(page: HTMLElement): void {
    let select = page.querySelector<HTMLSelectElement>(`.${PREFERENCE_SELECT_CLASS}`);
    if (!select) {
        const anchor = page.querySelector(PREFERENCE_ANCHOR_SELECTOR)
            ?? page.querySelector(PREFERENCE_FALLBACK_ANCHOR_SELECTOR);
        if (!anchor?.parentElement) {
            return;
        }
        const field = createPreferenceField();
        anchor.parentElement.insertBefore(field, anchor);
        const createdSelect = field.querySelector<HTMLSelectElement>(`.${PREFERENCE_SELECT_CLASS}`);
        if (!createdSelect) {
            return;
        }
        // The preference is local, so it saves on change instead of with the server-backed form
        createdSelect.addEventListener('change', (): void => {
            writeVideoPlayerPreference(createdSelect.value, createdSelect.dataset.userId || undefined);
        });
        select = createdSelect;
    }

    const userId = getSettingsPageUserId();
    select.dataset.userId = userId ?? '';
    select.value = readVideoPlayerPreference(userId);
}

/** Registers the OSD button and the preference control once per page lifetime. */
export function installSettingsEntryPoints(player: SettingsEntryPlayer): boolean {
    if (installedPlayer) {
        return false;
    }
    installedPlayer = player;

    // Both entry points render add-on strings, so they wait for the current locale's translation
    pageIdOn(VIEW_SHOW_EVENT, VIDEO_OSD_PAGE_ID, (event: Event): void => {
        const page = event.target as HTMLElement;
        void loadAddonStrings().then((): void => {
            ensureOsdSettingsButton(page, player);
        });
    });
    pageIdOn(VIEW_SHOW_EVENT, PLAYBACK_SETTINGS_PAGE_ID, (event: Event): void => {
        const page = event.target as HTMLElement;
        void loadAddonStrings().then((): void => {
            ensurePreferredPlayerControl(page);
        });
    });
    // A server default can change the placement of users who follow it
    subscribeClientDefaults(applySettingsButtonPlacement);
    // The OSD can show before play() resolves and PlaybackManager makes this player current
    for (const eventName of PLAYER_STATE_EVENTS) {
        Events.on(playbackManager, eventName, (): void => {
            updateOsdSettingsButtons(player);
        });
    }
    return true;
}

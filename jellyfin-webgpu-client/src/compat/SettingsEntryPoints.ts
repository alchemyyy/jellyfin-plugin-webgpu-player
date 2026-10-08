import escapeHtml from 'escape-html';

import { playbackManager } from 'components/playback/playbackmanager';
import globalize from 'lib/globalize';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import appSettings from 'scripts/settings/appSettings';
import { pageIdOn } from 'utils/dashboard';
import Events from 'utils/events';

import { normalizeVideoPlayerPreference, VideoPlayerPreference } from '../PreferredVideoPlayer';
import { PREFERRED_VIDEO_PLAYER_KEY } from '../shims/userSettings';

// The stock host has no player settings menu seam and dropped the fork's preference control, so both
// entry points are added to the host pages through the DOM when those pages show

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
const VIDEO_OSD_PAGE_ID = 'videoOsdPage';
// The host's user Playback settings page (route mypreferencesplayback)
const PLAYBACK_SETTINGS_PAGE_ID = 'languagePreferencesPage';
const PLAYER_STATE_EVENTS = [ 'playerchange', 'playbackstart', 'playbackstop' ];

const OSD_SETTINGS_BUTTON_CLASS = 'btnWebGPUPlayerSettings';
const OSD_SETTINGS_ANCHOR_SELECTOR = '.btnVideoOsdSettings';
const OSD_SETTINGS_ICON = 'tune';
const SETTINGS_MENU_ITEM_ID = 'webgpu-playback-settings';

const PREFERENCE_FIELD_CLASS = 'fldWebGPUPreferredVideoPlayer';
const PREFERENCE_SELECT_CLASS = 'selectWebGPUPreferredVideoPlayer';
// The fork placed the preference first in the advanced video section
const PREFERENCE_ANCHOR_SELECTOR = '.fldEnableDts';
const PREFERENCE_FALLBACK_ANCHOR_SELECTOR = 'form .btnSave';
const USER_ID_PARAMETER = 'userId';

let installed = false;

function getSettingsMenuItem(player: SettingsEntryPlayer): SettingsMenuItem | undefined {
    return player.getSettingsMenuItems().find(menuItem => menuItem.id === SETTINGS_MENU_ITEM_ID);
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
        Promise.resolve(getSettingsMenuItem(player)?.onSelect()).catch((error: unknown): void => {
            console.error('[WebGPUPlayer] unable to toggle the WebGPU settings panel', error);
        });
    });
    return button;
}

/** Adds the WebGPU Settings button beside the OSD settings button once per OSD page. */
export function ensureOsdSettingsButton(page: HTMLElement, player: SettingsEntryPlayer): void {
    if (!page.querySelector(`.${OSD_SETTINGS_BUTTON_CLASS}`)) {
        const menuItem = getSettingsMenuItem(player);
        const anchor = page.querySelector(OSD_SETTINGS_ANCHOR_SELECTOR);
        if (!menuItem || !anchor?.parentElement) {
            return;
        }
        anchor.parentElement.insertBefore(createOsdSettingsButton(player, menuItem), anchor);
    }
    updateOsdSettingsButtons(player);
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
        + ` label="${escapeHtml(globalize.translate('LabelPreferredVideoPlayer'))}">`
        + `<option value="${VideoPlayerPreference.Auto}">${escapeHtml(globalize.translate('Auto'))}</option>`
        + `<option value="${VideoPlayerPreference.WEBGPU}">WebGPU</option>`
        + `<option value="${VideoPlayerPreference.HTML}">HTML</option>`
        + '</select>'
        + `<div class="fieldDescription">${escapeHtml(globalize.translate('PreferredVideoPlayerHelp'))}</div>`;
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
            appSettings.set(
                PREFERRED_VIDEO_PLAYER_KEY,
                normalizeVideoPlayerPreference(createdSelect.value),
                createdSelect.dataset.userId || undefined
            );
        });
        select = createdSelect;
    }

    const userId = getSettingsPageUserId();
    select.dataset.userId = userId ?? '';
    select.value = normalizeVideoPlayerPreference(
        appSettings.get(PREFERRED_VIDEO_PLAYER_KEY, userId) ?? VideoPlayerPreference.Auto
    );
}

/** Registers the OSD button and the preference control once per page lifetime. */
export function installSettingsEntryPoints(player: SettingsEntryPlayer): boolean {
    if (installed) {
        return false;
    }
    installed = true;

    pageIdOn(VIEW_SHOW_EVENT, VIDEO_OSD_PAGE_ID, (event: Event): void => {
        ensureOsdSettingsButton(event.target as HTMLElement, player);
    });
    pageIdOn(VIEW_SHOW_EVENT, PLAYBACK_SETTINGS_PAGE_ID, (event: Event): void => {
        ensurePreferredPlayerControl(event.target as HTMLElement);
    });
    // The OSD can show before play() resolves and PlaybackManager makes this player current
    for (const eventName of PLAYER_STATE_EVENTS) {
        Events.on(playbackManager, eventName, (): void => {
            updateOsdSettingsButtons(player);
        });
    }
    return true;
}

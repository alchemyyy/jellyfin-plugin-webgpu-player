import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Events from 'utils/events';

type PageHandler = (event: Event) => void;

const testState = vi.hoisted(() => ({
    currentPlayer: null as unknown,
    pageHandlers: new Map<string, (event: Event) => void>(),
    storage: new Map<string, string>()
}));

const playbackManagerMock = vi.hoisted(() => ({
    getCurrentPlayer: (): unknown => testState.currentPlayer
}));

vi.mock('components/playback/playbackmanager', () => ({ playbackManager: playbackManagerMock }));
vi.mock('lib/globalize', () => ({
    default: { translate: (key: string): string => `translated ${key}` }
}));
vi.mock('lib/jellyfin-apiclient', () => ({
    ServerConnections: {
        currentApiClient: () => ({ getCurrentUserId: () => 'current-user' })
    }
}));
vi.mock('scripts/settings/appSettings', () => ({
    default: {
        get: (name: string, userId?: string): string | null => (
            testState.storage.get(userId ? `${userId}-${name}` : name) ?? null
        ),
        set: (name: string, value: string, userId?: string): void => {
            testState.storage.set(userId ? `${userId}-${name}` : name, value);
        }
    }
}));
// WebGPUUserSettings persists through the host user settings, which the add-on build redirects to its shim
vi.mock('scripts/settings/userSettings', () => ({
    currentSettings: {
        get: (name: string): string | null => testState.storage.get(name) ?? null,
        set: (name: string, value: string): void => {
            testState.storage.set(name, value);
        }
    }
}));
vi.mock('utils/dashboard', () => ({
    pageIdOn: (eventName: string, pageId: string, handler: PageHandler): void => {
        testState.pageHandlers.set(`${eventName}:${pageId}`, handler);
    }
}));

import { setClientDefaults } from 'addons/webGPUPlayer/ClientDefaults';
import {
    applySettingsButtonPlacement,
    ensureOsdSettingsButton,
    ensurePreferredPlayerControl,
    installSettingsEntryPoints,
    type SettingsEntryPlayer
} from 'addons/webGPUPlayer/compat/SettingsEntryPoints';
import type { SettingsButtonPlacement } from 'addons/webGPUPlayer/SettingsButtonPlacement';
import { loadWebGPUUserSettings, saveWebGPUUserSettings } from 'addons/webGPUPlayer/WebGPUUserSettings';

const OSD_BUTTON_SELECTOR = '.btnWebGPUPlayerSettings';
const PREFERENCE_SELECT_SELECTOR = '.selectWebGPUPreferredVideoPlayer';

function createPlayer(onSelect: () => unknown = vi.fn()): SettingsEntryPlayer {
    return {
        getSettingsMenuItems: () => [ { id: 'webgpu-playback-settings', name: 'WebGPU Settings', onSelect } ]
    };
}

function createOsdPage(withAnchor = true): HTMLElement {
    const page = document.createElement('div');
    page.id = 'videoOsdPage';
    page.innerHTML = '<div class="buttons">'
        + '<div dir="ltr"><button class="btnPause"></button></div>'
        + (withAnchor ? '<button class="btnVideoOsdSettings"></button>' : '')
        + '<button class="btnFullscreen"></button></div>';
    document.body.appendChild(page);
    return page;
}

function createPlaybackSettingsPage(markup: string): HTMLElement {
    const page = document.createElement('div');
    page.id = 'languagePreferencesPage';
    page.innerHTML = `<div class="settingsContainer"><form>${markup}<button class="btnSave"></button></form></div>`;
    document.body.appendChild(page);
    return page;
}

function savePlacement(settingsButtonPlacement: SettingsButtonPlacement): void {
    saveWebGPUUserSettings({ ...loadWebGPUUserSettings(), osd: { settingsButtonPlacement } });
}

describe('SettingsEntryPoints', () => {
    beforeEach(() => {
        testState.currentPlayer = null;
        testState.storage.clear();
        setClientDefaults({});
        window.location.hash = '';
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    describe('ensureOsdSettingsButton', () => {
        it('adds one button before the OSD settings button that toggles the WebGPU settings panel', () => {
            const onSelect = vi.fn(() => Promise.resolve());
            const player = createPlayer(onSelect);
            const page = createOsdPage();
            testState.currentPlayer = player;

            ensureOsdSettingsButton(page, player);
            ensureOsdSettingsButton(page, player);

            const buttons = page.querySelectorAll<HTMLButtonElement>(OSD_BUTTON_SELECTOR);
            expect(buttons).toHaveLength(1);
            expect(buttons[0].nextElementSibling?.classList.contains('btnVideoOsdSettings')).toBe(true);
            expect(buttons[0].title).toBe('WebGPU Settings');
            expect(buttons[0].classList.contains('hide')).toBe(false);

            // The menu item toggles, so every click reaches it, including the one that closes the panel
            buttons[0].click();
            buttons[0].click();
            expect(onSelect).toHaveBeenCalledTimes(2);
        });

        it('places the button where the user settings place it', () => {
            const player = createPlayer();
            testState.currentPlayer = player;

            savePlacement('after-settings');
            const afterPage = createOsdPage();
            ensureOsdSettingsButton(afterPage, player);
            expect(afterPage.querySelector(OSD_BUTTON_SELECTOR)?.previousElementSibling?.classList.contains('btnVideoOsdSettings')).toBe(true);

            savePlacement('controls-end');
            const endPage = createOsdPage();
            ensureOsdSettingsButton(endPage, player);
            expect(endPage.querySelector('.buttons')?.lastElementChild?.matches(OSD_BUTTON_SELECTOR)).toBe(true);

            savePlacement('settings-menu');
            const menuPage = createOsdPage();
            ensureOsdSettingsButton(menuPage, player);
            expect(menuPage.querySelector(OSD_BUTTON_SELECTOR)).toBeNull();
        });

        it('follows the server default placement when the user has not chosen one', () => {
            const player = createPlayer();
            setClientDefaults({ settingsButtonPlacement: 'controls-end' });
            const page = createOsdPage();

            ensureOsdSettingsButton(page, player);

            expect(page.querySelector('.buttons')?.lastElementChild?.matches(OSD_BUTTON_SELECTOR)).toBe(true);
        });

        it('hides the button while another player is current', () => {
            const player = createPlayer();
            const page = createOsdPage();
            testState.currentPlayer = createPlayer();

            ensureOsdSettingsButton(page, player);

            expect(page.querySelector(OSD_BUTTON_SELECTOR)?.classList.contains('hide')).toBe(true);
        });

        it('tolerates an OSD without the settings button', () => {
            const page = createOsdPage(false);

            expect(() => ensureOsdSettingsButton(page, createPlayer())).not.toThrow();
            expect(page.querySelector(OSD_BUTTON_SELECTOR)).toBeNull();
        });
    });

    describe('ensurePreferredPlayerControl', () => {
        it('adds the control before the DTS option and loads the signed-in user preference', () => {
            testState.storage.set('current-user-preferredVideoPlayer', 'html');
            const page = createPlaybackSettingsPage('<div class="checkboxContainer fldEnableDts"></div>');

            ensurePreferredPlayerControl(page);
            ensurePreferredPlayerControl(page);

            const selects = page.querySelectorAll<HTMLSelectElement>(PREFERENCE_SELECT_SELECTOR);
            expect(selects).toHaveLength(1);
            expect(selects[0].closest('.selectContainer')?.nextElementSibling?.classList.contains('fldEnableDts')).toBe(true);
            expect(selects[0].getAttribute('label')).toBe('translated WebGPUPreferredVideoPlayer');
            expect(selects[0].value).toBe('html');
            expect(page.querySelector('.fieldDescription')?.textContent).toBe('translated WebGPUPreferredVideoPlayerHelp');
        });

        it('edits the user named by the page parameter and saves on change', () => {
            window.location.hash = '#/mypreferencesplayback?userId=other-user';
            const page = createPlaybackSettingsPage('<div class="fldEnableDts"></div>');

            ensurePreferredPlayerControl(page);
            const select = page.querySelector<HTMLSelectElement>(PREFERENCE_SELECT_SELECTOR) as HTMLSelectElement;
            expect(select.value).toBe('auto');

            select.value = 'webgpu';
            select.dispatchEvent(new Event('change'));

            expect(testState.storage.get('other-user-preferredVideoPlayer')).toBe('webgpu');
            expect(testState.storage.has('current-user-preferredVideoPlayer')).toBe(false);
        });

        it('shows the server default for a user without a choice', () => {
            setClientDefaults({ preferredVideoPlayer: 'html' });
            const page = createPlaybackSettingsPage('<div class="fldEnableDts"></div>');

            ensurePreferredPlayerControl(page);

            expect(page.querySelector<HTMLSelectElement>(PREFERENCE_SELECT_SELECTOR)?.value).toBe('html');
        });

        it('falls back to the save button and tolerates pages without anchors', () => {
            const page = createPlaybackSettingsPage('');
            ensurePreferredPlayerControl(page);
            expect(page.querySelector(PREFERENCE_SELECT_SELECTOR)?.closest('.selectContainer')?.nextElementSibling
                ?.classList.contains('btnSave')).toBe(true);

            const emptyPage = document.createElement('div');
            expect(() => ensurePreferredPlayerControl(emptyPage)).not.toThrow();
            expect(emptyPage.childElementCount).toBe(0);
        });
    });

    describe('installSettingsEntryPoints', () => {
        it('registers the page handlers once, follows player changes, and places the button anew', async () => {
            const player = createPlayer();
            const page = createOsdPage();

            // Nothing is installed yet, so there is no player to create a button for
            applySettingsButtonPlacement();
            expect(page.querySelector(OSD_BUTTON_SELECTOR)).toBeNull();

            expect(installSettingsEntryPoints(player)).toBe(true);
            expect(installSettingsEntryPoints(player)).toBe(false);

            // Each handler first waits for the add-on strings, which are already loaded here
            testState.pageHandlers.get('viewshow:videoOsdPage')?.({ target: page } as unknown as Event);
            await Promise.resolve();
            const button = page.querySelector(OSD_BUTTON_SELECTOR) as HTMLElement;
            expect(button.classList.contains('hide')).toBe(true);

            testState.currentPlayer = player;
            Events.trigger(playbackManagerMock, 'playbackstart', [ player ]);
            expect(button.classList.contains('hide')).toBe(false);

            testState.currentPlayer = null;
            Events.trigger(playbackManagerMock, 'playerchange', []);
            expect(button.classList.contains('hide')).toBe(true);

            const settingsPage = createPlaybackSettingsPage('<div class="fldEnableDts"></div>');
            testState.pageHandlers.get('viewshow:languagePreferencesPage')?.({ target: settingsPage } as unknown as Event);
            await Promise.resolve();
            expect(settingsPage.querySelector(PREFERENCE_SELECT_SELECTOR)).not.toBeNull();

            // A placement change moves the same button on every OSD page, out of the bar and back
            testState.currentPlayer = player;
            savePlacement('settings-menu');
            applySettingsButtonPlacement();
            expect(page.querySelector(OSD_BUTTON_SELECTOR)).toBeNull();

            savePlacement('controls-end');
            applySettingsButtonPlacement();
            expect(page.querySelector('.buttons')?.lastElementChild).toBe(button);
            expect(button.classList.contains('hide')).toBe(false);

            // A user who follows the default follows a new server default at once
            testState.storage.clear();
            setClientDefaults({ settingsButtonPlacement: 'after-settings' });
            expect(button.previousElementSibling?.classList.contains('btnVideoOsdSettings')).toBe(true);

            // Showing the OSD again places the button anew
            savePlacement('before-settings');
            testState.pageHandlers.get('viewshow:videoOsdPage')?.({ target: page } as unknown as Event);
            await Promise.resolve();
            expect(button.nextElementSibling?.classList.contains('btnVideoOsdSettings')).toBe(true);
            expect(page.querySelectorAll(OSD_BUTTON_SELECTOR)).toHaveLength(1);
        });
    });
});

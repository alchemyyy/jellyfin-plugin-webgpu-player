import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type HostPlayer = {
    isLocalPlayer: boolean
    name: string
};

type HostPlayerState = {
    NowPlayingItem?: { RunTimeTicks?: number }
    PlayState: Record<string, unknown>
};

const testState = vi.hoisted(() => ({
    currentItem: null as Record<string, unknown> | null,
    currentPlayer: null as unknown,
    panelToggles: 0,
    playRequests: [] as unknown[],
    playerState: { PlayState: {} } as HostPlayerState,
    playing: true,
    playlist: [] as Array<Record<string, unknown>>,
    playlistIndex: 0,
    storage: new Map<string, string>(),
    toasts: [] as string[],
    transparencyLevels: [] as string[],
    webGPUPlayable: true
}));

const playbackManagerMock = vi.hoisted(() => ({
    currentItem: (): unknown => testState.currentItem,
    getCurrentPlayer: (): unknown => testState.currentPlayer,
    getCurrentPlaylistIndex: (): number => testState.playlistIndex,
    getPlayerState: (): unknown => testState.playerState,
    getPlaylist: (): Promise<unknown> => Promise.resolve(testState.playlist.slice(0)),
    isPlaying: (): boolean => testState.playing,
    play: (options: unknown): Promise<void> => {
        testState.playRequests.push(options);
        return Promise.resolve();
    },
    syncPlayEnabled: false
}));

vi.mock('components/backdrop/backdrop', () => ({
    setBackdropTransparency: (level: string): void => {
        testState.transparencyLevels.push(level);
    },
    TRANSPARENCY_LEVEL: { Backdrop: 'backdrop', Full: 'full', None: 'none' }
}));
vi.mock('components/playback/playbackmanager', () => ({ playbackManager: playbackManagerMock }));
vi.mock('components/toast/toast', () => ({
    default: (text: string): void => {
        testState.toasts.push(text);
    }
}));
vi.mock('lib/globalize', () => ({
    default: {
        translate: (key: string, ...replacements: string[]): string => (
            key === 'WebGPUJoinedSentences' ? replacements.join(' ') : `translated ${key}`
        )
    }
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
vi.mock('utils/dashboard', () => ({ pageIdOn: (): void => undefined }));

import { setClientDefaults } from 'addons/webGPUPlayer/ClientDefaults';
import {
    installPlayerSettingsMenu,
    setWebGPUPlayerEnabled,
    type PlayerSettingsMenuPlayer
} from 'addons/webGPUPlayer/compat/PlayerSettingsMenu';
import type { SettingsButtonPlacement } from 'addons/webGPUPlayer/SettingsButtonPlacement';
import { preferredVideoPlayer } from 'addons/webGPUPlayer/shims/userSettings';
import { loadWebGPUUserSettings, saveWebGPUUserSettings } from 'addons/webGPUPlayer/WebGPUUserSettings';

const PREFERENCE_STORAGE_KEY = 'current-user-preferredVideoPlayer';
const HOST_ITEM_CLASS = 'listItem listItem-button actionSheetMenuItem emby-button';
const TOGGLE_SELECTOR = '[data-id="webgpu-player-toggle"]';
const SETTINGS_SELECTOR = '[data-id="webgpu-playback-settings"]';

// Mirrors HostCompatibleWebGPUPlayer: it declines when the user prefers the HTML player
const webGPUPlayer: PlayerSettingsMenuPlayer & HostPlayer = {
    canPlayItem: (): boolean => preferredVideoPlayer() !== 'html' && testState.webGPUPlayable,
    getSettingsMenuItems: () => [ {
        id: 'webgpu-playback-settings',
        name: 'WebGPU Settings',
        onSelect: (): void => {
            testState.panelToggles += 1;
        }
    } ],
    isLocalPlayer: true,
    name: 'WebGPU Player'
};
const htmlPlayer: HostPlayer = { isLocalPlayer: true, name: 'Html Video Player' };

function createOsdPage(): HTMLElement {
    const page = document.createElement('div');
    page.id = 'videoOsdPage';
    page.innerHTML = '<div class="buttons"><button class="btnVideoOsdSettings"><span class="settings"></span></button></div>';
    document.body.appendChild(page);
    return page;
}

function clickOsdSettingsButton(): void {
    const icon = (document.querySelector('#videoOsdPage .btnVideoOsdSettings span') ?? createOsdPage().querySelector('span')) as HTMLElement;
    icon.click();
}

function createHostItem(id: string, name: string, asideText: string | null, itemClass = HOST_ITEM_CLASS): string {
    return `<button is="emby-button" type="button" class="${itemClass}" data-id="${id}">`
        + `<div class="listItemBody actionsheetListItemBody"><div class="listItemBodyText actionSheetItemText">${name}</div></div>`
        + (asideText === null ? '' : `<div class="listItemAside actionSheetItemAsideText">${asideText}</div>`)
        + '</button>';
}

type SheetOptions = {
    fullscreen?: boolean
    itemClass?: string
    items?: string
    left?: number
    size?: { height: number, width: number }
    top?: number
};

/** Opens an action sheet as dialogHelper.open and actionSheet.show do: the container joins the body, then the sheet is positioned. */
function openHostSheet(options: SheetOptions = {}): HTMLElement {
    const sheet = document.createElement('div');
    sheet.className = `focuscontainer dialog actionSheet centeredDialog opened ${options.fullscreen ? 'actionsheet-fullscreen' : 'actionsheet-not-fullscreen'}`;
    const items = options.items ?? createHostItem('aspectratio', 'Aspect ratio', 'Auto', options.itemClass)
        + createHostItem('stats', 'Playback data', null, options.itemClass);
    sheet.innerHTML = `<div class="actionSheetContent"><div class="actionSheetScroller scrollY">${items}</div></div>`;
    if (options.size) {
        Object.defineProperty(sheet, 'offsetHeight', { value: options.size.height });
        Object.defineProperty(sheet, 'offsetWidth', { value: options.size.width });
    }
    const container = document.createElement('div');
    container.className = 'dialogContainer';
    container.appendChild(sheet);
    document.body.appendChild(container);
    if (!options.fullscreen) {
        sheet.style.position = 'fixed';
        sheet.style.margin = '0';
        sheet.style.left = `${options.left ?? 100}px`;
        sheet.style.top = `${options.top ?? 100}px`;
    }
    return sheet;
}

/** Selects an item as the host does: the click reaches the item, then the sheet closes. */
function selectSheetItem(sheet: HTMLElement, selector: string): void {
    (sheet.querySelector(selector) as HTMLElement).click();
    sheet.closest('.dialogContainer')?.remove();
    sheet.dispatchEvent(new CustomEvent('close', { bubbles: false, cancelable: false }));
}

function flushTasks(): Promise<void> {
    return new Promise((resolve): void => {
        setTimeout(resolve, 0);
    });
}

function savePlacement(settingsButtonPlacement: SettingsButtonPlacement): void {
    saveWebGPUUserSettings({ ...loadWebGPUUserSettings(), osd: { settingsButtonPlacement } });
}

function playEpisodes(currentPlayer: unknown): void {
    testState.currentPlayer = currentPlayer;
    testState.playlist = [
        { Id: 'episode-1', ServerId: 'server', Type: 'Episode', MediaType: 'Video', PlaylistItemId: 'playlistItem0' },
        { Id: 'episode-2', ServerId: 'server', Type: 'Episode', MediaType: 'Video', PlaylistItemId: 'playlistItem1', PartCount: 2 },
        { Id: 'episode-2-part', ServerId: 'server', Type: 'Episode', MediaType: 'Video', PlaylistItemId: 'playlistItem2', PartCount: 2 }
    ];
    testState.playlistIndex = 1;
    testState.currentItem = testState.playlist[1];
    testState.playerState = {
        NowPlayingItem: { RunTimeTicks: 30_000_000_000 },
        PlayState: { AudioStreamIndex: 2, MediaSourceId: 'source-2', PositionTicks: 12_345_678.9, SubtitleStreamIndex: -1 }
    };
}

describe('PlayerSettingsMenu', () => {
    beforeAll(() => {
        expect(installPlayerSettingsMenu(webGPUPlayer)).toBe(true);
        expect(installPlayerSettingsMenu(webGPUPlayer)).toBe(false);
    });

    beforeEach(() => {
        testState.storage.clear();
        testState.toasts = [];
        testState.playRequests = [];
        testState.transparencyLevels = [];
        testState.panelToggles = 0;
        testState.playing = true;
        testState.webGPUPlayable = true;
        playbackManagerMock.syncPlayEnabled = false;
        setClientDefaults({});
        playEpisodes(webGPUPlayer);
    });

    afterEach(() => {
        vi.useRealTimers();
        document.body.innerHTML = '';
        Reflect.deleteProperty(window, 'NativeShell');
    });

    describe('settings sheet items', () => {
        it('extends only a settings sheet that opens after a click on the OSD settings button', async () => {
            const unarmedSheet = openHostSheet();
            await flushTasks();
            expect(unarmedSheet.querySelector(TOGGLE_SELECTOR)).toBeNull();

            clickOsdSettingsButton();
            // Another sheet, such as the audio track menu, is left alone and the wait goes on
            const audioSheet = openHostSheet({ items: createHostItem('1', 'English', null) + createHostItem('2', 'French', null) });
            await flushTasks();
            expect(audioSheet.querySelector(TOGGLE_SELECTOR)).toBeNull();

            const sheet = openHostSheet({ itemClass: `${HOST_ITEM_CLASS} listItem-focusscale` });
            await flushTasks();
            const toggle = sheet.querySelector(TOGGLE_SELECTOR) as HTMLElement;
            expect(toggle.previousElementSibling?.getAttribute('data-id')).toBe('stats');
            expect(toggle.className).toBe(`${HOST_ITEM_CLASS} listItem-focusscale`);
            expect(toggle.getAttribute('is')).toBe('emby-button');
            expect(toggle.querySelector('.listItemBody.actionsheetListItemBody .listItemBodyText.actionSheetItemText')?.textContent)
                .toBe('translated WebGPUPlayerToggle');
            expect(toggle.querySelector('.listItemAside.actionSheetItemAsideText')?.textContent).toBe('translated WebGPUOn');

            // The observer stopped with the first settings sheet
            const laterSheet = openHostSheet();
            await flushTasks();
            expect(laterSheet.querySelector(TOGGLE_SELECTOR)).toBeNull();
        });

        it('stops waiting for the sheet after a bounded time', async () => {
            vi.useFakeTimers({ toFake: [ 'setTimeout', 'clearTimeout' ] });
            clickOsdSettingsButton();
            vi.advanceTimersByTime(10_000);
            vi.useRealTimers();

            const sheet = openHostSheet();
            await flushTasks();
            expect(sheet.querySelector(TOGGLE_SELECTOR)).toBeNull();
        });

        it('lines the items up behind an invisible icon when the host items have icons', async () => {
            const iconItem = `<button is="emby-button" type="button" class="${HOST_ITEM_CLASS}" data-id="stats">`
                + '<span class="actionsheetMenuItemIcon listItemIcon listItemIcon-transparent material-icons check" aria-hidden="true"></span>'
                + '<div class="listItemBody actionsheetListItemBody"><div class="listItemBodyText actionSheetItemText">Playback data</div></div>'
                + '</button>';
            clickOsdSettingsButton();
            const sheet = openHostSheet({ items: iconItem });
            await flushTasks();

            const icon = sheet.querySelector<HTMLElement>(`${TOGGLE_SELECTOR} .actionsheetMenuItemIcon`);
            expect(icon?.style.visibility).toBe('hidden');
        });

        it('shows the toggle off while the user prefers the HTML player', async () => {
            testState.storage.set(PREFERENCE_STORAGE_KEY, 'html');
            playEpisodes(htmlPlayer);
            clickOsdSettingsButton();
            const sheet = openHostSheet();
            await flushTasks();

            expect(sheet.querySelector(`${TOGGLE_SELECTOR} .actionSheetItemAsideText`)?.textContent).toBe('translated Off');
            expect(sheet.querySelector(SETTINGS_SELECTOR)).toBeNull();
        });

        it('offers no toggle in a native app shell, for a remote player, or for audio', async () => {
            Object.assign(window, { NativeShell: {} });
            clickOsdSettingsButton();
            const shellSheet = openHostSheet();
            await flushTasks();
            expect(shellSheet.querySelector(TOGGLE_SELECTOR)).toBeNull();
            Reflect.deleteProperty(window, 'NativeShell');

            testState.currentPlayer = { isLocalPlayer: false, name: 'Chromecast' };
            clickOsdSettingsButton();
            const remoteSheet = openHostSheet();
            await flushTasks();
            expect(remoteSheet.querySelector(TOGGLE_SELECTOR)).toBeNull();

            testState.currentPlayer = htmlPlayer;
            testState.currentItem = { Id: 'song', ServerId: 'server', MediaType: 'Audio' };
            clickOsdSettingsButton();
            const audioSheet = openHostSheet();
            await flushTasks();
            expect(audioSheet.querySelector(TOGGLE_SELECTOR)).toBeNull();
        });

        it('offers WebGPU Settings with the settings menu placement while the WebGPU player is current', async () => {
            clickOsdSettingsButton();
            const buttonPlacementSheet = openHostSheet();
            await flushTasks();
            expect(buttonPlacementSheet.querySelector(SETTINGS_SELECTOR)).toBeNull();

            savePlacement('settings-menu');
            clickOsdSettingsButton();
            const sheet = openHostSheet();
            await flushTasks();
            const settingsItem = sheet.querySelector(SETTINGS_SELECTOR) as HTMLElement;
            expect(settingsItem.previousElementSibling?.matches(TOGGLE_SELECTOR)).toBe(true);
            expect(settingsItem.textContent).toBe('WebGPU Settings');
            expect(settingsItem.querySelector('.actionSheetItemAsideText')).toBeNull();

            // The item runs only once the host has closed the sheet
            settingsItem.click();
            expect(testState.panelToggles).toBe(0);
            sheet.dispatchEvent(new CustomEvent('close', { bubbles: false, cancelable: false }));
            expect(testState.panelToggles).toBe(1);
            expect(testState.storage.has(PREFERENCE_STORAGE_KEY)).toBe(false);

            testState.currentPlayer = htmlPlayer;
            clickOsdSettingsButton();
            const htmlSheet = openHostSheet();
            await flushTasks();
            expect(htmlSheet.querySelector(SETTINGS_SELECTOR)).toBeNull();
        });

        it('runs nothing when the sheet closes on a host item', async () => {
            clickOsdSettingsButton();
            const sheet = openHostSheet();
            await flushTasks();

            selectSheetItem(sheet, '[data-id="stats"]');
            await flushTasks();

            expect(testState.storage.has(PREFERENCE_STORAGE_KEY)).toBe(false);
            expect(testState.toasts).toEqual([]);
        });

        it('keeps a positioned sheet inside the viewport after the items grew it', async () => {
            clickOsdSettingsButton();
            const sheet = openHostSheet({ left: 900, size: { height: 200, width: 200 }, top: 650 });
            await flushTasks();

            // jsdom's viewport is 1024 by 768; the host moves an overflowing sheet 20 pixels clear of the edge
            expect(sheet.style.top).toBe(`${650 - (650 + 200 - 768) - 20}px`);
            expect(sheet.style.left).toBe(`${900 - (900 + 200 - 1024) - 20}px`);

            clickOsdSettingsButton();
            const fittingSheet = openHostSheet({ left: 100, size: { height: 200, width: 200 }, top: 100 });
            await flushTasks();
            expect(fittingSheet.style.top).toBe('100px');
            expect(fittingSheet.style.left).toBe('100px');

            clickOsdSettingsButton();
            const fullscreenSheet = openHostSheet({ fullscreen: true, size: { height: 2000, width: 2000 } });
            await flushTasks();
            expect(fullscreenSheet.querySelector(TOGGLE_SELECTOR)).not.toBeNull();
            expect(fullscreenSheet.style.top).toBe('');
        });

        it('turns the WebGPU player off from the sheet and restarts the video in the HTML player', async () => {
            clickOsdSettingsButton();
            const sheet = openHostSheet();
            await flushTasks();

            selectSheetItem(sheet, TOGGLE_SELECTOR);
            await flushTasks();

            expect(testState.storage.get(PREFERENCE_STORAGE_KEY)).toBe('html');
            expect(testState.playRequests).toHaveLength(1);
            expect(testState.toasts).toEqual([ 'translated WebGPUPlayerTurnedOff translated WebGPUPlayerRestartingPlayback' ]);
        });
    });

    describe('setWebGPUPlayerEnabled', () => {
        it('restarts the queue at the current item, position, media source, and streams', async () => {
            await setWebGPUPlayerEnabled(webGPUPlayer, false);

            expect(testState.playRequests).toEqual([ {
                // Without the part counts PlaybackManager keeps the queued parts instead of fetching them again
                items: [
                    { ...testState.playlist[0], PartCount: undefined },
                    { ...testState.playlist[1], PartCount: undefined },
                    { ...testState.playlist[2], PartCount: undefined }
                ],
                startIndex: 1,
                startPositionTicks: 12_345_678,
                mediaSourceId: 'source-2',
                audioStreamIndex: 2,
                subtitleStreamIndex: -1
            } ]);
            // The host's queue keeps its items
            expect(testState.playlist[1].PartCount).toBe(2);
        });

        it('restarts at one tick at least, so cinema mode does not play the intros again', async () => {
            testState.playerState.PlayState.PositionTicks = 0;

            await setWebGPUPlayerEnabled(webGPUPlayer, false);

            expect(testState.playRequests[0]).toHaveProperty('startPositionTicks', 1);
        });

        it('starts a live channel or a video without a runtime from no position', async () => {
            testState.playlist = [ { Id: 'channel', ServerId: 'server', Type: 'TvChannel', MediaType: 'Video' } ];
            testState.playlistIndex = 0;
            await setWebGPUPlayerEnabled(webGPUPlayer, false);
            expect(testState.playRequests[0]).toEqual({ items: [ { ...testState.playlist[0], PartCount: undefined } ], startIndex: 0 });

            playEpisodes(webGPUPlayer);
            testState.playerState.NowPlayingItem = {};
            await setWebGPUPlayerEnabled(webGPUPlayer, false);
            expect(testState.playRequests[1]).not.toHaveProperty('startPositionTicks');
            expect(testState.playRequests[1]).toMatchObject({ mediaSourceId: 'source-2', startIndex: 1 });
        });

        it('turns the WebGPU player on and restarts a video the HTML player plays', async () => {
            testState.storage.set(PREFERENCE_STORAGE_KEY, 'html');
            playEpisodes(htmlPlayer);

            await setWebGPUPlayerEnabled(webGPUPlayer, true);

            expect(testState.storage.get(PREFERENCE_STORAGE_KEY)).toBe('webgpu');
            expect(testState.playRequests).toHaveLength(1);
            expect(testState.toasts).toEqual([ 'translated WebGPUPlayerTurnedOn translated WebGPUPlayerRestartingPlayback' ]);
        });

        it('makes the OSD transparent again once the restart started the other player, while the OSD still shows', async () => {
            // The old player's teardown inside PlaybackManager.play leaves the page's background opaque
            let finishPlay = (): void => undefined;
            vi.spyOn(playbackManagerMock, 'play').mockImplementation((options: unknown): Promise<void> => {
                testState.playRequests.push(options);
                return new Promise((resolve): void => {
                    finishPlay = resolve;
                });
            });
            const osdPage = createOsdPage();

            const restart = setWebGPUPlayerEnabled(webGPUPlayer, false);
            await flushTasks();
            expect(testState.playRequests).toHaveLength(1);
            expect(testState.transparencyLevels).toEqual([]);
            finishPlay();
            await restart;
            expect(testState.transparencyLevels).toEqual([ 'full' ]);

            // A restart that ends after the user left the OSD leaves the next page's background alone
            osdPage.classList.add('hide');
            const hiddenRestart = setWebGPUPlayerEnabled(webGPUPlayer, false);
            await flushTasks();
            finishPlay();
            await hiddenRestart;
            expect(testState.transparencyLevels).toEqual([ 'full' ]);
        });

        it('only saves when the current video keeps its player', async () => {
            playEpisodes(htmlPlayer);
            await setWebGPUPlayerEnabled(webGPUPlayer, false);
            expect(testState.storage.get(PREFERENCE_STORAGE_KEY)).toBe('html');

            // The WebGPU player declines this video even when it is on
            testState.webGPUPlayable = false;
            await setWebGPUPlayerEnabled(webGPUPlayer, true);
            expect(testState.storage.get(PREFERENCE_STORAGE_KEY)).toBe('webgpu');

            expect(testState.playRequests).toEqual([]);
            expect(testState.toasts).toEqual([
                'translated WebGPUPlayerTurnedOff translated WebGPUPlayerCurrentVideoUnchanged',
                'translated WebGPUPlayerTurnedOn translated WebGPUPlayerCurrentVideoUnchanged'
            ]);
        });

        it('saves for the next playback when restarting is unsafe', async () => {
            const nextPlaybackToast = 'translated WebGPUPlayerTurnedOff translated WebGPUPlayerAppliesNextPlayback';

            playbackManagerMock.syncPlayEnabled = true;
            await setWebGPUPlayerEnabled(webGPUPlayer, false);
            playbackManagerMock.syncPlayEnabled = false;

            testState.playlist = [ { Name: 'Trailer', Url: 'https://example.com/trailer.mp4', MediaType: 'Video' } ];
            testState.playlistIndex = 0;
            await setWebGPUPlayerEnabled(webGPUPlayer, false);

            playEpisodes({ isLocalPlayer: false, name: 'Chromecast' });
            await setWebGPUPlayerEnabled(webGPUPlayer, false);

            playEpisodes(webGPUPlayer);
            testState.playing = false;
            await setWebGPUPlayerEnabled(webGPUPlayer, false);

            expect(testState.storage.get(PREFERENCE_STORAGE_KEY)).toBe('html');
            expect(testState.playRequests).toEqual([]);
            expect(testState.toasts).toEqual([ nextPlaybackToast, nextPlaybackToast, nextPlaybackToast, nextPlaybackToast ]);
        });

        it('stores a choice equal to the server default as following it', async () => {
            setClientDefaults({ preferredVideoPlayer: 'html' });

            await setWebGPUPlayerEnabled(webGPUPlayer, false);

            expect(testState.storage.get(PREFERENCE_STORAGE_KEY)).toBe('');
            expect(preferredVideoPlayer()).toBe('html');
        });
    });
});

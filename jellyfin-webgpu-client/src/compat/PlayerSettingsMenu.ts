import escapeHtml from 'escape-html';

import { setBackdropTransparency, TRANSPARENCY_LEVEL } from 'components/backdrop/backdrop';
import { playbackManager } from 'components/playback/playbackmanager';
import toast from 'components/toast/toast';
import globalize from 'lib/globalize';

import { VideoPlayerPreference } from '../PreferredVideoPlayer';
import { preferredVideoPlayer } from '../shims/userSettings';
import {
    getSettingsButtonPlacement,
    getSettingsPanelName,
    OSD_SETTINGS_ANCHOR_SELECTOR,
    toggleSettingsPanel,
    VIDEO_OSD_PAGE_ID,
    type SettingsEntryPlayer
} from './SettingsEntryPoints';

// The host's player settings menu (components/playback/playersettingsmenu) has no seam for other items.
// A click on the OSD's settings button arms an observer for the action sheet the host then opens, and the add-on appends its items to that sheet.
// The host closes the sheet on any item click and rejects its menu promise for ids it does not know, as for a cancel, so the add-on runs its item once the sheet has closed

/** The player the menu enables and disables, and whose settings panel it opens */
export type PlayerSettingsMenuPlayer = SettingsEntryPlayer & {
    canPlayItem: (item: unknown, playOptions?: unknown) => boolean
};

type SheetItem = Readonly<{
    id: string
    name: string
    asideText: string | null
    run: () => void
}>;

/** A queue item as PlaybackManager keeps it */
type QueueItem = Readonly<Record<string, unknown>>;

type PlayerState = Readonly<{
    NowPlayingItem?: Readonly<{ RunTimeTicks?: unknown }> | null
    PlayState?: Readonly<{
        AudioStreamIndex?: unknown
        MediaSourceId?: unknown
        PositionTicks?: unknown
        SubtitleStreamIndex?: unknown
    }> | null
}>;

/** The options a restart passes to PlaybackManager.play */
type PlayRequest = {
    audioStreamIndex?: number
    items: unknown[]
    mediaSourceId?: string
    startIndex: number
    startPositionTicks?: number
    subtitleStreamIndex?: number
};

/** PlaybackManager members the menu reads; the host assigns most of them in its constructor, outside the type it declares */
type MenuPlaybackManager = {
    currentItem: (player: unknown) => QueueItem | null | undefined
    getCurrentPlayer: () => unknown
    getCurrentPlaylistIndex: (player: unknown) => number
    getPlayerState: (player: unknown) => PlayerState
    getPlaylist: (player: unknown) => Promise<unknown>
    isPlaying: (player: unknown) => boolean
    play: (options: PlayRequest) => Promise<unknown>
    // SyncPlay sets this while it routes PlaybackManager's methods through the group
    syncPlayEnabled?: unknown
};

/** A playback PlaybackManager can start again from where it is */
type RestartablePlayback = Readonly<{
    currentPlayer: unknown
    item: QueueItem
    request: PlayRequest
}>;

const OSD_SETTINGS_BUTTON_SELECTOR = `#${VIDEO_OSD_PAGE_ID} ${OSD_SETTINGS_ANCHOR_SELECTOR}`;
// The class the host's view manager gives a page that does not show
const HIDDEN_PAGE_CLASS = 'hide';
const DIALOG_CONTAINER_CLASS = 'dialogContainer';
const ACTION_SHEET_SELECTOR = '.actionSheet';
const MENU_ITEM_SELECTOR = '.actionSheetMenuItem';
// The OSD always offers playback data, so this item marks the sheet as its settings menu
const SETTINGS_SHEET_ITEM_SELECTOR = `${MENU_ITEM_SELECTOR}[data-id="stats"]`;
const MENU_ITEM_ICON_SELECTOR = '.actionsheetMenuItemIcon';
// The host imports the menu and reads the signed-in user before it opens the sheet
const SETTINGS_SHEET_WAIT_MS = 10_000;
// The host's own bounds for a positioned sheet: at least this far from the top and left edges, this far back from an overflowing edge
const SHEET_MINIMUM_OFFSET_PX = 10;
const SHEET_OVERFLOW_MARGIN_PX = 20;

const TOGGLE_ITEM_ID = 'webgpu-player-toggle';
const SETTINGS_ITEM_ID = 'webgpu-playback-settings';
const VIDEO_MEDIA_TYPE = 'Video';
const LIVE_TV_ITEM_TYPES: readonly unknown[] = [ 'TvChannel', 'LiveTvChannel' ];

let installed = false;
let armedObserver: MutationObserver | null = null;
let armedTimeout: ReturnType<typeof setTimeout> | undefined;

function getPlaybackManager(): MenuPlaybackManager {
    // The bridged instance is the host's, whose constructor-assigned members its declared type lacks
    return playbackManager as unknown as MenuPlaybackManager;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/** Returns whether PlaybackManager marked the player local; remote players report another device's playback. */
function isLocalPlayer(player: unknown): boolean {
    return typeof player === 'object' && player !== null && 'isLocalPlayer' in player && player.isLocalPlayer === true;
}

/** Returns whether a local player plays video, outside a native app shell, which supplies its own players. */
function isLocalVideoPlayback(currentPlayer: unknown): boolean {
    if (window.NativeShell || !isLocalPlayer(currentPlayer)) {
        return false;
    }
    return getPlaybackManager().currentItem(currentPlayer)?.MediaType === VIDEO_MEDIA_TYPE;
}

function joinSentences(statusKey: string, detailKey: string): string {
    return globalize.translate('WebGPUJoinedSentences', globalize.translate(statusKey), globalize.translate(detailKey));
}

/** Adds where the current video is to a restart request: its position, media source, and audio and subtitle streams. */
function addResumePoint(request: PlayRequest, state: PlayerState): void {
    const playState = state.PlayState ?? {};
    const runTimeTicks = state.NowPlayingItem?.RunTimeTicks;
    if (isFiniteNumber(runTimeTicks) && runTimeTicks > 0) {
        // A start position of at least one tick also keeps cinema mode from playing the intros again
        const positionTicks = isFiniteNumber(playState.PositionTicks) ? Math.floor(playState.PositionTicks) : 0;
        request.startPositionTicks = Math.max(1, positionTicks);
    }
    if (typeof playState.MediaSourceId === 'string' && playState.MediaSourceId) {
        request.mediaSourceId = playState.MediaSourceId;
    }
    if (isFiniteNumber(playState.AudioStreamIndex)) {
        request.audioStreamIndex = playState.AudioStreamIndex;
    }
    if (isFiniteNumber(playState.SubtitleStreamIndex)) {
        request.subtitleStreamIndex = playState.SubtitleStreamIndex;
    }
}

/**
 * Returns the current playback as a request that plays it again from where it is, or null when restarting it is unsafe:
 * nothing plays, a remote player or a SyncPlay group plays, or the item is not on a server.
 */
async function getRestartablePlayback(): Promise<RestartablePlayback | null> {
    const host = getPlaybackManager();
    const currentPlayer = host.getCurrentPlayer();
    if (!isLocalPlayer(currentPlayer) || host.syncPlayEnabled === true || !host.isPlaying(currentPlayer)) {
        return null;
    }
    const playlist = await host.getPlaylist(currentPlayer);
    if (!Array.isArray(playlist)) {
        return null;
    }
    const queue: unknown[] = playlist;
    const startIndex = host.getCurrentPlaylistIndex(currentPlayer);
    const item = queue[startIndex];
    if (!item || typeof item !== 'object') {
        return null;
    }
    // PlaybackManager's queue holds item objects
    const queueItem = item as QueueItem;
    if (typeof queueItem.Id !== 'string' || !queueItem.Id || !queueItem.ServerId) {
        return null;
    }

    const request: PlayRequest = {
        // The queue already holds the parts of each multi-part item, which PlaybackManager.play would fetch and queue again
        items: queue.map((entry: unknown): unknown => (
            entry && typeof entry === 'object' ? { ...entry, PartCount: undefined } : entry
        )),
        startIndex
    };
    // A live channel tunes again like a new playback: its media source and streams belong to the live stream it opened
    if (!LIVE_TV_ITEM_TYPES.includes(queueItem.Type)) {
        addResumePoint(request, host.getPlayerState(currentPlayer));
    }
    return { currentPlayer, item: queueItem, request };
}

/**
 * Stores the WebGPU player enablement and, when the current video would now play in the other player, starts it again there.
 * PlaybackManager.play stops and destroys the current player and reports the stop before the next player starts, so no player is swapped while it runs.
 */
export async function setWebGPUPlayerEnabled(player: PlayerSettingsMenuPlayer, enabled: boolean): Promise<void> {
    preferredVideoPlayer(enabled ? VideoPlayerPreference.WEBGPU : VideoPlayerPreference.HTML);
    const statusKey = enabled ? 'WebGPUPlayerTurnedOn' : 'WebGPUPlayerTurnedOff';
    const playback = await getRestartablePlayback();
    if (!playback) {
        toast(joinSentences(statusKey, 'WebGPUPlayerAppliesNextPlayback'));
        return;
    }
    // The WebGPU player comes first in PlaybackManager's selection and declines what it cannot play, which the stored preference now decides
    const playsInWebGPUPlayer = player.canPlayItem(playback.item, playback.request);
    if ((playback.currentPlayer === player) === playsInWebGPUPlayer) {
        toast(joinSentences(statusKey, 'WebGPUPlayerCurrentVideoUnchanged'));
        return;
    }
    toast(joinSentences(statusKey, 'WebGPUPlayerRestartingPlayback'));
    await getPlaybackManager().play(playback.request);
    // The old player's teardown makes the page's background opaque again, which the OSD makes transparent only as it shows; while it still shows, the next player's video would stay hidden
    const osdPage = document.getElementById(VIDEO_OSD_PAGE_ID);
    if (osdPage?.isConnected && !osdPage.classList.contains(HIDDEN_PAGE_CLASS)) {
        setBackdropTransparency(TRANSPARENCY_LEVEL.Full);
    }
}

/** Returns the add-on's items for the settings menu of the current playback. */
function getSheetItems(player: PlayerSettingsMenuPlayer): SheetItem[] {
    const items: SheetItem[] = [];
    const currentPlayer = getPlaybackManager().getCurrentPlayer();
    if (isLocalVideoPlayback(currentPlayer)) {
        const enabled = preferredVideoPlayer() !== VideoPlayerPreference.HTML;
        items.push({
            id: TOGGLE_ITEM_ID,
            name: globalize.translate('WebGPUPlayerToggle'),
            asideText: globalize.translate(enabled ? 'WebGPUOn' : 'Off'),
            run: (): void => {
                setWebGPUPlayerEnabled(player, !enabled).catch((error: unknown): void => {
                    console.error('[WebGPUPlayer] unable to apply the WebGPU player setting', error);
                });
            }
        });
    }
    const panelName = getSettingsPanelName(player);
    if (currentPlayer === player && panelName !== null && getSettingsButtonPlacement() === 'settings-menu') {
        items.push({
            id: SETTINGS_ITEM_ID,
            name: panelName,
            asideText: null,
            run: (): void => {
                toggleSettingsPanel(player);
            }
        });
    }
    return items;
}

/** Builds an item with the host's action sheet markup and the classes of the sheet's own items, which carry its TV and mobile variants. */
function createSheetItemElement(template: Element, item: SheetItem): HTMLElement {
    const container = document.createElement('div');
    // Items line up behind an invisible icon when the sheet's items have icons
    const icon = template.querySelector(MENU_ITEM_ICON_SELECTOR) ?
        '<span class="actionsheetMenuItemIcon listItemIcon listItemIcon-transparent material-icons check" aria-hidden="true" style="visibility:hidden;"></span>' :
        '';
    const aside = item.asideText === null ?
        '' :
        `<div class="listItemAside actionSheetItemAsideText">${escapeHtml(item.asideText)}</div>`;
    container.innerHTML = `<button is="emby-button" type="button" class="${escapeHtml(template.className)}" data-id="${escapeHtml(item.id)}">`
        + icon
        + '<div class="listItemBody actionsheetListItemBody">'
        + `<div class="listItemBodyText actionSheetItemText">${escapeHtml(item.name)}</div>`
        + '</div>'
        + aside
        + '</button>';
    return container.firstElementChild as HTMLElement;
}

/** Moves an offset back inside the viewport when the element overflows it, by the host's margins. */
function getOffsetInViewport(offset: number, size: number, viewportSize: number): number {
    const overflow = offset + size - viewportSize;
    return overflow > 0 ? Math.max(offset - overflow - SHEET_OVERFLOW_MARGIN_PX, SHEET_MINIMUM_OFFSET_PX) : offset;
}

/** Keeps a positioned sheet inside the viewport after the added items grew it; the host places it only when it opens. */
function keepSheetInViewport(sheet: HTMLElement): void {
    // The host positions a sheet that is not fullscreen through fixed left and top styles
    const top = parseFloat(sheet.style.top);
    const left = parseFloat(sheet.style.left);
    if (sheet.style.position !== 'fixed' || !Number.isFinite(top) || !Number.isFinite(left)) {
        return;
    }
    sheet.style.top = `${getOffsetInViewport(top, sheet.offsetHeight, window.innerHeight)}px`;
    sheet.style.left = `${getOffsetInViewport(left, sheet.offsetWidth, window.innerWidth)}px`;
}

/** Appends the add-on's items after the sheet's last item and runs the chosen one once the sheet has closed. */
function extendSettingsSheet(sheet: HTMLElement, player: PlayerSettingsMenuPlayer): void {
    const hostItems = sheet.querySelectorAll(MENU_ITEM_SELECTOR);
    const lastHostItem = hostItems[hostItems.length - 1];
    const items = getSheetItems(player);
    if (!lastHostItem || items.length === 0) {
        return;
    }
    let selectedItem: SheetItem | null = null;
    let previousElement: Element = lastHostItem;
    for (const item of items) {
        const element = createSheetItemElement(lastHostItem, item);
        element.addEventListener('click', (): void => {
            selectedItem = item;
        });
        previousElement.after(element);
        previousElement = element;
    }
    // dialogHelper dispatches close once the sheet is gone and its history entry is undone
    sheet.addEventListener('close', (): void => {
        selectedItem?.run();
    }, { once: true });
    keepSheetInViewport(sheet);
}

function disarm(): void {
    armedObserver?.disconnect();
    armedObserver = null;
    clearTimeout(armedTimeout);
    armedTimeout = undefined;
}

/** Returns the host's settings sheet when the node is the dialog container that holds it. */
function findSettingsSheet(node: Node): HTMLElement | null {
    if (!(node instanceof HTMLElement) || !node.classList.contains(DIALOG_CONTAINER_CLASS)) {
        return null;
    }
    const sheet = node.querySelector<HTMLElement>(ACTION_SHEET_SELECTOR);
    return sheet?.querySelector(SETTINGS_SHEET_ITEM_SELECTOR) ? sheet : null;
}

/** Waits a bounded time for the next settings sheet that dialogHelper adds to the document body. */
function arm(player: PlayerSettingsMenuPlayer): void {
    disarm();
    const observer = new MutationObserver((records: MutationRecord[]): void => {
        for (const record of records) {
            for (const node of Array.from(record.addedNodes)) {
                const sheet = findSettingsSheet(node);
                if (sheet) {
                    disarm();
                    extendSettingsSheet(sheet, player);
                    return;
                }
            }
        }
    });
    observer.observe(document.body, { childList: true });
    armedObserver = observer;
    armedTimeout = setTimeout(disarm, SETTINGS_SHEET_WAIT_MS);
}

/** Adds the add-on's items to the host's player settings menu once per page lifetime. */
export function installPlayerSettingsMenu(player: PlayerSettingsMenuPlayer): boolean {
    if (installed) {
        return false;
    }
    installed = true;
    // Capturing sees the click before the OSD's own handler starts opening the menu
    document.addEventListener('click', (event: MouseEvent): void => {
        if (event.target instanceof Element && event.target.closest(OSD_SETTINGS_BUTTON_SELECTOR)) {
            arm(player);
        }
    }, true);
    return true;
}

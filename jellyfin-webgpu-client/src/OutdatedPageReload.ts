import { playbackManager } from 'components/playback/playbackmanager';
import Events from 'utils/events';

// Reloads a page that loaded an older add-on build than the server serves now, once nothing plays, so an open tab picks up a deploy by itself.
// A build's identity is its entry module path, which webpack names by content hash: the plugin's bootstrap publishes the one this page imported,
// and every catalog response names the server's current one (ServerModules.ts), so noticing a new build costs no request of its own.
// index.html is served no-cache and every other add-on file is content-addressed, so the reload loads the current build, at the same URL

/** How long the page waits after a playback stops, or its request settles, for the queue's next item or another click before it reloads. */
export const OUTDATED_PAGE_RELOAD_GRACE_MILLISECONDS = 10_000;
/** The session storage key of the server entry this tab last reloaded for; a page that loads an older build after that reload never reloads for it again. */
export const RELOADED_ENTRY_STORAGE_KEY = 'webGPUPlayerReloadedForEntry';
const LOG_PREFIX = '[WebGPUPlayer]';
// The first path segment of Jellyfin Web's library pages, which hold no input a reload could lose.
// Every other page never reloads: the dashboard, the plugin and user settings pages, search, the queue, and the player among them
const RELOADABLE_ROUTES: ReadonlySet<string> = new Set([
    'books', 'boxsets', 'details', 'home', 'homevideos', 'list', 'livetv', 'movies', 'music', 'musicvideos', 'tv'
]);
const ROUTE_PATTERN = /^#!?\/?([^/?#]*)/;
// A dialog of the host's dialog helper, or a native one, such as an action sheet or the add-on's settings panel
const OPEN_DIALOG_SELECTOR = '.dialogContainer, dialog[open]';
const EDITABLE_SELECTOR = 'input, select, textarea';

// The entry this page imported, or null when the bootstrap names none, which leaves the reload off
let loadedEntry: string | null = null;
let reloadPage = (): void => {
    window.location.reload();
};
// The server's entry once a catalog names one other than the loaded one; the page then waits for its moment
let serverEntry: string | null = null;
// The playback requests that have not settled.
// A playback start settles every request before it, since a request that returns no promise, as nextTrack does, has no other end
const openRequests = new Set<object>();
let reloadTimer: ReturnType<typeof setTimeout> | null = null;

/** Returns whether the host has a playback open; a check that fails counts as one. */
function isHostPlaying(): boolean {
    try {
        return playbackManager.isPlaying() === true;
    } catch {
        return true;
    }
}

/** Returns whether a reload loses nothing the user is doing: a library page, with no dialog open and no text field focused. */
function isPageReloadable(): boolean {
    if (document.querySelector(OPEN_DIALOG_SELECTOR) !== null) {
        return false;
    }
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && (focused.isContentEditable || focused.matches(EDITABLE_SELECTOR))) {
        return false;
    }
    const route = ROUTE_PATTERN.exec(window.location.hash)?.[1] ?? '';
    return RELOADABLE_ROUTES.has(route.toLowerCase());
}

function cancelReload(): void {
    if (reloadTimer !== null) {
        clearTimeout(reloadTimer);
        reloadTimer = null;
    }
}

/** Waits the grace period again, when the page is outdated and no request is open. */
function scheduleReload(): void {
    if (serverEntry === null) {
        return;
    }
    cancelReload();
    if (openRequests.size === 0) {
        reloadTimer = setTimeout(reloadIfIdle, OUTDATED_PAGE_RELOAD_GRACE_MILLISECONDS);
    }
}

/** Reloads once nothing plays and nothing starts; a page that holds the user's input waits another grace period, and a playback its stop. */
function reloadIfIdle(): void {
    reloadTimer = null;
    const entry = serverEntry;
    if (entry === null || openRequests.size > 0 || isHostPlaying()) {
        return;
    }
    if (!isPageReloadable()) {
        scheduleReload();
        return;
    }
    try {
        sessionStorage.setItem(RELOADED_ENTRY_STORAGE_KEY, entry);
    } catch (error) {
        // Without the guard a stale index.html could reload the tab again and again
        console.warn(`${LOG_PREFIX} the page stays on add-on ${loadedEntry}: the reload guard cannot be stored`, error);
        serverEntry = null;
        return;
    }
    serverEntry = null;
    console.info(`${LOG_PREFIX} reloading for add-on ${entry}, which replaced ${loadedEntry}`);
    reloadPage();
}

function onPlaybackStart(): void {
    openRequests.clear();
    cancelReload();
}

/**
 * Reads the entry this page imported and follows the host's playbacks; call once the host bridge is bound.
 * Without the bootstrap's entry, as on the development server, it installs nothing and the page never reloads.
 */
export function installOutdatedPageReload(reload?: () => void): void {
    const entry = window.WebGPUPlayerConfig?.entry;
    if (loadedEntry !== null || typeof entry !== 'string' || entry === '') {
        return;
    }
    loadedEntry = entry;
    if (reload) {
        reloadPage = reload;
    }
    Events.on(playbackManager, 'playbackstart', onPlaybackStart);
    Events.on(playbackManager, 'playbackstop', scheduleReload);
}

/** Notes a playback request, which holds the reload until it settles or a playback starts; returns the function that settles it. */
export function holdOutdatedPageReload(): () => void {
    if (loadedEntry === null) {
        return (): void => undefined;
    }
    const request = {};
    openRequests.add(request);
    cancelReload();
    return (): void => {
        if (openRequests.delete(request)) {
            scheduleReload();
        }
    };
}

/**
 * Notes the add-on entry a catalog response names: one other than the loaded entry makes the page outdated, and the loaded one current again.
 * A catalog without an entry, or an entry this tab reloaded for already, changes nothing.
 */
export function noteServerAddonEntry(entry: unknown): void {
    if (loadedEntry === null || typeof entry !== 'string' || entry === '' || entry === serverEntry) {
        return;
    }
    if (entry === loadedEntry) {
        serverEntry = null;
        cancelReload();
        return;
    }
    try {
        if (sessionStorage.getItem(RELOADED_ENTRY_STORAGE_KEY) === entry) {
            return;
        }
    } catch {
        return;
    }
    console.info(`${LOG_PREFIX} the server serves add-on ${entry} and this page loaded ${loadedEntry}; the page reloads once nothing plays`);
    serverEntry = entry;
    scheduleReload();
}

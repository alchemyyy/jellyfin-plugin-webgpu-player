import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import Events from 'utils/events';

type OutdatedPageReloadModule = typeof import('addons/webGPUPlayer/OutdatedPageReload');

const testState = vi.hoisted(() => ({
    playing: false,
    playbackManager: {
        isPlaying: (): boolean => testState.playing
    } as { _callbacks?: unknown, isPlaying: () => boolean }
}));

vi.mock('components/playback/playbackmanager', () => ({ playbackManager: testState.playbackManager }));

const ASSET_BASE_URL = '/WebGPUPlayer/assets/';
const LOADED_ENTRY = 'plugin.1111111111111111.js';
const SERVER_ENTRY = 'plugin.2222222222222222.js';
const NEWER_SERVER_ENTRY = 'plugin.3333333333333333.js';

type LoadedReload = OutdatedPageReloadModule & { reload: Mock<() => void> };

/** Loads the module afresh for a page whose bootstrap names an entry, or none, and installs it with a reload the test watches. */
async function loadReload(entry: string | null = LOADED_ENTRY): Promise<LoadedReload> {
    vi.resetModules();
    window.WebGPUPlayerConfig = entry === null ? { assetBaseURL: ASSET_BASE_URL } : { assetBaseURL: ASSET_BASE_URL, entry };
    const reloadModule = await import('addons/webGPUPlayer/OutdatedPageReload');
    const reload = vi.fn<() => void>();
    reloadModule.installOutdatedPageReload(reload);
    return { ...reloadModule, reload };
}

function startPlayback(): void {
    testState.playing = true;
    Events.trigger(testState.playbackManager, 'playbackstart', [ {}, {} ]);
}

function stopPlayback(): void {
    // PlaybackManager triggers the stop before it destroys the player, which still plays then
    Events.trigger(testState.playbackManager, 'playbackstop', [ {} ]);
    testState.playing = false;
}

function waitGracePeriod(reloadModule: OutdatedPageReloadModule): void {
    vi.advanceTimersByTime(reloadModule.OUTDATED_PAGE_RELOAD_GRACE_MILLISECONDS);
}

describe('OutdatedPageReload', () => {
    beforeEach(() => {
        // Before the fake timers, which would hold the hashchange event jsdom queues
        window.location.hash = '#/details?id=1';
        vi.useFakeTimers();
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        delete testState.playbackManager._callbacks;
        testState.playing = false;
        sessionStorage.clear();
        document.body.innerHTML = '';
    });

    afterEach(() => {
        vi.useRealTimers();
        delete window.WebGPUPlayerConfig;
    });

    it('never reloads, and keeps no timer, while the catalog names the loaded entry', async () => {
        const reloadModule = await loadReload();
        startPlayback();

        reloadModule.noteServerAddonEntry(LOADED_ENTRY);
        stopPlayback();

        expect(vi.getTimerCount()).toBe(0);
        waitGracePeriod(reloadModule);
        expect(reloadModule.reload).not.toHaveBeenCalled();
    });

    it('waits out the play request and the playback, then reloads once a grace period after the stop', async () => {
        const reloadModule = await loadReload();
        // The catalog arrives while the request that reads it negotiates
        const endRequest = reloadModule.holdOutdatedPageReload();
        reloadModule.noteServerAddonEntry(SERVER_ENTRY);
        waitGracePeriod(reloadModule);
        startPlayback();
        endRequest();
        waitGracePeriod(reloadModule);
        expect(reloadModule.reload).not.toHaveBeenCalled();

        stopPlayback();
        vi.advanceTimersByTime(reloadModule.OUTDATED_PAGE_RELOAD_GRACE_MILLISECONDS - 1);
        expect(reloadModule.reload).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);

        expect(reloadModule.reload).toHaveBeenCalledOnce();
        expect(sessionStorage.getItem(reloadModule.RELOADED_ENTRY_STORAGE_KEY)).toBe(SERVER_ENTRY);
        expect(window.location.hash).toBe('#/details?id=1');
    });

    it('cancels the reload when a playback or a play request starts within the grace period', async () => {
        const reloadModule = await loadReload();
        startPlayback();
        reloadModule.noteServerAddonEntry(SERVER_ENTRY);

        // The queue's next item
        stopPlayback();
        vi.advanceTimersByTime(reloadModule.OUTDATED_PAGE_RELOAD_GRACE_MILLISECONDS / 2);
        startPlayback();
        waitGracePeriod(reloadModule);
        expect(reloadModule.reload).not.toHaveBeenCalled();

        // Another click, whose request negotiates longer than the grace period
        stopPlayback();
        vi.advanceTimersByTime(reloadModule.OUTDATED_PAGE_RELOAD_GRACE_MILLISECONDS / 2);
        const endRequest = reloadModule.holdOutdatedPageReload();
        waitGracePeriod(reloadModule);
        expect(reloadModule.reload).not.toHaveBeenCalled();

        // A request that starts nothing settles, and the page reloads a grace period later
        endRequest();
        waitGracePeriod(reloadModule);
        expect(reloadModule.reload).toHaveBeenCalledOnce();
    });

    it('holds the reload past a request that never settles, such as nextTrack, until a playback starts and stops', async () => {
        const reloadModule = await loadReload();
        reloadModule.noteServerAddonEntry(SERVER_ENTRY);

        reloadModule.holdOutdatedPageReload();
        waitGracePeriod(reloadModule);
        expect(reloadModule.reload).not.toHaveBeenCalled();

        startPlayback();
        stopPlayback();
        waitGracePeriod(reloadModule);
        expect(reloadModule.reload).toHaveBeenCalledOnce();
    });

    it('never reloads while the host still reports a playback', async () => {
        const reloadModule = await loadReload();
        reloadModule.noteServerAddonEntry(SERVER_ENTRY);
        testState.playing = true;

        waitGracePeriod(reloadModule);

        expect(reloadModule.reload).not.toHaveBeenCalled();
    });

    it('waits while a dialog is open, a text field is focused, or the page is not a library page', async () => {
        const reloadModule = await loadReload();
        const dialog = document.createElement('div');
        dialog.className = 'dialogContainer';
        document.body.append(dialog);

        reloadModule.noteServerAddonEntry(SERVER_ENTRY);
        waitGracePeriod(reloadModule);
        expect(reloadModule.reload).not.toHaveBeenCalled();

        dialog.remove();
        const field = document.createElement('input');
        document.body.append(field);
        field.focus();
        waitGracePeriod(reloadModule);
        expect(reloadModule.reload).not.toHaveBeenCalled();

        field.blur();
        window.location.hash = '#/dashboard';
        waitGracePeriod(reloadModule);
        window.location.hash = '#/configurationpage?name=WebGPUPlayer';
        waitGracePeriod(reloadModule);
        window.location.hash = '#/mypreferencesplayback';
        waitGracePeriod(reloadModule);
        expect(reloadModule.reload).not.toHaveBeenCalled();

        window.location.hash = '#/home';
        waitGracePeriod(reloadModule);
        expect(reloadModule.reload).toHaveBeenCalledOnce();
    });

    it('reloads at most once per server entry in a tab session', async () => {
        sessionStorage.setItem('webGPUPlayerReloadedForEntry', SERVER_ENTRY);
        // The reloaded page got a stale index.html, which loads the old build again
        const reloadModule = await loadReload();

        reloadModule.noteServerAddonEntry(SERVER_ENTRY);
        waitGracePeriod(reloadModule);
        expect(reloadModule.reload).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);

        reloadModule.noteServerAddonEntry(NEWER_SERVER_ENTRY);
        waitGracePeriod(reloadModule);
        reloadModule.noteServerAddonEntry(NEWER_SERVER_ENTRY);
        startPlayback();
        stopPlayback();
        waitGracePeriod(reloadModule);
        expect(reloadModule.reload).toHaveBeenCalledOnce();
    });

    it('stays as it is when the guard cannot be stored', async () => {
        const reloadModule = await loadReload();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('quota', 'QuotaExceededError');
        });

        reloadModule.noteServerAddonEntry(SERVER_ENTRY);
        waitGracePeriod(reloadModule);

        expect(reloadModule.reload).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('ignores a catalog without the entry, and a page whose bootstrap names none', async () => {
        const reloadModule = await loadReload();
        for (const entry of [ undefined, null, '', 7 ]) {
            reloadModule.noteServerAddonEntry(entry);
        }
        waitGracePeriod(reloadModule);
        expect(reloadModule.reload).not.toHaveBeenCalled();

        // The development server's bootstrap names no entry
        const developmentReload = await loadReload(null);
        developmentReload.noteServerAddonEntry(SERVER_ENTRY);
        waitGracePeriod(developmentReload);
        expect(developmentReload.reload).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('is current again when the catalog names the loaded entry once more', async () => {
        const reloadModule = await loadReload();
        reloadModule.noteServerAddonEntry(SERVER_ENTRY);

        reloadModule.noteServerAddonEntry(LOADED_ENTRY);
        waitGracePeriod(reloadModule);

        expect(reloadModule.reload).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});

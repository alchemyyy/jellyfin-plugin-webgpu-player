import { VIDEO_OSD_PAGE_ID } from './SettingsEntryPoints';

// The host toggles fullscreen on a double click of the OSD page itself, and the browser's default for that click's second press selects the nearest word, the OSD title's first.
// Text the double click lands on, such as a subtitle cue, is selected the same way.

const VIDEO_PLAYER_CONTAINER_SELECTOR = '.videoPlayerContainer';

let installed = false;

/** Returns whether a press lands on the playback surface: the OSD page's own background, or the player's container beneath it. */
function isPlaybackSurface(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) {
        return false;
    }
    return target.id === VIDEO_OSD_PAGE_ID || target.closest(VIDEO_PLAYER_CONTAINER_SELECTOR) !== null;
}

function onMouseDown(event: MouseEvent): void {
    // The first press of a double click keeps its default, so a single click still moves focus
    if (event.detail > 1 && isPlaybackSurface(event.target)) {
        event.preventDefault();
    }
}

/** Keeps a double click on the playback surface from selecting text; installs once per page. */
export function installOsdDoubleClickSelectionGuard(): void {
    if (installed) {
        return;
    }
    installed = true;
    document.addEventListener('mousedown', onMouseDown, { capture: true });
}

import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('addons/webGPUPlayer/compat/SettingsEntryPoints', () => ({
    // eslint-disable-next-line @typescript-eslint/naming-convention -- the module's export name
    VIDEO_OSD_PAGE_ID: 'videoOsdPage'
}));

import { installOsdDoubleClickSelectionGuard } from 'addons/webGPUPlayer/compat/OsdDoubleClickSelection';

function press(target: Element, detail: number): boolean {
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail });
    target.dispatchEvent(event);
    return event.defaultPrevented;
}

describe('installOsdDoubleClickSelectionGuard', () => {
    beforeAll(() => {
        document.body.innerHTML = '<div class="videoPlayerContainer"><div class="videoSubtitles"><span id="cue">Cue</span></div></div>'
            + '<div id="videoOsdPage"><p id="title">Frieren</p></div>';
        installOsdDoubleClickSelectionGuard();
        installOsdDoubleClickSelectionGuard();
    });

    it('cancels the selecting second press on the OSD page background and the player surface', () => {
        expect(press(document.getElementById('videoOsdPage')!, 2)).toBe(true);
        expect(press(document.getElementById('cue')!, 2)).toBe(true);
        expect(press(document.getElementById('videoOsdPage')!, 3)).toBe(true);
    });

    it('keeps single presses and double clicks on OSD content', () => {
        expect(press(document.getElementById('videoOsdPage')!, 1)).toBe(false);
        expect(press(document.getElementById('title')!, 2)).toBe(false);
    });
});

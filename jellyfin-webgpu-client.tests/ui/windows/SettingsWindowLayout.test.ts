import { describe, expect, it } from 'vitest';

import {
    anchorToNearestSides,
    isInside,
    layoutSettingsWindows,
    overlaps,
    resolveAnchoredPosition,
    type LayoutPlacement,
    type LayoutRect,
    type LayoutWindow,
    type SettingsWindowLayoutInput
} from 'addons/webGPUPlayer/ui/windows/SettingsWindowLayout';

const GAP = 8;
const ROOM: LayoutRect = { height: 800, width: 1600, x: 10, y: 60 };

function createWindow(id: string, overrides: Partial<LayoutWindow> = {}): LayoutWindow {
    const height = overrides.height ?? 300;
    return {
        desired: null,
        height,
        id,
        minimumHeight: 120,
        minimumWidth: 220,
        pinned: false,
        // A window that does not collapse reserves its whole height
        slotHeight: height,
        width: 320,
        ...overrides
    };
}

function layout(windows: readonly LayoutWindow[], bounds: LayoutRect = ROOM, direction: 'ltr' | 'rtl' = 'ltr'): Map<string, LayoutPlacement> {
    const input: SettingsWindowLayoutInput = { bounds, direction, gap: GAP, windows };
    return layoutSettingsWindows(input);
}

function getRect(placements: Map<string, LayoutPlacement>, id: string): LayoutRect {
    const placement = placements.get(id);
    if (!placement) {
        throw new Error(`no placement for ${id}`);
    }
    return placement.rect;
}

/** Every window the layout did not stack lies inside the room, apart from every other one it did not stack. */
function expectTidy(placements: Map<string, LayoutPlacement>, bounds: LayoutRect): void {
    const placed = [ ...placements.entries() ].filter(([ , placement ]) => placement.kind !== 'stacked');
    for (const [ id, placement ] of placed) {
        expect(isInside(placement.rect, bounds), `${id} inside the room`).toBe(true);
        for (const [ otherId, other ] of placed) {
            if (otherId !== id) {
                expect(overlaps(placement.rect, other.rect, 0), `${id} apart from ${otherId}`).toBe(false);
            }
        }
    }
}

describe('layoutSettingsWindows', () => {
    it('keeps every window where the user put it while the room holds them all', () => {
        const placements = layout([
            createWindow('master', { desired: { x: 10, y: 60 }, pinned: true }),
            createWindow('picture', { desired: { x: 400, y: 60 } }),
            createWindow('audio', { desired: { x: 1200, y: 500 } })
        ]);

        expect(getRect(placements, 'picture')).toEqual({ height: 300, width: 320, x: 400, y: 60 });
        expect(getRect(placements, 'audio')).toEqual({ height: 300, width: 320, x: 1200, y: 500 });
        expect([ ...placements.values() ].every(placement => placement.kind === 'kept')).toBe(true);
    });

    it('lets the user put windows edge to edge', () => {
        const placements = layout([
            createWindow('picture', { desired: { x: 10, y: 60 } }),
            createWindow('audio', { desired: { x: 330, y: 60 } })
        ]);

        expect(placements.get('audio')?.kind).toBe('kept');
    });

    it('moves a window that left the room to the nearest free place inside it', () => {
        const bounds: LayoutRect = { height: 500, width: 900, x: 10, y: 60 };
        const placements = layout([
            createWindow('master', { desired: { x: 10, y: 60 }, pinned: true }),
            // Put at the right of a wider player, so now past the room's right edge
            createWindow('audio', { desired: { x: 1200, y: 100 } })
        ], bounds);

        expect(placements.get('audio')).toEqual({ kind: 'moved', rect: { height: 300, width: 320, x: 590, y: 100 } });
        expectTidy(placements, bounds);
    });

    it('moves the later of two overlapping windows beside the earlier, which keeps its place', () => {
        const placements = layout([
            createWindow('picture', { desired: { x: 400, y: 100 } }),
            createWindow('audio', { desired: { x: 420, y: 120 } })
        ]);

        expect(placements.get('picture')?.kind).toBe('kept');
        const audio = placements.get('audio');
        expect(audio?.kind).toBe('moved');
        expect(overlaps(getRect(placements, 'picture'), getRect(placements, 'audio'), GAP)).toBe(false);
        // Below picture, a gap away, is nearer the wished corner than beside it
        expect(audio?.rect).toEqual({ height: 300, width: 320, x: 420, y: 100 + 300 + GAP });
    });

    it('never puts a window over the pinned master window', () => {
        const placements = layout([
            createWindow('master', { desired: { x: 10, y: 60 }, height: 600, pinned: true }),
            createWindow('picture', { desired: { x: 100, y: 100 } })
        ]);

        expect(overlaps(getRect(placements, 'master'), getRect(placements, 'picture'), 0)).toBe(false);
        expect(placements.get('master')?.rect).toEqual({ height: 600, width: 320, x: 10, y: 60 });
    });

    it('flows windows without a place in reading order: along the top row, then below', () => {
        const bounds: LayoutRect = { height: 800, width: 1000, x: 0, y: 0 };
        const placements = layout([
            createWindow('master', { desired: { x: 0, y: 0 }, pinned: true }),
            createWindow('picture', { height: 40 }),
            createWindow('pipeline', { height: 40 }),
            createWindow('audio', { height: 40 })
        ], bounds);

        expect(getRect(placements, 'picture')).toMatchObject({ x: 320 + GAP, y: 0 });
        expect(getRect(placements, 'pipeline')).toMatchObject({ x: 2 * (320 + GAP), y: 0 });
        // The top row is full, so the next goes below the first window it fits under
        expect(getRect(placements, 'audio')).toMatchObject({ x: 320 + GAP, y: 40 + GAP });
        expectTidy(placements, bounds);
    });

    it('keeps windows without a place in their columns and order as they expand and collapse', () => {
        const bounds: LayoutRect = { height: 800, width: 1000, x: 0, y: 0 };
        // Section windows reserve their 40 pixel title bars as slots, whatever their content
        const lay = (pictureHeight: number): Map<string, LayoutPlacement> => layout([
            createWindow('master', { desired: { x: 0, y: 0 }, height: 500, pinned: true }),
            createWindow('picture', { height: pictureHeight, slotHeight: 40 }),
            createWindow('pipeline', { height: 40, slotHeight: 40 }),
            createWindow('audio', { height: 40, slotHeight: 40 }),
            createWindow('interface', { height: 40, slotHeight: 40 })
        ], bounds);

        const collapsed = lay(40);
        expect(getRect(collapsed, 'audio')).toMatchObject({ x: 320 + GAP, y: 40 + GAP });
        expect(getRect(collapsed, 'interface')).toMatchObject({ x: 2 * (320 + GAP), y: 40 + GAP });

        // Picture grows down its column and pushes audio below it; interface keeps its slot under pipeline
        const expanded = lay(400);
        expect(getRect(expanded, 'audio')).toMatchObject({ x: 320 + GAP, y: 400 + GAP });
        expect(getRect(expanded, 'interface')).toMatchObject({ x: 2 * (320 + GAP), y: 40 + GAP });
        expectTidy(expanded, bounds);

        expect(lay(40)).toEqual(collapsed);
    });

    it('moves a window its column no longer holds to the free place nearest its slot', () => {
        const bounds: LayoutRect = { height: 800, width: 1000, x: 0, y: 0 };
        const placements = layout([
            createWindow('master', { desired: { x: 0, y: 0 }, height: 500, pinned: true }),
            createWindow('picture', { height: 780, slotHeight: 40 }),
            createWindow('pipeline', { height: 40, slotHeight: 40 }),
            createWindow('audio', { height: 40, slotHeight: 40 })
        ], bounds);

        // Below picture there is no room, and under pipeline is nearer than under the master
        expect(placements.get('audio')).toEqual({ kind: 'moved', rect: { height: 40, width: 320, x: 2 * (320 + GAP), y: 40 + GAP } });
        expectTidy(placements, bounds);
    });

    it('shrinks a window into the room left in its column rather than moving it, while its minimum height fits', () => {
        const bounds: LayoutRect = { height: 800, width: 1000, x: 0, y: 0 };
        const placements = layout([
            createWindow('master', { desired: { x: 0, y: 0 }, height: 500, pinned: true }),
            createWindow('picture', { height: 600, slotHeight: 40 }),
            createWindow('pipeline', { height: 40, slotHeight: 40 }),
            createWindow('audio', { height: 300, minimumHeight: 120, slotHeight: 40 })
        ], bounds);

        expect(placements.get('audio')).toEqual({ kind: 'shrunk', rect: { height: 800 - 600 - GAP, width: 320, x: 320 + GAP, y: 600 + GAP } });
        expectTidy(placements, bounds);
    });

    it('flows from the right on a right-to-left page', () => {
        const bounds: LayoutRect = { height: 800, width: 1000, x: 0, y: 0 };
        const placements = layout([
            createWindow('master', { desired: { x: 680, y: 0 }, pinned: true }),
            createWindow('picture', { height: 40 })
        ], bounds, 'rtl');

        expect(getRect(placements, 'picture')).toMatchObject({ x: 680 - GAP - 320, y: 0 });
    });

    it('clamps a pinned window into the room and limits it to the room\'s height', () => {
        const bounds: LayoutRect = { height: 400, width: 600, x: 0, y: 50 };
        const placements = layout([
            createWindow('master', { desired: { x: -40, y: 0 }, height: 700, pinned: true })
        ], bounds);

        expect(placements.get('master')).toEqual({ kind: 'kept', rect: { height: 400, width: 320, x: 0, y: 50 } });
    });

    it('shrinks a window into the largest free room when no place holds it whole', () => {
        const bounds: LayoutRect = { height: 500, width: 700, x: 0, y: 0 };
        const placements = layout([
            createWindow('master', { desired: { x: 0, y: 0 }, height: 500, pinned: true }),
            createWindow('picture', { desired: { x: 340, y: 0 }, height: 300 }),
            createWindow('audio', { height: 400, minimumHeight: 100 })
        ], bounds);

        const audio = placements.get('audio');
        expect(audio?.kind).toBe('shrunk');
        expect(audio?.rect.height).toBe(500 - 300 - GAP);
        expect(audio?.rect.height).toBeGreaterThanOrEqual(100);
        expectTidy(placements, bounds);
    });

    it('narrows windows to a room narrower than they are', () => {
        const bounds: LayoutRect = { height: 900, width: 260, x: 0, y: 0 };
        const placements = layout([ createWindow('picture', { desired: null, width: 400 }) ], bounds);

        expect(getRect(placements, 'picture').width).toBe(260);
        expectTidy(placements, bounds);
    });

    it('stacks a window where it covers the least of the others, keeping off the pinned window', () => {
        const bounds: LayoutRect = { height: 300, width: 700, x: 0, y: 0 };
        const placements = layout([
            createWindow('master', { desired: { x: 0, y: 0 }, height: 300, pinned: true }),
            createWindow('picture', { desired: { x: 340, y: 0 }, height: 300 }),
            // Like the host's playback info, which neither shrinks nor scrolls
            createWindow('playbackInfo', { height: 280, minimumHeight: 280, minimumWidth: 320 })
        ], bounds);

        const playbackInfo = placements.get('playbackInfo');
        expect(playbackInfo?.kind).toBe('stacked');
        expect(playbackInfo?.rect).toMatchObject({ height: 280, x: 380 });
        expect(overlaps(getRect(placements, 'master'), getRect(placements, 'playbackInfo'), 0)).toBe(false);
    });

    it('stacks a window that no free room holds, at its minimum height, inside the room', () => {
        const bounds: LayoutRect = { height: 300, width: 330, x: 0, y: 0 };
        const placements = layout([
            createWindow('master', { desired: { x: 0, y: 0 }, height: 300, pinned: true }),
            createWindow('audio', { desired: { x: 200, y: 200 }, minimumHeight: 120 })
        ], bounds);

        const audio = placements.get('audio');
        expect(audio?.kind).toBe('stacked');
        expect(audio?.rect.height).toBe(120);
        expect(isInside(audio?.rect ?? bounds, bounds)).toBe(true);
    });

    it('keeps every unstacked window inside the room and apart as the room shrinks', () => {
        const windows = [
            createWindow('master', { desired: { x: 10, y: 60 }, height: 520, pinned: true }),
            createWindow('picture', { desired: { x: 400, y: 60 }, height: 640 }),
            createWindow('pipeline', { desired: { x: 800, y: 60 }, height: 420, width: 460 }),
            createWindow('audio', { desired: { x: 1200, y: 300 }, height: 380 }),
            createWindow('interface', { height: 44, minimumHeight: 44 })
        ];
        for (const width of [ 1600, 1280, 1024, 800, 640 ]) {
            for (const height of [ 800, 600, 420 ]) {
                const bounds: LayoutRect = { height, width, x: 10, y: 60 };
                expectTidy(layout(windows, bounds), bounds);
            }
        }
    });
});

describe('anchored positions', () => {
    it('anchors a window to the nearer side on each axis and resolves it back in the same room', () => {
        const rect: LayoutRect = { height: 300, width: 320, x: 1200, y: 600 };
        const position = anchorToNearestSides(rect, ROOM);

        expect(position).toEqual({ horizontal: 'right', vertical: 'bottom', x: 90, y: 260 });
        expect(resolveAnchoredPosition(position, ROOM, rect.width)).toEqual({ x: 1200, y: 600 });
    });

    it('anchors a window near the top left corner to the left and top', () => {
        expect(anchorToNearestSides({ height: 300, width: 320, x: 40, y: 100 }, ROOM))
            .toEqual({ horizontal: 'left', vertical: 'top', x: 30, y: 40 });
    });

    it('follows the anchored sides when the room resizes, keeping the title bar\'s distance from the bottom', () => {
        const position = anchorToNearestSides({ height: 300, width: 320, x: 1200, y: 600 }, ROOM);
        const smallerRoom: LayoutRect = { height: 500, width: 1000, x: 10, y: 60 };

        expect(resolveAnchoredPosition(position, smallerRoom, 320)).toEqual({ x: 10 + 1000 - 90 - 320, y: 60 + 500 - 260 });
    });
});

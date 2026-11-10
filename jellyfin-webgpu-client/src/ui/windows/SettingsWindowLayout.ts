// Where each shown settings window goes within the room the player leaves them, as a pure function of their sizes and the places the user gave them.
// A window keeps its place while it fits there; one that leaves the room, or overlaps a window placed before it, moves to the nearest free place.
// A window without a place keeps its reading-order slot, below the windows above it in its column, so expanding and collapsing windows does not reorder them.
// Without a free place at its size a window shrinks into the largest free room (smooshing), and as a last resort it stacks over the others, inside the room

/** A rectangle in viewport pixels, its corner at the top left. */
export type LayoutRect = Readonly<{
    height: number
    width: number
    x: number
    y: number
}>;

export type LayoutPoint = Readonly<{
    x: number
    y: number
}>;

export type LayoutWindow = Readonly<{
    /** Where the window's top left corner goes, or null to place it in reading order at the first free place */
    desired: LayoutPoint | null
    /** The window's height with nothing constrained: its title bar, and its content unless collapsed */
    height: number
    id: string
    /** The height below which the window stacks rather than shrinks */
    minimumHeight: number
    /** The width below which the window stacks rather than shrinks */
    minimumWidth: number
    /** A pinned window takes its desired place, clamped into the room, before any other */
    pinned: boolean
    /** The height a window without a place reserves for its reading-order slot: its title bar for a window that collapses, else its height */
    slotHeight: number
    width: number
}>;

export type LayoutDirection = 'ltr' | 'rtl';

export type SettingsWindowLayoutInput = Readonly<{
    /** The room the windows share */
    bounds: LayoutRect
    /** Reading order: from the left in 'ltr', from the right in 'rtl' */
    direction: LayoutDirection
    /** The space a moved window keeps from its neighbors */
    gap: number
    /** In priority order: a window keeps its place over every window after it; windows without a place take their slots after every window with one */
    windows: readonly LayoutWindow[]
}>;

/**
 * - 'kept': at the place the user gave it, or a pinned window at its own.
 * - 'moved': at the nearest free place, at its full size.
 * - 'shrunk': at a free place, narrower or shorter than its full size.
 * - 'stacked': over other windows, since no free room holds it.
 */
export type LayoutPlacementKind = 'kept' | 'moved' | 'shrunk' | 'stacked';

export type LayoutPlacement = Readonly<{
    kind: LayoutPlacementKind
    rect: LayoutRect
}>;

/**
 * Where the user put a window, as its distance from the room's nearer side on each axis, so the window follows that side as the room resizes.
 * Horizontally: from the room's left edge to the window's, or from the window's right edge to the room's.
 * Vertically: from the room's top or bottom edge to the window's top edge, where its title bar is, so expanding the window grows it downward.
 */
export type AnchoredPosition = Readonly<{
    horizontal: 'left' | 'right'
    vertical: 'bottom' | 'top'
    x: number
    y: number
}>;

/** The windows placed so far, which a stacked window covers as little of as it can. */
type StackingObstacles = {
    /** The pinned windows among the placed ones */
    readonly pinned: LayoutRect[]
    readonly placed: LayoutRect[]
    readonly stacked: LayoutRect[]
};

// Measured sizes are fractional, so edges this close count as touching
const EPSILON = 0.5;
// Covering the pinned window, which holds the settings every other window is reached from, costs this many times covering another
const PINNED_OVERLAP_WEIGHT = 8;

function getRight(rect: LayoutRect): number {
    return rect.x + rect.width;
}

function getBottom(rect: LayoutRect): number {
    return rect.y + rect.height;
}

/** Clamps a value into a range; a range whose maximum is below its minimum clamps to the minimum. */
function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

/** Whether a rectangle lies within the room. */
export function isInside(rect: LayoutRect, bounds: LayoutRect): boolean {
    return rect.x >= bounds.x - EPSILON
        && rect.y >= bounds.y - EPSILON
        && getRight(rect) <= getRight(bounds) + EPSILON
        && getBottom(rect) <= getBottom(bounds) + EPSILON;
}

/** Whether two rectangles come closer than the gap; with no gap, rectangles that only touch do not overlap. */
export function overlaps(first: LayoutRect, second: LayoutRect, gap: number): boolean {
    return first.x < getRight(second) + gap - EPSILON
        && second.x < getRight(first) + gap - EPSILON
        && first.y < getBottom(second) + gap - EPSILON
        && second.y < getBottom(first) + gap - EPSILON;
}

function overlapsAny(rect: LayoutRect, placed: readonly LayoutRect[], gap: number): boolean {
    return placed.some((other: LayoutRect): boolean => overlaps(rect, other, gap));
}

/** Moves a rectangle's corner so the rectangle lies within the room, as far as its size allows. */
function clampIntoBounds(rect: LayoutRect, bounds: LayoutRect): LayoutRect {
    return {
        height: rect.height,
        width: rect.width,
        x: clamp(rect.x, bounds.x, getRight(bounds) - rect.width),
        y: clamp(rect.y, bounds.y, getBottom(bounds) - rect.height)
    };
}

/** The offsets worth trying along one axis: the room's edges, both sides of every placed window, and the wished offset, each inside the room. */
function getCandidateOffsets(size: number, start: number, end: number, placedSpans: ReadonlyArray<readonly [ number, number ]>, gap: number, wished: number | null): number[] {
    const offsets = new Set<number>([ start, end - size ]);
    for (const [ placedStart, placedEnd ] of placedSpans) {
        offsets.add(placedEnd + gap);
        offsets.add(placedStart - gap - size);
    }
    if (wished !== null) {
        offsets.add(clamp(wished, start, end - size));
    }
    return [ ...offsets ].filter((offset: number): boolean => offset >= start - EPSILON && offset + size <= end + EPSILON);
}

/** The corners worth trying for a rectangle of the size: every pair of candidate offsets, free or not. */
function getCandidateCorners(input: SettingsWindowLayoutInput, anchor: LayoutPoint | null, placed: readonly LayoutRect[], width: number, height: number): LayoutPoint[] {
    const { bounds, gap } = input;
    const xs = getCandidateOffsets(width, bounds.x, getRight(bounds), placed.map((rect: LayoutRect): [ number, number ] => [ rect.x, getRight(rect) ]), gap, anchor?.x ?? null);
    const ys = getCandidateOffsets(height, bounds.y, getBottom(bounds), placed.map((rect: LayoutRect): [ number, number ] => [ rect.y, getBottom(rect) ]), gap, anchor?.y ?? null);
    const corners: LayoutPoint[] = [];
    for (const x of xs) {
        for (const y of ys) {
            corners.push({ x, y });
        }
    }
    return corners;
}

/** How far a corner is from where its window wants to be: the distance to its anchor, its desired corner or its slot, or its reading order without one. */
function createDistance(input: SettingsWindowLayoutInput, anchor: LayoutPoint | null): (rect: LayoutRect) => number {
    const { bounds, direction } = input;
    if (anchor !== null) {
        return (rect: LayoutRect): number => Math.hypot(rect.x - anchor.x, rect.y - anchor.y);
    }
    // The topmost row first, then the start side: a row weighs more than any distance along it
    const rowWeight = 2 * (bounds.width + 1);
    return (rect: LayoutRect): number => {
        const along = direction === 'rtl' ? getRight(bounds) - getRight(rect) : rect.x - bounds.x;
        return (rect.y - bounds.y) * rowWeight + along;
    };
}

/** The free place nearest the anchor, or first in reading order without one, for a rectangle of the size, or null when none is free. */
function findFreeRect(input: SettingsWindowLayoutInput, anchor: LayoutPoint | null, placed: readonly LayoutRect[], width: number, height: number): LayoutRect | null {
    const distance = createDistance(input, anchor);
    let best: LayoutRect | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const corner of getCandidateCorners(input, anchor, placed, width, height)) {
        const rect: LayoutRect = { height, width, ...corner };
        const candidateDistance = distance(rect);
        if (candidateDistance < bestDistance && !overlapsAny(rect, placed, input.gap)) {
            best = rect;
            bestDistance = candidateDistance;
        }
    }
    return best;
}

/**
 * The reading-order slot of each window without a place, at its slot height: a window that collapses reserves its title bar,
 * so the slots, and the order of the windows in each column, stay as the windows expand and collapse.
 */
function findSlots(input: SettingsWindowLayoutInput, windows: readonly LayoutWindow[], placed: readonly LayoutRect[]): Map<string, LayoutRect> {
    const { bounds } = input;
    const slots = new Map<string, LayoutRect>();
    const taken = [ ...placed ];
    for (const layoutWindow of windows) {
        const width = clamp(layoutWindow.width, Math.min(layoutWindow.minimumWidth, bounds.width), bounds.width);
        const slot = findFreeRect(input, null, taken, width, Math.min(layoutWindow.slotHeight, bounds.height));
        if (slot) {
            slots.set(layoutWindow.id, slot);
            taken.push(slot);
        }
    }
    return slots;
}

/** The top of a window at its slot: below each window that starts above it in its column. */
function getSlotTop(input: SettingsWindowLayoutInput, slot: LayoutPoint, placed: readonly LayoutRect[], width: number): number {
    const { gap } = input;
    let y = slot.y;
    let pushed = true;
    while (pushed) {
        pushed = false;
        for (const rect of placed) {
            const sharesColumn = slot.x < getRight(rect) + gap - EPSILON && rect.x < slot.x + width + gap - EPSILON;
            if (sharesColumn && rect.y <= y + EPSILON && getBottom(rect) + gap > y + EPSILON) {
                y = getBottom(rect) + gap;
                pushed = true;
            }
        }
    }
    return y;
}

/**
 * A window in its column at its slot: whole when the room below holds it, else shrunk to that room, at least its minimum height, so it keeps its order;
 * null when not even its minimum height fits.
 */
function placeInSlot(input: SettingsWindowLayoutInput, layoutWindow: LayoutWindow, slot: LayoutPoint, placed: readonly LayoutRect[], width: number, height: number): LayoutPlacement | null {
    const { bounds, gap } = input;
    const corner: LayoutPoint = { x: slot.x, y: getSlotTop(input, slot, placed, width) };
    const fittedHeight = Math.min(height, getFreeHeightBelow(corner, width, bounds, placed, gap));
    if (fittedHeight < Math.min(layoutWindow.minimumHeight, height) - EPSILON) {
        return null;
    }
    const rect: LayoutRect = { height: fittedHeight, width, ...corner };
    if (!isInside(rect, bounds) || overlapsAny(rect, placed, gap)) {
        return null;
    }
    return { kind: fittedHeight >= layoutWindow.height - EPSILON ? 'moved' : 'shrunk', rect };
}

/** The height free below a corner, in a column of the width: down to the room's bottom, or to the first window below it. */
function getFreeHeightBelow(corner: LayoutPoint, width: number, bounds: LayoutRect, placed: readonly LayoutRect[], gap: number): number {
    let limit = getBottom(bounds);
    for (const rect of placed) {
        const sharesColumn = corner.x < getRight(rect) + gap - EPSILON && rect.x < corner.x + width + gap - EPSILON;
        if (sharesColumn && rect.y >= corner.y - EPSILON) {
            limit = Math.min(limit, rect.y - gap);
        }
    }
    return limit - corner.y;
}

/** The free place with the most room for the window shrunk to fit it, at least its minimum height, or null when none is free; the nearest of equal rooms wins. */
function findShrunkRect(input: SettingsWindowLayoutInput, layoutWindow: LayoutWindow, anchor: LayoutPoint | null, placed: readonly LayoutRect[], width: number): LayoutRect | null {
    const minimumHeight = Math.min(layoutWindow.minimumHeight, layoutWindow.height);
    const distance = createDistance(input, anchor);
    let best: LayoutRect | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const corner of getCandidateCorners(input, anchor, placed, width, minimumHeight)) {
        if (overlapsAny({ height: minimumHeight, width, ...corner }, placed, input.gap)) {
            continue;
        }
        const height = Math.min(layoutWindow.height, getFreeHeightBelow(corner, width, input.bounds, placed, input.gap));
        const rect: LayoutRect = { height, width, ...corner };
        const candidateDistance = distance(rect);
        const roomier = best === null || height > best.height + EPSILON;
        const nearerOfEqual = best !== null && Math.abs(height - best.height) <= EPSILON && candidateDistance < bestDistance;
        if (height >= minimumHeight - EPSILON && (roomier || nearerOfEqual)) {
            best = rect;
            bestDistance = candidateDistance;
        }
    }
    return best;
}

/** Returns the area two rectangles share. */
function getOverlapArea(first: LayoutRect, second: LayoutRect): number {
    const width = Math.min(getRight(first), getRight(second)) - Math.max(first.x, second.x);
    const height = Math.min(getBottom(first), getBottom(second)) - Math.max(first.y, second.y);
    return width > 0 && height > 0 ? width * height : 0;
}

/**
 * Where a window no free room holds goes: the place inside the room where it covers the least of the windows before it,
 * covering a pinned window weighing more than covering any other, and the place nearest its anchor among equal ones.
 */
function getStackedRect(input: SettingsWindowLayoutInput, anchor: LayoutPoint | null, occupied: StackingObstacles, width: number, height: number): LayoutRect {
    const { bounds } = input;
    const distance = createDistance(input, anchor);
    const corners = [
        ...getCandidateCorners(input, anchor, [ ...occupied.placed, ...occupied.stacked ], width, height),
        anchor ?? { x: bounds.x, y: bounds.y }
    ];
    let best: LayoutRect | null = null;
    let bestCost = Number.POSITIVE_INFINITY;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const corner of corners) {
        const rect = clampIntoBounds({ height, width, x: corner.x, y: corner.y }, bounds);
        let cost = 0;
        for (const other of occupied.placed) {
            cost += getOverlapArea(rect, other);
        }
        for (const other of occupied.stacked) {
            cost += getOverlapArea(rect, other);
        }
        for (const other of occupied.pinned) {
            cost += PINNED_OVERLAP_WEIGHT * getOverlapArea(rect, other);
        }
        const candidateDistance = distance(rect);
        if (best === null || cost < bestCost - EPSILON || (Math.abs(cost - bestCost) <= EPSILON && candidateDistance < bestDistance)) {
            best = rect;
            bestCost = cost;
            bestDistance = candidateDistance;
        }
    }
    return best ?? clampIntoBounds({ height, width, x: bounds.x, y: bounds.y }, bounds);
}

/**
 * Places one window: pinned or kept, else in its slot's column, whole or shrunk, else moved, else shrunk, else stacked.
 * A window its column no longer holds looks for free room nearest its slot, so it stays near its column.
 */
function placeWindow(input: SettingsWindowLayoutInput, layoutWindow: LayoutWindow, occupied: StackingObstacles, slot: LayoutRect | null): LayoutPlacement {
    const { bounds } = input;
    const { placed } = occupied;
    const width = clamp(layoutWindow.width, Math.min(layoutWindow.minimumWidth, bounds.width), bounds.width);
    const height = Math.min(layoutWindow.height, bounds.height);
    const fullHeight = height >= layoutWindow.height;
    const anchor: LayoutPoint | null = layoutWindow.desired ?? slot;
    if (layoutWindow.pinned) {
        const corner = layoutWindow.desired ?? { x: bounds.x, y: bounds.y };
        return { kind: 'kept', rect: clampIntoBounds({ height, width, x: corner.x, y: corner.y }, bounds) };
    }
    if (layoutWindow.desired !== null && fullHeight) {
        const rect: LayoutRect = { height, width, ...layoutWindow.desired };
        // The user's own place may touch its neighbors
        if (isInside(rect, bounds) && !overlapsAny(rect, placed, 0)) {
            return { kind: 'kept', rect };
        }
    }
    const slotted = slot === null ? null : placeInSlot(input, layoutWindow, slot, placed, width, height);
    if (slotted) {
        return slotted;
    }
    if (fullHeight && width >= layoutWindow.width) {
        const moved = findFreeRect(input, anchor, placed, width, height);
        if (moved) {
            return { kind: 'moved', rect: moved };
        }
    }
    // At the width the room allows first, then at the window's minimum width
    for (const shrunkWidth of new Set([ width, Math.min(width, layoutWindow.minimumWidth) ])) {
        const shrunk = findShrunkRect(input, layoutWindow, anchor, placed, shrunkWidth);
        if (shrunk) {
            return { kind: 'shrunk', rect: shrunk };
        }
    }
    return { kind: 'stacked', rect: getStackedRect(input, anchor, occupied, width, Math.min(height, layoutWindow.minimumHeight)) };
}

/**
 * Lays the windows out in priority order: each takes its place before the windows after it, which then avoid it.
 * The windows with a place, pinned or the user's, claim it first; then each window without one takes its reading-order slot, in list order.
 * A stacked window takes its minimum height, so the windows it covers show as much as they can, and later windows do not avoid it.
 */
export function layoutSettingsWindows(input: SettingsWindowLayoutInput): Map<string, LayoutPlacement> {
    const placements = new Map<string, LayoutPlacement>();
    const occupied: StackingObstacles = { pinned: [], placed: [], stacked: [] };
    const place = (layoutWindow: LayoutWindow, slot: LayoutRect | null): void => {
        const placement = placeWindow(input, layoutWindow, occupied, slot);
        placements.set(layoutWindow.id, placement);
        if (placement.kind === 'stacked') {
            occupied.stacked.push(placement.rect);
        } else {
            occupied.placed.push(placement.rect);
            if (layoutWindow.pinned) {
                occupied.pinned.push(placement.rect);
            }
        }
    };
    const unplaced: LayoutWindow[] = [];
    for (const layoutWindow of input.windows) {
        if (layoutWindow.pinned || layoutWindow.desired !== null) {
            place(layoutWindow, null);
        } else {
            unplaced.push(layoutWindow);
        }
    }
    const slots = findSlots(input, unplaced, occupied.placed);
    for (const layoutWindow of unplaced) {
        place(layoutWindow, slots.get(layoutWindow.id) ?? null);
    }
    return placements;
}

/** Returns the top left corner an anchored position gives a window of the width within the room. */
export function resolveAnchoredPosition(position: AnchoredPosition, bounds: LayoutRect, width: number): LayoutPoint {
    return {
        x: position.horizontal === 'left' ? bounds.x + position.x : getRight(bounds) - position.x - width,
        y: position.vertical === 'top' ? bounds.y + position.y : getBottom(bounds) - position.y
    };
}

/** Anchors a window's rectangle to the room's nearer side on each axis; a window in the middle anchors to the left and top. */
export function anchorToNearestSides(rect: LayoutRect, bounds: LayoutRect): AnchoredPosition {
    const leftDistance = rect.x - bounds.x;
    const rightDistance = getRight(bounds) - getRight(rect);
    const topDistance = rect.y - bounds.y;
    // The title bar's distance from the bottom edge, which is where the window's top stays
    const bottomDistance = getBottom(bounds) - rect.y;
    const anchorsRight = rightDistance < leftDistance;
    const anchorsBottom = getBottom(bounds) - getBottom(rect) < topDistance;
    return {
        horizontal: anchorsRight ? 'right' : 'left',
        vertical: anchorsBottom ? 'bottom' : 'top',
        x: Math.max(0, Math.round(anchorsRight ? rightDistance : leftDistance)),
        y: Math.max(0, Math.round(anchorsBottom ? bottomDistance : topDistance))
    };
}

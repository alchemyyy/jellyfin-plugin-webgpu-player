import escapeHtml from 'escape-html';

import globalize from 'lib/globalize';

import { HIDDEN_CLASS, translateToHTML } from '../SettingsPanelHTML';
import {
    anchorToNearestSides,
    layoutSettingsWindows,
    resolveAnchoredPosition,
    type LayoutDirection,
    type LayoutPlacement,
    type LayoutRect,
    type LayoutWindow
} from './SettingsWindowLayout';
import {
    createDefaultSettingsWindowsState,
    getNextPlacementOrder,
    loadSettingsWindowsState,
    saveSettingsWindowsState,
    type SettingsWindowDefaults,
    type SettingsWindowState,
    type SettingsWindowsState
} from './SettingsWindowState';

import '../WebGPUTheme.scss';
import './SettingsWindows.scss';

// The settings windows: one pinned master window and section windows the user shows, hides, collapses, and drags, each where the user put it.
// The layout keeps every shown window inside the room the player leaves, between the OSD's top bar and its bottom controls;
// a window that no longer fits where the user put it moves to the nearest free place or shrinks there, and gets its place back once the room allows.
// The host's playback info takes part as a window of its own, which the host shows and hides

// Sizes in ems of the windows' font
const ROOM_MARGIN_EM = 0.75;
const ROOM_TOP_EM = 5;
const ROOM_TOP_TV_EM = 4;
const WINDOW_GAP_EM = 0.5;
// A shrunk window keeps at least this much of its content in view
const MINIMUM_CONTENT_HEIGHT_EM = 6;
// Above the OSD controls, a room shorter than this extends to the viewport's bottom instead
const MINIMUM_ROOM_HEIGHT_EM = 12;
const OSD_CONTROLS_GAP_EM = 0.5;
// The room's top never takes more than this share of the viewport's height
const MAXIMUM_ROOM_TOP_SHARE = 0.25;
// Keyboard moves, in pixels
const KEY_MOVE_STEP = 8;
const KEY_MOVE_FAST_STEP = 48;
// A press that moves less than this is a click, not a drag
const DRAG_THRESHOLD = 4;
// Digits 1 to 9 toggle the listed windows
const MAXIMUM_SHORTCUT_COUNT = 9;
const DIGIT_CODE_PATTERN = /^(?:Digit|Numpad)([1-9])$/;
const FOCUSABLE_SELECTOR = 'button, input, select, textarea, [tabindex]';
const WINDOW_SELECTOR = '[data-window]';
const WINDOW_LIST_SELECTOR = '[data-settings-window-list]';
const MOVE_HELP_ID = 'webgpu-settings-window-move-help';
const DRAGGING_CLASS = 'webgpuWindow-dragging';
const COLLAPSED_CLASS = 'webgpuWindow-collapsed';
const ANIMATED_CLASS = 'webgpuSettingsWindows-animated';
// The classes and inline properties the settings give the host's playback info while they place it and drag it
const HOSTED_CLASS = 'webgpuSettingsHostedWindow';
const HOSTED_STACKED_CLASS = 'webgpuSettingsHostedWindow-stacked';
const HOSTED_STYLE_PROPERTIES = [ 'left', 'position', 'right', 'top', 'transform' ] as const;

export type SettingsWindowRole = 'master' | 'section';

export type SettingsWindowDefinition = Readonly<{
    /** Raw HTML of the title bar buttons that come before the window's own, such as its reset */
    actionsHTML: string
    /** Raw HTML of the window's content */
    contentHTML: string
    /** Whether the window shows when the user has not chosen; a window always shows expanded until the user collapses it */
    defaultVisible: boolean
    id: string
    /** The width below which the window stops shrinking, in ems of the windows' font */
    minimumWidthEm: number
    /** The master window is pinned to the room's start corner, never collapses or hides, and closes the settings */
    role: SettingsWindowRole
    title: string
    /** The window's width in ems of the windows' font */
    widthEm: number
}>;

/** A window the host owns: the settings place it and move it, and show and hide it through the host, which may act later. */
export type HostedSettingsWindow = Readonly<{
    defaultVisible: boolean
    /** Returns the host's element while it shows, else null */
    findShown: () => HTMLElement | null
    id: string
    setShown: (shown: boolean) => void
    /** Calls the listener whenever the host adds, shows, hides, or resizes its element; returns the unsubscribe */
    subscribe: (listener: () => void) => () => void
    title: string
}>;

export type SettingsWindowManagerOptions = Readonly<{
    definitions: readonly SettingsWindowDefinition[]
    direction: LayoutDirection
    /** Returns the top of the player's controls at the viewport's bottom, in viewport pixels, or null when they take no room */
    findReservedBottom: () => number | null
    hosted: HostedSettingsWindow | null
    /** Closes the settings: the master window's close button and Escape */
    onClose: () => void
    /** Called after a window shows, hides, collapses, or expands */
    onWindowsChange: () => void
    tv: boolean
}>;

export type SettingsWindowManager = Readonly<{
    /** Releases the listeners and returns the host's window to the host; the caller removes the element */
    destroy: () => void
    /** Holds every window; the caller appends it to the document */
    element: HTMLElement
    /** Focuses a window: a section window's title, or the master window's first control */
    focusWindow: (id: string) => void
    /** Whether a window shows its content: shown and not collapsed */
    isExpanded: (id: string) => boolean
    /** Lays the windows out at the next frame */
    requestLayout: () => void
    /** Returns every window to its default visibility, collapse, and place */
    resetLayout: () => void
    setVisible: (id: string, visible: boolean) => void
}>;

/** One window's elements; the master window's title is a heading, a section window's a button that moves and collapses it. */
type WindowFrame = Readonly<{
    body: HTMLElement
    collapseButton: HTMLButtonElement | null
    definition: SettingsWindowDefinition
    frame: HTMLElement
    title: HTMLElement
    titleBar: HTMLElement
}>;

type ListedWindow = Readonly<{
    id: string
    title: string
}>;

type DragState = {
    /** The frame of a settings window, or the host's element */
    readonly element: HTMLElement
    readonly height: number
    readonly id: string
    moved: boolean
    readonly originX: number
    readonly originY: number
    readonly pointerId: number
    /** The room as the drag began; a drag reads nothing from the page while it moves */
    readonly room: LayoutRect
    readonly startX: number
    readonly startY: number
    readonly width: number
    x: number
    y: number
};

/** One layout's reads of the page: the font size, the room, and each shown window's size in priority order, with its title bar's height. */
type LayoutMeasurements = Readonly<{
    chromeHeights: ReadonlyMap<string, number>
    fontSize: number
    room: LayoutRect
    windows: readonly LayoutWindow[]
}>;

/** Sets an inline style property unless it holds the value already, so a layout that changes nothing invalidates no style. */
function setStyle(target: HTMLElement, property: string, value: string): void {
    if (target.style.getPropertyValue(property) !== value) {
        target.style.setProperty(property, value);
    }
}

function getTitleId(id: string): string {
    return `webgpu-settings-window-${id}-title`;
}

function createTitleBarButtonHTML(className: string, label: string, contentHTML: string, attributes: string): string {
    return `
        <button
            aria-label="${escapeHtml(label)}"
            class="webgpuWindowButton ${className}"
            title="${escapeHtml(label)}"
            type="button"
            ${attributes}
        >${contentHTML}</button>`;
}

function createIconHTML(icon: string): string {
    return `<span class="material-icons ${icon}" aria-hidden="true"></span>`;
}

/** Returns an icon button for a window's title bar, before the window's own buttons, named by its label and tooltip; the class and attributes are raw HTML the caller escapes. */
export function createWindowActionHTML(options: Readonly<{ attributes: string; className: string; icon: string; label: string }>): string {
    return createTitleBarButtonHTML(options.className, options.label, createIconHTML(options.icon), options.attributes);
}

function createMasterTitleBarHTML(definition: SettingsWindowDefinition): string {
    return `
        <h2 class="webgpuWindowTitle" id="${getTitleId(definition.id)}">${escapeHtml(definition.title)}</h2>
        <div class="webgpuWindowActions">
            ${definition.actionsHTML}
            ${createTitleBarButtonHTML('webgpuSettingsResetLayout', globalize.translate('WebGPUResetWindowLayout'), createIconHTML('view_quilt'), 'data-reset-layout')}
            ${createTitleBarButtonHTML('webgpuSettingsClose', globalize.translate('WebGPUCloseSettings'), createIconHTML('close'), '')}
        </div>`;
}

function createSectionTitleBarHTML(definition: SettingsWindowDefinition): string {
    const title = escapeHtml(definition.title);
    return `
        <button
            aria-describedby="${MOVE_HELP_ID}"
            aria-expanded="true"
            class="webgpuWindowTitle"
            data-window-title
            id="${getTitleId(definition.id)}"
            title="${title}"
            type="button"
        >${title}</button>
        <div class="webgpuWindowActions">
            ${definition.actionsHTML}
            ${createTitleBarButtonHTML('webgpuWindowCollapse', globalize.translate('WebGPUCollapseWindow', definition.title), '<span class="webgpuWindowCollapseBox" aria-hidden="true"></span>', 'aria-expanded="true" data-window-collapse')}
            ${createTitleBarButtonHTML('webgpuWindowHide', globalize.translate('WebGPUHideWindow', definition.title), createIconHTML('close'), 'data-window-hide')}
        </div>`;
}

function createWindowHTML(definition: SettingsWindowDefinition): string {
    return `
        <section
            aria-labelledby="${getTitleId(definition.id)}"
            class="webgpuWindow webgpuWindow-${definition.role}"
            data-window="${escapeHtml(definition.id)}"
        >
            <div class="webgpuWindowTitleBar" data-window-title-bar>
                ${definition.role === 'master' ? createMasterTitleBarHTML(definition) : createSectionTitleBarHTML(definition)}
            </div>
            <div class="webgpuWindowBody" data-window-body>
                <div class="webgpuWindowContent">${definition.contentHTML}</div>
            </div>
        </section>`;
}

function createWindowListHTML(listedWindows: readonly ListedWindow[]): string {
    return listedWindows.map((entry: ListedWindow, index: number): string => `
        <li class="webgpuWindowListItem">
            <button aria-pressed="false" class="webgpuWindowToggle" data-window-toggle="${escapeHtml(entry.id)}" type="button">
                <span class="webgpuWindowToggleBox" aria-hidden="true"></span>
                <span class="webgpuWindowToggleName">${escapeHtml(entry.title)}</span>
                <kbd class="webgpuWindowToggleKey" aria-hidden="true">${index + 1}</kbd>
            </button>
        </li>`).join('');
}

function requireChild<ElementType extends Element>(parent: ParentNode, selector: string): ElementType {
    const child = parent.querySelector<ElementType>(selector);
    if (!child) {
        throw new Error(`WebGPU settings windows are missing ${selector}`);
    }
    return child;
}

/** Whether a key goes to typing: a text field, or a select, whose letters and digits choose options. */
function isTypingTarget(target: EventTarget | null): boolean {
    if (target instanceof HTMLInputElement) {
        return ![ 'button', 'checkbox', 'radio', 'range', 'reset', 'submit' ].includes(target.type);
    }
    return target instanceof HTMLSelectElement
        || target instanceof HTMLTextAreaElement
        || (target instanceof HTMLElement && target.isContentEditable);
}

function findFirstFocusable(container: HTMLElement): HTMLElement | null {
    for (const candidate of container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) {
        if (candidate.tabIndex >= 0 && !candidate.matches(':disabled') && !candidate.closest(`[hidden], .${HIDDEN_CLASS}`)) {
            return candidate;
        }
    }
    return null;
}

/** Creates the windows from their definitions, with the stored visibility, collapse, and places of this user. */
export function createSettingsWindowManager(options: SettingsWindowManagerOptions): SettingsWindowManager {
    const { definitions, direction, hosted } = options;
    const windowDefaults: Record<string, SettingsWindowDefaults> = {};
    for (const definition of definitions) {
        windowDefaults[definition.id] = { visible: definition.defaultVisible };
    }
    if (hosted) {
        windowDefaults[hosted.id] = { visible: hosted.defaultVisible };
    }
    let state: SettingsWindowsState = loadSettingsWindowsState(windowDefaults);

    const element = document.createElement('div');
    element.className = `webgpuUi webgpuSettingsWindows${options.tv ? ' webgpuSettingsWindows-tv' : ''}`;
    element.setAttribute('data-settings-windows', '');
    element.innerHTML = `
        ${definitions.map(createWindowHTML).join('')}
        <div class="${HIDDEN_CLASS}" id="${MOVE_HELP_ID}">${translateToHTML('WebGPUWindowMoveHelp')}</div>`;

    const frames = new Map<string, WindowFrame>();
    for (const definition of definitions) {
        const frame = requireChild<HTMLElement>(element, `[data-window="${definition.id}"]`);
        frames.set(definition.id, {
            body: requireChild<HTMLElement>(frame, '[data-window-body]'),
            collapseButton: frame.querySelector<HTMLButtonElement>('[data-window-collapse]'),
            definition,
            frame,
            title: requireChild<HTMLElement>(frame, `#${getTitleId(definition.id)}`),
            titleBar: requireChild<HTMLElement>(frame, '[data-window-title-bar]')
        });
    }
    const master = definitions.find((definition: SettingsWindowDefinition): boolean => definition.role === 'master') ?? null;
    // The windows the master lists and the digits toggle: every section window, then the host's
    const listedWindows: readonly ListedWindow[] = [
        ...definitions.filter((definition: SettingsWindowDefinition): boolean => definition.role === 'section'),
        ...(hosted ? [ hosted ] : [])
    ].slice(0, MAXIMUM_SHORTCUT_COUNT);
    const windowList = element.querySelector<HTMLElement>(WINDOW_LIST_SELECTOR);
    if (windowList) {
        windowList.innerHTML = createWindowListHTML(listedWindows);
    }

    const cleanupCallbacks: Array<() => void> = [];
    let layoutRequest: number | null = null;
    let destroyed = false;
    let drag: DragState | null = null;
    // The measurements a drag lays the windows out with: the windows keep their sizes while one moves, so its frames read nothing from the page
    let dragMeasurements: LayoutMeasurements | null = null;
    // The window that holds focus, or was pressed last, keeps its place over the others while the user works in it
    let activeWindowId: string | null = null;
    let raisedCount = 0;
    // Whether the settings showed the host's window, which they hide again when they close
    let hostedShownBySettings = false;
    // The visibility the settings asked the host for and the host has not reached yet
    let pendingHostedShown: boolean | null = null;
    let lastHostedShown: boolean | null = null;
    // Whether the user pressed one of the host's own buttons on it, its close button, so the next hide is the user's choice
    let hostedButtonPressed = false;
    // The inline styles of the host's element before the settings placed it
    const hostedInlineStyles = new Map<HTMLElement, ReadonlyArray<readonly [ string, string ]>>();
    // The host's elements the settings listen on, shown or since hidden, which they stop listening on when they close
    const listenedHostedElements = new Set<HTMLElement>();

    const getWindowState = (id: string): SettingsWindowState => state[id] ?? { collapsed: false, position: null, visible: false };

    const updateState = (id: string, update: Partial<SettingsWindowState>): void => {
        state = { ...state, [id]: { ...getWindowState(id), ...update } };
        saveSettingsWindowsState(state);
    };

    const isShown = (id: string): boolean => {
        if (master?.id === id) {
            return true;
        }
        if (hosted?.id === id) {
            return hosted.findShown() !== null;
        }
        return getWindowState(id).visible;
    };

    const isCollapsed = (id: string): boolean => frames.get(id)?.definition.role === 'section' && getWindowState(id).collapsed;

    const getFontSize = (): number => parseFloat(getComputedStyle(element).fontSize) || 16;

    /** The room the windows share: the viewport within its margins, below the OSD's top bar, and above its bottom controls when that leaves enough. */
    const getRoom = (fontSize: number): LayoutRect => {
        const viewportWidth = document.documentElement.clientWidth;
        const viewportHeight = document.documentElement.clientHeight;
        const margin = ROOM_MARGIN_EM * fontSize;
        const top = Math.min((options.tv ? ROOM_TOP_TV_EM : ROOM_TOP_EM) * fontSize, viewportHeight * MAXIMUM_ROOM_TOP_SHARE);
        let bottom = viewportHeight - margin;
        const reservedBottom = options.findReservedBottom();
        if (reservedBottom !== null) {
            const aboveControls = reservedBottom - OSD_CONTROLS_GAP_EM * fontSize;
            if (aboveControls - top >= MINIMUM_ROOM_HEIGHT_EM * fontSize) {
                bottom = Math.min(bottom, aboveControls);
            }
        }
        return { height: Math.max(0, bottom - top), width: Math.max(0, viewportWidth - 2 * margin), x: margin, y: top };
    };

    const placeHostedElement = (hostedElement: HTMLElement, x: number, y: number): void => {
        if (!hostedInlineStyles.has(hostedElement)) {
            hostedInlineStyles.set(hostedElement, HOSTED_STYLE_PROPERTIES.map((property: string): [ string, string ] => [ property, hostedElement.style.getPropertyValue(property) ]));
            hostedElement.classList.add(HOSTED_CLASS);
        }
        // Fixed, so it shares the windows' viewport coordinates, whatever the host positions it against
        setStyle(hostedElement, 'position', 'fixed');
        setStyle(hostedElement, 'right', 'auto');
        setStyle(hostedElement, 'left', `${Math.round(x)}px`);
        setStyle(hostedElement, 'top', `${Math.round(y)}px`);
    };

    const restoreHostedElements = (): void => {
        for (const [ hostedElement, styles ] of hostedInlineStyles) {
            for (const [ property, value ] of styles) {
                hostedElement.style.setProperty(property, value);
            }
            hostedElement.classList.remove(HOSTED_CLASS, HOSTED_STACKED_CLASS, DRAGGING_CLASS);
        }
        hostedInlineStyles.clear();
    };

    /** Measures one shown window for the layout, at its full width, which the frame already has, with its content unconstrained; reads only. */
    const measureWindow = (id: string, fontSize: number, room: LayoutRect, chromeHeights: Map<string, number>): LayoutWindow | null => {
        const position = getWindowState(id).position;
        const windowFrame = frames.get(id);
        if (windowFrame) {
            const { body, definition, frame } = windowFrame;
            const width = definition.widthEm * fontSize;
            const chromeHeight = frame.offsetHeight - body.offsetHeight;
            chromeHeights.set(id, chromeHeight);
            const height = chromeHeight + body.scrollHeight;
            const pinned = definition.role === 'master';
            const pinnedCorner = { x: direction === 'rtl' ? room.x + room.width - width : room.x, y: room.y };
            return {
                desired: pinned ? pinnedCorner : position && resolveAnchoredPosition(position, room, width),
                height,
                id,
                minimumHeight: isCollapsed(id) ? height : Math.min(height, chromeHeight + MINIMUM_CONTENT_HEIGHT_EM * fontSize),
                minimumWidth: definition.minimumWidthEm * fontSize,
                pinned,
                // A section window's slot is its title bar, so it keeps its slot as it expands and collapses
                slotHeight: definition.role === 'section' ? chromeHeight : height,
                width
            };
        }
        const hostedElement = hosted?.id === id ? hosted.findShown() : null;
        if (!hostedElement) {
            return null;
        }
        const bounds = hostedElement.getBoundingClientRect();
        // The host's window keeps its own size: it neither shrinks nor scrolls
        return {
            desired: position && resolveAnchoredPosition(position, room, bounds.width),
            height: bounds.height,
            id,
            minimumHeight: bounds.height,
            minimumWidth: bounds.width,
            pinned: false,
            slotHeight: bounds.height,
            width: bounds.width
        };
    };

    /**
     * The shown windows in the order they claim places: the master, the one the user drags or works in among those the user placed,
     * the most recently placed, then the rest in list order, which keep their reading-order slots whichever the user works in.
     */
    const getPriorityOrder = (): string[] => {
        const rank = (id: string): number => {
            if (master?.id === id) {
                return Number.POSITIVE_INFINITY;
            }
            const position = getWindowState(id).position;
            if (drag ? drag.id === id : activeWindowId === id && position !== null) {
                return Number.MAX_SAFE_INTEGER;
            }
            return position?.order ?? -1;
        };
        // The sort is stable, so windows of equal rank keep their list order
        return [ ...frames.keys(), ...(hosted ? [ hosted.id ] : []) ]
            .filter((id: string): boolean => isShown(id))
            .sort((first: string, second: string): number => rank(second) - rank(first));
    };

    /**
     * Measures every shown window, in priority order: each frame takes its full width first, so the reads that follow cost the page one layout,
     * however many windows there are.
     */
    const measure = (): LayoutMeasurements => {
        const fontSize = getFontSize();
        const ids = getPriorityOrder();
        for (const id of ids) {
            const windowFrame = frames.get(id);
            if (windowFrame) {
                setStyle(windowFrame.frame, 'width', `${windowFrame.definition.widthEm * fontSize}px`);
            }
        }
        const room = getRoom(fontSize);
        const chromeHeights = new Map<string, number>();
        const windows: LayoutWindow[] = [];
        for (const id of ids) {
            const measured = measureWindow(id, fontSize, room, chromeHeights);
            if (measured) {
                windows.push(measured);
            }
        }
        return { chromeHeights, fontSize, room, windows };
    };

    /** Applies one window's placement; it only writes, and only what changed, so it never makes the page lay itself out. */
    const applyPlacement = (id: string, placement: LayoutPlacement, chromeHeights: ReadonlyMap<string, number>): void => {
        const { rect } = placement;
        const windowFrame = frames.get(id);
        if (!windowFrame) {
            const hostedElement = hosted?.findShown();
            if (hostedElement && drag?.element !== hostedElement) {
                placeHostedElement(hostedElement, rect.x, rect.y);
                // Stacked over the windows when no free room holds it, it shows above them, as a stacked settings window does
                hostedElement.classList.toggle(HOSTED_STACKED_CLASS, placement.kind === 'stacked');
            }
            return;
        }
        const { body, frame } = windowFrame;
        setStyle(frame, 'width', `${Math.round(rect.width)}px`);
        setStyle(body, 'max-height', isCollapsed(id) ? '' : `${Math.max(0, Math.floor(rect.height - (chromeHeights.get(id) ?? 0)))}px`);
        if (frame.dataset.placement !== placement.kind) {
            frame.dataset.placement = placement.kind;
        }
        // The dragged window follows the pointer; the others make room around it
        if (drag?.element !== frame) {
            setStyle(frame, 'left', `${Math.round(rect.x)}px`);
            setStyle(frame, 'top', `${Math.round(rect.y)}px`);
        }
    };

    const layout = (): void => {
        layoutRequest = null;
        if (destroyed || !element.isConnected) {
            return;
        }
        // A drag measures once, as it starts moving, and then only computes and writes
        const active = drag;
        let measurements: LayoutMeasurements;
        if (active?.moved) {
            if (dragMeasurements === null) {
                dragMeasurements = measure();
            }
            measurements = dragMeasurements;
        } else {
            measurements = measure();
        }
        const { chromeHeights, fontSize, room } = measurements;
        const windows = active === null ?
            measurements.windows :
            measurements.windows.map((measured: LayoutWindow): LayoutWindow => (measured.id === active.id ? { ...measured, desired: { x: active.x, y: active.y } } : measured));
        const placements = layoutSettingsWindows({ bounds: room, direction, gap: WINDOW_GAP_EM * fontSize, windows });
        for (const [ id, placement ] of placements) {
            applyPlacement(id, placement, chromeHeights);
        }
        if (active?.moved) {
            // The dragged window moves by a transform from where the drag began, which the compositor applies without laying the page out
            setStyle(active.element, 'transform', `translate(${Math.round(active.x - active.originX)}px, ${Math.round(active.y - active.originY)}px)`);
        }
        // Moves animate from the first layout on, so the windows do not slide in as the settings open
        if (!element.classList.contains(ANIMATED_CLASS)) {
            element.classList.add(ANIMATED_CLASS);
        }
    };

    const requestLayout = (): void => {
        if (layoutRequest === null && !destroyed) {
            layoutRequest = requestAnimationFrame(layout);
        }
    };

    const layoutNow = (): void => {
        if (layoutRequest !== null) {
            cancelAnimationFrame(layoutRequest);
        }
        layout();
    };

    const raise = (frame: HTMLElement): void => {
        raisedCount += 1;
        frame.style.zIndex = String(raisedCount);
    };

    const synchronize = (): void => {
        for (const { body, collapseButton, definition, frame, title } of frames.values()) {
            const collapsed = isCollapsed(definition.id);
            frame.hidden = !isShown(definition.id);
            frame.classList.toggle(COLLAPSED_CLASS, collapsed);
            body.hidden = collapsed;
            if (definition.role === 'section') {
                title.setAttribute('aria-expanded', String(!collapsed));
            }
            if (collapseButton) {
                const label = globalize.translate(collapsed ? 'WebGPUExpandWindow' : 'WebGPUCollapseWindow', definition.title);
                collapseButton.setAttribute('aria-expanded', String(!collapsed));
                collapseButton.setAttribute('aria-label', label);
                collapseButton.title = label;
            }
        }
        for (const entry of listedWindows) {
            const toggle = windowList?.querySelector<HTMLElement>(`[data-window-toggle="${entry.id}"]`);
            if (toggle) {
                const shown = isShown(entry.id);
                toggle.setAttribute('aria-pressed', String(shown));
                toggle.title = globalize.translate(shown ? 'WebGPUHideWindow' : 'WebGPUShowWindow', entry.title);
            }
        }
    };

    const notifyChange = (): void => {
        synchronize();
        layoutNow();
        options.onWindowsChange();
    };

    const focusWindow = (id: string): void => {
        const windowFrame = frames.get(id);
        if (!windowFrame || windowFrame.frame.hidden) {
            return;
        }
        raise(windowFrame.frame);
        const target = windowFrame.definition.role === 'master' ?
            findFirstFocusable(windowFrame.body) ?? findFirstFocusable(windowFrame.frame) :
            windowFrame.title;
        target?.focus();
    };

    const setVisible = (id: string, visible: boolean): void => {
        if (master?.id === id) {
            return;
        }
        if (hosted?.id === id) {
            // Playback info shown from the settings closes with them, as it did beside the earlier panel
            hostedShownBySettings = visible;
            pendingHostedShown = visible;
            updateState(id, { visible });
            hosted.setShown(visible);
            synchronize();
            return;
        }
        const windowFrame = frames.get(id);
        if (!windowFrame) {
            return;
        }
        const hadFocus = windowFrame.frame.contains(document.activeElement);
        // A window shown again opens expanded, so it shows what the user asked for
        updateState(id, visible ? { collapsed: false, visible } : { visible });
        notifyChange();
        if (visible) {
            raise(windowFrame.frame);
        } else if (hadFocus) {
            // Focus leaves a hidden window for its toggle in the master's list, where it shows again
            windowList?.querySelector<HTMLElement>(`[data-window-toggle="${id}"]`)?.focus();
        }
    };

    const toggleCollapsed = (id: string): void => {
        if (frames.get(id)?.definition.role === 'section') {
            updateState(id, { collapsed: !isCollapsed(id) });
            notifyChange();
        }
    };

    /** Stores where the user put a window, as its distance from the room's nearer sides, placed after every earlier placement. */
    const storePosition = (id: string, rect: LayoutRect): void => {
        const room = getRoom(getFontSize());
        updateState(id, { position: { ...anchorToNearestSides(rect, room), order: getNextPlacementOrder(state) } });
    };

    /** Returns a corner for a window of the size that keeps the window inside the room as far as its size allows. */
    const clampIntoRoom = (x: number, y: number, width: number, height: number, room: LayoutRect = getRoom(getFontSize())): Readonly<{ x: number; y: number }> => ({
        x: Math.min(Math.max(x, room.x), Math.max(room.x, room.x + room.width - width)),
        y: Math.min(Math.max(y, room.y), Math.max(room.y, room.y + room.height - height))
    });

    const moveByKeyboard = (id: string, deltaX: number, deltaY: number): void => {
        const frame = frames.get(id)?.frame;
        if (!frame) {
            return;
        }
        const bounds = frame.getBoundingClientRect();
        const corner = clampIntoRoom(bounds.left + deltaX, bounds.top + deltaY, bounds.width, bounds.height);
        activeWindowId = id;
        storePosition(id, { height: bounds.height, width: bounds.width, x: corner.x, y: corner.y });
        layoutNow();
    };

    const resetLayout = (): void => {
        const hostedShown = hosted ? hosted.findShown() !== null : false;
        state = createDefaultSettingsWindowsState(windowDefaults);
        saveSettingsWindowsState(state);
        activeWindowId = null;
        if (hosted && hostedShown !== hosted.defaultVisible) {
            setVisible(hosted.id, hosted.defaultVisible);
        }
        notifyChange();
    };

    // Clicks on the window list, the title bar buttons, and the master's own buttons
    const onClick = (event: MouseEvent): void => {
        const target = event.target instanceof Element ? event.target : null;
        const toggle = target?.closest<HTMLElement>('[data-window-toggle]');
        if (!target) {
            return;
        }
        if (toggle) {
            const id = toggle.dataset.windowToggle ?? '';
            setVisible(id, !isShown(id));
        } else if (target.closest('.webgpuSettingsClose')) {
            options.onClose();
        } else if (target.closest('[data-reset-layout]')) {
            resetLayout();
        } else if (target.closest('[data-window-collapse]')) {
            toggleCollapsed(target.closest<HTMLElement>(WINDOW_SELECTOR)?.dataset.window ?? '');
        } else if (target.closest('[data-window-hide]')) {
            setVisible(target.closest<HTMLElement>(WINDOW_SELECTOR)?.dataset.window ?? '', false);
        }
    };

    // A double click on a section window's title bar collapses or expands it, as its square does
    const onDoubleClick = (event: MouseEvent): void => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('[data-window-title-bar]') && !target.closest('.webgpuWindowActions')) {
            toggleCollapsed(target.closest<HTMLElement>(WINDOW_SELECTOR)?.dataset.window ?? '');
        }
    };

    const startDrag = (id: string, dragElement: HTMLElement, event: PointerEvent, captureTarget: Element): boolean => {
        if (event.button !== 0 || drag !== null) {
            return false;
        }
        const bounds = dragElement.getBoundingClientRect();
        drag = {
            element: dragElement,
            height: bounds.height,
            id,
            moved: false,
            originX: bounds.left,
            originY: bounds.top,
            pointerId: event.pointerId,
            room: getRoom(getFontSize()),
            startX: event.clientX,
            startY: event.clientY,
            width: bounds.width,
            x: bounds.left,
            y: bounds.top
        };
        dragMeasurements = null;
        try {
            captureTarget.setPointerCapture?.(event.pointerId);
        } catch {
            // A pointer the browser no longer tracks cannot be captured; the drag then follows the events that still reach the windows
        }
        return true;
    };

    // A move only notes where the pointer is; the next frame moves the window and lays the others out, once however many moves came
    const onPointerMove = (event: PointerEvent): void => {
        if (!drag || event.pointerId !== drag.pointerId) {
            return;
        }
        const deltaX = event.clientX - drag.startX;
        const deltaY = event.clientY - drag.startY;
        if (!drag.moved) {
            if (Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD) {
                return;
            }
            drag.moved = true;
            drag.element.classList.add(DRAGGING_CLASS);
        }
        const corner = clampIntoRoom(drag.originX + deltaX, drag.originY + deltaY, drag.width, drag.height, drag.room);
        drag.x = corner.x;
        drag.y = corner.y;
        requestLayout();
    };

    const endDrag = (event: PointerEvent): void => {
        if (!drag || event.pointerId !== drag.pointerId) {
            return;
        }
        const ended = drag;
        drag = null;
        dragMeasurements = null;
        if (ended.moved) {
            // The window takes its place where the pointer left it while its dragging class still turns its transitions off
            if (frames.has(ended.id)) {
                setStyle(ended.element, 'left', `${Math.round(ended.x)}px`);
                setStyle(ended.element, 'top', `${Math.round(ended.y)}px`);
            } else {
                placeHostedElement(ended.element, ended.x, ended.y);
            }
            ended.element.style.removeProperty('transform');
            if (event.type !== 'pointercancel') {
                storePosition(ended.id, { height: ended.height, width: ended.width, x: ended.x, y: ended.y });
            }
        }
        // The layout reads the page, so the window's place is in effect before its transitions turn back on
        layoutNow();
        ended.element.classList.remove(DRAGGING_CLASS);
    };

    const onPointerDown = (event: PointerEvent): void => {
        const target = event.target instanceof Element ? event.target : null;
        const frame = target?.closest<HTMLElement>(WINDOW_SELECTOR);
        if (!target || !frame) {
            return;
        }
        raise(frame);
        const id = frame.dataset.window ?? '';
        activeWindowId = id;
        const titleBar = target.closest<HTMLElement>('[data-window-title-bar]');
        // The master is pinned, and a title bar's buttons act rather than drag
        if (titleBar && frames.get(id)?.definition.role === 'section' && !target.closest('.webgpuWindowActions')) {
            startDrag(id, frame, event, titleBar);
        }
    };

    // The host's playback info moves by a press anywhere on it but its buttons
    const onHostedPointerDown = (event: PointerEvent): void => {
        const hostedElement = hosted?.findShown();
        const target = event.target instanceof Element ? event.target : null;
        if (!hosted || !hostedElement || !target || target.closest('button') || !startDrag(hosted.id, hostedElement, event, hostedElement)) {
            return;
        }
        activeWindowId = hosted.id;
        const onHostedPointerEnd = (endEvent: PointerEvent): void => {
            if (endEvent.pointerId !== event.pointerId) {
                return;
            }
            endDrag(endEvent);
            hostedElement.removeEventListener('pointermove', onPointerMove);
            hostedElement.removeEventListener('pointerup', onHostedPointerEnd);
            hostedElement.removeEventListener('pointercancel', onHostedPointerEnd);
        };
        hostedElement.addEventListener('pointermove', onPointerMove);
        hostedElement.addEventListener('pointerup', onHostedPointerEnd);
        hostedElement.addEventListener('pointercancel', onHostedPointerEnd);
    };

    // A click on the host's own button, its close button, by pointer or key, comes before the hide it causes
    const onHostedClick = (event: MouseEvent): void => {
        if (event.target instanceof Element && event.target.closest('button')) {
            hostedButtonPressed = true;
        }
    };

    const focusAdjacentWindow = (step: number): void => {
        const shownIds = [ ...frames.keys() ].filter((id: string): boolean => isShown(id));
        const active = document.activeElement instanceof Element ? document.activeElement.closest<HTMLElement>(WINDOW_SELECTOR) : null;
        const currentIndex = shownIds.indexOf(active?.dataset.window ?? '');
        if (shownIds.length > 0) {
            focusWindow(shownIds[currentIndex === -1 ? 0 : (currentIndex + step + shownIds.length) % shownIds.length]);
        }
    };

    /** Handles a key on a section window's title, which moves, collapses, or hides the window; returns whether it did. */
    const handleTitleKey = (event: KeyboardEvent, id: string): boolean => {
        const step = event.shiftKey ? KEY_MOVE_FAST_STEP : KEY_MOVE_STEP;
        switch (event.key) {
            case 'ArrowLeft':
                moveByKeyboard(id, -step, 0);
                return true;
            case 'ArrowRight':
                moveByKeyboard(id, step, 0);
                return true;
            case 'ArrowUp':
                moveByKeyboard(id, 0, -step);
                return true;
            case 'ArrowDown':
                moveByKeyboard(id, 0, step);
                return true;
            case 'Home':
                // Back to the first free place in reading order
                updateState(id, { position: null });
                layoutNow();
                return true;
            case 'Enter':
            case ' ':
                toggleCollapsed(id);
                return true;
            case 'Delete':
                setVisible(id, false);
                return true;
            default:
                return false;
        }
    };

    /** Handles the keys every window shares, whatever holds the focus; returns whether the key was taken. */
    const handleSharedKey = (event: KeyboardEvent): boolean => {
        if (event.key === 'Escape') {
            options.onClose();
            return true;
        }
        if (event.key === 'F6') {
            focusAdjacentWindow(event.shiftKey ? -1 : 1);
            return true;
        }
        return false;
    };

    /** Shows or hides the listed window of a digit pressed outside a text field; returns whether the key was taken. */
    const handleDigitKey = (event: KeyboardEvent): boolean => {
        const digit = DIGIT_CODE_PATTERN.exec(event.code);
        const entry = digit && !isTypingTarget(event.target) ? listedWindows[Number(digit[1]) - 1] : undefined;
        if (!entry) {
            return false;
        }
        const visible = !isShown(entry.id);
        setVisible(entry.id, visible);
        if (visible) {
            focusWindow(entry.id);
        }
        return true;
    };

    const onKeyDown = (event: KeyboardEvent): void => {
        // Keys pressed in the windows never reach the video OSD, which pauses on Space, seeks on digits and arrows, and changes the volume on ArrowUp
        event.stopPropagation();
        if (event.defaultPrevented) {
            return;
        }
        if (handleSharedKey(event)) {
            event.preventDefault();
            return;
        }
        if (event.ctrlKey || event.altKey || event.metaKey) {
            return;
        }
        const target = event.target instanceof Element ? event.target : null;
        const titleWindowId = target?.matches('[data-window-title]') ? target.closest<HTMLElement>(WINDOW_SELECTOR)?.dataset.window : undefined;
        if ((titleWindowId !== undefined && handleTitleKey(event, titleWindowId)) || handleDigitKey(event)) {
            event.preventDefault();
        }
    };

    // The video OSD changes the volume on wheel events that reach the document; the windows keep their own scrolling
    const onWheel = (event: WheelEvent): void => {
        event.stopPropagation();
    };

    const onFocusIn = (event: FocusEvent): void => {
        const id = event.target instanceof Element ? event.target.closest<HTMLElement>(WINDOW_SELECTOR)?.dataset.window : undefined;
        if (id !== undefined) {
            activeWindowId = id;
        }
    };

    const onHostedChange = (): void => {
        if (!hosted || destroyed) {
            return;
        }
        const hostedElement = hosted.findShown();
        const shown = hostedElement !== null;
        if (pendingHostedShown === shown) {
            pendingHostedShown = null;
        }
        // A hide after the user pressed the host's close button is the user's choice, which the settings keep as the master's toggle does;
        // the host also hides and removes it by itself, as when the playback ends, which changes nothing the user chose
        if (!shown && hostedButtonPressed) {
            hostedButtonPressed = false;
            hostedShownBySettings = false;
            updateState(hosted.id, { visible: false });
        }
        if (hostedElement && !listenedHostedElements.has(hostedElement)) {
            listenedHostedElements.add(hostedElement);
            hostedElement.addEventListener('pointerdown', onHostedPointerDown);
            hostedElement.addEventListener('click', onHostedClick);
        }
        requestLayout();
        if (shown !== lastHostedShown) {
            lastHostedShown = shown;
            synchronize();
            options.onWindowsChange();
        }
    };

    const listen = <Type extends keyof HTMLElementEventMap>(type: Type, listener: (event: HTMLElementEventMap[Type]) => void, listenerOptions?: AddEventListenerOptions): void => {
        element.addEventListener(type, listener, listenerOptions);
        cleanupCallbacks.push((): void => {
            element.removeEventListener(type, listener, listenerOptions);
        });
    };
    listen('click', onClick);
    listen('dblclick', onDoubleClick);
    listen('pointerdown', onPointerDown);
    listen('pointermove', onPointerMove);
    listen('pointerup', endDrag);
    listen('pointercancel', endDrag);
    listen('keydown', onKeyDown);
    listen('focusin', onFocusIn);
    listen('wheel', onWheel, { passive: true });
    window.addEventListener('resize', requestLayout);
    cleanupCallbacks.push((): void => {
        window.removeEventListener('resize', requestLayout);
    });

    // Content that grows or shrinks, as when a description expands or a list fills, lays the windows out again
    if (typeof ResizeObserver === 'function') {
        const resizeObserver = new ResizeObserver(requestLayout);
        for (const { body, titleBar } of frames.values()) {
            resizeObserver.observe(body.firstElementChild ?? body);
            resizeObserver.observe(titleBar);
        }
        cleanupCallbacks.push((): void => {
            resizeObserver.disconnect();
        });
    }

    if (hosted) {
        cleanupCallbacks.push(hosted.subscribe(onHostedChange));
        if (hosted.findShown() !== null) {
            // Playback info the user already shows stays, listed as shown, and stays when the settings close
            state = { ...state, [hosted.id]: { ...getWindowState(hosted.id), visible: true } };
        } else if (getWindowState(hosted.id).visible) {
            hostedShownBySettings = true;
            pendingHostedShown = true;
            hosted.setShown(true);
        }
        // The caller learns of changes from here on, not of the state the windows open in
        lastHostedShown = hosted.findShown() !== null;
        onHostedChange();
    }
    synchronize();

    return {
        destroy: (): void => {
            if (destroyed) {
                return;
            }
            destroyed = true;
            if (layoutRequest !== null) {
                cancelAnimationFrame(layoutRequest);
                layoutRequest = null;
            }
            for (const cleanupCallback of cleanupCallbacks) {
                cleanupCallback();
            }
            restoreHostedElements();
            const hostedElement = hosted?.findShown() ?? null;
            for (const listenedElement of listenedHostedElements) {
                listenedElement.removeEventListener('pointerdown', onHostedPointerDown);
                listenedElement.removeEventListener('click', onHostedClick);
            }
            listenedHostedElements.clear();
            // Playback info the settings showed closes with them, unless the user closed it already
            if (hosted && hostedShownBySettings && (hostedElement !== null || pendingHostedShown === true)) {
                hosted.setShown(false);
            }
        },
        element,
        focusWindow,
        isExpanded: (id: string): boolean => isShown(id) && !isCollapsed(id),
        requestLayout,
        resetLayout,
        setVisible
    };
}

import { currentSettings } from 'scripts/settings/userSettings';

import type { AnchoredPosition } from './SettingsWindowLayout';

// The settings windows' arrangement in this browser, per user: which windows show, which are collapsed, and where the user put each.
// It belongs to this browser and its screen, so it is stored apart from the settings, has no server default, and the settings' resets leave it

const STORAGE_KEY = 'webGPUSettingsWindows';
const STATE_VERSION = 1;
const WARNING_PREFIX = 'WebGPU settings windows';
// No screen is this large, so a stored distance beyond it, like a negative one, loads as no place
const MAXIMUM_DISTANCE = 100_000;

/** Where the user put a window, and when: a window placed later wins a contested place over one placed earlier. */
export type SettingsWindowPosition = AnchoredPosition & Readonly<{
    /** Counts up with each placement */
    order: number
}>;

export type SettingsWindowState = Readonly<{
    collapsed: boolean
    /** Null while the window takes the first free place in reading order */
    position: SettingsWindowPosition | null
    visible: boolean
}>;

/** Whether a window shows before the user chooses; every window shows expanded, with no place of its own, until the user collapses or places it. */
export type SettingsWindowDefaults = Readonly<{
    visible: boolean
}>;

/** Each window's state, by its id. */
export type SettingsWindowsState = Readonly<Record<string, SettingsWindowState>>;

function isDistance(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAXIMUM_DISTANCE;
}

/** Narrows parsed JSON to an object whose fields the caller checks one by one; null for anything else. */
function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizePosition(value: unknown): SettingsWindowPosition | null {
    const record = asRecord(value);
    if (!record) {
        return null;
    }
    const { horizontal, order, vertical, x, y } = record;
    if ((horizontal !== 'left' && horizontal !== 'right')
        || (vertical !== 'top' && vertical !== 'bottom')
        || !isDistance(x)
        || !isDistance(y)
        || typeof order !== 'number'
        || !Number.isSafeInteger(order)
        || order < 0) {
        return null;
    }
    return { horizontal, order, vertical, x, y };
}

function normalizeWindowState(value: unknown, defaults: SettingsWindowDefaults): SettingsWindowState {
    const record = asRecord(value);
    if (!record) {
        return { collapsed: false, position: null, visible: defaults.visible };
    }
    return {
        collapsed: record.collapsed === true,
        position: normalizePosition(record.position),
        visible: typeof record.visible === 'boolean' ? record.visible : defaults.visible
    };
}

/** Returns every window at its defaults: expanded, with no place of its own. */
export function createDefaultSettingsWindowsState(defaults: Readonly<Record<string, SettingsWindowDefaults>>): SettingsWindowsState {
    const state: Record<string, SettingsWindowState> = {};
    for (const [ id, windowDefaults ] of Object.entries(defaults)) {
        state[id] = { collapsed: false, position: null, visible: windowDefaults.visible };
    }
    return state;
}

/** Returns the stored state of each window, or its defaults where none is stored or the stored one is not valid; unknown windows are dropped. */
export function loadSettingsWindowsState(defaults: Readonly<Record<string, SettingsWindowDefaults>>): SettingsWindowsState {
    let stored: unknown = null;
    try {
        stored = JSON.parse(currentSettings.get(STORAGE_KEY, false) || 'null');
    } catch (error) {
        console.warn(`${WARNING_PREFIX}: state-unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const storedState = asRecord(stored);
    const windows = storedState?.version === STATE_VERSION ? asRecord(storedState.windows) ?? {} : {};
    const state: Record<string, SettingsWindowState> = {};
    for (const [ id, windowDefaults ] of Object.entries(defaults)) {
        state[id] = normalizeWindowState(Object.prototype.hasOwnProperty.call(windows, id) ? windows[id] : null, windowDefaults);
    }
    return state;
}

/** Stores the windows' state; returns what failed when the browser refused the write, else null. */
export function saveSettingsWindowsState(state: SettingsWindowsState): string | null {
    try {
        currentSettings.set(STORAGE_KEY, JSON.stringify({ version: STATE_VERSION, windows: state }), false);
        return null;
    } catch (error) {
        // Local storage refuses a write once the origin's quota is full
        const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        const failure = `state-save-failed: ${reason}`;
        console.warn(`${WARNING_PREFIX}: ${failure}`);
        return failure;
    }
}

/** Returns the order of the next placement: one past the latest one stored. */
export function getNextPlacementOrder(state: SettingsWindowsState): number {
    let latest = -1;
    for (const windowState of Object.values(state)) {
        latest = Math.max(latest, windowState.position?.order ?? -1);
    }
    return latest + 1;
}

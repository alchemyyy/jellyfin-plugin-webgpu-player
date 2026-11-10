import { afterEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
    refusedWriteError: null as Error | null,
    values: new Map<string, string>()
}));

vi.mock('scripts/settings/userSettings', () => ({
    currentSettings: {
        get: (name: string): string | null => storage.values.get(name) ?? null,
        set: (name: string, value: string): void => {
            if (storage.refusedWriteError) {
                throw storage.refusedWriteError;
            }
            storage.values.set(name, value);
        }
    }
}));

import {
    createDefaultSettingsWindowsState,
    getNextPlacementOrder,
    loadSettingsWindowsState,
    saveSettingsWindowsState
} from 'addons/webGPUPlayer/ui/windows/SettingsWindowState';

const STORAGE_KEY = 'webGPUSettingsWindows';
const DEFAULTS = Object.freeze({
    audio: { visible: true },
    picture: { visible: false }
});
const PLACED = Object.freeze({ horizontal: 'right', order: 3, vertical: 'bottom', x: 24, y: 300 });

function store(value: unknown): void {
    storage.values.set(STORAGE_KEY, JSON.stringify(value));
}

describe('SettingsWindowState', () => {
    afterEach(() => {
        storage.values.clear();
        storage.refusedWriteError = null;
    });

    it('starts every window at its defaults, with no place of its own, when nothing is stored', () => {
        expect(loadSettingsWindowsState(DEFAULTS)).toEqual(createDefaultSettingsWindowsState(DEFAULTS));
        expect(loadSettingsWindowsState(DEFAULTS).picture).toEqual({ collapsed: false, position: null, visible: false });
    });

    it('reads stored windows back, and drops windows it no longer has', () => {
        saveSettingsWindowsState({
            gone: { collapsed: false, position: null, visible: true },
            picture: { collapsed: false, position: PLACED, visible: false }
        });

        const state = loadSettingsWindowsState(DEFAULTS);

        expect(state.picture).toEqual({ collapsed: false, position: PLACED, visible: false });
        expect(state.audio).toEqual({ collapsed: false, position: null, visible: true });
        expect(Object.keys(state).sort((left: string, right: string): number => left.localeCompare(right))).toEqual([ 'audio', 'picture' ]);
    });

    it('loads a place that no screen can have, or no anchor names, as no place', () => {
        for (const position of [
            { ...PLACED, x: -1 },
            { ...PLACED, y: 1_000_000 },
            { ...PLACED, horizontal: 'start' },
            { ...PLACED, vertical: 'middle' },
            { ...PLACED, order: 1.5 },
            { ...PLACED, order: -1 },
            { ...PLACED, x: '24' },
            [ PLACED ]
        ]) {
            store({ version: 1, windows: { picture: { collapsed: false, position, visible: true } } });
            expect(loadSettingsWindowsState(DEFAULTS).picture.position).toBeNull();
        }
    });

    it('takes the defaults for a stored window state that is not valid, and for another version', () => {
        store({ version: 1, windows: { picture: { collapsed: 'no', visible: 1 } } });
        expect(loadSettingsWindowsState(DEFAULTS).picture).toEqual({ collapsed: false, position: null, visible: false });

        store({ version: 2, windows: { picture: { collapsed: false, position: PLACED, visible: false } } });
        expect(loadSettingsWindowsState(DEFAULTS).picture).toEqual({ collapsed: false, position: null, visible: false });

        storage.values.set(STORAGE_KEY, '{not json');
        vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
        expect(loadSettingsWindowsState(DEFAULTS)).toEqual(createDefaultSettingsWindowsState(DEFAULTS));
    });

    it('numbers the next placement after the latest stored one', () => {
        expect(getNextPlacementOrder(createDefaultSettingsWindowsState(DEFAULTS))).toBe(0);
        expect(getNextPlacementOrder({
            audio: { collapsed: false, position: { ...PLACED, order: 7 }, visible: true },
            picture: { collapsed: false, position: PLACED, visible: true }
        })).toBe(8);
    });

    it('reports a write the browser refuses, and keeps going', () => {
        storage.refusedWriteError = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        vi.spyOn(console, 'warn').mockImplementation((): void => undefined);

        expect(saveSettingsWindowsState(createDefaultSettingsWindowsState(DEFAULTS)))
            .toBe('state-save-failed: QuotaExceededError: The quota has been exceeded.');
    });
});

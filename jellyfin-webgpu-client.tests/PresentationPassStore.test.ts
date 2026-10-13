import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as PassSourceStore from 'addons/webGPUPlayer/PresentationPassStore';
import type { StoredPresentationFile } from 'addons/webGPUPlayer/WebGPUUserSettings';
import { installIndexedDBFake, type IndexedDBFake } from './indexedDBFake';
import { INVERT_PASS_SOURCE, SATURATION_PARAMETER_NAME, SATURATION_PASS_SOURCE, STORED_SATURATION } from './presentationPassSources';

type PassSourceStoreModule = typeof PassSourceStore;

// Where the store keeps the sources
const DATABASE_NAME = 'webGPUPlayerPresentation';
const SOURCE_STORE_NAME = 'passSources';
// The keys the store gives count up from 1
const FIRST_SOURCE_KEY = 1;
const SECOND_SOURCE_KEY = 2;
// A key the store never gave
const MISSING_SOURCE_KEY = 99;
const QUOTA_ERROR = new DOMException('The quota has been exceeded', 'QuotaExceededError');
const OPEN_ERROR = new DOMException('Storage is blocked', 'SecurityError');

/** Imports the store anew, so no connection from an earlier test is cached. */
async function importStore(): Promise<PassSourceStoreModule> {
    vi.resetModules();
    return import('addons/webGPUPlayer/PresentationPassStore');
}

describe('PresentationPassStore', () => {
    let fake: IndexedDBFake;

    beforeEach(() => {
        fake = installIndexedDBFake();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('stores sources under keys counting up from 1, reads them back, and deletes them', async () => {
        const store = await importStore();

        expect(await store.addPassSource(SATURATION_PASS_SOURCE)).toBe(FIRST_SOURCE_KEY);
        expect(await store.addPassSource(INVERT_PASS_SOURCE)).toBe(SECOND_SOURCE_KEY);
        expect(await store.readPassSources([ SECOND_SOURCE_KEY, MISSING_SOURCE_KEY, FIRST_SOURCE_KEY ])).toEqual(new Map([
            [ SECOND_SOURCE_KEY, INVERT_PASS_SOURCE ],
            [ FIRST_SOURCE_KEY, SATURATION_PASS_SOURCE ]
        ]));

        await store.deletePassSources([ FIRST_SOURCE_KEY ]);

        expect(fake.readStore(DATABASE_NAME, SOURCE_STORE_NAME)).toEqual(new Map([ [ SECOND_SOURCE_KEY, INVERT_PASS_SOURCE ] ]));
    });

    it('opens nothing when there are no keys to read or delete', async () => {
        const store = await importStore();
        const open = vi.spyOn(indexedDB, 'open');

        expect(await store.readPassSources([])).toEqual(new Map());
        await store.deletePassSources([]);

        expect(open).not.toHaveBeenCalled();
    });

    it('reports a refused write by its code and the browser\'s error, and keeps nothing of it', async () => {
        const store = await importStore();
        fake.failNextWrite(QUOTA_ERROR);

        await expect(store.addPassSource(SATURATION_PASS_SOURCE)).rejects.toMatchObject({
            code: 'source-add-failed',
            message: `source-add-failed: ${QUOTA_ERROR.name}: ${QUOTA_ERROR.message}`
        });
        expect(fake.readStore(DATABASE_NAME, SOURCE_STORE_NAME).size).toBe(0);
    });

    it('reports a failed open, and opens again at the next operation', async () => {
        const store = await importStore();
        fake.failOpen(OPEN_ERROR);

        await expect(store.addPassSource(SATURATION_PASS_SOURCE)).rejects.toMatchObject({
            code: 'store-open-failed',
            message: `store-open-failed: ${OPEN_ERROR.name}: ${OPEN_ERROR.message}`
        });

        fake.failOpen(null);
        expect(await store.addPassSource(SATURATION_PASS_SOURCE)).toBe(FIRST_SOURCE_KEY);
    });

    it('reports a browser without IndexedDB as unavailable', async () => {
        vi.stubGlobal('indexedDB', undefined);
        const store = await importStore();

        await expect(store.readPassSources([ FIRST_SOURCE_KEY ])).rejects.toMatchObject({ code: 'store-unavailable' });
    });

    it('builds the preset from stored files in order, and names the keys it has no source for', async () => {
        const store = await importStore();
        const parameters = { [SATURATION_PARAMETER_NAME]: STORED_SATURATION };
        const files: StoredPresentationFile[] = [
            { parameters: {}, sourceKey: MISSING_SOURCE_KEY },
            { parameters, sourceKey: await store.addPassSource(SATURATION_PASS_SOURCE) },
            { parameters: {}, sourceKey: await store.addPassSource(INVERT_PASS_SOURCE) }
        ];

        expect(await store.loadStoredPresentationPreset(files)).toEqual({
            files: [ { parameters, source: SATURATION_PASS_SOURCE }, { parameters: {}, source: INVERT_PASS_SOURCE } ],
            missingSourceKeys: [ MISSING_SOURCE_KEY ]
        });
    });
});

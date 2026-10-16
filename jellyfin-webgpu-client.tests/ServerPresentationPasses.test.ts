import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addPassSource } from 'addons/webGPUPlayer/PresentationPassStore';
import { loadServerModuleCatalog, type ServerModuleCatalog, type ServerPassFile } from 'addons/webGPUPlayer/ServerModules';
import {
    getAddableServerPassFiles,
    isServerPassFileOffered,
    loadUpdatedStoredPresentationFiles
} from 'addons/webGPUPlayer/ServerPresentationPasses';
import {
    createDefaultWebGPUUserSettings,
    type StoredPresentationFile,
    type WebGPUUserSettings
} from 'addons/webGPUPlayer/WebGPUUserSettings';

import { installIndexedDBFake } from './indexedDBFake';
import { INVERT_PASS_SOURCE, SATURATION_PARAMETER_NAME, SATURATION_PASS_SOURCE, STORED_SATURATION } from './presentationPassSources';

const SATURATION_FILE_NAME = 'saturation.wgsl';
const INVERT_FILE_NAME = 'invert.wgsl';
// Two versions of one server pass file
const FIRST_HASH = 'd'.repeat(64);
const SECOND_HASH = 'e'.repeat(64);
const SERVER_UNAVAILABLE_FAILURE = 'server-unavailable: no signed-in server';
const PASS_SOURCE_DATABASE_NAME = 'webGPUPlayerPresentation';
const PASS_SOURCE_STORE_NAME = 'passSources';

const testState = vi.hoisted(() => ({
    catalog: null as ServerModuleCatalog | null,
    passSources: new Map<string, string>(),
    settingsValue: null as string | null
}));

vi.mock('scripts/settings/userSettings', () => ({
    currentSettings: {
        get: vi.fn((): string | null => testState.settingsValue),
        set: vi.fn((_name: string, value: string): void => {
            testState.settingsValue = value;
        })
    }
}));

vi.mock('addons/webGPUPlayer/ServerModules', () => ({
    fetchServerPassSource: vi.fn((fileName: string): Promise<string> => {
        const source = testState.passSources.get(fileName);
        return source === undefined ? Promise.reject(new Error(`server-request-failed: ${fileName} HTTP 404`)) : Promise.resolve(source);
    }),
    loadServerModuleCatalog: vi.fn(() => (testState.catalog === null ?
        Promise.reject(new Error(SERVER_UNAVAILABLE_FAILURE)) :
        Promise.resolve(testState.catalog)))
}));

const indexedDBFake = installIndexedDBFake();

function createPassEntry(fileName: string, contentHash: string): ServerPassFile {
    return { byteLength: 1, contentHash, fileName, passNames: [ fileName ] };
}

function createCatalog(passes: readonly ServerPassFile[]): ServerModuleCatalog {
    return { decoderPackages: [], passes };
}

function storeFiles(files: readonly StoredPresentationFile[]): void {
    const settings = createDefaultWebGPUUserSettings();
    testState.settingsValue = JSON.stringify({ ...settings, presentation: { ...settings.presentation, files } });
}

function readSavedFiles(): readonly StoredPresentationFile[] {
    return (JSON.parse(testState.settingsValue ?? '{}') as WebGPUUserSettings).presentation.files;
}

beforeEach(() => {
    indexedDBFake.install();
    indexedDBFake.clear();
    testState.catalog = null;
    testState.passSources.clear();
    testState.settingsValue = null;
    vi.mocked(loadServerModuleCatalog).mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('ServerPresentationPasses', () => {
    it('offers the server files the preset does not hold, whatever their names\' case', () => {
        const held: StoredPresentationFile = { parameters: {}, server: { contentHash: FIRST_HASH, fileName: 'Saturation.WGSL' }, sourceKey: 1 };
        const catalog = createCatalog([ createPassEntry(SATURATION_FILE_NAME, FIRST_HASH), createPassEntry(INVERT_FILE_NAME, FIRST_HASH) ]);

        expect(getAddableServerPassFiles(catalog, [ held ]).map((entry: ServerPassFile): string => entry.fileName)).toEqual([ INVERT_FILE_NAME ]);
        expect(isServerPassFileOffered(catalog, held)).toBe(true);
        expect(isServerPassFileOffered(createCatalog([]), held)).toBe(false);
        expect(isServerPassFileOffered(catalog, { parameters: {}, sourceKey: 2 })).toBe(false);
    });

    it('reads no catalog for a preset without server files', async () => {
        storeFiles([ { parameters: {}, sourceKey: await addPassSource(INVERT_PASS_SOURCE) } ]);

        await loadUpdatedStoredPresentationFiles();

        expect(loadServerModuleCatalog).not.toHaveBeenCalled();
    });

    it('replaces the source of a server file the server has a newer version of, and saves the version', async () => {
        const sourceKey = await addPassSource(INVERT_PASS_SOURCE);
        const parameters = { [SATURATION_PARAMETER_NAME]: STORED_SATURATION };
        storeFiles([ { parameters, server: { contentHash: FIRST_HASH, fileName: SATURATION_FILE_NAME }, sourceKey } ]);
        testState.catalog = createCatalog([ createPassEntry(SATURATION_FILE_NAME, SECOND_HASH) ]);
        testState.passSources.set(SATURATION_FILE_NAME, SATURATION_PASS_SOURCE);

        const files = await loadUpdatedStoredPresentationFiles();

        const updated = [ { parameters, server: { contentHash: SECOND_HASH, fileName: SATURATION_FILE_NAME }, sourceKey } ];
        expect(files).toEqual(updated);
        expect(readSavedFiles()).toEqual(updated);
        expect(indexedDBFake.readStore(PASS_SOURCE_DATABASE_NAME, PASS_SOURCE_STORE_NAME)).toEqual(new Map([ [ sourceKey, SATURATION_PASS_SOURCE ] ]));
    });

    it('keeps every file as stored when the server cannot be reached or a download fails', async () => {
        const sourceKey = await addPassSource(INVERT_PASS_SOURCE);
        const stored = [ { parameters: {}, server: { contentHash: FIRST_HASH, fileName: SATURATION_FILE_NAME }, sourceKey } ];
        storeFiles(stored);

        await expect(loadUpdatedStoredPresentationFiles()).resolves.toEqual(stored);
        expect(console.warn).toHaveBeenLastCalledWith(`WebGPU shader files: ${SERVER_UNAVAILABLE_FAILURE}`);

        testState.catalog = createCatalog([ createPassEntry(SATURATION_FILE_NAME, SECOND_HASH) ]);
        await expect(loadUpdatedStoredPresentationFiles()).resolves.toEqual(stored);
        expect(console.warn).toHaveBeenLastCalledWith(expect.stringMatching(/^WebGPU shader files: server-pass-update-failed: saturation\.wgsl /));
        expect(readSavedFiles()).toEqual(stored);
        expect(indexedDBFake.readStore(PASS_SOURCE_DATABASE_NAME, PASS_SOURCE_STORE_NAME)).toEqual(new Map([ [ sourceKey, INVERT_PASS_SOURCE ] ]));
    });
});

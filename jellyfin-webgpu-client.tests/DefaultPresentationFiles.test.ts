import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setClientDefaults } from 'addons/webGPUPlayer/ClientDefaults';
import { ensureDefaultPresentationFiles, getDefaultPresentationFiles } from 'addons/webGPUPlayer/DefaultPresentationFiles';
import { fetchServerPassSource, loadServerModuleCatalog, type ServerModuleCatalog, type ServerPassFile } from 'addons/webGPUPlayer/ServerModules';
import {
    createDefaultWebGPUUserSettings,
    MAXIMUM_PRESENTATION_FILE_COUNT,
    WEBGPU_USER_SETTINGS_STORAGE_KEY,
    type StoredPresentationFile
} from 'addons/webGPUPlayer/WebGPUUserSettings';

import { installIndexedDBFake } from './indexedDBFake';
import { INVERT_PASS_SOURCE, SATURATION_PARAMETER_NAME, SATURATION_PASS_SOURCE, STORED_SATURATION } from './presentationPassSources';

const SATURATION_FILE_NAME = 'saturation.wgsl';
const INVERT_FILE_NAME = 'invert.wgsl';
// Two versions of one server pass file
const FIRST_HASH = 'd'.repeat(64);
const SECOND_HASH = 'e'.repeat(64);
const CHANGED_SATURATION = 1.5;
const CACHE_STORAGE_KEY = 'webGPUDefaultPresentationFiles';
const SERVER_UNAVAILABLE_FAILURE = 'server-unavailable: no signed-in server';
const PASS_SOURCE_DATABASE_NAME = 'webGPUPlayerPresentation';
const PASS_SOURCE_STORE_NAME = 'passSources';

const testState = vi.hoisted(() => ({
    catalog: null as ServerModuleCatalog | null,
    // Runs as a pass file downloads, before its source arrives
    onDownload: null as (() => void) | null,
    passSources: new Map<string, string>(),
    // The user's local settings by name
    storage: new Map<string, string>()
}));

vi.mock('scripts/settings/userSettings', () => ({
    currentSettings: {
        get: vi.fn((name: string): string | null => testState.storage.get(name) ?? null),
        set: vi.fn((name: string, value: string): void => {
            testState.storage.set(name, value);
        })
    }
}));

vi.mock('addons/webGPUPlayer/ServerModules', () => ({
    fetchServerPassSource: vi.fn((fileName: string): Promise<string> => {
        testState.onDownload?.();
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

/** Offers the saturation and invert files, the saturation file in the given version. */
function offerPasses(saturationHash: string): void {
    testState.catalog = { decoderPackages: [], passes: [ createPassEntry(SATURATION_FILE_NAME, saturationHash), createPassEntry(INVERT_FILE_NAME, FIRST_HASH) ] };
    testState.passSources.set(SATURATION_FILE_NAME, SATURATION_PASS_SOURCE);
    testState.passSources.set(INVERT_FILE_NAME, INVERT_PASS_SOURCE);
}

/** Stores a preset of the user's own. */
function storeOwnFiles(files: readonly StoredPresentationFile[]): void {
    const settings = createDefaultWebGPUUserSettings();
    testState.storage.set(WEBGPU_USER_SETTINGS_STORAGE_KEY, JSON.stringify({ ...settings, presentation: { ...settings.presentation, files } }));
}

function readStoredSources(): ReadonlyMap<number, unknown> {
    return indexedDBFake.readStore(PASS_SOURCE_DATABASE_NAME, PASS_SOURCE_STORE_NAME);
}

/** Returns a default file as the cache keeps it. */
function createDefaultFile(fileName: string, contentHash: string, sourceKey: number, parameters: Readonly<Record<string, number>> = {}): StoredPresentationFile {
    return { parameters, server: { contentHash, fileName }, sourceKey };
}

beforeEach(() => {
    indexedDBFake.install();
    indexedDBFake.clear();
    testState.catalog = null;
    testState.onDownload = null;
    testState.passSources.clear();
    testState.storage.clear();
    vi.mocked(fetchServerPassSource).mockClear();
    vi.mocked(loadServerModuleCatalog).mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
    setClientDefaults({});
    vi.restoreAllMocks();
});

describe('DefaultPresentationFiles', () => {
    it('reads no catalog and stores nothing when the server sets no default preset', async () => {
        await expect(ensureDefaultPresentationFiles()).resolves.toEqual([]);

        expect(loadServerModuleCatalog).not.toHaveBeenCalled();
        expect(testState.storage.has(CACHE_STORAGE_KEY)).toBe(false);
        expect(getDefaultPresentationFiles()).toEqual([]);
    });

    it('stores the offered files of the server\'s preset in order, whatever their names\' case, leaving out the others', async () => {
        offerPasses(FIRST_HASH);
        setClientDefaults({
            presentationFiles: [
                { fileName: 'Saturation.WGSL', parameters: { [SATURATION_PARAMETER_NAME]: STORED_SATURATION, text: '0.5' } },
                { fileName: 'withdrawn.wgsl', parameters: {} },
                { fileName: ' ', parameters: {} },
                INVERT_FILE_NAME,
                { fileName: INVERT_FILE_NAME }
            ]
        });

        const files = await ensureDefaultPresentationFiles();

        const expected = [
            createDefaultFile(SATURATION_FILE_NAME, FIRST_HASH, 1, { [SATURATION_PARAMETER_NAME]: STORED_SATURATION }),
            createDefaultFile(INVERT_FILE_NAME, FIRST_HASH, 2)
        ];
        expect(files).toEqual(expected);
        expect(getDefaultPresentationFiles()).toEqual(expected);
        expect(readStoredSources()).toEqual(new Map([ [ 1, SATURATION_PASS_SOURCE ], [ 2, INVERT_PASS_SOURCE ] ]));
        expect(console.warn).toHaveBeenCalledWith('WebGPU default shader files: default-file-unoffered: withdrawn.wgsl');
        expect(console.warn).toHaveBeenCalledWith('WebGPU default shader files: default-file-invalid: presentationFiles[2]');
        expect(console.warn).toHaveBeenCalledWith('WebGPU default shader files: default-file-invalid: presentationFiles[3]');
    });

    it('keeps the files a preset holds at most', async () => {
        offerPasses(FIRST_HASH);
        setClientDefaults({ presentationFiles: Array.from({ length: MAXIMUM_PRESENTATION_FILE_COUNT + 1 }, () => ({ fileName: INVERT_FILE_NAME })) });

        await expect(ensureDefaultPresentationFiles()).resolves.toHaveLength(MAXIMUM_PRESENTATION_FILE_COUNT);
    });

    it('reuses the stored files without a download while the server\'s preset and versions stay, sharing one update between callers', async () => {
        offerPasses(FIRST_HASH);
        setClientDefaults({ presentationFiles: [ { fileName: SATURATION_FILE_NAME } ] });

        const [ first, second ] = await Promise.all([ ensureDefaultPresentationFiles(), ensureDefaultPresentationFiles() ]);
        const later = await ensureDefaultPresentationFiles();

        expect(first).toEqual([ createDefaultFile(SATURATION_FILE_NAME, FIRST_HASH, 1) ]);
        expect(second).toEqual(first);
        expect(later).toEqual(first);
        expect(fetchServerPassSource).toHaveBeenCalledTimes(1);
    });

    it('stores the files again for a new version or new parameters, and deletes the replaced sources', async () => {
        offerPasses(FIRST_HASH);
        setClientDefaults({ presentationFiles: [ { fileName: SATURATION_FILE_NAME } ] });
        await ensureDefaultPresentationFiles();

        offerPasses(SECOND_HASH);
        await expect(ensureDefaultPresentationFiles()).resolves.toEqual([ createDefaultFile(SATURATION_FILE_NAME, SECOND_HASH, 2) ]);
        expect(readStoredSources()).toEqual(new Map([ [ 2, SATURATION_PASS_SOURCE ] ]));

        setClientDefaults({ presentationFiles: [ { fileName: SATURATION_FILE_NAME, parameters: { [SATURATION_PARAMETER_NAME]: CHANGED_SATURATION } } ] });
        await expect(ensureDefaultPresentationFiles()).resolves.toEqual([
            createDefaultFile(SATURATION_FILE_NAME, SECOND_HASH, 3, { [SATURATION_PARAMETER_NAME]: CHANGED_SATURATION })
        ]);
        expect(readStoredSources()).toEqual(new Map([ [ 3, SATURATION_PASS_SOURCE ] ]));

        // A server that drops its preset needs no catalog to empty the default files
        setClientDefaults({});
        vi.mocked(loadServerModuleCatalog).mockClear();
        await expect(ensureDefaultPresentationFiles()).resolves.toEqual([]);
        expect(loadServerModuleCatalog).not.toHaveBeenCalled();
        expect(readStoredSources().size).toBe(0);
    });

    it('starts another update for a default preset that changes while one runs, so a later caller gets files of the newer preset', async () => {
        offerPasses(FIRST_HASH);
        setClientDefaults({ presentationFiles: [ { fileName: SATURATION_FILE_NAME } ] });
        const later: { files?: Promise<readonly StoredPresentationFile[]> } = {};
        // The server's default preset changes while the first update downloads, and the player asks for the files again
        testState.onDownload = (): void => {
            testState.onDownload = null;
            setClientDefaults({ presentationFiles: [ { fileName: INVERT_FILE_NAME } ] });
            later.files = ensureDefaultPresentationFiles();
        };

        await expect(ensureDefaultPresentationFiles()).resolves.toEqual([ createDefaultFile(SATURATION_FILE_NAME, FIRST_HASH, 1) ]);
        await expect(later.files).resolves.toEqual([ createDefaultFile(INVERT_FILE_NAME, FIRST_HASH, 2) ]);
        expect(getDefaultPresentationFiles()).toEqual([ createDefaultFile(INVERT_FILE_NAME, FIRST_HASH, 2) ]);
        expect(readStoredSources()).toEqual(new Map([ [ 2, INVERT_PASS_SOURCE ] ]));
    });

    it('keeps a replaced source the user\'s own preset took over meanwhile', async () => {
        offerPasses(FIRST_HASH);
        setClientDefaults({ presentationFiles: [ { fileName: SATURATION_FILE_NAME } ] });
        const [ firstFile ] = await ensureDefaultPresentationFiles();

        offerPasses(SECOND_HASH);
        // The user edits the default preset while the new version downloads, which makes it their own
        testState.onDownload = (): void => {
            storeOwnFiles([ firstFile ]);
        };
        await ensureDefaultPresentationFiles();

        expect(readStoredSources()).toEqual(new Map([ [ firstFile.sourceKey, SATURATION_PASS_SOURCE ], [ 2, SATURATION_PASS_SOURCE ] ]));
    });

    it('keeps the files stored before when a download fails, and deletes the sources the attempt stored', async () => {
        offerPasses(FIRST_HASH);
        setClientDefaults({ presentationFiles: [ { fileName: SATURATION_FILE_NAME } ] });
        const before = await ensureDefaultPresentationFiles();

        setClientDefaults({ presentationFiles: [ { fileName: SATURATION_FILE_NAME }, { fileName: INVERT_FILE_NAME } ] });
        testState.passSources.delete(INVERT_FILE_NAME);

        await expect(ensureDefaultPresentationFiles()).resolves.toEqual(before);
        expect(getDefaultPresentationFiles()).toEqual(before);
        expect(readStoredSources()).toEqual(new Map([ [ before[0].sourceKey, SATURATION_PASS_SOURCE ] ]));
        expect(console.warn).toHaveBeenLastCalledWith(expect.stringMatching(/^WebGPU default shader files: default-files-failed: server-request-failed: invert\.wgsl /));
    });

    it('keeps the files stored before when the server cannot be reached', async () => {
        offerPasses(FIRST_HASH);
        setClientDefaults({ presentationFiles: [ { fileName: SATURATION_FILE_NAME } ] });
        const before = await ensureDefaultPresentationFiles();

        testState.catalog = null;
        setClientDefaults({ presentationFiles: [ { fileName: INVERT_FILE_NAME } ] });

        await expect(ensureDefaultPresentationFiles()).resolves.toEqual(before);
        expect(console.warn).toHaveBeenLastCalledWith(`WebGPU default shader files: ${SERVER_UNAVAILABLE_FAILURE}`);
    });

    it('stores nothing for a user with a preset of their own', async () => {
        offerPasses(FIRST_HASH);
        setClientDefaults({ presentationFiles: [ { fileName: SATURATION_FILE_NAME } ] });
        storeOwnFiles([]);

        await expect(ensureDefaultPresentationFiles()).resolves.toEqual([]);
        expect(loadServerModuleCatalog).not.toHaveBeenCalled();
        expect(readStoredSources().size).toBe(0);
    });
});

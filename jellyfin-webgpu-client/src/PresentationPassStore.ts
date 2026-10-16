import type { PresentationPresetFile } from 'webgpu-player/presentation/WebGPUPresenter';

import type { StoredPresentationFile } from './WebGPUUserSettings';

// The pass source store: the sources of the users' shader files in IndexedDB, which the settings in local storage refer to by key
// Local storage holds about 5 MB for everything on the origin, which shader networks of several passes would exhaust

const DATABASE_NAME = 'webGPUPlayerPresentation';
const DATABASE_VERSION = 1;
const SOURCE_STORE_NAME = 'passSources';
const MISSING_ERROR_DETAIL = 'no error';

/** The step of the pass source store that failed. */
export type PassSourceStoreFailure =
    | 'source-add-failed'
    | 'source-delete-failed'
    | 'source-read-failed'
    | 'source-replace-failed'
    | 'store-open-failed'
    | 'store-unavailable';

/** A failed pass source store operation: its code, then a terse detail of what failed. */
export class PassSourceStoreError extends Error {
    readonly code: PassSourceStoreFailure;

    constructor(code: PassSourceStoreFailure, detail: string) {
        super(`${code}: ${detail}`);
        this.name = 'PassSourceStoreError';
        this.code = code;
    }
}

/** The presenter's preset built from stored files: the files the store has sources for, in order, and the keys it has none for. */
export type StoredPresentationPreset = Readonly<{
    files: readonly PresentationPresetFile[]
    missingSourceKeys: readonly number[]
}>;

// One connection per page, opened by the first operation that needs it
let databasePromise: Promise<IDBDatabase> | null = null;

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function describeDOMException(error: DOMException | null): string {
    return error ? `${error.name}: ${error.message}` : MISSING_ERROR_DETAIL;
}

function requestDatabase(): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve: (database: IDBDatabase) => void, reject: (error: PassSourceStoreError) => void): void => {
        if (typeof indexedDB === 'undefined') {
            reject(new PassSourceStoreError('store-unavailable', 'indexedDB is undefined'));
            return;
        }
        let request: IDBOpenDBRequest;
        try {
            request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        } catch (error) {
            // Opening throws where the browser blocks storage for the page
            reject(new PassSourceStoreError('store-open-failed', getErrorMessage(error)));
            return;
        }
        request.onupgradeneeded = (): void => {
            request.result.createObjectStore(SOURCE_STORE_NAME, { autoIncrement: true });
        };
        request.onsuccess = (): void => {
            const database = request.result;
            // A newer version opened in another tab asks this connection to close; the next operation opens it again
            database.onversionchange = (): void => {
                database.close();
                databasePromise = null;
            };
            resolve(database);
        };
        request.onerror = (): void => {
            reject(new PassSourceStoreError('store-open-failed', describeDOMException(request.error)));
        };
    });
}

/** Returns the page's connection, opening it once; a failed open is tried again by the next operation. */
function openDatabase(): Promise<IDBDatabase> {
    if (databasePromise === null) {
        const opening = requestDatabase();
        databasePromise = opening;
        opening.catch((): void => {
            if (databasePromise === opening) {
                databasePromise = null;
            }
        });
    }
    return databasePromise;
}

/** Runs requests in one transaction of the source store, and resolves with their reading once it commits; a failed request aborts it. */
async function runTransaction<Result>(
    mode: IDBTransactionMode,
    failure: PassSourceStoreFailure,
    createRequests: (store: IDBObjectStore) => readonly IDBRequest[],
    readResults: (requests: readonly IDBRequest[]) => Result
): Promise<Result> {
    const database = await openDatabase();
    return new Promise<Result>((resolve: (result: Result) => void, reject: (error: PassSourceStoreError) => void): void => {
        try {
            const transaction = database.transaction(SOURCE_STORE_NAME, mode);
            const requests = createRequests(transaction.objectStore(SOURCE_STORE_NAME));
            transaction.oncomplete = (): void => {
                try {
                    resolve(readResults(requests));
                } catch (error) {
                    reject(new PassSourceStoreError(failure, getErrorMessage(error)));
                }
            };
            transaction.onabort = (): void => {
                reject(new PassSourceStoreError(failure, describeDOMException(transaction.error)));
            };
        } catch (error) {
            // A closed connection throws when a transaction starts
            reject(new PassSourceStoreError(failure, getErrorMessage(error)));
        }
    });
}

/** Stores a file's source, and resolves with its new key once the write commits. */
export function addPassSource(source: string): Promise<number> {
    return runTransaction(
        'readwrite',
        'source-add-failed',
        (store: IDBObjectStore): readonly IDBRequest[] => [ store.add(source) ],
        (requests: readonly IDBRequest[]): number => {
            const key: unknown = requests[0].result;
            if (typeof key !== 'number') {
                throw new TypeError(`key ${String(key)} is not a number`);
            }
            return key;
        }
    );
}

/** Replaces the source under a key, as a newer version of a server pass file replaces the old one, and resolves once the write commits. */
export function replacePassSource(key: number, source: string): Promise<void> {
    return runTransaction(
        'readwrite',
        'source-replace-failed',
        (store: IDBObjectStore): readonly IDBRequest[] => [ store.put(source, key) ],
        (): void => undefined
    );
}

/** Reads the sources of the keys in one transaction; a key the store has no source for is absent from the map. */
export async function readPassSources(keys: readonly number[]): Promise<Map<number, string>> {
    const sources = new Map<number, string>();
    // Without keys there is nothing stored to read, so the database stays closed
    if (keys.length === 0) {
        return sources;
    }
    return runTransaction(
        'readonly',
        'source-read-failed',
        (store: IDBObjectStore): readonly IDBRequest[] => keys.map((key: number): IDBRequest => store.get(key)),
        (requests: readonly IDBRequest[]): Map<number, string> => {
            for (const [ keyIndex, request ] of requests.entries()) {
                const source: unknown = request.result;
                if (typeof source === 'string') {
                    sources.set(keys[keyIndex], source);
                }
            }
            return sources;
        }
    );
}

/** Deletes the sources of the keys in one transaction. */
export async function deletePassSources(keys: readonly number[]): Promise<void> {
    if (keys.length === 0) {
        return;
    }
    await runTransaction(
        'readwrite',
        'source-delete-failed',
        (store: IDBObjectStore): readonly IDBRequest[] => keys.map((key: number): IDBRequest => store.delete(key)),
        (): void => undefined
    );
}

/** Returns the store keys of the stored files, in order. */
export function getStoredFileSourceKeys(files: readonly StoredPresentationFile[]): number[] {
    return files.map((file: StoredPresentationFile): number => file.sourceKey);
}

/** Returns the source read for a stored file's key, or null when the store has none for it. */
export function getStoredFileSource(file: StoredPresentationFile, sources: ReadonlyMap<number, string>): string | null {
    return sources.get(file.sourceKey) ?? null;
}

/** Builds the presenter's preset from stored files and the sources read for their keys, leaving out each file the store has no source for. */
export function createStoredPresentationPreset(
    files: readonly StoredPresentationFile[],
    sources: ReadonlyMap<number, string>
): StoredPresentationPreset {
    const missingSourceKeys: number[] = [];
    const presetFiles: PresentationPresetFile[] = [];
    for (const file of files) {
        const source = getStoredFileSource(file, sources);
        if (source === null) {
            missingSourceKeys.push(file.sourceKey);
        } else {
            presetFiles.push({ parameters: file.parameters, source });
        }
    }
    return { files: presetFiles, missingSourceKeys };
}

/** Reads the stored files' sources from the store and builds the presenter's preset from them. */
export async function loadStoredPresentationPreset(files: readonly StoredPresentationFile[]): Promise<StoredPresentationPreset> {
    return createStoredPresentationPreset(files, await readPassSources(getStoredFileSourceKeys(files)));
}

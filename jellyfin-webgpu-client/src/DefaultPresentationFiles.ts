import { currentSettings } from 'scripts/settings/userSettings';

import { getClientDefaults } from './ClientDefaults';
import { deletePassSources, getStoredFileSourceKeys } from './PresentationPassStore';
import { loadServerModuleCatalog, type ServerModuleCatalog, type ServerPassFile } from './ServerModules';
import { addServerPassFile, getServerFileKey } from './ServerPresentationPasses';
import {
    loadWebGPUUserSettings,
    MAXIMUM_PRESENTATION_FILE_COUNT,
    MAXIMUM_SERVER_PASS_FILE_NAME_LENGTH,
    normalizePresentationFiles,
    normalizePresentationParameters,
    type StoredPresentationFile
} from './WebGPUUserSettings';

// The shader preset an administrator sets as the server's default, for the users whose settings follow it.
// Its files download from the server's pass files into the pass source store, and a per-user cache keeps them with the signature of what they were made from,
// so later pages reuse them until the server's preset, a parameter of it, or one of its files' versions changes

const CACHE_STORAGE_KEY = 'webGPUDefaultPresentationFiles';
const WARNING_PREFIX = 'WebGPU default shader files';

/** One file of the server's default preset: the name of the server pass file it is, and its parameter values. */
type DefaultPresentationFile = Readonly<{
    fileName: string
    parameters: Readonly<Record<string, number>>
}>;

/** A file of the server's default preset with the server pass file it names. */
type ResolvedDefaultPresentationFile = Readonly<{
    entry: ServerPassFile
    parameters: Readonly<Record<string, number>>
}>;

/** The default preset's files in the pass source store, and the signature of the server files and parameters they were made from. */
type DefaultPresentationCache = Readonly<{
    files: readonly StoredPresentationFile[]
    signature: string
}>;

const EMPTY_CACHE: DefaultPresentationCache = Object.freeze({ files: [], signature: getSignature([]) });

/** An update and the server's default preset it reads, as JSON. */
type PendingUpdate = Readonly<{
    defaultFilesText: string
    promise: Promise<readonly StoredPresentationFile[]>
}>;

// The latest update, which every caller of the same default preset shares
let pendingUpdate: PendingUpdate | null = null;

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Returns what a resolved preset was made from: each file's name, version, and parameter values, in order. */
function getSignature(files: readonly ResolvedDefaultPresentationFile[]): string {
    return JSON.stringify(files.map((file: ResolvedDefaultPresentationFile): unknown[] => [
        file.entry.fileName,
        file.entry.contentHash,
        file.parameters
    ]));
}

/** Reads one file of the server's default preset, or null for a value that names no server pass file; its parameters are read as stored parameters are. */
function readDefaultFile(value: unknown): DefaultPresentationFile | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return null;
    }
    const { fileName, parameters } = value as Record<string, unknown>;
    if (typeof fileName !== 'string' || fileName.trim().length === 0 || fileName.length > MAXIMUM_SERVER_PASS_FILE_NAME_LENGTH) {
        return null;
    }
    return { fileName, parameters: normalizePresentationParameters(parameters) };
}

/** Reads the server's default preset in order, up to the files a preset holds at most; each file it cannot hold is named and left out. */
function readDefaultFiles(): DefaultPresentationFile[] {
    const value = getClientDefaults().presentationFiles;
    const files: DefaultPresentationFile[] = [];
    if (value === undefined) {
        return files;
    }
    if (!Array.isArray(value)) {
        console.warn(`${WARNING_PREFIX}: default-invalid: presentationFiles`);
        return files;
    }
    for (const [ index, candidate ] of (value as unknown[]).entries()) {
        const file = readDefaultFile(candidate);
        if (file === null) {
            console.warn(`${WARNING_PREFIX}: default-file-invalid: presentationFiles[${index}]`);
            continue;
        }
        if (files.length >= MAXIMUM_PRESENTATION_FILE_COUNT) {
            console.warn(`${WARNING_PREFIX}: default-files-over-limit: presentationFiles[${index}] and later`);
            break;
        }
        files.push(file);
    }
    return files;
}

/** Matches each default file to the server pass file it names, whatever the name's case, in order; a file the server does not offer is named and left out. */
function resolveDefaultFiles(files: readonly DefaultPresentationFile[], catalog: ServerModuleCatalog): ResolvedDefaultPresentationFile[] {
    const resolvedFiles: ResolvedDefaultPresentationFile[] = [];
    for (const file of files) {
        const entry = catalog.passes.find((candidate: ServerPassFile): boolean => getServerFileKey(candidate.fileName) === getServerFileKey(file.fileName));
        if (entry === undefined) {
            console.warn(`${WARNING_PREFIX}: default-file-unoffered: ${file.fileName}`);
            continue;
        }
        resolvedFiles.push({ entry, parameters: file.parameters });
    }
    return resolvedFiles;
}

/** Reads this user's cache; a missing or unreadable one holds no files. */
function readCache(): DefaultPresentationCache {
    try {
        const serializedCache = currentSettings.get(CACHE_STORAGE_KEY, false);
        if (!serializedCache) {
            return EMPTY_CACHE;
        }
        const value: unknown = JSON.parse(serializedCache);
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return EMPTY_CACHE;
        }
        const { files, signature } = value as Record<string, unknown>;
        return typeof signature === 'string' ? { files: normalizePresentationFiles(files), signature } : EMPTY_CACHE;
    } catch {
        return EMPTY_CACHE;
    }
}

/** Deletes the sources of the keys, naming a failure; the sources then stay unused. */
async function deleteSources(keys: readonly number[]): Promise<void> {
    if (keys.length === 0) {
        return;
    }
    try {
        await deletePassSources(keys);
    } catch (error) {
        console.warn(`${WARNING_PREFIX}: ${getErrorMessage(error)}`);
    }
}

/**
 * Stores each resolved file's source and caches the files under the signature, all or nothing: a failure deletes the sources this attempt stored and rejects.
 * Each file takes the default preset's parameter values.
 */
async function materializeFiles(resolvedFiles: readonly ResolvedDefaultPresentationFile[], signature: string): Promise<StoredPresentationFile[]> {
    const files: StoredPresentationFile[] = [];
    try {
        for (const resolvedFile of resolvedFiles) {
            const added = await addServerPassFile(resolvedFile.entry);
            files.push({ ...added.file, parameters: resolvedFile.parameters });
        }
        currentSettings.set(CACHE_STORAGE_KEY, JSON.stringify({ files, signature }), false);
    } catch (error) {
        await deleteSources(getStoredFileSourceKeys(files));
        throw error;
    }
    return files;
}

/** Brings the cache up to the server's default preset for a user who follows it, and returns the default files. */
async function updateDefaultFiles(): Promise<readonly StoredPresentationFile[]> {
    const cache = readCache();
    if (loadWebGPUUserSettings().presentation.files !== null) {
        return cache.files;
    }
    const defaultFiles = readDefaultFiles();
    let resolvedFiles: ResolvedDefaultPresentationFile[] = [];
    // A server without a default preset needs no catalog
    if (defaultFiles.length > 0) {
        try {
            resolvedFiles = resolveDefaultFiles(defaultFiles, await loadServerModuleCatalog());
        } catch (error) {
            console.warn(`${WARNING_PREFIX}: ${getErrorMessage(error)}`);
            return cache.files;
        }
    }
    const signature = getSignature(resolvedFiles);
    if (signature === cache.signature) {
        return cache.files;
    }
    let files: StoredPresentationFile[];
    try {
        files = await materializeFiles(resolvedFiles, signature);
    } catch (error) {
        console.warn(`${WARNING_PREFIX}: default-files-failed: ${getErrorMessage(error)}`);
        return cache.files;
    }
    // The replaced files' sources go, unless the user's own preset took them over meanwhile
    const heldKeys = new Set<number>([
        ...getStoredFileSourceKeys(files),
        ...getStoredFileSourceKeys(loadWebGPUUserSettings().presentation.files ?? [])
    ]);
    await deleteSources(getStoredFileSourceKeys(cache.files).filter((key: number): boolean => !heldKeys.has(key)));
    return files;
}

/** Returns this user's default shader files as last made from the server's default preset, or none before any were. */
export function getDefaultPresentationFiles(): readonly StoredPresentationFile[] {
    return readCache().files;
}

/**
 * Makes the server's default preset this user's default shader files, once per preset and file version, and returns them.
 * A user with a preset of their own needs none; a failure keeps the files made before and is logged, so this never rejects.
 * A default preset that changes while an update runs starts another once that one settles, so the caller gets files of the preset it asked under.
 */
export function ensureDefaultPresentationFiles(): Promise<readonly StoredPresentationFile[]> {
    const defaultFilesText = JSON.stringify(getClientDefaults().presentationFiles ?? null);
    if (pendingUpdate?.defaultFilesText === defaultFilesText) {
        return pendingUpdate.promise;
    }
    // Updates run one at a time, since each replaces the cache and deletes the sources the one before made
    const previousUpdate: Promise<unknown> = pendingUpdate?.promise ?? Promise.resolve();
    const promise = previousUpdate.then(updateDefaultFiles).finally((): void => {
        if (pendingUpdate?.promise === promise) {
            pendingUpdate = null;
        }
    });
    pendingUpdate = { defaultFilesText, promise };
    return promise;
}

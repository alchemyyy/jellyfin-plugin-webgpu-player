import { addPassSource, replacePassSource } from './PresentationPassStore';
import {
    fetchServerPassSource,
    loadServerModuleCatalog,
    type ServerModuleCatalog,
    type ServerPassFile
} from './ServerModules';
import {
    isPresentationPassSource,
    loadWebGPUUserSettings,
    saveWebGPUUserSettings,
    type StoredPresentationFile
} from './WebGPUUserSettings';

// The pass files the server offers, as a user's preset holds them.
// Adding one downloads it then and stores its source like a file of the user's own, and a newer version the server offers later replaces that source under its key,
// so the file keeps its place and its parameter values

const WARNING_PREFIX = 'WebGPU shader files';

/** The step of a server pass file change that failed. */
export type ServerPassFailure = 'server-pass-invalid';

/** A server pass file the preset cannot hold: its code, then the file's name. */
export class ServerPassError extends Error {
    readonly code: ServerPassFailure;

    constructor(code: ServerPassFailure, detail: string) {
        super(`${code}: ${detail}`);
        this.name = 'ServerPassError';
        this.code = code;
    }
}

/** A server pass file the preset gained: the stored file, and its source. */
export type AddedServerPassFile = Readonly<{
    file: StoredPresentationFile
    source: string
}>;

/** The preset's files after the server's newer versions replaced their sources: each file with its version, the new sources by key, and each file that failed. */
export type ServerPassFileUpdate = Readonly<{
    failures: readonly string[]
    files: readonly StoredPresentationFile[]
    sources: ReadonlyMap<number, string>
    updatedFileNames: readonly string[]
}>;

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Server pass file names are one identity whatever their case, as the server plugin keys them. */
function getServerFileKey(fileName: string): string {
    return fileName.toLowerCase();
}

/** Downloads a server pass file's source, refusing one the preset cannot hold. */
async function downloadPassSource(entry: ServerPassFile): Promise<string> {
    const source = await fetchServerPassSource(entry.fileName);
    if (!isPresentationPassSource(source)) {
        throw new ServerPassError('server-pass-invalid', entry.fileName);
    }
    return source;
}

/** Downloads a server pass file and stores its source; rejects with the failed request, a source the preset cannot hold, or the store's failure. */
export async function addServerPassFile(entry: ServerPassFile): Promise<AddedServerPassFile> {
    const source = await downloadPassSource(entry);
    const sourceKey = await addPassSource(source);
    return {
        file: { parameters: {}, server: { contentHash: entry.contentHash, fileName: entry.fileName }, sourceKey },
        source
    };
}

/** Returns the server's pass files the preset does not hold yet, in catalog order. */
export function getAddableServerPassFiles(catalog: ServerModuleCatalog, files: readonly StoredPresentationFile[]): ServerPassFile[] {
    const heldKeys = new Set<string>();
    for (const file of files) {
        if (file.server) {
            heldKeys.add(getServerFileKey(file.server.fileName));
        }
    }
    return catalog.passes.filter((entry: ServerPassFile): boolean => !heldKeys.has(getServerFileKey(entry.fileName)));
}

/** Returns whether the server still offers a stored file's server pass file. */
export function isServerPassFileOffered(catalog: ServerModuleCatalog, file: StoredPresentationFile): boolean {
    const server = file.server;
    return server !== undefined
        && catalog.passes.some((entry: ServerPassFile): boolean => getServerFileKey(entry.fileName) === getServerFileKey(server.fileName));
}

/**
 * Replaces the stored source of each server file whose version on the server changed.
 * A file the server no longer offers keeps its source, and one whose download fails keeps its version and is named in the failures.
 */
export async function updateServerPassFiles(
    files: readonly StoredPresentationFile[],
    catalog: ServerModuleCatalog
): Promise<ServerPassFileUpdate> {
    const offered = new Map<string, ServerPassFile>(catalog.passes.map((entry: ServerPassFile): [ string, ServerPassFile ] => [ getServerFileKey(entry.fileName), entry ]));
    const failures: string[] = [];
    const sources = new Map<number, string>();
    const updatedFileNames: string[] = [];
    const updatedFiles: StoredPresentationFile[] = [];
    for (const file of files) {
        const entry = file.server ? offered.get(getServerFileKey(file.server.fileName)) : undefined;
        if (!entry || entry.contentHash === file.server?.contentHash) {
            updatedFiles.push(file);
            continue;
        }
        try {
            const source = await downloadPassSource(entry);
            await replacePassSource(file.sourceKey, source);
            sources.set(file.sourceKey, source);
            updatedFileNames.push(entry.fileName);
            updatedFiles.push({ ...file, server: { contentHash: entry.contentHash, fileName: entry.fileName } });
        } catch (error) {
            failures.push(`${entry.fileName} ${getErrorMessage(error)}`);
            updatedFiles.push(file);
        }
    }
    return { failures, files: updatedFiles, sources, updatedFileNames };
}

/**
 * Returns the stored preset's files once the server's newer versions replaced their sources, saving the new versions.
 * A preset without server files reads no catalog, and a server that cannot be reached leaves every file as stored.
 */
export async function loadUpdatedStoredPresentationFiles(): Promise<readonly StoredPresentationFile[]> {
    const settings = loadWebGPUUserSettings();
    const files = settings.presentation.files;
    if (!files.some((file: StoredPresentationFile): boolean => file.server !== undefined)) {
        return files;
    }
    let catalog: ServerModuleCatalog;
    try {
        catalog = await loadServerModuleCatalog();
    } catch (error) {
        console.warn(`${WARNING_PREFIX}: ${getErrorMessage(error)}`);
        return files;
    }
    const update = await updateServerPassFiles(files, catalog);
    for (const failure of update.failures) {
        console.warn(`${WARNING_PREFIX}: server-pass-update-failed: ${failure}`);
    }
    if (update.updatedFileNames.length > 0) {
        try {
            saveWebGPUUserSettings({ ...settings, presentation: { ...settings.presentation, files: update.files } });
        } catch (error) {
            // The new sources are stored already, so the next update downloads them again and changes nothing else
            console.warn(`${WARNING_PREFIX}: settings-save-failed: ${getErrorMessage(error)}`);
        }
    }
    return update.files;
}

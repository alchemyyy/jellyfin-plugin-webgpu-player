import { ServerConnections } from 'lib/jellyfin-apiclient';

import type { CustomAudioCodec } from 'webgpu-player/capability/CustomDecodeCapabilities';
import type { GPUVideoDecodeTarget } from 'webgpu-player/capability/CustomPlaybackEligibility';
import {
    DECODER_PACKAGE_FILE_EXTENSION,
    loadDecoderPackage,
    type AudioDecoderPackage,
    type DecoderPackage,
    type VideoDecoderPackage
} from 'webgpu-player/decode/packages/DecoderPackage';
import DecoderPackageStore, { DecoderPackageStoreError } from 'webgpu-player/decode/packages/DecoderPackageStore';

import type { DecoderPackageRouteSummary } from './custom/CustomDeviceProfile';

// The decoder packages and pass files the server plugin offers: its catalog, and each file fetched only when a playback or the user needs it.
// A fetched package stays in IndexedDB under its id, so later pages load it without a download until the server offers another version

const CATALOG_PATH = 'WebGPUPlayer/Catalog';
const DECODER_PACKAGE_PATH = 'WebGPUPlayer/DecoderPackages';
const PASS_PATH = 'WebGPUPlayer/Passes';
const DATABASE_NAME = 'webGPUPlayerServerDecoders';
// A negotiation and its playback's eligibility read one catalog; a later playback reads it again
const CATALOG_REUSE_MILLISECONDS = 60_000;
const WARNING_PREFIX = 'WebGPU server modules';
const VIDEO_KIND = 'video';
const AUDIO_KIND = 'audio';

/** A decoder package the server offers, as its catalog describes it. */
export type ServerDecoderPackage = Readonly<{
    byteLength: number
    codecs: readonly string[]
    contentHash: string
    id: string
    kind: 'audio' | 'video'
    monochrome: boolean
    name: string
    outputFormats: readonly string[]
}>;

/** A pass file the server offers, as its catalog describes it. */
export type ServerPassFile = Readonly<{
    byteLength: number
    contentHash: string
    fileName: string
    passNames: readonly string[]
}>;

/** What the server offers; a server without the plugin's routes, or a failed request, offers nothing. */
export type ServerModuleCatalog = Readonly<{
    decoderPackages: readonly ServerDecoderPackage[]
    passes: readonly ServerPassFile[]
}>;

/** The step of a server module request that failed. */
export type ServerModuleFailure =
    | 'catalog-invalid'
    | 'server-request-failed'
    | 'server-unavailable';

/** A failed server module request: its code, then a terse detail of what failed. */
export class ServerModuleError extends Error {
    readonly code: ServerModuleFailure;

    constructor(code: ServerModuleFailure, detail: string) {
        super(`${code}: ${detail}`);
        this.name = 'ServerModuleError';
        this.code = code;
    }
}

/** The part of the host's API client the server modules use. */
type ServerApiClient = Readonly<{
    accessToken: () => string
    getUrl: (name: string) => string
    serverId: () => string
}>;

type CatalogRequest = {
    promise: Promise<ServerModuleCatalog>
    requestedAtMilliseconds: number
};

type LoadedPackage = {
    contentHash: string
    promise: Promise<DecoderPackage>
};

const EMPTY_CATALOG: ServerModuleCatalog = Object.freeze({ decoderPackages: [], passes: [] });

const packageStore = new DecoderPackageStore(DATABASE_NAME);
// Each server's latest catalog request; a failed request is not kept
const catalogRequests = new Map<string, CatalogRequest>();
// The packages this page loaded, by id, with the version each holds; a newer version the catalog names replaces its entry
const loadedPackages = new Map<string, LoadedPackage>();

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item: unknown): boolean => typeof item === 'string');
}

function isServerDecoderPackage(value: unknown): value is ServerDecoderPackage {
    return isRecord(value)
        && typeof value.id === 'string'
        && typeof value.name === 'string'
        && (value.kind === VIDEO_KIND || value.kind === AUDIO_KIND)
        && isStringArray(value.codecs)
        && isStringArray(value.outputFormats)
        && typeof value.monochrome === 'boolean'
        && typeof value.contentHash === 'string'
        && typeof value.byteLength === 'number';
}

function isServerPassFile(value: unknown): value is ServerPassFile {
    return isRecord(value)
        && typeof value.fileName === 'string'
        && isStringArray(value.passNames)
        && typeof value.contentHash === 'string'
        && typeof value.byteLength === 'number';
}

/** Reads a catalog response, keeping each entry that has the catalog's shape; one without it is named and left out. */
export function parseServerModuleCatalog(value: unknown): ServerModuleCatalog {
    if (!isRecord(value) || !Array.isArray(value.decoderPackages) || !Array.isArray(value.passes)) {
        throw new ServerModuleError('catalog-invalid', 'no decoderPackages and passes arrays');
    }
    const decoderPackages: ServerDecoderPackage[] = [];
    for (const entry of value.decoderPackages) {
        if (isServerDecoderPackage(entry)) {
            decoderPackages.push(entry);
        } else {
            console.warn(`${WARNING_PREFIX}: catalog-entry-invalid: decoder package ${JSON.stringify(entry)}`);
        }
    }
    const passes: ServerPassFile[] = [];
    for (const entry of value.passes) {
        if (isServerPassFile(entry)) {
            passes.push(entry);
        } else {
            console.warn(`${WARNING_PREFIX}: catalog-entry-invalid: pass file ${JSON.stringify(entry)}`);
        }
    }
    return { decoderPackages, passes };
}

/** Returns the API client of the item's server, or of the current one, or null when the page has none signed in. */
function getApiClient(serverId: string | null | undefined): ServerApiClient | null {
    const apiClient = serverId ? ServerConnections.getApiClient(serverId) : ServerConnections.currentApiClient();
    return apiClient ?? null;
}

/** Fetches a path of the plugin's routes, signed in as the page's user. */
async function fetchServerPath(apiClient: ServerApiClient, path: string): Promise<Response> {
    let response: Response;
    try {
        response = await fetch(apiClient.getUrl(path), {
            headers: { Authorization: `MediaBrowser Token="${apiClient.accessToken()}"` }
        });
    } catch (error) {
        throw new ServerModuleError('server-request-failed', `${path} ${getErrorMessage(error)}`);
    }
    if (!response.ok) {
        throw new ServerModuleError('server-request-failed', `${path} HTTP ${response.status}`);
    }
    return response;
}

async function requestCatalog(apiClient: ServerApiClient): Promise<ServerModuleCatalog> {
    const response = await fetchServerPath(apiClient, CATALOG_PATH);
    let body: unknown;
    try {
        body = await response.json();
    } catch (error) {
        throw new ServerModuleError('catalog-invalid', getErrorMessage(error));
    }
    return parseServerModuleCatalog(body);
}

/**
 * Returns what the item's server offers, reusing a catalog read moments ago; a refresh always reads it again, as the settings panel does when it opens.
 * Rejects when the server cannot be reached or answers without the plugin's catalog.
 */
export function loadServerModuleCatalog(serverId?: string | null, refresh = false): Promise<ServerModuleCatalog> {
    const apiClient = getApiClient(serverId);
    if (!apiClient) {
        return Promise.reject(new ServerModuleError('server-unavailable', 'no signed-in server'));
    }
    const serverKey = apiClient.serverId();
    const now = Date.now();
    const cached = catalogRequests.get(serverKey);
    if (!refresh && cached && now - cached.requestedAtMilliseconds < CATALOG_REUSE_MILLISECONDS) {
        return cached.promise;
    }
    const promise = requestCatalog(apiClient);
    catalogRequests.set(serverKey, { promise, requestedAtMilliseconds: now });
    promise.catch((): void => {
        if (catalogRequests.get(serverKey)?.promise === promise) {
            catalogRequests.delete(serverKey);
        }
    });
    return promise;
}

/** Returns what the item's server offers for a playback; a server that cannot be reached offers nothing, and the failure is logged. */
async function loadPlaybackCatalog(serverId: string | null | undefined): Promise<ServerModuleCatalog> {
    try {
        return await loadServerModuleCatalog(serverId);
    } catch (error) {
        console.warn(`${WARNING_PREFIX}: ${getErrorMessage(error)}`);
        return EMPTY_CATALOG;
    }
}

/** Downloads a package version the store does not hold and stores it, which runs the engine's checks; storage that fails still leaves the page the package. */
async function downloadDecoderPackage(apiClient: ServerApiClient, entry: ServerDecoderPackage): Promise<DecoderPackage> {
    const response = await fetchServerPath(apiClient, `${DECODER_PACKAGE_PATH}/${encodeURIComponent(entry.id)}`);
    const bytes = await response.arrayBuffer();
    try {
        return (await packageStore.add(`${entry.id}${DECODER_PACKAGE_FILE_EXTENSION}`, bytes)).decoderPackage;
    } catch (error) {
        if (!(error instanceof DecoderPackageStoreError)) {
            throw error;
        }
        console.warn(`${WARNING_PREFIX}: ${error.message}`);
        return loadDecoderPackage(bytes);
    }
}

/** Loads the version of a package the catalog names: the stored one when it is that version, else a download. */
async function loadDecoderPackageVersion(apiClient: ServerApiClient, entry: ServerDecoderPackage): Promise<DecoderPackage> {
    try {
        const stored = await packageStore.load(entry.id);
        if (stored?.decoderPackage.contentHash === entry.contentHash) {
            return stored.decoderPackage;
        }
    } catch (error) {
        // A stored file that no longer loads, or a store that cannot be read, costs only a download
        console.warn(`${WARNING_PREFIX}: package-stale: ${entry.id} ${getErrorMessage(error)}`);
    }
    return downloadDecoderPackage(apiClient, entry);
}

/** Returns a package version for this page, loading it once; a failed load is tried again by the next playback. */
function loadServerDecoderPackage(apiClient: ServerApiClient, entry: ServerDecoderPackage): Promise<DecoderPackage> {
    const loaded = loadedPackages.get(entry.id);
    if (loaded?.contentHash === entry.contentHash) {
        return loaded.promise;
    }
    const promise = loadDecoderPackageVersion(apiClient, entry);
    loadedPackages.set(entry.id, { contentHash: entry.contentHash, promise });
    promise.catch((): void => {
        if (loadedPackages.get(entry.id)?.promise === promise) {
            loadedPackages.delete(entry.id);
        }
    });
    return promise;
}

/** Loads the catalog's packages that a playback needs, in catalog order; each one that fails is logged with its id and left out. */
async function loadServerDecoderPackages(
    serverId: string | null | undefined,
    isNeeded: (entry: ServerDecoderPackage) => boolean
): Promise<DecoderPackage[]> {
    const apiClient = getApiClient(serverId);
    if (!apiClient) {
        return [];
    }
    const entries = (await loadPlaybackCatalog(serverId)).decoderPackages.filter(isNeeded);
    const outcomes = await Promise.allSettled(entries.map((entry: ServerDecoderPackage): Promise<DecoderPackage> => loadServerDecoderPackage(apiClient, entry)));
    const decoderPackages: DecoderPackage[] = [];
    for (const [ entryIndex, outcome ] of outcomes.entries()) {
        if (outcome.status === 'fulfilled') {
            decoderPackages.push(outcome.value);
        } else {
            console.warn(`${WARNING_PREFIX}: package-unavailable: ${entries[entryIndex].id} ${getErrorMessage(outcome.reason)}`);
        }
    }
    return decoderPackages;
}

/**
 * Loads the server's video packages that decode a playback's video into its frame pool format, leaving out the ids the user's own packages hold.
 * Only these are downloaded, and only when no stored version matches.
 */
export async function loadServerVideoDecoderPackages(
    serverId: string | null | undefined,
    target: GPUVideoDecodeTarget,
    excludedIds: ReadonlySet<string>
): Promise<VideoDecoderPackage[]> {
    const decoderPackages = await loadServerDecoderPackages(serverId, (entry: ServerDecoderPackage): boolean => (
        entry.kind === VIDEO_KIND
        && !excludedIds.has(entry.id)
        && entry.codecs.includes(target.codec)
        && entry.outputFormats.includes(target.format)
    ));
    return decoderPackages.filter((decoderPackage: DecoderPackage): decoderPackage is VideoDecoderPackage => decoderPackage.kind === VIDEO_KIND);
}

/** Loads the server's audio packages that decode a playback's audio codec, leaving out the ids the user's own packages hold. */
export async function loadServerAudioDecoderPackages(
    serverId: string | null | undefined,
    codec: CustomAudioCodec,
    excludedIds: ReadonlySet<string>
): Promise<AudioDecoderPackage[]> {
    const decoderPackages = await loadServerDecoderPackages(serverId, (entry: ServerDecoderPackage): boolean => (
        entry.kind === AUDIO_KIND && !excludedIds.has(entry.id) && entry.codecs.includes(codec)
    ));
    return decoderPackages.filter((decoderPackage: DecoderPackage): decoderPackage is AudioDecoderPackage => decoderPackage.kind === AUDIO_KIND);
}

/** Returns what the server's packages decode, which negotiation advertises before any of them is downloaded. */
export async function loadServerDecoderPackageSummaries(serverId: string | null | undefined): Promise<DecoderPackageRouteSummary[]> {
    return (await loadPlaybackCatalog(serverId)).decoderPackages.map((entry: ServerDecoderPackage): DecoderPackageRouteSummary => ({
        codecs: entry.codecs,
        kind: entry.kind,
        outputFormats: entry.outputFormats
    }));
}

/** Downloads a pass file the server offers; rejects with the failed request. */
export async function fetchServerPassSource(fileName: string, serverId?: string | null): Promise<string> {
    const apiClient = getApiClient(serverId);
    if (!apiClient) {
        throw new ServerModuleError('server-unavailable', 'no signed-in server');
    }
    const response = await fetchServerPath(apiClient, `${PASS_PATH}/${encodeURIComponent(fileName)}`);
    return response.text();
}

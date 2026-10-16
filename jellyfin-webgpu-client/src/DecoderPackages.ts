import type { AudioDecoderPackage, DecoderPackage, VideoDecoderPackage } from 'webgpu-player/decode/packages/DecoderPackage';
import DecoderPackageStore, { type StoredDecoderPackage, type StoredDecoderPackages } from 'webgpu-player/decode/packages/DecoderPackageStore';

import type { DecoderPackageRouteSummary } from './custom/CustomDeviceProfile';

// The decoder packages the user adds in this browser, kept in IndexedDB
// A playback offers them in the order the user added them, wherever WebCodecs cannot decode the media, ahead of the server's packages of other ids

const DATABASE_NAME = 'webGPUPlayerDecoders';
const WARNING_PREFIX = 'WebGPU decoder packages';
const NO_STORED_PACKAGES: StoredDecoderPackages = Object.freeze({ failures: [], packages: [] });

const store = new DecoderPackageStore(DATABASE_NAME);
// The stored packages, read once per page and again after each change; a failed read is not kept
let storedPackagesPromise: Promise<StoredDecoderPackages> | null = null;

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Returns every stored package, oldest first, with a failure for each one that no longer loads; rejects when the store cannot be read. */
export function loadStoredDecoderPackages(): Promise<StoredDecoderPackages> {
    if (storedPackagesPromise === null) {
        const reading = store.loadAll();
        storedPackagesPromise = reading;
        reading.catch((): void => {
            if (storedPackagesPromise === reading) {
                storedPackagesPromise = null;
            }
        });
    }
    return storedPackagesPromise;
}

/** Returns the stored packages a playback offers; a store that cannot be read, or a package that no longer loads, is logged and left out. */
export async function loadPlaybackDecoderPackages(): Promise<StoredDecoderPackages> {
    let stored: StoredDecoderPackages;
    try {
        stored = await loadStoredDecoderPackages();
    } catch (error) {
        console.warn(`${WARNING_PREFIX}: ${getErrorMessage(error)}`);
        return NO_STORED_PACKAGES;
    }
    for (const failure of stored.failures) {
        console.warn(`${WARNING_PREFIX}: package-stale: ${failure.fileName} ${failure.detail}`);
    }
    return stored;
}

/** Checks a package file with the engine's loader and stores it; rejects with the engine's refusal, or the store's failure. */
export async function addDecoderPackage(fileName: string, bytes: ArrayBuffer): Promise<StoredDecoderPackage> {
    try {
        return await store.add(fileName, bytes);
    } finally {
        storedPackagesPromise = null;
    }
}

/** Removes a stored package, one that loads or one that no longer does. */
export async function removeDecoderPackage(id: string): Promise<void> {
    try {
        await store.remove(id);
    } finally {
        storedPackagesPromise = null;
    }
}

/** Returns the user's audio packages, in the order the user added them. */
export function getAudioDecoderPackages(stored: StoredDecoderPackages): AudioDecoderPackage[] {
    return stored.packages
        .map((storedPackage: StoredDecoderPackage): DecoderPackage => storedPackage.decoderPackage)
        .filter((decoderPackage: DecoderPackage): decoderPackage is AudioDecoderPackage => decoderPackage.kind === 'audio');
}

/** Returns the user's video packages, in the order the user added them. */
export function getVideoDecoderPackages(stored: StoredDecoderPackages): VideoDecoderPackage[] {
    return stored.packages
        .map((storedPackage: StoredDecoderPackage): DecoderPackage => storedPackage.decoderPackage)
        .filter((decoderPackage: DecoderPackage): decoderPackage is VideoDecoderPackage => decoderPackage.kind === 'video');
}

/** Returns the ids of the user's packages, whose server packages a playback leaves out, since the user's own version comes first. */
export function getStoredDecoderPackageIds(stored: StoredDecoderPackages): Set<string> {
    return new Set<string>(stored.packages.map((storedPackage: StoredDecoderPackage): string => storedPackage.decoderPackage.id));
}

/** Returns what the user's packages decode, which negotiation advertises. */
export function getDecoderPackageRouteSummaries(stored: StoredDecoderPackages): DecoderPackageRouteSummary[] {
    return stored.packages.map((storedPackage: StoredDecoderPackage): DecoderPackageRouteSummary => {
        const decoderPackage = storedPackage.decoderPackage;
        return decoderPackage.kind === 'video' ?
            { codecs: decoderPackage.manifest.accepts.codecs, kind: 'video', outputFormats: decoderPackage.manifest.outputFormats } :
            { codecs: decoderPackage.manifest.codecs, kind: 'audio', outputFormats: [] };
    });
}

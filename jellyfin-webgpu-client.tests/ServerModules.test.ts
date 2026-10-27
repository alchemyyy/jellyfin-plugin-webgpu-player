import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { GPUVideoDecodeTarget } from 'webgpu-player/capability/CustomPlaybackEligibility';
import { parseGPUDecoderHeader } from 'webgpu-player/decode/video/gpu/GPUDecoderManifest';

type ServerModulesModule = typeof import('addons/webGPUPlayer/ServerModules');

const SERVER_ADDRESS = 'https://jellyfin.example';
const SERVER_ID = 'server-1';
const ACCESS_TOKEN = 'token-1';
const CATALOG_URL = `${SERVER_ADDRESS}/WebGPUPlayer/Catalog`;
const AUTHORIZATION = `MediaBrowser Token="${ACCESS_TOKEN}"`;
const HEVC_PACKAGE_URL = `${SERVER_ADDRESS}/WebGPUPlayer/DecoderPackages/hevc`;
const AV1_PACKAGE_URL = `${SERVER_ADDRESS}/WebGPUPlayer/DecoderPackages/av1`;
const EAC3_PACKAGE_URL = `${SERVER_ADDRESS}/WebGPUPlayer/DecoderPackages/eac3`;
const PASS_URL = `${SERVER_ADDRESS}/WebGPUPlayer/Passes/sharpen.wgsl`;
const PASS_SOURCE = '//! name: Sharpen\n';
const BAD_GATEWAY_STATUS = 502;
// The catalog read the store reuses, and a moment past it
const CATALOG_READ_MILLISECONDS = 1_000;
const CATALOG_REUSE_MILLISECONDS = 60_000;
// Content hashes of two versions of a package
const FIRST_HASH = '1'.repeat(64);
const SECOND_HASH = '2'.repeat(64);

// A video package's header as the catalog carries it, without the body whose entry points it dispatches
const HEVC_HEADER = [
    '//! id: hevc',
    '//! name: HEVC',
    '//! decoder: video',
    '//! accepts: codec in [hevc], stream.width <= 8192, stream.height <= 4320, stream.width * stream.height <= 8912896',
    '//! output: I420, I420P10',
    '//! monochrome: yes',
    '//! references: 16',
    '//! reorder: 8',
    '//! packet: 64 MiB',
    '//! dispatch: main, 1'
].join('\n');
const HEVC_ENTRY = {
    byteLength: 3,
    codecs: [ 'hevc' ],
    contentHash: FIRST_HASH,
    header: HEVC_HEADER,
    id: 'hevc',
    kind: 'video',
    monochrome: true,
    name: 'HEVC',
    outputFormats: [ 'I420', 'I420P10' ]
};
// A video package the catalog gives no header, whose routes then go by codec and format alone
const AV1_ENTRY = { byteLength: 3, codecs: [ 'av1' ], contentHash: FIRST_HASH, header: null, id: 'av1', kind: 'video', monochrome: true, name: 'AV1', outputFormats: [ 'I420' ] };
const EAC3_ENTRY = { byteLength: 3, codecs: [ 'eac3', 'ac3' ], contentHash: FIRST_HASH, header: null, id: 'eac3', kind: 'audio', monochrome: false, name: 'E-AC-3', outputFormats: [] };
const SHARPEN_ENTRY = { byteLength: PASS_SOURCE.length, contentHash: FIRST_HASH, fileName: 'sharpen.wgsl', passNames: [ 'Sharpen' ] };
const CATALOG = { decoderPackages: [ HEVC_ENTRY, AV1_ENTRY, EAC3_ENTRY ], passes: [ SHARPEN_ENTRY ] };
const HEVC_I420P10_TARGET: GPUVideoDecodeTarget = { codec: 'hevc', format: 'I420P10' };
const NO_EXCLUDED_IDS: ReadonlySet<string> = new Set<string>();

/** A decoder package as the engine's loader returns it, reduced to what these tests read. */
type FakeDecoderPackage = { contentHash: string, id: string, kind: 'audio' | 'video' };

const testState = vi.hoisted(() => ({
    apiClientAvailable: true,
    // The packages the IndexedDB store holds, by id
    storedPackages: new Map<string, { contentHash: string, id: string, kind: 'audio' | 'video' }>(),
    storeAddCount: 0,
    // The package the loader reads each downloaded file as, by the file's first byte
    packagesByMarker: new Map<number, { contentHash: string, id: string, kind: 'audio' | 'video' }>()
}));

vi.mock('lib/jellyfin-apiclient', () => {
    const apiClient = {
        accessToken: (): string => ACCESS_TOKEN,
        getUrl: (name: string): string => `${SERVER_ADDRESS}/${name}`,
        serverId: (): string => SERVER_ID
    };
    return {
        ServerConnections: {
            currentApiClient: vi.fn(() => (testState.apiClientAvailable ? apiClient : null)),
            getApiClient: vi.fn(() => (testState.apiClientAvailable ? apiClient : null))
        }
    };
});

// The engine's loader compiles WebAssembly, which these tests leave out: a downloaded file's first byte names the package it holds
vi.mock('webgpu-player/decode/packages/DecoderPackage', async importOriginal => ({
    ...await importOriginal<typeof import('webgpu-player/decode/packages/DecoderPackage')>(),
    loadDecoderPackage: vi.fn((bytes: ArrayBuffer): Promise<unknown> => Promise.resolve(testState.packagesByMarker.get(new Uint8Array(bytes)[0])))
}));

vi.mock('webgpu-player/decode/packages/DecoderPackageStore', () => {
    class DecoderPackageStoreError extends Error {}
    class FakeDecoderPackageStore {
        add(fileName: string, bytes: ArrayBuffer): Promise<unknown> {
            testState.storeAddCount += 1;
            const decoderPackage = testState.packagesByMarker.get(new Uint8Array(bytes)[0]);
            if (!decoderPackage) {
                return Promise.reject(new Error(`package-invalid: ${fileName}`));
            }
            testState.storedPackages.set(decoderPackage.id, decoderPackage);
            return Promise.resolve({ addedAtMilliseconds: 0, decoderPackage, fileName });
        }

        load(id: string): Promise<unknown> {
            const decoderPackage = testState.storedPackages.get(id);
            return Promise.resolve(decoderPackage ? { addedAtMilliseconds: 0, decoderPackage, fileName: `${id}.wasm` } : null);
        }
    }
    return { DecoderPackageStoreError, default: FakeDecoderPackageStore };
});

let fetchMock: Mock;
// The responses the server gives, by URL
let responses: Map<string, () => Response>;

function respondJSON(value: unknown): () => Response {
    return (): Response => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' }, status: 200 });
}

/** Responds with a package file whose first byte is the marker the loader reads it by. */
function respondPackage(marker: number, decoderPackage: FakeDecoderPackage): () => Response {
    testState.packagesByMarker.set(marker, decoderPackage);
    return (): Response => new Response(Uint8Array.of(marker), { status: 200 });
}

function getRequestedURLs(): string[] {
    return fetchMock.mock.calls.map((call: unknown[]): string => String(call[0]));
}

async function importServerModules(): Promise<ServerModulesModule> {
    return import('addons/webGPUPlayer/ServerModules');
}

beforeEach(() => {
    vi.resetModules();
    testState.apiClientAvailable = true;
    testState.storedPackages.clear();
    testState.storeAddCount = 0;
    testState.packagesByMarker.clear();
    responses = new Map<string, () => Response>([ [ CATALOG_URL, respondJSON(CATALOG) ] ]);
    fetchMock = vi.fn((url: string): Promise<Response> => {
        const respond = responses.get(url);
        return Promise.resolve(respond ? respond() : new Response(null, { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('ServerModules', () => {
    it('reads the catalog signed in as the page\'s user, reusing it moments later and reading it again on refresh', async () => {
        const { loadServerModuleCatalog } = await importServerModules();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(CATALOG_READ_MILLISECONDS);

        const catalog = await loadServerModuleCatalog();
        await loadServerModuleCatalog();
        clock.mockReturnValue(CATALOG_READ_MILLISECONDS + CATALOG_REUSE_MILLISECONDS);
        await loadServerModuleCatalog();
        await loadServerModuleCatalog(null, true);

        expect(catalog).toEqual(CATALOG);
        expect(getRequestedURLs()).toEqual([ CATALOG_URL, CATALOG_URL, CATALOG_URL ]);
        expect(fetchMock.mock.calls[0][1]).toEqual({ headers: { Authorization: AUTHORIZATION } });
    });

    it('rejects without a signed-in server, and keeps no failed read', async () => {
        const { loadServerModuleCatalog } = await importServerModules();
        responses.set(CATALOG_URL, (): Response => new Response(null, { status: BAD_GATEWAY_STATUS }));
        testState.apiClientAvailable = false;

        await expect(loadServerModuleCatalog()).rejects.toMatchObject({ code: 'server-unavailable' });
        testState.apiClientAvailable = true;
        await expect(loadServerModuleCatalog()).rejects.toThrow(`server-request-failed: WebGPUPlayer/Catalog HTTP ${BAD_GATEWAY_STATUS}`);
        responses.set(CATALOG_URL, respondJSON(CATALOG));
        await expect(loadServerModuleCatalog()).resolves.toEqual(CATALOG);
    });

    it('keeps each catalog entry of the catalog\'s shape and refuses a body that is no catalog', async () => {
        const { parseServerModuleCatalog } = await importServerModules();

        // An older plugin's catalog, without the header
        const headerlessEntry: Record<string, unknown> = { ...HEVC_ENTRY };
        delete headerlessEntry.header;
        expect(parseServerModuleCatalog({ decoderPackages: [ HEVC_ENTRY, { id: 'broken' }, headerlessEntry, { ...HEVC_ENTRY, header: 7 } ], passes: [ SHARPEN_ENTRY, { fileName: 7 } ] }))
            .toEqual({ decoderPackages: [ HEVC_ENTRY, headerlessEntry ], passes: [ SHARPEN_ENTRY ] });
        expect(() => parseServerModuleCatalog([])).toThrow('catalog-invalid');
    });

    it('downloads only the video packages that decode the target, leaving out the user\'s ids', async () => {
        const { loadServerVideoDecoderPackages } = await importServerModules();
        responses.set(HEVC_PACKAGE_URL, respondPackage(1, { contentHash: FIRST_HASH, id: 'hevc', kind: 'video' }));
        responses.set(AV1_PACKAGE_URL, respondPackage(2, { contentHash: FIRST_HASH, id: 'av1', kind: 'video' }));

        const decoderPackages = await loadServerVideoDecoderPackages(SERVER_ID, HEVC_I420P10_TARGET, NO_EXCLUDED_IDS);
        const excluded = await loadServerVideoDecoderPackages(SERVER_ID, HEVC_I420P10_TARGET, new Set<string>([ 'hevc' ]));

        expect(decoderPackages.map((decoderPackage: { id: string }): string => decoderPackage.id)).toEqual([ 'hevc' ]);
        expect(excluded).toEqual([]);
        expect(getRequestedURLs()).toEqual([ CATALOG_URL, HEVC_PACKAGE_URL ]);
    });

    it('loads the stored version the catalog names without a download, and downloads a newer one in its place', async () => {
        testState.storedPackages.set('hevc', { contentHash: FIRST_HASH, id: 'hevc', kind: 'video' });
        const { loadServerVideoDecoderPackages } = await importServerModules();

        await loadServerVideoDecoderPackages(SERVER_ID, HEVC_I420P10_TARGET, NO_EXCLUDED_IDS);
        expect(getRequestedURLs()).toEqual([ CATALOG_URL ]);

        responses.set(CATALOG_URL, respondJSON({ ...CATALOG, decoderPackages: [ { ...HEVC_ENTRY, contentHash: SECOND_HASH } ] }));
        responses.set(HEVC_PACKAGE_URL, respondPackage(1, { contentHash: SECOND_HASH, id: 'hevc', kind: 'video' }));
        const { loadServerModuleCatalog } = await importServerModules();
        await loadServerModuleCatalog(SERVER_ID, true);
        const updated = await loadServerVideoDecoderPackages(SERVER_ID, HEVC_I420P10_TARGET, NO_EXCLUDED_IDS);

        expect(updated).toEqual([ { contentHash: SECOND_HASH, id: 'hevc', kind: 'video' } ]);
        expect(testState.storeAddCount).toBe(1);
        expect(testState.storedPackages.get('hevc')?.contentHash).toBe(SECOND_HASH);
    });

    it('downloads the audio package of the track\'s codec, and leaves out one that fails with a warning', async () => {
        const { loadServerAudioDecoderPackages } = await importServerModules();

        await expect(loadServerAudioDecoderPackages(SERVER_ID, 'ac3', NO_EXCLUDED_IDS)).resolves.toEqual([]);
        expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/^WebGPU server modules: package-unavailable: eac3 server-request-failed: /));

        responses.set(EAC3_PACKAGE_URL, respondPackage(3, { contentHash: FIRST_HASH, id: 'eac3', kind: 'audio' }));
        await expect(loadServerAudioDecoderPackages(SERVER_ID, 'ac3', NO_EXCLUDED_IDS)).resolves.toEqual([ { contentHash: FIRST_HASH, id: 'eac3', kind: 'audio' } ]);
    });

    it('summarizes what the server\'s packages decode with each header the engine reads, and offers nothing when the catalog cannot be read', async () => {
        const { loadServerDecoderPackageSummaries } = await importServerModules();

        await expect(loadServerDecoderPackageSummaries(SERVER_ID)).resolves.toEqual([
            { codecs: HEVC_ENTRY.codecs, header: parseGPUDecoderHeader(HEVC_HEADER), kind: 'video', outputFormats: HEVC_ENTRY.outputFormats },
            { codecs: AV1_ENTRY.codecs, kind: 'video', outputFormats: AV1_ENTRY.outputFormats },
            { codecs: EAC3_ENTRY.codecs, kind: 'audio', outputFormats: [] }
        ]);

        vi.resetModules();
        responses.set(CATALOG_URL, (): Response => new Response(null, { status: BAD_GATEWAY_STATUS }));
        const reloaded = await importServerModules();
        await expect(reloaded.loadServerDecoderPackageSummaries(SERVER_ID)).resolves.toEqual([]);
    });

    it('leaves out a package whose header the engine refuses, which would fail its load too', async () => {
        responses.set(CATALOG_URL, respondJSON({ ...CATALOG, decoderPackages: [ { ...HEVC_ENTRY, header: HEVC_HEADER.replace('//! packet: 64 MiB', '//! packet: lots') }, EAC3_ENTRY ] }));
        const { loadServerDecoderPackageSummaries } = await importServerModules();

        await expect(loadServerDecoderPackageSummaries(SERVER_ID)).resolves.toEqual([ { codecs: EAC3_ENTRY.codecs, kind: 'audio', outputFormats: [] } ]);
        expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/^WebGPU server modules: package-header-invalid: hevc packet-identifier: /));
    });

    it('downloads a pass file\'s source', async () => {
        const { fetchServerPassSource } = await importServerModules();
        responses.set(PASS_URL, (): Response => new Response(PASS_SOURCE, { status: 200 }));

        await expect(fetchServerPassSource(SHARPEN_ENTRY.fileName)).resolves.toBe(PASS_SOURCE);
        expect(fetchMock).toHaveBeenLastCalledWith(PASS_URL, { headers: { Authorization: AUTHORIZATION } });
    });
});

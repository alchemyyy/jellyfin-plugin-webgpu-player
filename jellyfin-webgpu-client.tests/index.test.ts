import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostPluginBag } from 'addons/webGPUPlayer/host/HostBridge';

const testState = vi.hoisted(() => ({
    bindHostBridge: vi.fn((): void => {
        testState.events.push('bind');
    }),
    configureEngineAssets: vi.fn(),
    configureEngineFeatureFlags: vi.fn(),
    events: [] as string[],
    getWebGPUHDRToneMappingEnabled: vi.fn(() => Promise.resolve(true)),
    installHostCompatibleMode: vi.fn((): void => {
        testState.events.push('install');
    }),
    configureCapabilityProbeStore: vi.fn(),
    installTimingTraceControl: vi.fn(),
    startCapabilityProbeWarmUp: vi.fn((): void => {
        testState.events.push('warm');
    }),
    startClientDefaultsSync: vi.fn((): void => {
        testState.events.push('defaults');
    }),
    // Resolves the add-on strings' load when a test lets it
    finishStringsLoad: null as (() => void) | null,
    loadAddonStrings: vi.fn((): Promise<void> => new Promise<void>((resolve: () => void): void => {
        testState.finishStringsLoad = resolve;
    })),
    renderClientDefaultsEditor: vi.fn((element: HTMLElement): Promise<void> => {
        element.textContent = 'editor';
        return Promise.resolve();
    })
}));

vi.mock('webgpu-player/EngineAssets', () => ({ configureEngineAssets: testState.configureEngineAssets }));
vi.mock('webgpu-player/EngineConfiguration', () => ({
    configureEngineFeatureFlags: testState.configureEngineFeatureFlags
}));
vi.mock('webgpu-player/style.css', () => ({}));
vi.mock('addons/webGPUPlayer/WebGPUPlaybackPreferences', () => ({
    getWebGPUHDRToneMappingEnabled: testState.getWebGPUHDRToneMappingEnabled
}));
vi.mock('addons/webGPUPlayer/host/HostBridge', () => ({ bindHostBridge: testState.bindHostBridge }));
vi.mock('addons/webGPUPlayer/compat/HostCompatibleMode', () => ({
    installHostCompatibleMode: testState.installHostCompatibleMode
}));
vi.mock('webgpu-player/capability/CapabilityProbeStore', () => ({
    configureCapabilityProbeStore: testState.configureCapabilityProbeStore
}));
vi.mock('addons/webGPUPlayer/CapabilityProbeWarmUp', () => ({
    startCapabilityProbeWarmUp: testState.startCapabilityProbeWarmUp
}));
vi.mock('addons/webGPUPlayer/TimingTraceControl', () => ({
    installTimingTraceControl: testState.installTimingTraceControl
}));
vi.mock('addons/webGPUPlayer/ServerClientDefaults', () => ({
    startClientDefaultsSync: testState.startClientDefaultsSync
}));
vi.mock('addons/webGPUPlayer/host/globalize', () => ({ loadAddonStrings: testState.loadAddonStrings }));
vi.mock('addons/webGPUPlayer/ui/ClientDefaultsEditor', () => ({
    renderClientDefaultsEditor: testState.renderClientDefaultsEditor
}));
// The player itself is covered by its own suites
vi.mock('addons/webGPUPlayer/HostCompatibleWebGPUPlayer', () => ({
    default: class FakeHostCompatibleWebGPUPlayer {
        name = 'WebGPU Player';
        type = 'mediaplayer';
        id = 'webgpuplayer';
        priority = 0;

        constructor() {
            testState.events.push('construct');
        }
    }
}));

type AddonEntry = new (bag: HostPluginBag) => { id: string, name: string, priority: number, type: string };

async function loadEntry(): Promise<AddonEntry> {
    vi.resetModules();
    const entryModule = await import('addons/webGPUPlayer/index');
    return entryModule.default as unknown as AddonEntry;
}

describe('WebGPU player add-on entry', () => {
    beforeEach(() => {
        testState.events.length = 0;
        vi.stubGlobal('__WEBGPU_PLAYER_ASSET_KEY__', 'asset-key');
        vi.stubGlobal('__webpack_hash__', 'webpack-hash');
    });

    afterEach(() => {
        delete window.WebGPUPlayerConfig;
        vi.unstubAllGlobals();
    });

    it('configures the engine from the bootstrap without touching host singletons', async () => {
        window.WebGPUPlayerConfig = { assetBaseURL: '/jellyfin/WebGPUPlayer/assets/' };

        await loadEntry();

        expect(testState.configureEngineAssets).toHaveBeenCalledWith({
            baseURL: '/jellyfin/WebGPUPlayer/assets/libraries/',
            cacheKey: 'asset-key'
        });
        // The engine follows the per-browser preference, read when it presents HDR rather than at load
        expect(testState.configureEngineFeatureFlags).toHaveBeenCalledTimes(1);
        expect(testState.configureEngineFeatureFlags).toHaveBeenCalledWith({
            isHDRToneMappingEnabled: testState.getWebGPUHDRToneMappingEnabled
        });
        expect(testState.getWebGPUHDRToneMappingEnabled).not.toHaveBeenCalled();
        // The timing trace control is installed at load, so a trace requested through storage covers the first play
        expect(testState.installTimingTraceControl).toHaveBeenCalledWith({ engineAssetKey: 'asset-key' });
        expect(testState.bindHostBridge).not.toHaveBeenCalled();
        // Stored probe verdicts are keyed by the engine assets and the add-on's own compilation
        expect(testState.configureCapabilityProbeStore).toHaveBeenCalledWith({ buildKey: 'asset-key-webpack-hash' });
        expect(testState.events).toEqual([]);
    });

    it('falls back to the bundle directory without a bootstrap configuration', async () => {
        vi.stubGlobal('__webpack_public_path__', 'https://server.example/WebGPUPlayer/assets');

        await loadEntry();

        expect(testState.configureEngineAssets).toHaveBeenCalledWith({
            baseURL: 'https://server.example/WebGPUPlayer/assets/libraries/',
            cacheKey: 'asset-key'
        });
    });

    it('binds the bag before constructing the player that new returns', async () => {
        window.WebGPUPlayerConfig = { assetBaseURL: '/WebGPUPlayer/assets/' };
        const WebGPUPlayerAddon = await loadEntry();
        const bag = { playbackManager: {} } as unknown as HostPluginBag;

        const player = new WebGPUPlayerAddon(bag);

        expect(testState.bindHostBridge).toHaveBeenCalledWith(bag);
        expect(testState.installHostCompatibleMode).toHaveBeenCalledWith(player);
        // The warm-up starts once the bag binds the PlaybackManager it waits on, and the server's defaults sync once it binds ServerConnections,
        // so the settings the player reads at construction start from the cached defaults
        expect(testState.events).toEqual([ 'bind', 'defaults', 'warm', 'construct', 'install' ]);
        // The plugin manager reads these synchronously after construction
        expect([ player.id, player.type, player.name, player.priority ])
            .toEqual([ 'webgpuplayer', 'mediaplayer', 'WebGPU Player', 0 ]);
    });

    it('renders the client defaults editor once the add-on strings have loaded', async () => {
        window.WebGPUPlayerConfig = { assetBaseURL: '/WebGPUPlayer/assets/' };
        const entry = await loadEntry() as unknown as { renderClientDefaultsEditor: (element: HTMLElement) => Promise<void> };
        const container = document.createElement('div');

        const rendered = entry.renderClientDefaultsEditor(container);
        await vi.waitFor(() => expect(testState.loadAddonStrings).toHaveBeenCalled());
        // The editor waits on the strings even once its own module has loaded
        await import('addons/webGPUPlayer/ui/ClientDefaultsEditor');
        expect(testState.renderClientDefaultsEditor).not.toHaveBeenCalled();
        testState.finishStringsLoad?.();
        await rendered;

        expect(testState.renderClientDefaultsEditor).toHaveBeenCalledWith(container);
        expect(container.textContent).toBe('editor');
    });
});

import { configureEngineAssets } from 'webgpu-player/EngineAssets';
import { configureEngineFeatureFlags } from 'webgpu-player/EngineConfiguration';
import 'webgpu-player/style.scss';

import { installHostCompatibleMode } from './compat/HostCompatibleMode';
import { bindHostBridge, type HostPluginBag } from './host/HostBridge';
import HostCompatibleWebGPUPlayer from './HostCompatibleWebGPUPlayer';
import { getWebGPUHDRToneMappingEnabled } from './WebGPUPlaybackPreferences';

// Add-on entry loaded by the server plugin's bootstrap through Jellyfin Web's window plugin path.
// NOTE: Module evaluation must not touch host singletons; they arrive with the plugin bag at construction

const ENGINE_LIBRARIES_DIRECTORY = 'libraries/';

/** Returns the add-on asset route, which the bootstrap publishes, else the bundle's own directory. */
function getAddonAssetBaseURL(): string {
    const configuredBaseURL = typeof window === 'undefined' ? undefined : window.WebGPUPlayerConfig?.assetBaseURL;
    const assetBaseURL = typeof configuredBaseURL === 'string' && configuredBaseURL.length > 0 ?
        configuredBaseURL :
        __webpack_public_path__;
    return assetBaseURL.endsWith('/') ? assetBaseURL : `${assetBaseURL}/`;
}

// Engine workers and decoders load from the add-on route, keyed per engine build
configureEngineAssets({
    baseURL: getAddonAssetBaseURL() + ENGINE_LIBRARIES_DIRECTORY,
    cacheKey: __WEBGPU_PLAYER_ASSET_KEY__
});
configureEngineFeatureFlags({
    isHDRToneMappingEnabled: getWebGPUHDRToneMappingEnabled
});

/**
 * Plugin constructor for Jellyfin Web's plugin manager.
 * `new WebGPUPlayerAddon(bag)` binds the host bridge, installs the host-compatible hooks, and returns the player.
 * A constructor that returns an object makes `new` yield that object.
 */
function WebGPUPlayerAddon(this: unknown, bag: HostPluginBag): HostCompatibleWebGPUPlayer {
    bindHostBridge(bag);
    const player = new HostCompatibleWebGPUPlayer();
    installHostCompatibleMode(player);
    return player;
}

export default WebGPUPlayerAddon;

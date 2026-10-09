import { loadWebGPUUserSettings, type WebGPUUserSettings } from './WebGPUUserSettings';

// The custom decode and HDR tone mapping preferences, kept per browser with the other WebGPU user settings.
// They shape the device profile the server decides on, so a playback keeps the values its negotiation adopted and a stored change applies from the next negotiation: the next item, a restart, or a stream change

type WebGPUPlaybackPreferences = WebGPUUserSettings['playback'];

let negotiatedPreferences: WebGPUPlaybackPreferences | null = null;

function getNegotiatedPreferences(): WebGPUPlaybackPreferences {
    if (negotiatedPreferences === null) {
        negotiatedPreferences = loadWebGPUUserSettings().playback;
    }
    return negotiatedPreferences;
}

/** Adopts the stored preferences for a new playback negotiation. */
export function refreshWebGPUPlaybackPreferences(): void {
    negotiatedPreferences = loadWebGPUUserSettings().playback;
}

/** Returns the stored custom decode preference, for player selection ahead of the next negotiation. */
export function isStoredWebGPUCustomDecodeEnabled(): boolean {
    return loadWebGPUUserSettings().playback.enableCustomDecode;
}

/** Returns the negotiated custom decode preference without delaying playback. */
export function isWebGPUCustomDecodeEnabled(): boolean {
    return getNegotiatedPreferences().enableCustomDecode;
}

/** Resolves the negotiated custom decode preference. */
export function getWebGPUCustomDecodeEnabled(): Promise<boolean> {
    return Promise.resolve(isWebGPUCustomDecodeEnabled());
}

/** Resolves the negotiated HDR tone mapping preference, which the engine also reads for HDR presentation. */
export function getWebGPUHDRToneMappingEnabled(): Promise<boolean> {
    return Promise.resolve(getNegotiatedPreferences().enableHDRToneMapping);
}

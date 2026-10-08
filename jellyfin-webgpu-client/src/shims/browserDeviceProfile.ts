import browser from 'scripts/browser';

// Shim for scripts/browserDeviceProfile: the HTML backend always gets its profile from appHost.getDeviceProfile,
// which every supported host defines, so only canPlaySecondaryAudio keeps the host implementation

const MINIMUM_TIZEN_SECONDARY_AUDIO_VERSION = 5.5;
const UNSUPPORTED_TIZEN_SECONDARY_AUDIO_VERSION = 8;
const MINIMUM_WEBOS_SECONDARY_AUDIO_VERSION = 4.0;

/** Checks whether the web engine supports secondary audio, exactly as the host does. */
export function canPlaySecondaryAudio(videoTestElement: HTMLVideoElement & { audioTracks?: unknown }): boolean {
    // An unknown version compares like undefined does in the host's comparisons
    const tizenVersion = browser.tizenVersion ?? 0;
    const webOSVersion = browser.web0sVersion ?? 0;
    return !!videoTestElement.audioTracks
        && !browser.firefox
        && (
            (tizenVersion >= MINIMUM_TIZEN_SECONDARY_AUDIO_VERSION
                && tizenVersion < UNSUPPORTED_TIZEN_SECONDARY_AUDIO_VERSION)
            || !browser.tizen
        )
        && (webOSVersion >= MINIMUM_WEBOS_SECONDARY_AUDIO_VERSION || !browser.web0sVersion);
}

/** Never used: the host's appHost.getDeviceProfile supplies the HTML backend profile. */
export default function buildDeviceProfile(): never {
    throw new Error('The WebGPU player add-on builds device profiles through appHost.getDeviceProfile');
}

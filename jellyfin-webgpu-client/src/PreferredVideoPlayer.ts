// Ported from the fork's components/playback/PreferredVideoPlayer.
// The stock host has no ordering seam, so HostCompatibleWebGPUPlayer.canPlayItem applies the preference instead of PlaybackManager.getPlayer

export enum VideoPlayerPreference {
    Auto = 'auto',
    HTML = 'html',
    WEBGPU = 'webgpu'
}

/** Converts persisted or external values to a supported player preference. */
export function normalizeVideoPlayerPreference(value: unknown): VideoPlayerPreference {
    switch (value) {
        case VideoPlayerPreference.HTML:
            return VideoPlayerPreference.HTML;
        case VideoPlayerPreference.WEBGPU:
            return VideoPlayerPreference.WEBGPU;
        case VideoPlayerPreference.Auto:
        default:
            return VideoPlayerPreference.Auto;
    }
}

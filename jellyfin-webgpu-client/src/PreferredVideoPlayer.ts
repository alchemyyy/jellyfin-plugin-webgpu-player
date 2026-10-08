// Ported from the fork's components/playback/PreferredVideoPlayer; the stock host has no ordering seam,
// so the preference is applied by HostCompatibleWebGPUPlayer.canPlayItem instead of PlaybackManager.getPlayer

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

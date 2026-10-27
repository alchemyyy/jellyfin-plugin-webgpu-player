import { playbackManager } from 'components/playback/playbackmanager';
import {
    configureCustomDecodeCapabilityBackground,
    warmCustomDecodeCapabilities
} from 'webgpu-player/capability/CustomDecodeCapabilities';
import { getCustomPlaybackRuntimeAvailability } from 'webgpu-player/capability/CustomPlaybackRuntime';

import { isStoredWebGPUCustomDecodeEnabled } from './WebGPUPlaybackPreferences';

// The engine's capability probes, started at add-on load so the first getDeviceProfile finds them done.
// The engine gates each step on idle time, on no negotiation being near, and on no media playing, and getDeviceProfile promotes what it needs

/** Returns whether the host has a playback open, whichever player plays it, paused or not. */
function isHostPlaybackActive(): boolean {
    try {
        return playbackManager.isPlaying() === true;
    } catch {
        // Before the host binds its PlaybackManager nothing plays through it
        return false;
    }
}

/**
 * Starts the capability probes in the background, unless custom decode is off or cannot run here.
 * The engine skips the warm-up on a client that asks to save data or has few threads; returns whether it started.
 */
export function startCapabilityProbeWarmUp(): boolean {
    configureCustomDecodeCapabilityBackground({ isPlaybackActive: isHostPlaybackActive });
    if (!isStoredWebGPUCustomDecodeEnabled() || !getCustomPlaybackRuntimeAvailability().available) {
        return false;
    }
    return warmCustomDecodeCapabilities();
}

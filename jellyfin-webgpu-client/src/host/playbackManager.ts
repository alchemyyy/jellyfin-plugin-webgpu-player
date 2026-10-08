import type { PlaybackManager as HostPlaybackManager } from 'components/playback/playbackmanager';

// Bridge for components/playback/playbackmanager: live bindings filled from the plugin bag

/** The host's PlaybackManager instance */
export let playbackManager: HostPlaybackManager;
/** The host's PlaybackManager class */
export let PlaybackManager: typeof HostPlaybackManager;

/** Binds the host's PlaybackManager instance from the plugin bag. */
export function bindPlaybackManager(value: HostPlaybackManager): void {
    playbackManager = value;
    PlaybackManager = value.constructor as typeof HostPlaybackManager;
}

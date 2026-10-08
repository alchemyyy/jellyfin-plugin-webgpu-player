// The fork's PlaybackManager cancelled pending local starts at every new playback request. The stock one
// has no request generations, so these wrappers cancel a pending WebGPU start before the request runs

/** PlaybackManager entry points that begin a new playback request or end the current one */
export const SUPERSEDING_PLAYBACK_MANAGER_METHODS = [
    'play',
    'nextTrack',
    'previousTrack',
    'setCurrentPlaylistItem',
    'stop'
] as const;

type SupersedingMethodName = typeof SUPERSEDING_PLAYBACK_MANAGER_METHODS[number];

type HookablePlaybackManager = Partial<Record<SupersedingMethodName, unknown>>;

type PlaybackManagerHookCallbacks = Readonly<{
    // Cancels pending WebGPU starts and returns whether one was pending
    cancelPendingPlays: () => boolean
    hideLoading: () => void
}>;

type MethodFunction = (this: unknown, ...methodArguments: unknown[]) => unknown;

const hookedPlaybackManagers = new WeakSet<object>();

/** Wraps the superseding PlaybackManager methods once; returns false when they were already wrapped. */
export function installPlaybackManagerHooks(
    playbackManager: object,
    callbacks: PlaybackManagerHookCallbacks
): boolean {
    if (hookedPlaybackManagers.has(playbackManager)) {
        return false;
    }
    hookedPlaybackManagers.add(playbackManager);

    const hookablePlaybackManager = playbackManager as HookablePlaybackManager;
    for (const methodName of SUPERSEDING_PLAYBACK_MANAGER_METHODS) {
        const originalMethod = hookablePlaybackManager[methodName];
        if (typeof originalMethod !== 'function') {
            continue;
        }

        const forwardedMethod = originalMethod as MethodFunction;
        hookablePlaybackManager[methodName] = function (this: unknown, ...methodArguments: unknown[]): unknown {
            try {
                // A superseded start never settles toward PlaybackManager, so its loading indicator is cleared here
                if (callbacks.cancelPendingPlays()) {
                    callbacks.hideLoading();
                }
            } catch (error) {
                console.warn('[WebGPUPlayer] unable to cancel a pending start', error);
            }
            return forwardedMethod.apply(this, methodArguments);
        };
    }
    return true;
}

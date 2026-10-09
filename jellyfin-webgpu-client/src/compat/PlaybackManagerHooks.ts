// The fork's PlaybackManager cancelled pending local starts at every new playback request.
// The stock one has no request generations, so these wrappers cancel a pending WebGPU start before the request runs.
// A play request identical to the pending one, such as a second click while a card's playback loads, joins that start instead

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
    // Returns whether no WebGPU start for the latest request has completed or been lost
    isRequestStartPending: () => boolean
}>;

type MethodFunction = (this: unknown, ...methodArguments: unknown[]) => unknown;

/** Every option the stock PlaybackManager.play reads */
type PlayRequestOptions = {
    aspectRatio?: unknown
    audioStreamIndex?: unknown
    enableRemotePlayers?: unknown
    fullscreen?: unknown
    ids?: unknown
    items?: unknown
    mediaSourceId?: unknown
    queryOptions?: unknown
    serverId?: unknown
    shuffle?: unknown
    startIndex?: unknown
    startPositionTicks?: unknown
    subtitleStreamIndex?: unknown
};

type PassedItemKey = Readonly<{
    id: string
    serverId: unknown
}>;

/** A forwarded play request that has not settled toward its callers */
type PendingPlayRequest = Readonly<{
    identity: string
    promise: Promise<unknown>
}>;

const hookedPlaybackManagers = new WeakSet<object>();

/** Returns the requested IDs in queue order, or null when the list is empty or holds anything but IDs. */
function getRequestedItemIDs(ids: unknown): string[] | null {
    if (!Array.isArray(ids) || ids.length === 0) {
        return null;
    }
    const itemIDs: string[] = [];
    for (const itemID of ids) {
        if (typeof itemID !== 'string' || !itemID) {
            return null;
        }
        itemIDs.push(itemID);
    }
    return itemIDs;
}

/** Returns each passed item's ID and server in queue order, or null when the list is empty or an item has no ID. */
function getPassedItemKeys(items: unknown): PassedItemKey[] | null {
    if (!Array.isArray(items) || items.length === 0) {
        return null;
    }
    const itemKeys: PassedItemKey[] = [];
    for (const item of items) {
        // Remote trailers and other URL items carry no ID
        const passedItem = item && typeof item === 'object' ? item as { Id?: unknown, ServerId?: unknown } : null;
        if (typeof passedItem?.Id !== 'string' || !passedItem.Id) {
            return null;
        }
        itemKeys.push({ id: passedItem.Id, serverId: passedItem.ServerId ?? null });
    }
    return itemKeys;
}

/**
 * Returns a key that play requests share when they would start the same playback, or null when a request does not name its items by ID.
 * The key covers every option PlaybackManager.play reads, comparing passed items by ID and server.
 * PlaybackManager rewrites the options while the request runs, so the key is read before forwarding.
 */
export function getPlayRequestIdentity(options: unknown): string | null {
    if (!options || typeof options !== 'object') {
        return null;
    }
    const playOptions = options as PlayRequestOptions;
    if (playOptions.items == null && playOptions.ids == null) {
        return null;
    }
    // PlaybackManager plays passed items rather than fetching the IDs, and orders passed items by the IDs when both are given
    const itemKeys = playOptions.items == null ? [] : getPassedItemKeys(playOptions.items);
    const itemIDs = playOptions.ids == null ? [] : getRequestedItemIDs(playOptions.ids);
    if (!itemKeys || !itemIDs) {
        return null;
    }
    try {
        return JSON.stringify({
            itemKeys,
            itemIDs,
            serverId: playOptions.serverId ?? null,
            startIndex: playOptions.startIndex ?? null,
            startPositionTicks: playOptions.startPositionTicks ?? null,
            mediaSourceId: playOptions.mediaSourceId ?? null,
            audioStreamIndex: playOptions.audioStreamIndex ?? null,
            subtitleStreamIndex: playOptions.subtitleStreamIndex ?? null,
            shuffle: Boolean(playOptions.shuffle),
            queryOptions: playOptions.queryOptions ?? null,
            aspectRatio: playOptions.aspectRatio ?? null,
            // PlaybackManager reads these two as on unless they are false
            fullscreen: playOptions.fullscreen !== false,
            enableRemotePlayers: playOptions.enableRemotePlayers !== false
        });
    } catch {
        // Query options that cannot serialize, such as cyclic ones, leave the request without an identity
        return null;
    }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return (typeof value === 'object' || typeof value === 'function')
        && value !== null
        && typeof (value as { then?: unknown }).then === 'function';
}

/** Returns whether the latest request is still starting; a failing check lets the new request supersede it. */
function isRequestStartPending(callbacks: PlaybackManagerHookCallbacks): boolean {
    try {
        return callbacks.isRequestStartPending();
    } catch (error) {
        console.warn('[WebGPUPlayer] unable to check a pending start', error);
        return false;
    }
}

/** Wraps the superseding PlaybackManager methods once; returns false when they were already wrapped. */
export function installPlaybackManagerHooks(playbackManager: object, callbacks: PlaybackManagerHookCallbacks): boolean {
    if (hookedPlaybackManagers.has(playbackManager)) {
        return false;
    }
    hookedPlaybackManagers.add(playbackManager);

    // The latest forwarded play request, kept until it settles or another request supersedes it
    let pendingPlayRequest: PendingPlayRequest | null = null;

    const hookablePlaybackManager = playbackManager as HookablePlaybackManager;
    for (const methodName of SUPERSEDING_PLAYBACK_MANAGER_METHODS) {
        const originalMethod = hookablePlaybackManager[methodName];
        if (typeof originalMethod !== 'function') {
            continue;
        }

        const forwardedMethod = originalMethod as MethodFunction;
        hookablePlaybackManager[methodName] = function (this: unknown, ...methodArguments: unknown[]): unknown {
            const playRequestIdentity = methodName === 'play' ? getPlayRequestIdentity(methodArguments[0]) : null;
            const joinedRequest = pendingPlayRequest;
            if (
                joinedRequest !== null
                && joinedRequest.identity === playRequestIdentity
                && isRequestStartPending(callbacks)
            ) {
                // NOTE: Forwarding would rerun the item and PlaybackInfo requests and restart the WebGPU start.
                // The joined start keeps its loading indicator, which PlaybackManager hides when that start completes
                console.debug('[WebGPUPlayer] an identical play request joined the pending start');
                return joinedRequest.promise;
            }

            pendingPlayRequest = null;
            try {
                // A superseded start never settles toward PlaybackManager, so its loading indicator is cleared here
                if (callbacks.cancelPendingPlays()) {
                    callbacks.hideLoading();
                }
            } catch (error) {
                console.warn('[WebGPUPlayer] unable to cancel a pending start', error);
            }
            const result = forwardedMethod.apply(this, methodArguments);
            if (playRequestIdentity === null || !isPromiseLike(result)) {
                return result;
            }

            // Settles like the forwarded promise, after the request is forgotten, so callers that play again from it are forwarded
            const requestPromise: Promise<unknown> = Promise.resolve(result).finally((): void => {
                if (pendingPlayRequest?.promise === requestPromise) {
                    pendingPlayRequest = null;
                }
            });
            pendingPlayRequest = { identity: playRequestIdentity, promise: requestPromise };
            return requestPromise;
        };
    }
    return true;
}

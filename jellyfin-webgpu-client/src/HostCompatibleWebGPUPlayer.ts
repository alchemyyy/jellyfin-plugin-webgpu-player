import { ServerConnections } from 'lib/jellyfin-apiclient';
import { getCustomPlaybackRuntimeAvailability } from 'webgpu-player/capability/CustomPlaybackRuntime';

import {
    ensurePlaybackInfoInterceptors,
    markPlaybackInfoNegotiation,
    type NegotiationItem
} from './compat/PlaybackInfoInterceptor';
import { getPlaybackInfoNegotiationPurpose, PlaybackInfoNegotiationPurpose } from './compat/PlaybackInfoPolicy';
import { isPlaybackSuperseded } from './constants/playbackResult';
import {
    DirectPlayHeadPrefetches,
    predictDirectPlayStream,
    type DirectPlayStreamPrediction,
    type StreamURLBuilder
} from './DirectPlayHeadPrefetch';
import { VideoPlayerPreference } from './PreferredVideoPlayer';
import { whenClientDefaultsSettled } from './ServerClientDefaults';
import { preferredVideoPlayer } from './shims/userSettings';
import { isStoredWebGPUCustomDecodeEnabled } from './WebGPUPlaybackPreferences';
import WebGPUPlayer from './WebGPUPlayer';

type StreamingBitrateRequest = Parameters<WebGPUPlayer['getMaxStreamingBitrate']>[0];

/** Stream state the stock PlaybackManager writes onto the player through getPlayerData() */
type HostStreamInfo = {
    item?: { ServerId?: string | null } | null
    mediaSource?: { MediaStreams?: unknown } | null
    playMethod?: string | null
    playSessionId?: string | null
};

/** A playback request PlaybackManager began, and the media source it names */
type PlaybackRequest = Readonly<{
    mediaSourceId: string | null
}>;

/** Native app shells supply their own players and a device profile that describes those players. */
function isNativeShellHost(): boolean {
    return typeof window !== 'undefined' && Boolean(window.NativeShell);
}

/** Stops the server encodings a superseded start requested, as the fork's PlaybackManager did. */
function stopSupersededEncodings(options: unknown): void {
    const streamInfo = options && typeof options === 'object' ? options as HostStreamInfo : null;
    const playSessionId = streamInfo?.playSessionId;
    const serverId = streamInfo?.item?.ServerId;
    if (!playSessionId || !serverId) {
        return;
    }
    const apiClient = ServerConnections.getApiClient(serverId);
    if (!apiClient) {
        return;
    }
    Promise.resolve(apiClient.stopActiveEncodings(playSessionId)).catch((error: unknown): void => {
        console.warn('[WebGPUPlayer] unable to stop a superseded playback encoding', error);
    });
}

/**
 * The fork's WebGPU player adapted to the stock PlaybackManager, which lacks the fork's bitrate purposes, superseded results, and request generations.
 */
export default class HostCompatibleWebGPUPlayer extends WebGPUPlayer {
    // Written by the stock PlaybackManager through getPlayerData()
    isChangingStream?: boolean;
    maxStreamingBitrate?: number | null;
    streamInfo?: HostStreamInfo | null;

    // Advances whenever a start, stop, or new PlaybackManager request makes earlier starts stale
    private hostRequestRevision = 0;
    // Whether a start began since PlaybackManager's latest request
    private startedSinceHostRequest = false;
    // The reads of the stream heads that negotiations are predicted to direct play
    private readonly headPrefetches = new DirectPlayHeadPrefetches();
    // The playback request whose first negotiation for playback may read its stream's head, until that negotiation, a start, or the request's end
    private headPrefetchRequest: PlaybackRequest | null = null;

    /** Keeps the fork's purpose semantics; a purpose-less call returns the cap PlaybackManager stored. */
    getMaxStreamingBitrate(request?: StreamingBitrateRequest): number | null {
        if (request) {
            return super.getMaxStreamingBitrate(request);
        }
        // The stock PlaybackManager asks without a purpose for stream changes, retries, and state reports
        const savedBitrate = this.maxStreamingBitrate;
        return typeof savedBitrate === 'number' && Number.isFinite(savedBitrate) && savedBitrate > 0 ?
            savedBitrate :
            null;
    }

    /** Declines when the user prefers the HTML player, or inside a native app shell. */
    canPlayItem(item: unknown, playOptions?: unknown): boolean {
        if (isNativeShellHost() || preferredVideoPlayer() === VideoPlayerPreference.HTML) {
            return false;
        }
        return super.canPlayItem(item, playOptions);
    }

    /** Returns the fork's profile, marked so the PlaybackInfo interceptor applies the fork's request rules. */
    async getDeviceProfile(item: unknown, options?: unknown): Promise<unknown> {
        this.startHeadPrefetch(item, options);
        const negotiationItem: NegotiationItem = item && typeof item === 'object' ? item as NegotiationItem : {};
        const interceptorsActive = ensurePlaybackInfoInterceptors(negotiationItem.ServerId);
        const profile = await super.getDeviceProfile(item, options);
        return interceptorsActive ?
            markPlaybackInfoNegotiation(profile, this, negotiationItem, options) :
            profile;
    }

    /**
     * Never settles a superseded start, because the stock PlaybackManager treats any settlement as a start.
     * A start of the stream whose head a negotiation read ahead claims that read, and releases it once the start is over; any other start ends it.
     */
    play(options: unknown): Promise<unknown> {
        this.headPrefetchRequest = null;
        const headPrefetch = this.headPrefetches.claim(options);
        const playPromise = super.play(options).finally((): void => {
            this.headPrefetches.release(headPrefetch);
        });
        this.hostRequestRevision += 1;
        this.startedSinceHostRequest = true;
        const requestRevision = this.hostRequestRevision;
        return playPromise.then(
            (result: unknown): unknown => (
                isPlaybackSuperseded(result) || requestRevision !== this.hostRequestRevision ?
                    this.abandonSupersededPlay(options) :
                    result
            ),
            (error: unknown): unknown => {
                if (requestRevision !== this.hostRequestRevision) {
                    return this.abandonSupersededPlay(options);
                }
                throw error;
            }
        );
    }

    stop(destroyPlayer: boolean): Promise<unknown> {
        this.hostRequestRevision += 1;
        // PlaybackManager stops the playing item before it negotiates the next one, whose request may still read its head
        this.headPrefetches.cancel();
        // NOTE: PlaybackManager ignores 'stopped' while isChangingStream is set, which a stop during a stream change would otherwise leave behind
        this.isChangingStream = false;
        return super.stop(destroyPlayer);
    }

    destroy(): void {
        this.hostRequestRevision += 1;
        this.headPrefetchRequest = null;
        this.headPrefetches.cancel();
        super.destroy();
    }

    /** Cancels a pending start because PlaybackManager began another request; returns whether one was pending. */
    cancelPendingPlayForNewRequest(): boolean {
        const hadPendingPlay = this.hasPendingPlay();
        this.hostRequestRevision += 1;
        this.startedSinceHostRequest = false;
        this.headPrefetchRequest = null;
        this.headPrefetches.cancel();
        this.cancelPendingPlay();
        return hadPendingPlay;
    }

    /**
     * Notes a request PlaybackManager began that starts a playback, with the media source it names, whose first negotiation may then read the
     * stream's head; returns the function that ends the request once it settled.
     */
    beginPlaybackRequest(mediaSourceId: string | null): () => void {
        const request: PlaybackRequest = { mediaSourceId };
        this.headPrefetchRequest = request;
        return (): void => {
            if (this.headPrefetchRequest === request) {
                this.headPrefetchRequest = null;
            }
        };
    }

    /**
     * Returns whether PlaybackManager's latest request has yet to start here, or is still starting here.
     * The hooks cannot read this from PlaybackManager's promise, which never settles for a start that a stream change, stop, or destroy supersedes.
     */
    isRequestStartPending(): boolean {
        return !this.startedSinceHostRequest || this.hasPendingPlay();
    }

    /**
     * Starts reading the head of the stream that the first negotiation for playback of PlaybackManager's request is predicted to direct play, so
     * the read overlaps the device profile and PlaybackInfo.
     * Only an item this player would play with custom decode is read ahead: no HTML player preference, custom decode on, and its runtime present.
     */
    private startHeadPrefetch(item: unknown, deviceProfileOptions: unknown): void {
        const request = this.headPrefetchRequest;
        // Stream changes and retries pass options, and a request's later negotiations, such as for its next item, read their own heads
        if (!request || getPlaybackInfoNegotiationPurpose(deviceProfileOptions) !== PlaybackInfoNegotiationPurpose.Selection) {
            return;
        }
        this.headPrefetchRequest = null;
        // The negotiation adopts the server's latest client defaults first, which may turn custom decode off
        this.headPrefetches.start(whenClientDefaultsSettled(), (): DirectPlayStreamPrediction | null => {
            if (!this.canPlayItem(item) || !isStoredWebGPUCustomDecodeEnabled() || !getCustomPlaybackRuntimeAvailability().available) {
                return null;
            }
            const serverId = item && typeof item === 'object' ? (item as NegotiationItem).ServerId : null;
            const apiClient: StreamURLBuilder | null = serverId ? ServerConnections.getApiClient(serverId) ?? null : null;
            return apiClient ? predictDirectPlayStream(item, request.mediaSourceId, apiClient) : null;
        });
    }

    private abandonSupersededPlay(options: unknown): Promise<never> {
        stopSupersededEncodings(options);
        // A fresh promise per request lets PlaybackManager's pending continuation be collected
        return new Promise<never>((): void => undefined);
    }
}

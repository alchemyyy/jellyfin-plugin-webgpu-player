import { ServerConnections } from 'lib/jellyfin-apiclient';

import {
    ensurePlaybackInfoInterceptors,
    markPlaybackInfoNegotiation,
    type NegotiationItem
} from './compat/PlaybackInfoInterceptor';
import { isPlaybackSuperseded } from './constants/playbackResult';
import { VideoPlayerPreference } from './PreferredVideoPlayer';
import { preferredVideoPlayer } from './shims/userSettings';
import WebGPUPlayer from './WebGPUPlayer';

type StreamingBitrateRequest = Parameters<WebGPUPlayer['getMaxStreamingBitrate']>[0];

/** Stream state the stock PlaybackManager writes onto the player through getPlayerData() */
type HostStreamInfo = {
    item?: { ServerId?: string | null } | null
    mediaSource?: { MediaStreams?: unknown } | null
    playMethod?: string | null
    playSessionId?: string | null
};

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
 * The fork's WebGPU player adapted to the stock PlaybackManager, which lacks the fork's
 * bitrate purposes, superseded results, and request generations.
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
        const negotiationItem: NegotiationItem = item && typeof item === 'object' ? item as NegotiationItem : {};
        const interceptorsActive = ensurePlaybackInfoInterceptors(negotiationItem.ServerId);
        const profile = await super.getDeviceProfile(item, options);
        return interceptorsActive ?
            markPlaybackInfoNegotiation(profile, this, negotiationItem, options) :
            profile;
    }

    /** Never settles a superseded start, because the stock PlaybackManager treats any settlement as a start. */
    play(options: unknown): Promise<unknown> {
        const playPromise = super.play(options);
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
        // NOTE: PlaybackManager ignores 'stopped' while isChangingStream is set, which a stop during a
        // stream change would otherwise leave behind
        this.isChangingStream = false;
        return super.stop(destroyPlayer);
    }

    destroy(): void {
        this.hostRequestRevision += 1;
        super.destroy();
    }

    /** Cancels a pending start because PlaybackManager began another request; returns whether one was pending. */
    cancelPendingPlayForNewRequest(): boolean {
        const hadPendingPlay = this.hasPendingPlay();
        this.hostRequestRevision += 1;
        this.startedSinceHostRequest = false;
        this.cancelPendingPlay();
        return hadPendingPlay;
    }

    /**
     * Returns whether PlaybackManager's latest request has yet to start here, or is still starting here.
     * The hooks cannot read this from PlaybackManager's promise, which never settles for a start that a stream change, stop, or destroy supersedes.
     */
    isRequestStartPending(): boolean {
        return !this.startedSinceHostRequest || this.hasPendingPlay();
    }

    private abandonSupersededPlay(options: unknown): Promise<never> {
        stopSupersededEncodings(options);
        // A fresh promise per request lets PlaybackManager's pending continuation be collected
        return new Promise<never>((): void => undefined);
    }
}

// Ported unchanged from the fork's components/playback/PlaybackStreamCopyPolicy.
// The PlaybackInfo interceptor applies this veto because the stock PlaybackManager has no stream-copy seam

type PlaybackVideoStreamCopyPlayer = {
    supportsVideoStreamCopy?: (
        item: unknown,
        mediaSourceId: string | null | undefined,
        mediaStreams: unknown
    ) => boolean
};

/** Returns false only when the player's supportsVideoStreamCopy vetoes video stream copy for the source. */
export function shouldAllowVideoStreamCopy(
    player: PlaybackVideoStreamCopyPlayer | null | undefined,
    item: unknown,
    mediaSourceId: string | null | undefined,
    mediaStreams?: unknown
): boolean {
    return player?.supportsVideoStreamCopy?.(item, mediaSourceId, mediaStreams) !== false;
}

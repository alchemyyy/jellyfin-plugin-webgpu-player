// Ported unchanged from the fork's components/playback/PlaybackStreamCopyPolicy; the PlaybackInfo
// interceptor applies this veto because the stock PlaybackManager has no stream-copy seam

type PlaybackVideoStreamCopyPlayer = {
    supportsVideoStreamCopy?: (
        item: unknown,
        mediaSourceId: string | null | undefined,
        mediaStreams: unknown
    ) => boolean
};

/** Applies an optional player-specific video stream-copy capability gate. */
export function shouldAllowVideoStreamCopy(
    player: PlaybackVideoStreamCopyPlayer | null | undefined,
    item: unknown,
    mediaSourceId: string | null | undefined,
    mediaStreams?: unknown
): boolean {
    return player?.supportsVideoStreamCopy?.(item, mediaSourceId, mediaStreams) !== false;
}

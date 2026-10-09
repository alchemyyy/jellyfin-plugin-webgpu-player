import type { PlaybackInfoDto } from '@jellyfin/sdk/lib/generated-client/models/playback-info-dto';

import {
    getPlayerMaxStreamingBitrate,
    PLAYBACK_SELECTION_BITRATE_PURPOSE,
    shouldKeepTranscode,
    shouldUsePostSelectionTranscodeBitrate,
    TRANSCODE_OUTPUT_BITRATE_PURPOSE,
    type PlaybackBitrateRequest
} from './PlaybackBitratePolicy';
import type { MediaSourceSelection } from './MediaSourceSelection';

// The fork's PlaybackManager negotiation rules, applied to the PlaybackInfo bodies the stock PlaybackManager builds

/** Which stock PlaybackManager path built a PlaybackInfo request */
export enum PlaybackInfoNegotiationPurpose {
    // playAfterBitrateDetect, getPlaybackInfo, and getPlaybackMediaSources ask for a profile without options
    Selection = 'selection',
    // changeStream, including the error retry ladder, passes { isRetry }
    StreamChange = 'stream-change'
}

/** PlaybackInfo body fields the stock PlaybackManager sends beyond the generated DTO */
export type PlaybackInfoRequestBody = PlaybackInfoDto & {
    IsPlayback?: boolean | null
    [field: string]: unknown
};

/** The player rules the policy consults, as the fork's PlaybackManager did */
export type NegotiatingPlayer = {
    getMaxStreamingBitrate?: (request?: PlaybackBitrateRequest) => number | null | undefined
};

export type PlaybackInfoRequestContext = Readonly<{
    // Result of the fork's stream-copy veto for this request's source
    allowVideoStreamCopy: boolean
    // The play method of the stream the player is currently playing, for stream changes
    currentPlayMethod: string | null | undefined
    player: NegotiatingPlayer
    purpose: PlaybackInfoNegotiationPurpose
}>;

/** Bitrates that decide whether a bitrate-free first selection needs a sized second request */
export type TranscodeSizingRequest = Readonly<{
    selectionBitrate: number | null | undefined
    transcodingBitrate: number | null | undefined
}>;

export type PlaybackInfoRequestDecision = Readonly<{
    body: PlaybackInfoRequestBody
    transcodeSizing: TranscodeSizingRequest | null
}>;

/** Classifies a getDeviceProfile call by the options the stock PlaybackManager passes. */
export function getPlaybackInfoNegotiationPurpose(deviceProfileOptions: unknown): PlaybackInfoNegotiationPurpose {
    return deviceProfileOptions !== null && typeof deviceProfileOptions === 'object' ?
        PlaybackInfoNegotiationPurpose.StreamChange :
        PlaybackInfoNegotiationPurpose.Selection;
}

function getRequestedBitrate(body: PlaybackInfoRequestBody): number | null {
    const bitrate = body.MaxStreamingBitrate;
    return typeof bitrate === 'number' ? bitrate : null;
}

/** Sets the bitrate the way the stock getPlaybackInfo does: only a truthy value is sent. */
function setRequestedBitrate(body: PlaybackInfoRequestBody, bitrate: number | null | undefined): void {
    if (bitrate) {
        body.MaxStreamingBitrate = bitrate;
        return;
    }
    delete body.MaxStreamingBitrate;
}

/**
 * Rewrites one PlaybackInfo body with the fork's rules:
 * - selection omits bitrate;
 * - a stream change during a transcode keeps transcoding at the transcode-output bitrate;
 * - a stream-copy veto disables video copy.
 */
export function applyPlaybackInfoRequestPolicy(
    body: PlaybackInfoRequestBody,
    context: PlaybackInfoRequestContext
): PlaybackInfoRequestDecision {
    const nextBody: PlaybackInfoRequestBody = { ...body };
    if (nextBody.AllowVideoStreamCopy !== false && !context.allowVideoStreamCopy) {
        nextBody.AllowVideoStreamCopy = false;
    }

    // The body carries the cap the stock PlaybackManager would use, which is the fork's fallback bitrate.
    // On first play that is the detected bitrate; on stream changes it is the requested bitrate or the cap getMaxStreamingBitrate() returns
    const fallbackBitrate = getRequestedBitrate(body);
    switch (context.purpose) {
        case PlaybackInfoNegotiationPurpose.Selection: {
            const selectionBitrate = getPlayerMaxStreamingBitrate(context.player, fallbackBitrate);
            const transcodingBitrate = getPlayerMaxStreamingBitrate(
                context.player,
                fallbackBitrate,
                TRANSCODE_OUTPUT_BITRATE_PURPOSE
            );
            setRequestedBitrate(nextBody, selectionBitrate);
            // Only playback (getPlaybackMediaSource) sized a decided transcode with a second request
            const transcodeSizing = nextBody.IsPlayback === true ?
                { selectionBitrate, transcodingBitrate } :
                null;
            return { body: nextBody, transcodeSizing };
        }
        case PlaybackInfoNegotiationPurpose.StreamChange: {
            const keepTranscode = shouldKeepTranscode(context.player, context.currentPlayMethod, fallbackBitrate);
            const transcodeOutputRequest = (body.EnableDirectPlay === false && body.EnableDirectStream === false) || keepTranscode;
            if (keepTranscode) {
                nextBody.EnableDirectPlay = false;
                nextBody.EnableDirectStream = false;
            }
            setRequestedBitrate(nextBody, getPlayerMaxStreamingBitrate(
                context.player,
                fallbackBitrate,
                transcodeOutputRequest ?
                    TRANSCODE_OUTPUT_BITRATE_PURPOSE :
                    PLAYBACK_SELECTION_BITRATE_PURPOSE
            ));
            return { body: nextBody, transcodeSizing: null };
        }
    }
}

/** Returns whether the selected source needs the fork's second, transcode-sizing request. */
export function needsTranscodeSizingRequest(sizing: TranscodeSizingRequest, selection: MediaSourceSelection): boolean {
    return !selection.mediaSource.RequiresOpening
        && shouldUsePostSelectionTranscodeBitrate(
            sizing.selectionBitrate,
            sizing.transcodingBitrate,
            {
                enableDirectPlay: selection.enableDirectPlay,
                SupportsDirectStream: selection.mediaSource.SupportsDirectStream,
                SupportsTranscoding: selection.mediaSource.SupportsTranscoding
            }
        );
}

/** Builds the second request: the decided transcode for the selected source, sized at the transcode bitrate. */
export function createTranscodeSizingRequestBody(
    sentBody: PlaybackInfoRequestBody,
    mediaSourceId: string | null | undefined,
    transcodingBitrate: number | null | undefined
): PlaybackInfoRequestBody {
    const nextBody: PlaybackInfoRequestBody = {
        ...sentBody,
        EnableDirectPlay: false,
        EnableDirectStream: false
    };
    if (mediaSourceId) {
        nextBody.MediaSourceId = mediaSourceId;
    } else {
        delete nextBody.MediaSourceId;
    }
    setRequestedBitrate(nextBody, transcodingBitrate);
    return nextBody;
}

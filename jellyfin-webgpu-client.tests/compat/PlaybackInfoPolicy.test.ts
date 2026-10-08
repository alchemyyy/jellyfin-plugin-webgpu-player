import { describe, expect, it } from 'vitest';

import type { MediaSourceSelection } from 'addons/webGPUPlayer/compat/MediaSourceSelection';
import type { PlaybackBitrateRequest } from 'addons/webGPUPlayer/compat/PlaybackBitratePolicy';
import {
    applyPlaybackInfoRequestPolicy,
    createTranscodeSizingRequestBody,
    getPlaybackInfoNegotiationPurpose,
    needsTranscodeSizingRequest,
    PlaybackInfoNegotiationPurpose,
    type NegotiatingPlayer,
    type PlaybackInfoRequestBody,
    type PlaybackInfoRequestContext
} from 'addons/webGPUPlayer/compat/PlaybackInfoPolicy';

const DETECTED_BITRATE = 20_000_000;
const REQUESTED_BITRATE = 8_000_000;

// Mirrors the WebGPU player: no bitrate for selection, the fallback for transcode output
const BITRATE_FREE_PLAYER: NegotiatingPlayer = {
    getMaxStreamingBitrate: (bitrateRequest?: PlaybackBitrateRequest): number | null => (
        bitrateRequest?.purpose === 'transcode-output' ? bitrateRequest.fallbackBitrate ?? null : null
    )
};

function createContext(overrides: Partial<PlaybackInfoRequestContext> = {}): PlaybackInfoRequestContext {
    return {
        allowVideoStreamCopy: true,
        currentPlayMethod: null,
        player: BITRATE_FREE_PLAYER,
        purpose: PlaybackInfoNegotiationPurpose.Selection,
        ...overrides
    };
}

function createSelection(overrides: Partial<MediaSourceSelection['mediaSource']> = {}, enableDirectPlay = false): MediaSourceSelection {
    return {
        enableDirectPlay,
        mediaSource: {
            Id: 'source',
            SupportsDirectStream: false,
            SupportsTranscoding: true,
            ...overrides
        }
    };
}

describe('getPlaybackInfoNegotiationPurpose', () => {
    it('treats calls without options as a selection', () => {
        expect(getPlaybackInfoNegotiationPurpose(undefined)).toBe(PlaybackInfoNegotiationPurpose.Selection);
        expect(getPlaybackInfoNegotiationPurpose(null)).toBe(PlaybackInfoNegotiationPurpose.Selection);
    });

    it('treats changeStream options, including retries, as a stream change', () => {
        expect(getPlaybackInfoNegotiationPurpose({ isRetry: false })).toBe(PlaybackInfoNegotiationPurpose.StreamChange);
        expect(getPlaybackInfoNegotiationPurpose({ isRetry: true })).toBe(PlaybackInfoNegotiationPurpose.StreamChange);
    });
});

describe('applyPlaybackInfoRequestPolicy for selection', () => {
    it('omits the bitrate and keeps the detected bitrate for sizing a decided transcode', () => {
        const body: PlaybackInfoRequestBody = {
            IsPlayback: true,
            MaxStreamingBitrate: DETECTED_BITRATE,
            StartTimeTicks: 10
        };

        const decision = applyPlaybackInfoRequestPolicy(body, createContext());

        expect(decision.body).toEqual({ IsPlayback: true, StartTimeTicks: 10 });
        expect(decision.transcodeSizing).toEqual({
            selectionBitrate: null,
            transcodingBitrate: DETECTED_BITRATE
        });
        // The input body is left untouched
        expect(body.MaxStreamingBitrate).toBe(DETECTED_BITRATE);
    });

    it('does not size transcodes for media information requests', () => {
        const decision = applyPlaybackInfoRequestPolicy(
            { IsPlayback: false, MaxStreamingBitrate: DETECTED_BITRATE },
            createContext()
        );

        expect(decision.body).toEqual({ IsPlayback: false });
        expect(decision.transcodeSizing).toBeNull();
    });

    it('reports no transcode bitrate when the stock request carried none', () => {
        const decision = applyPlaybackInfoRequestPolicy({ IsPlayback: true }, createContext());

        expect(decision.transcodeSizing).toEqual({ selectionBitrate: null, transcodingBitrate: null });
    });

    it('keeps the stock bitrate for players without the bitrate seam', () => {
        const decision = applyPlaybackInfoRequestPolicy(
            { IsPlayback: true, MaxStreamingBitrate: DETECTED_BITRATE },
            createContext({ player: {} })
        );

        expect(decision.body.MaxStreamingBitrate).toBe(DETECTED_BITRATE);
        expect(decision.transcodeSizing).toEqual({
            selectionBitrate: DETECTED_BITRATE,
            transcodingBitrate: DETECTED_BITRATE
        });
    });
});

describe('applyPlaybackInfoRequestPolicy stream-copy veto', () => {
    it('disables video stream copy when the player vetoes it', () => {
        const decision = applyPlaybackInfoRequestPolicy(
            { IsPlayback: true },
            createContext({ allowVideoStreamCopy: false })
        );

        expect(decision.body.AllowVideoStreamCopy).toBe(false);
    });

    it('leaves the stock value when the player allows stream copy', () => {
        expect(applyPlaybackInfoRequestPolicy({ IsPlayback: true }, createContext()).body)
            .not.toHaveProperty('AllowVideoStreamCopy');
        expect(applyPlaybackInfoRequestPolicy(
            { AllowVideoStreamCopy: false },
            createContext()
        ).body.AllowVideoStreamCopy).toBe(false);
    });
});

describe('applyPlaybackInfoRequestPolicy for stream changes', () => {
    it('keeps a running transcode a transcode at the transcode-output bitrate', () => {
        const decision = applyPlaybackInfoRequestPolicy(
            { AudioStreamIndex: 2, MaxStreamingBitrate: REQUESTED_BITRATE, MediaSourceId: 'source' },
            createContext({
                currentPlayMethod: 'Transcode',
                purpose: PlaybackInfoNegotiationPurpose.StreamChange
            })
        );

        expect(decision.body).toEqual({
            AudioStreamIndex: 2,
            EnableDirectPlay: false,
            EnableDirectStream: false,
            MaxStreamingBitrate: REQUESTED_BITRATE,
            MediaSourceId: 'source'
        });
        expect(decision.transcodeSizing).toBeNull();
    });

    it('reselects without a bitrate while direct playing', () => {
        const decision = applyPlaybackInfoRequestPolicy(
            { AudioStreamIndex: 2, MaxStreamingBitrate: REQUESTED_BITRATE },
            createContext({
                currentPlayMethod: 'DirectPlay',
                purpose: PlaybackInfoNegotiationPurpose.StreamChange
            })
        );

        expect(decision.body).toEqual({ AudioStreamIndex: 2 });
    });

    it('sizes an error retry that forbids direct play and direct stream', () => {
        const decision = applyPlaybackInfoRequestPolicy(
            { EnableDirectPlay: false, EnableDirectStream: false, MaxStreamingBitrate: DETECTED_BITRATE },
            createContext({
                currentPlayMethod: 'DirectPlay',
                purpose: PlaybackInfoNegotiationPurpose.StreamChange
            })
        );

        expect(decision.body).toEqual({
            EnableDirectPlay: false,
            EnableDirectStream: false,
            MaxStreamingBitrate: DETECTED_BITRATE
        });
    });

    it('selects a remote retry that may still direct stream without a bitrate', () => {
        const decision = applyPlaybackInfoRequestPolicy(
            { EnableDirectPlay: false, EnableDirectStream: true, MaxStreamingBitrate: DETECTED_BITRATE },
            createContext({
                currentPlayMethod: 'DirectStream',
                purpose: PlaybackInfoNegotiationPurpose.StreamChange
            })
        );

        expect(decision.body).toEqual({ EnableDirectPlay: false, EnableDirectStream: true });
    });
});

describe('needsTranscodeSizingRequest', () => {
    const sizing = { selectionBitrate: null, transcodingBitrate: DETECTED_BITRATE };

    it('sizes a transcode-only selection', () => {
        expect(needsTranscodeSizingRequest(sizing, createSelection())).toBe(true);
    });

    it('does not size direct play, direct stream, or sources that need opening', () => {
        expect(needsTranscodeSizingRequest(sizing, createSelection({}, true))).toBe(false);
        expect(needsTranscodeSizingRequest(sizing, createSelection({ SupportsDirectStream: true }))).toBe(false);
        expect(needsTranscodeSizingRequest(sizing, createSelection({ RequiresOpening: true }))).toBe(false);
        expect(needsTranscodeSizingRequest(sizing, createSelection({ SupportsTranscoding: false }))).toBe(false);
    });

    it('does not size when selection already carried a bitrate or no bitrate is known', () => {
        expect(needsTranscodeSizingRequest(
            { selectionBitrate: DETECTED_BITRATE, transcodingBitrate: DETECTED_BITRATE },
            createSelection()
        )).toBe(false);
        expect(needsTranscodeSizingRequest(
            { selectionBitrate: null, transcodingBitrate: null },
            createSelection()
        )).toBe(false);
        expect(needsTranscodeSizingRequest(
            { selectionBitrate: null, transcodingBitrate: 0 },
            createSelection()
        )).toBe(false);
    });
});

describe('createTranscodeSizingRequestBody', () => {
    it('requests the decided transcode for the selected source at the transcode bitrate', () => {
        const sentBody: PlaybackInfoRequestBody = {
            AllowVideoStreamCopy: false,
            AudioStreamIndex: 1,
            DeviceProfile: { Name: 'profile' },
            IsPlayback: true,
            StartTimeTicks: 5
        };

        const sizedBody = createTranscodeSizingRequestBody(sentBody, 'selected', DETECTED_BITRATE);

        expect(sizedBody).toEqual({
            AllowVideoStreamCopy: false,
            AudioStreamIndex: 1,
            DeviceProfile: { Name: 'profile' },
            EnableDirectPlay: false,
            EnableDirectStream: false,
            IsPlayback: true,
            MaxStreamingBitrate: DETECTED_BITRATE,
            MediaSourceId: 'selected',
            StartTimeTicks: 5
        });
        expect(sentBody).not.toHaveProperty('MaxStreamingBitrate');
    });
});

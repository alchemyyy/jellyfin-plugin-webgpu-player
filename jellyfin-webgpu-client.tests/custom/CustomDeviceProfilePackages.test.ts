import type { DeviceProfile } from '@jellyfin/sdk/lib/generated-client/models/device-profile';
import { describe, expect, it } from 'vitest';

import {
    augmentDeviceProfileForCustomDecode,
    type DecoderPackageRouteSummary
} from 'addons/webGPUPlayer/custom/CustomDeviceProfile';
import { isSameSessionNativePlaybackCompatible } from 'addons/webGPUPlayer/custom/NativeDirectPlayCompatibility';
import {
    CUSTOM_AUDIO_CODECS,
    CUSTOM_RAW_HDR_VIDEO_CODECS,
    CUSTOM_VIDEO_CODECS,
    type CustomAudioCodec,
    type CustomDecodeCapabilities,
    type CustomDecodeCodecCapability,
    type CustomRawHDRVideoCodec,
    type CustomRawHDRVideoCodecCapability,
    type CustomVideoCodec
} from 'webgpu-player/capability/CustomDecodeCapabilities';

import { createConfigCodecCapability } from './CustomDecodeCapabilityBuilders';

// The decoder packages the engine's decoder projects build, as the server's catalog describes them
const MPEG2_PACKAGE: DecoderPackageRouteSummary = { codecs: [ 'mpeg2video', 'mpeg1video' ], kind: 'video', outputFormats: [ 'I420', 'I422', 'I444' ] };
const EVERY_FORMAT = [ 'I420', 'I420P10', 'I420P12', 'I422', 'I422P10', 'I422P12', 'I444', 'I444P10', 'I444P12' ];
const AV1_PACKAGE: DecoderPackageRouteSummary = { codecs: [ 'av1' ], kind: 'video', outputFormats: EVERY_FORMAT };
const HEVC_PACKAGE: DecoderPackageRouteSummary = { codecs: [ 'hevc' ], kind: 'video', outputFormats: EVERY_FORMAT };
const EAC3_PACKAGE: DecoderPackageRouteSummary = { codecs: [ 'eac3', 'ac3' ], kind: 'audio', outputFormats: [] };
// A package that names a codec and a format the engine has no name for, which negotiation ignores
const UNKNOWN_PACKAGE: DecoderPackageRouteSummary = { codecs: [ 'uncompressed' ], kind: 'video', outputFormats: [ 'RGBA' ] };

const MATROSKA_CONTAINER = 'mkv';
const TRANSPORT_STREAM_CONTAINER = 'ts';
const STEREO_CHANNEL_COUNT = 2;
const SURROUND_CHANNEL_COUNT = 6;
const SAMPLE_RATE = 48_000;
const EIGHT_BIT_DEPTH = 8;
const TEN_BIT_DEPTH = 10;
const TWELVE_BIT_DEPTH = 12;
const SDR_RANGE_TYPE = 'SDR';
const HDR10_RANGE_TYPE = 'HDR10';

type StreamRecord = Readonly<Record<string, unknown>>;

/** Returns probe results in which WebCodecs decodes H.264, the given video codecs, and AAC, and no raw route exists. */
function createCapabilities(supportedVideoCodecs: readonly CustomVideoCodec[] = []): CustomDecodeCapabilities {
    const supportedVideoSet = new Set<CustomVideoCodec>([ 'h264', ...supportedVideoCodecs ]);
    const video = {} as Record<CustomVideoCodec, CustomDecodeCodecCapability<CustomVideoCodec>>;
    for (const codec of CUSTOM_VIDEO_CODECS) {
        video[codec] = createConfigCodecCapability(codec, supportedVideoSet.has(codec));
    }
    const audio = {} as Record<CustomAudioCodec, CustomDecodeCodecCapability<CustomAudioCodec>>;
    for (const codec of CUSTOM_AUDIO_CODECS) {
        audio[codec] = createConfigCodecCapability(codec, codec === 'aac');
    }
    const rawHDRVideo = {} as Record<CustomRawHDRVideoCodec, CustomRawHDRVideoCodecCapability>;
    for (const codec of CUSTOM_RAW_HDR_VIDEO_CODECS) {
        rawHDRVideo[codec] = { bitDepth: TEN_BIT_DEPTH, codec, codecString: codec, format: 'I420P10', reason: 'output-copy-unsupported', status: 'unsupported' };
    }
    return {
        audio,
        rawHDRVideo,
        telemetry: {
            audioProbeCount: 0,
            mediabunnyAudioCodecCount: 0,
            nativeHDRVideoProbeCount: 0,
            nativeSurroundAudioProbeCount: 0,
            nativeUltraHDVideoProbeCount: 0,
            rawHDRVideoProbeCount: 0,
            reason: 'complete',
            supportedAudioCodecCount: 1,
            supportedNativeHDRVideoCodecCount: 0,
            supportedNativeSurroundAudioCodecCount: 0,
            supportedNativeUltraHDVideoCodecCount: 0,
            supportedRawHDRVideoCodecCount: 0,
            supportedVideoCodecCount: supportedVideoSet.size,
            unknownAudioCodecCount: 0,
            unknownNativeHDRVideoCodecCount: 0,
            unknownNativeSurroundAudioCodecCount: 0,
            unknownNativeUltraHDVideoCodecCount: 0,
            unknownVideoCodecCount: 0,
            videoProbeCount: 0
        },
        video
    };
}

/** Returns a stock profile that direct-plays H.264 and AAC in MP4, with Jellyfin Web's AV1 ceiling of Main SDR. */
function createStockProfile(): DeviceProfile {
    return {
        CodecProfiles: [ {
            Codec: 'av1',
            Conditions: [
                { Condition: 'EqualsAny', IsRequired: false, Property: 'VideoProfile', Value: 'main' },
                { Condition: 'EqualsAny', IsRequired: false, Property: 'VideoRangeType', Value: SDR_RANGE_TYPE }
            ],
            Type: 'Video'
        } ],
        DirectPlayProfiles: [ { AudioCodec: 'aac', Container: 'mp4', Type: 'Video', VideoCodec: 'h264' } ],
        Name: 'HTML profile',
        TranscodingProfiles: []
    };
}

function createVideoStream(codec: string, profile: string, bitDepth: number, overrides: StreamRecord = {}): StreamRecord {
    return {
        BitDepth: bitDepth,
        Codec: codec,
        Height: 1_080,
        Index: 0,
        IsInterlaced: false,
        Profile: profile,
        Type: 'Video',
        VideoRange: 'SDR',
        VideoRangeType: SDR_RANGE_TYPE,
        Width: 1_920,
        ...overrides
    };
}

function createAudioStream(codec: string, channelCount: number): StreamRecord {
    return { Channels: channelCount, Codec: codec, Index: 1, SampleRate: SAMPLE_RATE, Type: 'Audio' };
}

/** Returns whether a profile direct-plays a source of one video and one audio stream in a container. */
function isDirectPlayAdvertised(profile: DeviceProfile, container: string, videoStream: StreamRecord, audioStream = createAudioStream('aac', STEREO_CHANNEL_COUNT)): boolean {
    return isSameSessionNativePlaybackCompatible({
        mediaSource: {
            Container: container,
            DefaultAudioStreamIndex: 1,
            MediaStreams: [ videoStream, audioStream ],
            SupportsDirectPlay: true
        },
        playMethod: 'DirectPlay',
        url: `/Videos/item/stream.${container}`
    }, profile);
}

function augment(
    decoderPackages: readonly DecoderPackageRouteSummary[],
    supportedVideoCodecs: readonly CustomVideoCodec[] = [],
    allowFramePoolHDR = false
): DeviceProfile {
    return augmentDeviceProfileForCustomDecode(createStockProfile(), createCapabilities(supportedVideoCodecs), { allowFramePoolHDR, decoderPackages }).profile;
}

describe('augmentDeviceProfileForCustomDecode with decoder packages', () => {
    it('advertises a codec only a package decodes, in each container that carries it, as progressive SDR at its depths', () => {
        const mpeg2Stream = createVideoStream('mpeg2video', 'Main', EIGHT_BIT_DEPTH);

        const withoutPackage = augment([]);
        const withPackage = augment([ MPEG2_PACKAGE ]);

        expect(isDirectPlayAdvertised(withoutPackage, MATROSKA_CONTAINER, mpeg2Stream)).toBe(false);
        expect(isDirectPlayAdvertised(withPackage, MATROSKA_CONTAINER, mpeg2Stream)).toBe(true);
        expect(isDirectPlayAdvertised(withPackage, TRANSPORT_STREAM_CONTAINER, mpeg2Stream)).toBe(true);
        expect(isDirectPlayAdvertised(withPackage, MATROSKA_CONTAINER, { ...mpeg2Stream, IsInterlaced: true })).toBe(false);
        expect(isDirectPlayAdvertised(withPackage, MATROSKA_CONTAINER, { ...mpeg2Stream, BitDepth: TEN_BIT_DEPTH })).toBe(false);
    });

    it('widens AV1\'s stock Main ceiling to the profiles the package writes', () => {
        const highStream = createVideoStream('av1', 'High', TEN_BIT_DEPTH);
        const professionalStream = createVideoStream('av1', 'Professional', TWELVE_BIT_DEPTH);
        const mainStream = createVideoStream('av1', 'Main', EIGHT_BIT_DEPTH);

        const withoutPackage = augment([], [ 'av1' ]);
        const withPackage = augment([ AV1_PACKAGE ], [ 'av1' ]);

        expect(isDirectPlayAdvertised(withoutPackage, MATROSKA_CONTAINER, mainStream)).toBe(true);
        expect(isDirectPlayAdvertised(withoutPackage, MATROSKA_CONTAINER, highStream)).toBe(false);
        expect(isDirectPlayAdvertised(withPackage, MATROSKA_CONTAINER, mainStream)).toBe(true);
        expect(isDirectPlayAdvertised(withPackage, MATROSKA_CONTAINER, highStream)).toBe(true);
        expect(isDirectPlayAdvertised(withPackage, MATROSKA_CONTAINER, professionalStream)).toBe(true);
        expect(isDirectPlayAdvertised(withPackage, MATROSKA_CONTAINER, createVideoStream('av1', 'High', TWELVE_BIT_DEPTH))).toBe(false);
    });

    it('advertises a package\'s HDR only when the frame pool may present it', () => {
        const hdrStream = createVideoStream('av1', 'High', TEN_BIT_DEPTH, { VideoRange: 'HDR', VideoRangeType: HDR10_RANGE_TYPE });

        expect(isDirectPlayAdvertised(augment([ AV1_PACKAGE ], [ 'av1' ]), MATROSKA_CONTAINER, hdrStream)).toBe(false);
        expect(isDirectPlayAdvertised(augment([ AV1_PACKAGE ], [ 'av1' ], true), MATROSKA_CONTAINER, hdrStream)).toBe(true);
    });

    it('advertises the HEVC range extensions a package writes, by their named and generic profiles', () => {
        const named422Stream = createVideoStream('hevc', 'Main 4:2:2 10', TEN_BIT_DEPTH);
        const generic12BitStream = createVideoStream('hevc', 'Rext', TWELVE_BIT_DEPTH);

        const withoutPackage = augment([]);
        const withPackage = augment([ HEVC_PACKAGE ]);

        expect(isDirectPlayAdvertised(withoutPackage, MATROSKA_CONTAINER, named422Stream)).toBe(false);
        expect(isDirectPlayAdvertised(withPackage, MATROSKA_CONTAINER, named422Stream)).toBe(true);
        expect(isDirectPlayAdvertised(withPackage, MATROSKA_CONTAINER, generic12BitStream)).toBe(true);
        expect(isDirectPlayAdvertised(withPackage, MATROSKA_CONTAINER, createVideoStream('hevc', 'Main 10', TEN_BIT_DEPTH))).toBe(true);
    });

    it('advertises an audio codec a package decodes at every layout the decoded path presents', () => {
        // AV1 Main has a native route here, so only the audio decides
        const videoStream = createVideoStream('av1', 'Main', EIGHT_BIT_DEPTH);
        const surroundStream = createAudioStream('eac3', SURROUND_CHANNEL_COUNT);

        expect(isDirectPlayAdvertised(augment([], [ 'av1' ]), MATROSKA_CONTAINER, videoStream)).toBe(true);
        expect(isDirectPlayAdvertised(augment([], [ 'av1' ]), MATROSKA_CONTAINER, videoStream, surroundStream)).toBe(false);
        expect(isDirectPlayAdvertised(augment([ EAC3_PACKAGE ], [ 'av1' ]), MATROSKA_CONTAINER, videoStream, surroundStream)).toBe(true);
        expect(isDirectPlayAdvertised(augment([ EAC3_PACKAGE ], [ 'av1' ]), MATROSKA_CONTAINER, videoStream, createAudioStream('ac3', SURROUND_CHANNEL_COUNT))).toBe(true);
    });

    it('ignores codecs and formats the engine has no name for, and widens nothing on a retry', () => {
        const unknownProfile = augment([ UNKNOWN_PACKAGE ]);
        const retryProfile = augmentDeviceProfileForCustomDecode(
            createStockProfile(),
            createCapabilities(),
            { decoderPackages: [ MPEG2_PACKAGE ], isRetry: true }
        ).profile;

        expect(unknownProfile).toEqual(augment([]));
        expect(retryProfile.DirectPlayProfiles).toEqual(createStockProfile().DirectPlayProfiles);
    });
});

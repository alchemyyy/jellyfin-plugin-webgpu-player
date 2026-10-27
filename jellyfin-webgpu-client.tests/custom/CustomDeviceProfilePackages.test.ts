import type { DeviceProfile } from '@jellyfin/sdk/lib/generated-client/models/device-profile';
import { describe, expect, it } from 'vitest';

import {
    augmentDeviceProfileForCustomDecode,
    type DecoderPackageRouteSummary
} from 'addons/webGPUPlayer/custom/CustomDeviceProfile';
import { isSameSessionNativePlaybackCompatible } from 'addons/webGPUPlayer/custom/NativeDirectPlayCompatibility';
import { CUSTOM_PROFILE_VIDEO_CONTAINERS } from 'webgpu-player/capability/CustomContainerCodecSupport';
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

import { createConfigCodecCapability, createH264ProfileCapabilities } from './CustomDecodeCapabilityBuilders';
import { HEVC_HEADER, MPEG2_HEADER } from './DecoderPackageHeaders';

// The decoder packages the engine's decoder projects build, as the server's catalog describes them
const MPEG2_PACKAGE: DecoderPackageRouteSummary = { codecs: [ 'mpeg2video', 'mpeg1video' ], kind: 'video', outputFormats: [ 'I420', 'I422', 'I444' ] };
const EVERY_FORMAT = [ 'I420', 'I420P10', 'I420P12', 'I422', 'I422P10', 'I422P12', 'I444', 'I444P10', 'I444P12' ];
const AV1_PACKAGE: DecoderPackageRouteSummary = { codecs: [ 'av1' ], kind: 'video', outputFormats: EVERY_FORMAT };
const HEVC_PACKAGE: DecoderPackageRouteSummary = { codecs: [ 'hevc' ], kind: 'video', outputFormats: EVERY_FORMAT };
const EAC3_PACKAGE: DecoderPackageRouteSummary = { codecs: [ 'eac3', 'ac3' ], kind: 'audio', outputFormats: [] };
// A package that names a codec and a format the engine has no name for, which negotiation ignores
const UNKNOWN_PACKAGE: DecoderPackageRouteSummary = { codecs: [ 'uncompressed' ], kind: 'video', outputFormats: [ 'RGBA' ] };
// WebGPU's default largest storage binding, and a device that holds 2 GiB
const DEFAULT_STORAGE_BINDING_BYTE_LIMIT = 128 * 1024 * 1024;
const LARGE_BUFFER_BYTE_LIMIT = 2 ** 31;
// The HEVC package as the catalog describes it with its header, on a device of each limit
const HEVC_HEADER_PACKAGE: DecoderPackageRouteSummary = { ...HEVC_PACKAGE, header: HEVC_HEADER };
const SMALL_DEVICE_HEVC_PACKAGE: DecoderPackageRouteSummary = { ...HEVC_HEADER_PACKAGE, maximumBufferByteLength: DEFAULT_STORAGE_BINDING_BYTE_LIMIT };
const LARGE_DEVICE_HEVC_PACKAGE: DecoderPackageRouteSummary = { ...HEVC_HEADER_PACKAGE, maximumBufferByteLength: LARGE_BUFFER_BYTE_LIMIT };
const SIZES = {
    dci4K: { Height: 2_160, Width: 4_096 },
    fullHD: { Height: 1_080, Width: 1_920 },
    hd: { Height: 720, Width: 1_280 },
    portraitFullHD: { Height: 1_920, Width: 1_080 },
    ultraHD: { Height: 2_160, Width: 3_840 },
    ultraHD8K: { Height: 4_320, Width: 7_680 },
    wideUltraHD: { Height: 1_600, Width: 3_840 }
} as const;

const MATROSKA_CONTAINER = 'mkv';
const MPEG4_CONTAINER = 'mp4';
const TRANSPORT_STREAM_CONTAINER = 'ts';
// The value a stock profile split takes for every container the engine does not play
const NON_CUSTOM_VIDEO_CONTAINERS = `-${CUSTOM_PROFILE_VIDEO_CONTAINERS.join(',')}`;
const STOCK_H264_MAXIMUM_LEVEL = '52';
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
        h264Profiles: createH264ProfileCapabilities(true),
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

/** Returns the stock profile with Jellyfin Web's H.264 limits in a browser: a level ceiling, and no interlaced streams, which the browser shows woven. */
function createStockProfileWithH264ScanLimit(): DeviceProfile {
    const profile = createStockProfile();
    profile.CodecProfiles = [
        ...(profile.CodecProfiles ?? []),
        {
            Codec: 'h264',
            Conditions: [
                { Condition: 'LessThanEqual', IsRequired: false, Property: 'VideoLevel', Value: STOCK_H264_MAXIMUM_LEVEL },
                { Condition: 'NotEquals', IsRequired: false, Property: 'IsInterlaced', Value: 'true' }
            ],
            Type: 'Video'
        }
    ];
    return profile;
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
    it('advertises a codec only a package decodes, in each container that carries it, as SDR at its depths and either scan', () => {
        const mpeg2Stream = createVideoStream('mpeg2video', 'Main', EIGHT_BIT_DEPTH);

        const withoutPackage = augment([]);
        const withPackage = augment([ MPEG2_PACKAGE ]);

        expect(isDirectPlayAdvertised(withoutPackage, MATROSKA_CONTAINER, mpeg2Stream)).toBe(false);
        expect(isDirectPlayAdvertised(withPackage, MATROSKA_CONTAINER, mpeg2Stream)).toBe(true);
        expect(isDirectPlayAdvertised(withPackage, TRANSPORT_STREAM_CONTAINER, mpeg2Stream)).toBe(true);
        expect(isDirectPlayAdvertised(withPackage, MATROSKA_CONTAINER, { ...mpeg2Stream, IsInterlaced: true })).toBe(true);
        expect(isDirectPlayAdvertised(withPackage, TRANSPORT_STREAM_CONTAINER, { ...mpeg2Stream, IsInterlaced: true })).toBe(true);
        expect(isDirectPlayAdvertised(withPackage, MATROSKA_CONTAINER, { ...mpeg2Stream, BitDepth: TEN_BIT_DEPTH })).toBe(false);
    });

    it('advertises interlaced HEVC from no package, since HEVC codes its fields apart', () => {
        const mainStream = createVideoStream('hevc', 'Main 10', TEN_BIT_DEPTH);

        const withPackage = augment([ HEVC_PACKAGE ]);

        expect(isDirectPlayAdvertised(withPackage, MATROSKA_CONTAINER, mainStream)).toBe(true);
        expect(isDirectPlayAdvertised(withPackage, MATROSKA_CONTAINER, { ...mainStream, IsInterlaced: true })).toBe(false);
    });

    it('lifts the browser\'s scan limit on H.264 in the containers the engine plays, which deinterlaces it', () => {
        const interlacedStream = createVideoStream('h264', 'High', EIGHT_BIT_DEPTH, { IsInterlaced: true });
        const stockProfile = createStockProfileWithH264ScanLimit();

        const augmented = augmentDeviceProfileForCustomDecode(stockProfile, createCapabilities(), { decoderPackages: [] }).profile;

        expect(isDirectPlayAdvertised(stockProfile, MPEG4_CONTAINER, interlacedStream)).toBe(false);
        expect(isDirectPlayAdvertised(augmented, MPEG4_CONTAINER, interlacedStream)).toBe(true);
        expect(isDirectPlayAdvertised(augmented, MATROSKA_CONTAINER, interlacedStream)).toBe(true);
        expect(augmented.CodecProfiles).toContainEqual({ ...stockProfile.CodecProfiles?.[1], Container: NON_CUSTOM_VIDEO_CONTAINERS });
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

    it('refuses 1080p Main 10 on a device whose largest storage binding is WebGPU\'s default 128 MiB, which its 29-slot pool outgrows, and takes 720p', () => {
        const main10Stream = createVideoStream('hevc', 'Main 10', TEN_BIT_DEPTH);

        const smallDevice = augment([ SMALL_DEVICE_HEVC_PACKAGE ]);

        expect(isDirectPlayAdvertised(smallDevice, MATROSKA_CONTAINER, { ...main10Stream, ...SIZES.fullHD })).toBe(false);
        expect(isDirectPlayAdvertised(smallDevice, MATROSKA_CONTAINER, { ...main10Stream, ...SIZES.hd })).toBe(true);
        // Without the device's limit, the header's accepts alone bound it
        expect(isDirectPlayAdvertised(augment([ HEVC_HEADER_PACKAGE ]), MATROSKA_CONTAINER, { ...main10Stream, ...SIZES.fullHD })).toBe(true);
    });

    it('takes on a 2 GiB device every size the HEVC header accepts, within its 8912896 coded samples', () => {
        const largeDevice = augment([ LARGE_DEVICE_HEVC_PACKAGE ]);
        const advertises = (profile: string, bitDepth: number, size: StreamRecord): boolean => (
            isDirectPlayAdvertised(largeDevice, MATROSKA_CONTAINER, createVideoStream('hevc', profile, bitDepth, size))
        );

        for (const size of [ SIZES.fullHD, SIZES.ultraHD, SIZES.dci4K, SIZES.wideUltraHD, SIZES.portraitFullHD ]) {
            expect(advertises('Main 10', TEN_BIT_DEPTH, size)).toBe(true);
            expect(advertises('Main 4:4:4 12', TWELVE_BIT_DEPTH, size)).toBe(true);
        }
        expect(advertises('Main 10', TEN_BIT_DEPTH, SIZES.ultraHD8K)).toBe(false);
        expect(advertises('Main 10', TEN_BIT_DEPTH, { Height: 1_088, Width: 8_192 })).toBe(true);
        expect(advertises('Main 10', TEN_BIT_DEPTH, { Height: 1_088, Width: 8_193 })).toBe(false);
    });

    it('leaves the size of a stream a native route takes to the browser\'s decoder', () => {
        const withNativeHEVC = augment([ SMALL_DEVICE_HEVC_PACKAGE ], [ 'hevc' ]);

        expect(isDirectPlayAdvertised(withNativeHEVC, MATROSKA_CONTAINER, createVideoStream('hevc', 'Main', EIGHT_BIT_DEPTH, SIZES.ultraHD8K))).toBe(true);
        expect(isDirectPlayAdvertised(withNativeHEVC, MATROSKA_CONTAINER, createVideoStream('hevc', 'Main 10', TEN_BIT_DEPTH, SIZES.fullHD))).toBe(false);
    });

    it('advertises generic Rext, whose label 4:0:0 streams carry, only from a package that declares monochrome', () => {
        const rextStream = createVideoStream('hevc', 'Rext', TEN_BIT_DEPTH);
        const named422Stream = createVideoStream('hevc', 'Main 4:2:2 10', TEN_BIT_DEPTH);
        // Jellyfin Web's HEVC ceiling, which the routes widen to the profiles they take
        const stockProfile = createStockProfile();
        stockProfile.CodecProfiles = [
            ...(stockProfile.CodecProfiles ?? []),
            { Codec: 'hevc', Conditions: [ { Condition: 'EqualsAny', IsRequired: false, Property: 'VideoProfile', Value: 'main' } ], Type: 'Video' }
        ];
        const augmentStock = (decoderPackage: DecoderPackageRouteSummary): DeviceProfile => (
            augmentDeviceProfileForCustomDecode(stockProfile, createCapabilities(), { decoderPackages: [ decoderPackage ] }).profile
        );
        const withoutMonochrome = augmentStock({ ...LARGE_DEVICE_HEVC_PACKAGE, header: { ...HEVC_HEADER, monochrome: false } });

        expect(isDirectPlayAdvertised(augmentStock(LARGE_DEVICE_HEVC_PACKAGE), MATROSKA_CONTAINER, rextStream)).toBe(true);
        expect(isDirectPlayAdvertised(withoutMonochrome, MATROSKA_CONTAINER, rextStream)).toBe(false);
        expect(isDirectPlayAdvertised(withoutMonochrome, MATROSKA_CONTAINER, named422Stream)).toBe(true);
    });

    it('advertises a profile and depth only where the packages write every chroma format its streams may carry', () => {
        // AV1 High is 4:4:4, and Professional at 12 bits any chroma format
        const partialAV1Package: DecoderPackageRouteSummary = { codecs: [ 'av1' ], kind: 'video', outputFormats: [ 'I420', 'I444', 'I420P12' ] };

        const profile = augment([ partialAV1Package ], [ 'av1' ]);

        expect(isDirectPlayAdvertised(profile, MATROSKA_CONTAINER, createVideoStream('av1', 'High', EIGHT_BIT_DEPTH))).toBe(true);
        expect(isDirectPlayAdvertised(profile, MATROSKA_CONTAINER, createVideoStream('av1', 'Professional', TWELVE_BIT_DEPTH))).toBe(false);
    });

    it('bounds a codec only packages decode at each depth by its largest chroma format', () => {
        const mpeg2Package: DecoderPackageRouteSummary = { ...MPEG2_PACKAGE, header: MPEG2_HEADER, maximumBufferByteLength: DEFAULT_STORAGE_BINDING_BYTE_LIMIT };
        const mpeg2Stream = createVideoStream('mpeg2video', 'Main', EIGHT_BIT_DEPTH);

        const profile = augment([ mpeg2Package ]);

        // A 4:4:4 pool of ten 1080p slots fits 128 MiB, and of ten 2160p slots does not
        expect(isDirectPlayAdvertised(profile, MATROSKA_CONTAINER, { ...mpeg2Stream, ...SIZES.fullHD })).toBe(true);
        expect(isDirectPlayAdvertised(profile, MATROSKA_CONTAINER, { ...mpeg2Stream, ...SIZES.ultraHD })).toBe(false);
    });
});

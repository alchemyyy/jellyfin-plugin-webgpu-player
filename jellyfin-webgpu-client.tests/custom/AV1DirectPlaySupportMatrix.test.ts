import type { CodecProfile } from '@jellyfin/sdk/lib/generated-client/models/codec-profile';
import type { DeviceProfile } from '@jellyfin/sdk/lib/generated-client/models/device-profile';
import { describe, expect, it } from 'vitest';

import {
    AV1_RAW_FORMAT_PROBE_DEFINITIONS,
    AV1_RAW_FORMAT_VARIANTS,
    type AV1RawFormatCapability,
    type AV1RawFormatVariant
} from 'webgpu-player/capability/AV1RawFormatCapabilities';
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
import {
    augmentDeviceProfileForCustomDecode,
    type CustomDeviceProfileOptions,
    type DecoderPackageRouteSummary
} from 'addons/webGPUPlayer/custom/CustomDeviceProfile';
import {
    getCustomPlaybackEligibility,
    hasEligibleCustomVideoRoute,
    type CustomPlaybackEligibility,
    type CustomPlaybackEligibilityOptions,
    type CustomPlaybackIneligibilityReason,
    type CustomVideoRouteOptions
} from 'webgpu-player/capability/CustomPlaybackEligibility';
import type { CustomPlaybackRuntimeAvailability } from 'webgpu-player/capability/CustomPlaybackRuntime';
import type {
    CustomDecodeRawVideoFrameFormat,
    CustomDecodeVideoDecoderBackend,
    CustomDecodeVideoOutputMode
} from 'webgpu-player/pipeline/DecodeWorkerProtocol';
import { isSameSessionNativePlaybackCompatible } from 'addons/webGPUPlayer/custom/NativeDirectPlayCompatibility';
import { getDolbyVisionPresentationDescriptor } from 'webgpu-player/presentation/PresentationInput';
import {
    RAW_HDR_AUTHORIZATION_ROUTE_KEYS,
    type RawHDRAuthorizationRouteKey
} from 'webgpu-player/validation/RawHDRPresentationAuthorization';
import { createAV1RawFormatCapability, createVerifiedCodecCapability } from './CustomDecodeCapabilityBuilders';

// The labels MediaBrowser.Model/Entities/MediaStream.cs gives Profile 10:
// 10.0 is DOVI, 10.1 DOVIWithHDR10 or DOVIWithHDR10Plus, 10.2 DOVIWithSDR, and 10.4 DOVIWithHLG.
// CCID 6, a reserved CCID, or a base contradicting its CCID is DOVIInvalid, and a stream without a CCID is labeled by transfer.
// Profile 10 never has an EL label
const PROFILE_10_VIDEO_RANGE_TYPES = [
    'DOVI',
    'DOVIWithHDR10',
    'DOVIWithHDR10Plus',
    'DOVIWithSDR',
    'DOVIWithHLG',
    'DOVIInvalid'
] as const;

type AV1VideoRangeType =
    | typeof PROFILE_10_VIDEO_RANGE_TYPES[number]
    | 'HDR10'
    | 'HDR10Plus'
    | 'HLG'
    | 'SDR';

/** Orders strings for order-insensitive list comparisons. */
function compareStrings(first: string, second: string): number {
    return first.localeCompare(second);
}

// The eligibility fields that select the decoder backend and WebGPU presentation pipeline
type ExpectedAV1Route = Readonly<{
    dolbyVisionProfile: 4 | 5 | 7 | 8 | null
    hdr: boolean
    nativeHDRTransfer: 'hlg' | 'pq' | null
    neutralizeHDRColorMetadata: boolean
    rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat | null
    videoDecoderBackend: CustomDecodeVideoDecoderBackend
    videoOutputMode: CustomDecodeVideoOutputMode
}>;

type AV1DirectPlayMatrixRow = Readonly<{
    deviceProfileAdvertised: boolean
    directPlaySupported: boolean
    expectedIneligibilityReason?: CustomPlaybackIneligibilityReason
    expectedRoute?: ExpectedAV1Route
    // Jellyfin labels the source outside every generic route, so only the item's own exact route advertises it
    itemRouteRequired?: boolean
    label: string
    runtimeEligible: boolean
    videoStream: Readonly<Record<string, unknown>>
}>;

// A null route means the configuration offers no DirectPlay route for the variant
type AV1RouteFallbackRow = Readonly<{
    // With the Dolby Vision RPU authorization withheld, so only a declared base layer can present
    declaredBaseRoute: ExpectedAV1Route | null
    label: string
    // Without a qualified raw AV1 decode, so only the native 8-bit route remains
    nativeDecodeRoute: ExpectedAV1Route | null
    videoStream: Readonly<Record<string, unknown>>
}>;

const NATIVE_SDR_VIDEO_FRAME_ROUTE: ExpectedAV1Route = {
    dolbyVisionProfile: null,
    hdr: false,
    nativeHDRTransfer: null,
    neutralizeHDRColorMetadata: false,
    rawVideoFrameFormat: null,
    videoDecoderBackend: 'native',
    videoOutputMode: 'video-frame'
};

const RAW_SDR_ROUTE: ExpectedAV1Route = {
    dolbyVisionProfile: null,
    hdr: false,
    nativeHDRTransfer: null,
    neutralizeHDRColorMetadata: false,
    rawVideoFrameFormat: 'I420P10',
    videoDecoderBackend: 'native',
    videoOutputMode: 'raw-planes'
};

// Raw PQ and HLG share one route shape; the transfer comes from the stream's color metadata
const RAW_HDR_ROUTE: ExpectedAV1Route = {
    ...RAW_SDR_ROUTE,
    hdr: true
};

/** Returns the raw route of a format, such as I444 for 8-bit High; the transfer comes from the stream's color metadata. */
function createRawRoute(rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat, hdr: boolean): ExpectedAV1Route {
    return {
        ...RAW_SDR_ROUTE,
        hdr,
        rawVideoFrameFormat
    };
}

function createRawDolbyVisionRoute(
    dolbyVisionProfile: 5 | 8,
    rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat = 'I420P10'
): ExpectedAV1Route {
    return {
        ...createRawRoute(rawVideoFrameFormat, true),
        dolbyVisionProfile
    };
}

function getEligibleRoute(eligibility: CustomPlaybackEligibility): ExpectedAV1Route | null {
    if (!eligibility.eligible) {
        return null;
    }
    return {
        dolbyVisionProfile: eligibility.dolbyVisionProfile,
        hdr: eligibility.hdr,
        nativeHDRTransfer: eligibility.nativeHDRTransfer ?? null,
        neutralizeHDRColorMetadata: eligibility.neutralizeHDRColorMetadata,
        rawVideoFrameFormat: eligibility.rawVideoFrameFormat,
        videoDecoderBackend: eligibility.videoDecoderBackend,
        videoOutputMode: eligibility.videoOutputMode
    };
}

const AVAILABLE_RUNTIME: CustomPlaybackRuntimeAvailability = {
    available: true,
    environment: {
        animationFrame: true,
        audioContext: true,
        audioData: true,
        audioDecoder: true,
        audioWorklet: true,
        secureContext: true,
        videoDecoder: true,
        videoFrame: true,
        webGPU: true,
        worker: true
    },
    reason: null
};

const RAW_ROUTE_KEYS: readonly RawHDRAuthorizationRouteKey[] = RAW_HDR_AUTHORIZATION_ROUTE_KEYS;

// Native external HDR and native Dolby Vision are HEVC routes, so AV1 depends only on raw authorizations
const FULL_ROUTE_OPTIONS: CustomDeviceProfileOptions = {
    allowDolbyVision: true,
    allowRawHDR: true,
    allowRawSDR: true,
    authorizedRawHDRRouteKeys: RAW_ROUTE_KEYS
};

const FULL_ELIGIBILITY_OPTIONS: CustomPlaybackEligibilityOptions = {
    allowDolbyVision: true,
    allowRawHDR: true,
    allowRawSDR: true,
    authorizedRawHDRRouteKeys: RAW_ROUTE_KEYS,
    runtimeAvailability: AVAILABLE_RUNTIME
};

const DECLARED_BASE_ROUTE_OPTIONS: CustomDeviceProfileOptions = {
    ...FULL_ROUTE_OPTIONS,
    allowDolbyVision: false
};

const DECLARED_BASE_ELIGIBILITY_OPTIONS: CustomPlaybackEligibilityOptions = {
    ...FULL_ELIGIBILITY_OPTIONS,
    allowDolbyVision: false
};

function createRawHDRCapability(codec: CustomRawHDRVideoCodec, supported: boolean): CustomRawHDRVideoCodecCapability {
    return {
        bitDepth: 10,
        codec,
        codecString: codec,
        format: 'I420P10',
        reason: supported ? 'output-copy-supported' : 'output-copy-unsupported',
        status: supported ? 'supported' : 'unsupported'
    };
}

/** Qualifies native 8-bit AV1 decode, and when requested raw AV1 Main 10 planes and the raw formats Chrome's software decoder copies: every 8 and 10-bit variant, and no 12-bit one. */
function createAV1Capabilities(rawAV1Supported: boolean): CustomDecodeCapabilities {
    const audio = {} as Record<CustomAudioCodec, CustomDecodeCodecCapability<CustomAudioCodec>>;
    for (const codec of CUSTOM_AUDIO_CODECS) {
        audio[codec] = createVerifiedCodecCapability(codec, codec === 'aac');
    }

    const video = {} as Record<CustomVideoCodec, CustomDecodeCodecCapability<CustomVideoCodec>>;
    for (const codec of CUSTOM_VIDEO_CODECS) {
        video[codec] = createVerifiedCodecCapability(codec, codec === 'av1');
    }

    const rawHDRVideo = {} as Record<CustomRawHDRVideoCodec, CustomRawHDRVideoCodecCapability>;
    for (const codec of CUSTOM_RAW_HDR_VIDEO_CODECS) {
        rawHDRVideo[codec] = createRawHDRCapability(codec, rawAV1Supported && codec === 'av1');
    }
    const av1RawFormats = {} as Record<AV1RawFormatVariant, AV1RawFormatCapability>;
    for (const variant of AV1_RAW_FORMAT_VARIANTS) {
        av1RawFormats[variant] = createAV1RawFormatCapability(variant, rawAV1Supported && AV1_RAW_FORMAT_PROBE_DEFINITIONS[variant].bitDepth < 12);
    }

    return {
        audio,
        av1RawFormats,
        rawHDRVideo,
        telemetry: {
            audioProbeCount: CUSTOM_AUDIO_CODECS.length,
            mediabunnyAudioCodecCount: 0,
            nativeSurroundAudioProbeCount: 0,
            nativeHDRVideoProbeCount: 0,
            nativeUltraHDVideoProbeCount: 0,
            rawHDRVideoProbeCount: CUSTOM_RAW_HDR_VIDEO_CODECS.length,
            reason: 'complete',
            supportedAudioCodecCount: 1,
            supportedNativeSurroundAudioCodecCount: 0,
            supportedNativeHDRVideoCodecCount: 0,
            supportedNativeUltraHDVideoCodecCount: 0,
            supportedRawHDRVideoCodecCount: rawAV1Supported ? 1 : 0,
            supportedVideoCodecCount: 1,
            unknownAudioCodecCount: 0,
            unknownNativeSurroundAudioCodecCount: 0,
            unknownNativeHDRVideoCodecCount: 0,
            unknownNativeUltraHDVideoCodecCount: 0,
            unknownVideoCodecCount: 0,
            videoProbeCount: CUSTOM_VIDEO_CODECS.length
        },
        video
    };
}

function createSDRAV1Stream(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
    return {
        BitDepth: 8,
        Codec: 'av1',
        ColorPrimaries: 'bt709',
        ColorRange: 'tv',
        ColorSpace: 'bt709',
        ColorTransfer: 'bt709',
        Height: 1_080,
        Index: 0,
        IsInterlaced: false,
        Level: 8,
        Profile: 'Main',
        Type: 'Video',
        VideoRange: 'SDR',
        VideoRangeType: 'SDR',
        Width: 1_920,
        ...overrides
    };
}

function createTenBitSDRAV1Stream(
    videoRangeType: AV1VideoRangeType,
    overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
    return createSDRAV1Stream({
        BitDepth: 10,
        Height: 2_160,
        Level: 12,
        VideoRangeType: videoRangeType,
        Width: 3_840,
        ...overrides
    });
}

function createHDRAV1Stream(
    videoRangeType: AV1VideoRangeType,
    transfer: 'hlg' | 'pq',
    overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
    return createTenBitSDRAV1Stream(videoRangeType, {
        ColorPrimaries: 'bt2020',
        ColorSpace: 'bt2020nc',
        ColorTransfer: transfer === 'pq' ? 'smpte2084' : 'arib-std-b67',
        VideoRange: 'HDR',
        ...overrides
    });
}

// The color of a static HDR10 stream, which Jellyfin labels HDR10
const HDR10_COLOR = {
    ColorPrimaries: 'bt2020',
    ColorSpace: 'bt2020nc',
    ColorTransfer: 'smpte2084',
    VideoRange: 'HDR',
    VideoRangeType: 'HDR10'
} as const;

/** Creates an SDR AV1 stream of a raw format variant, which Jellyfin names by profile, depth, and pixel format. */
function createRawFormatAV1Stream(
    profile: 'High' | 'Professional',
    bitDepth: 8 | 10 | 12,
    pixelFormat: string,
    overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
    return createSDRAV1Stream({
        BitDepth: bitDepth,
        PixelFormat: pixelFormat,
        Profile: profile,
        ...overrides
    });
}

/** Creates a Profile 10 stream over a base with the given color; a null CCID omits the field, as Matroska can. */
function createProfile10Stream(
    compatibilityID: number | null,
    videoRangeType: AV1VideoRangeType,
    baseTransfer: 'hlg' | 'pq' | 'sdr',
    overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
    const dolbyVisionConfiguration = {
        BlPresentFlag: true,
        DvProfile: 10,
        ElPresentFlag: false,
        RpuPresentFlag: true,
        ...(compatibilityID === null ? {} : { DvBlSignalCompatibilityId: compatibilityID }),
        ...overrides
    };
    return baseTransfer === 'sdr' ?
        createTenBitSDRAV1Stream(videoRangeType, dolbyVisionConfiguration) :
        createHDRAV1Stream(videoRangeType, baseTransfer, dolbyVisionConfiguration);
}

// The server reports every MP4/MOV file with this probe string and matches profile containers by any token
const MP4_PROBE_CONTAINER = 'mov,mp4,m4a,3gp,3g2,mj2';

// The stream URL the play request carries, and the media source the engine reads it as
const STREAM_URL = '/Videos/item/stream.mkv';
const STREAM_SOURCE = { kind: 'url', url: STREAM_URL } as const;

function createPlaybackOptions(
    videoStream: Readonly<Record<string, unknown>>,
    container = 'mkv'
): Readonly<Record<string, unknown>> {
    return {
        mediaSource: {
            Container: container,
            DefaultAudioStreamIndex: 1,
            MediaStreams: [
                videoStream,
                {
                    Channels: 2,
                    Codec: 'aac',
                    Index: 1,
                    SampleRate: 48_000,
                    Type: 'Audio'
                }
            ],
            RunTimeTicks: 60_000_000,
            SupportsDirectPlay: true
        },
        playMethod: 'DirectPlay',
        playerStartPositionTicks: 0,
        source: STREAM_SOURCE,
        url: STREAM_URL
    };
}

const AV1_VIDEO_RANGE_MATRIX: readonly AV1DirectPlayMatrixRow[] = [
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        expectedRoute: NATIVE_SDR_VIDEO_FRAME_ROUTE,
        label: 'SDR Main 8-bit',
        runtimeEligible: true,
        videoStream: createSDRAV1Stream()
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        // Native AV1 decode is qualified at 8 bits only, so 10-bit SDR takes raw planes
        expectedRoute: RAW_SDR_ROUTE,
        label: 'SDR Main 10-bit',
        runtimeEligible: true,
        videoStream: createTenBitSDRAV1Stream('SDR')
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        expectedRoute: RAW_SDR_ROUTE,
        label: 'SDR Main 10-bit in full range',
        runtimeEligible: true,
        videoStream: createTenBitSDRAV1Stream('SDR', { ColorRange: 'pc' })
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        // A profile condition cannot express primaries, and the stream's own raw SDR key presents BT.601, converted to BT.709
        expectedRoute: RAW_SDR_ROUTE,
        label: 'BT.601 SDR Main 10-bit',
        runtimeEligible: true,
        videoStream: createTenBitSDRAV1Stream('SDR', {
            ColorPrimaries: 'smpte170m',
            ColorSpace: 'smpte170m',
            ColorTransfer: 'smpte170m'
        })
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        expectedRoute: RAW_HDR_ROUTE,
        label: 'HDR10 Main 10-bit',
        runtimeEligible: true,
        videoStream: createHDRAV1Stream('HDR10', 'pq')
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        expectedRoute: RAW_HDR_ROUTE,
        label: 'HLG Main 10-bit',
        runtimeEligible: true,
        videoStream: createHDRAV1Stream('HLG', 'hlg')
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        // Raw PQ presents the static HDR10 base that HDR10+ always carries
        expectedRoute: RAW_HDR_ROUTE,
        label: 'HDR10Plus Main 10-bit',
        runtimeEligible: true,
        videoStream: createHDRAV1Stream('HDR10Plus', 'pq', { Hdr10PlusPresentFlag: true })
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        // 10.0 has no compatible base, so it reconstructs like Profile 5
        expectedRoute: createRawDolbyVisionRoute(5),
        label: 'Dolby Vision 10.0, labeled DOVI',
        runtimeEligible: true,
        videoStream: createProfile10Stream(0, 'DOVI', 'pq')
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        expectedRoute: createRawDolbyVisionRoute(8),
        label: 'Dolby Vision 10.1, labeled DOVIWithHDR10',
        runtimeEligible: true,
        videoStream: createProfile10Stream(1, 'DOVIWithHDR10', 'pq')
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        expectedRoute: createRawDolbyVisionRoute(8),
        label: 'Dolby Vision 10.1 plus HDR10+ metadata, labeled DOVIWithHDR10Plus',
        runtimeEligible: true,
        videoStream: createProfile10Stream(1, 'DOVIWithHDR10Plus', 'pq', { Hdr10PlusPresentFlag: true })
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        expectedRoute: createRawDolbyVisionRoute(8),
        label: 'Dolby Vision 10.2, labeled DOVIWithSDR',
        runtimeEligible: true,
        videoStream: createProfile10Stream(2, 'DOVIWithSDR', 'sdr')
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        expectedRoute: createRawDolbyVisionRoute(8),
        label: 'Dolby Vision 10.4, labeled DOVIWithHLG',
        runtimeEligible: true,
        videoStream: createProfile10Stream(4, 'DOVIWithHLG', 'hlg')
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        // RPU reconstruction ignores the compatibility ID
        expectedRoute: createRawDolbyVisionRoute(8),
        label: 'Dolby Vision Profile 10 with reserved compatibility ID 3, labeled DOVIInvalid',
        runtimeEligible: true,
        videoStream: createProfile10Stream(3, 'DOVIInvalid', 'pq')
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        expectedRoute: createRawDolbyVisionRoute(8),
        label: 'Dolby Vision Profile 10 with compatibility ID 6, labeled DOVIInvalid',
        runtimeEligible: true,
        videoStream: createProfile10Stream(6, 'DOVIInvalid', 'pq')
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        expectedRoute: createRawDolbyVisionRoute(8),
        label: 'Dolby Vision 10.1 over an HLG base contradicting its compatibility ID, labeled DOVIInvalid',
        runtimeEligible: true,
        videoStream: createProfile10Stream(1, 'DOVIInvalid', 'hlg')
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        // Without a compatibility ID nothing declares a base, so the stream reconstructs like Profile 5
        expectedRoute: createRawDolbyVisionRoute(5),
        label: 'Dolby Vision Profile 10 without a compatibility ID, labeled HDR10 by transfer',
        runtimeEligible: true,
        videoStream: createProfile10Stream(null, 'HDR10', 'pq')
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        expectedRoute: createRawDolbyVisionRoute(5),
        label: 'Dolby Vision Profile 10 without a compatibility ID, labeled HLG by transfer',
        runtimeEligible: true,
        videoStream: createProfile10Stream(null, 'HLG', 'hlg')
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        expectedRoute: createRawDolbyVisionRoute(5),
        label: 'Dolby Vision Profile 10 without a compatibility ID, labeled SDR by transfer',
        runtimeEligible: true,
        videoStream: createProfile10Stream(null, 'SDR', 'sdr')
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        // The 8-bit Main raw format qualifies, so the RPU reconstructs from I420 planes
        expectedRoute: createRawDolbyVisionRoute(8, 'I420'),
        label: 'Dolby Vision 10.2 over an 8-bit base, labeled DOVIWithSDR',
        runtimeEligible: true,
        videoStream: createProfile10Stream(2, 'DOVIWithSDR', 'sdr', { BitDepth: 8, PixelFormat: 'yuv420p' })
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        // Without a pixel format no raw format variant names the base, so the declared SDR base presents through native 8-bit decode
        expectedRoute: NATIVE_SDR_VIDEO_FRAME_ROUTE,
        label: 'Dolby Vision 10.2 over an 8-bit base without a pixel format, labeled DOVIWithSDR',
        runtimeEligible: true,
        videoStream: createProfile10Stream(2, 'DOVIWithSDR', 'sdr', { BitDepth: 8 })
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        expectedRoute: createRawDolbyVisionRoute(8, 'I444P10'),
        label: 'Dolby Vision 10.1 over a High 4:4:4 10-bit base, labeled DOVIWithHDR10',
        runtimeEligible: true,
        videoStream: createProfile10Stream(1, 'DOVIWithHDR10', 'pq', { PixelFormat: 'yuv444p10le', Profile: 'High' })
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        expectedRoute: createRawRoute('I444', false),
        label: 'SDR High 4:4:4 8-bit',
        runtimeEligible: true,
        videoStream: createRawFormatAV1Stream('High', 8, 'yuv444p')
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        expectedRoute: createRawRoute('I444P10', false),
        label: 'SDR High 4:4:4 10-bit',
        runtimeEligible: true,
        videoStream: createRawFormatAV1Stream('High', 10, 'yuv444p10le')
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        expectedRoute: createRawRoute('I444P10', true),
        label: 'HDR10 High 4:4:4 10-bit',
        runtimeEligible: true,
        videoStream: createRawFormatAV1Stream('High', 10, 'yuv444p10le', HDR10_COLOR)
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        expectedRoute: createRawRoute('I422', false),
        label: 'SDR Professional 4:2:2 8-bit',
        runtimeEligible: true,
        videoStream: createRawFormatAV1Stream('Professional', 8, 'yuv422p')
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        expectedRoute: createRawRoute('I422P10', false),
        label: 'SDR Professional 4:2:2 10-bit',
        runtimeEligible: true,
        videoStream: createRawFormatAV1Stream('Professional', 10, 'yuv422p10le')
    },
    {
        // Chrome's software decoder refuses 12-bit AV1, so only a decoder package plays it
        deviceProfileAdvertised: false,
        directPlaySupported: false,
        expectedIneligibilityReason: 'codec-unsupported',
        label: 'SDR Professional 4:2:0 12-bit',
        runtimeEligible: false,
        videoStream: createRawFormatAV1Stream('Professional', 12, 'yuv420p12le')
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        // The deinterlacing pass presents interlaced video on every route but Dolby Vision's
        expectedRoute: NATIVE_SDR_VIDEO_FRAME_ROUTE,
        label: 'SDR Main 8-bit, interlaced',
        runtimeEligible: true,
        videoStream: createSDRAV1Stream({ IsInterlaced: true })
    },
    {
        deviceProfileAdvertised: false,
        directPlaySupported: false,
        expectedIneligibilityReason: 'interlaced-video-unsupported',
        label: 'Dolby Vision 10.1, labeled DOVIWithHDR10, interlaced',
        runtimeEligible: false,
        videoStream: createProfile10Stream(1, 'DOVIWithHDR10', 'pq', { IsInterlaced: true })
    }
];

const AV1_ROUTE_FALLBACK_MATRIX: readonly AV1RouteFallbackRow[] = [
    {
        declaredBaseRoute: NATIVE_SDR_VIDEO_FRAME_ROUTE,
        label: 'SDR Main 8-bit',
        nativeDecodeRoute: NATIVE_SDR_VIDEO_FRAME_ROUTE,
        videoStream: createSDRAV1Stream()
    },
    {
        declaredBaseRoute: RAW_SDR_ROUTE,
        label: 'SDR Main 10-bit',
        nativeDecodeRoute: null,
        videoStream: createTenBitSDRAV1Stream('SDR')
    },
    {
        declaredBaseRoute: RAW_HDR_ROUTE,
        label: 'HDR10 Main 10-bit',
        nativeDecodeRoute: null,
        videoStream: createHDRAV1Stream('HDR10', 'pq')
    },
    {
        declaredBaseRoute: RAW_HDR_ROUTE,
        label: 'HLG Main 10-bit',
        nativeDecodeRoute: null,
        videoStream: createHDRAV1Stream('HLG', 'hlg')
    },
    {
        declaredBaseRoute: RAW_HDR_ROUTE,
        label: 'HDR10Plus Main 10-bit',
        nativeDecodeRoute: null,
        videoStream: createHDRAV1Stream('HDR10Plus', 'pq', { Hdr10PlusPresentFlag: true })
    },
    {
        declaredBaseRoute: null,
        label: 'Dolby Vision 10.0, labeled DOVI',
        nativeDecodeRoute: null,
        videoStream: createProfile10Stream(0, 'DOVI', 'pq')
    },
    {
        declaredBaseRoute: RAW_HDR_ROUTE,
        label: 'Dolby Vision 10.1, labeled DOVIWithHDR10',
        nativeDecodeRoute: null,
        videoStream: createProfile10Stream(1, 'DOVIWithHDR10', 'pq')
    },
    {
        declaredBaseRoute: RAW_HDR_ROUTE,
        label: 'Dolby Vision 10.1 plus HDR10+ metadata, labeled DOVIWithHDR10Plus',
        nativeDecodeRoute: null,
        videoStream: createProfile10Stream(1, 'DOVIWithHDR10Plus', 'pq', { Hdr10PlusPresentFlag: true })
    },
    {
        declaredBaseRoute: RAW_SDR_ROUTE,
        label: 'Dolby Vision 10.2, labeled DOVIWithSDR',
        nativeDecodeRoute: null,
        videoStream: createProfile10Stream(2, 'DOVIWithSDR', 'sdr')
    },
    {
        declaredBaseRoute: RAW_HDR_ROUTE,
        label: 'Dolby Vision 10.4, labeled DOVIWithHLG',
        nativeDecodeRoute: null,
        videoStream: createProfile10Stream(4, 'DOVIWithHLG', 'hlg')
    },
    {
        declaredBaseRoute: null,
        label: 'Dolby Vision Profile 10 with reserved compatibility ID 3, labeled DOVIInvalid',
        nativeDecodeRoute: null,
        videoStream: createProfile10Stream(3, 'DOVIInvalid', 'pq')
    },
    {
        // Compatibility ID 6 declares the Ultra HD Blu-ray HDR10 base
        declaredBaseRoute: RAW_HDR_ROUTE,
        label: 'Dolby Vision Profile 10 with compatibility ID 6, labeled DOVIInvalid',
        nativeDecodeRoute: null,
        videoStream: createProfile10Stream(6, 'DOVIInvalid', 'pq')
    },
    {
        // The HLG transfer contradicts the PQ base compatibility ID 1 declares, so no base presents
        declaredBaseRoute: null,
        label: 'Dolby Vision 10.1 over an HLG base contradicting its compatibility ID, labeled DOVIInvalid',
        nativeDecodeRoute: null,
        videoStream: createProfile10Stream(1, 'DOVIInvalid', 'hlg')
    },
    {
        // Negotiated by its transfer label, then rejected at runtime: only the RPU presents it
        declaredBaseRoute: null,
        label: 'Dolby Vision Profile 10 without a compatibility ID, labeled HDR10 by transfer',
        nativeDecodeRoute: null,
        videoStream: createProfile10Stream(null, 'HDR10', 'pq')
    },
    {
        declaredBaseRoute: null,
        label: 'Dolby Vision Profile 10 without a compatibility ID, labeled HLG by transfer',
        nativeDecodeRoute: null,
        videoStream: createProfile10Stream(null, 'HLG', 'hlg')
    },
    {
        declaredBaseRoute: null,
        label: 'Dolby Vision Profile 10 without a compatibility ID, labeled SDR by transfer',
        nativeDecodeRoute: null,
        videoStream: createProfile10Stream(null, 'SDR', 'sdr')
    },
    {
        // Native 8-bit decode presents the declared SDR base without raw planes
        declaredBaseRoute: NATIVE_SDR_VIDEO_FRAME_ROUTE,
        label: 'Dolby Vision 10.2 over an 8-bit base, labeled DOVIWithSDR',
        nativeDecodeRoute: NATIVE_SDR_VIDEO_FRAME_ROUTE,
        videoStream: createProfile10Stream(2, 'DOVIWithSDR', 'sdr', { BitDepth: 8, PixelFormat: 'yuv420p' })
    },
    {
        declaredBaseRoute: createRawRoute('I444P10', true),
        label: 'Dolby Vision 10.1 over a High 4:4:4 10-bit base, labeled DOVIWithHDR10',
        nativeDecodeRoute: null,
        videoStream: createProfile10Stream(1, 'DOVIWithHDR10', 'pq', { PixelFormat: 'yuv444p10le', Profile: 'High' })
    },
    {
        declaredBaseRoute: createRawRoute('I444', false),
        label: 'SDR High 4:4:4 8-bit',
        nativeDecodeRoute: null,
        videoStream: createRawFormatAV1Stream('High', 8, 'yuv444p')
    },
    {
        declaredBaseRoute: createRawRoute('I444P10', true),
        label: 'HDR10 High 4:4:4 10-bit',
        nativeDecodeRoute: null,
        videoStream: createRawFormatAV1Stream('High', 10, 'yuv444p10le', HDR10_COLOR)
    },
    {
        declaredBaseRoute: createRawRoute('I422P10', false),
        label: 'SDR Professional 4:2:2 10-bit',
        nativeDecodeRoute: null,
        videoStream: createRawFormatAV1Stream('Professional', 10, 'yuv422p10le')
    }
];

// The AV1 package the engine's decoder project builds, as the server's catalog describes it
const AV1_PACKAGE: DecoderPackageRouteSummary = {
    codecs: [ 'av1' ],
    kind: 'video',
    outputFormats: [ 'I420', 'I420P10', 'I420P12', 'I422', 'I422P10', 'I422P12', 'I444', 'I444P10', 'I444P12' ]
};

const PACKAGE_ROUTE_OPTIONS: CustomDeviceProfileOptions = {
    ...FULL_ROUTE_OPTIONS,
    decoderPackages: [ AV1_PACKAGE ]
};

// Negotiation judges a package by its summary; a playback takes it only from an offer, which carries the package itself
const PACKAGE_VIDEO_ROUTE_OPTIONS: CustomVideoRouteOptions = {
    allowDolbyVision: true,
    allowRawHDR: true,
    allowRawSDR: true,
    authorizedRawHDRRouteKeys: RAW_ROUTE_KEYS,
    gpuVideoDecoderSummaries: [ AV1_PACKAGE ]
};

// A null raw route means only the package plays the variant
type AV1PackageRouteRow = Readonly<{
    label: string
    rawRoute: ExpectedAV1Route | null
    videoStream: Readonly<Record<string, unknown>>
}>;

// With an AV1 decoder package offered, a raw format that qualifies keeps its raw route, and 12-bit AV1, which Chrome's software decoder refuses, takes the package
const AV1_PACKAGE_ROUTE_MATRIX: readonly AV1PackageRouteRow[] = [
    {
        label: 'SDR Professional 4:2:0 12-bit',
        rawRoute: null,
        videoStream: createRawFormatAV1Stream('Professional', 12, 'yuv420p12le')
    },
    {
        label: 'SDR Professional 4:2:2 12-bit',
        rawRoute: null,
        videoStream: createRawFormatAV1Stream('Professional', 12, 'yuv422p12le')
    },
    {
        label: 'SDR High 4:4:4 8-bit',
        rawRoute: createRawRoute('I444', false),
        videoStream: createRawFormatAV1Stream('High', 8, 'yuv444p')
    },
    {
        label: 'SDR Professional 4:2:2 10-bit',
        rawRoute: createRawRoute('I422P10', false),
        videoStream: createRawFormatAV1Stream('Professional', 10, 'yuv422p10le')
    }
];

/** Returns Jellyfin Web's stock AV1 codec profile, whose ranges follow the display: HDR10, HDR10+, and HLG on HDR. */
function createStockAV1CodecProfile(videoRangeTypes: string): CodecProfile {
    return {
        Codec: 'av1',
        Conditions: [
            {
                Condition: 'EqualsAny',
                IsRequired: false,
                Property: 'VideoProfile',
                Value: 'main'
            },
            {
                Condition: 'EqualsAny',
                IsRequired: false,
                Property: 'VideoRangeType',
                Value: videoRangeTypes
            },
            {
                Condition: 'LessThanEqual',
                IsRequired: false,
                Property: 'VideoLevel',
                Value: '19'
            }
        ],
        Type: 'Video'
    };
}

const HDR_DISPLAY_STOCK_VIDEO_RANGE_TYPES = 'SDR|HDR10|HDR10Plus|HLG';
const SDR_DISPLAY_STOCK_VIDEO_RANGE_TYPES = 'SDR';

function createMatrixProfile(
    capabilities: CustomDecodeCapabilities,
    options: CustomDeviceProfileOptions,
    stockVideoRangeTypes = HDR_DISPLAY_STOCK_VIDEO_RANGE_TYPES
): DeviceProfile {
    return augmentDeviceProfileForCustomDecode(
        { CodecProfiles: [ createStockAV1CodecProfile(stockVideoRangeTypes) ] },
        capabilities,
        options
    ).profile;
}

const fullyQualifiedCapabilities = createAV1Capabilities(true);
const nativeDecodeCapabilities = createAV1Capabilities(false);
const fullyQualifiedProfile: DeviceProfile = createMatrixProfile(fullyQualifiedCapabilities, FULL_ROUTE_OPTIONS);
const declaredBaseProfile: DeviceProfile = createMatrixProfile(fullyQualifiedCapabilities, DECLARED_BASE_ROUTE_OPTIONS);
const nativeDecodeProfile: DeviceProfile = createMatrixProfile(nativeDecodeCapabilities, FULL_ROUTE_OPTIONS);
const packageProfile: DeviceProfile = createMatrixProfile(fullyQualifiedCapabilities, PACKAGE_ROUTE_OPTIONS);

/** Mirrors the host, which also advertises a Dolby Vision item's own exact route when the item has one. */
function getItemProfile(
    playbackOptions: Readonly<Record<string, unknown>>,
    genericProfile: DeviceProfile,
    capabilities: CustomDecodeCapabilities,
    profileOptions: CustomDeviceProfileOptions,
    stockVideoRangeTypes = HDR_DISPLAY_STOCK_VIDEO_RANGE_TYPES
): DeviceProfile {
    if (getDolbyVisionPresentationDescriptor(playbackOptions) === null) {
        return genericProfile;
    }
    const mediaStreams = (playbackOptions.mediaSource as { MediaStreams: unknown }).MediaStreams;
    return createMatrixProfile(
        capabilities,
        {
            ...profileOptions,
            itemMediaSource: { MediaStreams: mediaStreams }
        },
        stockVideoRangeTypes
    );
}

/** Asserts negotiation, runtime ownership, their conjunction, and the selected route. */
function expectFullyQualifiedMatrixRow(row: AV1DirectPlayMatrixRow): void {
    const playbackOptions = createPlaybackOptions(row.videoStream);
    const deviceProfileAdvertised = isSameSessionNativePlaybackCompatible(
        playbackOptions,
        getItemProfile(playbackOptions, fullyQualifiedProfile, fullyQualifiedCapabilities, FULL_ROUTE_OPTIONS)
    );
    const eligibility = getCustomPlaybackEligibility(playbackOptions, fullyQualifiedCapabilities, FULL_ELIGIBILITY_OPTIONS);

    expect(deviceProfileAdvertised).toBe(row.deviceProfileAdvertised);
    expect(eligibility.eligible).toBe(row.runtimeEligible);
    expect(deviceProfileAdvertised && eligibility.eligible).toBe(row.directPlaySupported);
    expect(getEligibleRoute(eligibility)).toEqual(row.expectedRoute ?? null);
    if (!eligibility.eligible && row.expectedIneligibilityReason) {
        expect(eligibility.reason).toBe(row.expectedIneligibilityReason);
    }
    if (row.itemRouteRequired === true) {
        expect(isSameSessionNativePlaybackCompatible(playbackOptions, fullyQualifiedProfile)).toBe(false);
    }
}

/** Returns whether the fully qualified profile advertises a row's stream under a stock profile and container. */
function isAdvertised(
    row: AV1DirectPlayMatrixRow,
    container: string,
    stockVideoRangeTypes: string
): boolean {
    const playbackOptions = createPlaybackOptions(row.videoStream, container);
    return isSameSessionNativePlaybackCompatible(
        playbackOptions,
        getItemProfile(
            playbackOptions,
            createMatrixProfile(fullyQualifiedCapabilities, FULL_ROUTE_OPTIONS, stockVideoRangeTypes),
            fullyQualifiedCapabilities,
            FULL_ROUTE_OPTIONS,
            stockVideoRangeTypes
        )
    );
}

/** Asserts the route a variant takes under a fallback configuration; a null route means the configuration offers no DirectPlay route for it. */
function expectFallbackRoute(
    videoStream: Readonly<Record<string, unknown>>,
    genericProfile: DeviceProfile,
    profileOptions: CustomDeviceProfileOptions,
    capabilities: CustomDecodeCapabilities,
    eligibilityOptions: CustomPlaybackEligibilityOptions,
    expectedRoute: ExpectedAV1Route | null
): void {
    const playbackOptions = createPlaybackOptions(videoStream);
    const deviceProfileAdvertised = isSameSessionNativePlaybackCompatible(
        playbackOptions,
        getItemProfile(playbackOptions, genericProfile, capabilities, profileOptions)
    );
    const eligibility = getCustomPlaybackEligibility(playbackOptions, capabilities, eligibilityOptions);

    expect(deviceProfileAdvertised && eligibility.eligible).toBe(expectedRoute !== null);
    if (expectedRoute !== null) {
        expect(getEligibleRoute(eligibility)).toEqual(expectedRoute);
    }
}

describe('AV1 DirectPlay support matrix', () => {
    it('contains a direct-play-positive row for every Profile 10 range label', () => {
        const supportedDolbyVisionRanges = new Set<string>();
        for (const row of AV1_VIDEO_RANGE_MATRIX) {
            const videoRangeType = row.videoStream.VideoRangeType;
            if (
                row.directPlaySupported
                && typeof videoRangeType === 'string'
                && (PROFILE_10_VIDEO_RANGE_TYPES as readonly string[]).includes(videoRangeType)
            ) {
                supportedDolbyVisionRanges.add(videoRangeType);
            }
        }

        expect([ ...supportedDolbyVisionRanges ].sort(compareStrings)).toEqual(
            [ ...PROFILE_10_VIDEO_RANGE_TYPES ].sort(compareStrings)
        );
    });

    it.each(AV1_VIDEO_RANGE_MATRIX)(
        '$label: distinguishes profile advertisement from runtime ownership',
        expectFullyQualifiedMatrixRow
    );

    it.each(AV1_VIDEO_RANGE_MATRIX)(
        '$label: advertises the MP4 probe container exactly as Matroska',
        (row: AV1DirectPlayMatrixRow) => {
            expect(isAdvertised(row, MP4_PROBE_CONTAINER, HDR_DISPLAY_STOCK_VIDEO_RANGE_TYPES)).toBe(
                isAdvertised(row, 'mkv', HDR_DISPLAY_STOCK_VIDEO_RANGE_TYPES)
            );
        }
    );

    // The server ANDs every matching codec profile, so the stock ranges of an SDR display must widen too
    it.each(AV1_VIDEO_RANGE_MATRIX)(
        '$label: advertises the same ranges under the stock profile of an SDR display',
        (row: AV1DirectPlayMatrixRow) => {
            expect(isAdvertised(row, 'mkv', SDR_DISPLAY_STOCK_VIDEO_RANGE_TYPES)).toBe(
                isAdvertised(row, 'mkv', HDR_DISPLAY_STOCK_VIDEO_RANGE_TYPES)
            );
        }
    );
});

describe('AV1 DirectPlay route fallbacks', () => {
    it.each(AV1_ROUTE_FALLBACK_MATRIX)(
        '$label: presents only a declared base without the Dolby Vision RPU authorization',
        row => {
            expectFallbackRoute(
                row.videoStream,
                declaredBaseProfile,
                DECLARED_BASE_ROUTE_OPTIONS,
                fullyQualifiedCapabilities,
                DECLARED_BASE_ELIGIBILITY_OPTIONS,
                row.declaredBaseRoute
            );
        }
    );

    it.each(AV1_ROUTE_FALLBACK_MATRIX)(
        '$label: keeps only native 8-bit decode without raw AV1 planes',
        row => {
            expectFallbackRoute(
                row.videoStream,
                nativeDecodeProfile,
                FULL_ROUTE_OPTIONS,
                nativeDecodeCapabilities,
                FULL_ELIGIBILITY_OPTIONS,
                row.nativeDecodeRoute
            );
        }
    );
});

describe('AV1 DirectPlay outside Main 10 with a decoder package', () => {
    it.each(AV1_PACKAGE_ROUTE_MATRIX)(
        '$label: takes its raw route where its format qualifies, else the package',
        row => {
            const playbackOptions = createPlaybackOptions(row.videoStream);
            const mediaSource = playbackOptions.mediaSource;
            const packageOnly = row.rawRoute === null;

            expect(isSameSessionNativePlaybackCompatible(playbackOptions, packageProfile)).toBe(true);
            expect(hasEligibleCustomVideoRoute(mediaSource, fullyQualifiedCapabilities, PACKAGE_VIDEO_ROUTE_OPTIONS)).toBe(true);
            // Without the package only a qualified raw format is advertised and has a route
            expect(isSameSessionNativePlaybackCompatible(playbackOptions, fullyQualifiedProfile)).toBe(!packageOnly);
            expect(hasEligibleCustomVideoRoute(
                mediaSource,
                fullyQualifiedCapabilities,
                { ...PACKAGE_VIDEO_ROUTE_OPTIONS, gpuVideoDecoderSummaries: [] }
            )).toBe(!packageOnly);
            expect(getEligibleRoute(getCustomPlaybackEligibility(playbackOptions, fullyQualifiedCapabilities, FULL_ELIGIBILITY_OPTIONS))).toEqual(row.rawRoute);
        }
    );
});

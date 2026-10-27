import type { CodecProfile } from '@jellyfin/sdk/lib/generated-client/models/codec-profile';
import type { ContainerProfile } from '@jellyfin/sdk/lib/generated-client/models/container-profile';
import type { DeviceProfile } from '@jellyfin/sdk/lib/generated-client/models/device-profile';
import type { DirectPlayProfile } from '@jellyfin/sdk/lib/generated-client/models/direct-play-profile';
import type { ProfileCondition } from '@jellyfin/sdk/lib/generated-client/models/profile-condition';
import type { SubtitleProfile } from '@jellyfin/sdk/lib/generated-client/models/subtitle-profile';

import {
    CUSTOM_AUDIO_CODECS,
    CUSTOM_NATIVE_VIDEO_BIT_DEPTH,
    CUSTOM_RAW_HDR_VIDEO_CODECS,
    CUSTOM_VIDEO_CODECS,
    hasSupportedNativeSDRVideoCodec,
    type CustomAudioCodec,
    type CustomDecodeCapabilities,
    type CustomNativeSurroundAudioCodecCapability,
    type CustomVideoCodec
} from 'webgpu-player/capability/CustomDecodeCapabilities';
import {
    CUSTOM_NON_SURROUND_INPUT_CHANNEL_COUNTS,
    CUSTOM_SURROUND_INPUT_CHANNEL_COUNT,
    getSupportedCustomAudioInputChannelCounts,
    isCustomMediabunnyPCMAudioCodec
} from 'webgpu-player/audio/CustomAudioOutputPolicy';
import {
    CUSTOM_CONTAINER_CODEC_RULES,
    CUSTOM_PROFILE_VIDEO_CONTAINERS,
    getCustomAudioCodecProfileContainers
} from 'webgpu-player/capability/CustomContainerCodecSupport';
import {
    DTS_DIRECT_PLAY_PROFILE_TOKENS,
    DTS_PROFILE_VALUE_BY_TOKEN,
    DTS_SUPPORTED_INPUT_ROUTES,
    TRUEHD_SUPPORTED_INPUT_ROUTES,
    isDTSDirectPlayProfileToken,
    type DTSDirectPlayProfileToken
} from 'webgpu-player/audio/CustomCompressedAudioRoute';
import {
    NATIVE_MEDIA_AUDIO_CHANNEL_COUNTS,
    NATIVE_MEDIA_AUDIO_SAMPLE_RATE,
    type NativeMediaAudioCapabilities,
    type NativeMediaAudioChannelCount,
    type NativeMediaAudioCodec
} from 'webgpu-player/capability/NativeMediaAudioCapabilities';
import { getSupportedH264JellyfinProfileNames } from 'webgpu-player/capability/H264ProfileCapabilities';
import type {
    ExternalHDRAuthorizationRouteKey
} from 'webgpu-player/validation/ExternalHDRPresentationAuthorization';
import type { RawHDRAuthorizationRouteKey } from 'webgpu-player/validation/RawHDRPresentationAuthorization';
import type { ColorTransfer } from 'webgpu-player/color/ColorMetadata';
import {
    HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS,
    HEVC_RANGE_EXTENSION_VARIANTS,
    type HEVCRangeExtensionBitDepth,
    type HEVCRangeExtensionProbeDefinition,
    type HEVCRangeExtensionRawFormat,
    type HEVCRangeExtensionVariant
} from 'webgpu-player/capability/HEVCRangeExtensionCapabilities';
import {
    hasEligibleCustomVideoRoute,
    presentsInterlacedVideo,
    type CustomVideoRouteOptions
} from 'webgpu-player/capability/CustomPlaybackEligibility';
import { getDolbyVisionPresentationSelection } from 'webgpu-player/presentation/PresentationInput';
import {
    getGPUDecoderFormatFacts,
    isGPUDecoderOutputFormat,
    type GPUDecoderOutputFormat
} from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import type { GPUVideoDecoderSummary } from 'webgpu-player/decode/video/gpu/GPUVideoDecoderCatalog';

import { getPackageRouteSizeSteps, type PackageRouteSizeScope, type PackageRouteSizeStep } from './PackageRouteSizes';

/**
 * What a decoder package a playback can use decodes, as negotiation reads it: its kind, its codecs by the engine's names, and a video decoder's output formats,
 * with its header and the buffer limit of the device it would decode on where the host has them, which bound the streams its routes advertise.
 */
export type DecoderPackageRouteSummary = GPUVideoDecoderSummary & Readonly<{
    kind: 'audio' | 'video'
}>;

export type CustomDeviceProfileOptions = {
    /** Whether a GPU decoder's frame pool route may present HDR, which needs only the user's HDR tone mapping */
    allowFramePoolHDR?: boolean
    allowDolbyVision?: boolean
    allowDolbyVisionProfile4?: boolean
    allowDolbyVisionProfile7?: boolean
    allowDolbyVisionProfile7HDR10Base?: boolean
    allowNativeDolbyVision?: boolean
    allowNativeDolbyVisionProfile7HDR10Base?: boolean
    allowNativeDolbyVisionProfile8HDR10Base?: boolean
    allowNativeDolbyVisionProfile8HLGBase?: boolean
    allowNativeHDR?: boolean
    allowRawHDR?: boolean
    allowRawSDR?: boolean
    authorizedExternalHDRRouteKeys?: readonly ExternalHDRAuthorizationRouteKey[]
    authorizedRawHDRRouteKeys?: readonly RawHDRAuthorizationRouteKey[]
    /**
     * The decoder packages a playback can use: the user's own and the ones the server offers, which a playback fetches when it needs one.
     * Their codecs are advertised as routes; the host lists a video package only on a device that holds a frame pool.
     */
    decoderPackages?: readonly DecoderPackageRouteSummary[]
    isRetry?: boolean
    /**
     * The negotiated item's media source.
     * When its Dolby Vision stream has a runtime route, its exact profile, bit depth, and range label are advertised even where no generic route covers that label.
     */
    itemMediaSource?: unknown
    nativeMediaAudioCapabilities?: NativeMediaAudioCapabilities | null
    subtitleCapabilities?: CustomSubtitleCapabilities
};

export type CustomSubtitleCapabilities = Readonly<{
    externalASS: boolean
    externalPGS: boolean
    externalText: boolean
}>;

export type CustomDeviceProfileReason =
    | 'already-advertised'
    | 'augmented'
    | 'no-compatible-combinations'
    | 'no-supported-codecs'
    | 'retry-not-widened';

export type CustomDeviceProfileTelemetry = {
    addedAudioProfileCount: number
    addedProfileCount: number
    addedVideoProfileCount: number
    reason: CustomDeviceProfileReason
    supportedAudioCodecs: readonly CustomAudioCodec[]
    supportedVideoCodecs: readonly CustomVideoCodec[]
    subtitleProfileChanged: boolean
    widenedHDRCodecProfileCount: number
};

export type CustomDeviceProfileResult = {
    profile: DeviceProfile
    telemetry: CustomDeviceProfileTelemetry
};

type AuthorizedHDRRoutes = {
    allowNativeDolbyVision: boolean
    allowNativeHDR: boolean
    allowRawDolbyVision: boolean
    dolbyVisionItemVideoRoute: MeasuredVideoRoute | null
    dolbyVisionVideoRangeTypes: readonly string[]
    nativeHDRVideoRangeTypes: readonly string[]
    /** The decoder packages' routes, which widen HEVC's stock ceiling with their profiles and depths */
    packageVideoRoutes: readonly MeasuredVideoRoute[]
    /** The stock-profile ceilings of the raw codecs other than HEVC that have a route beyond native SDR decode. */
    rawCodecProfilePlans: ReadonlyMap<CustomVideoCodec, AuthorizedCodecProfilePlan>
    rawHDRRouteVideoRangeTypes: readonly string[]
    rawHDRVideoRangeTypes: readonly string[]
    rawAuthorizationRouteKeys: readonly RawHDRAuthorizationRouteKey[]
    /** Whether HEVC's stock profiles take a ceiling: raw or range-extension routes are authorized, or a decoder package decodes HEVC */
    widenHEVC: boolean
};

type MeasuredVideoRouteOptions = {
    allowNativeDolbyVision: boolean
    allowNativeHDR: boolean
    dolbyVisionItemVideoRoute: MeasuredVideoRoute | null
    nativeDolbyVisionVideoRangeTypes: readonly string[]
    nativeHDRVideoRangeTypes: readonly string[]
    /** The routes of the decoder packages a playback can use, every codec's */
    packageVideoRoutes: readonly MeasuredVideoRoute[]
    /** The decoder packages' route scopes, each of one profile and depth, whose size steps bound the streams a scope takes where no other route takes them */
    packageVideoScopes: readonly PackageVideoScope[]
    rawAV1DolbyVisionVideoRangeTypes: readonly string[]
    rawDolbyVisionVideoRangeTypes: readonly string[]
    rawHDRRouteVideoRangeTypes: readonly string[]
    rawAuthorizationRouteKeys: readonly RawHDRAuthorizationRouteKey[]
};

type AuthorizedCodecProfilePlan = {
    bitDepths: readonly number[]
    profiles: readonly string[]
    rangeTypes: readonly string[]
};

const CUSTOM_VIDEO_CONTAINERS: readonly string[] = CUSTOM_PROFILE_VIDEO_CONTAINERS;
const CUSTOM_VIDEO_CONTAINER_SET = new Set<string>(CUSTOM_VIDEO_CONTAINERS);
const CUSTOM_VIDEO_CONTAINER_VALUE = CUSTOM_VIDEO_CONTAINERS.join(',');
const NON_CUSTOM_VIDEO_CONTAINER_VALUE = `-${CUSTOM_VIDEO_CONTAINER_VALUE}`;
const VIDEO_CODEC_PROFILE_TYPE = 'Video';
const AUDIO_BIT_DEPTH_PROPERTY = 'AudioBitDepth';
const AUDIO_BITRATE_PROPERTY = 'AudioBitrate';
const VIDEO_RANGE_TYPE_PROPERTY = 'VideoRangeType';
const VIDEO_BIT_DEPTH_PROPERTY = 'VideoBitDepth';
const VIDEO_BITRATE_PROPERTY = 'VideoBitrate';
const VIDEO_FRAMERATE_PROPERTY = 'VideoFramerate';
const VIDEO_HEIGHT_PROPERTY = 'Height';
const VIDEO_INTERLACED_PROPERTY = 'IsInterlaced';
const VIDEO_LEVEL_PROPERTY = 'VideoLevel';
const VIDEO_PROFILE_PROPERTY = 'VideoProfile';
const VIDEO_WIDTH_PROPERTY = 'Width';
const AUDIO_CHANNELS_PROPERTY = 'AudioChannels';
const AUDIO_PROFILE_PROPERTY = 'AudioProfile';
const AUDIO_SAMPLE_RATE_PROPERTY = 'AudioSampleRate';
const EQUALS_CONDITION = 'Equals';
const EQUALS_ANY_CONDITION = 'EqualsAny';
const GREATER_THAN_EQUAL_CONDITION = 'GreaterThanEqual';
const LESS_THAN_EQUAL_CONDITION = 'LessThanEqual';
const NOT_EQUALS_CONDITION = 'NotEquals';
const EXTERNAL_SUBTITLE_METHOD = 'External';
const CUSTOM_EXTERNAL_TEXT_SUBTITLE_FORMAT = 'vtt';
const CUSTOM_EXTERNAL_ASS_SUBTITLE_FORMATS = [ 'ass', 'ssa' ] as const;
const CUSTOM_EXTERNAL_PGS_SUBTITLE_FORMAT = 'pgssub';
const DTS_HIGH_SAMPLE_RATE_MINIMUM = 96_001;
const MAXIMUM_RAW_HDR_VIDEO_BIT_DEPTH = 10;
// VideoBitDepth Equals 0 never matches a real stream, so the route rejects its profile/range pair
const UNSUPPORTED_ROUTE_BIT_DEPTH = 0;
const GENERIC_REXT_PROFILE = 'Rext';
const GENERIC_REXT_BIT_DEPTHS = [ 8, 10, 12 ] as const satisfies readonly HEVCRangeExtensionBitDepth[];
const HDR10_PLUS_VIDEO_RANGE_TYPE = 'HDR10Plus';
const DOLBY_VISION_VIDEO_RANGE_TYPES = [
    'DOVI',
    'DOVIWithHDR10',
    'DOVIWithHLG',
    'DOVIWithSDR',
    'DOVIWithHDR10Plus'
] as const;
const DOLBY_VISION_PROFILE_7_VIDEO_RANGE_TYPES = [
    'DOVIWithEL',
    'DOVIWithELHDR10Plus'
] as const;
// Jellyfin's label for Profile 8 outside compatibility IDs 1, 2, and 4, and on 12.x for Dolby Vision whose base color fields disagree with its compatibility ID
const DOLBY_VISION_INVALID_VIDEO_RANGE_TYPE = 'DOVIInvalid';
// Profile 10 carries a single-layer RPU, so AV1 never takes an EL label.
// RPU reconstruction presents every compatibility ID, including the ones Jellyfin labels DOVIInvalid
const AV1_DOLBY_VISION_VIDEO_RANGE_TYPES = [
    ...DOLBY_VISION_VIDEO_RANGE_TYPES,
    DOLBY_VISION_INVALID_VIDEO_RANGE_TYPE
] as const;
// The labels a Dolby Vision route presents, which never deinterlaces
const DOLBY_VISION_RANGE_TYPE_SET = new Set<string>([
    ...DOLBY_VISION_VIDEO_RANGE_TYPES,
    ...DOLBY_VISION_PROFILE_7_VIDEO_RANGE_TYPES,
    DOLBY_VISION_INVALID_VIDEO_RANGE_TYPE
]);
// Every Jellyfin range label except Unknown; exact routes cover each one per profile
const JELLYFIN_VIDEO_RANGE_TYPES = [
    'SDR',
    'HDR10',
    'HLG',
    ...DOLBY_VISION_VIDEO_RANGE_TYPES,
    ...DOLBY_VISION_PROFILE_7_VIDEO_RANGE_TYPES,
    DOLBY_VISION_INVALID_VIDEO_RANGE_TYPE,
    HDR10_PLUS_VIDEO_RANGE_TYPE
] as const;
// The codecs whose Dolby Vision items can need their own route: HEVC, and AV1 for Profile 10
const DOLBY_VISION_ITEM_VIDEO_CODECS: ReadonlyMap<string, 'av1' | 'hevc'> = new Map<string, 'av1' | 'hevc'>([
    [ 'AV1', 'av1' ],
    [ 'H265', 'hevc' ],
    [ 'HEVC', 'hevc' ]
]);
const BITRATE_CONDITION_PROPERTIES = new Set<string>([
    AUDIO_BITRATE_PROPERTY,
    VIDEO_BITRATE_PROPERTY
]);
const NATIVE_VIDEO_RUNTIME_CONDITION_PROPERTIES = new Set<string>([
    VIDEO_FRAMERATE_PROPERTY,
    VIDEO_HEIGHT_PROPERTY,
    VIDEO_LEVEL_PROPERTY,
    VIDEO_WIDTH_PROPERTY
]);
const SUPPORTED_DTS_AUDIO_PROFILES: readonly string[] =
    Object.freeze(DTS_DIRECT_PLAY_PROFILE_TOKENS.map(profileToken => (DTS_PROFILE_VALUE_BY_TOKEN[profileToken])));

function getDolbyVisionVideoRangeTypes(
    capabilities: CustomDecodeCapabilities,
    allowRawDolbyVision: boolean,
    allowRawDolbyVisionProfile7: boolean,
    allowRawDolbyVisionProfile7HDR10Base: boolean,
    allowNativeDolbyVision: boolean
): string[] {
    const rangeTypes: string[] = [];
    if (allowNativeDolbyVision && capabilities.nativeDolbyVisionHEVC?.status === 'supported') {
        rangeTypes.push('DOVI');
    }
    if (capabilities.rawHDRVideo.hevc.status !== 'supported') {
        return rangeTypes;
    }
    if (allowRawDolbyVision) {
        for (const rangeType of DOLBY_VISION_VIDEO_RANGE_TYPES) {
            if (!rangeTypes.includes(rangeType)) {
                rangeTypes.push(rangeType);
            }
        }
        // RPU reconstruction presents every compatibility ID, including the ones Jellyfin labels DOVIInvalid
        rangeTypes.push(DOLBY_VISION_INVALID_VIDEO_RANGE_TYPE);
    }
    // No decoder decodes the EL, so Profile 7 reconstructs from its BL
    if (allowRawDolbyVisionProfile7) {
        rangeTypes.push(...DOLBY_VISION_PROFILE_7_VIDEO_RANGE_TYPES);
        if (allowRawDolbyVisionProfile7HDR10Base) {
            rangeTypes.push('HDR10');
        }
    }
    return rangeTypes;
}

/** Returns the AV1 Dolby Vision ranges, which Profile 10 reconstruction presents only from raw AV1 planes. */
function getAV1DolbyVisionVideoRangeTypes(capabilities: CustomDecodeCapabilities, allowRawDolbyVision: boolean): readonly string[] {
    return allowRawDolbyVision && capabilities.rawHDRVideo.av1.status === 'supported' ? AV1_DOLBY_VISION_VIDEO_RANGE_TYPES : [];
}

function getAuthorizedRawHDRVideoRangeTypes(routeKeys: readonly RawHDRAuthorizationRouteKey[]): string[] {
    const rangeTypes: string[] = [];
    for (const routeKey of routeKeys) {
        switch (routeKey) {
            case 'I420P10:bt2020-ncl:bt2020:limited:hlg':
                if (!rangeTypes.includes('HLG')) {
                    rangeTypes.push('HLG');
                }
                break;
            case 'I420P10:bt2020-ncl:bt2020:limited:pq':
                if (!rangeTypes.includes('HDR10')) {
                    rangeTypes.push('HDR10');
                }
                break;
        }
    }
    return rangeTypes;
}

/** Returns the ranges every raw HDR route advertises: HDR10Plus joins HDR10, because raw PQ presents the static HDR10 base that HDR10+ always carries. */
function getRawHDRRouteVideoRangeTypes(rawHDRVideoRangeTypes: readonly string[]): string[] {
    const rangeTypes: string[] = [ ...rawHDRVideoRangeTypes ];
    if (rangeTypes.includes('HDR10') && !rangeTypes.includes(HDR10_PLUS_VIDEO_RANGE_TYPE)) {
        rangeTypes.push(HDR10_PLUS_VIDEO_RANGE_TYPE);
    }
    return rangeTypes;
}

function getAuthorizedExternalHDRVideoRangeTypes(routeKeys: readonly ExternalHDRAuthorizationRouteKey[]): string[] {
    const rangeTypes: string[] = [];
    for (const routeKey of routeKeys) {
        switch (routeKey) {
            case 'external-hevc-main10-bt709-limited:hlg-v1':
                rangeTypes.push('HLG');
                break;
            case 'external-hevc-main10-bt709-limited:pq-v1':
                rangeTypes.push('HDR10');
                rangeTypes.push(HDR10_PLUS_VIDEO_RANGE_TYPE);
                break;
        }
    }
    return rangeTypes;
}

function authorizeNativeDolbyVisionBaseRanges(
    capabilities: CustomDecodeCapabilities,
    options: CustomDeviceProfileOptions,
    nativeHDRVideoRangeTypes: string[]
): ReadonlySet<string> {
    const overlappingRawRangeTypes = new Set<string>();
    if (capabilities.nativeHDRHEVC?.status !== 'supported') {
        return overlappingRawRangeTypes;
    }
    const PQRouteAuthorized = nativeHDRVideoRangeTypes.includes('HDR10');
    if (PQRouteAuthorized && options.allowNativeDolbyVisionProfile7HDR10Base === true) {
        nativeHDRVideoRangeTypes.push(...DOLBY_VISION_PROFILE_7_VIDEO_RANGE_TYPES);
        for (const rangeType of DOLBY_VISION_PROFILE_7_VIDEO_RANGE_TYPES) {
            overlappingRawRangeTypes.add(rangeType);
        }
        overlappingRawRangeTypes.add('HDR10');
    }
    if (PQRouteAuthorized && options.allowNativeDolbyVisionProfile8HDR10Base === true) {
        nativeHDRVideoRangeTypes.push('DOVIWithHDR10');
        nativeHDRVideoRangeTypes.push('DOVIWithHDR10Plus');
        overlappingRawRangeTypes.add('DOVIWithHDR10');
        overlappingRawRangeTypes.add('DOVIWithHDR10Plus');
    }
    if (nativeHDRVideoRangeTypes.includes('HLG')
        && options.allowNativeDolbyVisionProfile8HLGBase === true) {
        nativeHDRVideoRangeTypes.push('DOVIWithHLG');
        overlappingRawRangeTypes.add('DOVIWithHLG');
    }
    return overlappingRawRangeTypes;
}

type MeasuredVideoRoute = {
    bitDepths: readonly number[]
    codec: CustomVideoCodec
    profiles: readonly string[]
    rangeTypes: readonly string[]
};

/** Returns the profile token a codec's routes already use for a Jellyfin profile name, so exact pairs merge. */
function getCanonicalRouteProfile(codec: 'av1' | 'hevc', profile: string): string {
    const normalizedProfile = profile.trim().toLowerCase();
    const knownProfiles: string[] = [];
    knownProfiles.push(...NATIVE_VIDEO_PROFILES[codec], ...RAW_VIDEO_PROFILES[codec]);
    if (codec === 'hevc') {
        knownProfiles.push(GENERIC_REXT_PROFILE, ...NAMED_HEVC_RANGE_EXTENSION_PROFILES);
    }
    return knownProfiles.find((knownProfile: string): boolean => (
        knownProfile.toLowerCase() === normalizedProfile
    )) ?? normalizedProfile;
}

/** Returns the options of the engine's item route check: the profile's route flags and keys, and the video decoder packages a playback could use. */
function getItemEligibilityOptions(
    options: CustomDeviceProfileOptions
): CustomVideoRouteOptions {
    return {
        allowDolbyVision: options.allowDolbyVision,
        allowDolbyVisionProfile4: options.allowDolbyVisionProfile4,
        allowDolbyVisionProfile7: options.allowDolbyVisionProfile7,
        allowFramePoolHDR: options.allowFramePoolHDR,
        allowNativeDolbyVision: options.allowNativeDolbyVision,
        allowNativeDolbyVisionProfile7HDR10Base: options.allowNativeDolbyVisionProfile7HDR10Base,
        allowNativeDolbyVisionProfile8HDR10Base: options.allowNativeDolbyVisionProfile8HDR10Base,
        allowNativeDolbyVisionProfile8HLGBase: options.allowNativeDolbyVisionProfile8HLGBase,
        allowNativeHDR: options.allowNativeHDR,
        allowRawHDR: options.allowRawHDR === true,
        allowRawSDR: options.allowRawSDR,
        authorizedExternalHDRRouteKeys: options.authorizedExternalHDRRouteKeys,
        authorizedRawHDRRouteKeys: options.authorizedRawHDRRouteKeys,
        gpuVideoDecoderSummaries: (options.decoderPackages ?? []).filter((decoderPackage: DecoderPackageRouteSummary): boolean => (
            decoderPackage.kind === 'video'
        ))
    };
}

/**
 * Returns one exact route for a negotiated Dolby Vision item that the runtime presents.
 * Jellyfin labels many presentable streams outside the generic Dolby Vision ranges: Profiles 4 and 20 by transfer, Profile 10 without a compatibility ID by transfer, and range extension, Main 12, or 8-bit sources with any label.
 * So the item's own profile, bit depth, and range are advertised.
 */
function getDolbyVisionItemVideoRoute(
    capabilities: CustomDecodeCapabilities,
    options: CustomDeviceProfileOptions
): MeasuredVideoRoute | null {
    const mediaSource = options.itemMediaSource;
    // A retry is never widened
    if (options.isRetry === true || !mediaSource || typeof mediaSource !== 'object') {
        return null;
    }
    const selection = getDolbyVisionPresentationSelection({ mediaSource });
    const mediaStreams = (mediaSource as { MediaStreams?: unknown }).MediaStreams;
    if (!selection || !Array.isArray(mediaStreams)) {
        return null;
    }
    const videoStreams = mediaStreams.filter((stream: unknown): stream is Record<string, unknown> => (
        stream !== null
        && typeof stream === 'object'
        && String((stream as { Type?: unknown }).Type ?? '').trim().toUpperCase() === 'VIDEO'
    ));
    const videoStream = videoStreams[selection.baseLayerVideoTrackOrdinal];
    if (!videoStream) {
        return null;
    }
    const codec = DOLBY_VISION_ITEM_VIDEO_CODECS.get(String(videoStream.Codec ?? '').trim().toUpperCase());
    const profile = typeof videoStream.Profile === 'string' ? videoStream.Profile.trim() : '';
    const bitDepth = videoStream.BitDepth;
    const rangeType = videoStream.VideoRangeType;
    if (
        codec === undefined
        || profile.length === 0
        || typeof bitDepth !== 'number'
        || !Number.isSafeInteger(bitDepth)
        || bitDepth <= UNSUPPORTED_ROUTE_BIT_DEPTH
        || typeof rangeType !== 'string'
        || !(JELLYFIN_VIDEO_RANGE_TYPES as readonly string[]).includes(rangeType)
        || !hasEligibleCustomVideoRoute(
            mediaSource,
            capabilities,
            getItemEligibilityOptions(options)
        )
    ) {
        return null;
    }
    return {
        bitDepths: [ bitDepth ],
        codec,
        profiles: [ getCanonicalRouteProfile(codec, profile) ],
        rangeTypes: [ rangeType ]
    };
}

const NATIVE_VIDEO_PROFILES: Readonly<Record<CustomVideoCodec, readonly string[]>> = {
    av1: [ 'main' ],
    h264: [],
    hevc: [ 'main' ],
    jpeg2000: [],
    mpeg1video: [],
    mpeg2video: [ 'main' ],
    vc1: [ 'advanced' ],
    vp8: [],
    vp9: [ 'profile 0' ],
    wmv3: [ 'simple', 'main', 'complex' ]
};

function getNativeVideoProfiles(
    codec: CustomVideoCodec,
    capabilities: CustomDecodeCapabilities
): readonly string[] {
    if (codec !== 'h264') {
        return NATIVE_VIDEO_PROFILES[codec];
    }
    if (!capabilities.h264Profiles) {
        return [];
    }
    return getSupportedH264JellyfinProfileNames(capabilities.h264Profiles);
}

function supportsNativeVideoCodec(
    codec: CustomVideoCodec,
    capabilities: CustomDecodeCapabilities
): boolean {
    switch (codec) {
        case 'h264':
            return getNativeVideoProfiles(codec, capabilities).length > 0;
        case 'av1':
        case 'hevc':
        case 'vp9':
            return hasSupportedNativeSDRVideoCodec(codec, capabilities);
        case 'jpeg2000':
        case 'mpeg1video':
        case 'mpeg2video':
        case 'vc1':
        case 'wmv3':
            // Only a decoder package decodes these
            return false;
        case 'vp8':
            return capabilities.video[codec].status === 'supported';
    }
}

function supportsNativeMain10HEVC(capabilities: CustomDecodeCapabilities): boolean {
    return capabilities.nativeHDRHEVC?.status === 'supported';
}

const RAW_VIDEO_PROFILES: Readonly<Record<'av1' | 'hevc' | 'vp9', readonly string[]>> = {
    av1: [ 'main' ],
    hevc: [ 'main 10' ],
    vp9: [ 'profile 2' ]
};

// The ranges a GPU decoder's frame pool route presents beyond SDR, with the user's HDR tone mapping
const FRAME_POOL_HDR_VIDEO_RANGE_TYPES = [ 'HDR10', HDR10_PLUS_VIDEO_RANGE_TYPE, 'HLG' ] as const;

// The profile Jellyfin names a stream of each frame pool format by, for the codecs whose stock and route profiles condition on profile.
// AV1 Main is 4:2:0 at 8 or 10 bits, High adds 4:4:4, and Professional takes 4:2:2 and 12 bits; VP9 profiles 0 and 1 are 8-bit, 2 and 3 deeper, and 1 and 3 hold 4:2:2 and 4:4:4.
// HEVC takes its names from the range extension definitions instead
const PACKAGE_VIDEO_PROFILE_BY_FORMAT: Readonly<Partial<Record<CustomVideoCodec, Readonly<Record<GPUDecoderOutputFormat, string>>>>> = {
    av1: {
        I420: 'main',
        I420P10: 'main',
        I420P12: 'professional',
        I422: 'professional',
        I422P10: 'professional',
        I422P12: 'professional',
        I444: 'high',
        I444P10: 'high',
        I444P12: 'professional'
    },
    vp9: {
        I420: 'profile 0',
        I420P10: 'profile 2',
        I420P12: 'profile 2',
        I422: 'profile 1',
        I422P10: 'profile 3',
        I422P12: 'profile 3',
        I444: 'profile 1',
        I444P10: 'profile 3',
        I444P12: 'profile 3'
    }
};

function isCustomVideoCodec(codec: string): codec is CustomVideoCodec {
    return (CUSTOM_VIDEO_CODECS as readonly string[]).includes(codec);
}

function isCustomAudioCodec(codec: string): codec is CustomAudioCodec {
    return (CUSTOM_AUDIO_CODECS as readonly string[]).includes(codec);
}

/**
 * One profile and depth of a codec that decoder packages decode: the formats its streams may decode into, the ranges it presents,
 * and the size steps of the streams the packages take on the device, null when no size bounds them.
 * A codec only packages decode takes no profile condition, so its scopes have no profile.
 */
type PackageVideoScope = PackageRouteSizeScope & Readonly<{
    bitDepth: number
    codec: CustomVideoCodec
    profile: string | null
    rangeTypes: readonly string[]
    sizeSteps: readonly PackageRouteSizeStep[] | null
}>;

type PackageVideoScopeDefinition = Pick<PackageVideoScope, 'bitDepth' | 'formats' | 'monochromeFormat' | 'profile'>;

/**
 * Returns HEVC's package scopes: Main and Main 10 at 4:2:0, each named range extension at its format, and generic Rext at each depth,
 * whose label hides the chroma format, so it needs every chroma format of the depth, 4:0:0 among them.
 */
function getPackageHEVCScopeDefinitions(): PackageVideoScopeDefinition[] {
    const definitions: PackageVideoScopeDefinition[] = [
        ...NATIVE_VIDEO_PROFILES.hevc.map((profile: string): PackageVideoScopeDefinition => (
            { bitDepth: CUSTOM_NATIVE_VIDEO_BIT_DEPTH, formats: [ 'I420' ], monochromeFormat: null, profile }
        )),
        ...RAW_VIDEO_PROFILES.hevc.map((profile: string): PackageVideoScopeDefinition => (
            { bitDepth: MAXIMUM_RAW_HDR_VIDEO_BIT_DEPTH, formats: [ 'I420P10' ], monochromeFormat: null, profile }
        ))
    ];
    for (const variant of HEVC_RANGE_EXTENSION_VARIANTS) {
        const definition = HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS[variant];
        if (definition.jellyfinProfile !== GENERIC_REXT_PROFILE) {
            definitions.push({ bitDepth: definition.bitDepth, formats: [ definition.format ], monochromeFormat: null, profile: definition.jellyfinProfile });
        }
    }
    for (const bitDepth of GENERIC_REXT_BIT_DEPTHS) {
        const depthDefinitions = HEVC_RANGE_EXTENSION_VARIANTS
            .map((variant: HEVCRangeExtensionVariant): HEVCRangeExtensionProbeDefinition => HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS[variant])
            .filter((definition: HEVCRangeExtensionProbeDefinition): boolean => definition.bitDepth === bitDepth);
        definitions.push({
            bitDepth,
            formats: depthDefinitions.map((definition: HEVCRangeExtensionProbeDefinition): HEVCRangeExtensionRawFormat => definition.format),
            monochromeFormat: depthDefinitions.find((definition: HEVCRangeExtensionProbeDefinition): boolean => definition.chromaFormat === '420')?.format ?? null,
            profile: GENERIC_REXT_PROFILE
        });
    }
    return definitions;
}

/**
 * Returns a codec's package scopes: HEVC's by its profiles, AV1's and VP9's by the profile each format's streams carry, and a codec only packages decode by depth,
 * whose chroma formats no Jellyfin condition tells apart, so a depth's scope holds every format of it the packages write.
 */
function getPackageVideoScopeDefinitions(codec: CustomVideoCodec, writtenFormats: readonly GPUDecoderOutputFormat[]): PackageVideoScopeDefinition[] {
    if (codec === 'hevc') {
        return getPackageHEVCScopeDefinitions();
    }
    const profileByFormat = PACKAGE_VIDEO_PROFILE_BY_FORMAT[codec];
    const formats = profileByFormat ? Object.keys(profileByFormat).filter(isGPUDecoderOutputFormat) : writtenFormats;
    const definitions = new Map<string, PackageVideoScopeDefinition>();
    for (const format of formats) {
        const profile = profileByFormat?.[format] ?? null;
        const bitDepth = getGPUDecoderFormatFacts(format).bitDepth;
        const key = `${profile}:${bitDepth}`;
        const definition = definitions.get(key);
        definitions.set(key, definition ?
            { ...definition, formats: [ ...definition.formats, format ] } :
            { bitDepth, formats: [ format ], monochromeFormat: null, profile });
    }
    return [ ...definitions.values() ];
}

/** Returns the video decoder packages by each codec they decode that the engine names, in the packages' order. */
function groupVideoPackagesByCodec(decoderPackages: readonly DecoderPackageRouteSummary[]): Map<CustomVideoCodec, DecoderPackageRouteSummary[]> {
    const summariesByCodec = new Map<CustomVideoCodec, DecoderPackageRouteSummary[]>();
    for (const decoderPackage of decoderPackages.filter((summary: DecoderPackageRouteSummary): boolean => summary.kind === 'video')) {
        for (const codec of decoderPackage.codecs.filter(isCustomVideoCodec)) {
            summariesByCodec.set(codec, [ ...summariesByCodec.get(codec) ?? [], decoderPackage ]);
        }
    }
    return summariesByCodec;
}

/**
 * Returns the scopes of the video decoder packages a playback can use: per codec, each profile and depth whose every format, and 4:0:0 where the scope holds it,
 * some package takes at some size, with the size steps the packages take it at; SDR, and HDR when the frame pool may present it.
 */
function createPackageVideoScopes(
    decoderPackages: readonly DecoderPackageRouteSummary[],
    allowFramePoolHDR: boolean
): PackageVideoScope[] {
    const rangeTypes: string[] = [ 'SDR' ];
    if (allowFramePoolHDR) {
        rangeTypes.push(...FRAME_POOL_HDR_VIDEO_RANGE_TYPES);
    }
    const scopes: PackageVideoScope[] = [];
    for (const [ codec, summaries ] of groupVideoPackagesByCodec(decoderPackages)) {
        const writtenFormats: GPUDecoderOutputFormat[] = [];
        for (const summary of summaries) {
            appendUniqueValues(writtenFormats, summary.outputFormats.filter(isGPUDecoderOutputFormat));
        }
        for (const definition of getPackageVideoScopeDefinitions(codec, writtenFormats)) {
            const scope = { ...definition, codec };
            // A format no package writes takes no size
            const sizeSteps = getPackageRouteSizeSteps(summaries, scope);
            if (sizeSteps === null || sizeSteps.length > 0) {
                scopes.push({ ...scope, rangeTypes, sizeSteps });
            }
        }
    }
    return scopes;
}

/** Returns the routes of the package scopes: one per codec and profile with that profile's depths, in the scopes' order. */
function createPackageVideoRoutes(scopes: readonly PackageVideoScope[]): MeasuredVideoRoute[] {
    const routes = new Map<string, MeasuredVideoRoute>();
    for (const scope of scopes) {
        const key = `${scope.codec}:${scope.profile}`;
        const route = routes.get(key);
        routes.set(key, route ?
            { ...route, bitDepths: [ ...route.bitDepths, scope.bitDepth ] } :
            { bitDepths: [ scope.bitDepth ], codec: scope.codec, profiles: scope.profile === null ? [] : [ scope.profile ], rangeTypes: scope.rangeTypes });
    }
    return [ ...routes.values() ];
}

/** Returns the audio codecs a decoder package a playback can use decodes. */
function getPackageAudioCodecs(decoderPackages: readonly DecoderPackageRouteSummary[]): CustomAudioCodec[] {
    const codecs: CustomAudioCodec[] = [];
    for (const decoderPackage of decoderPackages) {
        if (decoderPackage.kind === 'audio') {
            appendUniqueValues(codecs, decoderPackage.codecs.filter(isCustomAudioCodec));
        }
    }
    return codecs;
}

/** Returns whether a codec's audio decodes through a decoder package: no engine decoder decodes it, and a package does. */
function isPackageDecodedAudioCodec(
    codec: CustomAudioCodec,
    capabilities: CustomDecodeCapabilities,
    packageAudioCodecs: readonly CustomAudioCodec[]
): boolean {
    return capabilities.audio[codec].status !== 'supported' && packageAudioCodecs.includes(codec);
}

function cloneDeviceProfile(profile: DeviceProfile): DeviceProfile {
    const clonedProfile: DeviceProfile = { ...profile };
    if (profile.DirectPlayProfiles) {
        clonedProfile.DirectPlayProfiles = profile.DirectPlayProfiles.map(directPlayProfile => ({
            ...directPlayProfile
        }));
    }
    if (profile.TranscodingProfiles) {
        clonedProfile.TranscodingProfiles = profile.TranscodingProfiles.map(transcodingProfile => ({
            ...transcodingProfile,
            Conditions: transcodingProfile.Conditions?.map(condition => ({ ...condition }))
        }));
    }
    if (profile.ContainerProfiles) {
        clonedProfile.ContainerProfiles = profile.ContainerProfiles.map(containerProfile => ({
            ...containerProfile,
            Conditions: containerProfile.Conditions?.map(condition => ({ ...condition }))
        }));
    }
    if (profile.CodecProfiles) {
        clonedProfile.CodecProfiles = profile.CodecProfiles.map(codecProfile => ({
            ...codecProfile,
            ...(codecProfile.ApplyConditions ? {
                ApplyConditions: codecProfile.ApplyConditions.map(condition => ({ ...condition }))
            } : {}),
            ...(codecProfile.Conditions ? {
                Conditions: codecProfile.Conditions.map(condition => ({ ...condition }))
            } : {})
        }));
    }
    if (profile.SubtitleProfiles) {
        clonedProfile.SubtitleProfiles = profile.SubtitleProfiles.map(subtitleProfile => ({
            ...subtitleProfile
        }));
    }
    return clonedProfile;
}

function normalizeSubtitleProfileValue(value: string | null | undefined): string {
    return value?.trim().toLowerCase() ?? '';
}

function getSubtitleProfileKey(profile: SubtitleProfile): string {
    return [
        normalizeSubtitleProfileValue(profile.Method),
        normalizeSubtitleProfileValue(profile.Format),
        normalizeSubtitleProfileValue(profile.Container),
        normalizeSubtitleProfileValue(profile.Language),
        normalizeSubtitleProfileValue(profile.DidlMode)
    ].join('|');
}

function addUniqueSubtitleProfile(
    profiles: SubtitleProfile[],
    profileKeys: Set<string>,
    profile: SubtitleProfile
): void {
    const profileKey: string = getSubtitleProfileKey(profile);
    if (profileKeys.has(profileKey)) {
        return;
    }
    profiles.push({ ...profile });
    profileKeys.add(profileKey);
}

/** Restricts custom playback to subtitle formats rendered by its owned HTML layers. */
function applyCustomSubtitleProfiles(
    profile: DeviceProfile,
    capabilities: CustomSubtitleCapabilities
): boolean {
    const originalProfiles: readonly SubtitleProfile[] = profile.SubtitleProfiles ?? [];
    const customProfiles: SubtitleProfile[] = [];
    const profileKeys = new Set<string>();

    for (const subtitleProfile of originalProfiles) {
        if (normalizeSubtitleProfileValue(subtitleProfile.Method) === 'external') {
            continue;
        }
        addUniqueSubtitleProfile(customProfiles, profileKeys, subtitleProfile);
    }

    if (capabilities.externalText) {
        addUniqueSubtitleProfile(customProfiles, profileKeys, {
            Format: CUSTOM_EXTERNAL_TEXT_SUBTITLE_FORMAT,
            Method: EXTERNAL_SUBTITLE_METHOD
        });
    }
    if (capabilities.externalASS) {
        for (const format of CUSTOM_EXTERNAL_ASS_SUBTITLE_FORMATS) {
            addUniqueSubtitleProfile(customProfiles, profileKeys, {
                Format: format,
                Method: EXTERNAL_SUBTITLE_METHOD
            });
        }
    }
    if (capabilities.externalPGS) {
        addUniqueSubtitleProfile(customProfiles, profileKeys, {
            Format: CUSTOM_EXTERNAL_PGS_SUBTITLE_FORMAT,
            Method: EXTERNAL_SUBTITLE_METHOD
        });
    }

    profile.SubtitleProfiles = customProfiles;
    if (originalProfiles.length !== customProfiles.length) {
        return true;
    }
    return originalProfiles.some((subtitleProfile: SubtitleProfile, index: number): boolean => (
        getSubtitleProfileKey(subtitleProfile) !== getSubtitleProfileKey(customProfiles[index])
    ));
}

function applyOptionalCustomSubtitleProfiles(
    profile: DeviceProfile,
    capabilities: CustomSubtitleCapabilities | undefined
): boolean {
    if (!capabilities) {
        return false;
    }
    return applyCustomSubtitleProfiles(profile, capabilities);
}

function removeBitrateConditions(conditions: NonNullable<CodecProfile['Conditions']>): NonNullable<CodecProfile['Conditions']> {
    return conditions.filter(condition => (
        !condition.Property || !BITRATE_CONDITION_PROPERTIES.has(condition.Property)
    ));
}

/** Removes every client bitrate input that Jellyfin can use for playback selection. */
function removeBitratePlaybackConstraints(profile: DeviceProfile): void {
    profile.MaxStreamingBitrate = null;
    profile.MaxStaticBitrate = null;
    profile.MaxStaticMusicBitrate = null;

    for (const codecProfile of profile.CodecProfiles ?? []) {
        if (codecProfile.ApplyConditions) {
            codecProfile.ApplyConditions = removeBitrateConditions(codecProfile.ApplyConditions);
        }
        if (codecProfile.Conditions) {
            codecProfile.Conditions = removeBitrateConditions(codecProfile.Conditions);
        }
    }
    for (const containerProfile of profile.ContainerProfiles ?? []) {
        if (containerProfile.Conditions) {
            containerProfile.Conditions = removeBitrateConditions(containerProfile.Conditions);
        }
    }
}

/** Clones a device profile and removes bitrate from playback selection. */
export function createBitrateIndependentDeviceProfile(profile: DeviceProfile): DeviceProfile {
    const clonedProfile = cloneDeviceProfile(profile);
    removeBitratePlaybackConstraints(clonedProfile);
    return clonedProfile;
}

/** Returns the video codecs with a route; a raw-plane codec counts once one of its raw routes is authorized, and a package codec once a package decodes it. */
function getSupportedVideoCodecs(
    capabilities: CustomDecodeCapabilities,
    rawRouteVideoCodecs: readonly CustomVideoCodec[] = [],
    allowNativeDolbyVision = false,
    allowNativeHDR = false,
    packageRouteVideoCodecs: readonly CustomVideoCodec[] = []
): CustomVideoCodec[] {
    const supportedCodecs: CustomVideoCodec[] = [];
    for (const codec of CUSTOM_VIDEO_CODECS) {
        const rangeExtensionSupported = codec === 'hevc'
            && Object.values(capabilities.hevcRangeExtensions ?? {}).some(capability => capability.status === 'supported');
        if (supportsNativeVideoCodec(codec, capabilities)
            || rangeExtensionSupported
            || (codec === 'hevc' && supportsNativeMain10HEVC(capabilities))
            || rawRouteVideoCodecs.includes(codec)
            || packageRouteVideoCodecs.includes(codec)
            || (allowNativeDolbyVision
                && codec === 'hevc'
                && capabilities.nativeDolbyVisionHEVC?.status === 'supported')
            || (allowNativeHDR
                && codec === 'hevc'
                && capabilities.nativeHDRHEVC?.status === 'supported')) {
            supportedCodecs.push(codec);
        }
    }
    return supportedCodecs;
}

function getSupportedAudioCodecs(
    capabilities: CustomDecodeCapabilities,
    nativeMediaAudioCapabilities: NativeMediaAudioCapabilities | null | undefined,
    packageAudioCodecs: readonly CustomAudioCodec[] = []
): CustomAudioCodec[] {
    const supportedCodecs: CustomAudioCodec[] = [];
    for (const codec of CUSTOM_AUDIO_CODECS) {
        const nativeMediaSupported = (codec === 'ac3' || codec === 'eac3')
            && nativeMediaAudioCapabilities?.audio[codec].status === 'supported';
        if (capabilities.audio[codec].status === 'supported' || nativeMediaSupported || packageAudioCodecs.includes(codec)) {
            supportedCodecs.push(codec);
        }
    }
    return supportedCodecs;
}

function getSupportedRawHDRVideoCodecs(capabilities: CustomDecodeCapabilities): CustomVideoCodec[] {
    const supportedCodecs: CustomVideoCodec[] = [];
    const rawHDRVideoCapabilities = capabilities.rawHDRVideo;

    for (const codec of CUSTOM_RAW_HDR_VIDEO_CODECS) {
        if (rawHDRVideoCapabilities[codec].status === 'supported') {
            supportedCodecs.push(codec);
        }
    }
    return supportedCodecs;
}

/** Returns the raw-plane codecs with an authorized raw route: HDR, Dolby Vision, or 10-bit SDR. */
function getRawRouteVideoCodecs(
    capabilities: CustomDecodeCapabilities,
    options: MeasuredVideoRouteOptions
): CustomVideoCodec[] {
    return CUSTOM_RAW_HDR_VIDEO_CODECS.filter((codec: CustomVideoCodec): boolean => (
        getRawMeasuredVideoRoutes(codec, capabilities, options).length > 0
    ));
}

function selectCompatibleCodecs<Codec extends CustomAudioCodec | CustomVideoCodec>(
    compatibleCodecs: readonly Codec[],
    supportedCodecs: ReadonlySet<Codec>
): Codec[] {
    const selectedCodecs: Codec[] = [];
    for (const codec of compatibleCodecs) {
        if (supportedCodecs.has(codec)) {
            selectedCodecs.push(codec);
        }
    }
    return selectedCodecs;
}

/** Returns one direct-play profile per container rule, with the rule's codecs the capabilities support, for every rule that keeps a video and an audio codec. */
export function createCompatibleProfiles(
    supportedVideoCodecs: readonly CustomVideoCodec[],
    supportedAudioCodecs: readonly CustomAudioCodec[]
): DirectPlayProfile[] {
    const profiles: DirectPlayProfile[] = [];
    const supportedVideoSet = new Set(supportedVideoCodecs);
    const supportedAudioSet = new Set(supportedAudioCodecs);

    for (const rule of CUSTOM_CONTAINER_CODEC_RULES) {
        const videoCodecs = selectCompatibleCodecs(rule.videoCodecs, supportedVideoSet);
        const audioCodecs = selectCompatibleCodecs(rule.audioCodecs, supportedAudioSet);
        if (videoCodecs.length === 0 || audioCodecs.length === 0) {
            continue;
        }
        profiles.push({
            AudioCodec: audioCodecs.join(','),
            Container: rule.profileContainers.join(','),
            Type: 'Video',
            VideoCodec: videoCodecs.join(',')
        });
    }

    return profiles;
}

function normalizeList(value: string | null | undefined): string {
    if (!value) {
        return '';
    }
    return value.split(',')
        .map(part => part.trim().toLowerCase())
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right))
        .join(',');
}

function getProfileKey(profile: DirectPlayProfile): string {
    return [
        profile.Type ?? '',
        normalizeList(profile.Container),
        normalizeList(profile.VideoCodec),
        normalizeList(profile.AudioCodec)
    ].join('|');
}

function createTelemetry(
    reason: CustomDeviceProfileReason,
    supportedVideoCodecs: readonly CustomVideoCodec[],
    supportedAudioCodecs: readonly CustomAudioCodec[],
    addedProfiles: readonly DirectPlayProfile[],
    widenedHDRCodecProfileCount: number,
    subtitleProfileChanged = false
): CustomDeviceProfileTelemetry {
    return {
        addedAudioProfileCount: addedProfiles.filter(profile => profile.Type === 'Audio').length,
        addedProfileCount: addedProfiles.length,
        addedVideoProfileCount: addedProfiles.filter(profile => profile.Type === 'Video').length,
        reason,
        supportedAudioCodecs: [ ...supportedAudioCodecs ],
        supportedVideoCodecs: [ ...supportedVideoCodecs ],
        subtitleProfileChanged,
        widenedHDRCodecProfileCount
    };
}

function getCodecTokens(value: string | null | undefined): string[] {
    if (!value) {
        return [];
    }

    const codecs: string[] = [];
    for (const codec of value.split(',')) {
        const normalizedCodec = codec.trim().toLowerCase();
        if (normalizedCodec) {
            codecs.push(normalizedCodec);
        }
    }
    return codecs;
}

type CustomContainerScope = {
    customContainers: string[]
    nonCustomContainerValue: string | null
};

function getUniqueTokens(tokens: readonly string[]): string[] {
    const uniqueTokens: string[] = [];
    for (const token of tokens) {
        if (!uniqueTokens.includes(token)) {
            uniqueTokens.push(token);
        }
    }
    return uniqueTokens;
}

function getCustomContainerScope(containerValue: string | null | undefined): CustomContainerScope {
    const normalizedValue = containerValue?.trim().toLowerCase() ?? '';
    if (!normalizedValue) {
        return {
            customContainers: [ ...CUSTOM_VIDEO_CONTAINERS ],
            nonCustomContainerValue: NON_CUSTOM_VIDEO_CONTAINER_VALUE
        };
    }

    if (normalizedValue.startsWith('-')) {
        const excludedContainers = getCodecTokens(normalizedValue.slice(1));
        return {
            customContainers: CUSTOM_VIDEO_CONTAINERS.filter(container => (
                !excludedContainers.includes(container)
            )),
            nonCustomContainerValue: `-${getUniqueTokens([
                ...excludedContainers,
                ...CUSTOM_VIDEO_CONTAINERS
            ]).join(',')}`
        };
    }

    const configuredContainers = getCodecTokens(normalizedValue);
    const nonCustomContainers = configuredContainers.filter(container => (
        !CUSTOM_VIDEO_CONTAINER_SET.has(container)
    ));
    return {
        customContainers: configuredContainers.filter(container => (
            CUSTOM_VIDEO_CONTAINER_SET.has(container)
        )),
        nonCustomContainerValue: nonCustomContainers.length > 0 ?
            nonCustomContainers.join(',') :
            null
    };
}

function hasNativeRuntimeConditions(conditions: readonly ProfileCondition[] | null | undefined): boolean {
    return conditions?.some(condition => NATIVE_VIDEO_RUNTIME_CONDITION_PROPERTIES.has(condition.Property ?? '')) === true;
}

function removeNativeRuntimeConditions(
    conditions: readonly ProfileCondition[] | null | undefined
): ProfileCondition[] | undefined {
    if (!conditions) {
        return undefined;
    }
    return conditions.filter(condition => !NATIVE_VIDEO_RUNTIME_CONDITION_PROPERTIES.has(condition.Property ?? ''));
}

/**
 * Returns whether a stock condition limits only the browser's own playback of the codec, which the custom path does not share:
 * a runtime ceiling, or a scan limit on a codec whose interlaced streams the engine deinterlaces.
 */
function isNativeOnlyVideoCondition(condition: ProfileCondition, codec: CustomVideoCodec): boolean {
    return NATIVE_VIDEO_RUNTIME_CONDITION_PROPERTIES.has(condition.Property ?? '')
        || (condition.Property === VIDEO_INTERLACED_PROPERTY && presentsInterlacedVideo(codec));
}

function hasNativeOnlyVideoConditions(codecProfile: CodecProfile, codec: CustomVideoCodec): boolean {
    return hasNativeRuntimeConditions(codecProfile.ApplyConditions)
        || codecProfile.Conditions?.some(condition => isNativeOnlyVideoCondition(condition, codec)) === true;
}

function getDeclaredDirectPlayVideoCodecs(profile: DeviceProfile): string[] {
    const codecs: string[] = [];
    for (const directPlayProfile of profile.DirectPlayProfiles ?? []) {
        if (directPlayProfile.Type !== 'Video') {
            continue;
        }
        for (const codec of getCodecTokens(directPlayProfile.VideoCodec)) {
            if (!codecs.includes(codec)) {
                codecs.push(codec);
            }
        }
    }
    return codecs;
}

function getSupportedProfileVideoCodecs(
    candidateCodecs: readonly string[],
    supportedVideoCodecs: readonly CustomVideoCodec[]
): CustomVideoCodec[] {
    const supportedProfileCodecs: CustomVideoCodec[] = [];
    for (const candidateCodec of candidateCodecs) {
        const supportedCodec = supportedVideoCodecs.find(codec => codec === candidateCodec);
        if (supportedCodec) {
            supportedProfileCodecs.push(supportedCodec);
        }
    }
    return supportedProfileCodecs;
}

function createRuntimeConditionProfile(
    codecProfile: CodecProfile,
    codec: CustomVideoCodec,
    containers: readonly string[]
): CodecProfile {
    const runtimeProfile: CodecProfile = {
        ...codecProfile,
        Codec: codec,
        Container: containers.join(',')
    };
    if (codecProfile.ApplyConditions) {
        runtimeProfile.ApplyConditions = removeNativeRuntimeConditions(codecProfile.ApplyConditions);
    }
    if (codecProfile.Conditions) {
        runtimeProfile.Conditions = codecProfile.Conditions.filter(condition => !isNativeOnlyVideoCondition(condition, codec));
    }
    return runtimeProfile;
}

function createSupportedCodecContainerProfiles(
    codecProfile: CodecProfile,
    codec: CustomVideoCodec,
    customContainers: readonly string[]
): CodecProfile[] {
    const profiles: CodecProfile[] = [];
    const routeContainerSet = new Set(getCustomContainersForVideoCodec(codec));
    const containerFamilySet = getCustomContainerFamilyForVideoCodec(codec);
    const runtimeContainers = customContainers.filter(container => (
        routeContainerSet.has(container)
    ));
    const preservedContainers = customContainers.filter(container => (
        !containerFamilySet.has(container)
    ));
    if (preservedContainers.length > 0) {
        profiles.push({
            ...codecProfile,
            Codec: codec,
            Container: preservedContainers.join(',')
        });
    }
    if (runtimeContainers.length > 0) {
        profiles.push(createRuntimeConditionProfile(
            codecProfile,
            codec,
            runtimeContainers
        ));
    }
    return profiles;
}

function createScopedVideoRuntimeProfiles(
    codecProfile: CodecProfile,
    supportedVideoCodecs: readonly CustomVideoCodec[],
    declaredVideoCodecs: readonly string[]
): CodecProfile[] | null {
    if (
        codecProfile.Type !== VIDEO_CODEC_PROFILE_TYPE
        || codecProfile.SubContainer
        || isAddedVideoRouteProfile(codecProfile)
    ) {
        return null;
    }

    const configuredCodecs = getCodecTokens(codecProfile.Codec);
    const candidateCodecs = configuredCodecs.length > 0 ?
        configuredCodecs :
        declaredVideoCodecs;
    const supportedProfileCodecs = getSupportedProfileVideoCodecs(
        candidateCodecs,
        supportedVideoCodecs
    );
    const containerScope = getCustomContainerScope(codecProfile.Container);
    if (
        containerScope.customContainers.length === 0
        || !supportedProfileCodecs.some(codec => hasNativeOnlyVideoConditions(codecProfile, codec))
    ) {
        return null;
    }

    const profiles: CodecProfile[] = [];
    if (containerScope.nonCustomContainerValue) {
        profiles.push({
            ...codecProfile,
            Container: containerScope.nonCustomContainerValue
        });
    }
    const supportedCodecSet = new Set<string>(supportedVideoCodecs);
    const unsupportedProfileCodecs = candidateCodecs.filter(codec => (
        !supportedCodecSet.has(codec)
    ));
    if (unsupportedProfileCodecs.length > 0) {
        profiles.push({
            ...codecProfile,
            Codec: unsupportedProfileCodecs.join(','),
            Container: containerScope.customContainers.join(',')
        });
    }
    for (const supportedProfileCodec of supportedProfileCodecs) {
        profiles.push(...createSupportedCodecContainerProfiles(
            codecProfile,
            supportedProfileCodec,
            containerScope.customContainers
        ));
    }
    return profiles;
}

/** Isolates browser-native source checks from cumulative HTML codec ceilings. */
function scopeOriginalVideoRuntimeConditions(
    profile: DeviceProfile,
    supportedVideoCodecs: readonly CustomVideoCodec[]
): void {
    if (!profile.CodecProfiles || supportedVideoCodecs.length === 0) {
        return;
    }

    const declaredVideoCodecs = getDeclaredDirectPlayVideoCodecs(profile);
    const scopedProfiles: CodecProfile[] = [];
    for (const codecProfile of profile.CodecProfiles) {
        const profileSplits = createScopedVideoRuntimeProfiles(
            codecProfile,
            supportedVideoCodecs,
            declaredVideoCodecs
        );
        scopedProfiles.push(...(profileSplits ?? [ codecProfile ]));
    }
    profile.CodecProfiles = scopedProfiles;
}

/** Removes container-level source ceilings only from custom WebGPU containers. */
function scopeOriginalContainerRuntimeConditions(profile: DeviceProfile): void {
    if (!profile.ContainerProfiles) {
        return;
    }

    const scopedProfiles: ContainerProfile[] = [];
    for (const containerProfile of profile.ContainerProfiles) {
        if (
            containerProfile.Type !== 'Video'
            || containerProfile.SubContainer
            || !hasNativeRuntimeConditions(containerProfile.Conditions)
        ) {
            scopedProfiles.push(containerProfile);
            continue;
        }

        const containerScope = getCustomContainerScope(containerProfile.Container);
        if (containerScope.customContainers.length === 0) {
            scopedProfiles.push(containerProfile);
            continue;
        }
        if (containerScope.nonCustomContainerValue) {
            scopedProfiles.push({
                ...containerProfile,
                Container: containerScope.nonCustomContainerValue
            });
        }
        scopedProfiles.push({
            ...containerProfile,
            Conditions: removeNativeRuntimeConditions(containerProfile.Conditions),
            Container: containerScope.customContainers.join(',')
        });
    }
    profile.ContainerProfiles = scopedProfiles;
}

function getRawHDRVideoRangeTypeValue(
    includeSDR: boolean,
    rawHDRVideoRangeTypes: readonly string[]
): string {
    const rangeTypes: string[] = [];
    if (includeSDR) {
        rangeTypes.push('SDR');
    }
    rangeTypes.push(...rawHDRVideoRangeTypes);
    return rangeTypes.join('|');
}

function parseFiniteNumber(value: string | null | undefined): number | null {
    if (typeof value !== 'string' || !value.trim()) {
        return null;
    }
    const parsedValue = Number(value);
    return Number.isFinite(parsedValue) ? parsedValue : null;
}

function bitDepthConditionAllowsTenBit(condition: ProfileCondition): boolean {
    if (condition.Property !== VIDEO_BIT_DEPTH_PROPERTY) {
        return true;
    }

    switch (condition.Condition) {
        case 'Equals':
            return parseFiniteNumber(condition.Value) === MAXIMUM_RAW_HDR_VIDEO_BIT_DEPTH;
        case 'NotEquals':
            return parseFiniteNumber(condition.Value) !== MAXIMUM_RAW_HDR_VIDEO_BIT_DEPTH;
        case LESS_THAN_EQUAL_CONDITION: {
            const maximumBitDepth = parseFiniteNumber(condition.Value);
            return maximumBitDepth !== null
                && MAXIMUM_RAW_HDR_VIDEO_BIT_DEPTH <= maximumBitDepth;
        }
        case 'GreaterThanEqual': {
            const minimumBitDepth = parseFiniteNumber(condition.Value);
            return minimumBitDepth !== null
                && MAXIMUM_RAW_HDR_VIDEO_BIT_DEPTH >= minimumBitDepth;
        }
        case EQUALS_ANY_CONDITION:
            return condition.Value?.split('|').some(value => (
                parseFiniteNumber(value) === MAXIMUM_RAW_HDR_VIDEO_BIT_DEPTH
            )) === true;
        default:
            return false;
    }
}

function bitDepthConditionCapsAtTenBit(condition: ProfileCondition): boolean {
    if (condition.Property !== VIDEO_BIT_DEPTH_PROPERTY) {
        return false;
    }

    switch (condition.Condition) {
        case 'Equals': {
            const bitDepth = parseFiniteNumber(condition.Value);
            return bitDepth !== null && bitDepth <= MAXIMUM_RAW_HDR_VIDEO_BIT_DEPTH;
        }
        case LESS_THAN_EQUAL_CONDITION: {
            const maximumBitDepth = parseFiniteNumber(condition.Value);
            return maximumBitDepth !== null
                && maximumBitDepth <= MAXIMUM_RAW_HDR_VIDEO_BIT_DEPTH;
        }
        case EQUALS_ANY_CONDITION: {
            const bitDepths = condition.Value?.split('|').map(parseFiniteNumber) ?? [];
            return bitDepths.length > 0 && bitDepths.every(bitDepth => (
                bitDepth !== null && bitDepth <= MAXIMUM_RAW_HDR_VIDEO_BIT_DEPTH
            ));
        }
        default:
            return false;
    }
}

function getAuthorizedHDRVideoProfiles(
    rawHDRCodecs: readonly string[],
    includeSDR: boolean
): string[] {
    const profiles: string[] = [];
    for (const codec of rawHDRCodecs) {
        let nativeProfiles: readonly string[] = [];
        let codecProfiles: readonly string[] = [];
        switch (codec) {
            case 'av1':
                nativeProfiles = NATIVE_VIDEO_PROFILES.av1;
                codecProfiles = RAW_VIDEO_PROFILES.av1;
                break;
            case 'hevc':
                nativeProfiles = NATIVE_VIDEO_PROFILES.hevc;
                codecProfiles = RAW_VIDEO_PROFILES.hevc;
                break;
            case 'vp9':
                nativeProfiles = NATIVE_VIDEO_PROFILES.vp9;
                codecProfiles = RAW_VIDEO_PROFILES.vp9;
                break;
            default:
                continue;
        }
        const authorizedProfiles = includeSDR ?
            [ ...nativeProfiles, ...codecProfiles ] :
            codecProfiles;
        for (const codecProfile of authorizedProfiles) {
            if (!profiles.includes(codecProfile)) {
                profiles.push(codecProfile);
            }
        }
    }
    return profiles;
}

function createRawHDRConditions(
    conditions: NonNullable<CodecProfile['Conditions']>,
    includeSDR: boolean,
    rawHDRCodecs: readonly CustomVideoCodec[],
    rawHDRVideoRangeTypes: readonly string[],
    codecProfilePlan: AuthorizedCodecProfilePlan | null = null
): NonNullable<CodecProfile['Conditions']> | null {
    if (codecProfilePlan === null
        && conditions.some(condition => !bitDepthConditionAllowsTenBit(condition))) {
        return null;
    }
    const videoRangeConditions = conditions.filter(condition => (
        condition.Property === VIDEO_RANGE_TYPE_PROPERTY
    ));
    if (videoRangeConditions.some(condition => condition.Condition !== EQUALS_ANY_CONDITION)) {
        return null;
    }
    const videoRangeTypeValue = codecProfilePlan?.rangeTypes.join('|')
        ?? getRawHDRVideoRangeTypeValue(includeSDR, rawHDRVideoRangeTypes);

    // A codec the engine deinterlaces takes interlaced streams; the measured routes still refuse them on Dolby Vision labels
    const presentsInterlaced = rawHDRCodecs.every(presentsInterlacedVideo);
    const applicableConditions = conditions.filter(condition => (
        condition.Property !== VIDEO_PROFILE_PROPERTY
        && !NATIVE_VIDEO_RUNTIME_CONDITION_PROPERTIES.has(condition.Property ?? '')
        && !(presentsInterlaced && condition.Property === VIDEO_INTERLACED_PROPERTY)
    ));
    const widenedConditions = applicableConditions.map(condition => {
        if (condition.Condition === EQUALS_ANY_CONDITION
            && condition.Property === VIDEO_RANGE_TYPE_PROPERTY) {
            return {
                ...condition,
                IsRequired: codecProfilePlan === null ? condition.IsRequired : true,
                Value: videoRangeTypeValue
            };
        }

        return condition;
    });
    const hasVideoRangeCondition = conditions.some(condition => (
        condition.Property === VIDEO_RANGE_TYPE_PROPERTY
    ));
    if (!hasVideoRangeCondition) {
        widenedConditions.push({
            Condition: EQUALS_ANY_CONDITION,
            IsRequired: true,
            Property: VIDEO_RANGE_TYPE_PROPERTY,
            Value: videoRangeTypeValue
        });
    }
    const maximumBitDepth = codecProfilePlan === null ?
        MAXIMUM_RAW_HDR_VIDEO_BIT_DEPTH :
        Math.max(...codecProfilePlan.bitDepths);
    if (codecProfilePlan !== null) {
        for (let conditionIndex = widenedConditions.length - 1; conditionIndex >= 0; conditionIndex -= 1) {
            if (widenedConditions[conditionIndex].Property === VIDEO_BIT_DEPTH_PROPERTY) {
                widenedConditions.splice(conditionIndex, 1);
            }
        }
    }
    if (codecProfilePlan !== null || !conditions.some(bitDepthConditionCapsAtTenBit)) {
        widenedConditions.push({
            Condition: LESS_THAN_EQUAL_CONDITION,
            IsRequired: true,
            Property: VIDEO_BIT_DEPTH_PROPERTY,
            Value: String(maximumBitDepth)
        });
    }
    const authorizedVideoProfiles = codecProfilePlan?.profiles
        ?? getAuthorizedHDRVideoProfiles(rawHDRCodecs, includeSDR);
    if (authorizedVideoProfiles.length > 0) {
        widenedConditions.push({
            Condition: EQUALS_ANY_CONDITION,
            IsRequired: true,
            Property: VIDEO_PROFILE_PROPERTY,
            Value: authorizedVideoProfiles.join('|')
        });
    }
    if (!presentsInterlaced && !widenedConditions.some(isProgressiveScanCondition)) {
        widenedConditions.push(createProgressiveScanCondition());
    }
    return widenedConditions;
}

function createProgressiveScanCondition(): ProfileCondition {
    return {
        Condition: EQUALS_CONDITION,
        IsRequired: true,
        Property: VIDEO_INTERLACED_PROPERTY,
        Value: 'false'
    };
}

function isProgressiveScanCondition(condition: ProfileCondition): boolean {
    return condition.IsRequired === true
        && condition.Property === VIDEO_INTERLACED_PROPERTY
        && condition.Condition === EQUALS_CONDITION
        && condition.Value === 'false';
}

/**
 * Returns whether a route takes only progressive streams: its codec codes interlaced fields apart, or it presents a Dolby Vision label,
 * whose routes never deinterlace.
 */
function requiresProgressiveScan(route: MeasuredVideoRoute): boolean {
    return !presentsInterlacedVideo(route.codec)
        || route.rangeTypes.some(rangeType => DOLBY_VISION_RANGE_TYPE_SET.has(rangeType));
}

type RawHDRCodecProfilePlan = {
    profiles: CodecProfile[]
};

type RawHDRCodecRoutePlan = {
    profiles: CodecProfile[]
    widened: boolean
};

/**
 * Returns whether the add-on built the codec profile, as a measured route or a widened stock profile, so another augmentation leaves it alone.
 * Each requires VideoRangeType or a progressive scan, which Jellyfin Web's own profiles never require.
 */
function isAddedVideoRouteProfile(codecProfile: CodecProfile): boolean {
    return codecProfile.Conditions?.some(condition => (
        (condition.IsRequired === true && condition.Property === VIDEO_RANGE_TYPE_PROPERTY)
        || isProgressiveScanCondition(condition)
    )) === true;
}

function hasRawHDRCapabilities(
    rawHDRCodecs: readonly string[],
    capabilities: CustomDecodeCapabilities
): boolean {
    for (const rawHDRCodec of rawHDRCodecs) {
        const capability = capabilities.rawHDRVideo[
            rawHDRCodec as 'av1' | 'hevc' | 'vp9'
        ];
        if (capability.status !== 'supported') {
            return false;
        }
    }
    return rawHDRCodecs.length > 0;
}

function hasNativeDolbyVisionCapability(
    capabilities: CustomDecodeCapabilities,
    enabled: boolean
): boolean {
    return enabled && capabilities.nativeDolbyVisionHEVC?.status === 'supported';
}

function hasNativeHDRCapability(
    capabilities: CustomDecodeCapabilities,
    enabled: boolean
): boolean {
    return enabled && capabilities.nativeHDRHEVC?.status === 'supported';
}

function createRawHDRCodecProfilePlan(
    codecProfile: CodecProfile,
    supportedRawHDRCodecs: ReadonlySet<CustomVideoCodec>,
    supportedNativeVideoCodecs: ReadonlySet<CustomVideoCodec>,
    rawHDRVideoRangeTypes: readonly string[],
    codecProfilePlans: ReadonlyMap<CustomVideoCodec, AuthorizedCodecProfilePlan>
): RawHDRCodecProfilePlan | null {
    if (
        codecProfile.Type !== VIDEO_CODEC_PROFILE_TYPE
        || codecProfile.SubContainer
        || isAddedVideoRouteProfile(codecProfile)
    ) {
        return null;
    }

    const codecs = getCodecTokens(codecProfile.Codec);
    const rawHDRCodecs = codecs.filter(codec => (
        supportedRawHDRCodecs.has(codec as CustomVideoCodec)
    ));
    if (rawHDRCodecs.length === 0) {
        return null;
    }

    const profiles: CodecProfile[] = [];
    const nonRawHDRCodecs = codecs.filter(codec => !rawHDRCodecs.includes(codec));
    if (nonRawHDRCodecs.length > 0) {
        profiles.push({
            ...codecProfile,
            Codec: nonRawHDRCodecs.join(',')
        });
    }

    const containerScope = getCustomContainerScope(codecProfile.Container);
    let widened = false;
    for (const rawHDRCodec of rawHDRCodecs) {
        const routePlan = createRawHDRCodecRoutePlan(
            codecProfile,
            rawHDRCodec as CustomVideoCodec,
            containerScope,
            supportedNativeVideoCodecs,
            rawHDRVideoRangeTypes,
            codecProfilePlans.get(rawHDRCodec as CustomVideoCodec) ?? null
        );
        profiles.push(...routePlan.profiles);
        widened ||= routePlan.widened;
    }
    return widened ? { profiles } : null;
}

function haveProfileConditionsChanged(
    conditions: readonly ProfileCondition[],
    widenedConditions: readonly ProfileCondition[]
): boolean {
    return widenedConditions.length !== conditions.length
        || conditions.some((condition, conditionIndex) => {
            const widenedCondition = widenedConditions[conditionIndex];
            return !widenedCondition
                || condition.Condition !== widenedCondition.Condition
                || condition.IsRequired !== widenedCondition.IsRequired
                || condition.Property !== widenedCondition.Property
                || condition.Value !== widenedCondition.Value;
        });
}

function createRawHDRCodecRoutePlan(
    codecProfile: CodecProfile,
    codec: CustomVideoCodec,
    containerScope: CustomContainerScope,
    supportedNativeVideoCodecs: ReadonlySet<CustomVideoCodec>,
    rawHDRVideoRangeTypes: readonly string[],
    codecProfilePlan: AuthorizedCodecProfilePlan | null
): RawHDRCodecRoutePlan {
    const conditions = codecProfile.Conditions ?? [];
    const widenedConditions = createRawHDRConditions(
        conditions,
        supportedNativeVideoCodecs.has(codec),
        [ codec ],
        rawHDRVideoRangeTypes,
        codecProfilePlan
    );
    const routeContainerSet = new Set(getCustomContainersForVideoCodec(codec));
    const customContainers = containerScope.customContainers.filter(container => (
        routeContainerSet.has(container)
    ));
    if (
        !widenedConditions
        || customContainers.length === 0
        || !haveProfileConditionsChanged(conditions, widenedConditions)
    ) {
        return {
            profiles: [ {
                ...codecProfile,
                Codec: codec
            } ],
            widened: false
        };
    }

    const profiles: CodecProfile[] = [];
    if (containerScope.nonCustomContainerValue) {
        profiles.push({
            ...codecProfile,
            Codec: codec,
            Container: containerScope.nonCustomContainerValue
        });
    }
    const containerFamilySet = getCustomContainerFamilyForVideoCodec(codec);
    const preservedCustomContainers = containerScope.customContainers.filter(container => (
        !containerFamilySet.has(container)
    ));
    if (preservedCustomContainers.length > 0) {
        profiles.push({
            ...codecProfile,
            Codec: codec,
            Container: preservedCustomContainers.join(',')
        });
    }
    profiles.push({
        ...codecProfile,
        Codec: codec,
        Conditions: widenedConditions,
        Container: customContainers.join(',')
    });
    return { profiles, widened: true };
}

/** Widens the stock profiles of the given codecs: a codec with a plan takes it, the others the shared raw ranges. */
function widenRawHDRCodecProfiles(
    profile: DeviceProfile,
    supportedRawHDRVideoCodecs: readonly CustomVideoCodec[],
    supportedNativeVideoCodecs: readonly CustomVideoCodec[],
    rawHDRVideoRangeTypes: readonly string[],
    codecProfilePlans: ReadonlyMap<CustomVideoCodec, AuthorizedCodecProfilePlan> = new Map()
): number {
    const supportedRawHDRCodecs = new Set<CustomVideoCodec>(supportedRawHDRVideoCodecs);
    const supportedNativeCodecs = new Set<CustomVideoCodec>(supportedNativeVideoCodecs);
    if (supportedRawHDRCodecs.size === 0 || !profile.CodecProfiles) {
        return 0;
    }

    const widenedProfiles: CodecProfile[] = [];
    let widenedProfileCount = 0;
    for (const codecProfile of profile.CodecProfiles) {
        const plan = createRawHDRCodecProfilePlan(
            codecProfile,
            supportedRawHDRCodecs,
            supportedNativeCodecs,
            rawHDRVideoRangeTypes,
            codecProfilePlans
        );
        if (!plan) {
            widenedProfiles.push(codecProfile);
            continue;
        }

        widenedProfiles.push(...plan.profiles);
        widenedProfileCount += 1;
    }

    profile.CodecProfiles = widenedProfiles;
    return widenedProfileCount;
}

/**
 * Returns a codec's route containers plus the aliases the server's probe string carries for them.
 * An MP4 file probes as `mov,mp4,m4a,3gp,3g2,mj2` and a server profile matches any single token, so a stock profile scoped to an alias such as `mj2` would also constrain every MP4 file the route plays.
 */
function getCustomContainerFamilyForVideoCodec(codec: CustomVideoCodec): Set<string> {
    const containerFamily = new Set<string>();
    const addRuleContainers = (rule: (typeof CUSTOM_CONTAINER_CODEC_RULES)[number]): void => {
        for (const container of [ ...rule.profileContainers, ...rule.containerAliases ]) {
            containerFamily.add(container);
        }
    };
    for (const rule of CUSTOM_CONTAINER_CODEC_RULES) {
        if (rule.videoCodecs.includes(codec)) {
            addRuleContainers(rule);
        }
    }
    // A rule sharing any token shares the probe string too: JPEG 2000 MOV/MJ2 files probe like MP4
    let familyGrew = true;
    while (familyGrew) {
        const familySize = containerFamily.size;
        for (const rule of CUSTOM_CONTAINER_CODEC_RULES) {
            if ([ ...rule.profileContainers, ...rule.containerAliases ].some(container => (
                containerFamily.has(container)
            ))) {
                addRuleContainers(rule);
            }
        }
        familyGrew = containerFamily.size !== familySize;
    }
    return containerFamily;
}

function getCustomContainersForVideoCodec(codec: CustomVideoCodec): string[] {
    const containers: string[] = [];
    const containerSet = new Set<string>();
    for (const rule of CUSTOM_CONTAINER_CODEC_RULES) {
        if (!rule.videoCodecs.includes(codec)) {
            continue;
        }
        for (const container of rule.profileContainers) {
            if (!containerSet.has(container)) {
                containerSet.add(container);
                containers.push(container);
            }
        }
    }
    return containers;
}

function createMeasuredRouteConditions(route: MeasuredVideoRoute): NonNullable<CodecProfile['Conditions']> {
    const conditions: NonNullable<CodecProfile['Conditions']> = [];
    conditions.push({
        Condition: EQUALS_ANY_CONDITION,
        IsRequired: true,
        Property: VIDEO_RANGE_TYPE_PROPERTY,
        Value: route.rangeTypes.join('|')
    });
    conditions.push({
        Condition: route.bitDepths.length === 1 ? 'Equals' : EQUALS_ANY_CONDITION,
        IsRequired: true,
        Property: VIDEO_BIT_DEPTH_PROPERTY,
        Value: route.bitDepths.join('|')
    });
    if (requiresProgressiveScan(route)) {
        conditions.push(createProgressiveScanCondition());
    }
    if (route.profiles.length > 0) {
        conditions.push({
            Condition: EQUALS_ANY_CONDITION,
            IsRequired: true,
            Property: VIDEO_PROFILE_PROPERTY,
            Value: route.profiles.join('|')
        });
    }
    return conditions;
}

function createMeasuredRouteApplyConditions(route: MeasuredVideoRoute): NonNullable<CodecProfile['ApplyConditions']> {
    return createMeasuredRouteConditions(route).filter(condition => (
        condition.Property !== VIDEO_INTERLACED_PROPERTY
        && (
            condition.Property !== VIDEO_BIT_DEPTH_PROPERTY
            || route.profiles.length === 0
        )
    ));
}

function createHEVCSDRMeasuredVideoRoutes(capabilities: CustomDecodeCapabilities): MeasuredVideoRoute[] {
    const routes: MeasuredVideoRoute[] = [];
    if (supportsNativeVideoCodec('hevc', capabilities)) {
        routes.push({
            bitDepths: [ CUSTOM_NATIVE_VIDEO_BIT_DEPTH ],
            codec: 'hevc',
            profiles: getNativeVideoProfiles('hevc', capabilities),
            rangeTypes: [ 'SDR' ]
        });
    }
    const nativeMain10Capability = capabilities.nativeHDRHEVC;
    if (nativeMain10Capability?.status === 'supported') {
        routes.push({
            bitDepths: [ nativeMain10Capability.bitDepth ],
            codec: 'hevc',
            profiles: RAW_VIDEO_PROFILES.hevc,
            rangeTypes: [ 'SDR' ]
        });
    }
    return routes;
}

function createNativeMeasuredVideoRoute(
    codec: CustomVideoCodec,
    capabilities: CustomDecodeCapabilities
): MeasuredVideoRoute | null {
    if (!supportsNativeVideoCodec(codec, capabilities)) {
        return null;
    }

    return {
        bitDepths: [ CUSTOM_NATIVE_VIDEO_BIT_DEPTH ],
        codec,
        profiles: getNativeVideoProfiles(codec, capabilities),
        rangeTypes: [ 'SDR' ]
    };
}

function createRawHDRMeasuredVideoRoute(
    codec: CustomVideoCodec,
    capabilities: CustomDecodeCapabilities,
    rawHDRVideoRangeTypes: readonly string[]
): MeasuredVideoRoute | null {
    if (rawHDRVideoRangeTypes.length === 0
        || (codec !== 'hevc' && codec !== 'vp9' && codec !== 'av1')) {
        return null;
    }

    const rawCapability = capabilities.rawHDRVideo[codec];
    if (rawCapability.status !== 'supported') {
        return null;
    }
    return {
        bitDepths: [ rawCapability.bitDepth ],
        codec,
        profiles: RAW_VIDEO_PROFILES[codec],
        rangeTypes: rawHDRVideoRangeTypes
    };
}

/** Returns the ranges of a codec's raw HDR route: the static ranges with HDR10+, then HEVC's Dolby Vision ranges or AV1 Profile 10's. */
function getRawVideoRangeTypes(
    codec: CustomVideoCodec,
    options: MeasuredVideoRouteOptions
): readonly string[] {
    switch (codec) {
        case 'hevc':
            return [ ...new Set([
                ...options.rawHDRRouteVideoRangeTypes,
                ...options.rawDolbyVisionVideoRangeTypes
            ]) ];
        case 'av1':
            return [ ...new Set([
                ...options.rawHDRRouteVideoRangeTypes,
                ...options.rawAV1DolbyVisionVideoRangeTypes
            ]) ];
        default:
            return options.rawHDRRouteVideoRangeTypes;
    }
}

/**
 * Returns a codec's raw 10-bit SDR route: AV1 Main, VP9 Profile 2, and HEVC Main 10 without native decode.
 * A profile condition cannot express color range, so both BT.709 keys must pass.
 */
function createRawSDRMeasuredVideoRoute(
    codec: CustomVideoCodec,
    capabilities: CustomDecodeCapabilities,
    routeKeys: readonly RawHDRAuthorizationRouteKey[]
): MeasuredVideoRoute | null {
    if (codec !== 'hevc' && codec !== 'vp9' && codec !== 'av1') {
        return null;
    }
    const rawCapability = capabilities.rawHDRVideo[codec];
    if (
        !hasRawHDRCapabilities([ codec ], capabilities)
        || !isRawFormatPresentationAuthorized(rawCapability.format, 'sdr', routeKeys)
    ) {
        return null;
    }
    return {
        bitDepths: [ rawCapability.bitDepth ],
        codec,
        profiles: RAW_VIDEO_PROFILES[codec],
        rangeTypes: [ 'SDR' ]
    };
}

/** Returns a codec's raw-plane routes: HDR with Dolby Vision, then 10-bit SDR. */
function getRawMeasuredVideoRoutes(
    codec: CustomVideoCodec,
    capabilities: CustomDecodeCapabilities,
    options: MeasuredVideoRouteOptions
): MeasuredVideoRoute[] {
    const routes: MeasuredVideoRoute[] = [];
    const rawRoute = createRawHDRMeasuredVideoRoute(
        codec,
        capabilities,
        getRawVideoRangeTypes(codec, options)
    );
    if (rawRoute) {
        routes.push(rawRoute);
    }
    const rawSDRRoute = createRawSDRMeasuredVideoRoute(
        codec,
        capabilities,
        options.rawAuthorizationRouteKeys
    );
    if (rawSDRRoute) {
        routes.push(rawSDRRoute);
    }
    return routes;
}

function createDolbyVisionMeasuredVideoRoute(
    codec: CustomVideoCodec,
    capabilities: CustomDecodeCapabilities,
    dolbyVisionVideoRangeTypes: readonly string[],
    enabled: boolean
): MeasuredVideoRoute | null {
    const capability = capabilities.nativeDolbyVisionHEVC;
    if (
        codec !== 'hevc'
        || !enabled
        || dolbyVisionVideoRangeTypes.length === 0
        || capability?.status !== 'supported'
    ) {
        return null;
    }
    return {
        bitDepths: [ capability.bitDepth ],
        codec,
        profiles: RAW_VIDEO_PROFILES.hevc,
        rangeTypes: dolbyVisionVideoRangeTypes
    };
}

function createNativeHDRMeasuredVideoRoute(
    codec: CustomVideoCodec,
    capabilities: CustomDecodeCapabilities,
    nativeHDRVideoRangeTypes: readonly string[],
    enabled: boolean
): MeasuredVideoRoute | null {
    const capability = capabilities.nativeHDRHEVC;
    if (
        codec !== 'hevc'
        || !enabled
        || nativeHDRVideoRangeTypes.length === 0
        || capability?.status !== 'supported'
    ) {
        return null;
    }
    return {
        bitDepths: [ capability.bitDepth ],
        codec,
        profiles: RAW_VIDEO_PROFILES.hevc,
        rangeTypes: nativeHDRVideoRangeTypes
    };
}

function getMeasuredVideoRoutes(
    codec: CustomVideoCodec,
    capabilities: CustomDecodeCapabilities,
    options: MeasuredVideoRouteOptions
): MeasuredVideoRoute[] {
    const routes: MeasuredVideoRoute[] = [];
    if (codec === 'hevc') {
        routes.push(...createHEVCSDRMeasuredVideoRoutes(capabilities));
    } else {
        const nativeRoute = createNativeMeasuredVideoRoute(codec, capabilities);
        if (nativeRoute) {
            routes.push(nativeRoute);
        }
    }
    routes.push(...getRawMeasuredVideoRoutes(codec, capabilities, options));
    const nativeHDRRoute = createNativeHDRMeasuredVideoRoute(
        codec,
        capabilities,
        options.nativeHDRVideoRangeTypes,
        options.allowNativeHDR
    );
    if (nativeHDRRoute) {
        routes.push(nativeHDRRoute);
    }
    const dolbyVisionRoute = createDolbyVisionMeasuredVideoRoute(
        codec,
        capabilities,
        options.nativeDolbyVisionVideoRangeTypes,
        options.allowNativeDolbyVision
    );
    if (dolbyVisionRoute) {
        routes.push(dolbyVisionRoute);
    }
    if (codec === 'hevc') {
        routes.push(...createHEVCRangeExtensionMeasuredVideoRoutes(
            capabilities,
            options.rawAuthorizationRouteKeys
        ));
    }
    if (options.dolbyVisionItemVideoRoute?.codec === codec) {
        routes.push(options.dolbyVisionItemVideoRoute);
    }
    routes.push(...getCodecPackageVideoRoutes(codec, options));
    return routes;
}

function getCodecPackageVideoRoutes(codec: CustomVideoCodec, options: MeasuredVideoRouteOptions): MeasuredVideoRoute[] {
    return options.packageVideoRoutes.filter((route: MeasuredVideoRoute): boolean => route.codec === codec);
}

function appendUniqueValues<Value>(target: Value[], values: readonly Value[]): void {
    for (const value of values) {
        if (!target.includes(value)) {
            target.push(value);
        }
    }
}

function isAuthorizedRouteBitDepth(bitDepth: number): boolean {
    return bitDepth > UNSUPPORTED_ROUTE_BIT_DEPTH;
}

function hasAuthorizedRouteBitDepth(route: MeasuredVideoRoute): boolean {
    return route.bitDepths.some(isAuthorizedRouteBitDepth);
}

/** Creates one exact profile/range route; no authorized depth makes it a rejection rule. */
function createExactMeasuredVideoRoute(
    codec: CustomVideoCodec,
    profile: string,
    rangeType: string,
    bitDepths: readonly number[]
): MeasuredVideoRoute {
    return {
        bitDepths: bitDepths.length > 0 ? bitDepths : [ UNSUPPORTED_ROUTE_BIT_DEPTH ],
        codec,
        profiles: [ profile ],
        rangeTypes: [ rangeType ]
    };
}

function getMeasuredRouteBitDepths(
    routes: readonly MeasuredVideoRoute[],
    profile: string,
    rangeType: string
): number[] {
    const bitDepths: number[] = [];
    for (const route of routes) {
        if (route.profiles.includes(profile) && route.rangeTypes.includes(rangeType)) {
            appendUniqueValues(bitDepths, route.bitDepths.filter(isAuthorizedRouteBitDepth));
        }
    }
    return bitDepths;
}

/**
 * Splits a codec's routes into exact profile/range pairs with their unioned depths, so each stream matches one route and one route cannot widen or narrow another.
 */
function normalizeMeasuredVideoRoutes(
    codec: CustomVideoCodec,
    routes: readonly MeasuredVideoRoute[]
): MeasuredVideoRoute[] {
    const profiles: string[] = [];
    for (const route of routes) {
        appendUniqueValues(profiles, route.profiles);
    }

    const normalizedRoutes: MeasuredVideoRoute[] = [];
    for (const profile of profiles) {
        for (const rangeType of JELLYFIN_VIDEO_RANGE_TYPES) {
            normalizedRoutes.push(createExactMeasuredVideoRoute(
                codec,
                profile,
                rangeType,
                getMeasuredRouteBitDepths(routes, profile, rangeType)
            ));
        }
    }
    return normalizedRoutes;
}

/**
 * Returns whether a codec's routes split into exact pairs.
 * Several routes scope their conditions with ApplyConditions, so pairs that share a profile must merge, and a pair no route claims must reject.
 * Native 8-bit and raw 10-bit AV1 SDR, for example, share the Main profile.
 * HEVC splits whenever range-extension evidence exists, or a decoder package decodes it.
 */
function isNormalizedMeasuredVideoCodec(
    codec: CustomVideoCodec,
    capabilities: CustomDecodeCapabilities,
    routes: readonly MeasuredVideoRoute[],
    packageRouted: boolean
): boolean {
    return codec === 'hevc' ?
        capabilities.hevcRangeExtensions !== undefined || packageRouted :
        routes.length > 1;
}

function getCodecProfileKey(profile: CodecProfile): string {
    return JSON.stringify({
        ApplyConditions: profile.ApplyConditions ?? [],
        Codec: normalizeList(profile.Codec),
        Conditions: profile.Conditions ?? [],
        Container: normalizeList(profile.Container),
        Type: profile.Type
    });
}

function getCodecMeasuredVideoRoutes(
    codec: CustomVideoCodec,
    capabilities: CustomDecodeCapabilities,
    options: MeasuredVideoRouteOptions
): MeasuredVideoRoute[] {
    const measuredRoutes = getMeasuredVideoRoutes(codec, capabilities, options);
    const packageRouted = getCodecPackageVideoRoutes(codec, options).length > 0;
    return isNormalizedMeasuredVideoCodec(codec, capabilities, measuredRoutes, packageRouted) ?
        normalizeMeasuredVideoRoutes(codec, measuredRoutes) :
        measuredRoutes;
}

/** Returns the stock-profile ceiling of a codec's routes: every authorized profile, range, and depth. */
function createMeasuredRouteProfilePlan(routes: readonly MeasuredVideoRoute[]): AuthorizedCodecProfilePlan | null {
    const bitDepths: number[] = [];
    const profiles: string[] = [];
    const rangeTypes: string[] = [];
    for (const route of routes) {
        if (!hasAuthorizedRouteBitDepth(route)) {
            continue;
        }
        appendUniqueValues(bitDepths, route.bitDepths.filter(isAuthorizedRouteBitDepth));
        appendUniqueValues(profiles, route.profiles);
        appendUniqueValues(rangeTypes, route.rangeTypes);
    }
    if (bitDepths.length === 0 || profiles.length === 0 || rangeTypes.length === 0) {
        return null;
    }
    return { bitDepths, profiles, rangeTypes: orderSDRRangeTypeFirst(rangeTypes) };
}

/**
 * Returns the stock-profile ceilings of the raw codecs other than HEVC.
 * A codec needs one only for a raw route, its item's own route, or a decoder package's route, which the stock ranges and profiles may reject.
 * Its exact routes keep each pair at its own depths.
 */
function createRawCodecProfilePlans(
    capabilities: CustomDecodeCapabilities,
    options: MeasuredVideoRouteOptions
): Map<CustomVideoCodec, AuthorizedCodecProfilePlan> {
    const plans = new Map<CustomVideoCodec, AuthorizedCodecProfilePlan>();
    for (const codec of CUSTOM_RAW_HDR_VIDEO_CODECS) {
        if (
            codec === 'hevc'
            || (getRawMeasuredVideoRoutes(codec, capabilities, options).length === 0
                && options.dolbyVisionItemVideoRoute?.codec !== codec
                && getCodecPackageVideoRoutes(codec, options).length === 0)
        ) {
            continue;
        }
        const plan = createMeasuredRouteProfilePlan(getMeasuredVideoRoutes(codec, capabilities, options));
        if (plan) {
            plans.set(codec, plan);
        }
    }
    return plans;
}

/** A single route needs no ApplyConditions; several routes each scope their own conditions. */
function createMeasuredVideoRouteCodecProfiles(
    codec: CustomVideoCodec,
    routes: readonly MeasuredVideoRoute[]
): CodecProfile[] {
    const container = getCustomContainersForVideoCodec(codec).join(',');
    if (routes.length === 1) {
        return [ {
            Codec: codec,
            Conditions: createMeasuredRouteConditions(routes[0]),
            Container: container,
            Type: VIDEO_CODEC_PROFILE_TYPE
        } ];
    }
    return routes.map((route: MeasuredVideoRoute): CodecProfile => ({
        ApplyConditions: createMeasuredRouteApplyConditions(route),
        Codec: codec,
        Conditions: createMeasuredRouteConditions(route),
        Container: container,
        Type: VIDEO_CODEC_PROFILE_TYPE
    }));
}

function appendMeasuredVideoRouteProfiles(
    profile: DeviceProfile,
    capabilities: CustomDecodeCapabilities,
    supportedVideoCodecs: readonly CustomVideoCodec[],
    options: MeasuredVideoRouteOptions
): void {
    const codecProfiles = profile.CodecProfiles ?? [];
    profile.CodecProfiles = codecProfiles;
    const existingProfileKeys = new Set(codecProfiles.map(getCodecProfileKey));
    for (const codec of supportedVideoCodecs) {
        const measuredProfiles = createMeasuredVideoRouteCodecProfiles(
            codec,
            getCodecMeasuredVideoRoutes(codec, capabilities, options)
        );
        for (const measuredProfile of measuredProfiles) {
            const profileKey = getCodecProfileKey(measuredProfile);
            if (existingProfileKeys.has(profileKey)) {
                continue;
            }
            codecProfiles.push(measuredProfile);
            existingProfileKeys.add(profileKey);
        }
    }
}

/** Returns whether a route other than a package's takes a scope's streams of one range, so the native or raw decoder, not the package, bounds their size. */
function takesPackageScopeRange(route: MeasuredVideoRoute, scope: PackageVideoScope, rangeType: string): boolean {
    return route.rangeTypes.includes(rangeType)
        && route.bitDepths.includes(scope.bitDepth)
        && (route.profiles.length === 0 || route.profiles.some((profile: string): boolean => (
            profile.toLowerCase() === scope.profile?.toLowerCase()
        )));
}

/** The size steps of a codec's package scopes at one depth and in the same ranges, whose profiles share them. */
type PackageSizeRule = {
    bitDepth: number
    codec: CustomVideoCodec
    /** Empty for a codec only packages decode, whose routes take no profile condition */
    profiles: string[]
    rangeTypes: readonly string[]
    sizeSteps: readonly PackageRouteSizeStep[]
};

/**
 * Returns a size rule's profiles: the first bounds the width and the height of the narrowest step,
 * and each wider step's applies past the step before it and bounds the height alone, so a stream matches every step up to its width and the narrowest bound holds.
 * Each scopes itself by range, profile, and depth, and requires the range again among its conditions, which marks it as the add-on's.
 */
function createPackageSizeCodecProfiles(rule: PackageSizeRule): CodecProfile[] {
    const rangeCondition: ProfileCondition = {
        Condition: EQUALS_ANY_CONDITION,
        IsRequired: true,
        Property: VIDEO_RANGE_TYPE_PROPERTY,
        Value: rule.rangeTypes.join('|')
    };
    const scopeConditions: ProfileCondition[] = [ rangeCondition ];
    if (rule.profiles.length > 0) {
        scopeConditions.push({ Condition: EQUALS_ANY_CONDITION, IsRequired: true, Property: VIDEO_PROFILE_PROPERTY, Value: rule.profiles.join('|') });
    }
    scopeConditions.push({ Condition: EQUALS_CONDITION, IsRequired: true, Property: VIDEO_BIT_DEPTH_PROPERTY, Value: String(rule.bitDepth) });
    const steps = rule.sizeSteps;
    const container = getCustomContainersForVideoCodec(rule.codec).join(',');
    return steps.map((step: PackageRouteSizeStep, stepIndex: number): CodecProfile => {
        const heightCondition: ProfileCondition = {
            Condition: LESS_THAN_EQUAL_CONDITION,
            IsRequired: true,
            Property: VIDEO_HEIGHT_PROPERTY,
            Value: String(step.maximumHeight)
        };
        return stepIndex === 0 ?
            {
                ApplyConditions: scopeConditions,
                Codec: rule.codec,
                Conditions: [
                    rangeCondition,
                    { Condition: LESS_THAN_EQUAL_CONDITION, IsRequired: true, Property: VIDEO_WIDTH_PROPERTY, Value: String(steps[steps.length - 1].maximumWidth) },
                    heightCondition
                ],
                Container: container,
                Type: VIDEO_CODEC_PROFILE_TYPE
            } :
            {
                ApplyConditions: [
                    ...scopeConditions,
                    {
                        Condition: GREATER_THAN_EQUAL_CONDITION,
                        IsRequired: true,
                        Property: VIDEO_WIDTH_PROPERTY,
                        Value: String(steps[stepIndex - 1].maximumWidth + 1)
                    }
                ],
                Codec: rule.codec,
                Conditions: [ rangeCondition, heightCondition ],
                Container: container,
                Type: VIDEO_CODEC_PROFILE_TYPE
            };
    });
}

/**
 * Returns the size rules of the package scopes, in the ranges no other route takes each scope's streams in,
 * with the profiles of one codec, depth, and ranges that share their size steps joined into one rule.
 */
function createPackageSizeRules(
    capabilities: CustomDecodeCapabilities,
    supportedVideoCodecs: readonly CustomVideoCodec[],
    options: MeasuredVideoRouteOptions
): PackageSizeRule[] {
    const rules = new Map<string, PackageSizeRule>();
    const otherRoutesByCodec = new Map<CustomVideoCodec, MeasuredVideoRoute[]>();
    for (const scope of options.packageVideoScopes) {
        if (scope.sizeSteps === null || !supportedVideoCodecs.includes(scope.codec)) {
            continue;
        }
        const otherRoutes = otherRoutesByCodec.get(scope.codec)
            ?? getMeasuredVideoRoutes(scope.codec, capabilities, { ...options, packageVideoRoutes: [] });
        otherRoutesByCodec.set(scope.codec, otherRoutes);
        const rangeTypes = scope.rangeTypes.filter((rangeType: string): boolean => (
            !otherRoutes.some((route: MeasuredVideoRoute): boolean => takesPackageScopeRange(route, scope, rangeType))
        ));
        if (rangeTypes.length === 0) {
            continue;
        }
        const key = JSON.stringify([ scope.codec, scope.bitDepth, scope.profile === null, rangeTypes, scope.sizeSteps ]);
        const rule = rules.get(key);
        if (rule && scope.profile !== null) {
            rule.profiles.push(scope.profile);
        } else if (!rule) {
            rules.set(key, {
                bitDepth: scope.bitDepth,
                codec: scope.codec,
                profiles: scope.profile === null ? [] : [ scope.profile ],
                rangeTypes,
                sizeSteps: scope.sizeSteps
            });
        }
    }
    return [ ...rules.values() ];
}

/**
 * Appends the size conditions of the decoder package routes: Jellyfin offers a stream of a package scope, in a range no other route takes it in,
 * only at a size some package's `accepts` conditions take and whose frame pool and buffers fit the device's buffer limit.
 */
function appendPackageVideoSizeProfiles(
    profile: DeviceProfile,
    capabilities: CustomDecodeCapabilities,
    supportedVideoCodecs: readonly CustomVideoCodec[],
    options: MeasuredVideoRouteOptions
): void {
    const codecProfiles = profile.CodecProfiles ?? [];
    profile.CodecProfiles = codecProfiles;
    const existingProfileKeys = new Set(codecProfiles.map(getCodecProfileKey));
    for (const rule of createPackageSizeRules(capabilities, supportedVideoCodecs, options)) {
        for (const sizeProfile of createPackageSizeCodecProfiles(rule)) {
            const profileKey = getCodecProfileKey(sizeProfile);
            if (!existingProfileKeys.has(profileKey)) {
                codecProfiles.push(sizeProfile);
                existingProfileKeys.add(profileKey);
            }
        }
    }
}

function getAuthorizedHEVCRangeTypes(
    authorizedRoutes: AuthorizedHDRRoutes,
    rawHEVCSupported: boolean,
    nativeHDRSupported: boolean,
    nativeDolbyVisionSupported: boolean
): readonly string[] {
    const rangeTypes = new Set<string>();
    if (rawHEVCSupported) {
        for (const rangeType of authorizedRoutes.rawHDRRouteVideoRangeTypes) {
            rangeTypes.add(rangeType);
        }
    }
    if (nativeHDRSupported) {
        for (const rangeType of authorizedRoutes.nativeHDRVideoRangeTypes) {
            rangeTypes.add(rangeType);
        }
    }
    if (
        nativeDolbyVisionSupported
        || (authorizedRoutes.allowRawDolbyVision && rawHEVCSupported)
    ) {
        for (const rangeType of authorizedRoutes.dolbyVisionVideoRangeTypes) {
            rangeTypes.add(rangeType);
        }
    }
    return [ ...rangeTypes ];
}

function createAuthorizedHEVCProfilePlan(
    capabilities: CustomDecodeCapabilities,
    supportedRawHDRVideoCodecs: readonly CustomVideoCodec[],
    authorizedRoutes: AuthorizedHDRRoutes
): AuthorizedCodecProfilePlan | null {
    const nativeDolbyVisionSupported = hasNativeDolbyVisionCapability(
        capabilities,
        authorizedRoutes.allowNativeDolbyVision
    );
    const nativeHDRSupported = hasNativeHDRCapability(
        capabilities,
        authorizedRoutes.allowNativeHDR
    );
    const rawRouteAuthorized = authorizedRoutes.rawHDRRouteVideoRangeTypes.length > 0
        || authorizedRoutes.allowRawDolbyVision;
    // A plan replaces the shared raw ranges for HEVC, so it carries every authorized raw range itself, even one the other raw codecs share, such as HLG alone
    const rawHEVCSupported = rawRouteAuthorized
        && supportedRawHDRVideoCodecs.includes('hevc')
        && hasRawHDRCapabilities([ 'hevc' ], capabilities);
    const bitDepths: number[] = [];
    const profiles: string[] = [];
    const rangeTypes: string[] = [ ...getAuthorizedHEVCRangeTypes(
        authorizedRoutes,
        rawHEVCSupported,
        nativeHDRSupported,
        nativeDolbyVisionSupported
    ) ];
    const addRoute = (route: MeasuredVideoRoute): void => {
        if (!route.bitDepths.some((bitDepth: number): boolean => bitDepth > 0)) {
            return;
        }
        for (const bitDepth of route.bitDepths) {
            if (bitDepth > 0 && !bitDepths.includes(bitDepth)) {
                bitDepths.push(bitDepth);
            }
        }
        for (const profile of route.profiles) {
            if (!profiles.includes(profile)) {
                profiles.push(profile);
            }
        }
        for (const rangeType of route.rangeTypes) {
            if (!rangeTypes.includes(rangeType)) {
                rangeTypes.push(rangeType);
            }
        }
    };
    for (const nativeSDRRoute of createHEVCSDRMeasuredVideoRoutes(capabilities)) {
        addRoute(nativeSDRRoute);
    }
    const rawSDRRoute = createRawSDRMeasuredVideoRoute(
        'hevc',
        capabilities,
        authorizedRoutes.rawAuthorizationRouteKeys
    );
    if (rawSDRRoute) {
        addRoute(rawSDRRoute);
    }
    for (const route of createHEVCRangeExtensionMeasuredVideoRoutes(
        capabilities,
        authorizedRoutes.rawAuthorizationRouteKeys
    )) {
        addRoute(route);
    }
    if (authorizedRoutes.dolbyVisionItemVideoRoute?.codec === 'hevc') {
        addRoute(authorizedRoutes.dolbyVisionItemVideoRoute);
    }
    for (const route of authorizedRoutes.packageVideoRoutes.filter((packageRoute: MeasuredVideoRoute): boolean => packageRoute.codec === 'hevc')) {
        addRoute(route);
    }
    if (rawHEVCSupported || nativeHDRSupported || nativeDolbyVisionSupported) {
        for (const profile of RAW_VIDEO_PROFILES.hevc) {
            if (!profiles.includes(profile)) {
                profiles.push(profile);
            }
        }
        if (!bitDepths.includes(MAXIMUM_RAW_HDR_VIDEO_BIT_DEPTH)) {
            bitDepths.push(MAXIMUM_RAW_HDR_VIDEO_BIT_DEPTH);
        }
    }
    if (bitDepths.length === 0 || profiles.length === 0 || rangeTypes.length === 0) {
        return null;
    }
    return { bitDepths, profiles, rangeTypes: orderSDRRangeTypeFirst(rangeTypes) };
}

/** Keeps the established SDR-first range list ahead of authorized HDR and Dolby Vision ranges. */
function orderSDRRangeTypeFirst(rangeTypes: readonly string[]): string[] {
    if (!rangeTypes.includes('SDR')) {
        return [ ...rangeTypes ];
    }
    return [ 'SDR', ...rangeTypes.filter((rangeType: string): boolean => rangeType !== 'SDR') ];
}

/** Returns whether a raw format presents a transfer; SDR needs both color ranges, which negotiation cannot tell apart. */
function isRawFormatPresentationAuthorized(
    format: HEVCRangeExtensionRawFormat,
    transfer: ColorTransfer,
    routeKeys: readonly RawHDRAuthorizationRouteKey[]
): boolean {
    if (transfer === 'sdr') {
        return ([ 'limited', 'full' ] as const).every(
            (range: 'full' | 'limited'): boolean => routeKeys.includes(`${format}:bt709:bt709:${range}:sdr`)
        );
    }
    const requiredRouteKey = `${format}:bt2020-ncl:bt2020:limited:${transfer}`;
    return routeKeys.some((routeKey: RawHDRAuthorizationRouteKey): boolean => (
        routeKey === requiredRouteKey
    ));
}

function isRangeExtensionPresentationAuthorized(
    variant: HEVCRangeExtensionVariant,
    transfer: ColorTransfer,
    routeKeys: readonly RawHDRAuthorizationRouteKey[]
): boolean {
    return isRawFormatPresentationAuthorized(
        HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS[variant].format,
        transfer,
        routeKeys
    );
}

/**
 * Generic Rext hides chroma format from negotiation, so every qualified chroma variant at the bit depth must decode and present before the depth is advertised.
 */
function hasCompleteRextBitDepthEnvelope(
    capabilities: CustomDecodeCapabilities,
    bitDepth: HEVCRangeExtensionBitDepth,
    transfer: ColorTransfer,
    routeKeys: readonly RawHDRAuthorizationRouteKey[]
): boolean {
    return HEVC_RANGE_EXTENSION_VARIANTS
        .filter((variant: HEVCRangeExtensionVariant): boolean => (
            HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS[variant].bitDepth === bitDepth
        ))
        .every((variant: HEVCRangeExtensionVariant): boolean => (
            capabilities.hevcRangeExtensions?.[variant].status === 'supported'
            && isRangeExtensionPresentationAuthorized(variant, transfer, routeKeys)
        ));
}

const HEVC_RANGE_EXTENSION_RANGE_TYPES = [
    'SDR',
    'HDR10',
    HDR10_PLUS_VIDEO_RANGE_TYPE,
    'HLG'
] as const;

type HEVCRangeExtensionRangeType = typeof HEVC_RANGE_EXTENSION_RANGE_TYPES[number];

function getRangeExtensionTransfer(rangeType: HEVCRangeExtensionRangeType): ColorTransfer {
    switch (rangeType) {
        case 'SDR':
            return 'sdr';
        case 'HLG':
            return 'hlg';
        case 'HDR10':
        case 'HDR10Plus':
            return 'pq';
    }
}

const NAMED_HEVC_RANGE_EXTENSION_PROFILES: readonly string[] = getUniqueTokens(
    HEVC_RANGE_EXTENSION_VARIANTS
        .map((variant: HEVCRangeExtensionVariant): string => (
            HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS[variant].jellyfinProfile
        ))
        .filter((profile: string): boolean => profile !== GENERIC_REXT_PROFILE)
);

function getAuthorizedRangeExtensionBitDepths(
    variants: readonly HEVCRangeExtensionVariant[],
    rangeType: HEVCRangeExtensionRangeType,
    routeKeys: readonly RawHDRAuthorizationRouteKey[]
): number[] {
    const bitDepths: number[] = [];
    for (const variant of variants) {
        if (isRangeExtensionPresentationAuthorized(
            variant,
            getRangeExtensionTransfer(rangeType),
            routeKeys
        )) {
            appendUniqueValues(bitDepths, [ HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS[variant].bitDepth ]);
        }
    }
    return bitDepths;
}

/** Named profiles identify chroma format, so each qualified variant authorizes its own depth. */
function createNamedHEVCRangeExtensionMeasuredVideoRoutes(
    capabilities: CustomDecodeCapabilities,
    routeKeys: readonly RawHDRAuthorizationRouteKey[]
): MeasuredVideoRoute[] {
    const routes: MeasuredVideoRoute[] = [];
    for (const profile of NAMED_HEVC_RANGE_EXTENSION_PROFILES) {
        const profileVariants = HEVC_RANGE_EXTENSION_VARIANTS.filter(
            (variant: HEVCRangeExtensionVariant): boolean => (
                HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS[variant].jellyfinProfile === profile
                && capabilities.hevcRangeExtensions?.[variant].status === 'supported'
            )
        );
        const profileRoutes = HEVC_RANGE_EXTENSION_RANGE_TYPES.map(
            (rangeType: HEVCRangeExtensionRangeType): MeasuredVideoRoute => (
                createExactMeasuredVideoRoute(
                    'hevc',
                    profile,
                    rangeType,
                    getAuthorizedRangeExtensionBitDepths(profileVariants, rangeType, routeKeys)
                )
            )
        );
        if (profileRoutes.some(hasAuthorizedRouteBitDepth)) {
            routes.push(...profileRoutes);
        }
    }
    return routes;
}

function createGenericRextMeasuredVideoRoutes(
    capabilities: CustomDecodeCapabilities,
    routeKeys: readonly RawHDRAuthorizationRouteKey[]
): MeasuredVideoRoute[] {
    const routes: MeasuredVideoRoute[] = [];
    for (const bitDepth of GENERIC_REXT_BIT_DEPTHS) {
        const depthRoutes = HEVC_RANGE_EXTENSION_RANGE_TYPES.map(
            (rangeType: HEVCRangeExtensionRangeType): MeasuredVideoRoute => (
                createExactMeasuredVideoRoute(
                    'hevc',
                    GENERIC_REXT_PROFILE,
                    rangeType,
                    hasCompleteRextBitDepthEnvelope(
                        capabilities,
                        bitDepth,
                        getRangeExtensionTransfer(rangeType),
                        routeKeys
                    ) ? [ bitDepth ] : []
                )
            )
        );
        if (depthRoutes.some(hasAuthorizedRouteBitDepth)) {
            routes.push(...depthRoutes);
        }
    }
    return routes;
}

/** Returns exact range-extension routes; unauthorized ranges become rejection rules. */
function createHEVCRangeExtensionMeasuredVideoRoutes(
    capabilities: CustomDecodeCapabilities,
    routeKeys: readonly RawHDRAuthorizationRouteKey[]
): readonly MeasuredVideoRoute[] {
    return [
        ...createNamedHEVCRangeExtensionMeasuredVideoRoutes(capabilities, routeKeys),
        ...createGenericRextMeasuredVideoRoutes(capabilities, routeKeys)
    ];
}

function widenAuthorizedHDRCodecProfiles(
    profile: DeviceProfile,
    capabilities: CustomDecodeCapabilities,
    supportedRawHDRVideoCodecs: readonly CustomVideoCodec[],
    supportedNativeVideoCodecs: readonly CustomVideoCodec[],
    authorizedRoutes: AuthorizedHDRRoutes
): number {
    const authorizedHEVCProfilePlan = authorizedRoutes.widenHEVC ?
        createAuthorizedHEVCProfilePlan(capabilities, supportedRawHDRVideoCodecs, authorizedRoutes) :
        null;
    const supportsAuthorizedHEVC = authorizedHEVCProfilePlan !== null;
    let widenedProfileCount = 0;
    if (authorizedHEVCProfilePlan) {
        widenedProfileCount += widenRawHDRCodecProfiles(
            profile,
            [ 'hevc' ],
            supportedNativeVideoCodecs,
            authorizedHEVCProfilePlan.rangeTypes,
            new Map<CustomVideoCodec, AuthorizedCodecProfilePlan>([ [ 'hevc', authorizedHEVCProfilePlan ] ])
        );
    }
    // AV1 and VP9 take their own route ceilings; HEVC without a plan keeps the shared raw HDR ranges
    const sharedRangeCodecs = authorizedRoutes.rawHDRVideoRangeTypes.length > 0 && !supportsAuthorizedHEVC ?
        supportedRawHDRVideoCodecs.filter(codec => codec === 'hevc') :
        [];
    return widenedProfileCount + widenRawHDRCodecProfiles(
        profile,
        [ ...authorizedRoutes.rawCodecProfilePlans.keys(), ...sharedRangeCodecs ],
        supportedNativeVideoCodecs,
        authorizedRoutes.rawHDRVideoRangeTypes,
        authorizedRoutes.rawCodecProfilePlans
    );
}

type AudioSampleRateConstraint = Readonly<{
    kind: 'bounded'
}> | Readonly<{
    kind: 'exact'
    sampleRates: readonly number[]
}>;

function createAudioSampleRateConditions(constraint: AudioSampleRateConstraint): ProfileCondition[] {
    switch (constraint.kind) {
        case 'bounded':
            // Jellyfin reuses Equals/LTE conditions as transcode output targets.
            // Paired complement profiles also reject valid in-range routes on Jellyfin 12.
            // Negotiation therefore stays target-neutral, and runtime eligibility enforces the qualified resampler envelope
            return [ {
                Condition: NOT_EQUALS_CONDITION,
                IsRequired: true,
                Property: AUDIO_SAMPLE_RATE_PROPERTY,
                Value: '0'
            } ];
        case 'exact':
            return [ {
                Condition: constraint.sampleRates.length === 1 ? 'Equals' : EQUALS_ANY_CONDITION,
                IsRequired: true,
                Property: AUDIO_SAMPLE_RATE_PROPERTY,
                Value: constraint.sampleRates.join('|')
            } ];
    }
}

function createMeasuredAudioRouteProfile(
    codecs: readonly CustomAudioCodec[],
    channelCounts: readonly number[],
    sampleRateConstraint: AudioSampleRateConstraint
): CodecProfile {
    const conditions: ProfileCondition[] = [ {
        Condition: channelCounts.length === 1 ? 'Equals' : EQUALS_ANY_CONDITION,
        IsRequired: true,
        Property: AUDIO_CHANNELS_PROPERTY,
        Value: channelCounts.join('|')
    } ];
    conditions.push(...createAudioSampleRateConditions(sampleRateConstraint));
    return {
        Codec: codecs.join(','),
        Conditions: conditions,
        Container: CUSTOM_VIDEO_CONTAINER_VALUE,
        Type: 'VideoAudio'
    };
}

function createRequiredAudioRouteCondition(
    property: typeof AUDIO_CHANNELS_PROPERTY
        | typeof AUDIO_PROFILE_PROPERTY
        | typeof AUDIO_SAMPLE_RATE_PROPERTY,
    values: readonly (number | string)[]
): ProfileCondition {
    return {
        Condition: values.length === 1 ? 'Equals' : EQUALS_ANY_CONDITION,
        IsRequired: true,
        Property: property,
        Value: values.join('|')
    };
}

/** Scopes a bundled-decoder audio route to every container the engine's rules let carry it. */
function createMeasuredExactAudioRouteProfile(
    codec: 'dts' | 'mlp' | 'truehd',
    conditions: readonly ProfileCondition[],
    applyConditions: readonly ProfileCondition[] = []
): CodecProfile {
    return {
        ...(applyConditions.length > 0 ? { ApplyConditions: [ ...applyConditions ] } : {}),
        Codec: codec,
        Conditions: [ ...conditions ],
        Container: getCustomAudioCodecProfileContainers(codec).join(','),
        Type: 'VideoAudio'
    };
}

type DTSProfileRouteGroup = {
    channelCount: number
    profileTokens: DTSDirectPlayProfileToken[]
};

function createMeasuredDTSRouteProfiles(): CodecProfile[] {
    const measuredProfiles: CodecProfile[] = [];
    const routeGroupsByChannelCount = new Map<number, DTSProfileRouteGroup>();
    for (const route of DTS_SUPPORTED_INPUT_ROUTES) {
        for (const profileToken of route.profileTokens) {
            if (!isDTSDirectPlayProfileToken(profileToken)) {
                continue;
            }
            let routeGroup = routeGroupsByChannelCount.get(route.channelCount);
            if (!routeGroup) {
                routeGroup = {
                    channelCount: route.channelCount,
                    profileTokens: []
                };
                routeGroupsByChannelCount.set(route.channelCount, routeGroup);
            }
            if (!routeGroup.profileTokens.includes(profileToken)) {
                routeGroup.profileTokens.push(profileToken);
            }
        }
    }

    const measuredChannelCounts = [ ...routeGroupsByChannelCount.keys() ]
        .sort((firstChannelCount, secondChannelCount) => (
            firstChannelCount - secondChannelCount
        ));
    measuredProfiles.push(createMeasuredExactAudioRouteProfile('dts', [
        createRequiredAudioRouteCondition(
            AUDIO_CHANNELS_PROPERTY,
            measuredChannelCounts
        ),
        ...createAudioSampleRateConditions({ kind: 'bounded' }),
        createRequiredAudioRouteCondition(AUDIO_PROFILE_PROPERTY, SUPPORTED_DTS_AUDIO_PROFILES)
    ]));
    measuredProfiles.push(createMeasuredExactAudioRouteProfile(
        'dts',
        [
            {
                Condition: EQUALS_CONDITION,
                IsRequired: true,
                Property: AUDIO_CHANNELS_PROPERTY,
                Value: '6'
            },
            createRequiredAudioRouteCondition(
                AUDIO_PROFILE_PROPERTY,
                [ 'DTS-HD MA', 'DTS-HD MA + DTS:X' ]
            )
        ],
        [ {
            Condition: GREATER_THAN_EQUAL_CONDITION,
            IsRequired: true,
            Property: AUDIO_SAMPLE_RATE_PROPERTY,
            Value: String(DTS_HIGH_SAMPLE_RATE_MINIMUM)
        } ]
    ));

    for (const routeGroup of routeGroupsByChannelCount.values()) {
        const profileValues = DTS_DIRECT_PLAY_PROFILE_TOKENS
            .filter(profileToken => routeGroup.profileTokens.includes(profileToken))
            .map(profileToken => DTS_PROFILE_VALUE_BY_TOKEN[profileToken]);
        measuredProfiles.push(createMeasuredExactAudioRouteProfile(
            'dts',
            [ createRequiredAudioRouteCondition(AUDIO_PROFILE_PROPERTY, profileValues) ],
            [
                createRequiredAudioRouteCondition(
                    AUDIO_CHANNELS_PROPERTY,
                    [ routeGroup.channelCount ]
                )
            ]
        ));
    }
    return measuredProfiles;
}

function createMeasuredTrueHDRouteProfiles(codec: 'mlp' | 'truehd'): CodecProfile[] {
    const measuredProfiles: CodecProfile[] = [];
    const channelCounts: number[] = [];
    const exactSampleRatesByChannelCount = new Map<number, number[]>();
    for (const route of TRUEHD_SUPPORTED_INPUT_ROUTES) {
        if (route.codec === codec && !channelCounts.includes(route.channelCount)) {
            channelCounts.push(route.channelCount);
        }
        if (route.codec !== codec || route.sampleRateConstraint !== 'exact') {
            continue;
        }
        let sampleRates = exactSampleRatesByChannelCount.get(route.channelCount);
        if (!sampleRates) {
            sampleRates = [];
            exactSampleRatesByChannelCount.set(route.channelCount, sampleRates);
        }
        if (!sampleRates.includes(route.sampleRate)) {
            sampleRates.push(route.sampleRate);
        }
    }
    channelCounts.sort((left, right) => left - right);
    if (channelCounts.length === 0) {
        return measuredProfiles;
    }

    measuredProfiles.push(createMeasuredExactAudioRouteProfile(codec, [
        createRequiredAudioRouteCondition(AUDIO_CHANNELS_PROPERTY, channelCounts),
        ...createAudioSampleRateConditions({ kind: 'bounded' })
    ]));
    for (const [ channelCount, sampleRates ] of exactSampleRatesByChannelCount) {
        sampleRates.sort((left, right) => left - right);
        measuredProfiles.push(createMeasuredExactAudioRouteProfile(
            codec,
            [ createRequiredAudioRouteCondition(AUDIO_SAMPLE_RATE_PROPERTY, sampleRates) ],
            [ createRequiredAudioRouteCondition(AUDIO_CHANNELS_PROPERTY, [ channelCount ]) ]
        ));
    }
    return measuredProfiles;
}

const CUSTOM_AUDIO_ROUTE_PROPERTIES = new Set<string>([
    AUDIO_BIT_DEPTH_PROPERTY,
    AUDIO_CHANNELS_PROPERTY,
    AUDIO_SAMPLE_RATE_PROPERTY,
    'IsSecondaryAudio'
]);

function getDeclaredDirectPlayAudioCodecs(profile: DeviceProfile): string[] {
    const codecs: string[] = [];
    for (const directPlayProfile of profile.DirectPlayProfiles ?? []) {
        if (directPlayProfile.Type !== 'Video') {
            continue;
        }
        for (const codec of getCodecTokens(directPlayProfile.AudioCodec)) {
            if (!codecs.includes(codec)) {
                codecs.push(codec);
            }
        }
    }
    return codecs;
}

function shouldSplitAudioRouteProfile(
    codecProfile: CodecProfile,
    measuredProfileKeys: ReadonlySet<string>
): boolean {
    const conditions = codecProfile.Conditions ?? [];
    return codecProfile.Type === 'VideoAudio'
        && !codecProfile.SubContainer
        && !codecProfile.Container?.trim().startsWith('-')
        && !measuredProfileKeys.has(getCodecProfileKey(codecProfile))
        && conditions.some(condition => (
            CUSTOM_AUDIO_ROUTE_PROPERTIES.has(condition.Property ?? '')
        ));
}

function createSplitAudioRouteProfiles(
    codecProfile: CodecProfile,
    supportedAudioCodecs: readonly CustomAudioCodec[],
    supportedAudioCodecSet: ReadonlySet<string>,
    measuredProfileKeys: ReadonlySet<string>,
    declaredDirectPlayAudioCodecs: readonly string[]
): CodecProfile[] | null {
    if (!shouldSplitAudioRouteProfile(codecProfile, measuredProfileKeys)) {
        return null;
    }

    const configuredContainers = getCodecTokens(codecProfile.Container);
    const customContainers = configuredContainers.length === 0 ?
        [ ...CUSTOM_VIDEO_CONTAINERS ] :
        configuredContainers.filter(container => CUSTOM_VIDEO_CONTAINER_SET.has(container));
    if (customContainers.length === 0) {
        return null;
    }

    const configuredCodecs = getCodecTokens(codecProfile.Codec);
    const supportedProfileCodecs = configuredCodecs.length === 0 ?
        [ ...supportedAudioCodecs ] :
        configuredCodecs.filter(codec => supportedAudioCodecSet.has(codec));
    if (supportedProfileCodecs.length === 0) {
        return null;
    }

    const splitProfiles: CodecProfile[] = [];
    const nonCustomContainers = configuredContainers.filter(container => (
        !CUSTOM_VIDEO_CONTAINER_SET.has(container)
    ));
    if (configuredContainers.length === 0) {
        splitProfiles.push({
            ...codecProfile,
            Container: NON_CUSTOM_VIDEO_CONTAINER_VALUE
        });
    } else if (nonCustomContainers.length > 0) {
        splitProfiles.push({
            ...codecProfile,
            Container: nonCustomContainers.join(',')
        });
    }

    const unsupportedProfileCodecs = configuredCodecs.length === 0 ?
        declaredDirectPlayAudioCodecs.filter(codec => !supportedAudioCodecSet.has(codec)) :
        configuredCodecs.filter(codec => !supportedAudioCodecSet.has(codec));
    if (unsupportedProfileCodecs.length > 0) {
        splitProfiles.push({
            ...codecProfile,
            Codec: unsupportedProfileCodecs.join(','),
            Container: customContainers.join(',')
        });
    }

    const remainingConditions = (codecProfile.Conditions ?? []).filter(condition => (
        !CUSTOM_AUDIO_ROUTE_PROPERTIES.has(condition.Property ?? '')
    ));
    if (remainingConditions.length > 0) {
        splitProfiles.push({
            ...codecProfile,
            Codec: supportedProfileCodecs.join(','),
            Conditions: remainingConditions,
            Container: customContainers.join(',')
        });
    }
    return splitProfiles;
}

/**
 * Keeps HTML-player audio constraints outside custom routes while removing the bit-depth, channel, sample-rate, and secondary-track limits replaced by measured decoded-PCM routes.
 */
function splitOriginalAudioRouteProfiles(
    profile: DeviceProfile,
    supportedAudioCodecs: readonly CustomAudioCodec[],
    measuredProfileKeys: ReadonlySet<string>
): void {
    if (!profile.CodecProfiles || supportedAudioCodecs.length === 0) {
        return;
    }

    const supportedAudioCodecSet = new Set<string>(supportedAudioCodecs);
    const declaredDirectPlayAudioCodecs = getDeclaredDirectPlayAudioCodecs(profile);
    const splitProfiles: CodecProfile[] = [];
    for (const codecProfile of profile.CodecProfiles) {
        const profileSplits = createSplitAudioRouteProfiles(
            codecProfile,
            supportedAudioCodecs,
            supportedAudioCodecSet,
            measuredProfileKeys,
            declaredDirectPlayAudioCodecs
        );
        if (profileSplits === null) {
            splitProfiles.push(codecProfile);
        } else {
            splitProfiles.push(...profileSplits);
        }
    }
    profile.CodecProfiles = splitProfiles;
}

function getSupportedNativeMediaChannelCounts(
    nativeMediaAudioCapabilities: NativeMediaAudioCapabilities,
    codec: NativeMediaAudioCodec
): NativeMediaAudioChannelCount[] {
    const channelCounts: NativeMediaAudioChannelCount[] = [];
    for (const channelCount of NATIVE_MEDIA_AUDIO_CHANNEL_COUNTS) {
        if (nativeMediaAudioCapabilities.audio[codec].layouts[channelCount].status === 'supported') {
            channelCounts.push(channelCount);
        }
    }
    return channelCounts;
}

function appendMeasuredNativeAudioRouteProfiles(
    measuredProfiles: CodecProfile[],
    capabilities: CustomDecodeCapabilities,
    nativeMediaAudioCapabilities: NativeMediaAudioCapabilities | null | undefined,
    packageAudioCodecs: readonly CustomAudioCodec[]
): void {
    if (!nativeMediaAudioCapabilities) {
        return;
    }

    for (const codec of [ 'ac3', 'eac3' ] as const) {
        if (capabilities.audio[codec].status === 'supported' || packageAudioCodecs.includes(codec)) {
            // The decoded-PCM profile below covers the native route at 48 kHz without letting its exact rate veto the software fallback
            continue;
        }
        const channelCounts = getSupportedNativeMediaChannelCounts(
            nativeMediaAudioCapabilities,
            codec
        );
        if (channelCounts.length === 0) {
            continue;
        }
        measuredProfiles.push(createMeasuredAudioRouteProfile(
            [ codec ],
            channelCounts,
            {
                kind: 'exact',
                sampleRates: [ NATIVE_MEDIA_AUDIO_SAMPLE_RATE ]
            }
        ));
    }
}

/** Returns the codecs decoded to PCM: by an engine decoder, or by a decoder package where none does. */
function getDecodedAudioCodecs(capabilities: CustomDecodeCapabilities, packageAudioCodecs: readonly CustomAudioCodec[]): CustomAudioCodec[] {
    const decodedAudioCodecs: CustomAudioCodec[] = [];
    for (const codec of CUSTOM_AUDIO_CODECS) {
        if (capabilities.audio[codec].status !== 'supported' && !packageAudioCodecs.includes(codec)) {
            continue;
        }
        decodedAudioCodecs.push(codec);
    }
    return decodedAudioCodecs;
}

function hasQualifiedDecodedSurroundRoute(
    codec: CustomAudioCodec,
    capabilities: CustomDecodeCapabilities,
    packageAudioCodecs: readonly CustomAudioCodec[]
): boolean {
    // A package reports its decoded layout, so every layout the codec's decoded PCM path presents is a route, as eligibility checks it
    if (isCustomMediabunnyPCMAudioCodec(codec) || isPackageDecodedAudioCodec(codec, capabilities, packageAudioCodecs)) {
        return true;
    }
    switch (codec) {
        case 'ac3':
        case 'dts':
        case 'eac3':
        case 'mlp':
        case 'truehd':
            // No engine decoder decodes these to PCM
            return false;
        case 'aac':
        case 'flac':
        case 'opus':
        case 'vorbis': {
            const surroundCapability: CustomNativeSurroundAudioCodecCapability | undefined =
                capabilities.nativeSurroundAudio?.[codec];
            return surroundCapability?.status === 'supported'
                && surroundCapability.inputChannelCount
                    === CUSTOM_SURROUND_INPUT_CHANNEL_COUNT;
        }
        case 'mp3':
            return false;
    }
}

function appendMeasuredAudioRouteProfiles(
    profile: DeviceProfile,
    capabilities: CustomDecodeCapabilities,
    nativeMediaAudioCapabilities: NativeMediaAudioCapabilities | null | undefined,
    supportedAudioCodecs: readonly CustomAudioCodec[],
    packageAudioCodecs: readonly CustomAudioCodec[]
): void {
    const decodedAudioCodecs = getDecodedAudioCodecs(capabilities, packageAudioCodecs);
    const measuredProfiles: CodecProfile[] = [];
    appendMeasuredNativeAudioRouteProfiles(
        measuredProfiles,
        capabilities,
        nativeMediaAudioCapabilities,
        packageAudioCodecs
    );
    const decodedAudioRouteGroups = new Map<string, {
        channelCounts: readonly number[]
        codecs: CustomAudioCodec[]
    }>();
    for (const codec of decodedAudioCodecs) {
        if (codec === 'dts' || codec === 'mlp' || codec === 'truehd') {
            continue;
        }
        const channelCounts = hasQualifiedDecodedSurroundRoute(codec, capabilities, packageAudioCodecs) ?
            getSupportedCustomAudioInputChannelCounts(codec) :
            CUSTOM_NON_SURROUND_INPUT_CHANNEL_COUNTS;
        const routeKey = channelCounts.join(',');
        let routeGroup = decodedAudioRouteGroups.get(routeKey);
        if (!routeGroup) {
            routeGroup = {
                channelCounts,
                codecs: []
            };
            decodedAudioRouteGroups.set(routeKey, routeGroup);
        }
        routeGroup.codecs.push(codec);
    }
    for (const routeGroup of decodedAudioRouteGroups.values()) {
        measuredProfiles.push(createMeasuredAudioRouteProfile(
            routeGroup.codecs,
            routeGroup.channelCounts,
            { kind: 'bounded' }
        ));
    }
    if (decodedAudioCodecs.includes('dts')) {
        measuredProfiles.push(...createMeasuredDTSRouteProfiles());
    }
    if (decodedAudioCodecs.includes('mlp')) {
        measuredProfiles.push(...createMeasuredTrueHDRouteProfiles('mlp'));
    }
    if (decodedAudioCodecs.includes('truehd')) {
        measuredProfiles.push(...createMeasuredTrueHDRouteProfiles('truehd'));
    }

    const measuredProfileKeys = new Set(measuredProfiles.map(getCodecProfileKey));
    splitOriginalAudioRouteProfiles(
        profile,
        supportedAudioCodecs,
        measuredProfileKeys
    );
    const codecProfiles = profile.CodecProfiles ?? [];
    profile.CodecProfiles = codecProfiles;
    const existingProfileKeys = new Set(codecProfiles.map(getCodecProfileKey));
    for (const measuredProfile of measuredProfiles) {
        const profileKey = getCodecProfileKey(measuredProfile);
        if (existingProfileKeys.has(profileKey)) {
            continue;
        }
        codecProfiles.push(measuredProfile);
        existingProfileKeys.add(profileKey);
    }
}

/**
 * Clones and widens direct-play declarations only for proven WebCodecs and Mediabunny combinations.
 * Existing transcoding behavior is copied unchanged.
 */
export function augmentDeviceProfileForCustomDecode(
    profile: DeviceProfile,
    capabilities: CustomDecodeCapabilities,
    options: CustomDeviceProfileOptions = {}
): CustomDeviceProfileResult {
    const clonedProfile = cloneDeviceProfile(profile);
    const nativeHDRVideoRangeTypes = options.allowNativeHDR === true ?
        getAuthorizedExternalHDRVideoRangeTypes(options.authorizedExternalHDRRouteKeys ?? []) :
        [];
    const overlappingRawDolbyVisionRangeTypes =
        authorizeNativeDolbyVisionBaseRanges(
            capabilities,
            options,
            nativeHDRVideoRangeTypes
        );
    const rawHDRVideoRangeTypes = options.allowRawHDR === true ?
        getAuthorizedRawHDRVideoRangeTypes(options.authorizedRawHDRRouteKeys ?? []) :
        [];
    const rawAuthorizationRouteKeys = (options.authorizedRawHDRRouteKeys ?? []).filter(
        (routeKey: RawHDRAuthorizationRouteKey): boolean => (
            options.allowRawSDR === true && routeKey.endsWith(':sdr')
            || options.allowRawHDR === true && !routeKey.endsWith(':sdr')
        )
    );
    const rawHDRRouteVideoRangeTypes = getRawHDRRouteVideoRangeTypes(rawHDRVideoRangeTypes);
    const availableRawDolbyVisionVideoRangeTypes = getDolbyVisionVideoRangeTypes(
        capabilities,
        options.allowDolbyVision === true,
        options.allowDolbyVisionProfile7 === true,
        options.allowDolbyVisionProfile7HDR10Base === true,
        false
    );
    const nativeDolbyVisionVideoRangeTypes = getDolbyVisionVideoRangeTypes(
        capabilities,
        false,
        false,
        false,
        options.allowNativeDolbyVision === true
    );
    let rawDolbyVisionVideoRangeTypes = nativeDolbyVisionVideoRangeTypes.includes('DOVI') ?
        availableRawDolbyVisionVideoRangeTypes.filter(rangeType => rangeType !== 'DOVI') :
        availableRawDolbyVisionVideoRangeTypes;
    const allowRawDolbyVision = rawDolbyVisionVideoRangeTypes.length > 0;
    if (overlappingRawDolbyVisionRangeTypes.size > 0) {
        // Runtime prefers the authorized native compatible base for these ranges and keeps raw reconstruction only as its fallback, so the native route advertises them
        rawDolbyVisionVideoRangeTypes = rawDolbyVisionVideoRangeTypes.filter(rangeType => (
            !overlappingRawDolbyVisionRangeTypes.has(rangeType)
        ));
    }
    const dolbyVisionVideoRangeTypes = [
        ...new Set([
            ...rawDolbyVisionVideoRangeTypes,
            ...nativeDolbyVisionVideoRangeTypes
        ])
    ];
    const allowNativeDolbyVision = nativeDolbyVisionVideoRangeTypes.length > 0;
    const allowNativeHDR = nativeHDRVideoRangeTypes.length > 0;
    const dolbyVisionItemVideoRoute = getDolbyVisionItemVideoRoute(capabilities, options);
    const packageVideoScopes = createPackageVideoScopes(options.decoderPackages ?? [], options.allowFramePoolHDR === true);
    const packageVideoRoutes = createPackageVideoRoutes(packageVideoScopes);
    const packageAudioCodecs = getPackageAudioCodecs(options.decoderPackages ?? []);
    const measuredVideoRouteOptions: MeasuredVideoRouteOptions = {
        allowNativeDolbyVision,
        allowNativeHDR,
        dolbyVisionItemVideoRoute,
        nativeDolbyVisionVideoRangeTypes,
        nativeHDRVideoRangeTypes,
        packageVideoRoutes,
        packageVideoScopes,
        rawAV1DolbyVisionVideoRangeTypes: getAV1DolbyVisionVideoRangeTypes(
            capabilities,
            options.allowDolbyVision === true
        ),
        rawDolbyVisionVideoRangeTypes,
        rawHDRRouteVideoRangeTypes,
        rawAuthorizationRouteKeys
    };
    const rawRouteVideoCodecs = getRawRouteVideoCodecs(capabilities, measuredVideoRouteOptions);
    const allowRawHDR = rawHDRVideoRangeTypes.length > 0
        || dolbyVisionVideoRangeTypes.length > 0
        || allowNativeHDR
        || dolbyVisionItemVideoRoute !== null
        || rawRouteVideoCodecs.length > 0;
    const packageRouteVideoCodecs: CustomVideoCodec[] = [];
    appendUniqueValues(packageRouteVideoCodecs, packageVideoRoutes.map((route: MeasuredVideoRoute): CustomVideoCodec => route.codec));
    const supportedNativeVideoCodecs = getSupportedVideoCodecs(capabilities);
    const supportedVideoCodecs = getSupportedVideoCodecs(
        capabilities,
        rawRouteVideoCodecs,
        allowNativeDolbyVision,
        allowNativeHDR,
        packageRouteVideoCodecs
    );
    // The runtime selected a route for the item, so its decoder exists even without a generic route
    if (dolbyVisionItemVideoRoute && !supportedVideoCodecs.includes(dolbyVisionItemVideoRoute.codec)) {
        supportedVideoCodecs.push(dolbyVisionItemVideoRoute.codec);
    }
    const supportedAudioCodecs = getSupportedAudioCodecs(
        capabilities,
        options.nativeMediaAudioCapabilities,
        packageAudioCodecs
    );
    const supportedRawHDRVideoCodecs = getSupportedRawHDRVideoCodecs(capabilities);
    if (options.isRetry === true) {
        return {
            profile: clonedProfile,
            telemetry: createTelemetry(
                'retry-not-widened',
                supportedVideoCodecs,
                supportedAudioCodecs,
                [],
                0
            )
        };
    }

    removeBitratePlaybackConstraints(clonedProfile);

    if (supportedVideoCodecs.length === 0 && supportedAudioCodecs.length === 0) {
        return {
            profile: clonedProfile,
            telemetry: createTelemetry(
                'no-supported-codecs',
                supportedVideoCodecs,
                supportedAudioCodecs,
                [],
                0
            )
        };
    }

    const compatibleProfiles = createCompatibleProfiles(supportedVideoCodecs, supportedAudioCodecs);
    if (compatibleProfiles.length === 0) {
        return {
            profile: clonedProfile,
            telemetry: createTelemetry(
                'no-compatible-combinations',
                supportedVideoCodecs,
                supportedAudioCodecs,
                [],
                0
            )
        };
    }

    const subtitleProfileChanged = applyOptionalCustomSubtitleProfiles(
        clonedProfile,
        options.subtitleCapabilities
    );

    scopeOriginalVideoRuntimeConditions(clonedProfile, supportedVideoCodecs);
    scopeOriginalContainerRuntimeConditions(clonedProfile);

    const hasAuthorizedRangeExtensionRoute = createHEVCRangeExtensionMeasuredVideoRoutes(
        capabilities,
        rawAuthorizationRouteKeys
    ).some(hasAuthorizedRouteBitDepth);
    const widenAuthorizedRoutes = allowRawHDR || hasAuthorizedRangeExtensionRoute;
    // A package of a codec whose stock profiles condition on profile and depth needs that codec's ceiling widened too
    const packageRoutedRawCodecs = packageRouteVideoCodecs.filter((codec: CustomVideoCodec): boolean => (
        (CUSTOM_RAW_HDR_VIDEO_CODECS as readonly CustomVideoCodec[]).includes(codec)
    ));
    const widenedHDRCodecProfileCount = widenAuthorizedRoutes || packageRoutedRawCodecs.length > 0 ?
        widenAuthorizedHDRCodecProfiles(
            clonedProfile,
            capabilities,
            supportedRawHDRVideoCodecs,
            supportedNativeVideoCodecs,
            {
                allowNativeDolbyVision,
                allowNativeHDR,
                allowRawDolbyVision,
                dolbyVisionItemVideoRoute,
                dolbyVisionVideoRangeTypes,
                nativeHDRVideoRangeTypes,
                packageVideoRoutes,
                rawCodecProfilePlans: createRawCodecProfilePlans(capabilities, measuredVideoRouteOptions),
                rawHDRRouteVideoRangeTypes,
                rawHDRVideoRangeTypes,
                rawAuthorizationRouteKeys,
                widenHEVC: widenAuthorizedRoutes || packageRoutedRawCodecs.includes('hevc')
            }
        ) :
        0;
    appendMeasuredVideoRouteProfiles(
        clonedProfile,
        capabilities,
        supportedVideoCodecs,
        measuredVideoRouteOptions
    );
    appendPackageVideoSizeProfiles(
        clonedProfile,
        capabilities,
        supportedVideoCodecs,
        measuredVideoRouteOptions
    );
    appendMeasuredAudioRouteProfiles(
        clonedProfile,
        capabilities,
        options.nativeMediaAudioCapabilities,
        supportedAudioCodecs,
        packageAudioCodecs
    );
    const directPlayProfiles = clonedProfile.DirectPlayProfiles ?? [];
    clonedProfile.DirectPlayProfiles = directPlayProfiles;
    const existingProfileKeys = new Set(directPlayProfiles.map(getProfileKey));
    const addedProfiles: DirectPlayProfile[] = [];
    for (const compatibleProfile of compatibleProfiles) {
        const profileKey = getProfileKey(compatibleProfile);
        if (existingProfileKeys.has(profileKey)) {
            continue;
        }
        directPlayProfiles.push(compatibleProfile);
        existingProfileKeys.add(profileKey);
        addedProfiles.push(compatibleProfile);
    }

    return {
        profile: clonedProfile,
        telemetry: createTelemetry(
            addedProfiles.length > 0 || subtitleProfileChanged ?
                'augmented' :
                'already-advertised',
            supportedVideoCodecs,
            supportedAudioCodecs,
            addedProfiles,
            widenedHDRCodecProfileCount,
            subtitleProfileChanged
        )
    };
}

import type { CodecProfile } from '@jellyfin/sdk/lib/generated-client/models/codec-profile';
import type { DeviceProfile } from '@jellyfin/sdk/lib/generated-client/models/device-profile';
import type { ProfileCondition } from '@jellyfin/sdk/lib/generated-client/models/profile-condition';
import { describe, expect, it } from 'vitest';

import CustomDecodeCapabilityProbe, {
    CUSTOM_AUDIO_CODECS,
    CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS,
    CUSTOM_NATIVE_SURROUND_AUDIO_CODECS,
    CUSTOM_NATIVE_ULTRA_HD_VIDEO_CODECS,
    CUSTOM_PACKAGE_AUDIO_CODECS,
    CUSTOM_PACKAGE_VIDEO_CODECS,
    CUSTOM_RAW_HDR_VIDEO_CODECS,
    CUSTOM_VIDEO_CODECS,
    CUSTOM_WEB_CODECS_AUDIO_CODECS,
    type CustomAudioCodec,
    type CustomDecodeCapabilities,
    type CustomDecodeCodecCapability,
    type CustomNativeSurroundAudioCodec,
    type CustomNativeSurroundAudioCodecCapability,
    type CustomNativeUltraHDVideoCodec,
    type CustomNativeUltraHDVideoCodecCapability,
    type CustomPackageAudioCodec,
    type CustomPackageVideoCodec,
    type CustomRawHDRVideoCodec,
    type CustomRawHDRVideoCodecCapability,
    type CustomVideoCodec
} from 'webgpu-player/capability/CustomDecodeCapabilities';
import {
    augmentDeviceProfileForCustomDecode,
    createBitrateIndependentDeviceProfile,
    type CustomDeviceProfileOptions,
    type DecoderPackageRouteSummary
} from 'addons/webGPUPlayer/custom/CustomDeviceProfile';
import { isSameSessionNativePlaybackCompatible } from 'addons/webGPUPlayer/custom/NativeDirectPlayCompatibility';
import {
    CUSTOM_CONTAINER_CODEC_RULES,
    CUSTOM_PROFILE_VIDEO_CONTAINERS
} from 'webgpu-player/capability/CustomContainerCodecSupport';
import type { H264ProfileCapabilities } from 'webgpu-player/capability/H264ProfileCapabilities';
import {
    AV1_RAW_FORMAT_PROBE_DEFINITIONS,
    AV1_RAW_FORMAT_VARIANTS,
    type AV1RawFormatCapability,
    type AV1RawFormatVariant
} from 'webgpu-player/capability/AV1RawFormatCapabilities';
import {
    H264_RAW_FORMAT_PROBE_DEFINITIONS,
    H264_RAW_FORMAT_VARIANTS,
    type H264RawFormatCapability,
    type H264RawFormatVariant
} from 'webgpu-player/capability/H264RawFormatCapabilities';
import {
    HEVC_RANGE_EXTENSION_VARIANTS,
    type HEVCRangeExtensionCapability,
    type HEVCRangeExtensionRawFormat,
    type HEVCRangeExtensionVariant
} from 'webgpu-player/capability/HEVCRangeExtensionCapabilities';
import type { RawHDRAuthorizationRouteKey } from 'webgpu-player/validation/RawHDRPresentationAuthorization';
import type {
    NativeMediaAudioCapabilities,
    NativeMediaAudioChannelCount,
    NativeMediaAudioCodec,
    NativeMediaAudioCodecCapability,
    NativeMediaAudioLayoutCapability
} from 'webgpu-player/capability/NativeMediaAudioCapabilities';
import {
    createAV1RawFormatCapability,
    createConfigCodecCapability,
    createH264ProfileCapabilities,
    createH264RawFormatCapability,
    createHEVCRangeExtensionCapability,
    createNoEngineDecoderCodecCapability
} from './CustomDecodeCapabilityBuilders';

const RAW_PQ_ROUTE_KEY = 'I420P10:bt2020-ncl:bt2020:limited:pq';
const RAW_HLG_ROUTE_KEY = 'I420P10:bt2020-ncl:bt2020:limited:hlg';

const RAW_HDR_PROFILE_OPTIONS = {
    allowRawHDR: true,
    authorizedRawHDRRouteKeys: [
        RAW_PQ_ROUTE_KEY,
        RAW_HLG_ROUTE_KEY
    ] as const
};

const ULTRA_HD_8K_WIDTH = 7_680;
const ULTRA_HD_8K_HEIGHT = 4_320;

// The decoder packages the engine's decoder projects build, as the server's catalog describes them
const MPEG2_DECODER_PACKAGE: DecoderPackageRouteSummary = { codecs: [ 'mpeg2video', 'mpeg1video' ], kind: 'video', outputFormats: [ 'I420', 'I422', 'I444' ] };
const VC1_DECODER_PACKAGE: DecoderPackageRouteSummary = { codecs: [ 'vc1', 'wmv3' ], kind: 'video', outputFormats: [ 'I420' ] };
const MPEG4_DECODER_PACKAGE: DecoderPackageRouteSummary = {
    codecs: [ 'mpeg4', 'h263', 'msmpeg4v1', 'msmpeg4v2', 'msmpeg4v3' ],
    kind: 'video',
    outputFormats: [ 'I420' ]
};
const JPEG2000_DECODER_PACKAGE: DecoderPackageRouteSummary = {
    codecs: [ 'jpeg2000' ],
    kind: 'video',
    outputFormats: [ 'I420', 'I420P10', 'I420P12', 'I422', 'I422P10', 'I422P12', 'I444', 'I444P10', 'I444P12' ]
};
const EAC3_DECODER_PACKAGE: DecoderPackageRouteSummary = { codecs: [ 'eac3', 'ac3' ], kind: 'audio', outputFormats: [] };
const DTS_DECODER_PACKAGE: DecoderPackageRouteSummary = { codecs: [ 'dts' ], kind: 'audio', outputFormats: [] };
const TRUEHD_DECODER_PACKAGE: DecoderPackageRouteSummary = { codecs: [ 'mlp', 'truehd' ], kind: 'audio', outputFormats: [] };
const WMA_DECODER_PACKAGE: DecoderPackageRouteSummary = { codecs: [ 'wmav1', 'wmav2', 'wmapro', 'wmalossless', 'wmavoice' ], kind: 'audio', outputFormats: [] };
const HEVC_DECODER_PACKAGE: DecoderPackageRouteSummary = {
    codecs: [ 'hevc' ],
    kind: 'video',
    outputFormats: [ 'I420', 'I420P10', 'I420P12', 'I422', 'I422P10', 'I422P12', 'I444', 'I444P10', 'I444P12' ]
};
// The packages that decode every codec the engine has no decoder of
const PACKAGE_CODEC_DECODER_PACKAGES: readonly DecoderPackageRouteSummary[] = [
    MPEG2_DECODER_PACKAGE,
    VC1_DECODER_PACKAGE,
    MPEG4_DECODER_PACKAGE,
    JPEG2000_DECODER_PACKAGE,
    EAC3_DECODER_PACKAGE,
    DTS_DECODER_PACKAGE,
    TRUEHD_DECODER_PACKAGE,
    WMA_DECODER_PACKAGE
];

// The codecs a capability probe can find supported; the probe reports every other codec as having no engine decoder
type EngineVideoCodec = Exclude<CustomVideoCodec, CustomPackageVideoCodec>;
type EngineAudioCodec = Exclude<CustomAudioCodec, CustomPackageAudioCodec>;
const PACKAGE_VIDEO_CODEC_SET: ReadonlySet<CustomVideoCodec> = new Set<CustomVideoCodec>(CUSTOM_PACKAGE_VIDEO_CODECS);
const PACKAGE_AUDIO_CODEC_SET: ReadonlySet<CustomAudioCodec> = new Set<CustomAudioCodec>(CUSTOM_PACKAGE_AUDIO_CODECS);

function isEngineVideoCodec(codec: CustomVideoCodec): codec is EngineVideoCodec {
    return !PACKAGE_VIDEO_CODEC_SET.has(codec);
}

function isEngineAudioCodec(codec: CustomAudioCodec): codec is EngineAudioCodec {
    return !PACKAGE_AUDIO_CODEC_SET.has(codec);
}

const ENGINE_VIDEO_CODECS: readonly EngineVideoCodec[] = CUSTOM_VIDEO_CODECS.filter(isEngineVideoCodec);
const ENGINE_AUDIO_CODECS: readonly EngineAudioCodec[] = CUSTOM_AUDIO_CODECS.filter(isEngineAudioCodec);
// The containers whose rules carry DTS: ISO BMFF, Matroska, and MPEG-TS
const DTS_PROFILE_CONTAINERS = 'mp4,m4v,mov,mkv,ts,m2ts,mts';
// Every container the engine plays, as a measured audio route lists them, and the value a stock profile split takes for every other container
const CUSTOM_VIDEO_CONTAINERS = CUSTOM_PROFILE_VIDEO_CONTAINERS.join(',');
const NON_CUSTOM_VIDEO_CONTAINERS = `-${CUSTOM_VIDEO_CONTAINERS}`;

/** Returns the containers of a video codec's container rules, as its measured route profiles list them. */
function getCustomVideoCodecContainers(codec: CustomVideoCodec): string {
    const containers: string[] = [];
    for (const rule of CUSTOM_CONTAINER_CODEC_RULES) {
        if (!rule.videoCodecs.includes(codec)) {
            continue;
        }
        for (const container of rule.profileContainers) {
            if (!containers.includes(container)) {
                containers.push(container);
            }
        }
    }
    return containers.join(',');
}

type NativeUltraHDVideoCapabilityHarness = Readonly<{
    capabilityProperties: Readonly<{
        nativeUltraHDVideo?: NonNullable<CustomDecodeCapabilities['nativeUltraHDVideo']>
    }>
    probeCount: number
}>;

type NativeSurroundAudioCapabilityHarness = Readonly<{
    capabilities?: NonNullable<CustomDecodeCapabilities['nativeSurroundAudio']>
    probeCount: number
}>;

function createNativeSurroundAudioCapabilityHarness(
    supportedCodecs: readonly CustomNativeSurroundAudioCodec[],
    inputChannelCount: CustomNativeSurroundAudioCodecCapability['inputChannelCount']
): NativeSurroundAudioCapabilityHarness {
    if (supportedCodecs.length === 0) {
        return { probeCount: 0 };
    }

    const capabilities = {} as Record<CustomNativeSurroundAudioCodec, CustomNativeSurroundAudioCodecCapability>;
    const supportedCodecSet = new Set(supportedCodecs);
    const codecStrings: Readonly<Record<CustomNativeSurroundAudioCodec, string>> = {
        aac: 'mp4a.40.2',
        flac: 'flac',
        opus: 'opus',
        vorbis: 'vorbis'
    };
    for (const codec of CUSTOM_NATIVE_SURROUND_AUDIO_CODECS) {
        const supported = supportedCodecSet.has(codec);
        capabilities[codec] = {
            codec,
            codecString: codecStrings[codec],
            inputChannelCount,
            reason: supported ? 'decode-output-verified' : 'decode-output-missing',
            sampleRate: 48_000,
            status: supported ? 'supported' : 'unsupported'
        };
    }
    return {
        capabilities,
        probeCount: CUSTOM_NATIVE_SURROUND_AUDIO_CODECS.length
    };
}

function createNativeUltraHDVideoCapabilityHarness(
    supportedCodecs: readonly CustomNativeUltraHDVideoCodec[]
): NativeUltraHDVideoCapabilityHarness {
    if (supportedCodecs.length === 0) {
        return { capabilityProperties: {}, probeCount: 0 };
    }

    const capabilities = {} as Record<CustomNativeUltraHDVideoCodec, CustomNativeUltraHDVideoCodecCapability>;
    const supportedCodecSet = new Set(supportedCodecs);
    const codecStrings: Readonly<Record<CustomNativeUltraHDVideoCodec, string>> = {
        av1: 'av01.0.12M.08',
        hevc: 'hvc1.1.6.L153.B0',
        vp9: 'vp09.00.51.08'
    };
    for (const codec of CUSTOM_NATIVE_ULTRA_HD_VIDEO_CODECS) {
        const supported = supportedCodecSet.has(codec);
        capabilities[codec] = {
            bitDepth: 8,
            codec,
            codecString: codecStrings[codec],
            reason: supported ? 'decode-output-verified' : 'decode-output-missing',
            status: supported ? 'supported' : 'unsupported'
        };
    }
    return {
        capabilityProperties: { nativeUltraHDVideo: capabilities },
        probeCount: CUSTOM_NATIVE_ULTRA_HD_VIDEO_CODECS.length
    };
}

/** What each capability probe found supported; a codec a list leaves out is unsupported, and a codec only a package decodes is never supported. */
type CapabilityOptions = Readonly<{
    supportedVideoCodecs: readonly EngineVideoCodec[]
    supportedAudioCodecs: readonly EngineAudioCodec[]
    supportedRawHDRVideoCodecs?: readonly CustomRawHDRVideoCodec[]
    nativeDolbyVisionSupported?: boolean
    supportedNativeUltraHDVideoCodecs?: readonly CustomNativeUltraHDVideoCodec[]
    supportedNativeSurroundAudioCodecs?: readonly CustomNativeSurroundAudioCodec[]
    supportedNativeSevenPointOneAudioCodecs?: readonly CustomNativeSurroundAudioCodec[]
}>;

function createCapabilities({
    supportedVideoCodecs,
    supportedAudioCodecs,
    supportedRawHDRVideoCodecs = [],
    nativeDolbyVisionSupported = false,
    supportedNativeUltraHDVideoCodecs = [],
    supportedNativeSurroundAudioCodecs = [],
    supportedNativeSevenPointOneAudioCodecs = []
}: CapabilityOptions): CustomDecodeCapabilities {
    const supportedVideoSet = new Set(supportedVideoCodecs);
    const supportedAudioSet = new Set(supportedAudioCodecs);
    const video = {} as Record<CustomVideoCodec, CustomDecodeCodecCapability<CustomVideoCodec>>;
    for (const codec of CUSTOM_VIDEO_CODECS) {
        video[codec] = isEngineVideoCodec(codec) ?
            createConfigCodecCapability(codec, supportedVideoSet.has(codec)) :
            createNoEngineDecoderCodecCapability(codec);
    }
    const audio = {} as Record<CustomAudioCodec, CustomDecodeCodecCapability<CustomAudioCodec>>;
    for (const codec of CUSTOM_AUDIO_CODECS) {
        audio[codec] = isEngineAudioCodec(codec) ?
            createConfigCodecCapability(codec, supportedAudioSet.has(codec)) :
            createNoEngineDecoderCodecCapability(codec);
    }
    const supportedRawHDRVideoSet = new Set(supportedRawHDRVideoCodecs);
    const rawHDRVideo = {} as Record<CustomRawHDRVideoCodec, CustomRawHDRVideoCodecCapability>;
    for (const codec of CUSTOM_RAW_HDR_VIDEO_CODECS) {
        const supported = supportedRawHDRVideoSet.has(codec);
        rawHDRVideo[codec] = {
            bitDepth: 10,
            codec,
            codecString: codec,
            format: 'I420P10',
            reason: supported ? 'output-copy-supported' : 'output-copy-unsupported',
            status: supported ? 'supported' : 'unsupported'
        };
    }
    const nativeUltraHDVideoCapabilityHarness = createNativeUltraHDVideoCapabilityHarness(supportedNativeUltraHDVideoCodecs);
    const fivePointOneHarness = createNativeSurroundAudioCapabilityHarness(supportedNativeSurroundAudioCodecs, 6);
    const sevenPointOneHarness = createNativeSurroundAudioCapabilityHarness(supportedNativeSevenPointOneAudioCodecs, 8);
    return {
        audio,
        h264Profiles: createH264ProfileCapabilities(supportedVideoSet.has('h264')),
        nativeDolbyVisionHEVC: {
            bitDepth: 10,
            codec: 'hevc',
            codecString: 'hev1.2.4.H150.B0',
            profile: 5,
            reason: nativeDolbyVisionSupported ? 'decode-output-verified' : 'decode-output-missing',
            status: nativeDolbyVisionSupported ? 'supported' : 'unsupported'
        },
        ...(fivePointOneHarness.capabilities ? { nativeSurroundAudio: fivePointOneHarness.capabilities } : {}),
        ...(sevenPointOneHarness.capabilities ? { nativeSevenPointOneAudio: sevenPointOneHarness.capabilities } : {}),
        ...nativeUltraHDVideoCapabilityHarness.capabilityProperties,
        rawHDRVideo,
        telemetry: {
            audioProbeCount: CUSTOM_WEB_CODECS_AUDIO_CODECS.length,
            mediabunnyAudioCodecCount: CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS.length,
            nativeSurroundAudioProbeCount: fivePointOneHarness.probeCount + sevenPointOneHarness.probeCount,
            nativeHDRVideoProbeCount: 0,
            nativeUltraHDVideoProbeCount: nativeUltraHDVideoCapabilityHarness.probeCount,
            rawHDRVideoProbeCount: CUSTOM_RAW_HDR_VIDEO_CODECS.length - 1,
            reason: 'complete',
            supportedAudioCodecCount: supportedAudioCodecs.length,
            supportedNativeSurroundAudioCodecCount: supportedNativeSurroundAudioCodecs.length + supportedNativeSevenPointOneAudioCodecs.length,
            supportedNativeHDRVideoCodecCount: 0,
            supportedNativeUltraHDVideoCodecCount: supportedNativeUltraHDVideoCodecs.length,
            supportedRawHDRVideoCodecCount: supportedRawHDRVideoCodecs.length,
            supportedVideoCodecCount: supportedVideoCodecs.length,
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

function createNativeMediaAudioCapabilities(supportedRoutes: ReadonlySet<string>): NativeMediaAudioCapabilities {
    const audio = {} as Record<NativeMediaAudioCodec, NativeMediaAudioCodecCapability>;
    for (const codec of [ 'ac3', 'eac3' ] as const) {
        const codecString = codec === 'ac3' ? 'ac-3' : 'ec-3';
        const mimeType = `audio/mp4; codecs="${codecString}"`;
        const layouts = {} as Record<NativeMediaAudioChannelCount, NativeMediaAudioLayoutCapability>;
        let codecSupported = false;
        for (const channelCount of [ 2, 6 ] as const) {
            const supported = supportedRoutes.has(`${codec}:${channelCount}:48000`);
            codecSupported ||= supported;
            layouts[channelCount] = {
                channelCount,
                codec,
                codecString,
                mimeType,
                reason: supported ? 'decoded-playback-advanced' : 'playback-not-advanced',
                sampleRate: 48_000,
                status: supported ? 'supported' : 'unsupported'
            };
        }
        audio[codec] = {
            codec,
            codecString,
            layouts,
            mimeType,
            status: codecSupported ? 'supported' : 'unsupported'
        };
    }
    return {
        audio,
        telemetry: {
            probeCount: 4,
            supportedLayoutCount: supportedRoutes.size,
            unknownLayoutCount: 0
        }
    };
}

function createBaseProfile(): DeviceProfile {
    return {
        CodecProfiles: [ {
            Codec: 'h264',
            Conditions: [ {
                Condition: 'LessThanEqual',
                IsRequired: false,
                Property: 'VideoBitDepth',
                Value: '8'
            } ],
            Type: 'Video'
        } ],
        ContainerProfiles: [ {
            Conditions: [ {
                Condition: 'LessThanEqual',
                IsRequired: false,
                Property: 'NumStreams',
                Value: '32'
            } ],
            Container: 'mp4',
            Type: 'Video'
        } ],
        DirectPlayProfiles: [ {
            AudioCodec: 'aac',
            Container: 'mp4',
            Type: 'Video',
            VideoCodec: 'h264'
        } ],
        Name: 'HTML profile',
        SubtitleProfiles: [ { Format: 'vtt', Method: 'External' } ],
        TranscodingProfiles: [ {
            AudioCodec: 'aac',
            Conditions: [ {
                Condition: 'LessThanEqual',
                IsRequired: false,
                Property: 'AudioChannels',
                Value: '2'
            } ],
            Container: 'mp4',
            Protocol: 'hls',
            Type: 'Video',
            VideoCodec: 'h264'
        } ]
    };
}

type AudioRouteVector = {
    channelCount: number
    profile: string | null
    sampleRate: number
};

const TARGET_NEUTRAL_AUDIO_SAMPLE_RATE_CONDITIONS: readonly ProfileCondition[] = [
    {
        Condition: 'NotEquals',
        IsRequired: true,
        Property: 'AudioSampleRate',
        Value: '0'
    }
];

function getAudioRouteConditionValue(condition: ProfileCondition, route: AudioRouteVector): string | null {
    switch (condition.Property) {
        case 'AudioChannels':
            return String(route.channelCount);
        case 'AudioProfile':
            return route.profile;
        case 'AudioSampleRate':
            return String(route.sampleRate);
        default:
            throw new TypeError(`Unexpected audio route property: ${condition.Property}`);
    }
}

function isAudioRouteConditionSatisfied(condition: ProfileCondition, route: AudioRouteVector): boolean {
    const currentValue = getAudioRouteConditionValue(condition, route);
    if (currentValue === null) {
        return condition.IsRequired !== true;
    }
    const expectedValues = (condition.Value ?? '').split('|');
    switch (condition.Condition) {
        case 'Equals':
            return currentValue.toLowerCase() === expectedValues[0]?.toLowerCase();
        case 'EqualsAny':
            return expectedValues.some(expectedValue => (
                currentValue.toLowerCase() === expectedValue.toLowerCase()
            ));
        case 'GreaterThanEqual':
            return Number(currentValue) >= Number(expectedValues[0]);
        case 'LessThanEqual':
            return Number(currentValue) <= Number(expectedValues[0]);
        case 'NotEquals':
            return currentValue.toLowerCase() !== expectedValues[0]?.toLowerCase();
        default:
            throw new TypeError(`Unexpected audio route condition: ${condition.Condition}`);
    }
}

function acceptsMeasuredAudioRoute(
    codecProfiles: readonly CodecProfile[],
    codec: CustomAudioCodec,
    route: AudioRouteVector
): boolean {
    const applicableProfiles: CodecProfile[] = [];
    for (const codecProfile of codecProfiles) {
        if (codecProfile.Type !== 'VideoAudio'
            || !codecProfile.Container?.split(',').includes('mkv')
            || !codecProfile.Codec?.split(',').includes(codec)
            || !(codecProfile.ApplyConditions ?? []).every(condition => (
                isAudioRouteConditionSatisfied(condition, route)
            ))) {
            continue;
        }
        applicableProfiles.push(codecProfile);
    }
    for (const codecProfile of applicableProfiles) {
        if (!codecProfile.Conditions?.every(condition => (
            isAudioRouteConditionSatisfied(condition, route)
        ))) {
            return false;
        }
    }
    return applicableProfiles.length > 0;
}

// An exact route whose only depth is 0 rejects its profile and range pair
function isRejectedRouteProfile(codecProfile: CodecProfile): boolean {
    return codecProfile.Conditions?.some(condition => (
        condition.Property === 'VideoBitDepth' && condition.Value === '0'
    )) === true;
}

function getAppliedTranscodeAudioSampleRates(
    codecProfiles: readonly CodecProfile[],
    targetCodec: CustomAudioCodec,
    route: AudioRouteVector
): number[] {
    const sampleRates: number[] = [];
    for (const codecProfile of codecProfiles) {
        if (codecProfile.Type !== 'VideoAudio'
            || !codecProfile.Container?.split(',').includes('mkv')
            || !codecProfile.Codec?.split(',').includes(targetCodec)
            || !(codecProfile.ApplyConditions ?? []).every(condition => (
                isAudioRouteConditionSatisfied(condition, route)
            ))) {
            continue;
        }
        for (const condition of codecProfile.Conditions ?? []) {
            if (condition.Property !== 'AudioSampleRate'
                || (condition.Condition !== 'Equals'
                    && condition.Condition !== 'LessThanEqual')) {
                continue;
            }
            const sampleRate: number = Number(condition.Value);
            if (Number.isSafeInteger(sampleRate)) {
                sampleRates.push(sampleRate);
            }
        }
    }
    return sampleRates;
}

describe('augmentDeviceProfileForCustomDecode', () => {
    it('advertises every container codec composition the engine and the packages of the other codecs decode', () => {
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            createCapabilities({ supportedVideoCodecs: ENGINE_VIDEO_CODECS, supportedAudioCodecs: ENGINE_AUDIO_CODECS }),
            { decoderPackages: PACKAGE_CODEC_DECODER_PACKAGES }
        );

        for (const rule of CUSTOM_CONTAINER_CODEC_RULES) {
            const expectedContainer: string = rule.profileContainers.join(',');
            for (const videoCodec of rule.videoCodecs) {
                for (const audioCodec of rule.audioCodecs) {
                    const routePresent: boolean = result.profile.DirectPlayProfiles?.some(profile => (
                        profile.Type === 'Video'
                        && profile.Container === expectedContainer
                        && profile.VideoCodec?.split(',').includes(videoCodec) === true
                        && profile.AudioCodec?.split(',').includes(audioCodec) === true
                    )) === true;
                    expect(routePresent, `Missing ${expectedContainer}/${videoCodec}/${audioCodec}`).toBe(true);
                }
            }
        }
    });

    it('advertises MPEG-2 from its decoder package at its depth and either scan, in every container that carries it', () => {
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            createCapabilities({ supportedVideoCodecs: [], supportedAudioCodecs: [ 'aac' ] }),
            { decoderPackages: [ MPEG2_DECODER_PACKAGE ] }
        );

        const measuredProfile = result.profile.CodecProfiles?.find(profile => profile.Codec === 'mpeg2video');
        expect(measuredProfile).toEqual({
            Codec: 'mpeg2video',
            Conditions: [
                { Condition: 'EqualsAny', IsRequired: true, Property: 'VideoRangeType', Value: 'SDR' },
                { Condition: 'Equals', IsRequired: true, Property: 'VideoBitDepth', Value: '8' }
            ],
            Container: getCustomVideoCodecContainers('mpeg2video'),
            Type: 'Video'
        });
    });

    it.each([ 'ac3', 'eac3' ] as const)(
        'advertises VC-1 and WMV3 from their decoder package at either scan, with %s audio from its package',
        (audioCodec) => {
            const result = augmentDeviceProfileForCustomDecode(
                createBaseProfile(),
                createCapabilities({ supportedVideoCodecs: [], supportedAudioCodecs: [] }),
                { decoderPackages: [ VC1_DECODER_PACKAGE, EAC3_DECODER_PACKAGE ] }
            );

            expect(result.profile.DirectPlayProfiles?.some(profile => (
                profile.Container === 'mkv'
                && profile.VideoCodec?.split(',').includes('vc1') === true
                && profile.AudioCodec?.split(',').includes(audioCodec) === true
            ))).toBe(true);
            for (const codec of VC1_DECODER_PACKAGE.codecs) {
                expect(result.profile.CodecProfiles?.find(profile => profile.Codec === codec)).toEqual({
                    Codec: codec,
                    Conditions: [
                        { Condition: 'EqualsAny', IsRequired: true, Property: 'VideoRangeType', Value: 'SDR' },
                        { Condition: 'Equals', IsRequired: true, Property: 'VideoBitDepth', Value: '8' }
                    ],
                    Container: getCustomVideoCodecContainers(codec as CustomVideoCodec),
                    Type: 'Video'
                });
            }
        }
    );

    it('advertises MPEG-4 Part 2, H.263, and MS-MPEG4 from their decoder package in AVI, Matroska, and MP4 as 8-bit SDR', () => {
        const withoutPackage = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            createCapabilities({ supportedVideoCodecs: [], supportedAudioCodecs: [ 'aac', 'mp3' ] }),
            {}
        );
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            createCapabilities({ supportedVideoCodecs: [], supportedAudioCodecs: [ 'aac', 'mp3' ] }),
            { decoderPackages: [ MPEG4_DECODER_PACKAGE ] }
        );

        const advertises = (profile: typeof result.profile, container: string, codec: string): boolean => (
            profile.DirectPlayProfiles?.some(directPlay => (
                directPlay.Container?.split(',').includes(container) === true
                && directPlay.VideoCodec?.split(',').includes(codec) === true
            )) === true
        );
        for (const codec of MPEG4_DECODER_PACKAGE.codecs) {
            expect(advertises(result.profile, 'avi', codec), `avi/${codec}`).toBe(true);
            expect(advertises(result.profile, 'mkv', codec), `mkv/${codec}`).toBe(true);
            expect(advertises(result.profile, 'mp4', codec), `mp4/${codec}`).toBe([ 'mpeg4', 'h263' ].includes(codec));
            expect(advertises(withoutPackage.profile, 'avi', codec), `no package avi/${codec}`).toBe(false);
            expect(advertises(withoutPackage.profile, 'mkv', codec), `no package mkv/${codec}`).toBe(false);
            expect(withoutPackage.profile.CodecProfiles?.some(profile => profile.Codec === codec)).toBe(false);
            expect(result.profile.CodecProfiles?.find(profile => profile.Codec === codec)).toEqual({
                Codec: codec,
                Conditions: [
                    { Condition: 'EqualsAny', IsRequired: true, Property: 'VideoRangeType', Value: 'SDR' },
                    { Condition: 'Equals', IsRequired: true, Property: 'VideoBitDepth', Value: '8' }
                ],
                Container: getCustomVideoCodecContainers(codec as CustomVideoCodec),
                Type: 'Video'
            });
        }
    });

    it('advertises JPEG 2000 from its decoder package as progressive only, since it codes interlaced fields apart', () => {
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            createCapabilities({ supportedVideoCodecs: [], supportedAudioCodecs: [ 'aac' ] }),
            { decoderPackages: [ JPEG2000_DECODER_PACKAGE ] }
        );

        expect(result.profile.CodecProfiles?.find(profile => profile.Codec === 'jpeg2000')).toEqual({
            Codec: 'jpeg2000',
            Conditions: [
                { Condition: 'EqualsAny', IsRequired: true, Property: 'VideoRangeType', Value: 'SDR' },
                { Condition: 'EqualsAny', IsRequired: true, Property: 'VideoBitDepth', Value: '8|10|12' },
                { Condition: 'Equals', IsRequired: true, Property: 'IsInterlaced', Value: 'false' }
            ],
            Container: getCustomVideoCodecContainers('jpeg2000'),
            Type: 'Video'
        });
    });

    it('sanitizes a non-custom WebGPU selection profile without mutation', () => {
        const original = createBaseProfile();
        original.MaxStreamingBitrate = 20_000_000;
        original.MaxStaticBitrate = 40_000_000;

        const result = createBitrateIndependentDeviceProfile(original);

        expect(result).not.toBe(original);
        expect(result.MaxStreamingBitrate).toBeNull();
        expect(result.MaxStaticBitrate).toBeNull();
        expect(original.MaxStreamingBitrate).toBe(20_000_000);
        expect(original.MaxStaticBitrate).toBe(40_000_000);
    });

    it('sanitizes an initial profile even when no custom codec is supported', () => {
        const original = createBaseProfile();
        original.MaxStreamingBitrate = 20_000_000;

        const result = augmentDeviceProfileForCustomDecode(original, createCapabilities({ supportedVideoCodecs: [], supportedAudioCodecs: [] }));

        expect(result.telemetry.reason).toBe('no-supported-codecs');
        expect(result.profile.MaxStreamingBitrate).toBeNull();
        expect(original.MaxStreamingBitrate).toBe(20_000_000);
    });

    it('advertises exact HEVC Main from its decoder package when native HEVC is unavailable', () => {
        const capabilities = createCapabilities({ supportedVideoCodecs: [], supportedAudioCodecs: [ 'aac' ] });

        const unpackagedResult = augmentDeviceProfileForCustomDecode(createBaseProfile(), capabilities);
        const result = augmentDeviceProfileForCustomDecode(createBaseProfile(), capabilities, { decoderPackages: [ HEVC_DECODER_PACKAGE ] });

        expect(unpackagedResult.telemetry.supportedVideoCodecs).not.toContain('hevc');
        expect(result.telemetry.supportedVideoCodecs).toContain('hevc');
        const hevcProfile = result.profile.CodecProfiles?.find(profile => (
            profile.Codec === 'hevc'
            && profile.Conditions?.some(condition => (
                condition.Property === 'VideoProfile'
                && condition.Value === 'main'
            ))
        ));
        expect(hevcProfile).toBeDefined();
        // The package route carries no frame-size cap, and no stock native runtime condition carries over
        expect(hevcProfile?.Conditions?.some(condition => (
            condition.Property === 'Width'
            || condition.Property === 'Height'
            || condition.Property === 'VideoLevel'
            || condition.Property === 'VideoFramerate'
        ))).toBe(false);
    });

    it('advertises the HEVC decoder package routes at any frame size', () => {
        // Without native HEVC, Main and Main 10 both decode through the package into the frame pool, which may present HDR here
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            withUnqualifiedHEVCRangeExtensions(createCapabilities({ supportedVideoCodecs: [], supportedAudioCodecs: [ 'aac' ] })),
            {
                allowFramePoolHDR: true,
                decoderPackages: [ HEVC_DECODER_PACKAGE ]
            }
        );
        const eightKOverrides = { Height: ULTRA_HD_8K_HEIGHT, Width: ULTRA_HD_8K_WIDTH };

        expect(isDirectPlayAdvertised(result.profile, createVideoStream('hevc', 'Main', 8, 'SDR', eightKOverrides))).toBe(true);
        expect(isDirectPlayAdvertised(result.profile, createVideoStream('hevc', 'Main 10', 10, 'HDR10', {
            ...eightKOverrides,
            ColorPrimaries: 'bt2020',
            ColorSpace: 'bt2020nc',
            ColorTransfer: 'smpte2084',
            VideoRange: 'HDR'
        }))).toBe(true);
    });

    it('removes all bitrate inputs from WebGPU playback negotiation', () => {
        const original = createBaseProfile();
        original.MaxStreamingBitrate = 20_000_000;
        original.MaxStaticBitrate = 40_000_000;
        original.MaxStaticMusicBitrate = 8_000_000;
        original.CodecProfiles?.[0].Conditions?.push({
            Condition: 'LessThanEqual',
            IsRequired: true,
            Property: 'VideoBitrate',
            Value: '12000000'
        });
        if (original.CodecProfiles?.[0]) {
            original.CodecProfiles[0].ApplyConditions = [ {
                Condition: 'LessThanEqual',
                IsRequired: true,
                Property: 'VideoBitrate',
                Value: '12000000'
            } ];
        }
        original.CodecProfiles?.push({
            Codec: 'aac',
            Conditions: [ {
                Condition: 'LessThanEqual',
                IsRequired: true,
                Property: 'AudioBitrate',
                Value: '384000'
            } ],
            Type: 'VideoAudio'
        });
        original.ContainerProfiles?.[0].Conditions?.push({
            Condition: 'LessThanEqual',
            IsRequired: true,
            Property: 'VideoBitrate',
            Value: '12000000'
        });

        const result = augmentDeviceProfileForCustomDecode(original, createCapabilities({ supportedVideoCodecs: [ 'h264' ], supportedAudioCodecs: [ 'aac' ] }));

        expect(result.profile.MaxStreamingBitrate).toBeNull();
        expect(result.profile.MaxStaticBitrate).toBeNull();
        expect(result.profile.MaxStaticMusicBitrate).toBeNull();
        expect(result.profile.CodecProfiles?.some(profile => (
            [ ...(profile.ApplyConditions ?? []), ...(profile.Conditions ?? []) ]
                .some(condition => (
                    condition.Property === 'AudioBitrate'
                    || condition.Property === 'VideoBitrate'
                ))
        ))).toBe(false);
        expect(result.profile.ContainerProfiles?.some(profile => (
            profile.Conditions?.some(condition => (
                condition.Property === 'AudioBitrate'
                || condition.Property === 'VideoBitrate'
            ))
        ))).toBe(false);
        expect(original.MaxStreamingBitrate).toBe(20_000_000);
        expect(original.CodecProfiles?.[0].Conditions).toEqual(expect.arrayContaining([
            expect.objectContaining({ Property: 'VideoBitrate' })
        ]));
    });

    it('advertises only H264 profiles with verified decoder output', () => {
        const capabilities = createCapabilities({ supportedVideoCodecs: [ 'h264' ], supportedAudioCodecs: [ 'aac' ] });
        const h264Profiles = capabilities.h264Profiles as H264ProfileCapabilities;
        capabilities.h264Profiles = {
            ...h264Profiles,
            'constrained-baseline': {
                ...h264Profiles['constrained-baseline'],
                evidence: 'none',
                reason: 'config-unsupported',
                status: 'unsupported'
            },
            high: {
                ...h264Profiles.high,
                evidence: 'configuration',
                reason: 'config-supported-only',
                status: 'unknown'
            },
            main: {
                ...h264Profiles.main,
                evidence: 'none',
                reason: 'config-unsupported',
                status: 'unsupported'
            }
        };

        const result = augmentDeviceProfileForCustomDecode(createBaseProfile(), capabilities);
        const measuredH264Profile = result.profile.CodecProfiles?.find(profile => (
            profile.Codec === 'h264'
            && profile.Container === getCustomVideoCodecContainers('h264')
            && profile.Conditions?.some(condition => condition.Property === 'VideoRangeType')
        ));
        expect(measuredH264Profile?.Conditions).toContainEqual(expect.objectContaining({
            Property: 'VideoProfile',
            Value: 'baseline'
        }));
    });

    it('does not advertise H264 from a generic config result without exact output evidence', () => {
        const capabilities = createCapabilities({ supportedVideoCodecs: [ 'h264' ], supportedAudioCodecs: [ 'aac' ] });
        delete capabilities.h264Profiles;

        const result = augmentDeviceProfileForCustomDecode(createBaseProfile(), capabilities);

        expect(result.telemetry.supportedVideoCodecs).toEqual([]);
        expect(result.profile.DirectPlayProfiles).toEqual(createBaseProfile().DirectPlayProfiles);
    });

    it.each([
        { codec: 'vp9', profile: 'profile 0' },
        { codec: 'av1', profile: 'main' }
    ] as const)(
        'advertises a dimension-neutral native Ultra HD $codec route',
        ({ codec, profile }) => {
            const capabilities = createCapabilities({ supportedVideoCodecs: [], supportedAudioCodecs: [ 'aac' ], supportedNativeUltraHDVideoCodecs: [ codec ] });

            const result = augmentDeviceProfileForCustomDecode(createBaseProfile(), capabilities);
            const measuredProfile = result.profile.CodecProfiles?.find(codecProfile => (
                codecProfile.Codec === codec
                && codecProfile.Conditions?.some(condition => (
                    condition.Property === 'VideoRangeType'
                    && condition.Value === 'SDR'
                ))
            ));

            expect(measuredProfile?.Conditions).toEqual(expect.arrayContaining([
                expect.objectContaining({ Property: 'VideoBitDepth', Value: '8' }),
                expect.objectContaining({ Property: 'VideoRangeType', Value: 'SDR' }),
                expect.objectContaining({ Property: 'VideoProfile', Value: profile })
            ]));
            expect(measuredProfile?.Conditions?.some(condition => (
                condition.Property === 'Width'
                || condition.Property === 'Height'
                || condition.Property === 'VideoLevel'
                || condition.Property === 'VideoFramerate'
            ))).toBe(false);
        }
    );

    it('advertises 4K HEVC Main with six-channel E-AC-3 from Ultra HD evidence', () => {
        const capabilities = createCapabilities({ supportedVideoCodecs: [], supportedAudioCodecs: [], supportedNativeUltraHDVideoCodecs: [ 'hevc' ] });

        const result = augmentDeviceProfileForCustomDecode(createBaseProfile(), capabilities, { decoderPackages: [ EAC3_DECODER_PACKAGE ] });
        const codecProfiles = result.profile.CodecProfiles ?? [];
        const measuredHEVCProfile = codecProfiles.find(codecProfile => (
            codecProfile.Codec === 'hevc'
            && codecProfile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value === 'SDR'
            ))
        ));

        expect(result.telemetry.supportedVideoCodecs).toEqual([ 'hevc' ]);
        expect(result.telemetry.supportedAudioCodecs).toEqual([ 'ac3', 'eac3' ]);
        expect(result.profile.DirectPlayProfiles).toContainEqual({
            AudioCodec: 'ac3,eac3',
            Container: 'mkv',
            Type: 'Video',
            VideoCodec: 'hevc'
        });
        expect(measuredHEVCProfile?.Conditions).toEqual(expect.arrayContaining([
            expect.objectContaining({ Property: 'VideoBitDepth', Value: '8' }),
            expect.objectContaining({ Property: 'VideoProfile', Value: 'main' }),
            expect.objectContaining({ Property: 'VideoRangeType', Value: 'SDR' })
        ]));
        expect(measuredHEVCProfile?.Conditions?.some(condition => (
            condition.Property === 'Width'
            || condition.Property === 'Height'
            || condition.Property === 'VideoLevel'
            || condition.Property === 'VideoFramerate'
        ))).toBe(false);
        expect(acceptsMeasuredAudioRoute(codecProfiles, 'eac3', {
            channelCount: 6,
            profile: 'Dolby Digital Plus + Dolby Atmos',
            sampleRate: 48_000
        })).toBe(true);
    });

    it('advertises exact native HEVC Main 10 SDR with six-channel E-AC-3', () => {
        const capabilities = createCapabilities({ supportedVideoCodecs: [], supportedAudioCodecs: [] });
        capabilities.nativeHDRHEVC = {
            bitDepth: 10,
            codec: 'hevc',
            codecString: 'hvc1.2.4.L153.B0',
            reason: 'decode-output-verified',
            status: 'supported'
        };

        const result = augmentDeviceProfileForCustomDecode(createBaseProfile(), capabilities, { decoderPackages: [ EAC3_DECODER_PACKAGE ] });
        const codecProfiles = result.profile.CodecProfiles ?? [];
        const nativeMain10SDRProfile = codecProfiles.find(codecProfile => (
            codecProfile.Codec === 'hevc'
            && codecProfile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value === 'SDR'
            ))
            && codecProfile.Conditions.some(condition => (
                condition.Property === 'VideoBitDepth'
                && condition.Value === '10'
            ))
        ));

        expect(result.telemetry.supportedVideoCodecs).toEqual([ 'hevc' ]);
        expect(result.telemetry.supportedAudioCodecs).toEqual([ 'ac3', 'eac3' ]);
        expect(result.profile.DirectPlayProfiles).toContainEqual({
            AudioCodec: 'ac3,eac3',
            Container: 'mkv',
            Type: 'Video',
            VideoCodec: 'hevc'
        });
        expect(nativeMain10SDRProfile?.Conditions).toEqual(expect.arrayContaining([
            expect.objectContaining({ Property: 'VideoBitDepth', Value: '10' }),
            expect.objectContaining({ Property: 'VideoProfile', Value: 'main 10' }),
            expect.objectContaining({ Property: 'VideoRangeType', Value: 'SDR' })
        ]));
        expect(nativeMain10SDRProfile?.Conditions?.some(condition => (
            condition.Property === 'Width'
            || condition.Property === 'Height'
            || condition.Property === 'VideoLevel'
            || condition.Property === 'VideoFramerate'
            || condition.Property === 'VideoBitrate'
        ))).toBe(false);
        expect(acceptsMeasuredAudioRoute(codecProfiles, 'eac3', {
            channelCount: 6,
            profile: null,
            sampleRate: 48_000
        })).toBe(true);
    });

    it('keeps native HEVC Main and Main 10 SDR as exact alternatives', () => {
        const capabilities = createCapabilities({ supportedVideoCodecs: [], supportedAudioCodecs: [ 'aac' ], supportedNativeUltraHDVideoCodecs: [ 'hevc' ] });
        capabilities.nativeHDRHEVC = {
            bitDepth: 10,
            codec: 'hevc',
            codecString: 'hvc1.2.4.L153.B0',
            reason: 'decode-output-verified',
            status: 'supported'
        };

        const result = augmentDeviceProfileForCustomDecode(createBaseProfile(), capabilities);
        const nativeSDRProfiles = result.profile.CodecProfiles?.filter(codecProfile => (
            codecProfile.Codec === 'hevc'
            && codecProfile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value === 'SDR'
            ))
        )) ?? [];

        expect(nativeSDRProfiles).toHaveLength(2);
        expect(nativeSDRProfiles.map(codecProfile => codecProfile.Conditions)).toEqual(
            expect.arrayContaining([
                expect.arrayContaining([
                    expect.objectContaining({ Property: 'VideoBitDepth', Value: '8' }),
                    expect.objectContaining({ Property: 'VideoProfile', Value: 'main' })
                ]),
                expect.arrayContaining([
                    expect.objectContaining({ Property: 'VideoBitDepth', Value: '10' }),
                    expect.objectContaining({ Property: 'VideoProfile', Value: 'main 10' })
                ])
            ])
        );
    });

    it('omits native HEVC Main 10 SDR without exact decoded-output evidence', () => {
        const capabilities = createCapabilities({ supportedVideoCodecs: [], supportedAudioCodecs: [ 'aac' ] });
        capabilities.nativeHDRHEVC = {
            bitDepth: 10,
            codec: 'hevc',
            codecString: 'hvc1.2.4.L153.B0',
            reason: 'decode-output-missing',
            status: 'unsupported'
        };

        const result = augmentDeviceProfileForCustomDecode(createBaseProfile(), capabilities);

        expect(result.telemetry.supportedVideoCodecs).not.toContain('hevc');
        expect(result.profile.CodecProfiles?.some(codecProfile => (
            codecProfile.Codec === 'hevc'
            && codecProfile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value === 'SDR'
            ))
            && codecProfile.Conditions.some(condition => (
                condition.Property === 'VideoBitDepth'
                && condition.Value === '10'
            ))
        ))).toBe(false);
        expect(result.profile.DirectPlayProfiles).not.toContainEqual(expect.objectContaining({ VideoCodec: 'hevc' }));
    });

    it('adds only compatible Mediabunny container and codec combinations', () => {
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            createCapabilities({ supportedVideoCodecs: [ 'h264', 'vp8' ], supportedAudioCodecs: [ 'aac', 'vorbis' ] })
        );
        const addedProfiles = result.profile.DirectPlayProfiles?.slice(1) ?? [];

        expect(addedProfiles).toContainEqual({
            AudioCodec: 'aac,vorbis',
            Container: 'mp4,m4v,mov',
            Type: 'Video',
            VideoCodec: 'h264,vp8'
        });
        expect(addedProfiles).toContainEqual({
            AudioCodec: 'vorbis',
            Container: 'webm',
            Type: 'Video',
            VideoCodec: 'vp8'
        });
        expect(addedProfiles).toContainEqual({
            AudioCodec: 'aac',
            Container: 'ts,m2ts,mts',
            Type: 'Video',
            VideoCodec: 'h264'
        });
        // The fork gives Vorbis in AVI the decoder description its extradata holds
        expect(addedProfiles).toContainEqual({
            AudioCodec: 'aac,vorbis',
            Container: 'avi',
            Type: 'Video',
            VideoCodec: 'h264,vp8'
        });
        expect(addedProfiles).not.toContainEqual(expect.objectContaining({
            AudioCodec: expect.stringContaining('aac'),
            Container: 'webm'
        }));
        expect(addedProfiles).not.toContainEqual(expect.objectContaining({
            Container: 'ts,m2ts,mts',
            VideoCodec: expect.stringContaining('vp8')
        }));
        expect(result.telemetry).toMatchObject({
            addedAudioProfileCount: 0,
            addedProfileCount: 5,
            addedVideoProfileCount: 5,
            reason: 'augmented',
            supportedAudioCodecs: [ 'aac', 'vorbis' ],
            supportedVideoCodecs: [ 'h264', 'vp8' ],
            widenedHDRCodecProfileCount: 0
        });
        // Without multichannel evidence the decoded route still covers mono, which the mixer duplicates
        expect(result.profile.CodecProfiles).toContainEqual({
            Codec: 'aac,vorbis',
            Conditions: [
                {
                    Condition: 'EqualsAny',
                    IsRequired: true,
                    Property: 'AudioChannels',
                    Value: '1|2'
                },
                ...TARGET_NEUTRAL_AUDIO_SAMPLE_RATE_CONDITIONS
            ],
            Container: CUSTOM_VIDEO_CONTAINERS,
            Type: 'VideoAudio'
        });
    });

    it.each([ 'aac', 'opus', 'flac', 'vorbis' ] as const)(
        'advertises target-neutral sample rates for qualified native 5.1 %s',
        codec => {
            const result = augmentDeviceProfileForCustomDecode(
                createBaseProfile(),
                createCapabilities({ supportedVideoCodecs: [ 'h264' ], supportedAudioCodecs: [ codec ], supportedNativeSurroundAudioCodecs: [ codec ] })
            );
            const measuredProfile = result.profile.CodecProfiles?.find(profile => (
                profile.Codec === codec
                && profile.Container === CUSTOM_VIDEO_CONTAINERS
            ));

            // Mono, the 3.0 order these decoders produce, stereo, and the measured 5.1 bed
            expect(measuredProfile?.Conditions).toContainEqual({
                Condition: 'EqualsAny',
                IsRequired: true,
                Property: 'AudioChannels',
                Value: '1|2|3|6'
            });
            expect(measuredProfile?.Conditions).toEqual(expect.arrayContaining([ ...TARGET_NEUTRAL_AUDIO_SAMPLE_RATE_CONDITIONS ]));
        }
    );

    it.each([ 'aac', 'opus', 'flac', 'vorbis' ] as const)(
        'advertises 8 channels for %s only with its 7.1 verdict',
        codec => {
            const getChannelCondition = (capabilityOptions: Partial<CapabilityOptions>): unknown => augmentDeviceProfileForCustomDecode(
                createBaseProfile(),
                createCapabilities({ supportedVideoCodecs: [ 'h264' ], supportedAudioCodecs: [ codec ], ...capabilityOptions })
            ).profile.CodecProfiles?.find(profile => (
                profile.Codec === codec
                && profile.Container === CUSTOM_VIDEO_CONTAINERS
            ))?.Conditions?.find(condition => condition.Property === 'AudioChannels')?.Value;

            expect(getChannelCondition({ supportedNativeSurroundAudioCodecs: [ codec ] })).toBe('1|2|3|6');
            expect(getChannelCondition({
                supportedNativeSevenPointOneAudioCodecs: [ codec ],
                supportedNativeSurroundAudioCodecs: [ codec ]
            })).toBe('1|2|3|6|8');
            // The 7.1 verdict alone adds 8 to the channels every decoded route covers, but no 5.1 bed
            expect(getChannelCondition({ supportedNativeSevenPointOneAudioCodecs: [ codec ] })).toBe('1|2|8');
        }
    );

    it('advertises AC-3 codecs from their decoder package only in compatible video containers', () => {
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            createCapabilities({ supportedVideoCodecs: [ 'h264' ], supportedAudioCodecs: [] }),
            { decoderPackages: [ EAC3_DECODER_PACKAGE ] }
        );
        const addedProfiles = result.profile.DirectPlayProfiles?.slice(1) ?? [];

        expect(addedProfiles).toContainEqual({
            AudioCodec: 'ac3,eac3',
            Container: 'mp4,m4v,mov',
            Type: 'Video',
            VideoCodec: 'h264'
        });
        expect(addedProfiles).toContainEqual({
            AudioCodec: 'ac3,eac3',
            Container: 'mkv',
            Type: 'Video',
            VideoCodec: 'h264'
        });
        expect(addedProfiles).toContainEqual({
            AudioCodec: 'ac3,eac3',
            Container: 'ts,m2ts,mts',
            Type: 'Video',
            VideoCodec: 'h264'
        });
        expect(addedProfiles.some(profile => profile.Container === 'webm')).toBe(false);
        expect(result.telemetry.supportedAudioCodecs).toEqual([ 'ac3', 'eac3' ]);
        // Jellyfin reports AC-3 2/1 and 3/0 alike as 3.0, so three-channel AC-3 transcodes
        expect(result.profile.CodecProfiles).toContainEqual({
            Codec: 'ac3',
            Conditions: [
                {
                    Condition: 'EqualsAny',
                    IsRequired: true,
                    Property: 'AudioChannels',
                    Value: '1|2|6'
                },
                ...TARGET_NEUTRAL_AUDIO_SAMPLE_RATE_CONDITIONS
            ],
            Container: CUSTOM_VIDEO_CONTAINERS,
            Type: 'VideoAudio'
        });
        expect(result.profile.CodecProfiles).toContainEqual({
            Codec: 'eac3',
            Conditions: [
                {
                    Condition: 'EqualsAny',
                    IsRequired: true,
                    Property: 'AudioChannels',
                    Value: '1|2|6|8'
                },
                ...TARGET_NEUTRAL_AUDIO_SAMPLE_RATE_CONDITIONS
            ],
            Container: CUSTOM_VIDEO_CONTAINERS,
            Type: 'VideoAudio'
        });
        const codecProfiles = result.profile.CodecProfiles ?? [];
        const sevenPointOneRoute: AudioRouteVector = {
            channelCount: 8,
            profile: null,
            sampleRate: 48_000
        };
        const monoRoute: AudioRouteVector = {
            channelCount: 1,
            profile: null,
            sampleRate: 48_000
        };
        expect(acceptsMeasuredAudioRoute(codecProfiles, 'eac3', sevenPointOneRoute)).toBe(true);
        expect(acceptsMeasuredAudioRoute(codecProfiles, 'ac3', sevenPointOneRoute)).toBe(false);
        expect(acceptsMeasuredAudioRoute(codecProfiles, 'ac3', monoRoute)).toBe(true);
        expect(acceptsMeasuredAudioRoute(codecProfiles, 'eac3', monoRoute)).toBe(true);
        for (const codec of [ 'ac3', 'eac3' ] as const) {
            expect(acceptsMeasuredAudioRoute(codecProfiles, codec, {
                ...monoRoute,
                channelCount: 3
            })).toBe(false);
        }
    });

    it('direct-authorizes ordinary stereo E-AC-3 independently of source bitrate', () => {
        const original = createBaseProfile();
        original.CodecProfiles?.push({
            Codec: 'eac3',
            Conditions: [ {
                Condition: 'LessThanEqual',
                IsRequired: true,
                Property: 'AudioBitrate',
                Value: '128000'
            } ],
            Type: 'VideoAudio'
        });

        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities({ supportedVideoCodecs: [ 'hevc' ], supportedAudioCodecs: [] }),
            { decoderPackages: [ EAC3_DECODER_PACKAGE ] }
        );
        const codecProfiles = result.profile.CodecProfiles ?? [];

        expect(result.profile.DirectPlayProfiles).toContainEqual({
            AudioCodec: 'ac3,eac3',
            Container: 'mkv',
            Type: 'Video',
            VideoCodec: 'hevc'
        });
        expect(acceptsMeasuredAudioRoute(codecProfiles, 'eac3', {
            channelCount: 2,
            profile: null,
            sampleRate: 48_000
        })).toBe(true);
        expect(codecProfiles.some(codecProfile => (
            codecProfile.Codec?.split(',').includes('eac3') === true
            && codecProfile.Conditions?.some(condition => (
                condition.Property === 'AudioBitrate'
            )) === true
        ))).toBe(false);
    });

    it('keeps sample-rate validation target-neutral for server negotiation', () => {
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            createCapabilities({ supportedVideoCodecs: [ 'av1' ], supportedAudioCodecs: [ 'aac', 'opus' ], supportedNativeUltraHDVideoCodecs: [ 'av1' ], supportedNativeSurroundAudioCodecs: [ 'opus' ] }),
            { decoderPackages: [ EAC3_DECODER_PACKAGE ] }
        );
        const codecProfiles = result.profile.CodecProfiles ?? [];
        const stereoRoute: AudioRouteVector = {
            channelCount: 2,
            profile: null,
            sampleRate: 48_000
        };
        const surroundRoute: AudioRouteVector = {
            channelCount: 6,
            profile: null,
            sampleRate: 48_000
        };
        const measuredUltraHDAV1Profile = codecProfiles.find(codecProfile => (
            codecProfile.Codec === 'av1'
            && codecProfile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType' && condition.Value === 'SDR'
            ))
        ));

        expect(getAppliedTranscodeAudioSampleRates(codecProfiles, 'aac', stereoRoute)).toEqual([]);
        expect(getAppliedTranscodeAudioSampleRates(codecProfiles, 'aac', surroundRoute)).toEqual([]);
        expect(acceptsMeasuredAudioRoute(codecProfiles, 'eac3', stereoRoute)).toBe(true);
        expect(acceptsMeasuredAudioRoute(codecProfiles, 'opus', surroundRoute)).toBe(true);
        expect(acceptsMeasuredAudioRoute(codecProfiles, 'eac3', {
            ...stereoRoute,
            sampleRate: 192_001
        })).toBe(true);
        expect(acceptsMeasuredAudioRoute(codecProfiles, 'eac3', {
            ...stereoRoute,
            sampleRate: 2_999
        })).toBe(true);
        expect(codecProfiles.filter(codecProfile => (
            codecProfile.Type === 'VideoAudio'
            && codecProfile.Codec?.split(',').includes('eac3') === true
        ))).toHaveLength(1);
        expect(measuredUltraHDAV1Profile?.Conditions).toContainEqual(expect.objectContaining({
            Property: 'VideoBitDepth',
            Value: '8'
        }));
    });

    it('advertises DTS from its decoder package in Matroska, ISO BMFF, and MPEG-TS with measured beds and runtime rate validation', () => {
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            createCapabilities({ supportedVideoCodecs: [ 'h264' ], supportedAudioCodecs: [] }),
            { decoderPackages: [ DTS_DECODER_PACKAGE ] }
        );
        const addedProfiles = result.profile.DirectPlayProfiles?.slice(1) ?? [];

        expect(addedProfiles).toContainEqual({
            AudioCodec: 'dts',
            Container: 'mkv',
            Type: 'Video',
            VideoCodec: 'h264'
        });
        expect(addedProfiles).toContainEqual({
            AudioCodec: 'dts',
            Container: 'mp4,m4v,mov',
            Type: 'Video',
            VideoCodec: 'h264'
        });
        expect(addedProfiles).toContainEqual({
            AudioCodec: 'dts',
            Container: 'ts,m2ts,mts',
            Type: 'Video',
            VideoCodec: 'h264'
        });
        expect(addedProfiles.some(profile => (
            profile.AudioCodec?.split(',').includes('dts') === true
            && profile.Container !== 'mkv'
            && profile.Container !== 'mp4,m4v,mov'
            && profile.Container !== 'ts,m2ts,mts'
        ))).toBe(false);
        expect(result.profile.CodecProfiles).toContainEqual({
            Codec: 'dts',
            Conditions: [
                {
                    Condition: 'EqualsAny',
                    IsRequired: true,
                    Property: 'AudioChannels',
                    Value: '1|2|3|6|8'
                },
                ...TARGET_NEUTRAL_AUDIO_SAMPLE_RATE_CONDITIONS,
                {
                    Condition: 'EqualsAny',
                    IsRequired: true,
                    Property: 'AudioProfile',
                    Value: 'DTS|DTS 96/24|DTS-HD HRA|DTS-HD MA|DTS-HD MA + DTS:X'
                }
            ],
            Container: DTS_PROFILE_CONTAINERS,
            Type: 'VideoAudio'
        });
        expect(result.profile.CodecProfiles).toContainEqual({
            ApplyConditions: [ {
                Condition: 'GreaterThanEqual',
                IsRequired: true,
                Property: 'AudioSampleRate',
                Value: '96001'
            } ],
            Codec: 'dts',
            Conditions: [
                {
                    Condition: 'Equals',
                    IsRequired: true,
                    Property: 'AudioChannels',
                    Value: '6'
                },
                {
                    Condition: 'EqualsAny',
                    IsRequired: true,
                    Property: 'AudioProfile',
                    Value: 'DTS-HD MA|DTS-HD MA + DTS:X'
                }
            ],
            Container: DTS_PROFILE_CONTAINERS,
            Type: 'VideoAudio'
        });
        expect(result.profile.CodecProfiles).toContainEqual({
            ApplyConditions: [
                {
                    Condition: 'Equals',
                    IsRequired: true,
                    Property: 'AudioChannels',
                    Value: '1'
                }
            ],
            Codec: 'dts',
            Conditions: [ {
                Condition: 'EqualsAny',
                IsRequired: true,
                Property: 'AudioProfile',
                Value: 'DTS|DTS 96/24|DTS-HD HRA|DTS-HD MA|DTS-HD MA + DTS:X'
            } ],
            Container: DTS_PROFILE_CONTAINERS,
            Type: 'VideoAudio'
        });
        expect(result.profile.CodecProfiles).toContainEqual({
            ApplyConditions: [
                {
                    Condition: 'Equals',
                    IsRequired: true,
                    Property: 'AudioChannels',
                    Value: '2'
                }
            ],
            Codec: 'dts',
            Conditions: [ {
                Condition: 'Equals',
                IsRequired: true,
                Property: 'AudioProfile',
                Value: 'DTS-HD MA'
            } ],
            Container: DTS_PROFILE_CONTAINERS,
            Type: 'VideoAudio'
        });
        // Jellyfin cannot express ChannelLayout, so runtime eligibility requires 2.1 or 3.0
        expect(result.profile.CodecProfiles).toContainEqual({
            ApplyConditions: [
                {
                    Condition: 'Equals',
                    IsRequired: true,
                    Property: 'AudioChannels',
                    Value: '3'
                }
            ],
            Codec: 'dts',
            Conditions: [ {
                Condition: 'EqualsAny',
                IsRequired: true,
                Property: 'AudioProfile',
                Value: 'DTS-HD MA|DTS-HD MA + DTS:X'
            } ],
            Container: DTS_PROFILE_CONTAINERS,
            Type: 'VideoAudio'
        });
        expect(result.profile.CodecProfiles).toContainEqual({
            ApplyConditions: [
                {
                    Condition: 'Equals',
                    IsRequired: true,
                    Property: 'AudioChannels',
                    Value: '6'
                }
            ],
            Codec: 'dts',
            Conditions: [ {
                Condition: 'EqualsAny',
                IsRequired: true,
                Property: 'AudioProfile',
                Value: 'DTS|DTS 96/24|DTS-HD HRA|DTS-HD MA|DTS-HD MA + DTS:X'
            } ],
            Container: DTS_PROFILE_CONTAINERS,
            Type: 'VideoAudio'
        });
        expect(result.profile.CodecProfiles).toContainEqual({
            ApplyConditions: [
                {
                    Condition: 'Equals',
                    IsRequired: true,
                    Property: 'AudioChannels',
                    Value: '8'
                }
            ],
            Codec: 'dts',
            Conditions: [ {
                Condition: 'EqualsAny',
                IsRequired: true,
                Property: 'AudioProfile',
                Value: 'DTS-HD HRA|DTS-HD MA|DTS-HD MA + DTS:X'
            } ],
            Container: DTS_PROFILE_CONTAINERS,
            Type: 'VideoAudio'
        });
        const codecProfiles = result.profile.CodecProfiles ?? [];
        for (const route of [
            { channelCount: 1, profile: 'DTS', sampleRate: 48_000 },
            { channelCount: 1, profile: 'DTS-HD MA', sampleRate: 96_000 },
            { channelCount: 3, profile: 'DTS-HD MA', sampleRate: 48_000 },
            { channelCount: 2, profile: 'DTS-HD MA', sampleRate: 48_000 },
            { channelCount: 2, profile: 'DTS-HD MA', sampleRate: 96_000 },
            { channelCount: 6, profile: 'DTS', sampleRate: 48_000 },
            { channelCount: 6, profile: 'DTS 96/24', sampleRate: 96_000 },
            { channelCount: 6, profile: 'DTS-HD HRA', sampleRate: 48_000 },
            { channelCount: 8, profile: 'DTS-HD HRA', sampleRate: 48_000 },
            { channelCount: 8, profile: 'DTS-HD MA', sampleRate: 96_000 },
            { channelCount: 6, profile: 'DTS-HD MA', sampleRate: 96_001 },
            { channelCount: 6, profile: 'DTS-HD MA + DTS:X', sampleRate: 192_000 },
            { channelCount: 6, profile: 'DTS', sampleRate: 12_345 },
            { channelCount: 6, profile: 'DTS', sampleRate: 2_999 }
        ]) {
            expect(acceptsMeasuredAudioRoute(codecProfiles, 'dts', route)).toBe(true);
        }
        for (const route of [
            { channelCount: 3, profile: 'DTS', sampleRate: 48_000 },
            { channelCount: 3, profile: 'DTS-HD HRA', sampleRate: 48_000 },
            { channelCount: 2, profile: 'DTS', sampleRate: 48_000 },
            { channelCount: 2, profile: 'DTS-HD HRA', sampleRate: 48_000 },
            { channelCount: 2, profile: 'DTS-HD MA', sampleRate: 96_001 },
            { channelCount: 7, profile: 'DTS-ES', sampleRate: 48_000 },
            { channelCount: 7, profile: 'DTS-ES', sampleRate: 96_000 },
            { channelCount: 7, profile: 'DTS-HD MA', sampleRate: 48_000 },
            { channelCount: 8, profile: 'DTS-HD MA', sampleRate: 96_001 },
            { channelCount: 8, profile: 'DTS-HD HRA', sampleRate: 96_001 },
            { channelCount: 8, profile: 'DTS-HD MA', sampleRate: 192_000 },
            { channelCount: 8, profile: 'DTS', sampleRate: 48_000 },
            { channelCount: 6, profile: null, sampleRate: 96_000 },
            { channelCount: 6, profile: 'DTS', sampleRate: 192_000 },
            { channelCount: 6, profile: 'DTS', sampleRate: 192_001 }
        ]) {
            expect(acceptsMeasuredAudioRoute(codecProfiles, 'dts', route)).toBe(false);
        }
        expect(result.telemetry.supportedAudioCodecs).toEqual([ 'dts' ]);
    });

    it('does not advertise DTS without a DTS decoder package', () => {
        const capabilities = createCapabilities({ supportedVideoCodecs: [ 'h264' ], supportedAudioCodecs: [] });

        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            capabilities,
            { decoderPackages: [ EAC3_DECODER_PACKAGE, TRUEHD_DECODER_PACKAGE ] }
        );

        expect(result.telemetry.supportedAudioCodecs).not.toContain('dts');
        expect(result.profile.DirectPlayProfiles?.some(profile => (
            profile.AudioCodec?.split(',').includes('dts') === true
        ))).toBe(false);
        expect(result.profile.CodecProfiles?.some(profile => (
            profile.Codec?.split(',').includes('dts') === true
        ))).toBe(false);
    });

    it('advertises TrueHD from its decoder package in Matroska and ISO BMFF with measured beds and runtime rate validation', () => {
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            createCapabilities({ supportedVideoCodecs: [ 'h264' ], supportedAudioCodecs: [] }),
            { decoderPackages: [ TRUEHD_DECODER_PACKAGE ] }
        );
        const addedProfiles = result.profile.DirectPlayProfiles?.slice(1) ?? [];

        // The package decodes MLP too, which only Matroska carries
        expect(addedProfiles).toContainEqual({
            AudioCodec: 'mlp,truehd',
            Container: 'mkv',
            Type: 'Video',
            VideoCodec: 'h264'
        });
        expect(addedProfiles).toContainEqual({
            AudioCodec: 'truehd',
            Container: 'mp4,m4v,mov',
            Type: 'Video',
            VideoCodec: 'h264'
        });
        expect(addedProfiles.some(profile => (
            profile.AudioCodec?.split(',').includes('truehd') === true
            && profile.Container !== 'mkv'
            && profile.Container !== 'mp4,m4v,mov'
        ))).toBe(false);
        expect(result.profile.CodecProfiles).toContainEqual({
            Codec: 'truehd',
            Conditions: [
                {
                    Condition: 'EqualsAny',
                    IsRequired: true,
                    Property: 'AudioChannels',
                    Value: '1|2|6|8'
                },
                ...TARGET_NEUTRAL_AUDIO_SAMPLE_RATE_CONDITIONS
            ],
            Container: 'mp4,m4v,mov,mkv',
            Type: 'VideoAudio'
        });
        expect(result.profile.CodecProfiles).toContainEqual({
            ApplyConditions: [ {
                Condition: 'Equals',
                IsRequired: true,
                Property: 'AudioChannels',
                Value: '8'
            } ],
            Codec: 'truehd',
            Conditions: [ {
                Condition: 'Equals',
                IsRequired: true,
                Property: 'AudioSampleRate',
                Value: '48000'
            } ],
            Container: 'mp4,m4v,mov,mkv',
            Type: 'VideoAudio'
        });
        const codecProfiles = result.profile.CodecProfiles ?? [];
        expect(acceptsMeasuredAudioRoute(codecProfiles, 'truehd', {
            channelCount: 1,
            profile: null,
            sampleRate: 96_000
        })).toBe(true);
        expect(acceptsMeasuredAudioRoute(codecProfiles, 'truehd', {
            channelCount: 3,
            profile: null,
            sampleRate: 48_000
        })).toBe(false);
        expect(acceptsMeasuredAudioRoute(codecProfiles, 'truehd', {
            channelCount: 2,
            profile: null,
            sampleRate: 48_000
        })).toBe(true);
        expect(acceptsMeasuredAudioRoute(codecProfiles, 'truehd', {
            channelCount: 6,
            profile: null,
            sampleRate: 96_000
        })).toBe(true);
        expect(acceptsMeasuredAudioRoute(codecProfiles, 'truehd', {
            channelCount: 6,
            profile: null,
            sampleRate: 192_000
        })).toBe(true);
        expect(acceptsMeasuredAudioRoute(codecProfiles, 'truehd', {
            channelCount: 2,
            profile: null,
            sampleRate: 96_000
        })).toBe(true);
        expect(acceptsMeasuredAudioRoute(codecProfiles, 'truehd', {
            channelCount: 6,
            profile: null,
            sampleRate: 48_000
        })).toBe(true);
        expect(acceptsMeasuredAudioRoute(codecProfiles, 'truehd', {
            channelCount: 8,
            profile: 'Dolby TrueHD + Dolby Atmos',
            sampleRate: 48_000
        })).toBe(true);
        expect(acceptsMeasuredAudioRoute(codecProfiles, 'truehd', {
            channelCount: 8,
            profile: 'Dolby TrueHD + Dolby Atmos',
            sampleRate: 96_000
        })).toBe(false);
        expect(acceptsMeasuredAudioRoute(codecProfiles, 'truehd', {
            channelCount: 6,
            profile: null,
            sampleRate: 192_001
        })).toBe(true);
        expect(result.telemetry.supportedAudioCodecs).toEqual([ 'mlp', 'truehd' ]);
    });

    it('advertises the measured MLP bed from the TrueHD decoder package across bounded source rates', () => {
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            createCapabilities({ supportedVideoCodecs: [ 'h264' ], supportedAudioCodecs: [] }),
            { decoderPackages: [ TRUEHD_DECODER_PACKAGE ] }
        );
        const codecProfiles = result.profile.CodecProfiles ?? [];

        expect(result.profile.DirectPlayProfiles).toContainEqual({
            AudioCodec: 'mlp,truehd',
            Container: 'mkv',
            Type: 'Video',
            VideoCodec: 'h264'
        });
        // MLP has no ISO BMFF sample entry, so it stays Matroska-only
        expect(result.profile.DirectPlayProfiles?.some(profile => (
            profile.AudioCodec?.split(',').includes('mlp') === true
            && profile.Container !== 'mkv'
        ))).toBe(false);
        expect(acceptsMeasuredAudioRoute(codecProfiles, 'mlp', {
            channelCount: 1,
            profile: null,
            sampleRate: 48_000
        })).toBe(true);
        expect(acceptsMeasuredAudioRoute(codecProfiles, 'mlp', {
            channelCount: 2,
            profile: null,
            sampleRate: 48_000
        })).toBe(true);
        expect(acceptsMeasuredAudioRoute(codecProfiles, 'mlp', {
            channelCount: 6,
            profile: null,
            sampleRate: 48_000
        })).toBe(false);
        expect(acceptsMeasuredAudioRoute(codecProfiles, 'mlp', {
            channelCount: 2,
            profile: null,
            sampleRate: 96_000
        })).toBe(true);
        expect(result.telemetry.supportedAudioCodecs).toEqual([ 'mlp', 'truehd' ]);
    });

    it('does not advertise TrueHD or MLP without a TrueHD decoder package', () => {
        const capabilities = createCapabilities({ supportedVideoCodecs: [ 'h264' ], supportedAudioCodecs: [] });

        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            capabilities,
            { decoderPackages: [ EAC3_DECODER_PACKAGE, DTS_DECODER_PACKAGE ] }
        );

        for (const codec of TRUEHD_DECODER_PACKAGE.codecs) {
            expect(result.telemetry.supportedAudioCodecs).not.toContain(codec);
            expect(result.profile.DirectPlayProfiles?.some(profile => (
                profile.AudioCodec?.split(',').includes(codec) === true
            ))).toBe(false);
            expect(result.profile.CodecProfiles?.some(profile => (
                profile.Codec?.split(',').includes(codec) === true
            ))).toBe(false);
        }
    });

    it('advertises Mediabunny PCM containers, layouts, and bounded rates', () => {
        const supportedPCMCodecs = [
            'pcm_s24le',
            'pcm_s8',
            'pcm_alaw'
        ] as const;
        const result = augmentDeviceProfileForCustomDecode(createBaseProfile(), createCapabilities({ supportedVideoCodecs: [ 'h264' ], supportedAudioCodecs: supportedPCMCodecs }));
        const addedProfiles = result.profile.DirectPlayProfiles?.slice(1) ?? [];

        expect(addedProfiles).toContainEqual({
            AudioCodec: 'pcm_s24le',
            Container: 'mp4,m4v,mov',
            Type: 'Video',
            VideoCodec: 'h264'
        });
        expect(addedProfiles).toContainEqual({
            AudioCodec: 'pcm_s24le,pcm_s8,pcm_alaw',
            Container: 'mov',
            Type: 'Video',
            VideoCodec: 'h264'
        });
        expect(addedProfiles).toContainEqual({
            AudioCodec: 'pcm_s24le',
            Container: 'mkv',
            Type: 'Video',
            VideoCodec: 'h264'
        });
        expect(addedProfiles).not.toContainEqual({
            AudioCodec: expect.stringContaining('pcm_s8'),
            Container: 'mkv',
            Type: 'Video',
            VideoCodec: 'h264'
        });
        expect(result.profile.CodecProfiles).toContainEqual({
            Codec: supportedPCMCodecs.join(','),
            Conditions: [
                {
                    Condition: 'EqualsAny',
                    IsRequired: true,
                    Property: 'AudioChannels',
                    Value: '1|2|3|6'
                },
                ...TARGET_NEUTRAL_AUDIO_SAMPLE_RATE_CONDITIONS
            ],
            Container: CUSTOM_VIDEO_CONTAINERS,
            Type: 'VideoAudio'
        });
    });

    it('replaces browser secondary-audio limits only on measured custom routes', () => {
        const original = createBaseProfile();
        original.DirectPlayProfiles = [ {
            AudioCodec: 'aac,eac3,dts',
            Container: 'mkv',
            Type: 'Video',
            VideoCodec: 'h264'
        } ];
        original.CodecProfiles = [
            {
                Codec: 'aac',
                Conditions: [
                    {
                        Condition: 'NotEquals',
                        Property: 'AudioProfile',
                        Value: 'HE-AAC'
                    },
                    {
                        Condition: 'Equals',
                        IsRequired: false,
                        Property: 'IsSecondaryAudio',
                        Value: 'false'
                    }
                ],
                Type: 'VideoAudio'
            },
            {
                Conditions: [
                    {
                        Condition: 'LessThanEqual',
                        IsRequired: false,
                        Property: 'AudioChannels',
                        Value: '2'
                    },
                    {
                        Condition: 'Equals',
                        IsRequired: false,
                        Property: 'IsSecondaryAudio',
                        Value: 'false'
                    }
                ],
                Type: 'VideoAudio'
            }
        ];

        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities({ supportedVideoCodecs: [ 'h264' ], supportedAudioCodecs: [ 'aac' ] }),
            { decoderPackages: [ EAC3_DECODER_PACKAGE ] }
        );

        expect(result.profile.CodecProfiles).toContainEqual({
            Codec: 'aac',
            Conditions: [ {
                Condition: 'NotEquals',
                Property: 'AudioProfile',
                Value: 'HE-AAC'
            } ],
            Container: CUSTOM_VIDEO_CONTAINERS,
            Type: 'VideoAudio'
        });
        expect(result.profile.CodecProfiles).toContainEqual({
            Codec: 'dts',
            Conditions: original.CodecProfiles[1].Conditions,
            Container: CUSTOM_VIDEO_CONTAINERS,
            Type: 'VideoAudio'
        });
        expect(result.profile.CodecProfiles).toContainEqual({
            ...original.CodecProfiles[1],
            Container: NON_CUSTOM_VIDEO_CONTAINERS
        });

        const measuredEAC3Profile = result.profile.CodecProfiles?.find(profile => (
            profile.Codec === 'eac3'
            && profile.Container === CUSTOM_VIDEO_CONTAINERS
        ));
        expect(measuredEAC3Profile?.Conditions).toContainEqual(expect.objectContaining({
            Property: 'AudioChannels',
            Value: '1|2|6|8'
        }));
    });

    it('replaces a browser exact-48-kHz constraint on a decoded custom route', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'aac',
            Conditions: [
                {
                    Condition: 'Equals',
                    IsRequired: true,
                    Property: 'AudioChannels',
                    Value: '2'
                },
                {
                    Condition: 'Equals',
                    IsRequired: true,
                    Property: 'AudioSampleRate',
                    Value: '48000'
                }
            ],
            Type: 'VideoAudio'
        } ];

        const result = augmentDeviceProfileForCustomDecode(original, createCapabilities({ supportedVideoCodecs: [ 'h264' ], supportedAudioCodecs: [ 'aac' ] }));

        expect(result.profile.CodecProfiles).toContainEqual({
            Codec: 'aac',
            Conditions: [
                {
                    Condition: 'EqualsAny',
                    IsRequired: true,
                    Property: 'AudioChannels',
                    Value: '1|2'
                },
                ...TARGET_NEUTRAL_AUDIO_SAMPLE_RATE_CONDITIONS
            ],
            Container: CUSTOM_VIDEO_CONTAINERS,
            Type: 'VideoAudio'
        });
        expect(result.profile.CodecProfiles).toContainEqual({
            ...original.CodecProfiles[0],
            Container: NON_CUSTOM_VIDEO_CONTAINERS
        });
    });

    it('does not apply an HTML bit-depth ceiling to decoded FLAC routes', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'flac',
            Conditions: [
                {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'AudioBitDepth',
                    Value: '16'
                },
                {
                    Condition: 'Equals',
                    IsRequired: true,
                    Property: 'AudioSampleRate',
                    Value: '48000'
                }
            ],
            Type: 'VideoAudio'
        } ];

        const result = augmentDeviceProfileForCustomDecode(original, createCapabilities({ supportedVideoCodecs: [ 'h264' ], supportedAudioCodecs: [ 'flac' ] }));
        const customFLACProfiles = result.profile.CodecProfiles?.filter(profile => (
            profile.Codec === 'flac'
            && profile.Container === CUSTOM_VIDEO_CONTAINERS
        )) ?? [];

        expect(customFLACProfiles).toContainEqual({
            Codec: 'flac',
            Conditions: [
                {
                    Condition: 'EqualsAny',
                    IsRequired: true,
                    Property: 'AudioChannels',
                    Value: '1|2'
                },
                ...TARGET_NEUTRAL_AUDIO_SAMPLE_RATE_CONDITIONS
            ],
            Container: CUSTOM_VIDEO_CONTAINERS,
            Type: 'VideoAudio'
        });
        expect(customFLACProfiles.some(profile => profile.Conditions?.some(condition => (
            condition.Property === 'AudioBitDepth'
        )))).toBe(false);
        expect(result.profile.CodecProfiles).toContainEqual({
            ...original.CodecProfiles[0],
            Container: NON_CUSTOM_VIDEO_CONTAINERS
        });
    });

    it('advertises native AC-3 routes only at their exact measured layouts', () => {
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            createCapabilities({ supportedVideoCodecs: [ 'h264' ], supportedAudioCodecs: [] }),
            {
                nativeMediaAudioCapabilities: createNativeMediaAudioCapabilities(
                    new Set([ 'ac3:2:48000', 'eac3:2:48000', 'eac3:6:48000' ])
                )
            }
        );

        expect(result.telemetry.supportedAudioCodecs).toEqual([ 'ac3', 'eac3' ]);
        expect(result.profile.CodecProfiles).toContainEqual({
            Codec: 'ac3',
            Conditions: [
                {
                    Condition: 'Equals',
                    IsRequired: true,
                    Property: 'AudioChannels',
                    Value: '2'
                },
                {
                    Condition: 'Equals',
                    IsRequired: true,
                    Property: 'AudioSampleRate',
                    Value: '48000'
                }
            ],
            Container: CUSTOM_VIDEO_CONTAINERS,
            Type: 'VideoAudio'
        });
        expect(result.profile.CodecProfiles).toContainEqual({
            Codec: 'eac3',
            Conditions: [
                {
                    Condition: 'EqualsAny',
                    IsRequired: true,
                    Property: 'AudioChannels',
                    Value: '2|6'
                },
                {
                    Condition: 'Equals',
                    IsRequired: true,
                    Property: 'AudioSampleRate',
                    Value: '48000'
                }
            ],
            Container: CUSTOM_VIDEO_CONTAINERS,
            Type: 'VideoAudio'
        });
        expect(result.profile.DirectPlayProfiles).toContainEqual(expect.objectContaining({
            AudioCodec: 'ac3,eac3',
            Container: 'mkv',
            VideoCodec: 'h264'
        }));
    });

    it('lets bounded package-decoded Dolby routes supersede exact native rate profiles', () => {
        const original = createBaseProfile();
        if (!original.CodecProfiles) {
            throw new Error('The base profile codec constraints are unavailable');
        }
        original.CodecProfiles.push({
            Codec: 'ac3',
            Conditions: [
                {
                    Condition: 'Equals',
                    IsRequired: true,
                    Property: 'AudioChannels',
                    Value: '2'
                },
                {
                    Condition: 'Equals',
                    IsRequired: true,
                    Property: 'AudioSampleRate',
                    Value: '48000'
                }
            ],
            Type: 'VideoAudio'
        });
        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities({ supportedVideoCodecs: [ 'h264' ], supportedAudioCodecs: [] }),
            {
                decoderPackages: [ EAC3_DECODER_PACKAGE ],
                nativeMediaAudioCapabilities: createNativeMediaAudioCapabilities(
                    new Set([ 'ac3:2:48000', 'eac3:2:48000', 'eac3:6:48000' ])
                )
            }
        );
        const dolbyProfiles = result.profile.CodecProfiles?.filter(profile => (
            profile.Codec?.split(',').some(codec => codec === 'ac3' || codec === 'eac3')
            && profile.Container === CUSTOM_VIDEO_CONTAINERS
        )) ?? [];

        expect(dolbyProfiles).toContainEqual({
            Codec: 'ac3',
            Conditions: [
                {
                    Condition: 'EqualsAny',
                    IsRequired: true,
                    Property: 'AudioChannels',
                    Value: '1|2|6'
                },
                ...TARGET_NEUTRAL_AUDIO_SAMPLE_RATE_CONDITIONS
            ],
            Container: CUSTOM_VIDEO_CONTAINERS,
            Type: 'VideoAudio'
        });
        expect(dolbyProfiles).toContainEqual({
            Codec: 'eac3',
            Conditions: [
                {
                    Condition: 'EqualsAny',
                    IsRequired: true,
                    Property: 'AudioChannels',
                    Value: '1|2|6|8'
                },
                ...TARGET_NEUTRAL_AUDIO_SAMPLE_RATE_CONDITIONS
            ],
            Container: CUSTOM_VIDEO_CONTAINERS,
            Type: 'VideoAudio'
        });
        expect(dolbyProfiles.some(profile => (
            profile.Conditions?.some(condition => (
                condition.Property === 'AudioSampleRate'
                && condition.Condition === 'Equals'
                && condition.Value === '48000'
            )) === true
        ))).toBe(false);
    });

    it('widens raw HDR ranges only for supported high-bit-depth codec families', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'h264,hevc,vp9,av1',
            Conditions: [
                {
                    Condition: 'EqualsAny',
                    IsRequired: false,
                    Property: 'VideoRangeType',
                    Value: 'SDR'
                },
                {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'VideoLevel',
                    Value: '120'
                }
            ],
            Type: 'Video'
        } ];

        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities({ supportedVideoCodecs: [ 'h264', 'hevc', 'vp9' ], supportedAudioCodecs: [ 'aac' ], supportedRawHDRVideoCodecs: [ 'hevc', 'vp9' ] }),
            RAW_HDR_PROFILE_OPTIONS
        );

        expect(result.profile.CodecProfiles).toContainEqual(expect.objectContaining({
            Codec: 'hevc',
            Conditions: expect.arrayContaining([
                expect.objectContaining({
                    Property: 'VideoRangeType',
                    Value: 'SDR|HDR10|HLG|HDR10Plus'
                })
            ]),
            Container: 'mp4,m4v,mov,mkv,avi,ts,m2ts,mts'
        }));
        expect(result.profile.CodecProfiles).toContainEqual(expect.objectContaining({
            Codec: 'vp9',
            Conditions: expect.arrayContaining([
                expect.objectContaining({
                    Property: 'VideoRangeType',
                    Value: 'SDR|HDR10|HLG|HDR10Plus'
                })
            ]),
            Container: getCustomVideoCodecContainers('vp9')
        }));
        // VP9 splits into exact profile and range pairs, where HDR10+ follows HDR10 onto the raw route
        expect(result.profile.CodecProfiles?.some(profile => (
            profile.Codec === 'vp9'
            && !isRejectedRouteProfile(profile)
            && profile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value?.includes('HDR10Plus')
            ))
        ))).toBe(true);
        expect(result.profile.CodecProfiles?.some(profile => (
            profile.Codec === 'hevc'
            && profile.Container === 'mj2,webm'
            && profile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value?.includes('HDR')
            ))
        ))).toBe(false);
        expect(result.profile.CodecProfiles?.some(profile => (
            profile.Codec === 'vp9'
            && profile.Container === 'mj2,ts,m2ts,mts'
            && profile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value?.includes('HDR')
            ))
        ))).toBe(false);
        expect(result.telemetry.widenedHDRCodecProfileCount).toBe(2);
    });

    it('keeps raw HDR widening route-scoped without source runtime ceilings', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'hevc,vp9',
            Conditions: [ {
                Condition: 'EqualsAny',
                IsRequired: false,
                Property: 'VideoRangeType',
                Value: 'SDR'
            } ],
            Type: 'Video'
        } ];

        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities({ supportedVideoCodecs: [ 'hevc', 'vp9' ], supportedAudioCodecs: [ 'aac' ], supportedRawHDRVideoCodecs: [ 'hevc', 'vp9' ] }),
            RAW_HDR_PROFILE_OPTIONS
        );

        expect(result.profile.CodecProfiles).toContainEqual(expect.objectContaining({
            Codec: 'hevc',
            Conditions: expect.arrayContaining([ expect.objectContaining({
                Property: 'VideoRangeType',
                Value: 'SDR|HDR10|HLG|HDR10Plus'
            }) ]),
            Container: 'mp4,m4v,mov,mkv,avi,ts,m2ts,mts'
        }));
        expect(result.profile.CodecProfiles).toContainEqual(expect.objectContaining({
            Codec: 'vp9',
            Conditions: expect.arrayContaining([ expect.objectContaining({
                Property: 'VideoRangeType',
                Value: 'SDR|HDR10|HLG|HDR10Plus'
            }) ]),
            Container: getCustomVideoCodecContainers('vp9')
        }));
        expect(result.profile.CodecProfiles?.some(profile => (
            profile.Codec === 'hevc'
            && profile.Container === 'mj2,webm'
            && profile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value?.includes('HDR')
            ))
        ))).toBe(false);
        expect(result.profile.CodecProfiles?.some(profile => (
            profile.Codec === 'vp9'
            && profile.Container === 'mj2,ts,m2ts,mts'
            && profile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value?.includes('HDR')
            ))
        ))).toBe(false);
    });

    it('removes narrower HTML dimensions from the authorized native HDR route', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'hevc',
            Conditions: [
                {
                    Condition: 'EqualsAny',
                    IsRequired: false,
                    Property: 'VideoRangeType',
                    Value: 'SDR'
                },
                {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'VideoLevel',
                    Value: '120'
                },
                {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'Width',
                    Value: '1920'
                },
                {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'Height',
                    Value: '1080'
                },
                {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'VideoLevel',
                    Value: '120'
                },
                {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'VideoFramerate',
                    Value: '30'
                }
            ],
            Type: 'Video'
        } ];
        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities({ supportedVideoCodecs: [], supportedAudioCodecs: [], nativeDolbyVisionSupported: true }),
            { allowNativeDolbyVision: true, allowRawHDR: false, decoderPackages: [ EAC3_DECODER_PACKAGE ] }
        );
        const widenedProfile = result.profile.CodecProfiles?.find(profile => (
            profile.Codec === 'hevc'
            && profile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value === 'DOVI'
            ))
        ));

        expect(widenedProfile?.Conditions?.some(condition => (
            condition.Property === 'Width'
            || condition.Property === 'Height'
            || condition.Property === 'VideoLevel'
            || condition.Property === 'VideoFramerate'
        ))).toBe(false);
        expect(original.CodecProfiles[0].Conditions).toEqual(expect.arrayContaining([
            expect.objectContaining({ Property: 'VideoLevel', Value: '120' }),
            expect.objectContaining({ Property: 'Width', Value: '1920' }),
            expect.objectContaining({ Property: 'Height', Value: '1080' })
        ]));
    });

    it('does not export raw HDR vector geometry or frame rate as source ceilings', () => {
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            createCapabilities({ supportedVideoCodecs: [ 'vp9' ], supportedAudioCodecs: [ 'opus' ], supportedRawHDRVideoCodecs: [ 'vp9' ] }),
            RAW_HDR_PROFILE_OPTIONS
        );

        // Native and raw VP9 routes split into exact profile and range pairs, one per raw HDR range
        const rawHDRProfiles = result.profile.CodecProfiles?.filter(profile => (
            profile.Codec === 'vp9'
            && !isRejectedRouteProfile(profile)
            && profile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && (condition.Value === 'HDR10' || condition.Value === 'HLG')
            ))
        )) ?? [];
        expect(rawHDRProfiles).toHaveLength(2);
        expect(rawHDRProfiles.some(rawHDRProfile => rawHDRProfile.Conditions?.some(condition => (
            condition.Property === 'Width'
            || condition.Property === 'Height'
            || condition.Property === 'VideoLevel'
            || condition.Property === 'VideoFramerate'
        )))).toBe(false);
    });

    it('rejects unsupported native raw HDR qualification evidence', () => {
        const capabilities = createCapabilities({ supportedVideoCodecs: [ 'vp9' ], supportedAudioCodecs: [ 'opus' ], supportedRawHDRVideoCodecs: [ 'vp9' ] });
        capabilities.rawHDRVideo = {
            ...capabilities.rawHDRVideo,
            vp9: {
                ...capabilities.rawHDRVideo.vp9,
                reason: 'output-copy-unsupported',
                status: 'unsupported'
            }
        };

        const result = augmentDeviceProfileForCustomDecode(createBaseProfile(), capabilities, RAW_HDR_PROFILE_OPTIONS);

        const rawHDRProfile = result.profile.CodecProfiles?.find(profile => (
            profile.Codec === 'vp9'
            && profile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value?.includes('HDR10')
            ))
        ));
        expect(rawHDRProfile).toBeUndefined();
    });

    it('advertises only settled authorized HDR range types and exact progressive metadata', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'hevc',
            Conditions: [
                {
                    Condition: 'EqualsAny',
                    IsRequired: false,
                    Property: 'VideoRangeType',
                    Value: 'SDR'
                },
                {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'Width',
                    Value: '1920'
                },
                {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'Height',
                    Value: '1080'
                },
                {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'VideoLevel',
                    Value: '120'
                },
                {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'VideoFramerate',
                    Value: '30'
                }
            ],
            Type: 'Video'
        } ];
        const capabilities = createCapabilities({ supportedVideoCodecs: [ 'hevc' ], supportedAudioCodecs: [ 'aac' ], supportedRawHDRVideoCodecs: [ 'hevc' ] });

        const missingAuthorization = augmentDeviceProfileForCustomDecode(original, capabilities, { allowRawHDR: true });
        expect(missingAuthorization.telemetry.widenedHDRCodecProfileCount).toBe(0);
        expect(missingAuthorization.profile.CodecProfiles?.some(profile => (
            profile.Conditions?.some(condition => condition.Value?.includes('HDR10'))
        ))).toBe(false);

        const pqAuthorization = augmentDeviceProfileForCustomDecode(
            original,
            capabilities,
            {
                allowRawHDR: true,
                authorizedRawHDRRouteKeys: [
                    RAW_PQ_ROUTE_KEY
                ]
            }
        );
        const authorizedProfile = pqAuthorization.profile.CodecProfiles?.find(profile => (
            profile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value === 'SDR|HDR10|HDR10Plus'
            ))
        ));
        expect(authorizedProfile).toBeDefined();
        expect(authorizedProfile?.Conditions?.some(condition => (
            condition.Property === 'Width'
            || condition.Property === 'Height'
            || condition.Property === 'VideoLevel'
            || condition.Property === 'VideoFramerate'
        ))).toBe(false);
        expect(pqAuthorization.profile.CodecProfiles).toContainEqual(expect.objectContaining({
            Codec: 'hevc',
            Conditions: expect.arrayContaining([
                expect.objectContaining({ Property: 'Width', Value: '1920' }),
                expect.objectContaining({ Property: 'Height', Value: '1080' }),
                expect.objectContaining({ Property: 'VideoLevel', Value: '120' }),
                expect.objectContaining({ Property: 'VideoFramerate', Value: '30' })
            ]),
            Container: NON_CUSTOM_VIDEO_CONTAINERS
        }));
        expect(pqAuthorization.profile.CodecProfiles?.some(profile => (
            profile.Conditions?.some(condition => condition.Value?.includes('HLG'))
        ))).toBe(false);
        expect(pqAuthorization.profile.CodecProfiles?.some(profile => (
            profile.Conditions?.some(condition => (
                condition.Property === 'IsInterlaced'
                && condition.Condition === 'Equals'
                && condition.Value === 'false'
            ))
        ))).toBe(true);
    });

    it('advertises a dimension-neutral native Main10 route only when authorized', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'hevc',
            Conditions: [
                {
                    Condition: 'EqualsAny',
                    IsRequired: false,
                    Property: 'VideoRangeType',
                    Value: 'SDR'
                },
                {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'Width',
                    Value: '1920'
                },
                {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'Height',
                    Value: '1080'
                },
                {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'VideoLevel',
                    Value: '120'
                },
                {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'VideoFramerate',
                    Value: '30'
                }
            ],
            Type: 'Video'
        } ];
        const capabilities = createCapabilities({ supportedVideoCodecs: [], supportedAudioCodecs: [ 'flac' ], supportedRawHDRVideoCodecs: [ 'hevc' ] });
        capabilities.nativeHDRHEVC = {
            bitDepth: 10,
            codec: 'hevc',
            codecString: 'hvc1.2.4.L153.B0',
            reason: 'decode-output-verified',
            status: 'supported'
        };

        const missingAuthorization = augmentDeviceProfileForCustomDecode(
            original,
            capabilities,
            { allowNativeHDR: true, allowRawHDR: false }
        );
        expect(missingAuthorization.profile.CodecProfiles?.some(profile => (
            profile.Conditions?.some(condition => condition.Value?.includes('HDR10'))
        ))).toBe(false);

        const result = augmentDeviceProfileForCustomDecode(
            original,
            capabilities,
            {
                allowNativeHDR: true,
                allowRawHDR: false,
                authorizedExternalHDRRouteKeys: [
                    'external-hevc-main10-bt709-limited:pq-v1'
                ]
            }
        );
        const nativeHDRProfile = result.profile.CodecProfiles?.find(profile => (
            profile.Codec === 'hevc'
            && profile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value === 'HDR10|HDR10Plus'
            ))
            && profile.Conditions.some(condition => (
                condition.Property === 'IsInterlaced'
                && condition.Value === 'false'
            ))
        ));

        expect(nativeHDRProfile?.Conditions).toEqual(expect.arrayContaining([
            expect.objectContaining({ Property: 'VideoBitDepth', Value: '10' }),
            expect.objectContaining({ Property: 'VideoProfile', Value: 'main 10' })
        ]));
        expect(nativeHDRProfile?.Conditions?.some(condition => (
            condition.Property === 'Width'
            || condition.Property === 'Height'
            || condition.Property === 'VideoLevel'
            || condition.Property === 'VideoFramerate'
        ))).toBe(false);
        expect(result.profile.CodecProfiles?.some(profile => (
            profile.Conditions?.some(condition => condition.Value?.includes('HLG'))
        ))).toBe(false);
        expect(nativeHDRProfile?.Conditions).toEqual(expect.arrayContaining([
            expect.objectContaining({
                Property: 'VideoRangeType',
                Value: 'HDR10|HDR10Plus'
            })
        ]));
        expect(result.profile.DirectPlayProfiles).toContainEqual(expect.objectContaining({
            AudioCodec: expect.stringContaining('flac'),
            Container: 'mkv',
            VideoCodec: 'hevc'
        }));
    });

    it('keeps native and raw HDR routes dimension-neutral', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'hevc',
            Conditions: [ {
                Condition: 'EqualsAny',
                IsRequired: false,
                Property: 'VideoRangeType',
                Value: 'SDR'
            } ],
            Type: 'Video'
        } ];
        const capabilities = createCapabilities({ supportedVideoCodecs: [ 'hevc' ], supportedAudioCodecs: [ 'flac' ], supportedRawHDRVideoCodecs: [ 'hevc' ] });
        capabilities.nativeHDRHEVC = {
            bitDepth: 10,
            codec: 'hevc',
            codecString: 'hvc1.2.4.L153.B0',
            reason: 'decode-output-verified',
            status: 'supported'
        };

        const result = augmentDeviceProfileForCustomDecode(
            original,
            capabilities,
            {
                allowNativeHDR: true,
                allowRawHDR: true,
                authorizedExternalHDRRouteKeys: [
                    'external-hevc-main10-bt709-limited:hlg-v1'
                ],
                authorizedRawHDRRouteKeys: [
                    RAW_PQ_ROUTE_KEY
                ]
            }
        );
        const sharedProfile = result.profile.CodecProfiles?.find(profile => (
            profile.Codec === 'hevc'
            && profile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value === 'SDR|HDR10|HDR10Plus|HLG'
            ))
        ));
        const nativeHLGProfile = result.profile.CodecProfiles?.find(profile => (
            profile.Codec === 'hevc'
            && profile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value === 'HLG'
            ))
        ));
        const rawPQProfile = result.profile.CodecProfiles?.find(profile => (
            profile.Codec === 'hevc'
            && profile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value === 'HDR10|HDR10Plus'
            ))
        ));

        expect(sharedProfile?.Conditions?.some(condition => (
            condition.Property === 'Width'
            || condition.Property === 'Height'
            || condition.Property === 'VideoLevel'
            || condition.Property === 'VideoFramerate'
        ))).toBe(false);
        expect(nativeHLGProfile?.Conditions?.some(condition => (
            condition.Property === 'Width'
            || condition.Property === 'Height'
            || condition.Property === 'VideoLevel'
            || condition.Property === 'VideoFramerate'
        ))).toBe(false);
        expect(rawPQProfile?.Conditions?.some(condition => (
            condition.Property === 'Width'
            || condition.Property === 'Height'
            || condition.Property === 'VideoLevel'
            || condition.Property === 'VideoFramerate'
        ))).toBe(false);
    });

    it('advertises authorized Dolby Vision ranges only for raw HEVC', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'hevc,vp9',
            Conditions: [ {
                Condition: 'EqualsAny',
                IsRequired: false,
                Property: 'VideoRangeType',
                Value: 'SDR'
            } ],
            Type: 'Video'
        } ];
        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities({ supportedVideoCodecs: [ 'hevc', 'vp9' ], supportedAudioCodecs: [ 'aac' ], supportedRawHDRVideoCodecs: [ 'hevc', 'vp9' ] }),
            { allowDolbyVision: true, allowRawHDR: false }
        );
        const HEVCProfiles = result.profile.CodecProfiles?.filter(profile => (
            profile.Codec?.split(',').includes('hevc')
        )) ?? [];
        const VP9Profiles = result.profile.CodecProfiles?.filter(profile => (
            profile.Codec?.split(',').includes('vp9')
        )) ?? [];

        // RPU reconstruction also presents the compatibility IDs Jellyfin labels DOVIInvalid
        expect(HEVCProfiles.some(profile => profile.Conditions?.some(condition => (
            condition.Property === 'VideoRangeType'
            && condition.Value === 'SDR|DOVI|DOVIWithHDR10|DOVIWithHLG|DOVIWithSDR|DOVIWithHDR10Plus|DOVIInvalid'
        )))).toBe(true);
        expect(VP9Profiles.some(profile => profile.Conditions?.some(condition => (
            condition.Value?.includes('DOVI')
        )))).toBe(false);
    });

    it('advertises Profile 7 only through its separately authorized EL range', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'hevc',
            Conditions: [ {
                Condition: 'EqualsAny',
                IsRequired: false,
                Property: 'VideoRangeType',
                Value: 'SDR'
            } ],
            Type: 'Video'
        } ];
        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities({ supportedVideoCodecs: [ 'hevc' ], supportedAudioCodecs: [ 'aac' ], supportedRawHDRVideoCodecs: [ 'hevc' ] }),
            { allowDolbyVisionProfile7: true, allowRawHDR: false }
        );
        const rangeValues = result.profile.CodecProfiles
            ?.flatMap(profile => profile.Conditions ?? [])
            .filter(condition => condition.Property === 'VideoRangeType')
            .map(condition => condition.Value) ?? [];

        expect(rangeValues.some(value => value?.includes('DOVIWithEL'))).toBe(true);
        expect(rangeValues.some(value => value?.includes('DOVIWithELHDR10Plus'))).toBe(true);
        expect(rangeValues.some(value => value?.includes('DOVIWithHDR10'))).toBe(false);
        expect(rangeValues.some(value => value?.includes('DOVIWithHLG'))).toBe(false);
    });

    it('adds HDR10 only for an exact item-scoped separate Profile 7 base route', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'hevc',
            Conditions: [ {
                Condition: 'EqualsAny',
                IsRequired: false,
                Property: 'VideoRangeType',
                Value: 'SDR'
            } ],
            Type: 'Video'
        } ];
        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities({ supportedVideoCodecs: [ 'hevc' ], supportedAudioCodecs: [ 'aac' ], supportedRawHDRVideoCodecs: [ 'hevc' ] }),
            {
                allowDolbyVisionProfile7: true,
                allowDolbyVisionProfile7HDR10Base: true,
                allowRawHDR: false
            }
        );
        const rangeValues = result.profile.CodecProfiles
            ?.flatMap(profile => profile.Conditions ?? [])
            .filter(condition => condition.Property === 'VideoRangeType')
            .map(condition => condition.Value) ?? [];

        expect(rangeValues).toContain('SDR|DOVIWithEL|DOVIWithELHDR10Plus|HDR10');
        expect(rangeValues).toContain('DOVIWithEL|DOVIWithELHDR10Plus|HDR10');
        expect(rangeValues.some(value => value?.includes('HLG'))).toBe(false);
    });

    it('uses a dimension-neutral native HDR envelope for a Profile 7 HDR10 base', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'hevc',
            Conditions: [ {
                Condition: 'EqualsAny',
                IsRequired: false,
                Property: 'VideoRangeType',
                Value: 'SDR'
            } ],
            Type: 'Video'
        } ];
        const capabilities = createCapabilities({ supportedVideoCodecs: [ 'hevc' ], supportedAudioCodecs: [ 'flac' ], supportedRawHDRVideoCodecs: [ 'hevc' ] });
        capabilities.nativeHDRHEVC = {
            bitDepth: 10,
            codec: 'hevc',
            codecString: 'hvc1.2.4.L153.B0',
            reason: 'decode-output-verified',
            status: 'supported'
        };

        const result = augmentDeviceProfileForCustomDecode(
            original,
            capabilities,
            {
                allowDolbyVisionProfile7: true,
                allowNativeDolbyVisionProfile7HDR10Base: true,
                allowNativeHDR: true,
                allowRawHDR: false,
                authorizedExternalHDRRouteKeys: [
                    'external-hevc-main10-bt709-limited:pq-v1'
                ]
            }
        );
        const profile7Profiles = result.profile.CodecProfiles?.filter(profile => (
            profile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value?.includes('DOVIWithEL')
            ))
        )) ?? [];

        expect(profile7Profiles.length).toBeGreaterThan(0);
        expect(profile7Profiles.some(profile => profile.Conditions?.some(condition => (
            condition.Property === 'VideoRangeType'
            && condition.Value?.includes('DOVIWithELHDR10Plus')
        )))).toBe(true);
        expect(profile7Profiles.some(profile => profile.Conditions?.some(condition => (
            condition.Property === 'Width'
            || condition.Property === 'Height'
            || condition.Property === 'VideoLevel'
            || condition.Property === 'VideoFramerate'
        )))).toBe(false);
    });

    it('uses a dimension-neutral native HDR envelope for a Profile 8.1 HDR10 base', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'hevc',
            Conditions: [ {
                Condition: 'EqualsAny',
                IsRequired: false,
                Property: 'VideoRangeType',
                Value: 'SDR'
            } ],
            Type: 'Video'
        } ];
        const capabilities = createCapabilities({ supportedVideoCodecs: [ 'hevc' ], supportedAudioCodecs: [], supportedRawHDRVideoCodecs: [ 'hevc' ] });
        capabilities.nativeHDRHEVC = {
            bitDepth: 10,
            codec: 'hevc',
            codecString: 'hvc1.2.4.L153.B0',
            reason: 'decode-output-verified',
            status: 'supported'
        };

        const result = augmentDeviceProfileForCustomDecode(
            original,
            capabilities,
            {
                allowDolbyVision: true,
                allowNativeDolbyVisionProfile8HDR10Base: true,
                allowNativeHDR: true,
                allowRawHDR: false,
                authorizedExternalHDRRouteKeys: [
                    'external-hevc-main10-bt709-limited:pq-v1'
                ],
                decoderPackages: [ TRUEHD_DECODER_PACKAGE ]
            }
        );
        const profile8Profiles = result.profile.CodecProfiles?.filter(profile => (
            profile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value?.includes('DOVIWithHDR10')
            ))
        )) ?? [];

        expect(profile8Profiles.length).toBeGreaterThan(0);
        expect(profile8Profiles.some(profile => profile.Conditions?.some(condition => (
            condition.Property === 'VideoRangeType'
            && condition.Value?.includes('DOVIWithHDR10Plus')
        )))).toBe(true);
        expect(profile8Profiles.every(profile => !profile.Conditions?.some(condition => (
            condition.Property === 'Width'
            || condition.Property === 'Height'
            || condition.Property === 'VideoLevel'
            || condition.Property === 'VideoFramerate'
        )))).toBe(true);
    });

    it('uses only the authorized native HLG envelope for a Profile 8.4 base', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'hevc',
            Conditions: [ {
                Condition: 'EqualsAny',
                IsRequired: false,
                Property: 'VideoRangeType',
                Value: 'SDR'
            } ],
            Type: 'Video'
        } ];
        const capabilities = createCapabilities({ supportedVideoCodecs: [ 'hevc' ], supportedAudioCodecs: [ 'aac' ], supportedRawHDRVideoCodecs: [ 'hevc' ] });
        capabilities.nativeHDRHEVC = {
            bitDepth: 10,
            codec: 'hevc',
            codecString: 'hvc1.2.4.L153.B0',
            reason: 'decode-output-verified',
            status: 'supported'
        };

        const result = augmentDeviceProfileForCustomDecode(
            original,
            capabilities,
            {
                allowNativeDolbyVisionProfile8HLGBase: true,
                allowNativeHDR: true,
                allowRawHDR: false,
                authorizedExternalHDRRouteKeys: [
                    'external-hevc-main10-bt709-limited:hlg-v1'
                ]
            }
        );
        const profile8Profiles = result.profile.CodecProfiles?.filter(profile => (
            profile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value?.includes('DOVIWithHLG')
            ))
        )) ?? [];
        const rangeValues = result.profile.CodecProfiles
            ?.flatMap(profile => profile.Conditions ?? [])
            .filter(condition => condition.Property === 'VideoRangeType')
            .map(condition => condition.Value) ?? [];

        expect(profile8Profiles.length).toBeGreaterThan(0);
        expect(profile8Profiles.every(profile => !profile.Conditions?.some(condition => (
            condition.Property === 'Width'
            || condition.Property === 'Height'
            || condition.Property === 'VideoLevel'
            || condition.Property === 'VideoFramerate'
        )))).toBe(true);
        expect(rangeValues.some(value => value?.includes('DOVIWithHDR10'))).toBe(false);
    });

    it('does not authorize a Profile 8.4 HLG base with only the PQ route', () => {
        const capabilities = createCapabilities({ supportedVideoCodecs: [ 'hevc' ], supportedAudioCodecs: [ 'aac' ], supportedRawHDRVideoCodecs: [ 'hevc' ] });
        capabilities.nativeHDRHEVC = {
            bitDepth: 10,
            codec: 'hevc',
            codecString: 'hvc1.2.4.L153.B0',
            reason: 'decode-output-verified',
            status: 'supported'
        };

        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            capabilities,
            {
                allowNativeDolbyVisionProfile8HLGBase: true,
                allowNativeHDR: true,
                allowRawHDR: false,
                authorizedExternalHDRRouteKeys: [
                    'external-hevc-main10-bt709-limited:pq-v1'
                ]
            }
        );
        const rangeValues = result.profile.CodecProfiles
            ?.flatMap(profile => profile.Conditions ?? [])
            .filter(condition => condition.Property === 'VideoRangeType')
            .map(condition => condition.Value) ?? [];

        expect(rangeValues.some(value => value?.includes('DOVIWithHLG'))).toBe(false);
    });

    it('does not export native Profile 5 vector limits as source ceilings', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'hevc',
            Conditions: [ {
                Condition: 'EqualsAny',
                IsRequired: false,
                Property: 'VideoRangeType',
                Value: 'SDR'
            } ],
            Type: 'Video'
        } ];
        const capabilities = createCapabilities({ supportedVideoCodecs: [], supportedAudioCodecs: [ 'aac' ], nativeDolbyVisionSupported: true });
        const nativeDolbyVisionHEVC = capabilities.nativeDolbyVisionHEVC;
        if (!nativeDolbyVisionHEVC) {
            throw new Error('The native Dolby Vision capability vector is missing');
        }
        const result = augmentDeviceProfileForCustomDecode(
            original,
            capabilities,
            { allowNativeDolbyVision: true, allowRawHDR: false }
        );
        const nativeProfile = result.profile.CodecProfiles?.find(profile => (
            profile.Codec === 'hevc'
            && profile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value === 'DOVI'
            ))
            && profile.Conditions.some(condition => (
                condition.Property === 'IsInterlaced'
                && condition.Value === 'false'
            ))
        ));

        expect(nativeProfile).toBeDefined();
        expect(nativeProfile?.Conditions).toEqual(expect.arrayContaining([
            expect.objectContaining({
                Condition: 'EqualsAny',
                Property: 'VideoRangeType',
                Value: 'DOVI'
            }),
            expect.objectContaining({ Property: 'VideoBitDepth', Value: '10' }),
            expect.objectContaining({ Property: 'VideoProfile', Value: 'main 10' })
        ]));
        expect(nativeProfile?.Conditions?.some(condition => (
            condition.Property === 'Width'
            || condition.Property === 'Height'
            || condition.Property === 'VideoLevel'
            || condition.Property === 'VideoFramerate'
        ))).toBe(false);
        expect(result.profile.CodecProfiles?.some(profile => (
            profile.Conditions?.some(condition => (
                condition.Value?.includes('DOVIWithHDR10')
                || condition.Value?.includes('DOVIWithHLG')
                || condition.Value?.includes('DOVIWithSDR')
            ))
        ))).toBe(false);
    });

    it('rejects unsupported native Profile 5 qualification evidence', () => {
        const capabilities = createCapabilities({ supportedVideoCodecs: [], supportedAudioCodecs: [ 'aac' ], nativeDolbyVisionSupported: true });
        const nativeDolbyVisionHEVC = capabilities.nativeDolbyVisionHEVC;
        if (!nativeDolbyVisionHEVC) {
            throw new Error('The native Dolby Vision capability vector is missing');
        }
        capabilities.nativeDolbyVisionHEVC = {
            ...nativeDolbyVisionHEVC,
            reason: 'decode-output-missing',
            status: 'unsupported'
        };

        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            capabilities,
            { allowNativeDolbyVision: true, allowRawHDR: false }
        );

        const nativeProfile = result.profile.CodecProfiles?.find(profile => (
            profile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value?.includes('DOVI')
            ))
        ));
        expect(nativeProfile).toBeUndefined();
    });

    it('does not leak native Profile 5 support through raw authorization', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'hevc',
            Conditions: [ {
                Condition: 'EqualsAny',
                IsRequired: false,
                Property: 'VideoRangeType',
                Value: 'SDR'
            } ],
            Type: 'Video'
        } ];
        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities({ supportedVideoCodecs: [], supportedAudioCodecs: [ 'aac' ], nativeDolbyVisionSupported: true }),
            { allowDolbyVision: true, allowRawHDR: false }
        );

        expect(result.profile.CodecProfiles?.some(profile => (
            profile.Conditions?.some(condition => condition.Value?.includes('DOVI'))
        ))).toBe(false);
    });

    it('keeps native and raw Dolby Vision routes dimension-neutral', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'hevc',
            Conditions: [ {
                Condition: 'EqualsAny',
                IsRequired: false,
                Property: 'VideoRangeType',
                Value: 'SDR'
            } ],
            Type: 'Video'
        } ];
        const capabilities = createCapabilities({ supportedVideoCodecs: [], supportedAudioCodecs: [ 'aac' ], supportedRawHDRVideoCodecs: [ 'hevc' ], nativeDolbyVisionSupported: true });
        capabilities.rawHDRVideo.hevc.codecString = 'hvc1.2.4.L120.B0';
        const result = augmentDeviceProfileForCustomDecode(
            original,
            capabilities,
            {
                allowDolbyVision: true,
                allowNativeDolbyVision: true,
                allowRawHDR: false
            }
        );
        const nativeProfile = result.profile.CodecProfiles?.find(profile => (
            profile.ApplyConditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value === 'DOVI'
            ))
        ));
        const rawProfile = result.profile.CodecProfiles?.find(profile => (
            profile.ApplyConditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value === 'DOVIWithHDR10|DOVIWithHLG|DOVIWithSDR|DOVIWithHDR10Plus|DOVIInvalid'
            ))
        ));

        expect(nativeProfile?.Conditions?.some(condition => (
            condition.Property === 'Width'
            || condition.Property === 'Height'
            || condition.Property === 'VideoLevel'
            || condition.Property === 'VideoFramerate'
        ))).toBe(false);
        expect(rawProfile?.Conditions?.some(condition => (
            condition.Property === 'Width'
            || condition.Property === 'Height'
            || condition.Property === 'VideoLevel'
            || condition.Property === 'VideoFramerate'
        ))).toBe(false);
    });

    it('keeps non-custom containers on the original native video range constraints', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'hevc',
            Conditions: [
                {
                    Condition: 'EqualsAny',
                    IsRequired: false,
                    Property: 'VideoRangeType',
                    Value: 'SDR'
                },
                {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'Width',
                    Value: '1920'
                },
                {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'Height',
                    Value: '1080'
                },
                {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'VideoLevel',
                    Value: '120'
                },
                {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'VideoFramerate',
                    Value: '30'
                }
            ],
            Container: 'mp4,hls',
            Type: 'Video'
        } ];

        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities({ supportedVideoCodecs: [ 'hevc' ], supportedAudioCodecs: [ 'aac' ], supportedRawHDRVideoCodecs: [ 'hevc' ] }),
            RAW_HDR_PROFILE_OPTIONS
        );

        const [ nonCustomProfile, customProfile ] = result.profile.CodecProfiles?.slice(0, 2) ?? [];
        expect(nonCustomProfile).toEqual({
            Codec: 'hevc',
            Conditions: original.CodecProfiles[0].Conditions,
            Container: 'hls',
            Type: 'Video'
        });
        expect(customProfile).toMatchObject({
            Codec: 'hevc',
            Conditions: expect.arrayContaining([
                expect.objectContaining({
                    Property: 'VideoRangeType',
                    Value: 'SDR|HDR10|HLG|HDR10Plus'
                }),
                expect.objectContaining({ Property: 'VideoBitDepth', Value: '10' }),
                expect.objectContaining({ Property: 'IsInterlaced', Value: 'false' })
            ]),
            Container: 'mp4',
            Type: 'Video'
        });
        expect(customProfile?.Conditions?.some(condition => (
            condition.Property === 'Width'
            || condition.Property === 'Height'
            || condition.Property === 'VideoLevel'
            || condition.Property === 'VideoFramerate'
        ))).toBe(false);
    });

    it('does not widen raw HDR ranges when HDR presentation is disabled or on retry', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'hevc',
            Conditions: [
                {
                    Condition: 'EqualsAny',
                    IsRequired: false,
                    Property: 'VideoRangeType',
                    Value: 'SDR'
                },
                {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'Width',
                    Value: '1920'
                },
                {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'Height',
                    Value: '1080'
                },
                {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'VideoLevel',
                    Value: '120'
                },
                {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'VideoFramerate',
                    Value: '30'
                }
            ],
            Type: 'Video'
        } ];
        const capabilities = createCapabilities({ supportedVideoCodecs: [ 'hevc' ], supportedAudioCodecs: [ 'aac' ], supportedRawHDRVideoCodecs: [ 'hevc' ] });

        const disabledResult = augmentDeviceProfileForCustomDecode(original, capabilities);
        const retryResult = augmentDeviceProfileForCustomDecode(original, capabilities, { ...RAW_HDR_PROFILE_OPTIONS, isRetry: true });

        expect(disabledResult.profile.CodecProfiles).toContainEqual({
            ...original.CodecProfiles[0],
            Container: NON_CUSTOM_VIDEO_CONTAINERS
        });
        expect(disabledResult.profile.CodecProfiles).not.toContainEqual(original.CodecProfiles[0]);
        const nativeSDRProfile = disabledResult.profile.CodecProfiles?.find(profile => (
            profile.Codec === 'hevc'
            && profile.Container === 'mp4,m4v,mov,mkv,avi,ts,m2ts,mts'
            && profile.Conditions?.some(condition => (
                condition.Property === 'VideoBitDepth' && condition.Value === '8'
            ))
        ));
        expect(nativeSDRProfile).toEqual(expect.objectContaining({
            Codec: 'hevc',
            Conditions: expect.arrayContaining([
                expect.objectContaining({ Property: 'VideoBitDepth', Value: '8' })
            ])
        }));
        expect(nativeSDRProfile?.Conditions?.some(condition => (
            condition.Property === 'Width'
            || condition.Property === 'Height'
            || condition.Property === 'VideoLevel'
            || condition.Property === 'VideoFramerate'
        ))).toBe(false);
        expect(disabledResult.telemetry.widenedHDRCodecProfileCount).toBe(0);
        expect(retryResult.profile.CodecProfiles).toEqual(original.CodecProfiles);
        expect(retryResult.telemetry.widenedHDRCodecProfileCount).toBe(0);
    });

    it('keeps raw HDR range widening idempotent', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'hevc',
            Conditions: [
                {
                    Condition: 'EqualsAny',
                    IsRequired: false,
                    Property: 'VideoRangeType',
                    Value: 'SDR'
                },
                {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'Width',
                    Value: '1920'
                },
                {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'Height',
                    Value: '1080'
                },
                {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'VideoLevel',
                    Value: '120'
                },
                {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'VideoFramerate',
                    Value: '30'
                }
            ],
            Type: 'Video'
        } ];
        const capabilities = createCapabilities({ supportedVideoCodecs: [ 'hevc' ], supportedAudioCodecs: [ 'aac' ], supportedRawHDRVideoCodecs: [ 'hevc' ] });

        const firstResult = augmentDeviceProfileForCustomDecode(original, capabilities, RAW_HDR_PROFILE_OPTIONS);
        const secondResult = augmentDeviceProfileForCustomDecode(firstResult.profile, capabilities, RAW_HDR_PROFILE_OPTIONS);

        expect(secondResult.profile.CodecProfiles).toEqual(firstResult.profile.CodecProfiles);
        expect(secondResult.telemetry.widenedHDRCodecProfileCount).toBe(0);
    });

    it('advertises only explicitly renderable external subtitle formats', () => {
        const original = createBaseProfile();
        original.SubtitleProfiles = [
            { Container: 'mkv', Format: 'dvdsub', Method: 'Encode' },
            { Container: 'mkv', Format: 'dvdsub', Method: 'Encode' },
            { Format: 'srt', Method: 'External' },
            { Format: 'vtt', Method: 'External' },
            { Format: 'ass', Method: 'External' },
            { Format: 'ass', Method: 'External' },
            { Container: 'mks', Format: 'vobsub', Method: 'External' }
        ];
        const originalSnapshot = JSON.stringify(original);

        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities({ supportedVideoCodecs: [ 'h264' ], supportedAudioCodecs: [ 'aac' ] }),
            {
                subtitleCapabilities: {
                    externalASS: true,
                    externalPGS: true,
                    externalVobSub: true,
                    externalText: true
                }
            }
        );

        expect(result.profile.SubtitleProfiles).toEqual([
            { Container: 'mkv', Format: 'dvdsub', Method: 'Encode' },
            { Format: 'vtt', Method: 'External' },
            { Format: 'ass', Method: 'External' },
            { Format: 'ssa', Method: 'External' },
            { Format: 'pgssub', Method: 'External' },
            { Container: 'mks', Format: 'vobsub', Method: 'External' }
        ]);
        expect(result.profile.SubtitleProfiles).not.toBe(original.SubtitleProfiles);
        expect(JSON.stringify(original)).toBe(originalSnapshot);
        expect(result.telemetry.subtitleProfileChanged).toBe(true);
    });

    it('removes unsupported external subtitles while preserving Encode routes', () => {
        const original = createBaseProfile();
        original.SubtitleProfiles = [
            { Format: 'dvdsub', Method: 'Encode' },
            { Format: 'ass', Method: 'External' },
            { Format: 'pgssub', Method: 'External' },
            { Format: 'vtt', Method: 'External' },
            { Container: 'mks', Format: 'vobsub', Method: 'External' }
        ];

        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities({ supportedVideoCodecs: [ 'h264' ], supportedAudioCodecs: [ 'aac' ] }),
            {
                subtitleCapabilities: {
                    externalASS: false,
                    externalPGS: false,
                    externalVobSub: false,
                    externalText: true
                }
            }
        );

        expect(result.profile.SubtitleProfiles).toEqual([
            { Format: 'dvdsub', Method: 'Encode' },
            { Format: 'vtt', Method: 'External' }
        ]);
    });

    it('keeps subtitle negotiation conservative on retry and incompatible routes', () => {
        const original = createBaseProfile();
        original.SubtitleProfiles = [
            { Format: 'srt', Method: 'External' },
            { Format: 'dvdsub', Method: 'Encode' }
        ];
        const subtitleCapabilities = {
            externalASS: true,
            externalPGS: true,
            externalVobSub: true,
            externalText: true
        } as const;

        const retryResult = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities({ supportedVideoCodecs: [ 'h264' ], supportedAudioCodecs: [ 'aac' ] }),
            { isRetry: true, subtitleCapabilities }
        );
        const incompatibleResult = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities({ supportedVideoCodecs: [ 'av1' ], supportedAudioCodecs: [] }),
            { subtitleCapabilities }
        );

        expect(retryResult.profile.SubtitleProfiles).toEqual(original.SubtitleProfiles);
        expect(retryResult.telemetry).toMatchObject({
            reason: 'retry-not-widened',
            subtitleProfileChanged: false
        });
        expect(incompatibleResult.profile.SubtitleProfiles).toEqual(original.SubtitleProfiles);
        expect(incompatibleResult.telemetry).toMatchObject({
            reason: 'no-compatible-combinations',
            subtitleProfileChanged: false
        });
    });

    it('keeps custom subtitle profiles deduplicated and idempotent', () => {
        const capabilities = createCapabilities({ supportedVideoCodecs: [ 'h264' ], supportedAudioCodecs: [ 'aac' ] });
        const options = {
            subtitleCapabilities: {
                externalASS: true,
                externalPGS: true,
                externalVobSub: true,
                externalText: true
            }
        } as const;
        const firstResult = augmentDeviceProfileForCustomDecode(createBaseProfile(), capabilities, options);
        const secondResult = augmentDeviceProfileForCustomDecode(firstResult.profile, capabilities, options);

        expect(secondResult.profile.SubtitleProfiles).toEqual(firstResult.profile.SubtitleProfiles);
        expect(new Set(secondResult.profile.SubtitleProfiles?.map(subtitleProfile => (
            `${subtitleProfile.Method}|${subtitleProfile.Format}|${subtitleProfile.Container}`
        ))).size).toBe(secondResult.profile.SubtitleProfiles?.length);
        expect(secondResult.telemetry.subtitleProfileChanged).toBe(false);
    });

    it('never widens a retry profile', () => {
        const original = createBaseProfile();
        original.MaxStreamingBitrate = 20_000_000;
        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities({ supportedVideoCodecs: ENGINE_VIDEO_CODECS, supportedAudioCodecs: ENGINE_AUDIO_CODECS }),
            { decoderPackages: PACKAGE_CODEC_DECODER_PACKAGES, isRetry: true }
        );

        expect(result.profile).toEqual(original);
        expect(result.profile.MaxStreamingBitrate).toBe(20_000_000);
        expect(result.profile).not.toBe(original);
        expect(result.profile.DirectPlayProfiles).not.toBe(original.DirectPlayProfiles);
        expect(result.telemetry).toMatchObject({
            addedProfileCount: 0,
            reason: 'retry-not-widened'
        });
    });

    it('deep-clones the input and preserves transcoding and constraint profiles', () => {
        const original = createBaseProfile();
        const originalSnapshot = JSON.stringify(original);
        const result = augmentDeviceProfileForCustomDecode(original, createCapabilities({ supportedVideoCodecs: [ 'vp9' ], supportedAudioCodecs: [ 'opus' ] }));

        expect(JSON.stringify(original)).toBe(originalSnapshot);
        expect(result.profile.TranscodingProfiles).toEqual(original.TranscodingProfiles);
        expect(result.profile.TranscodingProfiles).not.toBe(original.TranscodingProfiles);
        expect(result.profile.TranscodingProfiles?.[0]).not.toBe(original.TranscodingProfiles?.[0]);
        expect(result.profile.TranscodingProfiles?.[0].Conditions).not.toBe(original.TranscodingProfiles?.[0].Conditions);
        expect(result.profile.CodecProfiles?.[0].Conditions).not.toBe(original.CodecProfiles?.[0].Conditions);
        expect(result.profile.ContainerProfiles?.[0].Conditions).not.toBe(original.ContainerProfiles?.[0].Conditions);
        expect(result.profile.SubtitleProfiles).not.toBe(original.SubtitleProfiles);
    });

    it('preserves unrelated routes while splitting measured video and audio constraints', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [
            {
                Codec: 'h264,hevc',
                Conditions: [ {
                    Condition: 'EqualsAny',
                    IsRequired: false,
                    Property: 'VideoRangeType',
                    Value: 'SDR'
                } ],
                Type: 'Video'
            },
            {
                Codec: 'h264',
                Conditions: [ {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'VideoLevel',
                    Value: '42'
                } ],
                Container: 'webm',
                Type: 'Video'
            },
            {
                Codec: 'h264',
                Conditions: [ {
                    Condition: 'EqualsAny',
                    IsRequired: false,
                    Property: 'VideoProfile',
                    Value: 'main|high'
                } ],
                Container: '-mp4,m4v,mov,mkv,ts,m2ts,mts',
                Type: 'Video'
            },
            {
                Conditions: [ {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'Width',
                    Value: '3840'
                } ],
                Type: 'Video'
            },
            {
                Codec: 'aac',
                Conditions: [ {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'AudioChannels',
                    Value: '2'
                } ],
                Type: 'VideoAudio'
            },
            {
                Codec: 'aac',
                Conditions: [ {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'AudioChannels',
                    Value: '2'
                } ],
                Type: 'Audio'
            }
        ];

        const result = augmentDeviceProfileForCustomDecode(original, createCapabilities({ supportedVideoCodecs: [ 'h264' ], supportedAudioCodecs: [ 'aac' ] }));

        expect(result.profile.CodecProfiles).toContainEqual(original.CodecProfiles[0]);
        expect(result.profile.CodecProfiles).toContainEqual(original.CodecProfiles[1]);
        expect(result.profile.CodecProfiles).toContainEqual(original.CodecProfiles[2]);
        expect(result.profile.CodecProfiles).toContainEqual({
            ...original.CodecProfiles[3],
            Container: NON_CUSTOM_VIDEO_CONTAINERS
        });
        expect(result.profile.CodecProfiles).not.toContainEqual(original.CodecProfiles[3]);
        expect(result.profile.CodecProfiles).toContainEqual({
            ...original.CodecProfiles[4],
            Container: NON_CUSTOM_VIDEO_CONTAINERS
        });
        expect(result.profile.CodecProfiles).toContainEqual(original.CodecProfiles[5]);
        expect(result.profile.CodecProfiles).not.toContainEqual(original.CodecProfiles[4]);
        expect(result.profile.CodecProfiles).not.toBe(original.CodecProfiles);
        expect(result.profile.CodecProfiles?.[0].Conditions).toEqual(original.CodecProfiles[0].Conditions);
        expect(result.profile.CodecProfiles?.[0].Conditions).not.toBe(original.CodecProfiles[0].Conditions);
    });

    it('preserves native video constraints when direct play was already advertised', () => {
        const capabilities = createCapabilities({ supportedVideoCodecs: [ 'h264' ], supportedAudioCodecs: [ 'aac' ] });
        const firstResult = augmentDeviceProfileForCustomDecode(createBaseProfile(), capabilities);
        const alreadyAdvertisedProfile: DeviceProfile = {
            ...firstResult.profile,
            CodecProfiles: [ {
                Codec: 'h264',
                Conditions: [ {
                    Condition: 'EqualsAny',
                    IsRequired: false,
                    Property: 'VideoRangeType',
                    Value: 'SDR'
                } ],
                Type: 'Video'
            } ]
        };

        const result = augmentDeviceProfileForCustomDecode(alreadyAdvertisedProfile, capabilities);

        expect(result.profile.CodecProfiles?.slice(
            0,
            alreadyAdvertisedProfile.CodecProfiles?.length ?? 0
        )).toEqual(alreadyAdvertisedProfile.CodecProfiles);
        expect(result.telemetry).toMatchObject({
            addedProfileCount: 0,
            reason: 'already-advertised'
        });
    });

    it('does not add profiles for unsupported or unknown codecs', () => {
        const original = createBaseProfile();
        const baseCapabilities = createCapabilities({ supportedVideoCodecs: [], supportedAudioCodecs: [] });
        const capabilities: CustomDecodeCapabilities = {
            ...baseCapabilities,
            video: {
                ...baseCapabilities.video,
                hevc: {
                    codec: 'hevc',
                    codecString: 'hvc1.1.6.L120.B0',
                    reason: 'probe-exception',
                    status: 'unknown'
                }
            }
        };
        const result = augmentDeviceProfileForCustomDecode(original, capabilities);

        expect(result.profile).toMatchObject({
            ...original,
            MaxStaticBitrate: null,
            MaxStaticMusicBitrate: null,
            MaxStreamingBitrate: null
        });
        expect(result.profile).not.toBe(original);
        expect(result.telemetry).toMatchObject({
            addedProfileCount: 0,
            reason: 'no-supported-codecs'
        });
    });

    it('advertises proven raw HEVC Main 10 planes without native HEVC SDR decode', () => {
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            createCapabilities({ supportedVideoCodecs: [], supportedAudioCodecs: [ 'aac' ], supportedRawHDRVideoCodecs: [ 'hevc' ] }),
            RAW_HDR_PROFILE_OPTIONS
        );

        expect(result.profile.DirectPlayProfiles).toContainEqual({
            AudioCodec: 'aac',
            Container: 'mp4,m4v,mov',
            Type: 'Video',
            VideoCodec: 'hevc'
        });
        expect(result.profile.DirectPlayProfiles).toContainEqual({
            AudioCodec: 'aac',
            Container: 'ts,m2ts,mts',
            Type: 'Video',
            VideoCodec: 'hevc'
        });
        expect(result.profile.DirectPlayProfiles?.some(directPlayProfile => (
            directPlayProfile.Container === 'webm'
        ))).toBe(false);
        const rawHEVCProfile = result.profile.CodecProfiles?.find(profile => (
            profile.Codec === 'hevc'
            && profile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value === 'HDR10|HLG|HDR10Plus'
            ))
        ));
        expect(rawHEVCProfile?.Conditions).toEqual(expect.arrayContaining([
            expect.objectContaining({ Property: 'VideoBitDepth', Value: '10' }),
            expect.objectContaining({ Property: 'VideoProfile', Value: 'main 10' })
        ]));
        expect(rawHEVCProfile?.Conditions?.some(condition => (
            condition.Property === 'Width'
            || condition.Property === 'Height'
            || condition.Property === 'VideoLevel'
            || condition.Property === 'VideoFramerate'
        ))).toBe(false);
        expect(result.telemetry.supportedVideoCodecs).toEqual([ 'hevc' ]);
    });

    it('does not export the raw HEVC probe\'s level as a source ceiling', () => {
        const capabilities = createCapabilities({ supportedVideoCodecs: [], supportedAudioCodecs: [ 'aac' ], supportedRawHDRVideoCodecs: [ 'hevc' ] });
        // A Level 4 probe string, which a 1080p vector carries
        capabilities.rawHDRVideo = {
            ...capabilities.rawHDRVideo,
            hevc: {
                ...capabilities.rawHDRVideo.hevc,
                codecString: 'hvc1.2.4.L120.B0'
            }
        };

        const result = augmentDeviceProfileForCustomDecode(createBaseProfile(), capabilities, RAW_HDR_PROFILE_OPTIONS);

        const rawHEVCProfile = result.profile.CodecProfiles?.find(profile => (
            profile.Codec === 'hevc'
            && profile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value === 'HDR10|HLG|HDR10Plus'
            ))
        ));
        expect(rawHEVCProfile).toBeDefined();
        expect(rawHEVCProfile?.Conditions?.some(condition => (
            condition.Property === 'Width'
            || condition.Property === 'Height'
            || condition.Property === 'VideoLevel'
            || condition.Property === 'VideoFramerate'
        ))).toBe(false);
    });

    it('does not duplicate profiles already advertised by a previous augmentation', () => {
        const capabilities = createCapabilities({ supportedVideoCodecs: [ 'vp9' ], supportedAudioCodecs: [ 'opus' ] });
        const firstResult = augmentDeviceProfileForCustomDecode(createBaseProfile(), capabilities);
        const secondResult = augmentDeviceProfileForCustomDecode(firstResult.profile, capabilities);

        expect(secondResult.profile.DirectPlayProfiles).toEqual(firstResult.profile.DirectPlayProfiles);
        expect(secondResult.telemetry).toMatchObject({
            addedProfileCount: 0,
            reason: 'already-advertised'
        });
    });

    it('reports video-only support as having no safe combined profile', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'av1',
            Conditions: [ {
                Condition: 'EqualsAny',
                IsRequired: false,
                Property: 'VideoRangeType',
                Value: 'SDR'
            } ],
            Type: 'Video'
        } ];
        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities({ supportedVideoCodecs: [ 'av1' ], supportedAudioCodecs: [], supportedRawHDRVideoCodecs: [ 'av1' ] }),
            RAW_HDR_PROFILE_OPTIONS
        );

        expect(result.profile.CodecProfiles).toEqual(original.CodecProfiles);
        expect(result.telemetry).toMatchObject({
            addedProfileCount: 0,
            reason: 'no-compatible-combinations',
            widenedHDRCodecProfileCount: 0
        });
    });
});

const RAW_SDR_ROUTE_KEYS = [
    'I420P10:bt709:bt709:limited:sdr',
    'I420P10:bt709:bt709:full:sdr'
] as const;

const PROFILE_10_VIDEO_RANGE_TYPES = [
    'DOVI',
    'DOVIWithHDR10',
    'DOVIWithHLG',
    'DOVIWithSDR',
    'DOVIWithHDR10Plus',
    'DOVIInvalid'
] as const;

// Jellyfin Web's stock ranges follow the display: HDR10, HDR10+, and HLG on an HDR display, SDR alone otherwise
const HDR_DISPLAY_STOCK_VIDEO_RANGE_TYPES = 'SDR|HDR10|HDR10Plus|HLG';
const SDR_DISPLAY_STOCK_VIDEO_RANGE_TYPES = 'SDR';
const PQ_STREAM_COLOR = {
    ColorPrimaries: 'bt2020',
    ColorSpace: 'bt2020nc',
    ColorTransfer: 'smpte2084',
    VideoRange: 'HDR'
} as const;
const HLG_STREAM_COLOR = {
    ...PQ_STREAM_COLOR,
    ColorTransfer: 'arib-std-b67'
} as const;

// Raw VP9 HDR rows: HDR10+ plays its static HDR10 base wherever raw PQ is authorized
const RAW_VP9_HDR_ROUTE_MATRIX = [
    {
        advertised: true,
        bitDepth: 10,
        color: PQ_STREAM_COLOR,
        label: 'HDR10 Profile 2 at 10 bits',
        profile: 'Profile 2',
        rangeType: 'HDR10',
        routeKeys: RAW_HDR_PROFILE_OPTIONS.authorizedRawHDRRouteKeys
    },
    {
        advertised: true,
        bitDepth: 10,
        color: PQ_STREAM_COLOR,
        label: 'HDR10Plus Profile 2 at 10 bits',
        profile: 'Profile 2',
        rangeType: 'HDR10Plus',
        routeKeys: RAW_HDR_PROFILE_OPTIONS.authorizedRawHDRRouteKeys
    },
    {
        advertised: true,
        bitDepth: 10,
        color: HLG_STREAM_COLOR,
        label: 'HLG Profile 2 at 10 bits',
        profile: 'Profile 2',
        rangeType: 'HLG',
        routeKeys: RAW_HDR_PROFILE_OPTIONS.authorizedRawHDRRouteKeys
    },
    {
        advertised: false,
        bitDepth: 8,
        color: PQ_STREAM_COLOR,
        label: 'HDR10Plus Profile 0 at 8 bits',
        profile: 'Profile 0',
        rangeType: 'HDR10Plus',
        routeKeys: RAW_HDR_PROFILE_OPTIONS.authorizedRawHDRRouteKeys
    },
    {
        advertised: false,
        bitDepth: 10,
        color: PQ_STREAM_COLOR,
        label: 'HDR10Plus Profile 2 without the raw PQ key',
        profile: 'Profile 2',
        rangeType: 'HDR10Plus',
        routeKeys: [ RAW_HLG_ROUTE_KEY ]
    }
] as const;

/** Returns whether a profile direct-plays a Matroska source of one video stream and stereo AAC. */
function isDirectPlayAdvertised(profile: DeviceProfile, videoStream: Readonly<Record<string, unknown>>): boolean {
    return isSameSessionNativePlaybackCompatible({
        mediaSource: {
            Container: 'mkv',
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
            SupportsDirectPlay: true
        },
        playMethod: 'DirectPlay',
        url: '/Videos/item/stream.mkv'
    }, profile);
}

function createVideoStream(
    codec: string,
    profile: string,
    bitDepth: number,
    videoRangeType: string,
    overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
    return {
        BitDepth: bitDepth,
        Codec: codec,
        ColorPrimaries: 'bt709',
        ColorRange: 'tv',
        ColorSpace: 'bt709',
        ColorTransfer: 'bt709',
        Height: 2_160,
        Index: 0,
        IsInterlaced: false,
        Profile: profile,
        Type: 'Video',
        VideoRange: 'SDR',
        VideoRangeType: videoRangeType,
        Width: 3_840,
        ...overrides
    };
}

/** Creates an AV1 Profile 10 stream over a PQ base; a null compatibility ID omits the field, as Matroska can. */
function createProfile10Stream(
    compatibilityID: number | null,
    videoRangeType: string,
    overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
    return createVideoStream('av1', 'Main', 10, videoRangeType, {
        BlPresentFlag: true,
        ColorPrimaries: 'bt2020',
        ColorSpace: 'bt2020nc',
        ColorTransfer: 'smpte2084',
        DvProfile: 10,
        ElPresentFlag: false,
        RpuPresentFlag: true,
        VideoRange: 'HDR',
        ...(compatibilityID === null ? {} : { DvBlSignalCompatibilityId: compatibilityID }),
        ...overrides
    });
}

function createStockVideoCodecProfile(codec: string, videoRangeTypes: string): CodecProfile {
    return {
        Codec: codec,
        Conditions: [ {
            Condition: 'EqualsAny',
            IsRequired: false,
            Property: 'VideoRangeType',
            Value: videoRangeTypes
        } ],
        Type: 'Video'
    };
}

/** Returns the base profile with the stock HEVC codec profile of a browser whose own playback is SDR only. */
function createBaseProfileWithStockHEVC(videoProfiles: string): DeviceProfile {
    const profile = createBaseProfile();
    profile.CodecProfiles = [ {
        Codec: 'hevc',
        Conditions: [
            {
                Condition: 'EqualsAny',
                IsRequired: false,
                Property: 'VideoProfile',
                Value: videoProfiles
            },
            {
                Condition: 'EqualsAny',
                IsRequired: false,
                Property: 'VideoRangeType',
                Value: 'SDR'
            }
        ],
        Type: 'Video'
    } ];
    return profile;
}

/** Returns every profile/range pair a codec's exact routes scope with ApplyConditions. */
function getMeasuredRoutePairs(profile: DeviceProfile, codec: string): string[] {
    const pairs: string[] = [];
    for (const codecProfile of profile.CodecProfiles ?? []) {
        if (codecProfile.Codec !== codec || !codecProfile.ApplyConditions) {
            continue;
        }
        const profileCondition = codecProfile.ApplyConditions.find(condition => (
            condition.Property === 'VideoProfile'
        ));
        const rangeCondition = codecProfile.ApplyConditions.find(condition => (
            condition.Property === 'VideoRangeType'
        ));
        pairs.push(`${profileCondition?.Value ?? ''}|${rangeCondition?.Value ?? ''}`);
    }
    return pairs;
}

/** Adds range-extension evidence, unqualified apart from the given variants, which makes HEVC split into exact pairs as the probes always do. */
function withUnqualifiedHEVCRangeExtensions(
    capabilities: CustomDecodeCapabilities,
    supportedVariants: readonly HEVCRangeExtensionVariant[] = []
): CustomDecodeCapabilities {
    const hevcRangeExtensions = {} as Record<HEVCRangeExtensionVariant, HEVCRangeExtensionCapability>;
    for (const variant of HEVC_RANGE_EXTENSION_VARIANTS) {
        hevcRangeExtensions[variant] = createHEVCRangeExtensionCapability(variant, supportedVariants.includes(variant));
    }
    return { ...capabilities, hevcRangeExtensions };
}

describe('augmentDeviceProfileForCustomDecode Profile 10 and 10-bit raw routes', () => {
    it('advertises every Profile 10 range on the 10-bit raw AV1 route and never an EL range', () => {
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            createCapabilities({ supportedVideoCodecs: [ 'av1' ], supportedAudioCodecs: [ 'aac' ], supportedRawHDRVideoCodecs: [ 'av1' ] }),
            { allowDolbyVision: true, allowRawHDR: false }
        );

        for (const rangeType of PROFILE_10_VIDEO_RANGE_TYPES) {
            expect(isDirectPlayAdvertised(result.profile, createProfile10Stream(1, rangeType))).toBe(true);
            expect(isDirectPlayAdvertised(result.profile, createProfile10Stream(1, rangeType, { BitDepth: 8 }))).toBe(false);
        }
        // Profile 10 carries a single-layer RPU, so the EL labels stay rejection rules
        for (const rangeType of [ 'DOVIWithEL', 'DOVIWithELHDR10Plus' ]) {
            expect(isDirectPlayAdvertised(result.profile, createProfile10Stream(6, rangeType))).toBe(false);
        }
    });

    it('lets Profile 10 alone make AV1 a supported codec', () => {
        const capabilities = createCapabilities({ supportedVideoCodecs: [], supportedAudioCodecs: [ 'aac' ], supportedRawHDRVideoCodecs: [ 'av1' ] });

        const withDolbyVision = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            capabilities,
            { allowDolbyVision: true, allowRawHDR: false }
        );
        const withoutDolbyVision = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            capabilities,
            { allowRawHDR: false }
        );

        expect(withDolbyVision.telemetry.supportedVideoCodecs).toEqual([ 'av1' ]);
        expect(withDolbyVision.profile.DirectPlayProfiles).toContainEqual(expect.objectContaining({
            Container: 'mkv',
            VideoCodec: 'av1'
        }));
        expect(withoutDolbyVision.telemetry.supportedVideoCodecs).toEqual([]);
    });

    it('gates the Profile 10 ranges on raw AV1 decode and the RPU authorization', () => {
        const withoutRawAV1 = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            createCapabilities({ supportedVideoCodecs: [ 'av1' ], supportedAudioCodecs: [ 'aac' ] }),
            { allowDolbyVision: true, allowRawHDR: false }
        );
        const withoutAuthorization = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            createCapabilities({ supportedVideoCodecs: [ 'av1' ], supportedAudioCodecs: [ 'aac' ], supportedRawHDRVideoCodecs: [ 'av1' ] }),
            { allowRawHDR: false }
        );

        for (const result of [ withoutRawAV1, withoutAuthorization ]) {
            expect(isDirectPlayAdvertised(result.profile, createProfile10Stream(1, 'DOVIWithHDR10'))).toBe(false);
        }
    });

    it('widens a stock av1 profile limited to static ranges with the Profile 10 ranges', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ createStockVideoCodecProfile('av1', 'SDR|HDR10|HDR10Plus|HLG') ];

        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities({ supportedVideoCodecs: [ 'av1' ], supportedAudioCodecs: [ 'aac' ], supportedRawHDRVideoCodecs: [ 'av1' ] }),
            { ...RAW_HDR_PROFILE_OPTIONS, allowDolbyVision: true }
        );
        const widenedProfile = result.profile.CodecProfiles?.find(profile => (
            profile.Codec === 'av1'
            && profile.Container === getCustomVideoCodecContainers('av1')
            && profile.ApplyConditions === undefined
        ));

        expect(widenedProfile?.Conditions).toEqual(expect.arrayContaining([
            expect.objectContaining({
                Property: 'VideoRangeType',
                Value: 'SDR|HDR10|HLG|HDR10Plus|DOVI|DOVIWithHDR10|DOVIWithHLG|DOVIWithSDR|DOVIWithHDR10Plus|DOVIInvalid'
            }),
            expect.objectContaining({ Property: 'VideoBitDepth', Value: '10' }),
            expect.objectContaining({ Property: 'VideoProfile', Value: 'main' })
        ]));
        expect(isDirectPlayAdvertised(
            result.profile,
            createProfile10Stream(4, 'DOVIWithHLG', { ColorTransfer: 'arib-std-b67' })
        )).toBe(true);
        expect(result.telemetry.widenedHDRCodecProfileCount).toBe(1);
    });

    it('splits AV1 and VP9 routes into exact pairs, so 8-bit and 10-bit SDR both pass', () => {
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            createCapabilities({ supportedVideoCodecs: [ 'av1', 'vp9' ], supportedAudioCodecs: [ 'aac' ], supportedRawHDRVideoCodecs: [ 'av1', 'vp9' ] }),
            {
                allowDolbyVision: true,
                allowRawHDR: true,
                allowRawSDR: true,
                authorizedRawHDRRouteKeys: [
                    ...RAW_HDR_PROFILE_OPTIONS.authorizedRawHDRRouteKeys,
                    ...RAW_SDR_ROUTE_KEYS
                ]
            }
        );

        for (const codec of [ 'av1', 'vp9' ]) {
            const pairs = getMeasuredRoutePairs(result.profile, codec);
            expect(pairs.length).toBeGreaterThan(0);
            expect(new Set(pairs).size).toBe(pairs.length);
        }
        // Native 8-bit and raw 10-bit SDR share AV1 Main and merge into one exact route
        expect(isDirectPlayAdvertised(result.profile, createVideoStream('av1', 'Main', 8, 'SDR'))).toBe(true);
        expect(isDirectPlayAdvertised(result.profile, createVideoStream('av1', 'Main', 10, 'SDR'))).toBe(true);
        expect(isDirectPlayAdvertised(result.profile, createVideoStream('vp9', 'Profile 0', 8, 'SDR'))).toBe(true);
        expect(isDirectPlayAdvertised(result.profile, createVideoStream('vp9', 'Profile 2', 10, 'SDR'))).toBe(true);
        expect(isDirectPlayAdvertised(result.profile, createVideoStream('vp9', 'Profile 2', 8, 'SDR'))).toBe(false);
        expect(isDirectPlayAdvertised(result.profile, createVideoStream('vp9', 'Profile 0', 10, 'HDR10'))).toBe(false);
    });

    it.each([
        { allowRawSDR: true, label: 'both BT.709 keys', routeKeys: RAW_SDR_ROUTE_KEYS, supported: true },
        {
            allowRawSDR: true,
            label: 'only the limited-range key',
            routeKeys: [ 'I420P10:bt709:bt709:limited:sdr' ] as const,
            supported: false
        },
        { allowRawSDR: false, label: 'the raw SDR flag withheld', routeKeys: RAW_SDR_ROUTE_KEYS, supported: false }
    ])('advertises 10-bit SDR for AV1, VP9, and raw HEVC Main 10 with $label', ({
        allowRawSDR,
        routeKeys,
        supported
    }) => {
        // HEVC decodes only to raw Main 10 planes here, with no native Main 10 SDR route
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfileWithStockHEVC('main'),
            withUnqualifiedHEVCRangeExtensions(createCapabilities({ supportedVideoCodecs: [ 'av1', 'vp9' ], supportedAudioCodecs: [ 'aac' ], supportedRawHDRVideoCodecs: [ 'av1', 'vp9', 'hevc' ] })),
            {
                allowRawHDR: false,
                allowRawSDR,
                authorizedRawHDRRouteKeys: routeKeys
            }
        );

        expect(isDirectPlayAdvertised(result.profile, createVideoStream('av1', 'Main', 10, 'SDR'))).toBe(supported);
        expect(isDirectPlayAdvertised(result.profile, createVideoStream('vp9', 'Profile 2', 10, 'SDR'))).toBe(supported);
        expect(isDirectPlayAdvertised(result.profile, createVideoStream('hevc', 'Main 10', 10, 'SDR'))).toBe(supported);
        expect(isDirectPlayAdvertised(result.profile, createVideoStream('av1', 'Main', 8, 'SDR'))).toBe(true);
    });

    it('needs raw HEVC Main 10 output for 10-bit SDR without native HEVC decode', () => {
        const options = {
            allowRawHDR: false,
            allowRawSDR: true,
            authorizedRawHDRRouteKeys: RAW_SDR_ROUTE_KEYS
        };
        const stream = createVideoStream('hevc', 'Main 10', 10, 'SDR');

        const qualified = augmentDeviceProfileForCustomDecode(
            createBaseProfileWithStockHEVC('main'),
            withUnqualifiedHEVCRangeExtensions(createCapabilities({ supportedVideoCodecs: [], supportedAudioCodecs: [ 'aac' ], supportedRawHDRVideoCodecs: [ 'hevc' ] })),
            options
        );
        const unqualified = augmentDeviceProfileForCustomDecode(
            createBaseProfileWithStockHEVC('main'),
            withUnqualifiedHEVCRangeExtensions(createCapabilities({ supportedVideoCodecs: [], supportedAudioCodecs: [ 'aac' ] })),
            options
        );

        expect(isDirectPlayAdvertised(qualified.profile, stream)).toBe(true);
        expect(isDirectPlayAdvertised(unqualified.profile, stream)).toBe(false);
    });

    it('keeps widened stock av1 and vp9 profiles from advertising 10-bit SDR without the raw SDR route', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ createStockVideoCodecProfile('av1,vp9', 'SDR|HDR10|HLG') ];
        const capabilities = createCapabilities({ supportedVideoCodecs: [ 'av1', 'vp9' ], supportedAudioCodecs: [ 'aac' ], supportedRawHDRVideoCodecs: [ 'av1', 'vp9' ] });
        const tenBitSDRStreams = [
            createVideoStream('av1', 'Main', 10, 'SDR'),
            createVideoStream('vp9', 'Profile 2', 10, 'SDR')
        ];

        const withoutRawSDR = augmentDeviceProfileForCustomDecode(original, capabilities, RAW_HDR_PROFILE_OPTIONS);
        const withRawSDR = augmentDeviceProfileForCustomDecode(
            original,
            capabilities,
            {
                ...RAW_HDR_PROFILE_OPTIONS,
                allowRawSDR: true,
                authorizedRawHDRRouteKeys: [
                    ...RAW_HDR_PROFILE_OPTIONS.authorizedRawHDRRouteKeys,
                    ...RAW_SDR_ROUTE_KEYS
                ]
            }
        );

        // The widened stock profile allows SDR up to the raw HDR depth; the exact SDR routes keep their own depths
        expect(withoutRawSDR.profile.CodecProfiles).toContainEqual(expect.objectContaining({
            Codec: 'av1',
            Conditions: expect.arrayContaining([
                expect.objectContaining({ Property: 'VideoRangeType', Value: 'SDR|HDR10|HLG|HDR10Plus' }),
                expect.objectContaining({ Property: 'VideoBitDepth', Value: '10' })
            ])
        }));
        for (const stream of tenBitSDRStreams) {
            expect(isDirectPlayAdvertised(withoutRawSDR.profile, stream)).toBe(false);
            expect(isDirectPlayAdvertised(withRawSDR.profile, stream)).toBe(true);
        }
        expect(isDirectPlayAdvertised(withoutRawSDR.profile, createVideoStream('av1', 'Main', 8, 'SDR'))).toBe(true);
        expect(isDirectPlayAdvertised(
            withoutRawSDR.profile,
            createVideoStream('vp9', 'Profile 2', 10, 'HDR10', {
                ColorPrimaries: 'bt2020',
                ColorSpace: 'bt2020nc',
                ColorTransfer: 'smpte2084',
                VideoRange: 'HDR'
            })
        )).toBe(true);
    });

    // The server ANDs every matching codec profile, so the stock ranges of an SDR display must widen too
    it.each(RAW_VP9_HDR_ROUTE_MATRIX)(
        '$label: advertises the raw VP9 route under the stock profiles of HDR and SDR displays alike',
        ({ advertised, bitDepth, color, profile, rangeType, routeKeys }) => {
            for (const stockVideoRangeTypes of [ HDR_DISPLAY_STOCK_VIDEO_RANGE_TYPES, SDR_DISPLAY_STOCK_VIDEO_RANGE_TYPES ]) {
                const original = createBaseProfile();
                original.CodecProfiles = [ createStockVideoCodecProfile('vp9', stockVideoRangeTypes) ];
                const result = augmentDeviceProfileForCustomDecode(
                    original,
                    createCapabilities({ supportedVideoCodecs: [ 'vp9' ], supportedAudioCodecs: [ 'aac' ], supportedRawHDRVideoCodecs: [ 'vp9' ] }),
                    { allowRawHDR: true, authorizedRawHDRRouteKeys: routeKeys }
                );

                expect(
                    isDirectPlayAdvertised(result.profile, createVideoStream('vp9', profile, bitDepth, rangeType, color)),
                    stockVideoRangeTypes
                ).toBe(advertised);
            }
        }
    );

    it('advertises a Profile 10 item labeled by transfer through its own exact route', () => {
        const mediaStream = createProfile10Stream(null, 'HDR10');
        const capabilities = createCapabilities({ supportedVideoCodecs: [ 'av1' ], supportedAudioCodecs: [ 'aac' ], supportedRawHDRVideoCodecs: [ 'av1' ] });
        const options = { allowDolbyVision: true, allowRawHDR: false };

        const genericResult = augmentDeviceProfileForCustomDecode(createBaseProfile(), capabilities, options);
        const itemResult = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            capabilities,
            { ...options, itemMediaSource: { MediaStreams: [ mediaStream ] } }
        );

        expect(isDirectPlayAdvertised(genericResult.profile, mediaStream)).toBe(false);
        expect(isDirectPlayAdvertised(itemResult.profile, mediaStream)).toBe(true);
        // Jellyfin's Main merges into the generic main token instead of a second, conflicting pair
        expect(getMeasuredRoutePairs(itemResult.profile, 'av1').every(pair => (
            pair.startsWith('main|')
        ))).toBe(true);
        expect(getMeasuredRoutePairs(itemResult.profile, 'av1')).toContain('main|HDR10');
    });

    it('widens the stock av1 profile for an 8-bit 10.2 item on native AV1 decode alone', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ createStockVideoCodecProfile('av1', 'SDR') ];
        const mediaStream = createProfile10Stream(2, 'DOVIWithSDR', {
            BitDepth: 8,
            ColorPrimaries: 'bt709',
            ColorSpace: 'bt709',
            ColorTransfer: 'bt709',
            VideoRange: 'SDR'
        });

        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities({ supportedVideoCodecs: [ 'av1' ], supportedAudioCodecs: [ 'aac' ] }),
            {
                allowDolbyVision: true,
                allowRawHDR: false,
                itemMediaSource: { MediaStreams: [ mediaStream ] }
            }
        );

        expect(isDirectPlayAdvertised(result.profile, mediaStream)).toBe(true);
        expect(isDirectPlayAdvertised(result.profile, createProfile10Stream(2, 'DOVIWithSDR', { BitDepth: 10 }))).toBe(false);
    });

    it('advertises an 8-bit HEVC range-extension Dolby Vision item through its own exact route', () => {
        const dolbyVisionFields = {
            BlPresentFlag: true,
            DvBlSignalCompatibilityId: 0,
            DvProfile: 8,
            ElPresentFlag: false,
            RpuPresentFlag: true
        };
        const rangeExtensionStream = createVideoStream('hevc', 'Rext', 8, 'DOVIInvalid', {
            ...dolbyVisionFields,
            PixelFormat: 'yuv420p'
        });
        // No raw route decodes 8-bit Main planes, so an 8-bit Main base layer without a compatible base has no route
        const mainStream = createVideoStream('hevc', 'Main', 8, 'DOVIInvalid', dolbyVisionFields);
        const capabilities = withUnqualifiedHEVCRangeExtensions(
            createCapabilities({ supportedVideoCodecs: [ 'hevc' ], supportedAudioCodecs: [ 'aac' ], supportedRawHDRVideoCodecs: [ 'hevc' ] }),
            [ 'rext420-8' ]
        );
        const options = { allowDolbyVision: true, allowRawHDR: false };

        const genericResult = augmentDeviceProfileForCustomDecode(createBaseProfileWithStockHEVC('main|main 10'), capabilities, options);
        const itemResult = augmentDeviceProfileForCustomDecode(
            createBaseProfileWithStockHEVC('main|main 10'),
            capabilities,
            { ...options, itemMediaSource: { MediaStreams: [ rangeExtensionStream ] } }
        );
        const mainItemResult = augmentDeviceProfileForCustomDecode(
            createBaseProfileWithStockHEVC('main|main 10'),
            capabilities,
            { ...options, itemMediaSource: { MediaStreams: [ mainStream ] } }
        );

        expect(isDirectPlayAdvertised(genericResult.profile, rangeExtensionStream)).toBe(false);
        expect(isDirectPlayAdvertised(itemResult.profile, rangeExtensionStream)).toBe(true);
        expect(isDirectPlayAdvertised(mainItemResult.profile, mainStream)).toBe(false);
    });

    it('advertises a Dolby Vision item whose declared base the HEVC decoder package decodes without native HEVC', () => {
        // Profile 8.1, whose compatibility ID 1 declares an HDR10 base
        const mediaStream = createVideoStream('hevc', 'Main 10', 10, 'DOVIWithHDR10', {
            BlPresentFlag: true,
            ColorPrimaries: 'bt2020',
            ColorSpace: 'bt2020nc',
            ColorTransfer: 'smpte2084',
            DvBlSignalCompatibilityId: 1,
            DvProfile: 8,
            ElPresentFlag: false,
            RpuPresentFlag: true,
            VideoRange: 'HDR'
        });
        const capabilities = createCapabilities({ supportedVideoCodecs: [], supportedAudioCodecs: [ 'aac' ] });
        const options: CustomDeviceProfileOptions = { allowFramePoolHDR: true, allowRawHDR: false, decoderPackages: [ HEVC_DECODER_PACKAGE ] };
        const itemMediaSource = { MediaStreams: [ mediaStream ] };
        const isAdvertised = (profileOptions: CustomDeviceProfileOptions): boolean => isDirectPlayAdvertised(
            augmentDeviceProfileForCustomDecode(createBaseProfile(), capabilities, profileOptions).profile,
            mediaStream
        );

        // The generic package routes carry no Dolby Vision label
        expect(isAdvertised(options)).toBe(false);
        expect(isAdvertised({ ...options, itemMediaSource })).toBe(true);
        // The frame pool presents the HDR10 base only under the user's HDR tone mapping, and only a video package decodes it
        expect(isAdvertised({ ...options, allowFramePoolHDR: false, itemMediaSource })).toBe(false);
        expect(isAdvertised({ ...options, decoderPackages: [ EAC3_DECODER_PACKAGE ], itemMediaSource })).toBe(false);
    });

    it('never widens a retry, even for a Dolby Vision item with a route', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ createStockVideoCodecProfile('av1', 'SDR') ];

        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities({ supportedVideoCodecs: [ 'av1' ], supportedAudioCodecs: [ 'aac' ], supportedRawHDRVideoCodecs: [ 'av1' ] }),
            {
                allowDolbyVision: true,
                allowRawHDR: true,
                allowRawSDR: true,
                authorizedRawHDRRouteKeys: [
                    ...RAW_HDR_PROFILE_OPTIONS.authorizedRawHDRRouteKeys,
                    ...RAW_SDR_ROUTE_KEYS
                ],
                isRetry: true,
                itemMediaSource: { MediaStreams: [ createProfile10Stream(null, 'HDR10') ] }
            }
        );

        expect(result.profile).toEqual(original);
        expect(result.telemetry).toMatchObject({
            addedProfileCount: 0,
            reason: 'retry-not-widened',
            widenedHDRCodecProfileCount: 0
        });
    });

    it('advertises HEVC HLG when the raw HLG key is the only HDR authorization', () => {
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfileWithStockHEVC('main|main 10'),
            withUnqualifiedHEVCRangeExtensions(createCapabilities({ supportedVideoCodecs: [ 'hevc' ], supportedAudioCodecs: [ 'aac' ], supportedRawHDRVideoCodecs: [ 'hevc' ] })),
            {
                allowRawHDR: true,
                authorizedRawHDRRouteKeys: [ RAW_HLG_ROUTE_KEY ]
            }
        );

        // Unlike PQ, which brings HDR10+, HLG adds no HEVC-only range, so the HEVC plan must carry it on its own
        expect(isDirectPlayAdvertised(result.profile, createVideoStream('hevc', 'Main 10', 10, 'HLG', {
            ColorPrimaries: 'bt2020',
            ColorSpace: 'bt2020nc',
            ColorTransfer: 'arib-std-b67',
            VideoRange: 'HDR'
        }))).toBe(true);
    });

    it('advertises the generic Profile 7 ranges from the raw base layer alone, and not without raw HEVC', () => {
        const stream = createVideoStream('hevc', 'Main 10', 10, 'DOVIWithEL', {
            BlPresentFlag: true,
            ColorPrimaries: 'bt2020',
            ColorSpace: 'bt2020nc',
            ColorTransfer: 'smpte2084',
            DvBlSignalCompatibilityId: 0,
            DvProfile: 7,
            ElPresentFlag: true,
            RpuPresentFlag: true,
            VideoRange: 'HDR'
        });
        const options = { allowDolbyVisionProfile7: true, allowRawHDR: false };

        const rawResult = augmentDeviceProfileForCustomDecode(
            createBaseProfileWithStockHEVC('main|main 10'),
            withUnqualifiedHEVCRangeExtensions(createCapabilities({ supportedVideoCodecs: [ 'hevc' ], supportedAudioCodecs: [ 'aac' ], supportedRawHDRVideoCodecs: [ 'hevc' ] })),
            options
        );
        const nativeOnlyResult = augmentDeviceProfileForCustomDecode(
            createBaseProfileWithStockHEVC('main|main 10'),
            withUnqualifiedHEVCRangeExtensions(createCapabilities({ supportedVideoCodecs: [ 'hevc' ], supportedAudioCodecs: [ 'aac' ] })),
            options
        );

        // No decoder decodes the EL, so Profile 7 reconstructs from its BL's raw Main 10 planes
        expect(isDirectPlayAdvertised(rawResult.profile, stream)).toBe(true);
        expect(isDirectPlayAdvertised(nativeOnlyResult.profile, stream)).toBe(false);
    });
});

// The AV1 raw format variants Chrome's software decoder decodes and copies; it refuses 12-bit AV1
const CHROME_AV1_RAW_FORMAT_VARIANTS = AV1_RAW_FORMAT_VARIANTS.filter((variant: AV1RawFormatVariant): boolean => (
    AV1_RAW_FORMAT_PROBE_DEFINITIONS[variant].bitDepth < 12
));

/** Adds AV1 raw-format evidence, unqualified apart from the given variants. */
function withAV1RawFormats(
    capabilities: CustomDecodeCapabilities,
    supportedVariants: readonly AV1RawFormatVariant[]
): CustomDecodeCapabilities {
    const av1RawFormats = {} as Record<AV1RawFormatVariant, AV1RawFormatCapability>;
    for (const variant of AV1_RAW_FORMAT_VARIANTS) {
        av1RawFormats[variant] = createAV1RawFormatCapability(variant, supportedVariants.includes(variant));
    }
    return { ...capabilities, av1RawFormats };
}

/** Returns the depth condition of a codec's exact route for one profile/range pair. */
function getMeasuredRoutePairBitDepths(profile: DeviceProfile, codec: string, pair: string): string | undefined {
    const codecProfile = (profile.CodecProfiles ?? []).find(candidate => {
        const applyConditions = candidate.ApplyConditions ?? [];
        const profileValue = applyConditions.find(condition => condition.Property === 'VideoProfile')?.Value;
        const rangeValue = applyConditions.find(condition => condition.Property === 'VideoRangeType')?.Value;
        return candidate.Codec === codec && `${profileValue}|${rangeValue}` === pair;
    });
    return codecProfile?.Conditions?.find(condition => condition.Property === 'VideoBitDepth')?.Value ?? undefined;
}

/** Returns both BT.709 raw SDR keys of each format, which stand for the format's every SDR key in a profile. */
function getBT709RawSDRRouteKeys(formats: readonly HEVCRangeExtensionRawFormat[]): RawHDRAuthorizationRouteKey[] {
    return formats.flatMap((format: HEVCRangeExtensionRawFormat): RawHDRAuthorizationRouteKey[] => [
        `${format}:bt709:bt709:limited:sdr`,
        `${format}:bt709:bt709:full:sdr`
    ]);
}

const AV1_RAW_FORMAT_CAPABILITY_OPTIONS = {
    supportedAudioCodecs: [ 'aac' ],
    supportedRawHDRVideoCodecs: [ 'av1' ],
    supportedVideoCodecs: [ 'av1' ]
} as const;

const EIGHT_BIT_PROFILE_10_STREAM = createProfile10Stream(2, 'DOVIWithSDR', {
    BitDepth: 8,
    ColorPrimaries: 'bt709',
    ColorSpace: 'bt709',
    ColorTransfer: 'bt709',
    PixelFormat: 'yuv420p',
    VideoRange: 'SDR'
});

/** Returns the base profile with Jellyfin Web's stock AV1 codec profile of an HDR display, which conditions on Main. */
function createBaseProfileWithStockAV1(): DeviceProfile {
    const profile = createBaseProfile();
    const stockProfile = createStockVideoCodecProfile('av1', HDR_DISPLAY_STOCK_VIDEO_RANGE_TYPES);
    profile.CodecProfiles = [ {
        ...stockProfile,
        Conditions: [
            { Condition: 'EqualsAny', IsRequired: false, Property: 'VideoProfile', Value: 'main' },
            ...stockProfile.Conditions ?? []
        ]
    } ];
    return profile;
}

describe('augmentDeviceProfileForCustomDecode AV1 raw formats outside Main 10', () => {
    it('advertises each qualified raw format under its profile and depth, with the ranges its keys and the RPU route authorize', () => {
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfileWithStockAV1(),
            withAV1RawFormats(createCapabilities(AV1_RAW_FORMAT_CAPABILITY_OPTIONS), CHROME_AV1_RAW_FORMAT_VARIANTS),
            {
                allowDolbyVision: true,
                allowRawHDR: true,
                allowRawSDR: true,
                authorizedRawHDRRouteKeys: [
                    ...RAW_HDR_PROFILE_OPTIONS.authorizedRawHDRRouteKeys,
                    ...RAW_SDR_ROUTE_KEYS,
                    ...getBT709RawSDRRouteKeys([ 'I444', 'I444P10', 'I422', 'I422P10' ]),
                    'I444P10:bt2020-ncl:bt2020:limited:pq'
                ]
            }
        );
        const pairBitDepths = (pair: string): string | undefined => getMeasuredRoutePairBitDepths(result.profile, 'av1', pair);

        expect(pairBitDepths('high|SDR')).toBe('8|10');
        expect(pairBitDepths('professional|SDR')).toBe('8|10');
        // HDR10+ joins HDR10 on the format's PQ key; its HLG key and the I422P10 HDR keys were not authorized
        expect(pairBitDepths('high|HDR10')).toBe('10');
        expect(pairBitDepths('high|HDR10Plus')).toBe('10');
        expect(pairBitDepths('high|HLG')).toBe('0');
        expect(pairBitDepths('professional|HDR10')).toBe('0');
        // Profile 10 reconstructs from every qualified format, and at 8 bits from I420 beside raw Main 10
        expect(pairBitDepths('main|DOVIWithSDR')).toBe('10|8');
        expect(pairBitDepths('high|DOVIWithHDR10')).toBe('8|10');
        expect(pairBitDepths('professional|DOVIInvalid')).toBe('8|10');
        // 8-bit Main SDR keeps its native route, which raw 10-bit SDR joins
        expect(pairBitDepths('main|SDR')).toBe('8|10');
        expect(isDirectPlayAdvertised(result.profile, EIGHT_BIT_PROFILE_10_STREAM)).toBe(true);
        expect(isDirectPlayAdvertised(result.profile, createVideoStream('av1', 'High', 8, 'SDR', { PixelFormat: 'yuv444p' }))).toBe(true);
        expect(isDirectPlayAdvertised(result.profile, createVideoStream('av1', 'Professional', 10, 'SDR', { PixelFormat: 'yuv422p10le' }))).toBe(true);
        expect(isDirectPlayAdvertised(result.profile, createVideoStream('av1', 'High', 10, 'HDR10', { ...PQ_STREAM_COLOR, PixelFormat: 'yuv444p10le' }))).toBe(true);
        // The 12-bit variants did not qualify
        expect(isDirectPlayAdvertised(result.profile, createVideoStream('av1', 'Professional', 12, 'SDR', { PixelFormat: 'yuv420p12le' }))).toBe(false);
    });

    it('advertises no raw format outside Main 10 without its qualification', () => {
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfileWithStockAV1(),
            withAV1RawFormats(createCapabilities(AV1_RAW_FORMAT_CAPABILITY_OPTIONS), []),
            {
                allowDolbyVision: true,
                allowRawHDR: true,
                allowRawSDR: true,
                authorizedRawHDRRouteKeys: [
                    ...RAW_HDR_PROFILE_OPTIONS.authorizedRawHDRRouteKeys,
                    ...RAW_SDR_ROUTE_KEYS,
                    ...getBT709RawSDRRouteKeys([ 'I420', 'I444', 'I444P10', 'I422', 'I422P10' ])
                ]
            }
        );

        expect(getMeasuredRoutePairs(result.profile, 'av1').every(pair => pair.startsWith('main|'))).toBe(true);
        expect(getMeasuredRoutePairBitDepths(result.profile, 'av1', 'main|DOVIWithSDR')).toBe('10');
        expect(isDirectPlayAdvertised(result.profile, EIGHT_BIT_PROFILE_10_STREAM)).toBe(false);
        expect(isDirectPlayAdvertised(result.profile, createVideoStream('av1', 'High', 8, 'SDR', { PixelFormat: 'yuv444p' }))).toBe(false);
    });

    it('needs both BT.709 keys of a format for its SDR, its HDR key for HDR, and the RPU route for Profile 10', () => {
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfileWithStockAV1(),
            withAV1RawFormats(createCapabilities(AV1_RAW_FORMAT_CAPABILITY_OPTIONS), CHROME_AV1_RAW_FORMAT_VARIANTS),
            {
                allowRawHDR: true,
                allowRawSDR: true,
                authorizedRawHDRRouteKeys: [
                    ...RAW_HDR_PROFILE_OPTIONS.authorizedRawHDRRouteKeys,
                    'I444:bt709:bt709:limited:sdr',
                    ...getBT709RawSDRRouteKeys([ 'I422' ])
                ]
            }
        );

        expect(isDirectPlayAdvertised(result.profile, createVideoStream('av1', 'High', 8, 'SDR', { PixelFormat: 'yuv444p' }))).toBe(false);
        expect(isDirectPlayAdvertised(result.profile, createVideoStream('av1', 'Professional', 8, 'SDR', { PixelFormat: 'yuv422p' }))).toBe(true);
        expect(isDirectPlayAdvertised(result.profile, createVideoStream('av1', 'Professional', 10, 'SDR', { PixelFormat: 'yuv422p10le' }))).toBe(false);
        expect(isDirectPlayAdvertised(result.profile, createVideoStream('av1', 'High', 10, 'HDR10', { ...PQ_STREAM_COLOR, PixelFormat: 'yuv444p10le' }))).toBe(false);
        expect(isDirectPlayAdvertised(result.profile, EIGHT_BIT_PROFILE_10_STREAM)).toBe(false);
    });
});

/** Adds H.264 raw-format evidence, unqualified apart from the given variants. */
function withH264RawFormats(
    capabilities: CustomDecodeCapabilities,
    supportedVariants: readonly H264RawFormatVariant[]
): CustomDecodeCapabilities {
    const h264RawFormats = {} as Record<H264RawFormatVariant, H264RawFormatCapability>;
    for (const variant of H264_RAW_FORMAT_VARIANTS) {
        h264RawFormats[variant] = createH264RawFormatCapability(variant, supportedVariants.includes(variant));
    }
    return { ...capabilities, h264RawFormats };
}

/** Returns the base profile with Jellyfin Web's stock H.264 codec profile of an HDR display, which conditions on the 8-bit profiles. */
function createBaseProfileWithStockH264(): DeviceProfile {
    const profile = createBaseProfile();
    const stockProfile = createStockVideoCodecProfile('h264', HDR_DISPLAY_STOCK_VIDEO_RANGE_TYPES);
    profile.CodecProfiles = [ {
        ...stockProfile,
        Conditions: [
            { Condition: 'EqualsAny', IsRequired: false, Property: 'VideoProfile', Value: 'high|main|baseline|constrained baseline' },
            ...stockProfile.Conditions ?? []
        ]
    } ];
    return profile;
}

const H264_RAW_FORMAT_CAPABILITY_OPTIONS = {
    supportedAudioCodecs: [ 'aac' ],
    supportedVideoCodecs: [ 'h264' ]
} as const;
const H264_RAW_FORMATS = [ 'I420P10', 'I422', 'I422P10', 'I444', 'I444P10' ] as const;

function augmentH264RawFormats(
    supportedVariants: readonly H264RawFormatVariant[],
    authorizedRawHDRRouteKeys: readonly RawHDRAuthorizationRouteKey[],
    capabilities: CustomDecodeCapabilities = createCapabilities(H264_RAW_FORMAT_CAPABILITY_OPTIONS)
): DeviceProfile {
    return augmentDeviceProfileForCustomDecode(
        createBaseProfileWithStockH264(),
        withH264RawFormats(capabilities, supportedVariants),
        { allowRawHDR: true, allowRawSDR: true, authorizedRawHDRRouteKeys }
    ).profile;
}

function createH264Stream(
    profile: string,
    bitDepth: number,
    pixelFormat: string,
    videoRangeType = 'SDR'
): Readonly<Record<string, unknown>> {
    const STREAM_COLORS: Readonly<Record<string, Readonly<Record<string, string>>>> = { HLG: HLG_STREAM_COLOR, SDR: {} };
    const color = STREAM_COLORS[videoRangeType] ?? PQ_STREAM_COLOR;
    return createVideoStream('h264', profile, bitDepth, videoRangeType, { ...color, PixelFormat: pixelFormat });
}

describe('augmentDeviceProfileForCustomDecode H.264 raw formats beyond High', () => {
    it('advertises each profile at the depths whose whole format envelope qualified, with the ranges its keys authorize', () => {
        const profile = augmentH264RawFormats(H264_RAW_FORMAT_VARIANTS, [
            ...getBT709RawSDRRouteKeys(H264_RAW_FORMATS),
            'I420P10:bt2020-ncl:bt2020:limited:pq',
            'I422P10:bt2020-ncl:bt2020:limited:pq'
        ]);
        const pairBitDepths = (pair: string): string | undefined => getMeasuredRoutePairBitDepths(profile, 'h264', pair);

        // 8-bit 4:2:0 under a profile beyond High is no variant, so High 10 takes 10 bits alone
        expect(pairBitDepths('high 10|SDR')).toBe('10');
        expect(pairBitDepths('high 10 intra|SDR')).toBe('10');
        expect(pairBitDepths('high 4:2:2|SDR')).toBe('8|10');
        expect(pairBitDepths('high 4:4:4 predictive|SDR')).toBe('8|10');
        expect(pairBitDepths('cavlc 4:4:4|SDR')).toBe('8|10');
        // HDR is 10-bit only, and each profile needs the PQ key of every format it may code
        expect(pairBitDepths('high 10|HDR10')).toBe('10');
        expect(pairBitDepths('high 4:2:2|HDR10Plus')).toBe('10');
        expect(pairBitDepths('high 4:4:4 predictive|HDR10')).toBe('0');
        expect(pairBitDepths('high 10|HLG')).toBe('0');
        // The native route stays 8-bit SDR
        expect(pairBitDepths('high|SDR')).toBe('8');
        expect(pairBitDepths('high|HDR10')).toBe('0');

        expect(isDirectPlayAdvertised(profile, createH264Stream('High 10', 10, 'yuv420p10le'))).toBe(true);
        expect(isDirectPlayAdvertised(profile, createH264Stream('High 4:4:4 Predictive', 8, 'yuv444p'))).toBe(true);
        expect(isDirectPlayAdvertised(profile, createH264Stream('High 4:2:2', 10, 'yuv422p10le', 'HDR10'))).toBe(true);
        expect(isDirectPlayAdvertised(profile, createH264Stream('High 4:4:4 Predictive', 10, 'yuv444p10le', 'HDR10'))).toBe(false);
        expect(isDirectPlayAdvertised(profile, createH264Stream('High 10', 10, 'yuv420p10le', 'HLG'))).toBe(false);
        expect(isDirectPlayAdvertised(profile, createH264Stream('High', 8, 'yuv420p'))).toBe(true);
        expect(isDirectPlayAdvertised(profile, createH264Stream('High', 10, 'yuv420p10le'))).toBe(false);
    });

    it('withholds a profile at a depth when any format it may code there did not qualify', () => {
        const routeKeys = getBT709RawSDRRouteKeys(H264_RAW_FORMATS);
        // High 4:2:2 at 10 bits also codes 4:2:0
        const without422Ten = augmentH264RawFormats([ 'high420-10', 'high422-8', 'high444-8' ], routeKeys);
        // High 4:4:4 Predictive at 8 bits also codes 4:2:2
        const without422Eight = augmentH264RawFormats([ 'high420-10', 'high422-10', 'high444-8', 'high444-10' ], routeKeys);

        expect(getMeasuredRoutePairBitDepths(without422Ten, 'h264', 'high 10|SDR')).toBe('10');
        expect(getMeasuredRoutePairBitDepths(without422Ten, 'h264', 'high 4:2:2|SDR')).toBe('8');
        expect(getMeasuredRoutePairBitDepths(without422Ten, 'h264', 'high 4:4:4 predictive|SDR')).toBe('8');
        expect(isDirectPlayAdvertised(without422Ten, createH264Stream('High 4:2:2', 10, 'yuv422p10le'))).toBe(false);
        expect(isDirectPlayAdvertised(without422Ten, createH264Stream('High 4:2:2', 8, 'yuv422p'))).toBe(true);

        expect(getMeasuredRoutePairBitDepths(without422Eight, 'h264', 'high 4:2:2|SDR')).toBe('10');
        expect(getMeasuredRoutePairBitDepths(without422Eight, 'h264', 'high 4:4:4 predictive|SDR')).toBe('10');
        expect(isDirectPlayAdvertised(without422Eight, createH264Stream('High 4:4:4 Predictive', 8, 'yuv444p'))).toBe(false);
        expect(isDirectPlayAdvertised(without422Eight, createH264Stream('High 4:4:4 Predictive', 10, 'yuv444p10le'))).toBe(true);
    });

    it('needs both BT.709 keys of every format for SDR, and the raw HDR key for HDR', () => {
        const profile = augmentH264RawFormats(H264_RAW_FORMAT_VARIANTS, [
            ...getBT709RawSDRRouteKeys([ 'I420P10', 'I422P10', 'I444', 'I444P10' ]),
            'I422:bt709:bt709:limited:sdr',
            'I420P10:bt2020-ncl:bt2020:limited:hlg'
        ]);

        // I422 lacks its full-range key, which every 8-bit profile beyond High may code
        expect(getMeasuredRoutePairBitDepths(profile, 'h264', 'high 4:2:2|SDR')).toBe('10');
        expect(getMeasuredRoutePairBitDepths(profile, 'h264', 'high 4:4:4 predictive|SDR')).toBe('10');
        expect(isDirectPlayAdvertised(profile, createH264Stream('High 4:2:2', 8, 'yuv422p'))).toBe(false);
        expect(isDirectPlayAdvertised(profile, createH264Stream('High 10', 10, 'yuv420p10le', 'HLG'))).toBe(true);
        expect(isDirectPlayAdvertised(profile, createH264Stream('High 10', 10, 'yuv420p10le', 'HDR10'))).toBe(false);
        expect(isDirectPlayAdvertised(profile, createH264Stream('High 4:2:2', 10, 'yuv422p10le', 'HLG'))).toBe(false);
    });

    it('keeps the native H.264 advertisement unchanged when no raw format qualified', () => {
        const routeKeys = getBT709RawSDRRouteKeys(H264_RAW_FORMATS);
        const unqualified = augmentH264RawFormats([], routeKeys);
        const withoutEvidence = augmentDeviceProfileForCustomDecode(
            createBaseProfileWithStockH264(),
            createCapabilities(H264_RAW_FORMAT_CAPABILITY_OPTIONS),
            { allowRawHDR: true, allowRawSDR: true, authorizedRawHDRRouteKeys: routeKeys }
        ).profile;

        expect(unqualified).toEqual(withoutEvidence);
        expect(isDirectPlayAdvertised(unqualified, createH264Stream('High', 8, 'yuv420p'))).toBe(true);
        expect(isDirectPlayAdvertised(unqualified, createH264Stream('High 10', 10, 'yuv420p10le'))).toBe(false);
    });

    it('lists H.264 for direct play when only raw formats decode it', () => {
        const capabilities = createCapabilities(H264_RAW_FORMAT_CAPABILITY_OPTIONS);
        const profile = augmentH264RawFormats(
            H264_RAW_FORMAT_VARIANTS,
            getBT709RawSDRRouteKeys(H264_RAW_FORMATS),
            { ...capabilities, h264Profiles: createH264ProfileCapabilities(false) }
        );

        expect(isDirectPlayAdvertised(profile, createH264Stream('High 10', 10, 'yuv420p10le'))).toBe(true);
        expect(isDirectPlayAdvertised(profile, createH264Stream('High', 8, 'yuv420p'))).toBe(false);
    });

    it.each([
        { bitDepth: 10, pixelFormat: 'yuv422p10le', profile: 'High 4:2:2 Intra', variants: [ 'high420-10', 'high422-10' ] },
        { bitDepth: 8, pixelFormat: 'yuv444p', profile: 'High 4:4:4 Predictive', variants: [ 'high422-8', 'high444-8' ] }
    ])('advertises $profile at $bitDepth bits from the probes the engine selects for such an item', async ({ bitDepth, pixelFormat, profile, variants }) => {
        const stream = createH264Stream(profile, bitDepth, pixelFormat);
        // A browser whose software decoder decodes and copies every vector the selection downloads
        const probed = await new CustomDecodeCapabilityProbe({
            h264RawFormatVectorLoader: (assetPath: string): Promise<ArrayBuffer> => {
                const definition = H264_RAW_FORMAT_VARIANTS
                    .map((variant: H264RawFormatVariant) => H264_RAW_FORMAT_PROBE_DEFINITIONS[variant])
                    .find(candidate => candidate.assetPath === assetPath);
                const byteLength = definition?.accessUnits.reduce((total: number, accessUnit): number => total + accessUnit.byteLength, 0) ?? 0;
                return Promise.resolve(new ArrayBuffer(byteLength));
            },
            rawHDRVideoOutputProbe: () => Promise.resolve({ outputCopySupported: true }),
            videoDecoder: { isConfigSupported: (config: VideoDecoderConfig) => Promise.resolve({ config, supported: true }) }
        }).probe({ MediaSources: [ { MediaStreams: [ stream ] } ] });

        expect(H264_RAW_FORMAT_VARIANTS.filter(variant => probed.h264RawFormats?.[variant].status === 'supported')).toEqual(variants);
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfileWithStockH264(),
            { ...createCapabilities(H264_RAW_FORMAT_CAPABILITY_OPTIONS), h264RawFormats: probed.h264RawFormats },
            { allowRawHDR: true, allowRawSDR: true, authorizedRawHDRRouteKeys: getBT709RawSDRRouteKeys(H264_RAW_FORMATS) }
        ).profile;

        expect(isDirectPlayAdvertised(result, stream)).toBe(true);
    });
});

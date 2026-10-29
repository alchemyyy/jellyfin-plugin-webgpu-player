import type {
    CustomAudioCodec,
    CustomDecodeCodecCapability,
    CustomVideoCodec
} from 'webgpu-player/capability/CustomDecodeCapabilities';
import {
    AV1_RAW_FORMAT_PROBE_DEFINITIONS,
    type AV1RawFormatCapability,
    type AV1RawFormatVariant
} from 'webgpu-player/capability/AV1RawFormatCapabilities';
import {
    H264_JELLYFIN_PROFILE_NAMES,
    H264_PROFILE_PROBE_CODED_HEIGHT,
    H264_PROFILE_PROBE_CODED_WIDTH,
    H264_PROFILES,
    type H264ProfileCapabilities
} from 'webgpu-player/capability/H264ProfileCapabilities';
import {
    H264_RAW_FORMAT_PROBE_DEFINITIONS,
    type H264RawFormatCapability,
    type H264RawFormatVariant
} from 'webgpu-player/capability/H264RawFormatCapabilities';
import {
    HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS,
    type HEVCRangeExtensionCapability,
    type HEVCRangeExtensionVariant
} from 'webgpu-player/capability/HEVCRangeExtensionCapabilities';

// Capability records shared by the custom decode suites: WebCodecs codec results, H.264 profile results, HEVC range-extension, AV1 and H.264 raw-format probe results, and the codecs the engine has no decoder of

/** Builds a WebCodecs codec capability as the configuration probe alone reports it. */
export function createConfigCodecCapability<Codec extends CustomAudioCodec | CustomVideoCodec>(
    codec: Codec,
    supported: boolean
): CustomDecodeCodecCapability<Codec> {
    return {
        codec,
        codecString: codec,
        reason: supported ? 'config-supported' : 'config-unsupported',
        status: supported ? 'supported' : 'unsupported'
    };
}

/** Builds a WebCodecs codec capability whose support decoded output verified. */
export function createVerifiedCodecCapability<Codec extends CustomAudioCodec | CustomVideoCodec>(
    codec: Codec,
    supported: boolean
): CustomDecodeCodecCapability<Codec> {
    return {
        codec,
        codecString: codec,
        reason: supported ? 'decode-output-verified' : 'config-unsupported',
        status: supported ? 'supported' : 'unsupported'
    };
}

/** Builds every H.264 profile's probe result, each with decoded-output evidence or none. */
export function createH264ProfileCapabilities(supported: boolean): H264ProfileCapabilities {
    const capabilities = {} as Record<typeof H264_PROFILES[number], H264ProfileCapabilities[typeof H264_PROFILES[number]]>;
    for (const profile of H264_PROFILES) {
        capabilities[profile] = Object.freeze({
            codecString: profile,
            codedHeight: H264_PROFILE_PROBE_CODED_HEIGHT,
            codedWidth: H264_PROFILE_PROBE_CODED_WIDTH,
            evidence: supported ? 'decoded-output' : 'none',
            jellyfinProfileName: H264_JELLYFIN_PROFILE_NAMES[profile],
            profile,
            reason: supported ? 'decode-output-verified' : 'config-unsupported',
            status: supported ? 'supported' : 'unsupported'
        });
    }
    return Object.freeze(capabilities);
}

/** Builds the output-copy probe result of one HEVC range-extension variant from its probe definition. */
export function createHEVCRangeExtensionCapability(variant: HEVCRangeExtensionVariant, supported: boolean): HEVCRangeExtensionCapability {
    const definition = HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS[variant];
    return {
        bitDepth: definition.bitDepth,
        chromaFormat: definition.chromaFormat,
        codec: 'hevc',
        codecString: definition.config.codec,
        format: definition.format,
        jellyfinProfile: definition.jellyfinProfile,
        pixelFormat: definition.pixelFormat,
        reason: supported ? 'output-copy-supported' : 'output-copy-unsupported',
        status: supported ? 'supported' : 'unsupported',
        variant
    };
}

/** Builds the output-copy probe result of one AV1 raw-format variant from its probe definition. */
export function createAV1RawFormatCapability(variant: AV1RawFormatVariant, supported: boolean): AV1RawFormatCapability {
    const definition = AV1_RAW_FORMAT_PROBE_DEFINITIONS[variant];
    return {
        bitDepth: definition.bitDepth,
        chromaFormat: definition.chromaFormat,
        codec: 'av1',
        codecString: definition.config.codec,
        format: definition.format,
        jellyfinProfile: definition.jellyfinProfile,
        pixelFormat: definition.pixelFormat,
        reason: supported ? 'output-copy-supported' : 'output-copy-unsupported',
        status: supported ? 'supported' : 'unsupported',
        variant
    };
}

/** Builds the output-copy probe result of one H.264 raw-format variant from its probe definition. */
export function createH264RawFormatCapability(variant: H264RawFormatVariant, supported: boolean): H264RawFormatCapability {
    const definition = H264_RAW_FORMAT_PROBE_DEFINITIONS[variant];
    return {
        bitDepth: definition.bitDepth,
        chromaFormat: definition.chromaFormat,
        codec: 'h264',
        codecString: definition.config.codec,
        format: definition.format,
        jellyfinProfile: definition.jellyfinProfile,
        pixelFormat: definition.pixelFormat,
        reason: supported ? 'output-copy-supported' : 'output-copy-unsupported',
        status: supported ? 'supported' : 'unsupported',
        variant
    };
}

/** Builds the capability the probe reports for a codec the engine has no decoder of, which only a decoder package or a media element plays. */
export function createNoEngineDecoderCodecCapability<Codec extends CustomAudioCodec | CustomVideoCodec>(
    codec: Codec
): CustomDecodeCodecCapability<Codec> {
    return {
        codec,
        codecString: codec,
        reason: 'no-engine-decoder',
        status: 'unsupported'
    };
}

import type {
    CustomAudioCodec,
    CustomDecodeCapabilities,
    CustomDecodeCodecCapability,
    CustomVideoCodec
} from 'webgpu-player/capability/CustomDecodeCapabilities';
import {
    H264_JELLYFIN_PROFILE_NAMES,
    H264_PROFILE_PROBE_CODED_HEIGHT,
    H264_PROFILE_PROBE_CODED_WIDTH,
    H264_PROFILES,
    type H264ProfileCapabilities
} from 'webgpu-player/capability/H264ProfileCapabilities';
import {
    HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS,
    type HEVCRangeExtensionCapability,
    type HEVCRangeExtensionVariant
} from 'webgpu-player/capability/HEVCRangeExtensionCapabilities';

// Capability records shared by the custom decode suites: WebCodecs codec results, H.264 profile results, HEVC range-extension probe results, and the bundled HEVC qualifications

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

/** Builds bundled HEVC qualifications in which every vector decoded. */
export function createBundledHEVCCapabilities(): NonNullable<CustomDecodeCapabilities['bundledHEVC']> {
    return {
        qualifications: {
            'main-1080p': {
                bitDepth: 8,
                codecString: 'hvc1.1.6.L120.B0',
                vector: 'main-1080p',
                format: 'I420',
                profile: 'main',
                reason: 'decode-output-verified',
                status: 'supported'
            },
            'main10-1080p': {
                bitDepth: 10,
                codecString: 'hvc1.2.4.L120.B0',
                vector: 'main10-1080p',
                format: 'I420P10',
                profile: 'main10',
                reason: 'decode-output-verified',
                status: 'supported'
            },
            'main10-4k': {
                bitDepth: 10,
                codecString: 'hvc1.2.4.L153.B0',
                vector: 'main10-4k',
                format: 'I420P10',
                profile: 'main10',
                reason: 'decode-output-verified',
                status: 'supported'
            }
        },
        reason: 'complete'
    };
}

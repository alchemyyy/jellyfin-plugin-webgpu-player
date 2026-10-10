import type { DeviceProfile } from '@jellyfin/sdk/lib/generated-client/models/device-profile';
import escapeHtml from 'escape-html';

import { PlayerEvent } from 'apps/legacy/features/playback/constants/playerEvent';
import { PluginType } from 'constants/pluginType';
import globalize from 'lib/globalize';
import Events from 'utils/events';
import { MediaError } from 'types/mediaError';

import { PLAYBACK_SUPERSEDED } from './constants/playbackResult';
import { WebGPUPlayerEvent } from './constants/playerEvent';
import { loadAddonStrings } from './host/globalize';
import {
    translateAudioPath,
    translatePlaybackState,
    translateVideoDecoderBackend,
    translateVideoOutputMode
} from './ui/CustomPlaybackStatsText';
import {
    getWebGPUCustomDecodeEnabled,
    getWebGPUHDRToneMappingEnabled,
    isStoredWebGPUCustomDecodeEnabled,
    isWebGPUCustomDecodeEnabled,
    refreshWebGPUPlaybackPreferences
} from './WebGPUPlaybackPreferences';
import { HTMLPlayerDelegate } from './HTMLPlayerDelegate';
import { setTimingTraceMetadataProvider, type TimingTraceMetadata } from './TimingTraceControl';
import {
    jellyfinTicksToMicroseconds,
    microsecondsToJellyfinTicks,
    microsecondsToMilliseconds,
    millisecondsToMicroseconds,
    type Microseconds
} from 'webgpu-player/MediaTime';
import {
    getDolbyVisionBaseColorMetadata,
    getDolbyVisionPresentationDescriptor,
    getDolbyVisionPresentationSelection,
    getDolbyVisionProfile7HDR10BaseColorMetadata,
    getDolbyVisionProfile8HDR10BaseColorMetadata,
    getDolbyVisionProfile8HLGBaseColorMetadata,
    getPresentationInputColorMetadata,
    getPresentationVideoTrackOrdinal,
    isDolbyVisionProfile7HDR10BaseLayerDescriptor,
    isDolbyVisionProfile8HDR10BaseLayerDescriptor,
    isDolbyVisionProfile8HLGBaseLayerDescriptor,
    isKnownSDRPresentationInput,
    type DolbyVisionPresentationDescriptor
} from 'webgpu-player/presentation/PresentationInput';
import {
    createDefaultRenderSettings,
    type HDRToSDRRenderSettings,
    type RenderSettings
} from 'webgpu-player/presentation/RenderSettings';
import {
    createConfiguredHDRRenderSettings,
    loadWebGPUUserSettings,
    type WebGPUUserSettings
} from './WebGPUUserSettings';
import {
    getWebGPUAudioOutputManager,
    type WebGPUAudioOutputManager
} from 'webgpu-player/audio/output/WebGPUAudioOutputManager';
import {
    assertValidAudioDownmixSettings,
    type AudioDownmixSettings
} from 'webgpu-player/audio/processing/CustomAudioDownmix';
import {
    createHLGColorMetadata,
    createPQColorMetadata,
    type InputColorMetadata
} from 'webgpu-player/color/ColorMetadata';
import {
    prewarmBrowserAudioContext,
    type BrowserAudioContextPrewarmLease
} from 'webgpu-player/audio/output/BrowserAudioContextPrewarm';
import { CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE } from 'webgpu-player/audio/CustomAudioOutputPolicy';
import type { CustomAudioDownmixAlgorithm } from 'webgpu-player/audio/processing/CustomAudioDownmixAlgorithm';
import { isSupportedCustomAudioSampleRate } from 'webgpu-player/audio/CustomAudioSampleRate';
import {
    getCustomPlaybackEligibility,
    getDolbyVisionReconstructionRawFrameFormat,
    hasPotentialCustomPlaybackVideoRoute,
    type CustomPlaybackEligibility,
    type CustomPlaybackEligibilityOptions,
    type CustomPlaybackIneligibilityReason,
    type EligibleCustomPlayback
} from 'webgpu-player/capability/CustomPlaybackEligibility';
import {
    type CustomDecodeCapabilities,
    hasProbedCustomDecodeSelection,
    probeCustomDecodeCapabilities
} from 'webgpu-player/capability/CustomDecodeCapabilities';
import { getAudioNormalizationLinearGain } from 'webgpu-player/audio/AudioNormalization';
import type CustomPlaybackController from 'webgpu-player/pipeline/CustomPlaybackController';
import type {
    CustomAudioOutputFactory,
    CustomPlaybackControllerEvent,
    CustomPlaybackFallbackRequest,
    CustomPlaybackStartResult,
    CustomPlaybackTelemetry
} from 'webgpu-player/pipeline/CustomPlaybackControllerTypes';
import type {
    CustomDecodeAudioOutputMode,
    CustomDecodeDolbyVisionProfile,
    CustomDecodeNativeHDRTransfer,
    CustomDecodeRawVideoFrameFormat,
    CustomDecodeVideoDecoderBackend,
    CustomDecodeVideoOutputMode
} from 'webgpu-player/pipeline/DecodeWorkerProtocol';
import {
    isRawDolbyVisionVideoFrameFormat,
    type RawDolbyVisionVideoFrameFormat
} from 'webgpu-player/color/ColorPipelineShader';
import {
    probeCachedNativeMediaAudioCapabilities,
    type NativeMediaAudioCapabilities
} from 'webgpu-player/capability/NativeMediaAudioCapabilities';
import { selectCustomAudioOutputChannelCountForMaximum } from 'webgpu-player/audio/NativeMultichannelAudioOutput';
import {
    getStaticHDRToneMappingPeakNits,
    type StaticHDRMetadata
} from 'webgpu-player/video/hdr/StaticHDRMetadata';
import {
    augmentDeviceProfileForCustomDecode,
    createBitrateIndependentDeviceProfile,
    type CustomDeviceProfileOptions,
    type CustomDeviceProfileTelemetry,
    type CustomSubtitleCapabilities
} from './custom/CustomDeviceProfile';
import { isSameSessionNativePlaybackCompatible } from './custom/NativeDirectPlayCompatibility';
import { getHEVCRangeExtensionStreamDefinitionFromMetadata } from 'webgpu-player/capability/HEVCRangeExtensionCapabilities';
import {
    getCustomPlaybackRuntimeAvailability,
    type CustomPlaybackRuntimeAvailability
} from 'webgpu-player/capability/CustomPlaybackRuntime';
import WebGPUPresenter, {
    type DecodedPresentationFrame,
    type DolbyVisionReconstructionTarget,
    type PresentationFallbackReason,
    type PresentationSurface,
    type PresentationTelemetry
} from 'webgpu-player/presentation/WebGPUPresenter';
import type { WorkerPresentationAttachment } from 'webgpu-player/presentation/WorkerPresentationProtocol';

import type {
    DolbyVisionAuthorizationRoute,
    DolbyVisionAuthorizationTelemetry
} from 'webgpu-player/validation/DolbyVisionPresentationAuthorization';
import type {
    ExternalDolbyVisionAuthorizationTelemetry
} from 'webgpu-player/validation/ExternalDolbyVisionPresentationAuthorization';
import {
    getExternalHDRAuthorizationRouteKey,
    type ExternalHDRAuthorizationTelemetry,
    type ExternalHDRAuthorizationRouteKey
} from 'webgpu-player/validation/ExternalHDRPresentationAuthorization';
import type {
    RawHDRAuthorizationRouteKey,
    RawHDRAuthorizationTelemetry
} from 'webgpu-player/validation/RawHDRPresentationAuthorization';

function getRawVideoFrameBitDepth(format: CustomDecodeRawVideoFrameFormat): 8 | 10 | 12 {
    switch (format) {
        case 'I420':
        case 'I422':
        case 'I444':
            return 8;
        case 'I420P10':
        case 'I422P10':
        case 'I444P10':
            return 10;
        case 'I420P12':
        case 'I422P12':
        case 'I444P12':
            return 12;
    }
}

// AV1 and VP9 present HDR only through raw planes, since the native external HDR route decodes HEVC Main 10 alone
const RAW_ONLY_HDR_VIDEO_CODECS = new Set<string>([ 'AV1', 'VP9' ]);

/**
 * Returns whether the presented stream's HDR presents only through raw planes.
 * AV1, VP9, and HEVC range extensions have no native external route, so an external authorization never covers them.
 */
function isRawOnlyHDRPresentation(options: unknown): boolean {
    if (!options || typeof options !== 'object') {
        return false;
    }
    const mediaSource = (options as { mediaSource?: unknown }).mediaSource;
    if (!mediaSource || typeof mediaSource !== 'object') {
        return false;
    }
    const mediaStreams = (mediaSource as { MediaStreams?: unknown }).MediaStreams;
    const videoTrackOrdinal = getPresentationVideoTrackOrdinal(options);
    if (!Array.isArray(mediaStreams) || videoTrackOrdinal === null) {
        return false;
    }
    const videoStreams = mediaStreams.filter((stream: unknown): boolean => (
        stream !== null
        && typeof stream === 'object'
        && String((stream as { Type?: unknown }).Type ?? '').trim().toUpperCase() === 'VIDEO'
    ));
    const videoStream: unknown = videoStreams[videoTrackOrdinal];
    if (!videoStream) {
        return false;
    }
    const codec = String((videoStream as { Codec?: unknown }).Codec ?? '').trim().toUpperCase();
    return RAW_ONLY_HDR_VIDEO_CODECS.has(codec)
        || ([ 'H265', 'HEVC' ].includes(codec)
            && getHEVCRangeExtensionStreamDefinitionFromMetadata(videoStream) !== null);
}

/** Returns the media source a play request carries when it lists its streams, or null. */
function getPlaybackMediaSourceWithStreams(options: unknown): object | null {
    if (!options || typeof options !== 'object') {
        return null;
    }
    const mediaSource = (options as { mediaSource?: unknown }).mediaSource;
    if (!mediaSource || typeof mediaSource !== 'object') {
        return null;
    }
    const mediaStreams = (mediaSource as { MediaStreams?: unknown }).MediaStreams;
    return Array.isArray(mediaStreams) && mediaStreams.length > 0 ? mediaSource : null;
}

type OptionalItemCompatibility = {
    canPlayItem?: (item: unknown, playOptions?: unknown) => boolean
};

type RuntimeHTMLPlayerProperties = {
    forcedFullscreen?: boolean
};

type PlaybackRateOption = {
    id: number
    name: string
};

type AspectRatioOption = {
    id: string
    name: string
};

type BackendPlayer = HTMLPlayerDelegate['player'];

type DeviceProfileRequestOptions = {
    isRetry?: unknown
};

type StreamingBitrateRequest = {
    fallbackBitrate?: number | null
    purpose?: 'playback-selection' | 'transcode-output'
};

type HTMLPlayerSelectionContract = {
    canPlayMediaType: (mediaType: string | null | undefined) => boolean
    supportsPlayMethod: (playMethod: string, item: unknown) => boolean
    getDeviceProfile: (item: unknown, options?: unknown) => Promise<unknown>
};

type HTMLCustomPlaybackContract = {
    notifyCustomPlaybackEnded: () => boolean
    notifyCustomPlaybackPaused: () => boolean
    notifyCustomPlaybackPlaying: (emitUnpause?: boolean) => boolean
    notifyCustomPlaybackTimeUpdate: (timeMilliseconds: number) => boolean
    notifyCustomPlaybackWaiting: () => boolean
    prepareCustomPlayback: (options: unknown) => Promise<
        PresentationSurface | typeof PLAYBACK_SUPERSEDED | null
    >
};

type PlaybackOptionsRecord = Record<string, unknown>;

type DeviceProfileItem = {
    MediaSources?: unknown
    MediaStreams?: unknown
};

type DeviceProfileMediaSource = {
    Id?: unknown
    MediaStreams?: unknown
};

type PlayerSettingsMenuItem = {
    id: string
    name: string
    onSelect: () => unknown
    secondaryText?: string
};

// A Dolby Vision base declared PQ or HLG outside the exact Profile 7 and 8 bases presents through the ordinary static HDR routes, so it needs their probes as well as the Dolby Vision ones
type HDRDeviceProfileProbeScope =
    | 'dolby-vision'
    | 'dolby-vision-hdr-base'
    | 'dolby-vision-profile7'
    | 'dolby-vision-profile8-hdr10-base'
    | 'dolby-vision-profile8-hlg-base'
    | 'none'
    | 'static-hdr'
    | 'unknown';

const EXTERNAL_HDR_DEVICE_PROFILE_PROBE_SCOPES = new Set<HDRDeviceProfileProbeScope>([
    'dolby-vision-hdr-base',
    'dolby-vision-profile7',
    'dolby-vision-profile8-hdr10-base',
    'dolby-vision-profile8-hlg-base',
    'static-hdr',
    'unknown'
]);
const RAW_HDR_DEVICE_PROFILE_PROBE_SCOPES = new Set<HDRDeviceProfileProbeScope>([
    'dolby-vision-hdr-base',
    'static-hdr',
    'unknown'
]);
const DOLBY_VISION_DEVICE_PROFILE_PROBE_SCOPES = new Set<HDRDeviceProfileProbeScope>([
    'dolby-vision',
    'dolby-vision-hdr-base',
    'dolby-vision-profile7',
    'dolby-vision-profile8-hdr10-base',
    'dolby-vision-profile8-hlg-base',
    'unknown'
]);
// Reconstruction falls back to the default format when the stream does not name its own
const DEFAULT_DOLBY_VISION_RAW_FRAME_FORMAT = 'I420P10';
const RAW_SDR_ROUTE_KEY_SUFFIX = ':sdr';
// Normalized play methods; custom playback is eligible for DirectPlay alone
const DIRECT_PLAY_METHOD = 'DIRECTPLAY';
const DIRECT_STREAM_METHOD = 'DIRECTSTREAM';
// The presentation options of a play method that custom playback never accepts
const UNAUTHORIZED_PRESENTATION_ELIGIBILITY_OPTIONS: CustomPresentationEligibilityOptions = {
    allowDolbyVision: false,
    allowDolbyVisionProfile7: false,
    allowNativeDolbyVision: false,
    allowNativeHDR: false,
    allowRawHDR: false,
    allowRawSDR: false,
    authorizedExternalHDRRouteKeys: [],
    authorizedRawHDRRouteKeys: []
};

/**
 * Returns whether an item's scope waits for raw HDR.
 * A raw-only HDR item presents every static or declared HDR base through raw planes, whatever the external result.
 * Other items wait only in the raw HDR scopes.
 */
function isRawHDRDeviceProfileProbeScope(probeScope: HDRDeviceProfileProbeScope, rawOnlyHDRPresentation: boolean): boolean {
    return RAW_HDR_DEVICE_PROFILE_PROBE_SCOPES.has(probeScope)
        || (rawOnlyHDRPresentation && EXTERNAL_HDR_DEVICE_PROFILE_PROBE_SCOPES.has(probeScope));
}

/** Returns the RPU route a Dolby Vision presentation authorizes, when the stream has one. */
function getDolbyVisionReconstructionTarget(presentationOptions: unknown): DolbyVisionReconstructionTarget | null {
    const descriptor = getDolbyVisionPresentationDescriptor(presentationOptions);
    const rawFrameFormat = getDolbyVisionReconstructionRawFrameFormat(presentationOptions);
    if (
        !descriptor
        || descriptor.reconstructionProfile === null
        || rawFrameFormat === null
        || !isRawDolbyVisionVideoFrameFormat(rawFrameFormat)
    ) {
        return null;
    }
    return { profile: descriptor.reconstructionProfile, rawFrameFormat };
}

/** Returns the raw format whose authorization gates single-layer reconstruction for the item. */
function getSingleLayerDolbyVisionRawFrameFormat(
    reconstructionTarget: DolbyVisionReconstructionTarget | null
): RawDolbyVisionVideoFrameFormat {
    return reconstructionTarget?.profile === 5 || reconstructionTarget?.profile === 8 ?
        reconstructionTarget.rawFrameFormat :
        DEFAULT_DOLBY_VISION_RAW_FRAME_FORMAT;
}

/** Returns the raw format whose authorizations gate dual-layer reconstruction for the item. */
function getDualLayerDolbyVisionRawFrameFormat(
    reconstructionTarget: DolbyVisionReconstructionTarget | null
): RawDolbyVisionVideoFrameFormat {
    return reconstructionTarget?.rawFrameFormat ?? DEFAULT_DOLBY_VISION_RAW_FRAME_FORMAT;
}

/** Returns whether a raw route key presents SDR; raw SDR keys share the raw HDR key list. */
function isRawSDRRouteKey(routeKey: RawHDRAuthorizationRouteKey): boolean {
    return routeKey.endsWith(RAW_SDR_ROUTE_KEY_SUFFIX);
}

type RawDolbyVisionRouteFlags = Pick<
    CustomPlaybackEligibilityOptions,
    'allowDolbyVision' | 'allowDolbyVisionProfile4' | 'allowDolbyVisionProfile7'
>;

type CustomPresentationAuthorizations = {
    authorizedExternalHDRRouteKeys: readonly ExternalHDRAuthorizationRouteKey[]
    authorizedRawHDRRouteKeys: readonly RawHDRAuthorizationRouteKey[]
};

type CustomPresentationEligibilityOptions = Pick<
    CustomPlaybackEligibilityOptions,
    | 'allowDolbyVision'
    | 'allowDolbyVisionProfile4'
    | 'allowDolbyVisionProfile7'
    | 'allowNativeDolbyVision'
    | 'allowNativeDolbyVisionProfile7HDR10Base'
    | 'allowNativeDolbyVisionProfile8HDR10Base'
    | 'allowNativeDolbyVisionProfile8HLGBase'
    | 'allowNativeHDR'
    | 'allowRawHDR'
    | 'allowRawSDR'
    | 'authorizedExternalHDRRouteKeys'
    | 'authorizedRawHDRRouteKeys'
>;

type NativeDeviceProfileProof = {
    generation: number | null
    itemKey: string
    profile: DeviceProfile
};

export type CustomPlaybackEligibilityTelemetry =
    | {
        eligible: false
        reason: CustomPlaybackIneligibilityReason
    }
    | {
        audioOutputMode: CustomDecodeAudioOutputMode | null
        eligible: true
        hdr: boolean
        nativeHDRTransfer: CustomDecodeNativeHDRTransfer
        neutralizeHDRColorMetadata: boolean
        videoDecoderBackend: CustomDecodeVideoDecoderBackend
        videoOutputMode: CustomDecodeVideoOutputMode
    };

export type CustomPlaybackSetupStage =
    | 'capabilities'
    | 'complete'
    | 'controller'
    | 'idle'
    | 'modules'
    | 'presentation'
    | 'surface';

export type CustomPlaybackSetupTelemetry = {
    stage: CustomPlaybackSetupStage
    status: 'complete' | 'idle' | 'in-progress' | 'timeout'
};

function getItemKey(item: unknown): string | null {
    if (!item || typeof item !== 'object') {
        return null;
    }
    const itemRecord = item as PlaybackOptionsRecord;
    const itemId = typeof itemRecord.Id === 'string' ? itemRecord.Id.trim() : '';
    if (!itemId) {
        return null;
    }
    const serverId = typeof itemRecord.ServerId === 'string' ? itemRecord.ServerId.trim() : '';
    return `${serverId}\u0000${itemId}`;
}

function getPlaybackItemKey(options: unknown): string | null {
    if (!options || typeof options !== 'object') {
        return null;
    }
    return getItemKey((options as PlaybackOptionsRecord).item);
}

function hasExactSeparateProfile7Source(item: unknown): boolean {
    if (!item || typeof item !== 'object') {
        return false;
    }
    const itemRecord = item as DeviceProfileItem;
    let mediaStreams = itemRecord.MediaStreams;
    if (Array.isArray(itemRecord.MediaSources)) {
        if (itemRecord.MediaSources.length !== 1) {
            return false;
        }
        const mediaSource = itemRecord.MediaSources[0];
        if (!mediaSource || typeof mediaSource !== 'object') {
            return false;
        }
        mediaStreams = (mediaSource as DeviceProfileMediaSource).MediaStreams;
    }
    if (!Array.isArray(mediaStreams)) {
        return false;
    }
    let videoStreamCount = 0;
    for (const stream of mediaStreams) {
        if (
            stream
            && typeof stream === 'object'
            && typeof (stream as PlaybackOptionsRecord).Type === 'string'
            && ((stream as PlaybackOptionsRecord).Type as string).trim().toLowerCase() === 'video'
        ) {
            videoStreamCount += 1;
        }
    }
    if (videoStreamCount !== 2) {
        return false;
    }
    const selection = getDolbyVisionPresentationSelection({ mediaSource: { MediaStreams: mediaStreams } });
    return selection?.descriptor.profile === 7 && selection.descriptor.enhancementLayerPresent;
}

function hasExactProfile7HDR10BaseSource(item: unknown): boolean {
    const presentationOptions = getDeviceProfilePresentationOptions(item);
    return presentationOptions !== null && getDolbyVisionProfile7HDR10BaseColorMetadata(presentationOptions) !== null;
}

function hasExactProfile8HDR10BaseSource(item: unknown): boolean {
    const presentationOptions = getDeviceProfilePresentationOptions(item);
    return presentationOptions !== null && getDolbyVisionProfile8HDR10BaseColorMetadata(presentationOptions) !== null;
}

function hasExactProfile8HLGBaseSource(item: unknown): boolean {
    const presentationOptions = getDeviceProfilePresentationOptions(item);
    return presentationOptions !== null && getDolbyVisionProfile8HLGBaseColorMetadata(presentationOptions) !== null;
}

function getDeviceProfilePresentationOptions(item: unknown, mediaSourceId?: string | null): unknown | null {
    if (!item || typeof item !== 'object') {
        return null;
    }
    const itemRecord = item as DeviceProfileItem;
    let mediaStreams = itemRecord.MediaStreams;
    if (Array.isArray(itemRecord.MediaSources)) {
        const mediaSources: unknown[] = itemRecord.MediaSources;
        let mediaSource: unknown = null;
        if (mediaSources.length === 1) {
            mediaSource = mediaSources[0];
        } else if (typeof mediaSourceId === 'string' && mediaSourceId.length > 0) {
            mediaSource = mediaSources.find(candidate => (
                candidate !== null
                && typeof candidate === 'object'
                && (candidate as DeviceProfileMediaSource).Id === mediaSourceId
            ));
        }
        if (!mediaSource || typeof mediaSource !== 'object') {
            return null;
        }
        mediaStreams = (mediaSource as DeviceProfileMediaSource).MediaStreams;
    }
    if (!Array.isArray(mediaStreams)) {
        return null;
    }
    return { mediaSource: { MediaStreams: mediaStreams } };
}

function getHDRDeviceProfileProbeScope(item: unknown): HDRDeviceProfileProbeScope {
    const presentationOptions = getDeviceProfilePresentationOptions(item);
    if (!presentationOptions) {
        return 'unknown';
    }
    const dolbyVisionDescriptor = getDolbyVisionPresentationDescriptor(presentationOptions);
    if (dolbyVisionDescriptor) {
        if (getDolbyVisionProfile7HDR10BaseColorMetadata(presentationOptions) !== null) {
            return 'dolby-vision-profile7';
        }
        if (getDolbyVisionProfile8HDR10BaseColorMetadata(presentationOptions) !== null) {
            return 'dolby-vision-profile8-hdr10-base';
        }
        if (getDolbyVisionProfile8HLGBaseColorMetadata(presentationOptions) !== null) {
            return 'dolby-vision-profile8-hlg-base';
        }
        const baseTransfer = getDolbyVisionBaseColorMetadata(presentationOptions)?.transfer;
        return baseTransfer === 'pq' || baseTransfer === 'hlg' ? 'dolby-vision-hdr-base' : 'dolby-vision';
    }
    const colorMetadata = getPresentationInputColorMetadata(presentationOptions);
    if (colorMetadata?.transfer === 'pq' || colorMetadata?.transfer === 'hlg') {
        return 'static-hdr';
    }
    return isKnownSDRPresentationInput(presentationOptions) ? 'none' : 'unknown';
}

const DOLBY_VISION_HDR10_BASE_COLOR_METADATA = Object.freeze(createPQColorMetadata());
const DOLBY_VISION_HLG_BASE_COLOR_METADATA = Object.freeze(createHLGColorMetadata());

function hasAuthorizedDolbyVisionBaseRoute(metadata: InputColorMetadata, routeKeys: readonly ExternalHDRAuthorizationRouteKey[]): boolean {
    const routeKey = getExternalHDRAuthorizationRouteKey(metadata);
    return routeKey !== null && routeKeys.includes(routeKey);
}

function allowsNativeDolbyVisionBaseDeviceProfileRoute(
    HDRToneMappingEnabled: boolean,
    probeScope: HDRDeviceProfileProbeScope,
    requiredProbeScope: HDRDeviceProfileProbeScope,
    item: unknown,
    hasExactSource: (sourceItem: unknown) => boolean,
    metadata: InputColorMetadata,
    routeKeys: readonly ExternalHDRAuthorizationRouteKey[]
): boolean {
    return HDRToneMappingEnabled
        && probeScope === requiredProbeScope
        && hasExactSource(item)
        && hasAuthorizedDolbyVisionBaseRoute(metadata, routeKeys);
}

type AudioPrewarmMediaStream = {
    Index?: unknown
    SampleRate?: unknown
    Type?: unknown
};

type AudioPrewarmMediaSource = {
    DefaultAudioStreamIndex?: unknown
    MediaStreams?: unknown
};

type CustomPlaybackAudioPrewarm = {
    backendGeneration: number
    lease: BrowserAudioContextPrewarmLease
};

type CustomPlaybackAttemptResult =
    | { status: 'native-required' }
    | { result: unknown, status: 'handled' }
    | { status: 'superseded' };

type SourceRenegotiationRequest = {
    accept: () => void
    errorType: MediaError
    reason: CustomPlaybackFallbackRequest['reason']
};

type DeferredRenegotiationError = {
    generation: number
    mediaError: MediaError
};

type PendingPausedPresentationRefresh = {
    backendGeneration: number
    controller: CustomPlaybackController
    mediaTimeMicroseconds: Microseconds
    presentationGeneration: number
};

const CUSTOM_VOLUME_STEP = 2;
export const CUSTOM_PLAYBACK_SETUP_TIMEOUT_MICROSECONDS = millisecondsToMicroseconds(25_000);
// NOTE: Two raw-plane credits at 60 fps need a drain at least every 33 ms
export const CUSTOM_PLAYBACK_BACKGROUND_DRAIN_INTERVAL_MILLISECONDS = 25;
const JELLYFIN_VOLUME_CURVE_EXPONENT = 3;
const MAX_JELLYFIN_VOLUME = 100;
const MIN_JELLYFIN_VOLUME = 0;
const CUSTOM_PLAYBACK_SETUP_TIMEOUT = Symbol('custom-playback-setup-timeout');
const DEFERRED_RENEGOTIATION_ERROR_DELAY_MILLISECONDS = 0;
const CUSTOM_PLAYBACK_INELIGIBLE_HTML_BACKEND_MESSAGE = 'Custom playback is ineligible; using the HTML backend';
const CUSTOM_PLAYBACK_INELIGIBLE_RENEGOTIATION_MESSAGE = 'Custom playback is ineligible; requesting source renegotiation';
// Logged reasons for declines that carry no engine ineligibility reason
const CUSTOM_PLAYBACK_ELIGIBILITY_UNAVAILABLE_REASON = 'eligibility-unavailable';
const WEBGPU_PRESENTATION_DISABLED_REASON = 'webgpu-presentation-disabled';

function isDocumentVisible(): boolean {
    // eslint-disable-next-line compat/compat -- WebGPU playback is capability-gated
    return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

type CustomPlaybackSetupDeadline = {
    /** Stops the setup deadline once the controller, which bounds its own startup, owns playback. */
    release: () => void
};

/**
 * Bounds custom playback setup.
 * The deadline covers capability, presentation, and controller construction; the setup releases it when the controller starts, whose progress-aware startup bound then applies.
 */
function waitForCustomPlaybackSetup<T>(
    startSetup: (deadline: CustomPlaybackSetupDeadline) => Promise<T>
): Promise<T | typeof CUSTOM_PLAYBACK_SETUP_TIMEOUT> {
    return new Promise<T | typeof CUSTOM_PLAYBACK_SETUP_TIMEOUT>((resolve, reject) => {
        let timeout: ReturnType<typeof globalThis.setTimeout> | null = globalThis.setTimeout((): void => {
            timeout = null;
            resolve(CUSTOM_PLAYBACK_SETUP_TIMEOUT);
        }, microsecondsToMilliseconds(CUSTOM_PLAYBACK_SETUP_TIMEOUT_MICROSECONDS));
        const deadline: CustomPlaybackSetupDeadline = {
            release: (): void => {
                if (timeout !== null) {
                    globalThis.clearTimeout(timeout);
                    timeout = null;
                }
            }
        };
        startSetup(deadline).then((value: T): void => {
            deadline.release();
            resolve(value);
        }, (error: unknown): void => {
            deadline.release();
            reject(error);
        });
    });
}

function normalizeStreamType(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const normalizedValue = value.trim().toUpperCase();
    return normalizedValue || null;
}

function getNormalizedPlayMethod(options: unknown): string | null {
    if (!options || typeof options !== 'object') {
        return null;
    }
    return normalizeStreamType((options as PlaybackOptionsRecord).playMethod);
}

function getOptionalRecord(value: unknown): PlaybackOptionsRecord {
    return value && typeof value === 'object' ? value as PlaybackOptionsRecord : {};
}

/** Names the played item and source for a timing trace, from the options Jellyfin Web passed to play(). */
function getTimingTracePlaybackSource(options: unknown): TimingTraceMetadata | null {
    if (!options || typeof options !== 'object') {
        return null;
    }
    const playbackOptions = options as PlaybackOptionsRecord;
    const item = getOptionalRecord(playbackOptions.item);
    const mediaSource = getOptionalRecord(playbackOptions.mediaSource);
    return {
        container: mediaSource.Container ?? null,
        itemId: item.Id ?? null,
        itemName: item.Name ?? null,
        mediaSourceId: mediaSource.Id ?? null,
        playMethod: playbackOptions.playMethod ?? null,
        startPositionTicks: playbackOptions.playerStartPositionTicks ?? null
    };
}

function formatRoundedMilliseconds(microseconds: Microseconds): number {
    return Math.round(microsecondsToMilliseconds(microseconds));
}

function supportsCustomSubtitleCanvas(): boolean {
    if (typeof document === 'undefined') {
        return false;
    }

    try {
        return document.createElement('canvas').getContext('2d') !== null;
    } catch {
        return false;
    }
}

/** Qualifies the locked subtitle renderers without inheriting the HTML PGS experiment flag. */
function getCustomSubtitleCapabilities(
    profile: DeviceProfile,
    runtimeAvailability: CustomPlaybackRuntimeAvailability
): CustomSubtitleCapabilities | null {
    if (!profile.SubtitleProfiles) {
        return null;
    }

    const externalFormats = new Set<string>();
    for (const subtitleProfile of profile.SubtitleProfiles) {
        if (normalizeStreamType(subtitleProfile.Method) !== 'EXTERNAL') {
            continue;
        }
        const format: string | null = normalizeStreamType(subtitleProfile.Format);
        if (format) {
            externalFormats.add(format);
        }
    }
    const specializedRendererRuntimeAvailable = runtimeAvailability.environment.worker
        && typeof WebAssembly === 'object'
        && typeof WebAssembly.instantiate === 'function'
        && supportsCustomSubtitleCanvas();
    return {
        externalASS: specializedRendererRuntimeAvailable,
        externalPGS: specializedRendererRuntimeAvailable,
        externalText: externalFormats.has('VTT')
    };
}

function getAudioPrewarmStreams(mediaStreamsValue: unknown): Array<{ sampleRate: unknown, streamIndex: number }> | null {
    if (!Array.isArray(mediaStreamsValue)) {
        return null;
    }

    const audioStreams: Array<{ sampleRate: unknown, streamIndex: number }> = [];
    for (let streamPosition = 0; streamPosition < mediaStreamsValue.length; streamPosition += 1) {
        const streamValue = mediaStreamsValue[streamPosition];
        if (!streamValue || typeof streamValue !== 'object') {
            continue;
        }
        const stream = streamValue as AudioPrewarmMediaStream;
        if (normalizeStreamType(stream.Type) !== 'AUDIO') {
            continue;
        }

        const streamIndexValue = stream.Index ?? streamPosition;
        if (!Number.isSafeInteger(streamIndexValue) || Number(streamIndexValue) < 0) {
            return null;
        }
        audioStreams.push({
            sampleRate: stream.SampleRate,
            streamIndex: Number(streamIndexValue)
        });
    }
    return audioStreams.length === 0 ? null : audioStreams;
}

function getPlaybackStartTimeMicroseconds(options: unknown): Microseconds {
    if (!options || typeof options !== 'object') {
        return millisecondsToMicroseconds(0);
    }

    const startPositionTicks = (options as PlaybackOptionsRecord).playerStartPositionTicks;
    if (startPositionTicks == null) {
        return millisecondsToMicroseconds(0);
    }
    if (!Number.isSafeInteger(startPositionTicks) || Number(startPositionTicks) < 0) {
        return millisecondsToMicroseconds(0);
    }
    return jellyfinTicksToMicroseconds(Number(startPositionTicks));
}

function selectAudioPrewarmStream(
    mediaSource: AudioPrewarmMediaSource,
    audioStreams: Array<{ sampleRate: unknown, streamIndex: number }>
): { sampleRate: unknown, streamIndex: number } | null {
    const requestedIndex = mediaSource.DefaultAudioStreamIndex;
    if (requestedIndex == null) {
        return audioStreams[0];
    }
    if (!Number.isSafeInteger(requestedIndex) || Number(requestedIndex) < 0) {
        return null;
    }
    return audioStreams.find(audioStream => (audioStream.streamIndex === requestedIndex)) ?? null;
}

function getSelectedAudioSampleRate(options: unknown): number | null {
    if (!options || typeof options !== 'object') {
        return null;
    }
    const mediaSourceValue = (options as { mediaSource?: unknown }).mediaSource;
    if (!mediaSourceValue || typeof mediaSourceValue !== 'object') {
        return null;
    }

    const mediaSource = mediaSourceValue as AudioPrewarmMediaSource;
    const audioStreams = getAudioPrewarmStreams(mediaSource.MediaStreams);
    if (!audioStreams) {
        return null;
    }
    const selectedAudioStream = selectAudioPrewarmStream(mediaSource, audioStreams);
    if (!selectedAudioStream) {
        return null;
    }

    return isSupportedCustomAudioSampleRate(selectedAudioStream.sampleRate) ? selectedAudioStream.sampleRate : null;
}

function getAudioContextMaximumChannelCount(audioContext: AudioContext | null): number | null {
    if (!audioContext) {
        return null;
    }
    try {
        const maximumChannelCount = audioContext.destination.maxChannelCount;
        return Number.isSafeInteger(maximumChannelCount) && maximumChannelCount > 0 ? maximumChannelCount : null;
    } catch {
        return null;
    }
}

function selectDecodedAudioOutputChannelCount(
    eligibility: EligibleCustomPlayback,
    maximumChannelCount: number | null,
    forceStereoDownmix: boolean
): 2 | 6 | 8 | undefined {
    if (eligibility.audioOutputMode !== 'decoded-pcm') {
        return undefined;
    }
    if (forceStereoDownmix) {
        return 2;
    }
    return selectCustomAudioOutputChannelCountForMaximum(maximumChannelCount, eligibility.audioSourceChannelCount);
}

function selectAudioDownmixAlgorithm(
    audioTrackIndex: number | null,
    selectedAlgorithm: CustomAudioDownmixAlgorithm
): CustomAudioDownmixAlgorithm | undefined {
    return audioTrackIndex === null ? undefined : selectedAlgorithm;
}

function getDecodedAudioDownmixSettings(
    eligibility: EligibleCustomPlayback,
    settings: WebGPUUserSettings
): AudioDownmixSettings | undefined {
    return eligibility.audioOutputMode === 'decoded-pcm' ? settings.audio.downmix : undefined;
}

/** Returns the play option of a dual-layer route that reconstructs without its EL. */
function getDiscardedEnhancementLayerPlayOption(eligibility: EligibleCustomPlayback): { discardDolbyVisionEnhancementLayer?: true } {
    return eligibility.discardDolbyVisionEnhancementLayer ? { discardDolbyVisionEnhancementLayer: true } : {};
}

function initializeWebGPUAudioOutputManager(): WebGPUAudioOutputManager {
    const audioOutputManager = getWebGPUAudioOutputManager();
    void audioOutputManager.setSelectedDeviceId(loadWebGPUUserSettings().audio.outputDeviceId);
    return audioOutputManager;
}

/**
 * Jellyfin-facing player that owns the HTML player as its playback backend.
 * WebGPU presentation is optional and must never replace backend playback.
 */
export default class WebGPUPlayer {
    name = 'WebGPU Player';
    type = PluginType.MediaPlayer;
    id = 'webgpuplayer';
    // The wrapper preserves the HTML player's SyncPlay timing, rate, and events
    syncPlayWrapAs = 'htmlvideoplayer';
    priority = 0;

    private readonly htmlDelegate: HTMLPlayerDelegate;
    private readonly presenter: WebGPUPresenter;
    private readonly pendingAudioPrewarmClosePromises = new Set<Promise<void>>();
    private readonly pendingBackendStopPromises = new Set<Promise<unknown>>();
    private readonly pendingStopCounts = new Map<number, number>();

    private backendOperationTail: Promise<void> | null = null;
    private backendStopCallBarrier: Promise<void> | null = null;
    private backendStopCallDepth = 0;
    private releaseBackendStopCall: (() => void) | null = null;
    private backendPlayPendingGeneration: number | null = null;
    private deferredRenegotiationError: DeferredRenegotiationError | null = null;
    private backendSessionActive = false;
    private customPlaybackController: CustomPlaybackController | null = null;
    private customPlaybackAudioDownmixAlgorithm: CustomAudioDownmixAlgorithm | null = null;
    private customPlaybackAudioSettings: WebGPUUserSettings['audio'] | null = null;
    private customPlaybackBackendGeneration: number | null = null;
    private customPlaybackAudioPrewarm: CustomPlaybackAudioPrewarm | null = null;
    private customPlaybackFallbackPromise: Promise<unknown> | null = null;
    private customPlaybackBackgroundDrainTimer: ReturnType<typeof globalThis.setInterval> | null = null;
    private customPlaybackFrameCallback: number | null = null;
    private customPlaybackFrameGeneration: number | null = null;
    private pendingPausedPresentationRefresh: PendingPausedPresentationRefresh | null = null;
    private customPlaybackHasPlayed = false;
    private customPlaybackAudioSelectionRevision = 0;
    private customPlaybackSeekRevision = 0;
    private customPlaybackSetupRevision = 0;
    private customPlaybackSetupTelemetry: CustomPlaybackSetupTelemetry = {
        stage: 'idle',
        status: 'idle'
    };
    private customPlaybackStartingGeneration: number | null = null;
    private customPlaybackStopPromise: Promise<void> | null = null;
    private customPlaybackTerminalErrorGeneration: number | null = null;
    private customPlaybackEmitUnpause = false;
    private customPlaybackVolume = MAX_JELLYFIN_VOLUME;
    private customPlaybackMuted = false;
    private customPlaybackNormalizationGain = 1;
    private customPlaybackRecoveryTimeMicroseconds: Microseconds | null = null;
    private htmlPlaybackNormalizationGain: number | null = null;
    private currentPlaybackOptions: unknown = null;
    private currentNativeDeviceProfileProof: NativeDeviceProfileProof | null = null;
    private currentPlaybackRequiresSourceRenegotiation = false;
    private currentDolbyVisionPresentationDescriptor: DolbyVisionPresentationDescriptor | null = null;
    private currentPresentationColorMetadata: InputColorMetadata | null = null;
    // A Dolby Vision stream's declared base layer, presented by the ordinary routes when no RPU route is used
    private currentDolbyVisionBaseColorMetadata: InputColorMetadata | null = null;
    private activeDetectedInputPeakNits: number | null = null;
    private lastCustomDecodeCapabilities: CustomDecodeCapabilities | null = null;
    private lastCustomPlaybackEligibility: CustomPlaybackEligibility | null = null;
    private lastCustomPlaybackTelemetry: CustomPlaybackTelemetry | null = null;
    private lastCustomDeviceProfileTelemetry: CustomDeviceProfileTelemetry | null = null;
    private lastCustomPlaybackRuntimeAvailability: CustomPlaybackRuntimeAvailability | null = null;
    private lastNativeMediaAudioCapabilities: NativeMediaAudioCapabilities | null = null;
    private pendingNativeDeviceProfileProof: NativeDeviceProfileProof | null = null;
    private customProfileAugmentationAvailable = false;
    private webGPUPresentationEnabled = false;
    private presentationGeneration = 0;
    private backendSessionGeneration = 0;
    private ownedBackendSessionGeneration: number | null = null;
    private lastKnownTimeMicroseconds: Microseconds = millisecondsToMicroseconds(0);

    constructor() {
        const audioOutputManager = initializeWebGPUAudioOutputManager();
        this.htmlDelegate = new HTMLPlayerDelegate(this, this.handleBackendStopped, this.handleBackendError, audioOutputManager);
        this.presenter = new WebGPUPresenter(this.handlePresentationFallback, this.handleDecodedPresentationRefresh);
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', this.handleDocumentVisibilityChange);
        }
        setTimingTraceMetadataProvider((): TimingTraceMetadata => this.getTimingTraceMetadata());
    }

    /** Describes the current playback for a timing trace export. */
    private getTimingTraceMetadata(): TimingTraceMetadata {
        return {
            controller: this.getActiveCustomPlaybackController()?.getTelemetry() ?? null,
            eligibility: this.lastCustomPlaybackEligibility,
            playbackSource: getTimingTracePlaybackSource(this.currentPlaybackOptions),
            presentation: this.presenter.getTelemetry()
        };
    }

    get isFetching(): boolean {
        const customPlaybackState = this.customPlaybackController?.playbackState;
        if (this.customPlaybackStartingGeneration !== null || customPlaybackState === 'starting' || customPlaybackState === 'seeking') {
            return true;
        }
        return this.htmlDelegate.player.isFetching;
    }

    get forcedFullscreen(): boolean {
        const backend = this.htmlDelegate.player as BackendPlayer & RuntimeHTMLPlayerProperties;
        return Boolean(backend.forcedFullscreen);
    }

    currentSrc(): string | null | undefined {
        return this.htmlDelegate.player.currentSrc();
    }

    /** Keeps bitrate out of selection while retaining an explicit transcode target. */
    getMaxStreamingBitrate(request?: StreamingBitrateRequest): number | null {
        if (request?.purpose === 'transcode-output') {
            return request.fallbackBitrate ?? null;
        }
        return null;
    }

    /** Synchronously reports media-type compatibility for player selection. */
    canPlayMediaType = (mediaType: string | null | undefined): boolean => {
        const backend = this.htmlDelegate.player as unknown as HTMLPlayerSelectionContract;
        return backend.canPlayMediaType(mediaType);
    };

    /** Synchronously applies the optional HTML backend item check and, with custom decode enabled, the engine's metadata-only video route prefilter. */
    canPlayItem(item: unknown, playOptions?: unknown): boolean {
        const backend = this.htmlDelegate.player as BackendPlayer & OptionalItemCompatibility;
        const backendCanPlay = backend.canPlayItem?.(item, playOptions) ?? true;
        // Selection precedes the negotiation that adopts the stored preferences, so it reads them directly
        if (!backendCanPlay || !isStoredWebGPUCustomDecodeEnabled()) {
            return backendCanPlay;
        }
        return hasPotentialCustomPlaybackVideoRoute(item, playOptions);
    }

    supportsPlayMethod(playMethod: string, item: unknown): boolean {
        const backend = this.htmlDelegate.player as unknown as HTMLPlayerSelectionContract;
        return backend.supportsPlayMethod(playMethod, item);
    }

    /** Contributes one plugin-owned settings surface to Jellyfin's generic menu seam. */
    getSettingsMenuItems(): readonly PlayerSettingsMenuItem[] {
        return [ {
            id: 'webgpu-playback-settings',
            name: globalize.translate('WebGPUSettings'),
            onSelect: (): Promise<void> => Promise.all([
                import(
                    /* webpackChunkName: "webgpu-playback-settings" */
                    './ui/WebGPUPlaybackSettingsDialog'
                ),
                loadAddonStrings()
            ]).then(([ module ]) => module.toggleWebGPUPlaybackSettingsPanel(this))
        } ];
    }

    /** Blocks HLS video copy for Dolby Vision sources while preserving direct play. */
    supportsVideoStreamCopy(
        item: unknown,
        mediaSourceId?: string | null,
        mediaStreams?: unknown
    ): boolean {
        const presentationOptions = Array.isArray(mediaStreams) ?
            { mediaSource: { MediaStreams: mediaStreams } } :
            getDeviceProfilePresentationOptions(item, mediaSourceId);
        return presentationOptions === null || getDolbyVisionPresentationDescriptor(presentationOptions) === null;
    }

    async getDeviceProfile(item: unknown, options?: unknown): Promise<unknown> {
        const backend = this.htmlDelegate.player as unknown as HTMLPlayerSelectionContract;
        const isRetry = this.isDeviceProfileRetry(options);
        // A new negotiation adopts the stored preferences; a retry stays with the ones its playback negotiated
        if (!isRetry) {
            refreshWebGPUPlaybackPreferences();
        }
        const profile = await backend.getDeviceProfile(item, options);
        if (!isRetry && profile && typeof profile === 'object') {
            this.rememberNativeDeviceProfile(item, profile as DeviceProfile);
        }
        const playbackProfile = !isRetry && profile && typeof profile === 'object' ?
            createBitrateIndependentDeviceProfile(profile as DeviceProfile) :
            profile;
        if (!await getWebGPUCustomDecodeEnabled()) {
            this.lastCustomDecodeCapabilities = null;
            this.lastCustomDeviceProfileTelemetry = null;
            this.lastCustomPlaybackRuntimeAvailability = null;
            this.lastNativeMediaAudioCapabilities = null;
            return playbackProfile;
        }

        const runtimeAvailability = getCustomPlaybackRuntimeAvailability();
        this.lastCustomPlaybackRuntimeAvailability = runtimeAvailability;
        if (!runtimeAvailability.available) {
            this.lastCustomDecodeCapabilities = null;
            this.lastCustomDeviceProfileTelemetry = null;
            this.lastNativeMediaAudioCapabilities = null;
            return playbackProfile;
        }
        const subtitleCapabilities = !isRetry && profile && typeof profile === 'object' ?
            getCustomSubtitleCapabilities(profile as DeviceProfile, runtimeAvailability) :
            null;

        // The item scopes the video probes to its streams; every audio probe runs
        const [ capabilities, nativeMediaAudioCapabilities ] = await Promise.all([
            probeCustomDecodeCapabilities(item),
            isRetry ? Promise.resolve(null) : probeCachedNativeMediaAudioCapabilities()
        ]);
        const HDRDeviceProfileOptions = await this.getHDRDeviceProfileOptions(item, isRetry);
        const profileResult = augmentDeviceProfileForCustomDecode(
            playbackProfile as DeviceProfile,
            capabilities,
            {
                ...HDRDeviceProfileOptions,
                isRetry,
                nativeMediaAudioCapabilities,
                ...(subtitleCapabilities ? { subtitleCapabilities } : {})
            }
        );
        this.lastCustomDecodeCapabilities = capabilities;
        this.lastNativeMediaAudioCapabilities = nativeMediaAudioCapabilities;
        this.lastCustomDeviceProfileTelemetry = profileResult.telemetry;
        if (!isRetry && (
            profileResult.telemetry.addedProfileCount > 0
            || profileResult.telemetry.widenedHDRCodecProfileCount > 0
            || profileResult.telemetry.subtitleProfileChanged
        )) {
            this.customProfileAugmentationAvailable = true;
        }
        return profileResult.profile;
    }

    supports(feature: string): boolean {
        switch (feature) {
            case 'AirPlay':
            case 'PictureInPicture':
            case 'PlaybackRate':
            case 'SetBrightness':
                return this.hasAuthoritativeHTMLPlaybackSurface() && this.htmlDelegate.player.supports(feature);
            default:
                return this.htmlDelegate.player.supports(feature);
        }
    }

    /** Cancels only an unresolved backend startup, leaving established playback intact. */
    cancelPendingPlay(): void {
        this.htmlDelegate.cancelPendingPlay();
        const audioPrewarmClose = this.closeCustomPlaybackAudioPrewarm(this.backendSessionGeneration);
        if (audioPrewarmClose) {
            void audioPrewarmClose;
        }
        const pendingGeneration = this.backendPlayPendingGeneration;
        if (pendingGeneration == null || !this.isRequestedSessionCurrent(pendingGeneration)) {
            return;
        }

        void this.detachCustomPlaybackController();
        this.customPlaybackAudioSelectionRevision += 1;
        this.customPlaybackSeekRevision += 1;
        this.customPlaybackSetupRevision += 1;
        this.backendSessionActive = false;
        this.webGPUPresentationEnabled = false;
        this.currentPlaybackOptions = null;
        this.currentNativeDeviceProfileProof = null;
        this.currentPlaybackRequiresSourceRenegotiation = false;
        this.customPlaybackRecoveryTimeMicroseconds = null;
        this.resetHTMLPlaybackNormalization();
        this.customPlaybackNormalizationGain = 1;
        this.currentDolbyVisionPresentationDescriptor = null;
        this.currentPresentationColorMetadata = null;
        this.currentDolbyVisionBaseColorMetadata = null;
        this.htmlDelegate.endSession(pendingGeneration);
        const invalidatedGeneration = this.advancePresentationGeneration();
        this.presenter.endSession(invalidatedGeneration);
    }

    play(options: unknown): Promise<unknown> {
        this.resetHTMLPlaybackNormalization();
        this.customPlaybackNormalizationGain = 1;
        this.cancelPendingPlay();
        this.customPlaybackAudioSelectionRevision += 1;
        this.customPlaybackSeekRevision += 1;
        this.customPlaybackSetupRevision += 1;
        this.customPlaybackRecoveryTimeMicroseconds = null;
        const customPlaybackStop = this.detachCustomPlaybackController();
        const previousSessionGeneration = this.backendSessionGeneration;
        const generation = this.advancePresentationGeneration();
        if (previousSessionGeneration > 0 && !this.pendingStopCounts.has(previousSessionGeneration)) {
            this.htmlDelegate.endSession(previousSessionGeneration);
        }

        this.backendSessionActive = true;
        this.backendSessionGeneration = generation;
        this.currentNativeDeviceProfileProof = this.consumeNativeDeviceProfileProof(options, generation);
        this.backendPlayPendingGeneration = generation;
        this.deferredRenegotiationError = null;
        this.customPlaybackFallbackPromise = null;
        this.customPlaybackHasPlayed = false;
        this.customPlaybackStartingGeneration = null;
        this.customPlaybackTerminalErrorGeneration = null;
        this.lastCustomPlaybackEligibility = null;
        this.lastCustomPlaybackTelemetry = null;
        this.currentPlaybackOptions = options;
        this.activeDetectedInputPeakNits = null;
        this.lastKnownTimeMicroseconds = getPlaybackStartTimeMicroseconds(options);
        this.currentPlaybackRequiresSourceRenegotiation =
            this.customProfileAugmentationAvailable
            && this.isNonTranscodedSourceOptions(options)
            && !this.isCurrentSourceNativeCompatible(options);
        this.startCustomPlaybackAudioPrewarm(options, generation);
        this.currentDolbyVisionPresentationDescriptor = getDolbyVisionPresentationDescriptor(options);
        this.currentPresentationColorMetadata = getPresentationInputColorMetadata(options);
        this.currentDolbyVisionBaseColorMetadata = getDolbyVisionBaseColorMetadata(options);
        const customHDRPresentation = isWebGPUCustomDecodeEnabled()
            && (
                this.currentDolbyVisionPresentationDescriptor !== null
                || (this.currentPresentationColorMetadata !== null
                    && this.currentPresentationColorMetadata.transfer !== 'sdr')
            );
        this.webGPUPresentationEnabled = isKnownSDRPresentationInput(options) || customHDRPresentation;
        if (this.webGPUPresentationEnabled) {
            this.presenter.startSession(generation);
        } else {
            this.presenter.endSession(generation);
        }

        const backendStopCallBarrier = this.backendStopCallBarrier;
        const startPlayback = (): Promise<unknown> => {
            if (customPlaybackStop) {
                return customPlaybackStop.then(() => (this.startBackendPlayback(options, generation)));
            }
            return this.startBackendPlayback(options, generation);
        };
        const playPromise = this.enqueueBackendOperation(() => {
            if (backendStopCallBarrier) {
                return backendStopCallBarrier
                    .then(() => this.waitForPendingBackendStops())
                    .then(startPlayback);
            }
            if (this.pendingBackendStopPromises.size > 0) {
                return this.waitForPendingBackendStops().then(startPlayback);
            }

            return startPlayback();
        });
        return playPromise.finally(() => {
            if (this.backendPlayPendingGeneration === generation) {
                this.backendPlayPendingGeneration = null;
            }
        }).then((result: unknown): unknown => {
            this.scheduleDeferredRenegotiationError(generation);
            return result;
        });
    }

    /** Returns whether a play() request is still setting up its backend session. */
    hasPendingPlay(): boolean {
        const pendingGeneration = this.backendPlayPendingGeneration;
        return pendingGeneration != null && this.isRequestedSessionCurrent(pendingGeneration);
    }

    stop(destroyPlayer: boolean): Promise<unknown> {
        const sessionGeneration = this.backendSessionGeneration;
        const audioPrewarmClose = this.closeCustomPlaybackAudioPrewarm(sessionGeneration);
        this.htmlDelegate.cancelPendingPlay();
        this.customPlaybackAudioSelectionRevision += 1;
        this.customPlaybackSeekRevision += 1;
        this.customPlaybackSetupRevision += 1;
        const customPlaybackStop = this.detachCustomPlaybackController();
        this.backendSessionActive = false;
        this.webGPUPresentationEnabled = false;
        this.currentPlaybackOptions = null;
        this.currentNativeDeviceProfileProof = null;
        this.currentPlaybackRequiresSourceRenegotiation = false;
        this.customPlaybackRecoveryTimeMicroseconds = null;
        this.resetHTMLPlaybackNormalization();
        this.customPlaybackNormalizationGain = 1;
        this.currentDolbyVisionPresentationDescriptor = null;
        this.currentPresentationColorMetadata = null;
        this.currentDolbyVisionBaseColorMetadata = null;
        this.incrementPendingStopCount(sessionGeneration);
        const invalidatedGeneration = this.advancePresentationGeneration();
        this.presenter.endSession(invalidatedGeneration);

        const ownedGeneration = this.ownedBackendSessionGeneration ?? sessionGeneration;
        const stopPromise = this.callBackendStop(ownedGeneration, destroyPlayer);
        const completedStopPromise = stopPromise.catch(error => {
            this.htmlDelegate.destroy(ownedGeneration);
            throw error;
        }).finally(async () => {
            await customPlaybackStop;
            await audioPrewarmClose;
            await this.waitForPendingAudioPrewarmCloses();
            if (destroyPlayer && this.ownedBackendSessionGeneration === ownedGeneration) {
                this.ownedBackendSessionGeneration = null;
            }
            this.decrementPendingStopCount(sessionGeneration);
        });
        this.trackBackendStop(completedStopPromise);
        return completedStopPromise;
    }

    destroy(): void {
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this.handleDocumentVisibilityChange);
        }
        this.stopCustomPlaybackBackgroundDrain();
        const audioPrewarmClose = this.closeCustomPlaybackAudioPrewarm(this.backendSessionGeneration);
        if (audioPrewarmClose) {
            void audioPrewarmClose;
        }
        this.htmlDelegate.cancelPendingPlay();
        this.customPlaybackAudioSelectionRevision += 1;
        this.customPlaybackSetupRevision += 1;
        void this.detachCustomPlaybackController();
        this.backendSessionActive = false;
        this.webGPUPresentationEnabled = false;
        this.currentPlaybackOptions = null;
        this.currentNativeDeviceProfileProof = null;
        this.currentPlaybackRequiresSourceRenegotiation = false;
        this.customPlaybackRecoveryTimeMicroseconds = null;
        this.resetHTMLPlaybackNormalization();
        this.customPlaybackNormalizationGain = 1;
        this.currentDolbyVisionPresentationDescriptor = null;
        this.currentPresentationColorMetadata = null;
        this.currentDolbyVisionBaseColorMetadata = null;
        const sessionGeneration = this.backendSessionGeneration;
        const invalidatedGeneration = this.advancePresentationGeneration();
        this.presenter.endSession(invalidatedGeneration);
        this.presenter.destroy();
        this.htmlDelegate.endSession(sessionGeneration);

        const ownedGeneration = this.ownedBackendSessionGeneration ?? sessionGeneration;
        try {
            this.htmlDelegate.destroy(ownedGeneration);
        } finally {
            if (this.ownedBackendSessionGeneration === ownedGeneration) {
                this.ownedBackendSessionGeneration = null;
            }
        }
    }

    private async startBackendPlayback(options: unknown, generation: number): Promise<unknown> {
        if (!this.isRequestedSessionCurrent(generation)) {
            this.beginCustomPlaybackAudioPrewarmClose(generation);
            return PLAYBACK_SUPERSEDED;
        }

        try {
            if (this.ownedBackendSessionGeneration != null && this.ownedBackendSessionGeneration !== generation) {
                await this.stopOwnedBackendForReplacement(generation);
            }
            if (!this.isRequestedSessionCurrent(generation)) {
                return PLAYBACK_SUPERSEDED;
            }

            this.htmlDelegate.beginSession(generation);
            this.ownedBackendSessionGeneration = generation;
            const customDecodeEnabled = isWebGPUCustomDecodeEnabled();
            if (customDecodeEnabled) {
                const customPlaybackResult = await this.startCustomPlaybackBounded(options, generation, getPlaybackStartTimeMicroseconds(options));
                switch (customPlaybackResult.status) {
                    case 'handled':
                        return customPlaybackResult.result;
                    case 'superseded':
                        this.beginCustomPlaybackAudioPrewarmClose(generation);
                        return PLAYBACK_SUPERSEDED;
                    case 'native-required':
                        break;
                }
            }
            const disabledCustomSourceResult = this.renegotiateCustomOnlySourceWhenDisabled(customDecodeEnabled, options, generation);
            if (disabledCustomSourceResult) {
                switch (disabledCustomSourceResult.status) {
                    case 'handled':
                        return disabledCustomSourceResult.result;
                    case 'native-required':
                        break;
                    case 'superseded':
                        return PLAYBACK_SUPERSEDED;
                }
            }

            this.beginCustomPlaybackAudioPrewarmClose(generation);
            if (!this.isRequestedSessionCurrent(generation)) {
                return PLAYBACK_SUPERSEDED;
            }
            const playResult = await this.htmlDelegate.player.play(options);
            if (!this.isRequestedSessionCurrent(generation)) {
                return PLAYBACK_SUPERSEDED;
            }

            this.attachNativePresentation();
            return playResult;
        } catch (error) {
            this.beginCustomPlaybackAudioPrewarmClose(generation);
            this.htmlDelegate.endSession(generation);
            if (!this.isRequestedSessionCurrent(generation)) {
                return PLAYBACK_SUPERSEDED;
            }

            void this.detachCustomPlaybackController();
            this.backendSessionActive = false;
            this.webGPUPresentationEnabled = false;
            this.currentPlaybackOptions = null;
            this.currentDolbyVisionPresentationDescriptor = null;
            this.currentPresentationColorMetadata = null;
            this.currentDolbyVisionBaseColorMetadata = null;
            const invalidatedGeneration = this.advancePresentationGeneration();
            this.presenter.endSession(invalidatedGeneration);
            throw error;
        }
    }

    currentTime(value?: number): number | undefined {
        if (value != null) {
            this.cancelPendingPausedPresentationRefresh();
            const requestedTimeMicroseconds = millisecondsToMicroseconds(value);
            this.lastKnownTimeMicroseconds = requestedTimeMicroseconds;
            const recoveryTransitionActive = this.customPlaybackRecoveryTimeMicroseconds !== null;
            if (recoveryTransitionActive) {
                this.customPlaybackRecoveryTimeMicroseconds = requestedTimeMicroseconds;
            }
            this.customPlaybackSeekRevision += 1;
            const seekRevision = this.customPlaybackSeekRevision;
            const backendGeneration = this.backendSessionGeneration;
            const seekGeneration = this.advancePresentationGeneration();
            this.presenter.seek(seekGeneration);
            const customPlaybackController = this.getActiveCustomPlaybackController();
            if (customPlaybackController) {
                this.customPlaybackFrameGeneration = seekGeneration;
                this.cancelCustomPlaybackFrameCallback();
                this.presenter.setDecodedFramePushMode(true, seekGeneration);
                void Promise.resolve().then(() => (customPlaybackController.seek(requestedTimeMicroseconds))).then(result => {
                    if (this.customPlaybackSeekRevision !== seekRevision) {
                        return;
                    }
                    this.handleCustomPlaybackStartResult(customPlaybackController, backendGeneration, result);
                }).catch((error: unknown): void => {
                    if (this.customPlaybackSeekRevision !== seekRevision) {
                        return;
                    }
                    this.requestCustomPlaybackFallbackForError(customPlaybackController, backendGeneration, error);
                });
                return undefined;
            }
            if (recoveryTransitionActive) {
                return undefined;
            }
            this.htmlDelegate.player.currentTime(microsecondsToMilliseconds(requestedTimeMicroseconds));
            return undefined;
        }

        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (customPlaybackController) {
            this.lastKnownTimeMicroseconds = customPlaybackController.currentTimeMicroseconds;
            return microsecondsToMilliseconds(this.lastKnownTimeMicroseconds);
        }

        if (this.customPlaybackRecoveryTimeMicroseconds !== null) {
            return microsecondsToMilliseconds(this.customPlaybackRecoveryTimeMicroseconds);
        }

        const backendTimeMilliseconds = this.htmlDelegate.player.currentTime();
        if (typeof backendTimeMilliseconds !== 'number') {
            return undefined;
        }

        this.lastKnownTimeMicroseconds = millisecondsToMicroseconds(backendTimeMilliseconds);
        return microsecondsToMilliseconds(this.lastKnownTimeMicroseconds);
    }

    duration(): number | null {
        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (customPlaybackController) {
            const durationMicroseconds = customPlaybackController.durationMicroseconds;
            return durationMicroseconds === null ? null : microsecondsToMilliseconds(durationMicroseconds);
        }

        const backendDurationMilliseconds = this.htmlDelegate.player.duration();
        if (typeof backendDurationMilliseconds !== 'number') {
            return null;
        }

        return microsecondsToMilliseconds(millisecondsToMicroseconds(backendDurationMilliseconds));
    }

    seekable(): boolean | undefined {
        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (customPlaybackController) {
            // The host seeks by percent of duration, so without a duration every seek would land at zero
            return customPlaybackController.durationMicroseconds !== null;
        }
        return this.htmlDelegate.player.seekable();
    }

    pause(): void {
        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (customPlaybackController) {
            customPlaybackController.pause();
            return;
        }
        this.htmlDelegate.player.pause();
    }

    resume(): void {
        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (customPlaybackController) {
            customPlaybackController.resume();
            return;
        }
        this.htmlDelegate.player.resume();
    }

    unpause(): void {
        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (customPlaybackController) {
            customPlaybackController.resume();
            return;
        }
        this.htmlDelegate.player.unpause();
    }

    paused(): boolean {
        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (customPlaybackController) {
            return customPlaybackController.playbackState !== 'playing';
        }
        return this.htmlDelegate.player.paused();
    }

    setSubtitleStreamIndex(index: number): void {
        this.htmlDelegate.player.setSubtitleStreamIndex(index);
    }

    setSecondarySubtitleStreamIndex(index: number): void {
        this.htmlDelegate.player.setSecondarySubtitleStreamIndex(index);
    }

    resetSubtitleOffset(): void {
        this.htmlDelegate.player.resetSubtitleOffset();
    }

    setSubtitleOffset(offset: number | string): void {
        this.htmlDelegate.player.setSubtitleOffset(offset);
    }

    getSubtitleOffset(): number | undefined {
        return this.htmlDelegate.player.getSubtitleOffset();
    }

    enableShowingSubtitleOffset(): void {
        this.htmlDelegate.player.enableShowingSubtitleOffset();
    }

    disableShowingSubtitleOffset(): void {
        this.htmlDelegate.player.disableShowingSubtitleOffset();
    }

    isShowingSubtitleOffsetEnabled(): boolean {
        return Boolean(this.htmlDelegate.player.isShowingSubtitleOffsetEnabled());
    }

    canSetAudioStreamIndex(): boolean {
        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (customPlaybackController) {
            return customPlaybackController.canSetAudioStreamIndex();
        }
        return this.htmlDelegate.player.canSetAudioStreamIndex();
    }

    setAudioStreamIndex(index: number): void {
        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (customPlaybackController) {
            this.cancelPendingPausedPresentationRefresh();
            this.updateCustomPlaybackAudioSelection(index);
            const backendGeneration = this.backendSessionGeneration;
            const selectionRevision = this.customPlaybackAudioSelectionRevision + 1;
            this.customPlaybackAudioSelectionRevision = selectionRevision;
            void this.restartCustomPlaybackForSelectedAudio(
                customPlaybackController,
                backendGeneration,
                selectionRevision
            ).catch((error: unknown): void => {
                if (this.customPlaybackAudioSelectionRevision !== selectionRevision) {
                    return;
                }
                this.requestCustomPlaybackFallbackForError(customPlaybackController, backendGeneration, error);
            });
            return;
        }
        this.htmlDelegate.player.setAudioStreamIndex(index);
    }

    setVolume(value: number | string): void {
        const jellyfinVolume = this.requireJellyfinVolume(value);
        this.customPlaybackVolume = jellyfinVolume;
        this.applyHTMLPlaybackVolume();
        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (customPlaybackController) {
            customPlaybackController.setVolume(this.getLinearVolume(jellyfinVolume));
        }
    }

    getVolume(): number | undefined {
        if (this.getActiveCustomPlaybackController() || this.htmlPlaybackNormalizationGain !== null) {
            return this.customPlaybackVolume;
        }
        return this.htmlDelegate.player.getVolume();
    }

    volumeUp(): void {
        if (this.getActiveCustomPlaybackController() || this.htmlPlaybackNormalizationGain !== null) {
            this.setVolume(Math.min(this.customPlaybackVolume + CUSTOM_VOLUME_STEP, MAX_JELLYFIN_VOLUME));
            return;
        }
        this.htmlDelegate.player.volumeUp();
    }

    volumeDown(): void {
        if (this.getActiveCustomPlaybackController() || this.htmlPlaybackNormalizationGain !== null) {
            this.setVolume(Math.max(this.customPlaybackVolume - CUSTOM_VOLUME_STEP, MIN_JELLYFIN_VOLUME));
            return;
        }
        this.htmlDelegate.player.volumeDown();
    }

    setMute(muted: boolean): void {
        this.customPlaybackMuted = muted;
        this.htmlDelegate.player.setMute(muted);
        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (customPlaybackController) {
            customPlaybackController.setMuted(muted);
        }
    }

    isMuted(): boolean {
        if (this.getActiveCustomPlaybackController()) {
            return this.customPlaybackMuted;
        }
        return this.htmlDelegate.player.isMuted();
    }

    setPlaybackRate(value: number): void {
        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (customPlaybackController) {
            customPlaybackController.setPlaybackRate(value);
            return;
        }
        this.htmlDelegate.player.setPlaybackRate(value);
    }

    getPlaybackRate(): number | null {
        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (customPlaybackController) {
            return customPlaybackController.playbackRate;
        }
        return this.htmlDelegate.player.getPlaybackRate();
    }

    getSupportedPlaybackRates(): PlaybackRateOption[] {
        if (this.getActiveCustomPlaybackController()) {
            return [{ id: 1, name: '1x' }];
        }
        return this.htmlDelegate.player.getSupportedPlaybackRates();
    }

    setBrightness(value: number): void {
        this.htmlDelegate.player.setBrightness(value);
    }

    getBrightness(): number | undefined {
        return this.htmlDelegate.player.getBrightness();
    }

    setAspectRatio(value: string): void {
        this.htmlDelegate.player.setAspectRatio(value);
        this.presenter.refresh(this.presentationGeneration);
    }

    getAspectRatio(): string {
        return this.htmlDelegate.player.getAspectRatio();
    }

    getSupportedAspectRatios(): AspectRatioOption[] {
        return this.htmlDelegate.player.getSupportedAspectRatios();
    }

    setPictureInPictureEnabled(enabled: boolean): void {
        this.htmlDelegate.player.setPictureInPictureEnabled(enabled);
    }

    isPictureInPictureEnabled(): boolean {
        return this.htmlDelegate.player.isPictureInPictureEnabled();
    }

    togglePictureInPicture(): unknown {
        return this.htmlDelegate.player.togglePictureInPicture();
    }

    setAirPlayEnabled(enabled: boolean): void {
        this.htmlDelegate.player.setAirPlayEnabled(enabled);
    }

    isAirPlayEnabled(): boolean {
        return this.htmlDelegate.player.isAirPlayEnabled();
    }

    toggleAirPlay(): unknown {
        return this.htmlDelegate.player.toggleAirPlay();
    }

    getBufferedRanges(): unknown[] {
        if (this.isCustomPlaybackPathActive()) {
            return [];
        }
        return this.htmlDelegate.player.getBufferedRanges();
    }

    getStats(): Promise<unknown> {
        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (customPlaybackController) {
            const customTelemetry = customPlaybackController.getTelemetry();
            const presentationTiming = customTelemetry.presentationTiming;
            const presentationTelemetry = this.presenter.getTelemetry();
            const eligibility = this.lastCustomPlaybackEligibility;
            return loadAddonStrings().then(() => {
                const videoPath = eligibility?.eligible === true ?
                    `${translateVideoDecoderBackend(eligibility.videoDecoderBackend)} / ${translateVideoOutputMode(eligibility.videoOutputMode)}` :
                    globalize.translate('Unknown');
                // Counts stay out of translate, whose arguments are formatted for the locale; the playback testers parse them
                const categories = [
                    {
                        stats: [
                            { label: globalize.translate('WebGPUStatsPlaybackPipeline'), value: 'WebCodecs / WebGPU' },
                            {
                                label: globalize.translate('WebGPUStatsState'),
                                value: translatePlaybackState(customTelemetry.state)
                            },
                            {
                                label: globalize.translate('WebGPUStatsClock'),
                                value: `${customTelemetry.currentTimeMicroseconds} ${globalize.translate('WebGPUMicrosecondsUnit')}`
                            }
                        ],
                        type: 'media'
                    },
                    {
                        stats: [
                            {
                                label: globalize.translate('WebGPUStatsVideoPath'),
                                value: videoPath
                            },
                            {
                                label: globalize.translate('WebGPUStatsDecodedPresentedFrames'),
                                value: `${customTelemetry.videoDecode.receivedFrameCount} / ${presentationTelemetry.presentedFrameCount}`
                            },
                            {
                                // Every frame never shown: older due frames skipped, and frames discarded as stale
                                label: globalize.translate('WebGPUStatsDroppedQueuedFrames'),
                                value: `${customTelemetry.videoDecode.droppedFrameCount + customTelemetry.discardedStaleVideoFrameCount} / ${customTelemetry.videoDecode.queuedFrameCount}`
                            },
                            {
                                label: globalize.translate('WebGPUStatsStaleFramesDiscarded'),
                                value: `${customTelemetry.discardedStaleVideoFrameCount}`
                            },
                            {
                                label: globalize.translate('WebGPUStatsLateFramesWorstLag'),
                                value: `${presentationTiming.lateFrameCount} / ${formatRoundedMilliseconds(presentationTiming.worstFrameLagMicroseconds)} ${globalize.translate('WebGPUMillisecondsUnit')}`
                            },
                            {
                                label: globalize.translate('WebGPUStatsClockResetsLargestJump'),
                                value: `${presentationTiming.clockResetCount} / ${formatRoundedMilliseconds(presentationTiming.largestClockJumpMicroseconds)} ${globalize.translate('WebGPUMillisecondsUnit')}`
                            },
                            {
                                label: globalize.translate('WebGPUStatsVideoResyncsSuspensions'),
                                value: `${customTelemetry.videoDecode.videoResyncCount} / ${customTelemetry.videoDecode.videoSuspensionCount}`
                            }
                        ],
                        type: 'video'
                    },
                    {
                        stats: [
                            {
                                label: globalize.translate('WebGPUStatsAudioPath'),
                                value: translateAudioPath(customTelemetry.audioPath)
                            },
                            {
                                label: globalize.translate('WebGPUStatsQueuedUnderflowFrames'),
                                value: `${customTelemetry.audioOutput?.queuedFrames ?? 0} / ${customTelemetry.audioOutput?.underflowFrames ?? 0}`
                            }
                        ],
                        type: 'audio'
                    }
                ];
                // The host inserts labels and values as HTML
                return {
                    categories: categories.map(category => ({
                        ...category,
                        stats: category.stats.map(stat => ({ label: escapeHtml(stat.label), value: escapeHtml(stat.value) }))
                    }))
                };
            });
        }
        return this.htmlDelegate.player.getStats();
    }

    getPresentationTelemetry(): PresentationTelemetry {
        return this.presenter.getTelemetry();
    }

    /** Returns the raw HDR authorization results per route key on the current GPU device and canvas format. */
    getRawHDRAuthorizationTelemetry(): RawHDRAuthorizationTelemetry {
        return this.presenter.getRawHDRAuthorizationTelemetry();
    }

    /** Returns the authorization result of one raw Dolby Vision route and raw base-layer format on the current GPU device and canvas format. */
    getDolbyVisionAuthorizationTelemetry(
        route: DolbyVisionAuthorizationRoute,
        format: RawDolbyVisionVideoFrameFormat = DEFAULT_DOLBY_VISION_RAW_FRAME_FORMAT
    ): DolbyVisionAuthorizationTelemetry {
        return this.presenter.getDolbyVisionAuthorizationTelemetry(route, format);
    }

    /** Returns the external Profile 5 Dolby Vision authorization result on the current GPU device and canvas format. */
    getExternalDolbyVisionAuthorizationTelemetry(): ExternalDolbyVisionAuthorizationTelemetry {
        return this.presenter.getExternalDolbyVisionAuthorizationTelemetry();
    }

    /** Returns the native Main10 external-texture authorization results per route key on the current GPU device and canvas format. */
    getExternalHDRAuthorizationTelemetry(): ExternalHDRAuthorizationTelemetry {
        return this.presenter.getExternalHDRAuthorizationTelemetry();
    }

    /** Applies live HDR display controls without rebuilding the shader pipeline. */
    updateRenderSettings(
        settings: HDRToSDRRenderSettings,
        automaticInputPeakNits: boolean = loadWebGPUUserSettings().render.automaticInputPeakNits
    ): boolean {
        return this.presenter.updateRenderSettings(settings, this.presentationGeneration, automaticInputPeakNits);
    }

    /** Applies live gain changes to an active WebGPU stereo downmix when available. */
    updateAudioDownmixSettings(settings: AudioDownmixSettings): boolean {
        assertValidAudioDownmixSettings(settings);
        const customPlaybackController = this.getActiveCustomPlaybackController();
        const audioSettings = this.customPlaybackAudioSettings;
        if (!customPlaybackController || !audioSettings) {
            return false;
        }

        const settingsSnapshot: AudioDownmixSettings = { ...settings };
        this.customPlaybackAudioSettings = {
            ...audioSettings,
            downmix: { ...settingsSnapshot }
        };
        return customPlaybackController.updateAudioDownmixSettings(settingsSnapshot);
    }

    /**
     * Applies force stereo and the downmix algorithm to active WebGPU decoded audio at once.
     * Resolves false when no active session took them live.
     */
    applyAudioOutputSettings(forceStereoDownmix: boolean, audioDownmixAlgorithm: CustomAudioDownmixAlgorithm): Promise<boolean> {
        const audioSettings = this.customPlaybackAudioSettings;
        if (!audioSettings || !this.getActiveCustomPlaybackController()) {
            return Promise.resolve(false);
        }

        this.customPlaybackAudioSettings = {
            ...audioSettings,
            forceStereoDownmix
        };
        if (this.customPlaybackAudioDownmixAlgorithm !== null) {
            this.customPlaybackAudioDownmixAlgorithm = audioDownmixAlgorithm;
        }
        return this.reconfigureCustomPlaybackAudioOutput();
    }

    /**
     * Picks the decoded layout for the current device and settings and switches a live session to it.
     * The controller ignores a request that changes nothing.
     * Resolves whether the session took the request.
     */
    private reconfigureCustomPlaybackAudioOutput(): Promise<boolean> {
        const customPlaybackController = this.getActiveCustomPlaybackController();
        const audioSettings = this.customPlaybackAudioSettings;
        const eligibility = this.lastCustomPlaybackEligibility;
        if (!customPlaybackController || !audioSettings || !eligibility?.eligible || eligibility.audioTrackIndex === null) {
            return Promise.resolve(false);
        }

        const decodedAudioOutputChannelCount = selectDecodedAudioOutputChannelCount(
            eligibility,
            customPlaybackController.getAudioOutputMaximumChannelCount(),
            audioSettings.forceStereoDownmix
        );
        if (decodedAudioOutputChannelCount === undefined) {
            return Promise.resolve(false);
        }
        return customPlaybackController.reconfigureAudioOutput({
            audioDownmixAlgorithm: this.customPlaybackAudioDownmixAlgorithm ?? undefined,
            audioDownmixSettings: { ...audioSettings.downmix },
            decodedAudioOutputChannelCount
        }).catch((error: unknown): boolean => {
            console.warn('Unable to switch the WebGPU audio output layout', error);
            return false;
        });
    }

    /** Returns a detached renderer-settings snapshot for diagnostics and UI. */
    getRenderSettings(): RenderSettings {
        return this.presenter.getRenderSettings();
    }

    /** Returns the retained source peak used when automatic metadata tracking is enabled. */
    getDetectedInputPeakNits(): number | null {
        if (!this.backendSessionActive || !this.webGPUPresentationEnabled) {
            return null;
        }
        return this.activeDetectedInputPeakNits;
    }

    /** Returns the combined custom A/V pipeline telemetry. */
    getCustomPlaybackTelemetry(): CustomPlaybackTelemetry | null {
        const telemetry = this.customPlaybackController?.getTelemetry() ?? this.lastCustomPlaybackTelemetry;
        return telemetry ? { ...telemetry } : null;
    }

    /** Returns the selected Jellyfin stream index rather than the decoder track ordinal. */
    getCustomPlaybackSelectedAudioStreamIndex(): number | null {
        if (!this.getActiveCustomPlaybackController() || !this.currentPlaybackOptions || typeof this.currentPlaybackOptions !== 'object') {
            return null;
        }

        const playbackOptions = this.currentPlaybackOptions as PlaybackOptionsRecord;
        const requestedIndex = playbackOptions.audioStreamIndex;
        if (Number.isSafeInteger(requestedIndex) && Number(requestedIndex) >= 0) {
            return Number(requestedIndex);
        }
        const mediaSource = playbackOptions.mediaSource;
        if (!mediaSource || typeof mediaSource !== 'object') {
            return null;
        }
        const defaultIndex = (mediaSource as PlaybackOptionsRecord).DefaultAudioStreamIndex;
        return Number.isSafeInteger(defaultIndex) && Number(defaultIndex) >= 0 ? Number(defaultIndex) : null;
    }

    /** Returns the last eligibility decision without operational source data. */
    getCustomPlaybackEligibility(): CustomPlaybackEligibilityTelemetry | null {
        const eligibility = this.lastCustomPlaybackEligibility;
        if (!eligibility) {
            return null;
        }
        if (!eligibility.eligible) {
            return {
                eligible: false,
                reason: eligibility.reason
            };
        }
        return {
            audioOutputMode: eligibility.audioOutputMode,
            eligible: true,
            hdr: eligibility.hdr,
            nativeHDRTransfer: eligibility.nativeHDRTransfer ?? null,
            neutralizeHDRColorMetadata: eligibility.neutralizeHDRColorMetadata,
            videoDecoderBackend: eligibility.videoDecoderBackend,
            videoOutputMode: eligibility.videoOutputMode
        };
    }

    /** Returns the last bounded custom-playback setup stage. */
    getCustomPlaybackSetupTelemetry(): CustomPlaybackSetupTelemetry {
        return { ...this.customPlaybackSetupTelemetry };
    }

    /** Returns the last custom-codec capability snapshot used for negotiation. */
    getCustomDecodeCapabilities(): CustomDecodeCapabilities | null {
        return this.lastCustomDecodeCapabilities;
    }

    /** Returns the exact owned native-audio route probe used for negotiation. */
    getNativeMediaAudioCapabilities(): NativeMediaAudioCapabilities | null {
        const capabilities = this.lastNativeMediaAudioCapabilities;
        if (!capabilities) {
            return null;
        }
        return {
            audio: capabilities.audio,
            telemetry: { ...capabilities.telemetry }
        };
    }

    /** Returns the last safe device-profile augmentation decision. */
    getCustomDeviceProfileTelemetry(): CustomDeviceProfileTelemetry | null {
        const telemetry = this.lastCustomDeviceProfileTelemetry;
        return telemetry ? {
            ...telemetry,
            supportedAudioCodecs: [ ...telemetry.supportedAudioCodecs ],
            supportedVideoCodecs: [ ...telemetry.supportedVideoCodecs ]
        } : null;
    }

    /** Returns why custom A/V playback was or was not eligible at negotiation. */
    getCustomPlaybackRuntimeAvailability(): CustomPlaybackRuntimeAvailability | null {
        return this.lastCustomPlaybackRuntimeAvailability;
    }

    private attachNativePresentation(): void {
        if (!this.webGPUPresentationEnabled) {
            return;
        }

        // Native HDR must stay on the browser-managed video path.
        // External textures expose browser-converted sRGB, not the source PQ/HLG signal
        if (this.currentPresentationColorMetadata?.transfer !== 'sdr') {
            this.webGPUPresentationEnabled = false;
            this.presenter.endSession(this.presentationGeneration);
            return;
        }

        const presentationSurface = this.htmlDelegate.player.getPresentationSurface();
        if (!presentationSurface) {
            return;
        }

        const generation = this.presentationGeneration;
        this.presenter.setDecodedFramePushMode(false, generation);
        this.presenter.attach(presentationSurface, generation);
        void this.configurePresentationColorPipeline(generation, 'video-frame', null, null).then(configured => {
            if (!configured && this.isRequestedSessionCurrent(this.backendSessionGeneration)) {
                console.warn('WebGPU presentation returned to the native video surface');
            }
        });
    }

    private createHDRRenderConfiguration(detectedInputPeakNits: number): WebGPUUserSettings['render'] {
        const userSettings = loadWebGPUUserSettings();
        const automaticUserSettings: WebGPUUserSettings = {
            ...userSettings,
            render: {
                ...userSettings.render,
                automaticInputPeakNits: true
            }
        };
        const automaticSettings = createConfiguredHDRRenderSettings(automaticUserSettings, detectedInputPeakNits);
        this.activeDetectedInputPeakNits = automaticSettings.toneMapping.inputPeakNits;
        return {
            automaticInputPeakNits: userSettings.render.automaticInputPeakNits,
            settings: userSettings.render.automaticInputPeakNits ?
                automaticSettings :
                createConfiguredHDRRenderSettings(userSettings, detectedInputPeakNits)
        };
    }

    private configureDolbyVisionPresentationColorPipeline(
        dolbyVisionProfile: Exclude<CustomDecodeDolbyVisionProfile, null>,
        generation: number,
        videoOutputMode: CustomDecodeVideoOutputMode,
        rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat | null
    ): Promise<boolean> {
        if (dolbyVisionProfile === 5 && videoOutputMode === 'video-frame' && rawVideoFrameFormat === null) {
            return this.presenter.configureColorPipeline({
                ...this.createHDRRenderConfiguration(4_000),
                inputMode: 'external-dolby-vision',
                profile: 5
            }, generation);
        }
        if (videoOutputMode !== 'raw-planes' || rawVideoFrameFormat === null || !isRawDolbyVisionVideoFrameFormat(rawVideoFrameFormat)) {
            return Promise.resolve(false);
        }
        return this.presenter.configureColorPipeline({
            ...this.createHDRRenderConfiguration(4_000),
            inputMode: 'raw-dolby-vision',
            profile: dolbyVisionProfile,
            rawFrameFormat: rawVideoFrameFormat
        }, generation);
    }

    private configurePresentationColorPipeline(
        generation: number,
        videoOutputMode: CustomDecodeVideoOutputMode,
        rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat | null,
        dolbyVisionProfile: CustomDecodeDolbyVisionProfile
    ): Promise<boolean> {
        const dolbyVisionDescriptor = this.currentDolbyVisionPresentationDescriptor;
        if (!dolbyVisionDescriptor) {
            return this.configureColorMetadataPresentationPipeline(
                generation,
                videoOutputMode,
                rawVideoFrameFormat,
                this.currentPresentationColorMetadata
            );
        }
        if (dolbyVisionProfile === null) {
            return this.configureDolbyVisionBaseColorPipeline(
                dolbyVisionDescriptor,
                generation,
                videoOutputMode,
                rawVideoFrameFormat
            );
        }
        if (dolbyVisionDescriptor.reconstructionProfile !== dolbyVisionProfile) {
            return Promise.resolve(false);
        }

        return this.configureDolbyVisionPresentationColorPipeline(
            dolbyVisionProfile,
            generation,
            videoOutputMode,
            rawVideoFrameFormat
        );
    }

    /**
     * Presents a Dolby Vision base layer without its RPU: the exact native Profile 7 and 8 bases through external HDR, and any other declared base through the ordinary route the eligibility selected.
     */
    private configureDolbyVisionBaseColorPipeline(
        dolbyVisionDescriptor: DolbyVisionPresentationDescriptor,
        generation: number,
        videoOutputMode: CustomDecodeVideoOutputMode,
        rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat | null
    ): Promise<boolean> {
        if (this.isCurrentDolbyVisionNativeBasePresentation()) {
            const colorMetadata = this.getCurrentDolbyVisionBaseColorMetadata();
            const descriptorSupported =
                isDolbyVisionProfile7HDR10BaseLayerDescriptor(dolbyVisionDescriptor)
                || isDolbyVisionProfile8HDR10BaseLayerDescriptor(dolbyVisionDescriptor)
                || isDolbyVisionProfile8HLGBaseLayerDescriptor(dolbyVisionDescriptor);
            if (!descriptorSupported || colorMetadata === null || videoOutputMode !== 'video-frame' || rawVideoFrameFormat !== null) {
                return Promise.resolve(false);
            }
            return this.presenter.configureColorPipeline({
                ...this.createHDRRenderConfiguration(colorMetadata.nominalPeakNits),
                inputMode: 'external-hdr',
                metadata: colorMetadata
            }, generation);
        }
        return this.configureColorMetadataPresentationPipeline(
            generation,
            videoOutputMode,
            rawVideoFrameFormat,
            this.currentDolbyVisionBaseColorMetadata
        );
    }

    private getCurrentDolbyVisionBaseColorMetadata(): InputColorMetadata | null {
        return getDolbyVisionProfile7HDR10BaseColorMetadata(this.currentPlaybackOptions)
            ?? getDolbyVisionProfile8HDR10BaseColorMetadata(this.currentPlaybackOptions)
            ?? getDolbyVisionProfile8HLGBaseColorMetadata(this.currentPlaybackOptions);
    }

    private configureColorMetadataPresentationPipeline(
        generation: number,
        videoOutputMode: CustomDecodeVideoOutputMode,
        rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat | null,
        metadata: InputColorMetadata | null
    ): Promise<boolean> {
        if (!metadata) {
            return Promise.resolve(false);
        }
        if (metadata.transfer === 'sdr') {
            this.activeDetectedInputPeakNits = null;
            if (videoOutputMode === 'video-frame' && rawVideoFrameFormat === null) {
                return this.presenter.configureColorPipeline({
                    settings: createDefaultRenderSettings()
                }, generation);
            }
            if (videoOutputMode !== 'raw-planes' || rawVideoFrameFormat === null) {
                return Promise.resolve(false);
            }
        }

        if (videoOutputMode === 'video-frame' && rawVideoFrameFormat === null) {
            return this.presenter.configureColorPipeline({
                ...this.createHDRRenderConfiguration(metadata.nominalPeakNits),
                inputMode: 'external-hdr',
                metadata
            }, generation);
        }

        if (videoOutputMode !== 'raw-planes' || rawVideoFrameFormat === null) {
            return Promise.resolve(false);
        }
        if (getRawVideoFrameBitDepth(rawVideoFrameFormat) !== metadata.bitDepth) {
            return Promise.resolve(false);
        }

        if (metadata.transfer === 'sdr') {
            return this.presenter.configureColorPipeline({
                inputMode: 'raw-yuv',
                metadata,
                rawFrameFormat: rawVideoFrameFormat,
                settings: createDefaultRenderSettings()
            }, generation);
        }

        return this.presenter.configureColorPipeline({
            ...this.createHDRRenderConfiguration(metadata.nominalPeakNits),
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: rawVideoFrameFormat
        }, generation);
    }

    private applyStaticHDRMetadata(metadata: StaticHDRMetadata): void {
        const dolbyVisionBaseColorMetadata = this.getActiveDolbyVisionBaseColorMetadata();
        if (this.currentPresentationColorMetadata?.transfer !== 'pq' && dolbyVisionBaseColorMetadata?.transfer !== 'pq') {
            return;
        }

        const inputPeakNits = getStaticHDRToneMappingPeakNits(metadata);
        if (inputPeakNits === null) {
            return;
        }
        const configuration = this.createHDRRenderConfiguration(inputPeakNits);
        if (!configuration.automaticInputPeakNits) {
            return;
        }
        const currentSettings = this.presenter.getRenderSettings();
        if (currentSettings.mode !== 'hdr-to-sdr'
            || currentSettings.toneMapping.inputPeakNits === configuration.settings.toneMapping.inputPeakNits) {
            return;
        }
        if (!this.presenter.updateRenderSettings(configuration.settings, this.presentationGeneration, true)) {
            console.warn('WebGPU could not apply static HDR luminance metadata');
        }
    }

    /** Returns the base-layer metadata a Dolby Vision session presents without its RPU, or null. */
    private getActiveDolbyVisionBaseColorMetadata(): InputColorMetadata | null {
        const eligibility = this.lastCustomPlaybackEligibility;
        if (
            this.currentDolbyVisionPresentationDescriptor === null
            || eligibility?.eligible !== true
            || eligibility.dolbyVisionProfile !== null
        ) {
            return null;
        }
        return this.isCurrentDolbyVisionNativeBasePresentation() ?
            this.getCurrentDolbyVisionBaseColorMetadata() :
            this.currentDolbyVisionBaseColorMetadata;
    }

    private isCurrentDolbyVisionNativeBasePresentation(): boolean {
        const descriptor = this.currentDolbyVisionPresentationDescriptor;
        const eligibility = this.lastCustomPlaybackEligibility;
        const colorMetadata = this.getCurrentDolbyVisionBaseColorMetadata();
        return descriptor !== null
            && (
                isDolbyVisionProfile7HDR10BaseLayerDescriptor(descriptor)
                || isDolbyVisionProfile8HDR10BaseLayerDescriptor(descriptor)
                || isDolbyVisionProfile8HLGBaseLayerDescriptor(descriptor)
            )
            && colorMetadata !== null
            && eligibility?.eligible === true
            && eligibility.dolbyVisionProfile === null
            && eligibility.nativeHDRTransfer === colorMetadata.transfer
            && eligibility.neutralizeHDRColorMetadata;
    }

    private startCustomPlaybackAudioPrewarm(options: unknown, backendGeneration: number): void {
        if (!isWebGPUCustomDecodeEnabled()) {
            return;
        }

        const sourceSampleRate = getSelectedAudioSampleRate(options);
        if (sourceSampleRate === null) {
            return;
        }

        try {
            this.customPlaybackAudioPrewarm = {
                backendGeneration,
                lease: prewarmBrowserAudioContext(CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE)
            };
        } catch (error) {
            console.warn('Unable to prewarm custom playback audio', error);
        }
    }

    private getCustomPlaybackAudioPrewarm(backendGeneration: number): BrowserAudioContextPrewarmLease | null {
        const audioPrewarm = this.customPlaybackAudioPrewarm;
        return audioPrewarm?.backendGeneration === backendGeneration ? audioPrewarm.lease : null;
    }

    private getCustomPlaybackAudioPrewarmForTrack(
        audioTrackIndex: number | null,
        audioOutputMode: CustomDecodeAudioOutputMode | null,
        backendGeneration: number
    ): BrowserAudioContextPrewarmLease | null {
        if (audioTrackIndex !== null && audioOutputMode === 'decoded-pcm') {
            return this.getCustomPlaybackAudioPrewarm(backendGeneration);
        }

        this.beginCustomPlaybackAudioPrewarmClose(backendGeneration);
        return null;
    }

    private beginCustomPlaybackAudioPrewarmClose(backendGeneration: number): void {
        const audioPrewarmClose = this.closeCustomPlaybackAudioPrewarm(backendGeneration);
        if (audioPrewarmClose) {
            void audioPrewarmClose;
        }
    }

    private closeCustomPlaybackAudioPrewarm(backendGeneration: number): Promise<void> | null {
        const audioPrewarm = this.customPlaybackAudioPrewarm;
        if (!audioPrewarm || audioPrewarm.backendGeneration !== backendGeneration) {
            return null;
        }

        this.customPlaybackAudioPrewarm = null;
        let closePromise: Promise<void>;
        // eslint-disable-next-line sonarjs/no-try-promise -- AudioContext close may throw synchronously
        try {
            closePromise = audioPrewarm.lease.close().catch((error: unknown): void => {
                console.warn('Unable to close unused custom playback audio prewarm', error);
            });
        } catch (error) {
            console.warn('Unable to close unused custom playback audio prewarm', error);
            return Promise.resolve();
        }
        this.pendingAudioPrewarmClosePromises.add(closePromise);
        closePromise.then((): void => {
            this.pendingAudioPrewarmClosePromises.delete(closePromise);
        }, (): void => {
            this.pendingAudioPrewarmClosePromises.delete(closePromise);
        });
        return closePromise;
    }

    private waitForPendingAudioPrewarmCloses(): Promise<void> {
        const pendingCloses = Array.from(this.pendingAudioPrewarmClosePromises);
        return Promise.all(pendingCloses).then((): void => undefined);
    }

    private createCustomPlaybackAudioOutputFactory(
        audioOutputModule: typeof import('webgpu-player/audio/output/BrowserCustomAudioOutput'),
        audioTrackIndex: number | null,
        audioPrewarm: BrowserAudioContextPrewarmLease | null
    ): CustomAudioOutputFactory | undefined {
        return audioTrackIndex === null ? undefined : audioOutputModule.createBrowserCustomAudioOutputFactory(audioPrewarm);
    }

    private createCustomPlaybackController(
        controllerModule: typeof import('webgpu-player/pipeline/CustomPlaybackController'),
        audioOutputModule: typeof import('webgpu-player/audio/output/BrowserCustomAudioOutput'),
        nativeAudioBridgeModule: typeof import('webgpu-player/audio/native/CustomDecodeNativeAudioBridge'),
        eligibility: EligibleCustomPlayback,
        audioPrewarm: BrowserAudioContextPrewarmLease | null,
        backendGeneration: number
    ): CustomPlaybackController {
        const controllerReference: { controller: CustomPlaybackController | null } = { controller: null };
        const nativeAudioBridgeFactory = eligibility.audioTrackIndex === null ?
            undefined :
            (): InstanceType<typeof nativeAudioBridgeModule.default> => (new nativeAudioBridgeModule.default());
        const customPlaybackController = new controllerModule.default({
            audioOutputFactory: this.createCustomPlaybackAudioOutputFactory(
                audioOutputModule,
                eligibility.audioTrackIndex,
                audioPrewarm
            ),
            eventHandler: (event: CustomPlaybackControllerEvent): void => {
                if (controllerReference.controller) {
                    this.handleCustomPlaybackEvent(controllerReference.controller, backendGeneration, event);
                }
            },
            fallbackHook: (request: CustomPlaybackFallbackRequest): Promise<void> => {
                if (!controllerReference.controller) {
                    return Promise.resolve();
                }
                return this.requestCustomPlaybackFallback(
                    controllerReference.controller,
                    backendGeneration,
                    request
                ).then(() => undefined);
            },
            nativeAudioBridgeFactory,
            // Each decode worker draws its frames into a canvas of its own; the presenter declines where it cannot hand one over
            presentationRendererProvider: (): WorkerPresentationAttachment | null => (
                this.presenter.createWorkerPresentationAttachment(this.presentationGeneration)
            )
        });
        controllerReference.controller = customPlaybackController;
        return customPlaybackController;
    }

    private async startCustomPlaybackBounded(
        options: unknown,
        backendGeneration: number,
        recoveryAnchorMicroseconds: Microseconds
    ): Promise<CustomPlaybackAttemptResult> {
        const setupRevision = this.customPlaybackSetupRevision;
        this.customPlaybackSetupTelemetry = {
            stage: 'capabilities',
            status: 'in-progress'
        };
        const result = await waitForCustomPlaybackSetup(
            (deadline: CustomPlaybackSetupDeadline): Promise<CustomPlaybackAttemptResult> => (
                this.tryStartCustomPlayback(options, backendGeneration, setupRevision, recoveryAnchorMicroseconds, deadline)
            )
        );
        if (result !== CUSTOM_PLAYBACK_SETUP_TIMEOUT) {
            if (result.status !== 'superseded') {
                this.customPlaybackSetupTelemetry = {
                    stage: 'complete',
                    status: 'complete'
                };
            }
            return result;
        }

        if (!this.isCustomPlaybackSetupCurrent(backendGeneration, setupRevision)) {
            return { status: 'superseded' };
        }

        this.customPlaybackSetupTelemetry = {
            stage: this.customPlaybackSetupTelemetry.stage,
            status: 'timeout'
        };
        this.customPlaybackSetupRevision += 1;
        this.customPlaybackStartingGeneration = null;
        this.webGPUPresentationEnabled = false;
        const invalidatedGeneration = this.advancePresentationGeneration();
        this.presenter.endSession(invalidatedGeneration);
        void this.detachCustomPlaybackController();
        if (!this.isRequestedSessionCurrent(backendGeneration)) {
            return { status: 'superseded' };
        }

        console.warn('Custom playback setup exceeded its bounded timeout');
        return this.getCustomPlaybackUnavailableResult(backendGeneration, 'startup-timeout', recoveryAnchorMicroseconds);
    }

    /** Jellyfin can omit Rext BitDepth, so the raw plane format fixes the decoded depth. */
    private alignPresentationBitDepthToRawFrames(rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat | null): void {
        if (!rawVideoFrameFormat) {
            return;
        }
        const bitDepth = getRawVideoFrameBitDepth(rawVideoFrameFormat);
        if (this.currentPresentationColorMetadata) {
            this.currentPresentationColorMetadata = {
                ...this.currentPresentationColorMetadata,
                bitDepth
            };
        }
        if (this.currentDolbyVisionBaseColorMetadata) {
            this.currentDolbyVisionBaseColorMetadata = {
                ...this.currentDolbyVisionBaseColorMetadata,
                bitDepth
            };
        }
    }

    private async tryStartCustomPlayback(
        options: unknown,
        backendGeneration: number,
        setupRevision: number,
        recoveryAnchorMicroseconds: Microseconds,
        setupDeadline: CustomPlaybackSetupDeadline
    ): Promise<CustomPlaybackAttemptResult> {
        this.customPlaybackStartingGeneration = backendGeneration;
        const eligibility = await this.getCustomPlaybackEligibilityForOptions(options, backendGeneration);
        if (!this.isCustomPlaybackSetupCurrent(backendGeneration, setupRevision)) {
            return { status: 'superseded' };
        }
        if (!eligibility?.eligible || !this.webGPUPresentationEnabled) {
            this.warnCustomPlaybackIneligible(eligibility);
            return this.getCustomPlaybackUnavailableResult(backendGeneration, 'source-unsupported', recoveryAnchorMicroseconds);
        }
        this.alignPresentationBitDepthToRawFrames(eligibility.rawVideoFrameFormat);
        this.customPlaybackSetupTelemetry = {
            stage: 'modules',
            status: 'in-progress'
        };
        this.lastKnownTimeMicroseconds = eligibility.startTimeMicroseconds;

        const audioPrewarm = this.getCustomPlaybackAudioPrewarmForTrack(
            eligibility.audioTrackIndex,
            eligibility.audioOutputMode,
            backendGeneration
        );
        const webGPUUserSettings = loadWebGPUUserSettings();
        const decodedAudioOutputChannelCount = selectDecodedAudioOutputChannelCount(
            eligibility,
            getAudioContextMaximumChannelCount(audioPrewarm?.audioContext ?? null),
            webGPUUserSettings.audio.forceStereoDownmix
        );

        let completedStartResult: CustomPlaybackStartResult | null = null;
        try {
            const [
                controllerModule,
                audioOutputModule,
                nativeAudioBridgeModule,
                userSettingsModule
            ] = await Promise.all([
                import(
                    /* webpackChunkName: "webgpu-custom-playback" */
                    'webgpu-player/pipeline/CustomPlaybackController'
                ),
                import(
                    /* webpackChunkName: "webgpu-custom-playback" */
                    'webgpu-player/audio/output/BrowserCustomAudioOutput'
                ),
                import(
                    /* webpackChunkName: "webgpu-custom-playback" */
                    'webgpu-player/audio/native/CustomDecodeNativeAudioBridge'
                ),
                import(
                    /* webpackChunkName: "webgpu-custom-playback" */
                    './shims/userSettings'
                )
            ]);
            if (!this.isCustomPlaybackSetupCurrent(backendGeneration, setupRevision)) {
                return { status: 'superseded' };
            }

            this.customPlaybackSetupTelemetry = {
                stage: 'surface',
                status: 'in-progress'
            };
            const htmlBackend = this.getHTMLCustomPlaybackBackend();
            const presentationSurface = await htmlBackend.prepareCustomPlayback(options);
            if (!this.isCustomPlaybackSetupCurrent(backendGeneration, setupRevision)) {
                return { status: 'superseded' };
            }
            if (!presentationSurface || presentationSurface === PLAYBACK_SUPERSEDED) {
                return presentationSurface === PLAYBACK_SUPERSEDED ?
                    { status: 'superseded' } :
                    this.getCustomPlaybackUnavailableResult(backendGeneration, 'source-unsupported', recoveryAnchorMicroseconds);
            }

            this.customPlaybackSetupTelemetry = {
                stage: 'presentation',
                status: 'in-progress'
            };
            const presentationGeneration = this.presentationGeneration;
            this.presenter.setDecodedFramePushMode(true, presentationGeneration);
            this.presenter.attach(presentationSurface, presentationGeneration);
            const colorPipelineConfigured = await this.configurePresentationColorPipeline(
                presentationGeneration,
                eligibility.videoOutputMode,
                eligibility.rawVideoFrameFormat,
                eligibility.dolbyVisionProfile
            );
            if (!this.isCustomPlaybackSetupCurrent(backendGeneration, setupRevision)) {
                return { status: 'superseded' };
            }
            if (!colorPipelineConfigured || !this.webGPUPresentationEnabled) {
                return this.getCustomPlaybackUnavailableResult(backendGeneration, 'lifecycle-failed', recoveryAnchorMicroseconds);
            }

            this.customPlaybackSetupTelemetry = {
                stage: 'controller',
                status: 'in-progress'
            };
            // The controller's own startup bound extends while startup progresses
            setupDeadline.release();
            const customPlaybackController = this.createCustomPlaybackController(
                controllerModule,
                audioOutputModule,
                nativeAudioBridgeModule,
                eligibility,
                audioPrewarm,
                backendGeneration
            );
            this.customPlaybackController = customPlaybackController;
            this.customPlaybackAudioSettings = {
                downmix: { ...webGPUUserSettings.audio.downmix },
                forceStereoDownmix: webGPUUserSettings.audio.forceStereoDownmix,
                outputDeviceId: webGPUUserSettings.audio.outputDeviceId
            };
            this.customPlaybackBackendGeneration = backendGeneration;
            this.customPlaybackFrameGeneration = presentationGeneration;
            this.customPlaybackEmitUnpause = true;
            // Playback can start in a hidden tab, such as a queued next item
            this.synchronizeCustomPlaybackPageVisibility();
            this.initializeCustomPlaybackGain(customPlaybackController, options, userSettingsModule.selectAudioNormalization());
            const audioDownmixAlgorithm = selectAudioDownmixAlgorithm(
                eligibility.audioTrackIndex,
                userSettingsModule.webGPUAudioDownmixAlgorithm()
            );
            this.customPlaybackAudioDownmixAlgorithm = audioDownmixAlgorithm ?? null;

            const startResult = await customPlaybackController.play({
                audioDownmixAlgorithm,
                audioDownmixSettings: getDecodedAudioDownmixSettings(eligibility, webGPUUserSettings),
                audioOutputMode: eligibility.audioOutputMode ?? undefined,
                audioTrackIndex: eligibility.audioTrackIndex,
                decodedAudioOutputChannelCount,
                ...getDiscardedEnhancementLayerPlayOption(eligibility),
                durationMicroseconds: eligibility.durationMicroseconds,
                dolbyVisionProfile: eligibility.dolbyVisionProfile,
                maximumCodedHeight: eligibility.maximumCodedHeight,
                maximumCodedWidth: eligibility.maximumCodedWidth,
                nativeHDRTransfer: eligibility.nativeHDRTransfer ?? null,
                neutralizeHDRColorMetadata: eligibility.neutralizeHDRColorMetadata,
                rawVideoFrameFormat: eligibility.rawVideoFrameFormat,
                startTimeMicroseconds: eligibility.startTimeMicroseconds,
                url: eligibility.url,
                videoDecoderBackend: eligibility.videoDecoderBackend,
                videoOutputMode: eligibility.videoOutputMode,
                videoTrackIndex: eligibility.videoTrackIndex
            });
            if (!this.isCustomPlaybackSetupCurrent(backendGeneration, setupRevision)) {
                return { status: 'superseded' };
            }
            this.handleCustomPlaybackStartResult(customPlaybackController, backendGeneration, startResult);
            completedStartResult = startResult;
        } catch (error) {
            if (!this.isCustomPlaybackSetupCurrent(backendGeneration, setupRevision)) {
                return { status: 'superseded' };
            }
            console.warn('Custom playback startup failed; using the HTML backend', error);
            void this.detachCustomPlaybackController();
            return this.getCustomPlaybackUnavailableResult(backendGeneration, 'decode-failed', recoveryAnchorMicroseconds);
        } finally {
            if (this.customPlaybackStartingGeneration === backendGeneration) {
                this.customPlaybackStartingGeneration = null;
            }
        }

        if (!completedStartResult) {
            return this.getCustomPlaybackUnavailableResult(backendGeneration, 'lifecycle-failed', recoveryAnchorMicroseconds);
        }
        return this.resolveCustomPlaybackStartResult(completedStartResult);
    }

    private async resolveCustomPlaybackStartResult(startResult: CustomPlaybackStartResult): Promise<CustomPlaybackAttemptResult> {
        switch (startResult.status) {
            case 'started':
                return { result: undefined, status: 'handled' };
            case 'fallback': {
                const fallbackPromise = this.customPlaybackFallbackPromise;
                if (!fallbackPromise) {
                    return this.getCustomPlaybackUnavailableResult(
                        this.backendSessionGeneration,
                        'lifecycle-failed',
                        this.lastKnownTimeMicroseconds
                    );
                }
                return {
                    result: await fallbackPromise,
                    status: 'handled'
                };
            }
            case 'stopped':
            case 'superseded':
                return { status: 'superseded' };
        }
    }

    /** Logs why custom playback declined a source, which otherwise falls back without an error. */
    private warnCustomPlaybackIneligible(eligibility: CustomPlaybackEligibility | null): void {
        // Mirrors the fallback getCustomPlaybackUnavailableResult selects
        const message: string = this.currentPlaybackRequiresSourceRenegotiation ?
            CUSTOM_PLAYBACK_INELIGIBLE_RENEGOTIATION_MESSAGE :
            CUSTOM_PLAYBACK_INELIGIBLE_HTML_BACKEND_MESSAGE;
        if (!eligibility) {
            console.warn(message, CUSTOM_PLAYBACK_ELIGIBILITY_UNAVAILABLE_REASON);
            return;
        }
        if (!eligibility.eligible) {
            console.warn(message, eligibility.reason);
            return;
        }
        console.warn(message, WEBGPU_PRESENTATION_DISABLED_REASON);
    }

    private getCustomPlaybackUnavailableResult(
        backendGeneration: number,
        reason: CustomPlaybackFallbackRequest['reason'],
        mediaTimeMicroseconds: Microseconds
    ): CustomPlaybackAttemptResult {
        if (!this.currentPlaybackRequiresSourceRenegotiation) {
            return { status: 'native-required' };
        }

        this.lastKnownTimeMicroseconds = mediaTimeMicroseconds;
        this.customPlaybackRecoveryTimeMicroseconds = mediaTimeMicroseconds;
        this.webGPUPresentationEnabled = false;
        this.beginCustomPlaybackAudioPrewarmClose(backendGeneration);
        const invalidatedGeneration = this.advancePresentationGeneration();
        this.presenter.endSession(invalidatedGeneration);
        const accepted = this.emitCustomPlaybackRenegotiationRequired(backendGeneration, reason);
        return {
            result: accepted ? undefined : PLAYBACK_SUPERSEDED,
            status: 'handled'
        };
    }

    /** Renegotiates a source widened before custom decode became unavailable. */
    private renegotiateCustomOnlySourceWhenDisabled(
        customDecodeEnabled: boolean,
        options: unknown,
        backendGeneration: number
    ): CustomPlaybackAttemptResult | null {
        if (customDecodeEnabled || !this.currentPlaybackRequiresSourceRenegotiation) {
            return null;
        }
        return this.getCustomPlaybackUnavailableResult(
            backendGeneration,
            'source-unsupported',
            getPlaybackStartTimeMicroseconds(options)
        );
    }

    /**
     * Returns capabilities covering the played source's probes.
     * The negotiated result serves its own item, so a source whose video it did not probe is probed now.
     * A source without stream metadata cannot scope probes, so it keeps the negotiated result.
     */
    private getCustomDecodeCapabilitiesForOptions(options: unknown): Promise<CustomDecodeCapabilities> {
        const negotiatedCapabilities = this.lastCustomDecodeCapabilities;
        const mediaSource = getPlaybackMediaSourceWithStreams(options);
        if (negotiatedCapabilities
            && (mediaSource === null || hasProbedCustomDecodeSelection(negotiatedCapabilities, mediaSource))) {
            return Promise.resolve(negotiatedCapabilities);
        }
        return probeCustomDecodeCapabilities(mediaSource ?? undefined);
    }

    private async getCustomPlaybackEligibilityForOptions(
        options: unknown,
        backendGeneration: number
    ): Promise<CustomPlaybackEligibility | null> {
        if (!await getWebGPUCustomDecodeEnabled()) {
            return null;
        }
        if (!this.isRequestedSessionCurrent(backendGeneration)) {
            return null;
        }

        const runtimeAvailability = getCustomPlaybackRuntimeAvailability();
        this.lastCustomPlaybackRuntimeAvailability = runtimeAvailability;
        const [ capabilities, nativeMediaAudioCapabilities ] = await Promise.all([
            this.getCustomDecodeCapabilitiesForOptions(options),
            this.lastNativeMediaAudioCapabilities ?? probeCachedNativeMediaAudioCapabilities()
        ]);
        if (!this.isRequestedSessionCurrent(backendGeneration)) {
            return null;
        }

        this.lastCustomDecodeCapabilities = capabilities;
        this.lastNativeMediaAudioCapabilities = nativeMediaAudioCapabilities;
        // Another play method is ineligible whatever is authorized, so it skips the authorization waits
        const presentationOptions = this.isDirectPlayOptions(options) ?
            await this.getCustomPresentationEligibilityOptions(backendGeneration) :
            UNAUTHORIZED_PRESENTATION_ELIGIBILITY_OPTIONS;
        if (!presentationOptions) {
            return null;
        }
        const eligibility = getCustomPlaybackEligibility(options, capabilities, {
            ...presentationOptions,
            nativeMediaAudioCapabilities,
            runtimeAvailability
        });
        this.lastCustomPlaybackEligibility = eligibility;
        return eligibility;
    }

    private async getCustomPresentationEligibilityOptions(
        backendGeneration: number
    ): Promise<CustomPresentationEligibilityOptions | null> {
        await this.presenter.waitForRawSDRAuthorizationPrewarm();
        if (!this.isRequestedSessionCurrent(backendGeneration)) {
            return null;
        }
        const authorizedRawSDRRouteKeys = this.presenter.getAuthorizedRawHDRRouteKeys().filter(isRawSDRRouteKey);
        // A Dolby Vision stream without an RPU route presents its declared base through the same static routes
        const metadata = this.currentPresentationColorMetadata ?? this.currentDolbyVisionBaseColorMetadata;
        const rawHDRRequested = metadata !== null && metadata.transfer !== 'sdr' && (metadata.bitDepth === 10 || metadata.bitDepth === 12);
        const dolbyVisionRequested = this.currentDolbyVisionPresentationDescriptor !== null;
        const reconstructionTarget = getDolbyVisionReconstructionTarget(this.currentPlaybackOptions);
        const profile7HDR10BaseRequested = getDolbyVisionProfile7HDR10BaseColorMetadata(this.currentPlaybackOptions) !== null;
        const profile8HDR10BaseRequested = getDolbyVisionProfile8HDR10BaseColorMetadata(this.currentPlaybackOptions) !== null;
        const profile8HLGBaseRequested = getDolbyVisionProfile8HLGBaseColorMetadata(this.currentPlaybackOptions) !== null;
        const dolbyVisionBaseRequested = profile7HDR10BaseRequested || profile8HDR10BaseRequested || profile8HLGBaseRequested;
        if (!rawHDRRequested && !dolbyVisionRequested) {
            return {
                allowDolbyVision: false,
                allowDolbyVisionProfile7: false,
                allowNativeDolbyVision: false,
                allowNativeHDR: false,
                allowRawHDR: false,
                allowRawSDR: authorizedRawSDRRouteKeys.length > 0,
                authorizedExternalHDRRouteKeys: this.presenter.getAuthorizedExternalHDRRouteKeys(),
                authorizedRawHDRRouteKeys: authorizedRawSDRRouteKeys
            };
        }

        const hdrToneMappingEnabled = await getWebGPUHDRToneMappingEnabled();
        if (!this.isRequestedSessionCurrent(backendGeneration)) {
            return null;
        }
        if (!hdrToneMappingEnabled) {
            return {
                allowDolbyVision: false,
                allowDolbyVisionProfile7: false,
                allowNativeDolbyVision: false,
                allowNativeHDR: false,
                allowRawHDR: false,
                allowRawSDR: authorizedRawSDRRouteKeys.length > 0,
                authorizedExternalHDRRouteKeys: [],
                authorizedRawHDRRouteKeys: authorizedRawSDRRouteKeys
            };
        }
        // A single-layer RPU route is selected before the declared base it shares a raw capability with, so once that route is authorized no raw HDR key can change the selection
        const singleLayerReconstructionAuthorized =
            this.getItemRawDolbyVisionRouteFlags(reconstructionTarget).allowDolbyVision === true;
        await Promise.all([
            this.waitForRawOnlyHDRAuthorization(rawHDRRequested && !singleLayerReconstructionAuthorized),
            this.waitForDolbyVisionReconstructionAuthorization(reconstructionTarget)
        ]);
        if (!this.isRequestedSessionCurrent(backendGeneration)) {
            return null;
        }
        const {
            authorizedExternalHDRRouteKeys,
            authorizedRawHDRRouteKeys
        } = this.prepareCustomPresentationAuthorizations(
            rawHDRRequested,
            dolbyVisionRequested,
            dolbyVisionBaseRequested,
            reconstructionTarget
        );
        return {
            ...this.getItemRawDolbyVisionRouteFlags(reconstructionTarget),
            allowNativeDolbyVision: dolbyVisionRequested && this.presenter.isExternalDolbyVisionPresentationAuthorized(),
            allowNativeDolbyVisionProfile7HDR10Base: profile7HDR10BaseRequested
                && hasAuthorizedDolbyVisionBaseRoute(DOLBY_VISION_HDR10_BASE_COLOR_METADATA, authorizedExternalHDRRouteKeys),
            allowNativeDolbyVisionProfile8HDR10Base: profile8HDR10BaseRequested
                && hasAuthorizedDolbyVisionBaseRoute(DOLBY_VISION_HDR10_BASE_COLOR_METADATA, authorizedExternalHDRRouteKeys),
            allowNativeDolbyVisionProfile8HLGBase: profile8HLGBaseRequested
                && hasAuthorizedDolbyVisionBaseRoute(DOLBY_VISION_HLG_BASE_COLOR_METADATA, authorizedExternalHDRRouteKeys),
            allowNativeHDR: (rawHDRRequested || dolbyVisionBaseRequested) && authorizedExternalHDRRouteKeys.length > 0,
            allowRawHDR: rawHDRRequested && authorizedRawHDRRouteKeys.length > 0,
            allowRawSDR: authorizedRawSDRRouteKeys.length > 0,
            authorizedExternalHDRRouteKeys,
            // A declared 10-bit SDR base presents through the raw SDR keys whatever the HDR request
            authorizedRawHDRRouteKeys: [
                ...authorizedRawSDRRouteKeys,
                ...authorizedRawHDRRouteKeys
            ]
        };
    }

    /** Returns the raw Dolby Vision flags of the current item's own RPU route; no other route's authorization counts. */
    private getItemRawDolbyVisionRouteFlags(reconstructionTarget: DolbyVisionReconstructionTarget | null): RawDolbyVisionRouteFlags {
        const flags: RawDolbyVisionRouteFlags = {
            allowDolbyVision: false,
            allowDolbyVisionProfile4: false,
            allowDolbyVisionProfile7: false
        };
        switch (this.currentDolbyVisionPresentationDescriptor?.reconstructionProfile ?? null) {
            case 4:
                flags.allowDolbyVisionProfile4 = this.presenter.isRawDolbyVisionProfile4PresentationAuthorized(
                    getDualLayerDolbyVisionRawFrameFormat(reconstructionTarget)
                );
                break;
            case 5:
            case 8:
                flags.allowDolbyVision = this.presenter.isRawDolbyVisionPresentationAuthorized(
                    getSingleLayerDolbyVisionRawFrameFormat(reconstructionTarget)
                );
                break;
            case 7:
                flags.allowDolbyVisionProfile7 = this.presenter.isRawDolbyVisionProfile7PresentationAuthorized(
                    getDualLayerDolbyVisionRawFrameFormat(reconstructionTarget)
                );
                break;
            case null:
                break;
        }
        return flags;
    }

    /** Returns the raw Dolby Vision device profile flags once the item's Dolby Vision probes have settled. */
    private getRawDolbyVisionDeviceProfileFlags(
        dolbyVisionAvailable: boolean,
        reconstructionTarget: DolbyVisionReconstructionTarget | null
    ): RawDolbyVisionRouteFlags {
        const dualLayerRawFrameFormat = getDualLayerDolbyVisionRawFrameFormat(reconstructionTarget);
        return {
            allowDolbyVision: dolbyVisionAvailable && this.presenter.isRawDolbyVisionPresentationAuthorized(
                getSingleLayerDolbyVisionRawFrameFormat(reconstructionTarget)
            ),
            allowDolbyVisionProfile4: dolbyVisionAvailable
                && this.presenter.isRawDolbyVisionProfile4PresentationAuthorized(dualLayerRawFrameFormat),
            allowDolbyVisionProfile7: dolbyVisionAvailable
                && this.presenter.isRawDolbyVisionProfile7PresentationAuthorized(dualLayerRawFrameFormat)
        };
    }

    /**
     * AV1, VP9, and HEVC range extensions present HDR only through raw planes, so their raw HDR probes must settle before eligibility whatever the external result.
     */
    private async waitForRawOnlyHDRAuthorization(rawHDRRequested: boolean): Promise<void> {
        if (!rawHDRRequested || !isRawOnlyHDRPresentation(this.currentPlaybackOptions)) {
            return;
        }
        await this.presenter.waitForRawHDRAuthorizationPrewarm();
    }

    /**
     * Waits for the item's RPU route before eligibility.
     * Most keys authorize on first use, and a prewarmed key probes again on a GPU device recreated after negotiation; a settled probe resolves at once.
     */
    private async waitForDolbyVisionReconstructionAuthorization(target: DolbyVisionReconstructionTarget | null): Promise<void> {
        if (!target) {
            return;
        }
        await this.presenter.waitForDolbyVisionAuthorizationPrewarm(target);
    }

    private prepareCustomPresentationAuthorizations(
        rawHDRRequested: boolean,
        dolbyVisionRequested: boolean,
        dolbyVisionBaseRequested: boolean,
        reconstructionTarget: DolbyVisionReconstructionTarget | null
    ): CustomPresentationAuthorizations {
        const externalHDRRequested = rawHDRRequested || dolbyVisionBaseRequested;
        if (externalHDRRequested) {
            void this.presenter.prewarmExternalHDRPresentationAuthorization();
        }
        if (rawHDRRequested) {
            void this.presenter.prewarmRawHDRPresentationAuthorization();
        }
        if (dolbyVisionRequested) {
            void this.presenter.prewarmDolbyVisionPresentationAuthorization(reconstructionTarget);
        }
        return {
            authorizedExternalHDRRouteKeys: externalHDRRequested ? this.presenter.getAuthorizedExternalHDRRouteKeys() : [],
            authorizedRawHDRRouteKeys: rawHDRRequested ?
                this.presenter.getAuthorizedRawHDRRouteKeys().filter(
                    (routeKey: RawHDRAuthorizationRouteKey): boolean => !isRawSDRRouteKey(routeKey)
                ) :
                []
        };
    }

    private initializeCustomPlaybackGain(
        customPlaybackController: CustomPlaybackController,
        playbackOptions: unknown,
        audioNormalizationMode: unknown
    ): void {
        const backendVolume = this.htmlDelegate.player.getVolume();
        if (typeof backendVolume === 'number'
            && Number.isFinite(backendVolume)
            && backendVolume >= MIN_JELLYFIN_VOLUME
            && backendVolume <= MAX_JELLYFIN_VOLUME) {
            this.customPlaybackVolume = backendVolume;
        }
        this.customPlaybackMuted = this.htmlDelegate.player.isMuted();
        this.htmlPlaybackNormalizationGain = null;
        this.customPlaybackNormalizationGain = getAudioNormalizationLinearGain(playbackOptions, audioNormalizationMode);
        customPlaybackController.setNormalizationGain(this.customPlaybackNormalizationGain);
        customPlaybackController.setVolume(this.getLinearVolume(this.customPlaybackVolume));
        customPlaybackController.setMuted(this.customPlaybackMuted);
    }

    private handleCustomPlaybackStartResult(
        customPlaybackController: CustomPlaybackController,
        backendGeneration: number,
        result: CustomPlaybackStartResult
    ): void {
        if (!this.isCustomPlaybackCurrent(customPlaybackController, backendGeneration)) {
            return;
        }
        if (result.status === 'started' && customPlaybackController.playbackState === 'paused') {
            this.scheduleCustomPlaybackFrame(customPlaybackController, false);
        }
    }

    private handleCustomPlaybackEvent(
        customPlaybackController: CustomPlaybackController,
        backendGeneration: number,
        event: CustomPlaybackControllerEvent
    ): void {
        if (!this.isCustomPlaybackCurrent(customPlaybackController, backendGeneration)) {
            return;
        }

        const htmlBackend = this.getHTMLCustomPlaybackBackend();
        switch (event.type) {
            case 'audio-output-changed':
                // A new device can take a different layout, or need the user's downmix
                void this.reconfigureCustomPlaybackAudioOutput();
                break;
            case 'static-hdr-metadata':
                this.applyStaticHDRMetadata(event.metadata);
                break;
            case 'statechange':
                if (event.state === 'paused') {
                    this.cancelCustomPlaybackFrameCallback();
                    const pausedRefresh = this.getCurrentPausedPresentationRefresh(customPlaybackController, backendGeneration);
                    if (!pausedRefresh) {
                        // Preserve the shell's outstanding pause across any seek generation
                        this.customPlaybackEmitUnpause = true;
                        htmlBackend.notifyCustomPlaybackPaused();
                    }
                    this.scheduleCustomPlaybackFrame(customPlaybackController, false);
                } else if (event.state === 'playing') {
                    this.customPlaybackEmitUnpause = this.customPlaybackEmitUnpause
                        || event.previousState === 'paused'
                        || event.previousState === 'starting';
                    // Replace a one-shot paused poll with the continuous playing loop
                    this.cancelCustomPlaybackFrameCallback();
                    this.scheduleCustomPlaybackFrame(customPlaybackController, true);
                }
                break;
            case 'ready':
                if (customPlaybackController.playbackState === 'paused') {
                    this.scheduleCustomPlaybackFrame(customPlaybackController, false);
                }
                break;
            case 'playing':
                this.customPlaybackHasPlayed = true;
                htmlBackend.notifyCustomPlaybackPlaying(this.customPlaybackEmitUnpause);
                this.customPlaybackEmitUnpause = false;
                this.scheduleCustomPlaybackFrame(customPlaybackController, true);
                break;
            case 'timeupdate':
                this.lastKnownTimeMicroseconds = event.currentTimeMicroseconds;
                htmlBackend.notifyCustomPlaybackTimeUpdate(microsecondsToMilliseconds(event.currentTimeMicroseconds));
                break;
            case 'waiting':
                if (!this.getCurrentPausedPresentationRefresh(customPlaybackController, backendGeneration)) {
                    htmlBackend.notifyCustomPlaybackWaiting();
                }
                break;
            case 'ended':
                this.cancelPendingPausedPresentationRefresh();
                this.cancelCustomPlaybackFrameCallback();
                htmlBackend.notifyCustomPlaybackEnded();
                break;
            case 'error':
                console.warn('Custom playback pipeline error', event.message);
                if (!event.recoverable) {
                    this.handleCustomPlaybackTerminalFailure(customPlaybackController, backendGeneration, new Error(event.message));
                }
                break;
            case 'fallback-requested':
                // The fallback hook owns the one-shot native transition
                break;
            case 'telemetry':
                this.lastCustomPlaybackTelemetry = event.telemetry;
                break;
        }
    }

    private scheduleCustomPlaybackFrame(customPlaybackController: CustomPlaybackController, continueWhilePlaying: boolean): void {
        if (this.customPlaybackFrameCallback !== null
            || !this.isCustomPlaybackCurrent(customPlaybackController, this.backendSessionGeneration)) {
            return;
        }

        const generation = this.customPlaybackFrameGeneration;
        if (generation === null || typeof globalThis.requestAnimationFrame !== 'function') {
            this.requestCustomPlaybackFallbackForError(
                customPlaybackController,
                this.backendSessionGeneration,
                new Error('requestAnimationFrame is unavailable')
            );
            return;
        }

        const backendGeneration = this.backendSessionGeneration;
        this.customPlaybackFrameCallback = globalThis.requestAnimationFrame(
            (): void => this.handleCustomPlaybackAnimationFrame(
                customPlaybackController,
                backendGeneration,
                generation,
                continueWhilePlaying
            )
        );
    }

    private handleCustomPlaybackAnimationFrame(
        customPlaybackController: CustomPlaybackController,
        backendGeneration: number,
        presentationGeneration: number,
        continueWhilePlaying: boolean
    ): void {
        this.customPlaybackFrameCallback = null;
        if (!this.isCustomPlaybackCurrent(customPlaybackController, backendGeneration)
            || this.customPlaybackFrameGeneration !== presentationGeneration) {
            return;
        }

        const decodedFrame = customPlaybackController.takeCurrentFrame();
        const presentationState = decodedFrame ?
            this.presentCustomPlaybackFrame(customPlaybackController, backendGeneration, presentationGeneration, decodedFrame) :
            'no-frame';
        if (presentationState === 'failed') {
            return;
        }

        if (continueWhilePlaying && customPlaybackController.playbackState === 'playing') {
            this.scheduleCustomPlaybackFrame(customPlaybackController, true);
            return;
        }
        if ((presentationState === 'no-frame' || presentationState === 'temporarily-busy')
            && customPlaybackController.playbackState === 'paused') {
            // A paused seek still needs to wait for and display its first frame
            this.scheduleCustomPlaybackFrame(customPlaybackController, false);
        }
    }

    private presentCustomPlaybackFrame(
        customPlaybackController: CustomPlaybackController,
        backendGeneration: number,
        presentationGeneration: number,
        decodedFrame: DecodedPresentationFrame
    ): 'failed' | 'presented' | 'temporarily-busy' {
        // A VideoFrame and a frame the decode worker draws are released only once their GPU work ended
        const releasedAfterGPUWork = decodedFrame.outputMode === 'video-frame' || decodedFrame.outputMode === 'worker-frame';
        const videoFrameSubmissionCompleted = releasedAfterGPUWork ?
            (gpuWorkCompleted: boolean): void => {
                this.handleDecodedVideoFrameSubmissionCompleted(
                    customPlaybackController,
                    backendGeneration,
                    presentationGeneration,
                    decodedFrame,
                    gpuWorkCompleted
                );
            } :
            undefined;
        const frameSubmitted = this.presenter.presentDecodedFrame(decodedFrame, presentationGeneration, videoFrameSubmissionCompleted);
        if (!frameSubmitted) {
            const frameDiscarded = customPlaybackController.notifyFrameDiscarded(decodedFrame);
            if (frameDiscarded && this.presenter.getTelemetry().state === 'initializing') {
                return 'temporarily-busy';
            }
            this.requestCustomPlaybackFallbackForError(
                customPlaybackController,
                backendGeneration,
                new Error('Decoded frame did not reach WebGPU submission')
            );
            return 'failed';
        }
        if (decodedFrame.outputMode === 'raw-planes' && !customPlaybackController.notifyFramePresented(decodedFrame)) {
            this.requestCustomPlaybackFallbackForError(
                customPlaybackController,
                backendGeneration,
                new Error('Decoded frame did not reach WebGPU submission')
            );
            return 'failed';
        }
        return 'presented';
    }

    private handleDecodedVideoFrameSubmissionCompleted(
        customPlaybackController: CustomPlaybackController,
        backendGeneration: number,
        presentationGeneration: number,
        decodedFrame: DecodedPresentationFrame,
        gpuWorkCompleted: boolean
    ): void {
        let frameAcknowledged = false;
        try {
            frameAcknowledged = gpuWorkCompleted ?
                customPlaybackController.notifyFramePresented(decodedFrame) :
                customPlaybackController.notifyFrameDiscarded(decodedFrame);
        } catch {
            frameAcknowledged = false;
        }
        if (
            frameAcknowledged
            || !this.isCustomPlaybackCurrent(customPlaybackController, backendGeneration)
            || this.customPlaybackFrameGeneration !== presentationGeneration
        ) {
            return;
        }

        this.requestCustomPlaybackFallbackForError(
            customPlaybackController,
            backendGeneration,
            new Error('Decoded frame GPU release could not be acknowledged')
        );
    }

    private cancelCustomPlaybackFrameCallback(): void {
        const callback = this.customPlaybackFrameCallback;
        this.customPlaybackFrameCallback = null;
        if (callback !== null && typeof globalThis.cancelAnimationFrame === 'function') {
            globalThis.cancelAnimationFrame(callback);
        }
    }

    private readonly handleDocumentVisibilityChange = (): void => {
        this.synchronizeCustomPlaybackPageVisibility();
    };

    /**
     * Hidden pages get no animation frames, so a timer drains decoded video instead.
     * A returning page restarts the presentation loop for any video resync.
     */
    private synchronizeCustomPlaybackPageVisibility(): void {
        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (!customPlaybackController) {
            this.stopCustomPlaybackBackgroundDrain();
            return;
        }

        const pageVisible = isDocumentVisible();
        const videoResyncRequested = customPlaybackController.setPageVisibility(pageVisible);
        if (!pageVisible) {
            this.startCustomPlaybackBackgroundDrain(customPlaybackController);
            return;
        }

        this.stopCustomPlaybackBackgroundDrain();
        switch (customPlaybackController.playbackState) {
            case 'playing':
                this.scheduleCustomPlaybackFrame(customPlaybackController, true);
                break;
            case 'paused':
                // A paused resync needs the one-shot poll to display its first frame
                if (videoResyncRequested) {
                    this.scheduleCustomPlaybackFrame(customPlaybackController, false);
                }
                break;
            default:
                break;
        }
    }

    private startCustomPlaybackBackgroundDrain(customPlaybackController: CustomPlaybackController): void {
        if (this.customPlaybackBackgroundDrainTimer !== null) {
            return;
        }

        const backendGeneration = this.backendSessionGeneration;
        this.customPlaybackBackgroundDrainTimer = globalThis.setInterval((): void => {
            if (!this.isCustomPlaybackCurrent(customPlaybackController, backendGeneration)) {
                this.stopCustomPlaybackBackgroundDrain();
                return;
            }
            try {
                customPlaybackController.drainBackgroundVideo();
            } catch (error) {
                this.stopCustomPlaybackBackgroundDrain();
                this.requestCustomPlaybackFallbackForError(customPlaybackController, backendGeneration, error);
            }
        }, CUSTOM_PLAYBACK_BACKGROUND_DRAIN_INTERVAL_MILLISECONDS);
    }

    private stopCustomPlaybackBackgroundDrain(): void {
        const timer = this.customPlaybackBackgroundDrainTimer;
        this.customPlaybackBackgroundDrainTimer = null;
        if (timer !== null) {
            globalThis.clearInterval(timer);
        }
    }

    private readonly handleDecodedPresentationRefresh = (generation: number): void => {
        if (
            generation !== this.presentationGeneration
            || !this.isPresentationSessionCurrent(generation)
            || this.pendingPausedPresentationRefresh !== null
        ) {
            return;
        }

        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (!customPlaybackController || customPlaybackController.playbackState !== 'paused') {
            return;
        }

        const backendGeneration = this.backendSessionGeneration;
        const mediaTimeMicroseconds = customPlaybackController.currentTimeMicroseconds;
        const presentationGeneration = this.advancePresentationGeneration();
        const refresh: PendingPausedPresentationRefresh = {
            backendGeneration,
            controller: customPlaybackController,
            mediaTimeMicroseconds,
            presentationGeneration
        };
        this.pendingPausedPresentationRefresh = refresh;
        this.customPlaybackFrameGeneration = presentationGeneration;
        this.cancelCustomPlaybackFrameCallback();
        this.presenter.seek(presentationGeneration);
        this.presenter.setDecodedFramePushMode(true, presentationGeneration);
        void this.refreshPausedDecodedPresentation(refresh);
    };

    private async refreshPausedDecodedPresentation(refresh: PendingPausedPresentationRefresh): Promise<void> {
        try {
            if (!this.isPendingPausedPresentationRefreshCurrent(refresh)) {
                return;
            }

            // The decoder owns transferred frames, so a paused invalidation re-decodes exactly one generation instead of retaining a full-resolution CPU copy
            const result = await refresh.controller.seek(refresh.mediaTimeMicroseconds);
            if (!this.isPendingPausedPresentationRefreshCurrent(refresh)) {
                return;
            }

            this.pendingPausedPresentationRefresh = null;
            this.handleCustomPlaybackStartResult(refresh.controller, refresh.backendGeneration, result);
        } catch (error) {
            if (!this.isPendingPausedPresentationRefreshCurrent(refresh)) {
                return;
            }

            this.pendingPausedPresentationRefresh = null;
            this.requestCustomPlaybackFallbackForError(refresh.controller, refresh.backendGeneration, error);
        }
    }

    private isPendingPausedPresentationRefreshCurrent(refresh: PendingPausedPresentationRefresh): boolean {
        return this.pendingPausedPresentationRefresh === refresh
            && this.presentationGeneration === refresh.presentationGeneration
            && this.customPlaybackFrameGeneration === refresh.presentationGeneration
            && this.isCustomPlaybackCurrent(refresh.controller, refresh.backendGeneration);
    }

    private getCurrentPausedPresentationRefresh(
        customPlaybackController: CustomPlaybackController,
        backendGeneration: number
    ): PendingPausedPresentationRefresh | null {
        const refresh = this.pendingPausedPresentationRefresh;
        if (!refresh
            || refresh.controller !== customPlaybackController
            || refresh.backendGeneration !== backendGeneration
            || !this.isPendingPausedPresentationRefreshCurrent(refresh)) {
            return null;
        }

        return refresh;
    }

    private cancelPendingPausedPresentationRefresh(): void {
        this.pendingPausedPresentationRefresh = null;
    }

    private requestCustomPlaybackFallbackForError(
        customPlaybackController: CustomPlaybackController,
        backendGeneration: number,
        error: unknown
    ): void {
        const request: CustomPlaybackFallbackRequest = {
            disposition: 'same-session-native',
            generation: 0,
            mediaTimeMicroseconds: customPlaybackController.currentTimeMicroseconds,
            preserveHTMLSession: true,
            reason: 'lifecycle-failed'
        };
        console.warn('Custom playback control failed; using the HTML backend', error);
        void this.requestCustomPlaybackFallback(
            customPlaybackController,
            backendGeneration,
            request
        ).catch((fallbackError: unknown): void => {
            this.emitCustomPlaybackTerminalError(backendGeneration, fallbackError);
        });
    }

    private requestCustomPlaybackFallback(
        customPlaybackController: CustomPlaybackController,
        backendGeneration: number,
        request: CustomPlaybackFallbackRequest
    ): Promise<unknown> {
        if (this.customPlaybackFallbackPromise) {
            return this.customPlaybackFallbackPromise;
        }
        if (!this.isCustomPlaybackCurrent(customPlaybackController, backendGeneration)) {
            return Promise.resolve(PLAYBACK_SUPERSEDED);
        }

        const fallbackOperation = this.runCustomPlaybackFallback(customPlaybackController, backendGeneration, request);
        const fallbackPromise = fallbackOperation.finally((): void => {
            if (this.customPlaybackFallbackPromise === fallbackPromise) {
                this.customPlaybackFallbackPromise = null;
            }
        });
        this.customPlaybackFallbackPromise = fallbackPromise;
        void fallbackPromise.catch((error: unknown): void => {
            if (this.backendPlayPendingGeneration !== backendGeneration) {
                this.emitCustomPlaybackTerminalError(backendGeneration, error);
            }
        });
        return fallbackPromise;
    }

    private async runCustomPlaybackFallback(
        customPlaybackController: CustomPlaybackController,
        backendGeneration: number,
        request: CustomPlaybackFallbackRequest
    ): Promise<unknown> {
        this.customPlaybackRecoveryTimeMicroseconds = request.mediaTimeMicroseconds;
        this.lastKnownTimeMicroseconds = request.mediaTimeMicroseconds;
        this.captureCustomPlaybackTelemetry(customPlaybackController);
        this.clearCustomPlaybackController(customPlaybackController);
        this.webGPUPresentationEnabled = false;
        const invalidatedGeneration = this.advancePresentationGeneration();
        this.presenter.endSession(invalidatedGeneration);
        const audioPrewarmClose = this.closeCustomPlaybackAudioPrewarm(backendGeneration);
        await customPlaybackController.destroy();
        await audioPrewarmClose;
        if (!this.isRequestedSessionCurrent(backendGeneration)) {
            return PLAYBACK_SUPERSEDED;
        }
        const recoveryTimeMicroseconds = this.customPlaybackRecoveryTimeMicroseconds ?? request.mediaTimeMicroseconds;
        this.lastKnownTimeMicroseconds = recoveryTimeMicroseconds;

        if (request.disposition === 'renegotiate-source' || this.currentPlaybackRequiresSourceRenegotiation) {
            const accepted = this.emitCustomPlaybackRenegotiationRequired(backendGeneration, request.reason);
            return accepted ? undefined : PLAYBACK_SUPERSEDED;
        }

        this.htmlPlaybackNormalizationGain = this.customPlaybackNormalizationGain;
        this.applyHTMLPlaybackVolume();
        const nativeOptions = this.createNativeFallbackOptions(recoveryTimeMicroseconds);
        this.currentPlaybackOptions = nativeOptions;
        try {
            const result = await this.htmlDelegate.player.play(nativeOptions);
            if (!this.isRequestedSessionCurrent(backendGeneration)) {
                return PLAYBACK_SUPERSEDED;
            }
            const latestRecoveryTimeMicroseconds = this.customPlaybackRecoveryTimeMicroseconds ?? recoveryTimeMicroseconds;
            if (latestRecoveryTimeMicroseconds !== recoveryTimeMicroseconds) {
                this.htmlDelegate.player.currentTime(microsecondsToMilliseconds(latestRecoveryTimeMicroseconds));
            }
            this.lastKnownTimeMicroseconds = latestRecoveryTimeMicroseconds;
            this.customPlaybackRecoveryTimeMicroseconds = null;
            return result;
        } catch (error) {
            if (this.isRequestedSessionCurrent(backendGeneration)) {
                this.customPlaybackRecoveryTimeMicroseconds = null;
                this.resetHTMLPlaybackNormalization();
            }
            await this.stopFailedNativeFallback(backendGeneration);
            throw error;
        }
    }

    /** Stops a partially started HTML fallback before exposing its terminal error. */
    private async stopFailedNativeFallback(backendGeneration: number): Promise<void> {
        this.htmlDelegate.endSession(backendGeneration);
        try {
            await this.callBackendStop(backendGeneration, false);
        } catch (error) {
            console.warn('Unable to stop failed native fallback cleanly', error);
            this.htmlDelegate.destroy(backendGeneration);
        } finally {
            if (this.ownedBackendSessionGeneration === backendGeneration) {
                this.ownedBackendSessionGeneration = null;
            }
        }
    }

    private createNativeFallbackOptions(mediaTimeMicroseconds: Microseconds): PlaybackOptionsRecord {
        if (!this.currentPlaybackOptions || typeof this.currentPlaybackOptions !== 'object') {
            throw new TypeError('Custom playback fallback options are unavailable');
        }

        return {
            ...(this.currentPlaybackOptions as PlaybackOptionsRecord),
            playerStartPositionTicks: microsecondsToJellyfinTicks(mediaTimeMicroseconds),
            suppressInitialUnpause: this.customPlaybackHasPlayed
        };
    }

    private updateCustomPlaybackAudioSelection(audioStreamIndex: number): void {
        if (!Number.isSafeInteger(audioStreamIndex) || audioStreamIndex < 0) {
            throw new RangeError('Audio stream index must be a non-negative safe integer');
        }
        if (!this.currentPlaybackOptions || typeof this.currentPlaybackOptions !== 'object') {
            return;
        }

        const playbackOptions = this.currentPlaybackOptions as PlaybackOptionsRecord;
        const mediaSource = playbackOptions.mediaSource;
        this.currentPlaybackOptions = {
            ...playbackOptions,
            audioStreamIndex,
            mediaSource: mediaSource && typeof mediaSource === 'object' ? {
                ...(mediaSource as PlaybackOptionsRecord),
                DefaultAudioStreamIndex: audioStreamIndex
            } : mediaSource
        };
        this.currentPlaybackRequiresSourceRenegotiation =
            this.customProfileAugmentationAvailable
            && this.isNonTranscodedSourceOptions(this.currentPlaybackOptions)
            && !this.isCurrentSourceNativeCompatible(this.currentPlaybackOptions);
    }

    private async restartCustomPlaybackForSelectedAudio(
        customPlaybackController: CustomPlaybackController,
        backendGeneration: number,
        selectionRevision: number
    ): Promise<void> {
        const eligibility = await this.getCustomPlaybackEligibilityForOptions(this.currentPlaybackOptions, backendGeneration);
        if (!this.isCustomPlaybackAudioSelectionCurrent(customPlaybackController, backendGeneration, selectionRevision)) {
            return;
        }
        if (!eligibility?.eligible || eligibility.audioTrackIndex === null) {
            await this.requestCustomPlaybackFallback(
                customPlaybackController,
                backendGeneration,
                {
                    disposition: 'renegotiate-source',
                    generation: 0,
                    mediaTimeMicroseconds: customPlaybackController.currentTimeMicroseconds,
                    preserveHTMLSession: true,
                    reason: 'source-unsupported'
                }
            );
            return;
        }

        const audioSettings = this.customPlaybackAudioSettings;
        if (!audioSettings) {
            throw new Error('Custom playback audio settings snapshot is unavailable');
        }
        const audioOutputMode = eligibility.audioOutputMode ?? 'decoded-pcm';
        // The live output knows its current device; the prewarm only knew the startup one
        const maximumChannelCount = customPlaybackController.getAudioOutputMaximumChannelCount()
            ?? getAudioContextMaximumChannelCount(this.getCustomPlaybackAudioPrewarm(backendGeneration)?.audioContext ?? null);
        const result = await customPlaybackController.setAudioStreamIndex(
            eligibility.audioTrackIndex,
            audioOutputMode,
            selectDecodedAudioOutputChannelCount(eligibility, maximumChannelCount, audioSettings.forceStereoDownmix),
            audioOutputMode === 'decoded-pcm' ? audioSettings.downmix : undefined
        );
        if (!this.isCustomPlaybackAudioSelectionCurrent(customPlaybackController, backendGeneration, selectionRevision)) {
            return;
        }
        this.handleCustomPlaybackStartResult(customPlaybackController, backendGeneration, result);
    }

    private detachCustomPlaybackController(): Promise<void> | null {
        const customPlaybackController = this.customPlaybackController;
        if (!customPlaybackController) {
            this.customPlaybackAudioDownmixAlgorithm = null;
            this.customPlaybackAudioSettings = null;
            const fallbackPromise = this.customPlaybackFallbackPromise;
            if (fallbackPromise) {
                return fallbackPromise.then(() => undefined, () => undefined);
            }
            return this.customPlaybackStopPromise;
        }

        this.captureCustomPlaybackTelemetry(customPlaybackController);
        this.clearCustomPlaybackController(customPlaybackController);
        const stopPromise = customPlaybackController.destroy().catch((error: unknown): void => {
            console.warn('Unable to destroy custom playback cleanly', error);
        }).finally((): void => {
            if (this.customPlaybackStopPromise === stopPromise) {
                this.customPlaybackStopPromise = null;
            }
        });
        this.customPlaybackStopPromise = stopPromise;
        return stopPromise;
    }

    private captureCustomPlaybackTelemetry(customPlaybackController: CustomPlaybackController): void {
        this.lastCustomPlaybackTelemetry = customPlaybackController.getTelemetry();
    }

    private clearCustomPlaybackController(customPlaybackController: CustomPlaybackController): void {
        if (this.customPlaybackController !== customPlaybackController) {
            return;
        }

        this.cancelPendingPausedPresentationRefresh();
        this.cancelCustomPlaybackFrameCallback();
        this.stopCustomPlaybackBackgroundDrain();
        this.customPlaybackController = null;
        this.customPlaybackAudioDownmixAlgorithm = null;
        this.customPlaybackAudioSettings = null;
        this.customPlaybackAudioSelectionRevision += 1;
        this.customPlaybackSeekRevision += 1;
        this.customPlaybackBackendGeneration = null;
        this.customPlaybackFrameGeneration = null;
        this.customPlaybackEmitUnpause = false;
    }

    private isCustomPlaybackCurrent(customPlaybackController: CustomPlaybackController, backendGeneration: number): boolean {
        return this.customPlaybackController === customPlaybackController
            && this.customPlaybackBackendGeneration === backendGeneration
            && this.isRequestedSessionCurrent(backendGeneration);
    }

    private isCustomPlaybackAudioSelectionCurrent(
        customPlaybackController: CustomPlaybackController,
        backendGeneration: number,
        selectionRevision: number
    ): boolean {
        return this.customPlaybackAudioSelectionRevision === selectionRevision
            && this.isCustomPlaybackCurrent(customPlaybackController, backendGeneration);
    }

    private getActiveCustomPlaybackController(): CustomPlaybackController | null {
        const customPlaybackController = this.customPlaybackController;
        if (!customPlaybackController || !this.isCustomPlaybackCurrent(customPlaybackController, this.backendSessionGeneration)) {
            return null;
        }
        return customPlaybackController;
    }

    private isCustomPlaybackPathActive(): boolean {
        return this.customPlaybackStartingGeneration !== null
            || this.getActiveCustomPlaybackController() !== null
            || this.customPlaybackFallbackPromise !== null;
    }

    private hasAuthoritativeHTMLPlaybackSurface(): boolean {
        return this.backendSessionActive
            && this.backendPlayPendingGeneration === null
            && !this.webGPUPresentationEnabled
            && !this.isCustomPlaybackPathActive();
    }

    private getHTMLCustomPlaybackBackend(): HTMLCustomPlaybackContract {
        return this.htmlDelegate.player as unknown as HTMLCustomPlaybackContract;
    }

    private requireJellyfinVolume(value: unknown): number {
        const numericValue = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
        if (typeof numericValue !== 'number'
            || !Number.isFinite(numericValue)
            || numericValue < MIN_JELLYFIN_VOLUME
            || numericValue > MAX_JELLYFIN_VOLUME) {
            throw new RangeError('Playback volume must be between zero and one hundred');
        }
        return numericValue;
    }

    private getLinearVolume(value: number): number {
        return (value / MAX_JELLYFIN_VOLUME) ** JELLYFIN_VOLUME_CURVE_EXPONENT;
    }

    private getHTMLPlaybackVolume(value: number): number {
        if (this.htmlPlaybackNormalizationGain === null) {
            return value;
        }
        const normalizedLinearVolume = Math.min(this.getLinearVolume(value) * this.htmlPlaybackNormalizationGain, 1);
        return MAX_JELLYFIN_VOLUME * normalizedLinearVolume ** (1 / JELLYFIN_VOLUME_CURVE_EXPONENT);
    }

    private applyHTMLPlaybackVolume(): void {
        this.htmlDelegate.player.setVolume(this.getHTMLPlaybackVolume(this.customPlaybackVolume));
    }

    private resetHTMLPlaybackNormalization(): void {
        if (this.htmlPlaybackNormalizationGain === null) {
            return;
        }
        this.htmlPlaybackNormalizationGain = null;
        this.htmlDelegate.player.setVolume(this.customPlaybackVolume);
    }

    private emitCustomPlaybackTerminalError(backendGeneration: number, error: unknown): void {
        if (
            !this.isRequestedSessionCurrent(backendGeneration)
            || this.backendPlayPendingGeneration === backendGeneration
            || this.customPlaybackTerminalErrorGeneration === backendGeneration
        ) {
            return;
        }

        this.customPlaybackTerminalErrorGeneration = backendGeneration;
        console.warn('WebGPU playback fallback failed', error);
        Events.trigger(this, PlayerEvent.Error, [{ type: MediaError.PLAYER_ERROR }]);
    }

    private handleCustomPlaybackTerminalFailure(
        customPlaybackController: CustomPlaybackController,
        backendGeneration: number,
        error: unknown
    ): void {
        if (!this.isCustomPlaybackCurrent(customPlaybackController, backendGeneration)) {
            return;
        }

        this.webGPUPresentationEnabled = false;
        const invalidatedGeneration = this.advancePresentationGeneration();
        this.presenter.endSession(invalidatedGeneration);
        const customPlaybackStop = this.detachCustomPlaybackController();
        const audioPrewarmClose = this.closeCustomPlaybackAudioPrewarm(backendGeneration);
        void Promise.all([
            customPlaybackStop ?? Promise.resolve(),
            audioPrewarmClose ?? Promise.resolve()
        ]).then((): void => {
            this.emitCustomPlaybackTerminalError(backendGeneration, error);
        });
    }

    /**
     * Requests one transcode retry.
     * Returns true when the current play() continues as a start: the host accepted the request, or its error is deferred until play() resolves.
     */
    private emitCustomPlaybackRenegotiationRequired(
        backendGeneration: number,
        reason: CustomPlaybackFallbackRequest['reason']
    ): boolean {
        if (!this.isRequestedSessionCurrent(backendGeneration) || this.customPlaybackTerminalErrorGeneration === backendGeneration) {
            return false;
        }

        const mediaError = reason === 'network-failed' ? MediaError.NETWORK_ERROR : MediaError.MEDIA_NOT_SUPPORTED;
        let accepting = true;
        let accepted = false;
        const request: SourceRenegotiationRequest = {
            accept: (): void => {
                if (accepting) {
                    accepted = true;
                }
            },
            errorType: mediaError,
            reason
        };

        Events.trigger(this, WebGPUPlayerEvent.SourceRenegotiationRequired, [request]);
        accepting = false;
        this.customPlaybackTerminalErrorGeneration = backendGeneration;
        if (accepted) {
            return true;
        }

        // Older controllers, including the stock PlaybackManager, use the generic error contract for source retries
        if (this.backendPlayPendingGeneration === backendGeneration) {
            // NOTE: The stock retry ladder needs a recorded start, so play() resolves first and the error follows it
            this.deferredRenegotiationError = { generation: backendGeneration, mediaError };
            return true;
        }
        Events.trigger(this, PlayerEvent.Error, [{ type: mediaError }]);
        return false;
    }

    /** Emits a renegotiation error deferred during play() once its resolution has reached the host. */
    private scheduleDeferredRenegotiationError(generation: number): void {
        const deferredError = this.deferredRenegotiationError;
        if (!deferredError || deferredError.generation !== generation) {
            return;
        }

        // A macrotask runs after every promise reaction, including PlaybackManager's start bookkeeping
        globalThis.setTimeout((): void => {
            if (this.deferredRenegotiationError !== deferredError) {
                return;
            }
            this.deferredRenegotiationError = null;
            if (!this.isRequestedSessionCurrent(generation)) {
                return;
            }
            Events.trigger(this, PlayerEvent.Error, [{ type: deferredError.mediaError }]);
        }, DEFERRED_RENEGOTIATION_ERROR_DELAY_MILLISECONDS);
    }

    private readonly handlePresentationFallback = (generation: number, reason: PresentationFallbackReason): void => {
        if (generation !== this.presentationGeneration) {
            return;
        }

        const customPlaybackController = this.getActiveCustomPlaybackController();
        this.webGPUPresentationEnabled = false;
        this.cancelPendingPausedPresentationRefresh();
        this.advancePresentationGeneration();
        if (customPlaybackController) {
            const request: CustomPlaybackFallbackRequest = {
                disposition: 'same-session-native',
                generation: 0,
                mediaTimeMicroseconds: customPlaybackController.currentTimeMicroseconds,
                preserveHTMLSession: true,
                reason: 'lifecycle-failed'
            };
            console.warn(`Custom playback presentation failed: ${reason}`);
            void this.requestCustomPlaybackFallback(customPlaybackController, this.backendSessionGeneration, request);
        }
    };

    private readonly handleBackendStopped = (generation: number): void => {
        const audioPrewarmClose = this.closeCustomPlaybackAudioPrewarm(generation);
        if (audioPrewarmClose) {
            void audioPrewarmClose;
        }
        if (this.ownedBackendSessionGeneration === generation) {
            this.ownedBackendSessionGeneration = null;
        }

        if (!this.backendSessionActive || this.backendSessionGeneration !== generation) {
            return;
        }

        void this.detachCustomPlaybackController();
        this.backendSessionActive = false;
        this.webGPUPresentationEnabled = false;
        this.currentPlaybackOptions = null;
        this.currentDolbyVisionPresentationDescriptor = null;
        this.currentPresentationColorMetadata = null;
        this.currentDolbyVisionBaseColorMetadata = null;
        const invalidatedGeneration = this.advancePresentationGeneration();
        this.presenter.endSession(invalidatedGeneration);
    };

    private readonly handleBackendError = (generation: number): void => {
        const audioPrewarmClose = this.closeCustomPlaybackAudioPrewarm(generation);
        if (audioPrewarmClose) {
            void audioPrewarmClose;
        }
        if (!this.backendSessionActive || this.backendSessionGeneration !== generation) {
            return;
        }

        void this.detachCustomPlaybackController();
        this.backendSessionActive = false;
        this.webGPUPresentationEnabled = false;
        this.currentPlaybackOptions = null;
        this.currentDolbyVisionPresentationDescriptor = null;
        this.currentPresentationColorMetadata = null;
        this.currentDolbyVisionBaseColorMetadata = null;
        const invalidatedGeneration = this.advancePresentationGeneration();
        this.presenter.endSession(invalidatedGeneration);
    };

    private async stopOwnedBackendForReplacement(nextGeneration: number): Promise<void> {
        const ownedGeneration = this.ownedBackendSessionGeneration;
        if (ownedGeneration == null || ownedGeneration === nextGeneration) {
            return;
        }

        this.htmlDelegate.endSession(ownedGeneration);
        try {
            await this.callBackendStop(ownedGeneration, false);
        } catch (error) {
            console.warn('Reusable HTML player stop failed; destroying it before replacement', error);
            this.htmlDelegate.destroy(ownedGeneration);
        } finally {
            if (this.ownedBackendSessionGeneration === ownedGeneration) {
                this.ownedBackendSessionGeneration = null;
            }
        }
    }

    private callBackendStop(generation: number, destroyPlayer: boolean): Promise<unknown> {
        this.beginBackendStopCall();
        try {
            return this.htmlDelegate.stop(generation, destroyPlayer);
        } finally {
            this.endBackendStopCall();
        }
    }

    private beginBackendStopCall(): void {
        if (this.backendStopCallDepth === 0) {
            let releaseBackendStopCall: () => void = () => undefined;
            this.backendStopCallBarrier = new Promise<void>(resolve => {
                releaseBackendStopCall = resolve;
            });
            this.releaseBackendStopCall = releaseBackendStopCall;
        }

        this.backendStopCallDepth += 1;
    }

    private endBackendStopCall(): void {
        this.backendStopCallDepth -= 1;
        if (this.backendStopCallDepth > 0) {
            return;
        }

        const releaseBackendStopCall = this.releaseBackendStopCall;
        this.backendStopCallBarrier = null;
        this.releaseBackendStopCall = null;
        releaseBackendStopCall?.();
    }

    private enqueueBackendOperation<Result>(operation: () => PromiseLike<Result> | Result): Promise<Result> {
        const previousTail = this.backendOperationTail;
        let releaseOperation: () => void = () => undefined;
        const operationTail = new Promise<void>(resolve => {
            releaseOperation = resolve;
        });
        this.backendOperationTail = operationTail;

        let operationPromise: Promise<Result>;
        if (previousTail) {
            operationPromise = previousTail.then(operation);
        } else {
            try {
                operationPromise = Promise.resolve(operation());
            } catch (error) {
                operationPromise = Promise.reject(error);
            }
        }

        const finishOperation = (): void => {
            releaseOperation();
            if (this.backendOperationTail === operationTail) {
                this.backendOperationTail = null;
            }
        };
        void operationPromise.then(finishOperation, finishOperation);
        return operationPromise;
    }

    private trackBackendStop(stopPromise: Promise<unknown>): void {
        this.pendingBackendStopPromises.add(stopPromise);
        const removeStopPromise = (): void => {
            this.pendingBackendStopPromises.delete(stopPromise);
        };
        void stopPromise.then(removeStopPromise, removeStopPromise);
    }

    private async waitForPendingBackendStops(): Promise<void> {
        const pendingStopPromises = Array.from(this.pendingBackendStopPromises);
        if (pendingStopPromises.length === 0) {
            return;
        }

        await Promise.allSettled(pendingStopPromises);
    }

    private incrementPendingStopCount(generation: number): void {
        const pendingStopCount = this.pendingStopCounts.get(generation) ?? 0;
        this.pendingStopCounts.set(generation, pendingStopCount + 1);
    }

    private decrementPendingStopCount(generation: number): void {
        const pendingStopCount = this.pendingStopCounts.get(generation) ?? 0;
        if (pendingStopCount <= 1) {
            this.pendingStopCounts.delete(generation);
            return;
        }

        this.pendingStopCounts.set(generation, pendingStopCount - 1);
    }

    private isRequestedSessionCurrent(generation: number): boolean {
        return this.backendSessionActive && this.backendSessionGeneration === generation;
    }

    private isCustomPlaybackSetupCurrent(backendGeneration: number, setupRevision: number): boolean {
        return this.customPlaybackSetupRevision === setupRevision && this.isRequestedSessionCurrent(backendGeneration);
    }

    private rememberNativeDeviceProfile(item: unknown, profile: DeviceProfile): void {
        const itemKey = getItemKey(item);
        if (!itemKey) {
            this.pendingNativeDeviceProfileProof = null;
            return;
        }
        const proof: NativeDeviceProfileProof = {
            generation: null,
            itemKey,
            profile
        };
        this.pendingNativeDeviceProfileProof = proof;
        if (this.currentNativeDeviceProfileProof?.itemKey === itemKey) {
            this.currentNativeDeviceProfileProof = {
                ...proof,
                generation: this.backendSessionGeneration
            };
        }
    }

    private consumeNativeDeviceProfileProof(options: unknown, generation: number): NativeDeviceProfileProof | null {
        const pendingProof = this.pendingNativeDeviceProfileProof;
        this.pendingNativeDeviceProfileProof = null;
        if (!pendingProof || pendingProof.itemKey !== getPlaybackItemKey(options)) {
            return null;
        }
        return {
            ...pendingProof,
            generation
        };
    }

    private isCurrentSourceNativeCompatible(options: unknown): boolean {
        const proof = this.currentNativeDeviceProfileProof;
        return proof !== null
            && proof.generation === this.backendSessionGeneration
            && proof.itemKey === getPlaybackItemKey(options)
            && isSameSessionNativePlaybackCompatible(options, proof.profile);
    }

    private isDeviceProfileRetry(options: unknown): boolean {
        return Boolean(options && typeof options === 'object' && (options as DeviceProfileRequestOptions).isRetry === true);
    }

    /** Waits for raw HDR only when the external probe authorized no native route, which static HEVC HDR prefers. */
    private async waitForRawHDRWithoutExternalRoute(externalProbe: Promise<void>): Promise<void> {
        await externalProbe;
        if (this.presenter.getAuthorizedExternalHDRRouteKeys().length === 0) {
            await this.presenter.waitForRawHDRAuthorizationPrewarm();
        }
    }

    /** Raw SDR authorization is independent of HDR settings but never widens a retry. */
    private async getDeviceProfileRawSDRRouteKeys(isRetry: boolean): Promise<RawHDRAuthorizationRouteKey[]> {
        if (isRetry) {
            return [];
        }
        await this.presenter.waitForRawSDRAuthorizationPrewarm();
        return this.presenter.getAuthorizedRawHDRRouteKeys().filter(isRawSDRRouteKey);
    }

    /**
     * Waits once for each presentation probe the item's scope needs, all in parallel.
     * The scopes assume HEVC, whose static HDR prefers the native external route, so raw HDR waits for the external probe to find no route.
     * An AV1, VP9, or HEVC range-extension item presents HDR only through raw planes, and an item without metadata may need either, so both wait for raw HDR whatever the external result.
     */
    private async prewarmHDRDeviceProfileItemRoutes(
        probeScope: HDRDeviceProfileProbeScope,
        rawOnlyHDRPresentation: boolean,
        reconstructionTarget: DolbyVisionReconstructionTarget | null
    ): Promise<void> {
        const pendingProbes: Promise<void>[] = [];
        // External keys also shape the HEVC ranges a transcode may keep, so even a raw-only item waits for them
        const externalProbe = EXTERNAL_HDR_DEVICE_PROFILE_PROBE_SCOPES.has(probeScope) ?
            this.presenter.waitForExternalHDRAuthorizationPrewarm() :
            null;
        if (externalProbe) {
            pendingProbes.push(externalProbe);
        }
        if (isRawHDRDeviceProfileProbeScope(probeScope, rawOnlyHDRPresentation)) {
            pendingProbes.push(
                rawOnlyHDRPresentation || probeScope === 'unknown' || externalProbe === null ?
                    this.presenter.waitForRawHDRAuthorizationPrewarm() :
                    this.waitForRawHDRWithoutExternalRoute(externalProbe)
            );
        }
        if (DOLBY_VISION_DEVICE_PROFILE_PROBE_SCOPES.has(probeScope)) {
            pendingProbes.push(this.presenter.waitForDolbyVisionAuthorizationPrewarm(reconstructionTarget));
        }
        await Promise.all(pendingProbes);
    }

    /** Returns only the HDR routes authorized on the present GPU device. */
    private async getHDRDeviceProfileOptions(item: unknown, isRetry: boolean): Promise<CustomDeviceProfileOptions> {
        const authorizedRawSDRRouteKeys = await this.getDeviceProfileRawSDRRouteKeys(isRetry);
        const HDRToneMappingEnabled = !isRetry && await getWebGPUHDRToneMappingEnabled();
        const probeScope = getHDRDeviceProfileProbeScope(item);
        const presentationOptions = getDeviceProfilePresentationOptions(item);
        const rawOnlyHDRPresentation = isRawOnlyHDRPresentation(presentationOptions);
        const reconstructionTarget = getDolbyVisionReconstructionTarget(presentationOptions);
        if (HDRToneMappingEnabled) {
            await this.prewarmHDRDeviceProfileItemRoutes(probeScope, rawOnlyHDRPresentation, reconstructionTarget);
        }
        const externalHDRProbed = EXTERNAL_HDR_DEVICE_PROFILE_PROBE_SCOPES.has(probeScope);
        const rawHDRProbed = isRawHDRDeviceProfileProbeScope(probeScope, rawOnlyHDRPresentation);
        const DolbyVisionProbed = DOLBY_VISION_DEVICE_PROFILE_PROBE_SCOPES.has(probeScope);
        const authorizedExternalHDRRouteKeys = HDRToneMappingEnabled && externalHDRProbed ?
            this.presenter.getAuthorizedExternalHDRRouteKeys() :
            [];
        const authorizedRawHDRRouteKeys = HDRToneMappingEnabled && rawHDRProbed ?
            this.presenter.getAuthorizedRawHDRRouteKeys().filter(
                (routeKey: RawHDRAuthorizationRouteKey): boolean => !isRawSDRRouteKey(routeKey)
            ) :
            [];
        const rawDolbyVisionRouteFlags = this.getRawDolbyVisionDeviceProfileFlags(
            HDRToneMappingEnabled && DolbyVisionProbed,
            reconstructionTarget
        );
        const allowNativeDolbyVisionProfile7HDR10Base = allowsNativeDolbyVisionBaseDeviceProfileRoute(
            HDRToneMappingEnabled,
            probeScope,
            'dolby-vision-profile7',
            item,
            hasExactProfile7HDR10BaseSource,
            DOLBY_VISION_HDR10_BASE_COLOR_METADATA,
            authorizedExternalHDRRouteKeys
        );
        const allowNativeDolbyVisionProfile8HDR10Base = allowsNativeDolbyVisionBaseDeviceProfileRoute(
            HDRToneMappingEnabled,
            probeScope,
            'dolby-vision-profile8-hdr10-base',
            item,
            hasExactProfile8HDR10BaseSource,
            DOLBY_VISION_HDR10_BASE_COLOR_METADATA,
            authorizedExternalHDRRouteKeys
        );
        const allowNativeDolbyVisionProfile8HLGBase = allowsNativeDolbyVisionBaseDeviceProfileRoute(
            HDRToneMappingEnabled,
            probeScope,
            'dolby-vision-profile8-hlg-base',
            item,
            hasExactProfile8HLGBaseSource,
            DOLBY_VISION_HLG_BASE_COLOR_METADATA,
            authorizedExternalHDRRouteKeys
        );
        return {
            ...rawDolbyVisionRouteFlags,
            ...(rawDolbyVisionRouteFlags.allowDolbyVisionProfile7 && hasExactSeparateProfile7Source(item) ? {
                allowDolbyVisionProfile7HDR10Base: true
            } : {}),
            allowNativeDolbyVision: HDRToneMappingEnabled && DolbyVisionProbed && this.presenter.isExternalDolbyVisionPresentationAuthorized(),
            ...(allowNativeDolbyVisionProfile7HDR10Base ? {
                allowNativeDolbyVisionProfile7HDR10Base: true
            } : {}),
            ...(allowNativeDolbyVisionProfile8HDR10Base ? {
                allowNativeDolbyVisionProfile8HDR10Base: true
            } : {}),
            ...(allowNativeDolbyVisionProfile8HLGBase ? {
                allowNativeDolbyVisionProfile8HLGBase: true
            } : {}),
            allowNativeHDR: authorizedExternalHDRRouteKeys.length > 0,
            allowRawHDR: authorizedRawHDRRouteKeys.length > 0,
            allowRawSDR: authorizedRawSDRRouteKeys.length > 0,
            authorizedExternalHDRRouteKeys,
            authorizedRawHDRRouteKeys: [
                ...authorizedRawSDRRouteKeys,
                ...authorizedRawHDRRouteKeys
            ],
            // Only a Dolby Vision item can need its exact profile, depth, and range advertised
            ...(!isRetry && getDolbyVisionPresentationDescriptor(presentationOptions) !== null ? {
                itemMediaSource: (presentationOptions as { mediaSource: unknown }).mediaSource
            } : {})
        };
    }

    private isNonTranscodedSourceOptions(options: unknown): boolean {
        const playMethod = getNormalizedPlayMethod(options);
        return playMethod === DIRECT_PLAY_METHOD || playMethod === DIRECT_STREAM_METHOD;
    }

    private isDirectPlayOptions(options: unknown): boolean {
        return getNormalizedPlayMethod(options) === DIRECT_PLAY_METHOD;
    }

    private isPresentationSessionCurrent(generation: number): boolean {
        return this.backendSessionActive && this.webGPUPresentationEnabled && this.presentationGeneration === generation;
    }

    private advancePresentationGeneration(): number {
        if (this.presentationGeneration === Number.MAX_SAFE_INTEGER) {
            throw new RangeError('WebGPU player generation exhausted');
        }

        this.presentationGeneration += 1;
        return this.presentationGeneration;
    }
}

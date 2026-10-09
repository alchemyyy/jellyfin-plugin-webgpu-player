import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLAYBACK_SUPERSEDED } from 'addons/webGPUPlayer/constants/playbackResult';
import { MediaError } from 'types/mediaError';
import Events from 'utils/events';

import { microsecondsToMilliseconds } from 'webgpu-player/MediaTime';
import {
    RENDER_SETTINGS_VERSION,
    type HDRToSDRRenderSettings
} from 'webgpu-player/presentation/RenderSettings';
import {
    createConfiguredHDRRenderSettings,
    createDefaultWebGPUUserSettings
} from 'addons/webGPUPlayer/WebGPUUserSettings';
import { createDefaultAudioDownmixSettings } from 'webgpu-player/audio/processing/CustomAudioDownmix';
import type {
    NativeMediaAudioCapabilities,
    NativeMediaAudioChannelCount,
    NativeMediaAudioCodec,
    NativeMediaAudioCodecCapability,
    NativeMediaAudioLayoutCapability
} from 'webgpu-player/capability/NativeMediaAudioCapabilities';
import type { DolbyVisionAuthorizationRoute } from 'webgpu-player/validation/DolbyVisionPresentationAuthorization';

type MockAudioEligibilityOverride = {
    audioOutputMode?: 'native-media'
    audioSourceChannelCount?: number
    audioTrackIndex?: number
    eligible: boolean
    reason?: string
};

type MockEligibilityOptions = {
    allowDolbyVision?: boolean
    allowDolbyVisionProfile7?: boolean
    allowNativeDolbyVision?: boolean
    allowNativeDolbyVisionProfile7HDR10Base?: boolean
    allowNativeDolbyVisionProfile8HDR10Base?: boolean
    allowNativeDolbyVisionProfile8HLGBase?: boolean
    allowNativeHDR?: boolean
    allowRawHDR: boolean
    nativeMediaAudioCapabilities?: NativeMediaAudioCapabilities | null
};

const htmlPlayerMockState = vi.hoisted(() => ({
    constructorOptions: [] as Array<{
        forceCustomSubtitleElements: boolean
        useWebGPUHLSRuntime: boolean
    }>,
    instances: [] as object[],
    owners: [] as object[]
}));
// Presentation timing the mocked controller reports, which the stats overlay shows
const presentationTimingMockState = vi.hoisted(() => ({
    clockResetCount: 3,
    droppedFrameCount: 0,
    largestClockJumpMicroseconds: 42_000,
    lateFrameCount: 4,
    staleFrameCount: 2,
    worstFrameLagMicroseconds: 100_400
}));
const presenterMockState = vi.hoisted(() => ({
    authorizedExternalHDRRouteKeys: [] as string[],
    authorizedRawHDRRouteKeys: [] as string[],
    dolbyVisionAuthorized: false,
    instances: [] as object[]
}));
const playbackPreferencesMockState = vi.hoisted(() => ({
    customDecodeEnabled: false,
    customDecodeEnabledPromises: [] as Array<Promise<boolean>>,
    hdrToneMappingEnabled: false,
    refreshWebGPUPlaybackPreferences: vi.fn(),
    // Null keeps the stored preference equal to the negotiated one
    storedCustomDecodeEnabled: null as boolean | null
}));
const userSettingsMockState = vi.hoisted(() => ({
    audioDownmixAlgorithm: 'standard-lo-ro',
    audioNormalizationMode: 'TrackGain',
    webGPUPlaybackSettings: null as string | null
}));
const customDecodeMockState = vi.hoisted(() => ({
    audioEligibilityOverride: null as ((
        options: unknown,
        eligibilityOptions: MockEligibilityOptions
    ) => MockAudioEligibilityOverride) | null,
    audioOutputMode: 'decoded-pcm' as 'decoded-pcm' | 'native-media',
    audioSourceChannelCount: 2,
    audioTrackIndex: null as number | null,
    discardDolbyVisionEnhancementLayer: false,
    dolbyVision: false,
    dolbyVisionProfile7HDR10Base: false,
    dolbyVisionProfile7: false,
    dolbyVisionProfile8HDR10Base: false,
    dolbyVisionProfile8HLGBase: false,
    eligible: false,
    hdr: false,
    // A held play() never settles, as when the controller is still starting
    holdPlay: false,
    instances: [] as object[],
    maximumCodedHeight: 1_080,
    maximumCodedWidth: 1_920,
    nativeHDRTransfer: null as 'hlg' | 'pq' | null,
    neutralizeHDRColorMetadata: false,
    startupFallback: false,
    videoDecoderBackend: 'native' as 'bundled-hevc' | 'native',
    videoOutputMode: 'video-frame' as 'raw-planes' | 'video-frame'
}));
const customProfileMockState = vi.hoisted(() => ({
    augmentationCalls: [] as Array<{ options: unknown, profile: unknown }>,
    runtimeAvailable: true,
    workerAvailable: false
}));
const animationFrameMockState = vi.hoisted(() => ({
    callbacks: new Map<number, FrameRequestCallback>(),
    nextIdentifier: 1
}));
const audioPrewarmMockState = vi.hoisted(() => ({
    factoryLeases: [] as unknown[],
    leases: [] as Array<{
        audioContext: {
            destination: { maxChannelCount: number }
            sampleRate: number
        }
        close: ReturnType<typeof vi.fn>
        resumePromise: Promise<void>
    }>,
    nextClosePromise: null as Promise<void> | null,
    maximumChannelCount: 2,
    sampleRates: [] as number[]
}));
const nativeAudioCapabilityMockState = vi.hoisted(() => ({
    capabilities: null as object | null
}));

vi.mock('lib/globalize', async () => {
    const { translateSourceString } = await import('./host/globalizeMock');
    return { default: { translate: translateSourceString } };
});

vi.mock('addons/webGPUPlayer/WebGPUPlaybackPreferences', () => ({
    getWebGPUCustomDecodeEnabled: vi.fn(() => (
        playbackPreferencesMockState.customDecodeEnabledPromises.shift()
        ?? Promise.resolve(playbackPreferencesMockState.customDecodeEnabled)
    )),
    getWebGPUHDRToneMappingEnabled: vi.fn(() => Promise.resolve(
        playbackPreferencesMockState.hdrToneMappingEnabled
    )),
    isStoredWebGPUCustomDecodeEnabled: vi.fn(() => (
        playbackPreferencesMockState.storedCustomDecodeEnabled
        ?? playbackPreferencesMockState.customDecodeEnabled
    )),
    isWebGPUCustomDecodeEnabled: vi.fn(() => playbackPreferencesMockState.customDecodeEnabled),
    refreshWebGPUPlaybackPreferences: playbackPreferencesMockState.refreshWebGPUPlaybackPreferences
}));

// WebGPUUserSettings persists through the host's user settings
vi.mock('scripts/settings/userSettings', () => ({
    currentSettings: {
        get: vi.fn(() => userSettingsMockState.webGPUPlaybackSettings),
        set: vi.fn((_name: string, value: string) => {
            userSettingsMockState.webGPUPlaybackSettings = value;
        })
    }
}));

// Custom playback startup and the settings dialog read local preferences through the add-on shim
vi.mock('addons/webGPUPlayer/shims/userSettings', () => ({
    selectAudioNormalization: vi.fn(() => userSettingsMockState.audioNormalizationMode),
    webGPUAudioDownmixAlgorithm: vi.fn(() => userSettingsMockState.audioDownmixAlgorithm)
}));

vi.mock('webgpu-player/capability/CustomPlaybackEligibility', async importOriginal => {
    const originalModule = await importOriginal<
        typeof import('webgpu-player/capability/CustomPlaybackEligibility')
    >();
    const isHDRPresentationAllowed = (eligibilityOptions: MockEligibilityOptions): boolean => {
        if (!customDecodeMockState.dolbyVision) {
            return eligibilityOptions.allowRawHDR
                || eligibilityOptions.allowNativeHDR === true;
        }
        if (!customDecodeMockState.dolbyVisionProfile7) {
            if (customDecodeMockState.dolbyVisionProfile8HDR10Base) {
                return eligibilityOptions.allowNativeDolbyVisionProfile8HDR10Base === true;
            }
            if (customDecodeMockState.dolbyVisionProfile8HLGBase) {
                return eligibilityOptions.allowNativeDolbyVisionProfile8HLGBase === true;
            }
            return eligibilityOptions.allowDolbyVision === true;
        }
        if (eligibilityOptions.allowDolbyVisionProfile7 === true) {
            return true;
        }
        return customDecodeMockState.dolbyVisionProfile7HDR10Base
            && eligibilityOptions.allowNativeDolbyVisionProfile7HDR10Base === true;
    };
    const getDolbyVisionOutputProfile = (): 5 | 7 | 8 | null => {
        if (!customDecodeMockState.dolbyVision
            || customDecodeMockState.dolbyVisionProfile7HDR10Base
            || customDecodeMockState.dolbyVisionProfile8HDR10Base
            || customDecodeMockState.dolbyVisionProfile8HLGBase) {
            return null;
        }
        return customDecodeMockState.dolbyVisionProfile7 ? 7 : 8;
    };

    return {
        ...originalModule,
        getCustomPlaybackEligibility: vi.fn((
            options: unknown,
            _capabilities: unknown,
            eligibilityOptions: MockEligibilityOptions
        ) => {
            const HDRPresentationAllowed = isHDRPresentationAllowed(eligibilityOptions);
            const audioEligibilityOverride = customDecodeMockState.audioEligibilityOverride?.(
                options,
                eligibilityOptions
            ) ?? null;
            const eligible = customDecodeMockState.eligible
                && (!customDecodeMockState.hdr || HDRPresentationAllowed)
                && audioEligibilityOverride?.eligible !== false;
            return eligible ? {
                audioOutputMode: audioEligibilityOverride?.audioOutputMode
                    ?? (customDecodeMockState.audioTrackIndex === null ?
                        null :
                        customDecodeMockState.audioOutputMode),
                audioSourceChannelCount: audioEligibilityOverride?.audioSourceChannelCount
                    ?? customDecodeMockState.audioSourceChannelCount,
                audioTrackIndex: audioEligibilityOverride?.audioTrackIndex
                    ?? customDecodeMockState.audioTrackIndex,
                ...(customDecodeMockState.discardDolbyVisionEnhancementLayer ?
                    { discardDolbyVisionEnhancementLayer: true } :
                    {}),
                dolbyVisionProfile: getDolbyVisionOutputProfile(),
                durationMicroseconds: 60_000_000,
                eligible: true,
                hdr: customDecodeMockState.hdr,
                maximumCodedHeight: customDecodeMockState.maximumCodedHeight,
                maximumCodedWidth: customDecodeMockState.maximumCodedWidth,
                nativeHDRTransfer: customDecodeMockState.nativeHDRTransfer,
                neutralizeHDRColorMetadata: customDecodeMockState.neutralizeHDRColorMetadata,
                rawVideoFrameFormat: customDecodeMockState.videoOutputMode === 'raw-planes' ?
                    'I420P10' :
                    null,
                startTimeMicroseconds: 1_000_000,
                url: 'http://localhost/video.mp4?api_key=custom-decode-secret',
                videoDecoderBackend: customDecodeMockState.videoDecoderBackend,
                videoOutputMode: customDecodeMockState.videoOutputMode,
                videoTrackIndex: 0
            } : {
                eligible: false,
                reason: audioEligibilityOverride?.reason ?? 'invalid-options'
            };
        })
    };
});

vi.mock('webgpu-player/audio/output/BrowserAudioContextPrewarm', () => ({
    prewarmBrowserAudioContext: vi.fn((sampleRate: number) => {
        const lease = {
            audioContext: {
                destination: {
                    maxChannelCount: audioPrewarmMockState.maximumChannelCount
                },
                sampleRate
            },
            close: vi.fn(() => (
                audioPrewarmMockState.nextClosePromise ?? Promise.resolve()
            )),
            resumePromise: Promise.resolve()
        };
        audioPrewarmMockState.sampleRates.push(sampleRate);
        audioPrewarmMockState.leases.push(lease);
        return lease;
    })
}));

vi.mock('webgpu-player/capability/CustomDecodeCapabilities', async importOriginal => {
    const originalModule = await importOriginal<
        typeof import('webgpu-player/capability/CustomDecodeCapabilities')
    >();
    return {
        ...originalModule,
        probeCustomDecodeCapabilities: vi.fn(() => Promise.resolve({
            audio: {},
            telemetry: { reason: 'complete' },
            video: {}
        }))
    };
});

vi.mock('webgpu-player/capability/NativeMediaAudioCapabilities', () => ({
    probeCachedNativeMediaAudioCapabilities: vi.fn(() => Promise.resolve(
        nativeAudioCapabilityMockState.capabilities
    ))
}));

vi.mock('addons/webGPUPlayer/custom/CustomDeviceProfile', () => ({
    augmentDeviceProfileForCustomDecode: vi.fn((profile: object, _capabilities: object, options: unknown) => {
        customProfileMockState.augmentationCalls.push({ options, profile });
        return {
            profile: { ...profile, CustomDecode: true },
            telemetry: {
                addedAudioProfileCount: 0,
                addedProfileCount: 1,
                addedVideoProfileCount: 1,
                reason: 'augmented',
                supportedAudioCodecs: [ 'aac' ],
                supportedVideoCodecs: [ 'h264' ],
                subtitleProfileChanged: false,
                widenedHDRCodecProfileCount: 0
            }
        };
    }),
    createBitrateIndependentDeviceProfile: vi.fn((profile: object) => ({ ...profile }))
}));

vi.mock('webgpu-player/capability/CustomPlaybackRuntime', () => ({
    getCustomPlaybackRuntimeAvailability: vi.fn(() => ({
        available: customProfileMockState.runtimeAvailable,
        environment: { worker: customProfileMockState.workerAvailable },
        reason: customProfileMockState.runtimeAvailable ? null : 'webgpu-unavailable'
    }))
}));

vi.mock('webgpu-player/audio/output/BrowserCustomAudioOutput', () => ({
    createBrowserCustomAudioOutputFactory: vi.fn((audioPrewarm: unknown) => {
        audioPrewarmMockState.factoryLeases.push(audioPrewarm);
        return vi.fn();
    })
}));

vi.mock('webgpu-player/pipeline/CustomPlaybackController', () => {
    class MockCustomPlaybackController {
        readonly eventHandler: (event: object) => void;
        readonly fallbackHook: (request: object) => Promise<void>;
        readonly nativeAudioBridgeFactory: (() => object) | undefined;
        currentTimeMicroseconds = 1_000_000;
        durationMicroseconds: number | null = 60_000_000;
        playbackRate = 1;
        playbackState = 'idle';
        playbackVolume = 1;
        isMuted = false;

        constructor(options: {
            eventHandler: (event: object) => void
            fallbackHook: (request: object) => Promise<void>
            nativeAudioBridgeFactory?: () => object
        }) {
            this.eventHandler = options.eventHandler;
            this.fallbackHook = options.fallbackHook;
            this.nativeAudioBridgeFactory = options.nativeAudioBridgeFactory;
            customDecodeMockState.instances.push(this);
        }

        play = vi.fn((options: { startTimeMicroseconds: number }) => {
            this.currentTimeMicroseconds = options.startTimeMicroseconds;
            if (customDecodeMockState.holdPlay) {
                return new Promise<never>(() => undefined);
            }
            if (customDecodeMockState.startupFallback) {
                this.playbackState = 'fallback';
                void this.fallbackHook({
                    disposition: 'renegotiate-source',
                    generation: 1,
                    mediaTimeMicroseconds: this.currentTimeMicroseconds,
                    preserveHTMLSession: true,
                    reason: 'decode-failed'
                }).catch(() => undefined);
                return Promise.resolve({
                    fallbackReason: 'decode-failed',
                    generation: 1,
                    status: 'fallback'
                });
            }
            this.playbackState = 'playing';
            this.eventHandler({
                generation: 1,
                previousState: 'starting',
                state: 'playing',
                type: 'statechange'
            });
            this.eventHandler({
                durationMicroseconds: this.durationMicroseconds,
                generation: 1,
                startupDurationMicroseconds: 10_000,
                type: 'ready'
            });
            this.eventHandler({ generation: 1, type: 'playing' });
            return Promise.resolve({
                fallbackReason: null,
                generation: 1,
                status: 'started'
            });
        });
        seek = vi.fn((mediaTimeMicroseconds: number) => {
            this.currentTimeMicroseconds = mediaTimeMicroseconds;
            const previousState = this.playbackState;
            const desiredPlaying = previousState === 'playing';
            this.playbackState = 'seeking';
            this.eventHandler({
                generation: 2,
                previousState,
                state: 'seeking',
                type: 'statechange'
            });
            return Promise.resolve().then(() => {
                this.playbackState = desiredPlaying ? 'playing' : 'paused';
                this.eventHandler({
                    generation: 2,
                    previousState: 'seeking',
                    state: this.playbackState,
                    type: 'statechange'
                });
                if (desiredPlaying) {
                    this.eventHandler({ generation: 2, type: 'playing' });
                }
                return {
                    fallbackReason: null,
                    generation: 2,
                    status: 'started'
                };
            });
        });
        pause = vi.fn(() => {
            this.playbackState = 'paused';
            this.eventHandler({
                generation: 1,
                previousState: 'playing',
                state: 'paused',
                type: 'statechange'
            });
        });
        resume = vi.fn(() => {
            this.playbackState = 'playing';
            this.eventHandler({
                generation: 1,
                previousState: 'paused',
                state: 'playing',
                type: 'statechange'
            });
            this.eventHandler({ generation: 1, type: 'playing' });
        });
        destroy = vi.fn(() => Promise.resolve());
        takeCurrentFrame = vi.fn(() => null);
        notifyFrameDiscarded = vi.fn(() => true);
        notifyFramePresented = vi.fn(() => true);
        setPageVisibility = vi.fn((): boolean => false);
        drainBackgroundVideo = vi.fn();
        canSetAudioStreamIndex = vi.fn(() => true);
        updateAudioDownmixSettings = vi.fn(() => true);
        // Null reports an unknown sink, so track switches fall back to the startup prewarm
        getAudioOutputMaximumChannelCount = vi.fn((): number | null => null);
        reconfigureAudioOutput = vi.fn((): Promise<boolean> => Promise.resolve(true));
        setAudioStreamIndex = vi.fn(() => Promise.resolve({
            fallbackReason: null,
            generation: 2,
            status: 'started'
        }));
        setVolume = vi.fn((volume: number) => {
            this.playbackVolume = volume;
        });
        setNormalizationGain = vi.fn();
        setMuted = vi.fn((muted: boolean) => {
            this.isMuted = muted;
        });
        setPlaybackRate = vi.fn((playbackRate: number) => {
            this.playbackRate = playbackRate;
            return true;
        });
        getTelemetry = vi.fn(() => ({
            activeGeneration: null,
            audioBridge: null,
            audioOutput: null,
            audioPath: 'disabled',
            clock: {},
            currentTimeMicroseconds: this.currentTimeMicroseconds,
            discardedStaleVideoFrameCount: presentationTimingMockState.staleFrameCount,
            durationMicroseconds: this.durationMicroseconds,
            fallbackCount: 0,
            fallbackReason: null,
            lastErrorMessage: null,
            muted: this.isMuted,
            playCount: 1,
            presentationTiming: {
                clockResetCount: presentationTimingMockState.clockResetCount,
                largestClockJumpMicroseconds: presentationTimingMockState.largestClockJumpMicroseconds,
                lateFrameCount: presentationTimingMockState.lateFrameCount,
                worstFrameLagMicroseconds: presentationTimingMockState.worstFrameLagMicroseconds
            },
            staleEventCount: 0,
            startupDurationMicroseconds: 10_000,
            state: 'idle',
            videoDecode: {
                activeGeneration: null,
                audioCodec: null,
                droppedFrameCount: presentationTimingMockState.droppedFrameCount,
                failureKind: null,
                firstFrameMediaTimeMicroseconds: null,
                lastAudioMediaTimeMicroseconds: null,
                lastFrameMediaTimeMicroseconds: null,
                queuedFrameCount: 0,
                receivedAudioFrameCount: 0,
                receivedAudioSampleCount: 0,
                receivedFrameCount: 0,
                staleAudioSampleCount: 0,
                staleFrameCount: 0,
                state: 'idle',
                submittedAudioFrameCount: 0,
                submittedAudioSampleCount: 0,
                takenFrameCount: 0
            },
            volume: this.playbackVolume
        }));
    }

    return { default: MockCustomPlaybackController };
});

const EXPECTED_HTML_PLAYER_EVENTS = [
    'beginFetch',
    'endFetch',
    'timeupdate',
    'volumechange',
    'playing',
    'unpause',
    'click',
    'dblclick',
    'pause',
    'waiting',
    'brightnesschange',
    'error',
    'stopped'
] as const;

vi.mock('webgpu-player/presentation/WebGPUPresenter', () => {
    // The vector telemetry that each raw Dolby Vision route reports for the prewarmed I420P10 base layer
    const dolbyVisionRouteVectors: Record<DolbyVisionAuthorizationRoute, { routeKey: string, sampleCount: number, vectorVersion: number }> = {
        'profile4-base': { routeKey: 'I420P10:dovi-profile4-base-v1', sampleCount: 18, vectorVersion: 4 },
        'profile4-fel': { routeKey: 'I420P10:dovi-profile4-fel-v1', sampleCount: 9, vectorVersion: 4 },
        'profile7-base': { routeKey: 'I420P10:dovi-profile7-base-v1', sampleCount: 18, vectorVersion: 4 },
        'profile7-fel': { routeKey: 'I420P10:dovi-profile7-fel-v1', sampleCount: 9, vectorVersion: 4 },
        'single-layer': { routeKey: 'I420P10:dovi-rpu-v1', sampleCount: 4, vectorVersion: 1 }
    };

    class MockWebGPUPresenter {
        readonly fallbackHandler: (generation: number) => void;
        readonly decodedPresentationRefreshHandler: (generation: number) => void;

        constructor(
            fallbackHandler: (generation: number) => void,
            decodedPresentationRefreshHandler: (generation: number) => void
        ) {
            this.fallbackHandler = fallbackHandler;
            this.decodedPresentationRefreshHandler = decodedPresentationRefreshHandler;
            presenterMockState.instances.push(this);
        }

        startSession = vi.fn();
        attach = vi.fn();
        configureColorPipeline = vi.fn(() => Promise.resolve(true));
        setDecodedFramePushMode = vi.fn();
        presentDecodedFrame = vi.fn((
            _decodedFrame: unknown,
            _generation: number,
            videoFrameSubmissionCompleted?: (gpuWorkCompleted: boolean) => void
        ): boolean => {
            videoFrameSubmissionCompleted?.(true);
            return true;
        });
        seek = vi.fn();
        refresh = vi.fn();
        endSession = vi.fn();
        destroy = vi.fn();
        getTelemetry = vi.fn(() => ({
            decodedFrameCount: 0,
            deviceRecoveryCount: 0,
            dolbyVisionDualLayerFELBaseFallbackPresentedFrameCount: 0,
            dolbyVisionDualLayerFELPresentedFrameCount: 0,
            dolbyVisionDualLayerMELPresentedFrameCount: 0,
            fallbackReason: null,
            firstFrameLatencyMicroseconds: null,
            firstPresentedMediaTimeMicroseconds: null,
            lastCallbackTimeMicroseconds: null,
            lastExpectedDisplayTimeMicroseconds: null,
            lastPresentedMediaTimeMicroseconds: null,
            mode: 'identity-sdr',
            nativeFrameCount: 0,
            presentationSource: null,
            presentedFrameCount: 0,
            sessionStartedMicroseconds: 0,
            state: 'idle'
        }));
        getRenderSettings = vi.fn(() => ({
            mode: 'identity-sdr',
            version: RENDER_SETTINGS_VERSION
        }));
        updateRenderSettings = vi.fn(() => true);
        prewarmRawHDRPresentationAuthorization = vi.fn(() => Promise.resolve());
        prewarmRawSDRPresentationAuthorization = vi.fn(() => Promise.resolve());
        waitForRawHDRAuthorizationPrewarm = vi.fn(() => Promise.resolve());
        waitForRawSDRAuthorizationPrewarm = vi.fn(() => Promise.resolve());
        prewarmExternalHDRPresentationAuthorization = vi.fn(() => Promise.resolve());
        waitForExternalHDRAuthorizationPrewarm = vi.fn(() => Promise.resolve());
        prewarmDolbyVisionPresentationAuthorization = vi.fn(() => Promise.resolve());
        waitForDolbyVisionAuthorizationPrewarm = vi.fn(() => Promise.resolve());
        isRawDolbyVisionPresentationAuthorized = vi.fn(() => (
            presenterMockState.dolbyVisionAuthorized
        ));
        isRawDolbyVisionProfile4PresentationAuthorized = vi.fn(() => (
            presenterMockState.dolbyVisionAuthorized
        ));
        isRawDolbyVisionProfile7PresentationAuthorized = vi.fn(() => (
            presenterMockState.dolbyVisionAuthorized
        ));
        isExternalDolbyVisionPresentationAuthorized = vi.fn(() => (
            presenterMockState.dolbyVisionAuthorized
        ));
        getAuthorizedExternalHDRRouteKeys = vi.fn(() => (
            [ ...presenterMockState.authorizedExternalHDRRouteKeys ]
        ));
        getAuthorizedRawHDRRouteKeys = vi.fn(() => (
            [ ...presenterMockState.authorizedRawHDRRouteKeys ]
        ));
        getRawHDRAuthorizationTelemetry = vi.fn(() => ({
            authorizedRouteKeys: [ ...presenterMockState.authorizedRawHDRRouteKeys ],
            failureReasons: {},
            vectorVersion: 1,
            pendingRouteKeys: [],
            rejectedRouteKeys: [],
            renderSettingsVersion: 4,
            status: presenterMockState.authorizedRawHDRRouteKeys.length > 0 ?
                'authorized' :
                'unavailable',
            targetFormat: 'bgra8unorm'
        }));
        getExternalHDRAuthorizationTelemetry = vi.fn(() => ({
            authorizedRouteKeys: [ ...presenterMockState.authorizedExternalHDRRouteKeys ],
            failureReasons: {},
            vectorVersion: 1,
            maximumChannelErrors: {},
            pendingRouteKeys: [],
            rejectedRouteKeys: [],
            renderSettingsVersion: 4,
            sampleCounts: {},
            status: presenterMockState.authorizedExternalHDRRouteKeys.length > 0 ?
                'authorized' :
                'unavailable',
            targetFormat: 'bgra8unorm'
        }));
        getDolbyVisionAuthorizationTelemetry = vi.fn((route: DolbyVisionAuthorizationRoute) => ({
            ...dolbyVisionRouteVectors[route],
            failureReason: presenterMockState.dolbyVisionAuthorized ? null : 'pixel-mismatch',
            maximumChannelError: presenterMockState.dolbyVisionAuthorized ? 0 : 1,
            renderSettingsVersion: 4,
            status: presenterMockState.dolbyVisionAuthorized ? 'authorized' : 'rejected',
            targetFormat: 'bgra8unorm'
        }));
        getExternalDolbyVisionAuthorizationTelemetry = vi.fn(() => ({
            failureReason: presenterMockState.dolbyVisionAuthorized ? null : 'pixel-mismatch',
            vectorVersion: 2,
            maximumChannelError: presenterMockState.dolbyVisionAuthorized ? 0 : 1,
            maximumInputChannelError: presenterMockState.dolbyVisionAuthorized ? 0 : 1,
            renderSettingsVersion: RENDER_SETTINGS_VERSION,
            routeKey: 'external-I420P10-bt709-limited:dovi-p5-rpu-v1',
            sampleCount: 9,
            status: presenterMockState.dolbyVisionAuthorized ? 'authorized' : 'rejected',
            targetFormat: 'bgra8unorm'
        }));
    }

    return { default: MockWebGPUPresenter };
});

// HTMLPlayerDelegate owns the add-on's private copy of the fork's HTML player
vi.mock('addons/webGPUPlayer/backend/htmlVideoPlayer/plugin', () => {
    class MockHtmlVideoPlayer {
        isFetching = false;
        forcedFullscreen = false;
        currentTimeMilliseconds = 0;
        durationMilliseconds = 60_000;
        readonly profile = { Name: 'HTML profile' };
        presentationSurface: { container: HTMLDivElement, video: HTMLVideoElement } | null = null;

        constructor(
            owner: object,
            forceCustomSubtitleElements = false,
            useWebGPUHLSRuntime = false
        ) {
            htmlPlayerMockState.instances.push(this);
            htmlPlayerMockState.owners.push(owner);
            htmlPlayerMockState.constructorOptions.push({
                forceCustomSubtitleElements,
                useWebGPUHLSRuntime
            });
        }

        currentSrc = vi.fn(() => 'backend-source');
        cancelPendingPlay = vi.fn();
        getPresentationSurface = vi.fn(() => this.presentationSurface);
        prepareCustomPlayback = vi.fn(() => Promise.resolve(this.presentationSurface));
        notifyCustomPlaybackEnded = vi.fn(() => {
            Events.trigger(this, 'stopped');
            return true;
        });
        notifyCustomPlaybackPaused = vi.fn(() => {
            Events.trigger(this, 'pause');
            return true;
        });
        notifyCustomPlaybackPlaying = vi.fn((emitUnpause = true) => {
            if (emitUnpause) {
                Events.trigger(this, 'unpause');
            }
            Events.trigger(this, 'playing');
            return true;
        });
        notifyCustomPlaybackTimeUpdate = vi.fn(() => {
            Events.trigger(this, 'timeupdate');
            return true;
        });
        notifyCustomPlaybackWaiting = vi.fn(() => {
            Events.trigger(this, 'waiting');
            return true;
        });
        canPlayMediaType = vi.fn((mediaType: string | null | undefined) => mediaType?.toLowerCase() === 'video');
        supportsPlayMethod = vi.fn(() => true);
        getDeviceProfile = vi.fn(() => Promise.resolve(this.profile));
        supports = vi.fn(() => true);
        play = vi.fn((options: unknown) => Promise.resolve(options));
        stop = vi.fn<(destroyPlayer: boolean) => Promise<void>>(() => Promise.resolve());
        destroy = vi.fn();
        currentTime = vi.fn((value?: number) => {
            if (value != null) {
                this.currentTimeMilliseconds = value;
                return undefined;
            }

            return this.currentTimeMilliseconds;
        });
        duration = vi.fn(() => this.durationMilliseconds);
        seekable = vi.fn(() => true);
        pause = vi.fn();
        resume = vi.fn();
        unpause = vi.fn();
        paused = vi.fn(() => false);
        setSubtitleStreamIndex = vi.fn();
        setSecondarySubtitleStreamIndex = vi.fn();
        resetSubtitleOffset = vi.fn();
        setSubtitleOffset = vi.fn();
        getSubtitleOffset = vi.fn(() => 0);
        enableShowingSubtitleOffset = vi.fn();
        disableShowingSubtitleOffset = vi.fn();
        isShowingSubtitleOffsetEnabled = vi.fn(() => false);
        canSetAudioStreamIndex = vi.fn(() => true);
        setAudioStreamIndex = vi.fn();
        setVolume = vi.fn();
        getVolume = vi.fn(() => 50);
        volumeUp = vi.fn();
        volumeDown = vi.fn();
        setMute = vi.fn();
        isMuted = vi.fn(() => false);
        setPlaybackRate = vi.fn();
        getPlaybackRate = vi.fn(() => 1);
        getSupportedPlaybackRates = vi.fn(() => [{ id: 1, name: '1x' }]);
        setBrightness = vi.fn();
        getBrightness = vi.fn(() => 100);
        setAspectRatio = vi.fn();
        getAspectRatio = vi.fn(() => 'auto');
        getSupportedAspectRatios = vi.fn(() => [{ id: 'auto', name: 'Auto' }]);
        setPictureInPictureEnabled = vi.fn();
        isPictureInPictureEnabled = vi.fn(() => false);
        togglePictureInPicture = vi.fn();
        setAirPlayEnabled = vi.fn();
        isAirPlayEnabled = vi.fn(() => false);
        toggleAirPlay = vi.fn();
        getBufferedRanges = vi.fn(() => []);
        getStats = vi.fn(() => Promise.resolve({ categories: [] }));
    }

    return {
        default: MockHtmlVideoPlayer,
        HtmlVideoPlayer: MockHtmlVideoPlayer
    };
});

import { HTML_PLAYER_EVENTS } from 'addons/webGPUPlayer/HTMLPlayerDelegate';
import WebGPUPlayer, {
    CUSTOM_PLAYBACK_BACKGROUND_DRAIN_INTERVAL_MILLISECONDS,
    CUSTOM_PLAYBACK_SETUP_TIMEOUT_MICROSECONDS
} from 'addons/webGPUPlayer/WebGPUPlayer';
import { getCustomPlaybackEligibility } from 'webgpu-player/capability/CustomPlaybackEligibility';
import {
    CUSTOM_DECODE_AUDIO_PROBES,
    CUSTOM_DECODE_VIDEO_PROBES,
    probeCustomDecodeCapabilities,
    type CustomDecodeCapabilities,
    type CustomDecodeProbe,
    type CustomDecodeProbeState
} from 'webgpu-player/capability/CustomDecodeCapabilities';

type MockFunction = ReturnType<typeof vi.fn>;

type MockHTMLPlayer = {
    isFetching: boolean
    forcedFullscreen: boolean
    currentTimeMilliseconds: number
    durationMilliseconds: number
    profile: object
    presentationSurface: { container: HTMLDivElement, video: HTMLVideoElement } | null
    cancelPendingPlay: MockFunction
    currentSrc: MockFunction
    prepareCustomPlayback: MockFunction
    notifyCustomPlaybackEnded: MockFunction
    notifyCustomPlaybackPaused: MockFunction
    notifyCustomPlaybackPlaying: MockFunction
    notifyCustomPlaybackTimeUpdate: MockFunction
    notifyCustomPlaybackWaiting: MockFunction
    canPlayItem?: MockFunction
    canPlayMediaType: MockFunction
    supportsPlayMethod: MockFunction
    getDeviceProfile: MockFunction
    supports: MockFunction
    play: MockFunction
    stop: MockFunction
    destroy: MockFunction
    currentTime: MockFunction
    pause: MockFunction
    resume: MockFunction
    unpause: MockFunction
    resetSubtitleOffset: MockFunction
    setVolume: MockFunction
    getVolume: MockFunction
    setMute: MockFunction
    isMuted: MockFunction
    setPlaybackRate: MockFunction
    getPlaybackRate: MockFunction
    setBrightness: MockFunction
    getBrightness: MockFunction
    setAspectRatio: MockFunction
    setSubtitleStreamIndex: MockFunction
    setSecondarySubtitleStreamIndex: MockFunction
    setAudioStreamIndex: MockFunction
    setPictureInPictureEnabled: MockFunction
    isPictureInPictureEnabled: MockFunction
    togglePictureInPicture: MockFunction
    setAirPlayEnabled: MockFunction
    isAirPlayEnabled: MockFunction
    toggleAirPlay: MockFunction
    getBufferedRanges: MockFunction
    getStats: MockFunction
};

type MockPresenter = {
    attach: MockFunction
    configureColorPipeline: MockFunction
    destroy: MockFunction
    decodedPresentationRefreshHandler: (generation: number) => void
    endSession: MockFunction
    fallbackHandler: (generation: number) => void
    getDolbyVisionAuthorizationTelemetry: MockFunction
    getRenderSettings: MockFunction
    getTelemetry: MockFunction
    isRawDolbyVisionPresentationAuthorized: MockFunction
    isRawDolbyVisionProfile4PresentationAuthorized: MockFunction
    isRawDolbyVisionProfile7PresentationAuthorized: MockFunction
    refresh: MockFunction
    seek: MockFunction
    presentDecodedFrame: MockFunction
    prewarmDolbyVisionPresentationAuthorization: MockFunction
    prewarmExternalHDRPresentationAuthorization: MockFunction
    setDecodedFramePushMode: MockFunction
    startSession: MockFunction
    updateRenderSettings: MockFunction
    waitForDolbyVisionAuthorizationPrewarm: MockFunction
    waitForExternalHDRAuthorizationPrewarm: MockFunction
    waitForRawHDRAuthorizationPrewarm: MockFunction
    waitForRawSDRAuthorizationPrewarm: MockFunction
};

type MockCustomPlaybackController = {
    eventHandler: (event: object) => void
    fallbackHook: (request: object) => Promise<void>
    nativeAudioBridgeFactory: (() => object) | undefined
    getTelemetry: MockFunction
    play: MockFunction
    seek: MockFunction
    pause: MockFunction
    resume: MockFunction
    destroy: MockFunction
    takeCurrentFrame: MockFunction
    notifyFrameDiscarded: MockFunction
    notifyFramePresented: MockFunction
    setPageVisibility: MockFunction
    drainBackgroundVideo: MockFunction
    canSetAudioStreamIndex: MockFunction
    updateAudioDownmixSettings: MockFunction
    getAudioOutputMaximumChannelCount: MockFunction
    reconfigureAudioOutput: MockFunction
    setAudioStreamIndex: MockFunction
    setVolume: MockFunction
    setNormalizationGain: MockFunction
    setMuted: MockFunction
    setPlaybackRate: MockFunction
    currentTimeMicroseconds: number
    durationMicroseconds: number | null
    playbackRate: number
    playbackState: string
};

function getBackend(): MockHTMLPlayer {
    const backendIndex = htmlPlayerMockState.instances.length - 1;
    return htmlPlayerMockState.instances[backendIndex] as MockHTMLPlayer;
}

function getPresenter(): MockPresenter {
    const presenterIndex = presenterMockState.instances.length - 1;
    return presenterMockState.instances[presenterIndex] as MockPresenter;
}

function getCustomPlaybackController(): MockCustomPlaybackController {
    const sessionIndex = customDecodeMockState.instances.length - 1;
    return customDecodeMockState.instances[sessionIndex] as MockCustomPlaybackController;
}

type Deferred<Value> = {
    promise: Promise<Value>
    reject: (error: unknown) => void
    resolve: (value: Value) => void
};

function createDeferred<Value>(): Deferred<Value> {
    let rejectPromise: (error: unknown) => void = () => {
        throw new Error('Deferred promise was not initialized');
    };
    let resolvePromise: (value: Value) => void = () => {
        throw new Error('Deferred promise was not initialized');
    };
    const promise = new Promise<Value>((resolve, reject) => {
        rejectPromise = reject;
        resolvePromise = resolve;
    });
    return { promise, reject: rejectPromise, resolve: resolvePromise };
}

/** Resolves on a zero-delay timer, after any zero-delay timer scheduled before it. */
function waitForMacrotask(): Promise<void> {
    return new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, 0);
    });
}

function runNextAnimationFrame(timestamp = 0): void {
    const entry = animationFrameMockState.callbacks.entries().next();
    if (entry.done) {
        throw new Error('No animation frame is scheduled');
    }
    const [ identifier, callback ] = entry.value;
    animationFrameMockState.callbacks.delete(identifier);
    callback(timestamp);
}

function changeDocumentVisibility(visibilityState: DocumentVisibilityState): void {
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: (): DocumentVisibilityState => visibilityState
    });
    document.dispatchEvent(new Event('visibilitychange'));
}

function restoreDocumentVisibility(): void {
    Reflect.deleteProperty(document, 'visibilityState');
    // Players left by earlier tests also listen, so none may keep a hidden drain running
    document.dispatchEvent(new Event('visibilitychange'));
}

function createKnownSDRPlayOptions(
    properties: Record<string, unknown> = {}
): Record<string, unknown> {
    return {
        ...properties,
        mediaSource: {
            MediaStreams: [{ Type: 'Video', VideoRangeType: 'SDR' }]
        }
    };
}

function createPlaybackSelectionItem(
    identifier: string,
    videoStream: Record<string, unknown>,
    additionalStreams: readonly Record<string, unknown>[] = []
): Record<string, unknown> {
    return {
        Id: identifier,
        MediaSources: [{
            Container: 'mkv',
            Id: `${identifier}-source`,
            MediaStreams: [{
                Height: 1_080,
                Index: 0,
                IsInterlaced: false,
                Type: 'Video',
                VideoRangeType: 'SDR',
                Width: 1_920,
                ...videoStream
            }, ...additionalStreams]
        }]
    };
}

// Any positive integer source rate prewarms decoded audio, past 192 kHz included
const DXD_SAMPLE_RATE = 352_800;
const ZERO_SAMPLE_RATE = 0;
const TEXT_SAMPLE_RATE = '48000';

function createKnownSDRAudioPlayOptions(sampleRate: unknown = 48_000): Record<string, unknown> {
    return {
        playMethod: 'DirectPlay',
        mediaSource: {
            DefaultAudioStreamIndex: 1,
            MediaStreams: [
                { Index: 0, Type: 'Video', VideoRangeType: 'SDR' },
                { Index: 1, SampleRate: sampleRate, Type: 'Audio' }
            ]
        }
    };
}

function createKnownSDRNativeAudioPlayOptions(channelCount: number): Record<string, unknown> {
    return {
        playMethod: 'DirectPlay',
        mediaSource: {
            DefaultAudioStreamIndex: 1,
            MediaStreams: [
                { Index: 0, Type: 'Video', VideoRangeType: 'SDR' },
                {
                    Channels: channelCount,
                    Codec: 'eac3',
                    Index: 1,
                    SampleRate: 48_000,
                    Type: 'Audio'
                }
            ]
        }
    };
}

function createPartialNativeMediaAudioCapabilities(): NativeMediaAudioCapabilities {
    const supportedRouteKey = 'eac3:6:48000';
    const audio = {} as Record<NativeMediaAudioCodec, NativeMediaAudioCodecCapability>;
    for (const codec of [ 'ac3', 'eac3' ] as const) {
        const codecString = codec === 'ac3' ? 'ac-3' : 'ec-3';
        const mimeType = `audio/mp4; codecs="${codecString}"`;
        const layouts = {} as Record<
            NativeMediaAudioChannelCount,
            NativeMediaAudioLayoutCapability
        >;
        let codecSupported = false;
        for (const channelCount of [ 2, 6 ] as const) {
            const supported = `${codec}:${channelCount}:48000` === supportedRouteKey;
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
            supportedLayoutCount: 1,
            unknownLayoutCount: 0
        }
    };
}

function selectExactNativeAudioRouteForMock(
    options: unknown,
    eligibilityOptions: MockEligibilityOptions
): MockAudioEligibilityOverride {
    const unsupported: MockAudioEligibilityOverride = {
        eligible: false,
        reason: 'audio-layout-unsupported'
    };
    if (!options || typeof options !== 'object') {
        return unsupported;
    }
    const mediaSource = (options as Record<string, unknown>).mediaSource;
    if (!mediaSource || typeof mediaSource !== 'object') {
        return unsupported;
    }
    const mediaSourceRecord = mediaSource as Record<string, unknown>;
    if (!Array.isArray(mediaSourceRecord.MediaStreams)) {
        return unsupported;
    }

    const audioStreams: Array<Record<string, unknown>> = [];
    for (const mediaStream of mediaSourceRecord.MediaStreams) {
        if (mediaStream
            && typeof mediaStream === 'object'
            && (mediaStream as Record<string, unknown>).Type === 'Audio') {
            audioStreams.push(mediaStream as Record<string, unknown>);
        }
    }
    const selectedStreamIndex = mediaSourceRecord.DefaultAudioStreamIndex;
    const audioTrackIndex = audioStreams.findIndex(
        audioStream => audioStream.Index === selectedStreamIndex
    );
    if (audioTrackIndex < 0) {
        return unsupported;
    }

    const selectedAudioStream = audioStreams[audioTrackIndex];
    const codec = selectedAudioStream.Codec;
    const channelCount = selectedAudioStream.Channels;
    if ((codec !== 'ac3' && codec !== 'eac3')
        || (channelCount !== 2 && channelCount !== 6)) {
        return unsupported;
    }
    const layout = eligibilityOptions.nativeMediaAudioCapabilities
        ?.audio[codec].layouts[channelCount];
    if (layout?.status !== 'supported'
        || layout.sampleRate !== selectedAudioStream.SampleRate) {
        return unsupported;
    }

    return {
        audioOutputMode: 'native-media',
        audioTrackIndex,
        eligible: true
    };
}

function createKnownHDRPlayOptions(
    properties: Record<string, unknown> = {}
): Record<string, unknown> {
    return {
        ...properties,
        mediaSource: {
            MediaStreams: [{
                BitDepth: 10,
                Codec: 'hevc',
                ColorPrimaries: 'bt2020',
                ColorRange: 'limited',
                ColorSpace: 'bt2020-ncl',
                ColorTransfer: 'smpte2084',
                Index: 0,
                Type: 'Video',
                VideoRange: 'HDR',
                VideoRangeType: 'HDR10'
            }]
        }
    };
}

function createKnownDolbyVisionPlayOptions(
    properties: Record<string, unknown> = {}
): Record<string, unknown> {
    return {
        ...properties,
        mediaSource: {
            MediaStreams: [{
                BitDepth: 10,
                BlPresentFlag: true,
                Codec: 'hevc',
                DvBlSignalCompatibilityId: 1,
                DvProfile: 8,
                ElPresentFlag: false,
                Index: 0,
                RpuPresentFlag: true,
                Type: 'Video',
                VideoRange: 'HDR',
                VideoRangeType: 'DOVIWithHDR10'
            }]
        }
    };
}

function createKnownProfile8HDR10BasePlayOptions(
    properties: Record<string, unknown> = {}
): Record<string, unknown> {
    return {
        ...properties,
        mediaSource: {
            MediaStreams: [{
                BitDepth: 10,
                BlPresentFlag: true,
                Codec: 'hevc',
                ColorPrimaries: 'bt2020',
                ColorRange: 'tv',
                ColorSpace: 'bt2020nc',
                ColorTransfer: 'smpte2084',
                DvBlSignalCompatibilityId: 1,
                DvProfile: 8,
                ElPresentFlag: false,
                Height: 2_160,
                Index: 0,
                IsInterlaced: false,
                Level: 153,
                Profile: 'Main 10',
                RealFrameRate: 23.976025,
                RpuPresentFlag: true,
                Type: 'Video',
                VideoRange: 'HDR',
                VideoRangeType: 'DOVIWithHDR10',
                Width: 3_840
            }]
        }
    };
}

function createKnownProfile8HLGBasePlayOptions(
    properties: Record<string, unknown> = {}
): Record<string, unknown> {
    return {
        ...properties,
        mediaSource: {
            MediaStreams: [{
                BitDepth: 10,
                BlPresentFlag: true,
                Codec: 'hevc',
                ColorPrimaries: 'bt2020',
                ColorRange: 'tv',
                ColorSpace: 'bt2020nc',
                ColorTransfer: 'hlg',
                DvBlSignalCompatibilityId: 4,
                DvProfile: 8,
                ElPresentFlag: false,
                Height: 2_160,
                Index: 0,
                IsInterlaced: false,
                Level: 153,
                Profile: 'Main 10',
                RealFrameRate: 23.976025,
                RpuPresentFlag: true,
                Type: 'Video',
                VideoRange: 'HDR',
                VideoRangeType: 'DOVIWithHLG',
                Width: 3_840
            }]
        }
    };
}

function createKnownProfile7DolbyVisionPlayOptions(
    properties: Record<string, unknown> = {}
): Record<string, unknown> {
    return {
        ...properties,
        mediaSource: {
            MediaStreams: [{
                BitDepth: 10,
                BlPresentFlag: true,
                Codec: 'hevc',
                ColorPrimaries: 'bt2020',
                ColorRange: 'tv',
                ColorSpace: 'bt2020nc',
                ColorTransfer: 'smpte2084',
                DvBlSignalCompatibilityId: 6,
                DvProfile: 7,
                ElPresentFlag: true,
                Height: 2_160,
                Index: 0,
                IsInterlaced: false,
                Level: 153,
                Profile: 'Main 10',
                RealFrameRate: 23.976025,
                RpuPresentFlag: true,
                Type: 'Video',
                VideoRange: 'HDR',
                VideoRangeType: 'DOVIWithEL',
                Width: 3_840
            }]
        }
    };
}

function createVideoStreamPlayOptions(videoStream: Record<string, unknown>): Record<string, unknown> {
    return {
        mediaSource: {
            MediaStreams: [ {
                Index: 0,
                IsInterlaced: false,
                Type: 'Video',
                ...videoStream
            } ]
        },
        playMethod: 'DirectPlay'
    };
}

const PROFILE_7_RANGE_EXTENSION_STREAM = {
    BitDepth: 10,
    BlPresentFlag: true,
    Codec: 'hevc',
    DvBlSignalCompatibilityId: 0,
    DvProfile: 7,
    ElPresentFlag: true,
    PixelFormat: 'yuv422p10le',
    Profile: 'Rext',
    RpuPresentFlag: true,
    VideoRange: 'HDR',
    VideoRangeType: 'DOVIWithEL'
} as const;

const PROFILE_4_MAIN_STREAM = {
    BitDepth: 8,
    BlPresentFlag: true,
    Codec: 'hevc',
    DvBlSignalCompatibilityId: 2,
    DvProfile: 4,
    ElPresentFlag: true,
    Profile: 'Main',
    RpuPresentFlag: true,
    VideoRange: 'SDR',
    VideoRangeType: 'SDR'
} as const;

const AV1_HDR10_STREAM = {
    BitDepth: 10,
    Codec: 'av1',
    ColorPrimaries: 'bt2020',
    ColorSpace: 'bt2020nc',
    ColorTransfer: 'smpte2084',
    Profile: 'Main',
    VideoRange: 'HDR',
    VideoRangeType: 'HDR10'
} as const;

// A 4:2:2 range extension presents its PQ base only through raw planes, and its RPU key authorizes on first use
const PROFILE_8_1_RANGE_EXTENSION_STREAM = {
    BitDepth: 10,
    BlPresentFlag: true,
    Codec: 'hevc',
    ColorPrimaries: 'bt2020',
    ColorSpace: 'bt2020nc',
    ColorTransfer: 'smpte2084',
    DvBlSignalCompatibilityId: 1,
    DvProfile: 8,
    ElPresentFlag: false,
    PixelFormat: 'yuv422p10le',
    Profile: 'Rext',
    RpuPresentFlag: true,
    VideoRange: 'HDR',
    VideoRangeType: 'DOVIWithHDR10'
} as const;

const PROFILE_10_2_STREAM = {
    BitDepth: 10,
    BlPresentFlag: true,
    Codec: 'av1',
    ColorPrimaries: 'bt709',
    ColorSpace: 'bt709',
    ColorTransfer: 'bt709',
    DvBlSignalCompatibilityId: 2,
    DvProfile: 10,
    ElPresentFlag: false,
    Profile: 'Main',
    RpuPresentFlag: true,
    VideoRange: 'SDR',
    VideoRangeType: 'DOVIWithSDR'
} as const;

// Reconstruction-only streams, with no declared base a fallback could present
const PROFILE_4_MAIN10_STREAM = { ...PROFILE_4_MAIN_STREAM, BitDepth: 10, Profile: 'Main 10' } as const;

const PROFILE_8_MAIN_STREAM = {
    BitDepth: 8,
    BlPresentFlag: true,
    Codec: 'hevc',
    DvBlSignalCompatibilityId: 0,
    DvProfile: 8,
    Profile: 'Main',
    RpuPresentFlag: true,
    VideoRangeType: 'DOVIInvalid'
} as const;

const PROFILE_5_MAIN_STREAM = {
    BitDepth: 8,
    BlPresentFlag: true,
    Codec: 'hevc',
    DvBlSignalCompatibilityId: 0,
    DvProfile: 5,
    Profile: 'Main',
    RpuPresentFlag: true,
    VideoRangeType: 'DOVI'
} as const;

const PROFILE_7_MAIN10_STREAM = {
    BitDepth: 10,
    BlPresentFlag: true,
    Codec: 'hevc',
    DvBlSignalCompatibilityId: 0,
    DvProfile: 7,
    ElPresentFlag: true,
    Profile: 'Main 10',
    RpuPresentFlag: true,
    VideoRangeType: 'DOVIWithEL'
} as const;

const PROFILE_8_MAIN10_STREAM = {
    BitDepth: 10,
    BlPresentFlag: true,
    Codec: 'hevc',
    DvBlSignalCompatibilityId: 0,
    DvProfile: 8,
    Profile: 'Main 10',
    RpuPresentFlag: true,
    VideoRangeType: 'DOVIInvalid'
} as const;

const PROFILE_10_0_STREAM = {
    BitDepth: 10,
    BlPresentFlag: true,
    Codec: 'av1',
    DvBlSignalCompatibilityId: 0,
    DvProfile: 10,
    Profile: 'Main',
    RpuPresentFlag: true,
    VideoRangeType: 'DOVI'
} as const;

// Reconstructs from its RPU before its declared PQ base
const PROFILE_10_1_STREAM = {
    BitDepth: 10,
    BlPresentFlag: true,
    Codec: 'av1',
    ColorPrimaries: 'bt2020',
    ColorSpace: 'bt2020nc',
    ColorTransfer: 'smpte2084',
    DvBlSignalCompatibilityId: 1,
    DvProfile: 10,
    ElPresentFlag: false,
    Profile: 'Main',
    RpuPresentFlag: true,
    VideoRange: 'HDR',
    VideoRangeType: 'DOVIWithHDR10'
} as const;

const RAW_PQ_ROUTE_KEY = 'I420P10:bt2020-ncl:bt2020:limited:pq';
const RAW_SDR_ROUTE_KEY = 'I420P10:bt709:bt709:limited:sdr';
const EXTERNAL_PQ_ROUTE_KEY = 'external-hevc-main10-bt709-limited:pq-v1';
const EXTERNAL_HLG_ROUTE_KEY = 'external-hevc-main10-bt709-limited:hlg-v1';

function getLastEligibilityOptions(): Record<string, unknown> | undefined {
    return vi.mocked(getCustomPlaybackEligibility).mock.lastCall?.[2];
}

function createNativeCompatibleProfile(): Record<string, unknown> {
    return {
        CodecProfiles: [],
        ContainerProfiles: [],
        DirectPlayProfiles: [ {
            AudioCodec: 'aac',
            Container: 'mp4',
            Type: 'Video',
            VideoCodec: 'h264'
        } ],
        Name: 'HTML profile'
    };
}

function createNativeCompatiblePlayOptions(): Record<string, unknown> {
    return {
        item: { Id: 'item' },
        mediaSource: {
            Container: 'mp4',
            DefaultAudioStreamIndex: 1,
            MediaStreams: [
                {
                    Codec: 'h264',
                    Index: 0,
                    Type: 'Video',
                    VideoRangeType: 'SDR'
                },
                { Codec: 'aac', Index: 1, Type: 'Audio' }
            ],
            RunTimeTicks: 60_000_000,
            SupportsDirectPlay: true
        },
        playMethod: 'DirectPlay',
        url: '/Videos/item/stream.mp4'
    };
}

describe('WebGPUPlayer HTML delegation', () => {
    beforeEach(() => {
        htmlPlayerMockState.instances.length = 0;
        htmlPlayerMockState.owners.length = 0;
        htmlPlayerMockState.constructorOptions.length = 0;
        presenterMockState.instances.length = 0;
        presenterMockState.authorizedExternalHDRRouteKeys = [];
        presenterMockState.authorizedRawHDRRouteKeys = [];
        presenterMockState.dolbyVisionAuthorized = false;
        playbackPreferencesMockState.customDecodeEnabled = false;
        playbackPreferencesMockState.customDecodeEnabledPromises.length = 0;
        playbackPreferencesMockState.hdrToneMappingEnabled = false;
        playbackPreferencesMockState.refreshWebGPUPlaybackPreferences.mockReset();
        playbackPreferencesMockState.storedCustomDecodeEnabled = null;
        userSettingsMockState.audioNormalizationMode = 'TrackGain';
        userSettingsMockState.audioDownmixAlgorithm = 'standard-lo-ro';
        userSettingsMockState.webGPUPlaybackSettings = null;
        customDecodeMockState.audioEligibilityOverride = null;
        customDecodeMockState.eligible = false;
        customDecodeMockState.holdPlay = false;
        customDecodeMockState.discardDolbyVisionEnhancementLayer = false;
        customDecodeMockState.dolbyVision = false;
        customDecodeMockState.dolbyVisionProfile7HDR10Base = false;
        customDecodeMockState.dolbyVisionProfile7 = false;
        customDecodeMockState.dolbyVisionProfile8HDR10Base = false;
        customDecodeMockState.dolbyVisionProfile8HLGBase = false;
        customDecodeMockState.hdr = false;
        customDecodeMockState.nativeHDRTransfer = null;
        customDecodeMockState.neutralizeHDRColorMetadata = false;
        customDecodeMockState.audioOutputMode = 'decoded-pcm';
        customDecodeMockState.audioSourceChannelCount = 2;
        customDecodeMockState.audioTrackIndex = null;
        customDecodeMockState.instances.length = 0;
        customDecodeMockState.startupFallback = false;
        customDecodeMockState.videoDecoderBackend = 'native';
        customDecodeMockState.videoOutputMode = 'video-frame';
        customProfileMockState.augmentationCalls.length = 0;
        customProfileMockState.runtimeAvailable = true;
        customProfileMockState.workerAvailable = false;
        animationFrameMockState.callbacks.clear();
        animationFrameMockState.nextIdentifier = 1;
        audioPrewarmMockState.factoryLeases.length = 0;
        audioPrewarmMockState.leases.length = 0;
        audioPrewarmMockState.nextClosePromise = null;
        audioPrewarmMockState.maximumChannelCount = 2;
        audioPrewarmMockState.sampleRates.length = 0;
        nativeAudioCapabilityMockState.capabilities = null;
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback): number => {
            const identifier = animationFrameMockState.nextIdentifier;
            animationFrameMockState.nextIdentifier += 1;
            animationFrameMockState.callbacks.set(identifier, callback);
            return identifier;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn((identifier: number): void => {
            animationFrameMockState.callbacks.delete(identifier);
        }));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('owns exactly one HTML backend with the wrapper as manager identity', () => {
        const player = new WebGPUPlayer();

        expect(htmlPlayerMockState.instances).toHaveLength(1);
        expect(htmlPlayerMockState.owners).toEqual([player]);
        expect(htmlPlayerMockState.constructorOptions).toEqual([{
            forceCustomSubtitleElements: true,
            useWebGPUHLSRuntime: true
        }]);
        expect(player.id).toBe('webgpuplayer');
        expect(player.syncPlayWrapAs).toBe('htmlvideoplayer');
        expect(player.priority).toBe(0);
        expect(player.getMaxStreamingBitrate()).toBeNull();
        expect(player.getMaxStreamingBitrate({
            fallbackBitrate: 25_000_000,
            purpose: 'transcode-output'
        })).toBe(25_000_000);
    });

    it('keeps player selection synchronous and safe when called unbound', () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const canPlayMediaType = player.canPlayMediaType;
        const item = { Id: 'item' };
        const playOptions = { fullscreen: true };
        const canPlayItem = vi.fn(() => false);
        backend.canPlayItem = canPlayItem;

        expect(canPlayMediaType('Video')).toBe(true);
        expect(canPlayMediaType('Audio')).toBe(false);
        expect(player.canPlayItem(item, playOptions)).toBe(false);
        expect(canPlayItem).toHaveBeenCalledWith(item, playOptions);
        expect(backend.canPlayMediaType).toHaveBeenCalledTimes(2);
    });

    it.each([
        [ 'interlaced MPEG-2', createPlaybackSelectionItem('mpeg2-interlaced', {
            AverageFrameRate: 29.97003,
            BitDepth: 8,
            Codec: 'MPEG2VIDEO',
            Height: 480,
            IsInterlaced: true,
            Profile: 'Main',
            Width: 720
        }, [{
            Channels: 2,
            Codec: 'AC3',
            Index: 1,
            SampleRate: 48_000,
            Type: 'Audio'
        }]) ],
        // 10-bit AV1 SDR presents only through raw planes, whose SDR keys are BT.709 only
        [ '10-bit BT.601 SDR AV1 with Opus 5.1', createPlaybackSelectionItem('av1-10bit-bt601-sdr', {
            AverageFrameRate: 24,
            BitDepth: 10,
            Codec: 'AV1',
            ColorPrimaries: 'smpte170m',
            ColorSpace: 'smpte170m',
            ColorTransfer: 'smpte170m',
            Height: 1_632,
            Profile: 'Main',
            Width: 3_840
        }, [{
            Channels: 6,
            Codec: 'OPUS',
            Index: 1,
            SampleRate: 48_000,
            Type: 'Audio'
        }]) ]
    ])('declines exact unsupported %s item metadata only when custom decode is enabled', (
        _label,
        item
    ) => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const canPlayItem = vi.fn(() => true);
        backend.canPlayItem = canPlayItem;
        const playOptions = { fullscreen: true };

        playbackPreferencesMockState.customDecodeEnabled = false;
        expect(player.canPlayItem(item, playOptions)).toBe(true);
        playbackPreferencesMockState.customDecodeEnabled = true;
        expect(player.canPlayItem(item, playOptions)).toBe(false);
        expect(canPlayItem).toHaveBeenCalledTimes(2);
        expect(canPlayItem).toHaveBeenLastCalledWith(item, playOptions);
    });

    it('keeps 10-bit BT.709 SDR AV1 for the raw I420P10 route', () => {
        const player = new WebGPUPlayer();
        const canPlayItem = vi.fn(() => true);
        getBackend().canPlayItem = canPlayItem;
        const playOptions = { fullscreen: true };
        // Unspecified color is BT.709 for SDR
        const item = createPlaybackSelectionItem('av1-10bit-sdr', {
            AverageFrameRate: 24,
            BitDepth: 10,
            Codec: 'AV1',
            Height: 1_632,
            Profile: 'Main',
            Width: 3_840
        }, [{
            Channels: 6,
            Codec: 'OPUS',
            Index: 1,
            SampleRate: 48_000,
            Type: 'Audio'
        }]);

        playbackPreferencesMockState.customDecodeEnabled = true;
        expect(player.canPlayItem(item, playOptions)).toBe(true);
        expect(canPlayItem).toHaveBeenCalledWith(item, playOptions);
    });

    it('selects with the stored custom decode preference ahead of the negotiation that adopts it', () => {
        const player = new WebGPUPlayer();
        getBackend().canPlayItem = vi.fn(() => true);
        const playOptions = { fullscreen: true };
        const item = createPlaybackSelectionItem('mpeg2-interlaced', {
            AverageFrameRate: 29.97003,
            BitDepth: 8,
            Codec: 'MPEG2VIDEO',
            Height: 480,
            IsInterlaced: true,
            Profile: 'Main',
            Width: 720
        }, [{
            Channels: 2,
            Codec: 'AC3',
            Index: 1,
            SampleRate: 48_000,
            Type: 'Audio'
        }]);

        playbackPreferencesMockState.customDecodeEnabled = false;
        playbackPreferencesMockState.storedCustomDecodeEnabled = true;
        expect(player.canPlayItem(item, playOptions)).toBe(false);

        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.storedCustomDecodeEnabled = false;
        expect(player.canPlayItem(item, playOptions)).toBe(true);
    });

    it('keeps high-frame-rate progressive MPEG-2 metadata eligible with custom decode enabled', () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const canPlayItem = vi.fn(() => true);
        backend.canPlayItem = canPlayItem;
        const playOptions = { fullscreen: true };
        const item = createPlaybackSelectionItem('mpeg2-30fps', {
            AverageFrameRate: 29.97003,
            BitDepth: 8,
            Codec: 'MPEG2VIDEO',
            Height: 540,
            Profile: 'Main',
            Width: 720
        });

        playbackPreferencesMockState.customDecodeEnabled = true;
        expect(player.canPlayItem(item, playOptions)).toBe(true);
        expect(canPlayItem).toHaveBeenCalledOnce();
        expect(canPlayItem).toHaveBeenCalledWith(item, playOptions);
    });

    it('contributes one plugin-owned playback settings action', () => {
        const player = new WebGPUPlayer();

        expect(player.getSettingsMenuItems()).toEqual([ expect.objectContaining({
            id: 'webgpu-playback-settings',
            name: 'WebGPU Settings',
            onSelect: expect.any(Function)
        }) ]);
        expect(player.getSettingsMenuItems()[0]).not.toHaveProperty('secondaryText');
    });

    it('keeps exact VC-1 video available while later checks own audio and subtitles', () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const canPlayItem = vi.fn(() => true);
        backend.canPlayItem = canPlayItem;
        const item = createPlaybackSelectionItem('vc1', {
            AverageFrameRate: 23.976,
            BitDepth: 8,
            Codec: 'VC1',
            Profile: 'Advanced'
        }, [{
            Channels: 6,
            Codec: 'TRUEHD',
            Index: 1,
            SampleRate: 48_000,
            Type: 'Audio'
        }, {
            Codec: 'PGSSUB',
            Index: 2,
            Type: 'Subtitle'
        }]);
        const playOptions = { fullscreen: true };

        playbackPreferencesMockState.customDecodeEnabled = true;
        expect(player.canPlayItem(item, playOptions)).toBe(true);
        expect(canPlayItem).toHaveBeenCalledOnce();
        expect(canPlayItem).toHaveBeenCalledWith(item, playOptions);
    });

    it('delegates profile and source objects without mutation', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const item = { Id: 'item' };
        const profileOptions = { MaxStreamingBitrate: 1 };
        const playOptions = {
            url: '/Videos/item/stream',
            mediaSource: { Id: 'source' }
        };

        const playbackProfile = await player.getDeviceProfile(item, profileOptions);
        expect(playbackProfile).toEqual(backend.profile);
        expect(playbackProfile).not.toBe(backend.profile);
        await expect(player.play(playOptions)).resolves.toBe(playOptions);
        expect(backend.getDeviceProfile).toHaveBeenCalledWith(item, profileOptions);
        expect(backend.play).toHaveBeenCalledWith(playOptions);
    });

    it('blocks Profile 7 enhancement layer video stream copy before negotiation', () => {
        const player = new WebGPUPlayer();
        const item = createPlaybackSelectionItem('dolby-vision', {
            BlPresentFlag: true,
            Codec: 'HEVC',
            DvBlSignalCompatibilityId: 6,
            DvProfile: 7,
            ElPresentFlag: true,
            RpuPresentFlag: true,
            VideoRange: 'HDR',
            VideoRangeType: 'DOVIWithEL'
        });

        expect(player.supportsVideoStreamCopy(
            item,
            'dolby-vision-source'
        )).toBe(false);
    });

    it('blocks Dolby Vision copy from the full streams fetched for negotiation', () => {
        const player = new WebGPUPlayer();
        const mediaStreams = [{
            BlPresentFlag: true,
            Codec: 'HEVC',
            DvBlSignalCompatibilityId: 6,
            DvProfile: 7,
            ElPresentFlag: true,
            RpuPresentFlag: true,
            Type: 'Video',
            VideoRange: 'HDR',
            VideoRangeType: 'DOVIWithEL'
        }];

        expect(player.supportsVideoStreamCopy(
            { Id: 'sparse-playback-item' },
            'dolby-vision-source',
            mediaStreams
        )).toBe(false);
    });

    it('scopes the Dolby Vision stream-copy block to the selected source', () => {
        const player = new WebGPUPlayer();
        const item = {
            MediaSources: [
                {
                    Id: 'dolby-vision-source',
                    MediaStreams: [{
                        BlPresentFlag: true,
                        Codec: 'HEVC',
                        DvBlSignalCompatibilityId: 1,
                        DvProfile: 8,
                        ElPresentFlag: false,
                        RpuPresentFlag: true,
                        Type: 'Video',
                        VideoRange: 'HDR',
                        VideoRangeType: 'DOVIWithHDR10'
                    }]
                },
                {
                    Id: 'sdr-source',
                    MediaStreams: [{
                        Codec: 'HEVC',
                        Type: 'Video',
                        VideoRangeType: 'SDR'
                    }]
                }
            ]
        };

        expect(player.supportsVideoStreamCopy(
            item,
            'dolby-vision-source'
        )).toBe(false);
        expect(player.supportsVideoStreamCopy(item, 'sdr-source')).toBe(true);
        expect(player.supportsVideoStreamCopy(item, 'unknown-source')).toBe(true);
    });

    it('blocks AV1 Profile 10 video stream copy like any Dolby Vision source', () => {
        const player = new WebGPUPlayer();
        const item = createPlaybackSelectionItem('dolby-vision-av1', {
            BitDepth: 10,
            BlPresentFlag: true,
            Codec: 'AV1',
            DvBlSignalCompatibilityId: 1,
            DvProfile: 10,
            ElPresentFlag: false,
            Profile: 'Main',
            RpuPresentFlag: true,
            VideoRange: 'HDR',
            VideoRangeType: 'DOVIWithHDR10'
        });

        expect(player.supportsVideoStreamCopy(item, 'dolby-vision-av1-source')).toBe(false);
    });

    it('widens a custom-decode profile only when enabled and never on retry', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const item = { Id: 'item' };
        playbackPreferencesMockState.customDecodeEnabled = true;

        const profile = await player.getDeviceProfile(item, { isRetry: false }) as {
            CustomDecode?: boolean
        };
        expect(profile.CustomDecode).toBe(true);
        expect(profile).not.toBe(backend.profile);
        expect(customProfileMockState.augmentationCalls[0]).toEqual({
            options: {
                allowDolbyVision: false,
                allowDolbyVisionProfile4: false,
                allowDolbyVisionProfile7: false,
                allowNativeDolbyVision: false,
                allowNativeHDR: false,
                allowRawHDR: false,
                allowRawSDR: false,
                authorizedExternalHDRRouteKeys: [],
                authorizedRawHDRRouteKeys: [],
                isRetry: false,
                nativeMediaAudioCapabilities: null
            },
            profile: backend.profile
        });

        await player.getDeviceProfile(item, { isRetry: true });
        expect(customProfileMockState.augmentationCalls[1]?.options).toEqual({
            allowDolbyVision: false,
            allowDolbyVisionProfile4: false,
            allowDolbyVisionProfile7: false,
            allowNativeDolbyVision: false,
            allowNativeHDR: false,
            allowRawHDR: false,
            allowRawSDR: false,
            authorizedExternalHDRRouteKeys: [],
            authorizedRawHDRRouteKeys: [],
            isRetry: true,
            nativeMediaAudioCapabilities: null
        });
        expect(player.getCustomDeviceProfileTelemetry()).toMatchObject({
            reason: 'augmented',
            supportedVideoCodecs: [ 'h264' ]
        });
    });

    it('adopts the stored playback preferences for each new negotiation but not for a retry', async () => {
        const player = new WebGPUPlayer();
        const item = { Id: 'item' };
        // The user enabled custom decode after the last negotiation
        playbackPreferencesMockState.refreshWebGPUPlaybackPreferences.mockImplementationOnce((): void => {
            playbackPreferencesMockState.customDecodeEnabled = true;
        });

        const profile = await player.getDeviceProfile(item, { isRetry: false }) as {
            CustomDecode?: boolean
        };
        await player.getDeviceProfile(item, { isRetry: true });

        expect(profile.CustomDecode).toBe(true);
        expect(playbackPreferencesMockState.refreshWebGPUPlaybackPreferences).toHaveBeenCalledTimes(1);

        await player.getDeviceProfile(item, { isRetry: false });
        expect(playbackPreferencesMockState.refreshWebGPUPlaybackPreferences).toHaveBeenCalledTimes(2);
    });

    it('advertises locked ASS and PGS renderers without the HTML PGS profile flag', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        Object.assign(backend.profile, {
            SubtitleProfiles: [ { Format: 'vtt', Method: 'External' } ]
        });
        playbackPreferencesMockState.customDecodeEnabled = true;
        customProfileMockState.workerAvailable = true;
        const getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
            .mockReturnValue({} as CanvasRenderingContext2D & GPUCanvasContext);

        try {
            await player.getDeviceProfile({ Id: 'subtitle-item' }, { isRetry: false });
            await player.getDeviceProfile({ Id: 'subtitle-item' }, { isRetry: true });
        } finally {
            getContextSpy.mockRestore();
        }

        expect(customProfileMockState.augmentationCalls[0]?.options).toMatchObject({
            isRetry: false,
            subtitleCapabilities: {
                externalASS: true,
                externalPGS: true,
                externalText: true
            }
        });
        expect(customProfileMockState.augmentationCalls[1]?.options)
            .not.toHaveProperty('subtitleCapabilities');
    });

    it('passes a partial native-media audio capability into non-retry profile augmentation', async () => {
        const player = new WebGPUPlayer();
        const capabilities = createPartialNativeMediaAudioCapabilities();
        playbackPreferencesMockState.customDecodeEnabled = true;
        nativeAudioCapabilityMockState.capabilities = capabilities;

        await player.getDeviceProfile({ Id: 'native-audio-item' }, { isRetry: false });

        expect(customProfileMockState.augmentationCalls[0]?.options).toMatchObject({
            isRetry: false,
            nativeMediaAudioCapabilities: capabilities
        });
        expect(player.getNativeMediaAudioCapabilities()).toEqual(capabilities);
    });

    it('does not pass a measured native-media audio capability into retry widening', async () => {
        const player = new WebGPUPlayer();
        const capabilities = createPartialNativeMediaAudioCapabilities();
        playbackPreferencesMockState.customDecodeEnabled = true;
        nativeAudioCapabilityMockState.capabilities = capabilities;

        await player.getDeviceProfile({ Id: 'native-audio-item' }, { isRetry: true });

        expect(customProfileMockState.augmentationCalls[0]?.options).toMatchObject({
            isRetry: true,
            nativeMediaAudioCapabilities: null
        });
        expect(player.getNativeMediaAudioCapabilities()).toBeNull();
    });

    it('scopes the capability probes to the negotiated item', async () => {
        const player = new WebGPUPlayer();
        const item = {
            Id: 'scoped-item',
            MediaSources: [ { MediaStreams: [ { Codec: 'hevc', Type: 'Video' } ] } ]
        };
        playbackPreferencesMockState.customDecodeEnabled = true;
        vi.mocked(probeCustomDecodeCapabilities).mockClear();

        await player.getDeviceProfile(item, { isRetry: false });

        expect(probeCustomDecodeCapabilities).toHaveBeenCalledExactlyOnceWith(item);
    });

    it('widens custom profile HDR ranges only when raw HDR presentation is enabled', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.authorizedRawHDRRouteKeys = [
            RAW_PQ_ROUTE_KEY
        ];

        await player.getDeviceProfile({ Id: 'item' }, { isRetry: false });

        expect(customProfileMockState.augmentationCalls[0]).toEqual({
            options: {
                allowDolbyVision: false,
                allowDolbyVisionProfile4: false,
                allowDolbyVisionProfile7: false,
                allowNativeDolbyVision: false,
                allowNativeHDR: false,
                allowRawHDR: true,
                allowRawSDR: false,
                authorizedExternalHDRRouteKeys: [],
                authorizedRawHDRRouteKeys: [
                    RAW_PQ_ROUTE_KEY
                ],
                isRetry: false,
                nativeMediaAudioCapabilities: null
            },
            profile: backend.profile
        });
    });

    it('keeps exact raw HDR authorization when native Main10 is also authorized', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.authorizedExternalHDRRouteKeys = [
            EXTERNAL_PQ_ROUTE_KEY
        ];
        presenterMockState.authorizedRawHDRRouteKeys = [
            RAW_PQ_ROUTE_KEY
        ];

        await player.getDeviceProfile({ Id: 'native-hdr-item' }, { isRetry: false });

        expect(presenter.waitForExternalHDRAuthorizationPrewarm).toHaveBeenCalledOnce();
        expect(customProfileMockState.augmentationCalls[0]).toEqual({
            options: {
                allowDolbyVision: false,
                allowDolbyVisionProfile4: false,
                allowDolbyVisionProfile7: false,
                allowNativeDolbyVision: false,
                allowNativeHDR: true,
                allowRawHDR: true,
                allowRawSDR: false,
                authorizedExternalHDRRouteKeys: [
                    EXTERNAL_PQ_ROUTE_KEY
                ],
                authorizedRawHDRRouteKeys: [
                    RAW_PQ_ROUTE_KEY
                ],
                isRetry: false,
                nativeMediaAudioCapabilities: null
            },
            profile: backend.profile
        });
    });

    it('probes only native HDR first for an exact static HDR item', async () => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.authorizedExternalHDRRouteKeys = [
            EXTERNAL_PQ_ROUTE_KEY
        ];

        await player.getDeviceProfile({
            Id: 'exact-static-hdr-item',
            MediaSources: [{
                MediaStreams: [{
                    BitDepth: 10,
                    Codec: 'hevc',
                    ColorPrimaries: 'bt2020',
                    ColorRange: 'limited',
                    ColorSpace: 'bt2020-ncl',
                    ColorTransfer: 'smpte2084',
                    Type: 'Video',
                    VideoRange: 'HDR',
                    VideoRangeType: 'HDR10'
                }]
            }]
        }, { isRetry: false });

        expect(presenter.waitForExternalHDRAuthorizationPrewarm).toHaveBeenCalledOnce();
        expect(presenter.waitForRawHDRAuthorizationPrewarm).not.toHaveBeenCalled();
        expect(presenter.waitForDolbyVisionAuthorizationPrewarm).not.toHaveBeenCalled();
        expect(customProfileMockState.augmentationCalls[0]?.options).toMatchObject({
            allowNativeHDR: true,
            allowRawHDR: false
        });
    });

    it('probes raw HDR only when native HDR authorization is unavailable', async () => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.authorizedRawHDRRouteKeys = [
            RAW_PQ_ROUTE_KEY
        ];

        await player.getDeviceProfile({
            Id: 'raw-hdr-fallback-item',
            MediaStreams: [{
                BitDepth: 10,
                Codec: 'hevc',
                ColorPrimaries: 'bt2020',
                ColorSpace: 'bt2020-ncl',
                ColorTransfer: 'smpte2084',
                Type: 'Video',
                VideoRange: 'HDR',
                VideoRangeType: 'HDR10'
            }]
        }, { isRetry: false });

        expect(presenter.waitForExternalHDRAuthorizationPrewarm).toHaveBeenCalledOnce();
        expect(presenter.waitForRawHDRAuthorizationPrewarm).toHaveBeenCalledOnce();
        expect(presenter.waitForDolbyVisionAuthorizationPrewarm).not.toHaveBeenCalled();
        expect(customProfileMockState.augmentationCalls[0]?.options).toMatchObject({
            allowNativeHDR: false,
            allowRawHDR: true
        });
    });

    it('isolates Dolby Vision authorization from static HDR probes', async () => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.dolbyVisionAuthorized = true;

        // Profile 5 has no base the static HDR routes could present on its own
        await player.getDeviceProfile({
            Id: 'exact-dolby-vision-item',
            MediaSources: [{
                MediaStreams: [{
                    BitDepth: 10,
                    BlPresentFlag: true,
                    Codec: 'hevc',
                    DvBlSignalCompatibilityId: 0,
                    DvProfile: 5,
                    ElPresentFlag: false,
                    Profile: 'Main 10',
                    RpuPresentFlag: true,
                    Type: 'Video',
                    VideoRange: 'HDR',
                    VideoRangeType: 'DOVI'
                }]
            }]
        }, { isRetry: false });

        expect(presenter.waitForExternalHDRAuthorizationPrewarm).not.toHaveBeenCalled();
        expect(presenter.waitForRawHDRAuthorizationPrewarm).not.toHaveBeenCalled();
        expect(presenter.waitForDolbyVisionAuthorizationPrewarm).toHaveBeenCalledOnce();
        expect(presenter.waitForDolbyVisionAuthorizationPrewarm).toHaveBeenCalledWith({
            profile: 5,
            rawFrameFormat: 'I420P10'
        });
        expect(customProfileMockState.augmentationCalls[0]?.options).toMatchObject({
            allowDolbyVision: true,
            allowNativeDolbyVision: true,
            allowNativeHDR: false,
            allowRawHDR: false
        });
    });

    it.each([
        {
            authorizedExternalHDRRouteKeys: [ EXTERNAL_PQ_ROUTE_KEY ],
            expectedRawHDRProbeCount: 0,
            name: 'native external'
        },
        {
            authorizedExternalHDRRouteKeys: [],
            expectedRawHDRProbeCount: 1,
            name: 'raw planes'
        }
    ])('probes the declared HDR base of an inexact Dolby Vision item through $name', async ({
        authorizedExternalHDRRouteKeys,
        expectedRawHDRProbeCount
    }) => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.dolbyVisionAuthorized = true;
        presenterMockState.authorizedExternalHDRRouteKeys = authorizedExternalHDRRouteKeys;
        presenterMockState.authorizedRawHDRRouteKeys = [
            RAW_PQ_ROUTE_KEY
        ];
        // Without explicit colors this Profile 8.1 base is not an exact native base, only a declared PQ one
        const mediaStream = {
            BitDepth: 10,
            BlPresentFlag: true,
            Codec: 'hevc',
            DvBlSignalCompatibilityId: 1,
            DvProfile: 8,
            ElPresentFlag: false,
            Profile: 'Main 10',
            RpuPresentFlag: true,
            Type: 'Video',
            VideoRange: 'HDR',
            VideoRangeType: 'DOVIWithHDR10'
        };

        await player.getDeviceProfile({
            Id: 'declared-base-dolby-vision-item',
            MediaSources: [{ MediaStreams: [ mediaStream ] }]
        }, { isRetry: false });

        expect(presenter.waitForExternalHDRAuthorizationPrewarm).toHaveBeenCalledOnce();
        expect(presenter.waitForRawHDRAuthorizationPrewarm)
            .toHaveBeenCalledTimes(expectedRawHDRProbeCount);
        expect(presenter.waitForDolbyVisionAuthorizationPrewarm).toHaveBeenCalledWith({
            profile: 8,
            rawFrameFormat: 'I420P10'
        });
        expect(customProfileMockState.augmentationCalls[0]?.options).toMatchObject({
            allowDolbyVision: true,
            allowNativeHDR: authorizedExternalHDRRouteKeys.length > 0,
            allowRawHDR: true,
            itemMediaSource: { MediaStreams: [ mediaStream ] }
        });
        expect(customProfileMockState.augmentationCalls[0]?.options)
            .not.toHaveProperty('allowNativeDolbyVisionProfile8HDR10Base');
    });

    it('advertises a Profile 4 item only after its exact-device authorization', async () => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.dolbyVisionAuthorized = true;

        await player.getDeviceProfile({
            Id: 'profile-4-item',
            MediaSources: [{
                MediaStreams: [{
                    BitDepth: 10,
                    BlPresentFlag: true,
                    Codec: 'hevc',
                    DvBlSignalCompatibilityId: 2,
                    DvProfile: 4,
                    ElPresentFlag: true,
                    Profile: 'Main 10',
                    RpuPresentFlag: true,
                    Type: 'Video',
                    VideoRange: 'SDR',
                    VideoRangeType: 'SDR'
                }]
            }]
        }, { isRetry: false });

        // The SDR base needs no static HDR probe, and Profile 4 authorizes on first use
        expect(presenter.waitForExternalHDRAuthorizationPrewarm).not.toHaveBeenCalled();
        expect(presenter.waitForRawHDRAuthorizationPrewarm).not.toHaveBeenCalled();
        expect(presenter.waitForDolbyVisionAuthorizationPrewarm).toHaveBeenCalledWith({
            profile: 4,
            rawFrameFormat: 'I420P10'
        });
        expect(presenter.isRawDolbyVisionProfile4PresentationAuthorized).toHaveBeenCalled();
        expect(customProfileMockState.augmentationCalls[0]?.options).toMatchObject({
            allowDolbyVisionProfile4: true,
            itemMediaSource: expect.objectContaining({ MediaStreams: expect.any(Array) })
        });
    });

    it.each([
        {
            label: 'Profile 7 over a 10-bit 4:2:2 range extension',
            mediaStream: { ...PROFILE_7_RANGE_EXTENSION_STREAM, Type: 'Video' },
            target: { profile: 7, rawFrameFormat: 'I422P10' }
        },
        {
            label: 'Profile 4 over an 8-bit Main base',
            mediaStream: { ...PROFILE_4_MAIN_STREAM, Type: 'Video' },
            target: { profile: 4, rawFrameFormat: 'I420' }
        }
    ])('authorizes $label for negotiation in its own raw format', async ({ mediaStream, target }) => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.dolbyVisionAuthorized = true;

        await player.getDeviceProfile({
            Id: 'dual-layer-item',
            MediaSources: [{ MediaStreams: [ mediaStream ] }]
        }, { isRetry: false });

        // Every dual-layer key outside the default prewarm authorizes on first use
        expect(presenter.waitForDolbyVisionAuthorizationPrewarm).toHaveBeenCalledWith(target);
        expect(presenter.isRawDolbyVisionProfile4PresentationAuthorized).toHaveBeenCalledWith(target.rawFrameFormat);
        expect(presenter.isRawDolbyVisionProfile7PresentationAuthorized).toHaveBeenCalledWith(target.rawFrameFormat);
        expect(customProfileMockState.augmentationCalls[0]?.options).toMatchObject({
            allowDolbyVisionProfile4: true,
            allowDolbyVisionProfile7: true,
            itemMediaSource: { MediaStreams: [ mediaStream ] }
        });
    });

    it('checks the generic dual-layer authorizations in I420P10 without an item route', async () => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.dolbyVisionAuthorized = true;

        await player.getDeviceProfile({ Id: 'unknown-metadata-item' }, { isRetry: false });

        expect(presenter.isRawDolbyVisionPresentationAuthorized).toHaveBeenCalledWith('I420P10');
        expect(presenter.isRawDolbyVisionProfile4PresentationAuthorized).toHaveBeenCalledWith('I420P10');
        expect(presenter.isRawDolbyVisionProfile7PresentationAuthorized).toHaveBeenCalledWith('I420P10');
    });

    it.each([
        { codec: 'av1', profile: 'Main' },
        { codec: 'vp9', profile: 'Profile 2' }
    ])('waits for raw HDR for a static HDR $codec item although native HDR is authorized', async ({
        codec,
        profile
    }) => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.authorizedExternalHDRRouteKeys = [
            EXTERNAL_PQ_ROUTE_KEY
        ];
        presenterMockState.authorizedRawHDRRouteKeys = [
            RAW_PQ_ROUTE_KEY
        ];

        await player.getDeviceProfile({
            Id: 'raw-only-static-hdr-item',
            MediaSources: [{
                MediaStreams: [{
                    BitDepth: 10,
                    Codec: codec,
                    ColorPrimaries: 'bt2020',
                    ColorRange: 'limited',
                    ColorSpace: 'bt2020-ncl',
                    ColorTransfer: 'smpte2084',
                    Profile: profile,
                    Type: 'Video',
                    VideoRange: 'HDR',
                    VideoRangeType: 'HDR10'
                }]
            }]
        }, { isRetry: false });

        // The native external route decodes HEVC Main 10 alone, so its authorization never covers this item
        expect(presenter.waitForExternalHDRAuthorizationPrewarm).toHaveBeenCalledOnce();
        expect(presenter.waitForRawHDRAuthorizationPrewarm).toHaveBeenCalledOnce();
        expect(presenter.waitForDolbyVisionAuthorizationPrewarm).not.toHaveBeenCalled();
        expect(customProfileMockState.augmentationCalls[0]?.options).toMatchObject({
            allowRawHDR: true,
            authorizedRawHDRRouteKeys: [ RAW_PQ_ROUTE_KEY ]
        });
    });

    it('waits once for raw HDR for an AV1 static HDR item without native HDR authorization', async () => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;

        await player.getDeviceProfile({
            Id: 'raw-only-static-hdr-item',
            MediaSources: [{ MediaStreams: [ { ...AV1_HDR10_STREAM, Type: 'Video' } ] }]
        }, { isRetry: false });

        expect(presenter.waitForExternalHDRAuthorizationPrewarm).toHaveBeenCalledOnce();
        expect(presenter.waitForRawHDRAuthorizationPrewarm).toHaveBeenCalledOnce();
    });

    it('starts the raw HDR wait of a raw-only item while the external wait is pending', async () => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        const externalHDRWait = createDeferred<void>();
        presenter.waitForExternalHDRAuthorizationPrewarm.mockImplementation(() => externalHDRWait.promise);

        const profilePromise = player.getDeviceProfile({
            Id: 'raw-only-static-hdr-item',
            MediaSources: [{ MediaStreams: [ { ...AV1_HDR10_STREAM, Type: 'Video' } ] }]
        }, { isRetry: false });
        await vi.waitFor(() => expect(presenter.waitForExternalHDRAuthorizationPrewarm).toHaveBeenCalledOnce());
        const rawHDRWaitCallCount = presenter.waitForRawHDRAuthorizationPrewarm.mock.calls.length;
        externalHDRWait.resolve();
        await profilePromise;

        expect(rawHDRWaitCallCount).toBe(1);
    });

    it('waits for raw HDR for the declared base of an AV1 Profile 10.1 item', async () => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.dolbyVisionAuthorized = true;
        presenterMockState.authorizedExternalHDRRouteKeys = [
            EXTERNAL_PQ_ROUTE_KEY
        ];
        presenterMockState.authorizedRawHDRRouteKeys = [
            RAW_PQ_ROUTE_KEY
        ];
        const mediaStream = { ...PROFILE_10_1_STREAM, ColorRange: 'tv', Type: 'Video' };

        await player.getDeviceProfile({
            Id: 'profile-10-1-item',
            MediaSources: [{ MediaStreams: [ mediaStream ] }]
        }, { isRetry: false });

        expect(presenter.waitForRawHDRAuthorizationPrewarm).toHaveBeenCalledOnce();
        expect(presenter.waitForDolbyVisionAuthorizationPrewarm).toHaveBeenCalledWith({
            profile: 8,
            rawFrameFormat: 'I420P10'
        });
        expect(presenter.isRawDolbyVisionPresentationAuthorized).toHaveBeenCalledWith('I420P10');
        expect(customProfileMockState.augmentationCalls[0]?.options).toMatchObject({
            allowDolbyVision: true,
            allowRawHDR: true,
            authorizedRawHDRRouteKeys: [ RAW_PQ_ROUTE_KEY ],
            itemMediaSource: { MediaStreams: [ mediaStream ] }
        });
    });

    it('waits only for Dolby Vision for an AV1 Profile 10.0 item, which declares no base', async () => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.dolbyVisionAuthorized = true;

        await player.getDeviceProfile({
            Id: 'profile-10-0-item',
            MediaSources: [{
                MediaStreams: [{
                    BitDepth: 10,
                    BlPresentFlag: true,
                    Codec: 'av1',
                    DvBlSignalCompatibilityId: 0,
                    DvProfile: 10,
                    ElPresentFlag: false,
                    Profile: 'Main',
                    RpuPresentFlag: true,
                    Type: 'Video',
                    VideoRange: 'HDR',
                    VideoRangeType: 'DOVI'
                }]
            }]
        }, { isRetry: false });

        expect(presenter.waitForExternalHDRAuthorizationPrewarm).not.toHaveBeenCalled();
        expect(presenter.waitForRawHDRAuthorizationPrewarm).not.toHaveBeenCalled();
        expect(presenter.waitForDolbyVisionAuthorizationPrewarm).toHaveBeenCalledWith({
            profile: 5,
            rawFrameFormat: 'I420P10'
        });
        expect(customProfileMockState.augmentationCalls[0]?.options).toMatchObject({
            allowDolbyVision: true,
            allowRawHDR: false
        });
    });

    it('waits for raw HDR for a range-extension Profile 8.1 item with an exact native base shape', async () => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.dolbyVisionAuthorized = true;
        presenterMockState.authorizedExternalHDRRouteKeys = [
            EXTERNAL_PQ_ROUTE_KEY
        ];
        presenterMockState.authorizedRawHDRRouteKeys = [
            'I422P10:bt2020-ncl:bt2020:limited:pq'
        ];

        // The native base route decodes HEVC Main 10 alone, so this 4:2:2 base presents only through raw planes
        await player.getDeviceProfile({
            Id: 'range-extension-profile-8-1-item',
            MediaSources: [{
                MediaStreams: [{
                    BitDepth: 10,
                    BlPresentFlag: true,
                    Codec: 'hevc',
                    ColorPrimaries: 'bt2020',
                    ColorRange: 'tv',
                    ColorSpace: 'bt2020nc',
                    ColorTransfer: 'smpte2084',
                    DvBlSignalCompatibilityId: 1,
                    DvProfile: 8,
                    ElPresentFlag: false,
                    PixelFormat: 'yuv422p10le',
                    Profile: 'Rext',
                    RpuPresentFlag: true,
                    Type: 'Video',
                    VideoRange: 'HDR',
                    VideoRangeType: 'DOVIWithHDR10'
                }]
            }]
        }, { isRetry: false });

        expect(presenter.waitForExternalHDRAuthorizationPrewarm).toHaveBeenCalledOnce();
        expect(presenter.waitForRawHDRAuthorizationPrewarm).toHaveBeenCalledOnce();
        expect(presenter.waitForDolbyVisionAuthorizationPrewarm).toHaveBeenCalledWith({
            profile: 8,
            rawFrameFormat: 'I422P10'
        });
        expect(customProfileMockState.augmentationCalls[0]?.options).toMatchObject({
            allowRawHDR: true,
            authorizedRawHDRRouteKeys: [ 'I422P10:bt2020-ncl:bt2020:limited:pq' ]
        });
    });

    it('widens Dolby Vision capability only after exact-device authorization', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.dolbyVisionAuthorized = true;

        await player.getDeviceProfile({ Id: 'dolby-vision-item' }, { isRetry: false });

        expect(presenter.waitForRawHDRAuthorizationPrewarm).toHaveBeenCalledOnce();
        expect(presenter.waitForDolbyVisionAuthorizationPrewarm).toHaveBeenCalledOnce();
        expect(customProfileMockState.augmentationCalls[0]).toEqual({
            options: {
                allowDolbyVision: true,
                allowDolbyVisionProfile4: true,
                allowDolbyVisionProfile7: true,
                allowNativeDolbyVision: true,
                allowNativeHDR: false,
                allowRawHDR: false,
                allowRawSDR: false,
                authorizedExternalHDRRouteKeys: [],
                authorizedRawHDRRouteKeys: [],
                isRetry: false,
                nativeMediaAudioCapabilities: null
            },
            profile: backend.profile
        });
    });

    it('authorizes Jellyfin HDR10 labeling only for one exact separate Profile 7 source', async () => {
        const player = new WebGPUPlayer();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.dolbyVisionAuthorized = true;
        const videoStreams = [
            {
                AverageFrameRate: 23.976025,
                BitDepth: 10,
                Codec: 'hevc',
                ColorPrimaries: 'bt2020',
                ColorSpace: 'bt2020nc',
                ColorTransfer: 'smpte2084',
                Height: 1_080,
                IsInterlaced: false,
                RealFrameRate: 11.988012,
                Type: 'Video',
                VideoRange: 'HDR',
                VideoRangeType: 'HDR10',
                Width: 1_920
            },
            {
                AverageFrameRate: 23.976025,
                BitDepth: 10,
                BlPresentFlag: 0,
                Codec: 'hevc',
                ColorPrimaries: 'bt2020',
                ColorSpace: 'bt2020nc',
                ColorTransfer: 'smpte2084',
                DvBlSignalCompatibilityId: 6,
                DvProfile: 7,
                ElPresentFlag: 1,
                Height: 1_080,
                IsInterlaced: false,
                RealFrameRate: 11.988012,
                RpuPresentFlag: 1,
                Type: 'Video',
                VideoRange: 'HDR',
                VideoRangeType: 'HDR10',
                Width: 1_920
            }
        ];

        await player.getDeviceProfile({
            Id: 'separate-profile-7-item',
            MediaSources: [{ MediaStreams: videoStreams }]
        }, { isRetry: false });

        expect(customProfileMockState.augmentationCalls[0]?.options).toMatchObject({
            allowDolbyVisionProfile7: true,
            allowDolbyVisionProfile7HDR10Base: true
        });

        await player.getDeviceProfile({
            Id: 'ambiguous-profile-7-item',
            MediaSources: [
                { MediaStreams: videoStreams },
                { MediaStreams: videoStreams }
            ]
        }, { isRetry: false });

        expect(customProfileMockState.augmentationCalls[1]?.options).not.toHaveProperty(
            'allowDolbyVisionProfile7HDR10Base'
        );
    });

    it('authorizes the native HDR10 base for one exact interleaved Profile 7 source', async () => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.dolbyVisionAuthorized = true;
        presenterMockState.authorizedExternalHDRRouteKeys = [
            EXTERNAL_PQ_ROUTE_KEY
        ];
        const playOptions = createKnownProfile7DolbyVisionPlayOptions();

        await player.getDeviceProfile({
            Id: 'interleaved-profile-7-item',
            MediaSources: [ playOptions.mediaSource ]
        }, { isRetry: false });

        expect(presenter.waitForExternalHDRAuthorizationPrewarm).toHaveBeenCalledOnce();
        expect(presenter.waitForDolbyVisionAuthorizationPrewarm).toHaveBeenCalledOnce();
        expect(presenter.waitForRawHDRAuthorizationPrewarm).not.toHaveBeenCalled();
        expect(customProfileMockState.augmentationCalls[0]?.options).toMatchObject({
            allowDolbyVisionProfile7: true,
            allowNativeDolbyVisionProfile7HDR10Base: true,
            allowNativeHDR: true,
            authorizedExternalHDRRouteKeys: [
                EXTERNAL_PQ_ROUTE_KEY
            ]
        });
    });

    it('authorizes the native HDR10 base for one exact Profile 8.1 source', async () => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.dolbyVisionAuthorized = true;
        presenterMockState.authorizedExternalHDRRouteKeys = [
            EXTERNAL_PQ_ROUTE_KEY
        ];
        const playOptions = createKnownProfile8HDR10BasePlayOptions();

        await player.getDeviceProfile({
            Id: 'profile-8-1-item',
            MediaSources: [ playOptions.mediaSource ]
        }, { isRetry: false });

        expect(presenter.waitForExternalHDRAuthorizationPrewarm).toHaveBeenCalledOnce();
        expect(presenter.waitForDolbyVisionAuthorizationPrewarm).toHaveBeenCalledOnce();
        expect(presenter.waitForRawHDRAuthorizationPrewarm).not.toHaveBeenCalled();
        expect(customProfileMockState.augmentationCalls[0]?.options).toMatchObject({
            allowDolbyVision: true,
            allowNativeDolbyVisionProfile8HDR10Base: true,
            allowNativeHDR: true,
            authorizedExternalHDRRouteKeys: [
                EXTERNAL_PQ_ROUTE_KEY
            ]
        });
    });

    it('authorizes the native HLG base for one exact Profile 8.4 source', async () => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.dolbyVisionAuthorized = true;
        presenterMockState.authorizedExternalHDRRouteKeys = [
            EXTERNAL_HLG_ROUTE_KEY
        ];
        const playOptions = createKnownProfile8HLGBasePlayOptions();

        await player.getDeviceProfile({
            Id: 'profile-8-4-item',
            MediaSources: [ playOptions.mediaSource ]
        }, { isRetry: false });

        expect(presenter.waitForExternalHDRAuthorizationPrewarm).toHaveBeenCalledOnce();
        expect(presenter.waitForDolbyVisionAuthorizationPrewarm).toHaveBeenCalledOnce();
        expect(presenter.waitForRawHDRAuthorizationPrewarm).not.toHaveBeenCalled();
        expect(customProfileMockState.augmentationCalls[0]?.options).toMatchObject({
            allowDolbyVision: true,
            allowNativeDolbyVisionProfile8HLGBase: true,
            allowNativeHDR: true,
            authorizedExternalHDRRouteKeys: [
                EXTERNAL_HLG_ROUTE_KEY
            ]
        });
        expect(customProfileMockState.augmentationCalls[0]?.options).not.toHaveProperty(
            'allowNativeDolbyVisionProfile8HDR10Base'
        );
    });

    it('does not authorize a Profile 8.4 base from only the external PQ route', async () => {
        const player = new WebGPUPlayer();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.dolbyVisionAuthorized = true;
        presenterMockState.authorizedExternalHDRRouteKeys = [
            EXTERNAL_PQ_ROUTE_KEY
        ];
        const playOptions = createKnownProfile8HLGBasePlayOptions();

        await player.getDeviceProfile({
            Id: 'profile-8-4-pq-only-item',
            MediaSources: [ playOptions.mediaSource ]
        }, { isRetry: false });

        expect(customProfileMockState.augmentationCalls[0]?.options).not.toHaveProperty(
            'allowNativeDolbyVisionProfile8HLGBase'
        );
    });

    it('keeps the native profile when the complete custom runtime is unavailable', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        playbackPreferencesMockState.customDecodeEnabled = true;
        customProfileMockState.runtimeAvailable = false;

        const playbackProfile = await player.getDeviceProfile({}, {});
        expect(playbackProfile).toEqual(backend.profile);
        expect(playbackProfile).not.toBe(backend.profile);
        expect(customProfileMockState.augmentationCalls).toHaveLength(0);
        expect(player.getCustomPlaybackRuntimeAvailability()).toMatchObject({
            available: false,
            reason: 'webgpu-unavailable'
        });
    });

    it('attaches the presenter after HTML playback and invalidates it on seek and stop', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };

        await player.play(createKnownSDRPlayOptions());
        expect(presenter.startSession).toHaveBeenCalledWith(1);
        expect(presenter.attach).toHaveBeenCalledWith(backend.presentationSurface, 1);

        player.currentTime(1_000);
        expect(presenter.seek).toHaveBeenCalledWith(2);
        player.setAspectRatio('cover');
        expect(presenter.refresh).toHaveBeenCalledWith(2);

        await player.stop(false);
        expect(presenter.endSession).toHaveBeenCalledWith(3);
    });

    it('uses eligible custom playback without starting the native media source', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        const options = createKnownSDRPlayOptions({ playMethod: 'DirectPlay' });
        await player.play(options);
        const customPlaybackController = getCustomPlaybackController();
        expect(backend.prepareCustomPlayback).toHaveBeenCalledWith(options);
        expect(backend.play).not.toHaveBeenCalled();
        expect(customPlaybackController.play).toHaveBeenCalledWith({
            audioOutputMode: undefined,
            audioTrackIndex: null,
            decodedAudioOutputChannelCount: undefined,
            dolbyVisionProfile: null,
            durationMicroseconds: 60_000_000,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: 1_000_000,
            url: 'http://localhost/video.mp4?api_key=custom-decode-secret',
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        });
        expect(presenter.setDecodedFramePushMode).toHaveBeenCalledWith(true, 1);
        expect(presenter.attach).toHaveBeenCalledWith(backend.presentationSurface, 1);
        const eligibilityTelemetry = player.getCustomPlaybackEligibility();
        expect(eligibilityTelemetry).toEqual({
            audioOutputMode: null,
            eligible: true,
            hdr: false,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        });
        expect(eligibilityTelemetry).not.toHaveProperty('url');
        expect(JSON.stringify(eligibilityTelemetry)).not.toContain('custom-decode-secret');

        player.currentTime(2_500);
        await Promise.resolve();
        expect(customPlaybackController.seek).toHaveBeenCalledWith(2_500_000);
        expect(presenter.seek).toHaveBeenCalledWith(2);

        await player.stop(false);
        expect(customPlaybackController.destroy).toHaveBeenCalledOnce();
        expect(backend.stop).toHaveBeenCalledOnce();
    });

    it('uses raw 10-bit frames for enabled custom HDR tone mapping', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.authorizedRawHDRRouteKeys = [
            RAW_PQ_ROUTE_KEY
        ];
        customDecodeMockState.eligible = true;
        customDecodeMockState.hdr = true;
        customDecodeMockState.videoDecoderBackend = 'bundled-hevc';
        customDecodeMockState.videoOutputMode = 'raw-planes';
        const defaults = createDefaultWebGPUUserSettings();
        userSettingsMockState.webGPUPlaybackSettings = JSON.stringify({
            ...defaults,
            render: {
                automaticInputPeakNits: false,
                settings: {
                    ...defaults.render.settings,
                    toneMapping: {
                        ...defaults.render.settings.toneMapping,
                        inputPeakNits: 2_500
                    }
                }
            }
        });

        const options = createKnownHDRPlayOptions({ playMethod: 'DirectPlay' });
        await player.play(options);
        const customPlaybackController = getCustomPlaybackController();

        expect(backend.play).not.toHaveBeenCalled();
        expect(presenter.configureColorPipeline).toHaveBeenCalledWith({
            automaticInputPeakNits: false,
            inputMode: 'raw-yuv',
            metadata: expect.objectContaining({
                bitDepth: 10,
                matrix: 'bt2020-ncl',
                primaries: 'bt2020',
                transfer: 'pq'
            }),
            rawFrameFormat: 'I420P10',
            settings: expect.objectContaining({
                mode: 'hdr-to-sdr',
                outputTransfer: 'srgb',
                toneMapping: expect.objectContaining({ inputPeakNits: 2_500 })
            })
        }, 1);
        expect(player.getDetectedInputPeakNits()).toBe(1_000);
        expect(customPlaybackController.play).toHaveBeenCalledWith(
            expect.objectContaining({
                dolbyVisionProfile: null,
                rawVideoFrameFormat: 'I420P10',
                videoDecoderBackend: 'bundled-hevc',
                videoOutputMode: 'raw-planes'
            })
        );
    });

    it('uses neutralized native Main10 frames for authorized external HDR', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.authorizedExternalHDRRouteKeys = [
            EXTERNAL_PQ_ROUTE_KEY
        ];
        customDecodeMockState.eligible = true;
        customDecodeMockState.hdr = true;
        customDecodeMockState.nativeHDRTransfer = 'pq';
        customDecodeMockState.neutralizeHDRColorMetadata = true;
        customDecodeMockState.videoDecoderBackend = 'native';
        customDecodeMockState.videoOutputMode = 'video-frame';

        await player.play(createKnownHDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();

        expect(backend.play).not.toHaveBeenCalled();
        expect(presenter.configureColorPipeline).toHaveBeenCalledWith({
            automaticInputPeakNits: true,
            inputMode: 'external-hdr',
            metadata: expect.objectContaining({
                bitDepth: 10,
                matrix: 'bt2020-ncl',
                primaries: 'bt2020',
                transfer: 'pq'
            }),
            settings: expect.objectContaining({
                mode: 'hdr-to-sdr',
                outputTransfer: 'srgb'
            })
        }, 1);
        expect(customPlaybackController.play).toHaveBeenCalledWith(
            expect.objectContaining({
                nativeHDRTransfer: 'pq',
                neutralizeHDRColorMetadata: true,
                rawVideoFrameFormat: null,
                videoDecoderBackend: 'native',
                videoOutputMode: 'video-frame'
            })
        );
    });

    it('applies HEVC mastering peak metadata before HDR frame presentation', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.authorizedExternalHDRRouteKeys = [
            EXTERNAL_PQ_ROUTE_KEY
        ];
        customDecodeMockState.eligible = true;
        customDecodeMockState.hdr = true;
        customDecodeMockState.nativeHDRTransfer = 'pq';
        customDecodeMockState.neutralizeHDRColorMetadata = true;
        customDecodeMockState.videoDecoderBackend = 'native';
        customDecodeMockState.videoOutputMode = 'video-frame';
        presenter.getRenderSettings.mockReturnValue({
            display: { brightness: 0, contrast: 1, saturation: 1 },
            mode: 'hdr-to-sdr',
            outputTransfer: 'srgb',
            toneMapping: {
                desaturationStrength: 0.25,
                exposure: 0,
                inputPeakNits: 1_000,
                operator: 'spline',
                outputPeakNits: 100,
                paperWhiteNits: 203
            },
            version: RENDER_SETTINGS_VERSION
        });

        await player.play(createKnownHDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        customPlaybackController.eventHandler({
            generation: 1,
            metadata: {
                masteringDisplayMaximumLuminanceNits: 4_000,
                masteringDisplayMinimumLuminanceNits: 0.005,
                maximumContentLightLevelNits: 500,
                maximumFrameAverageLightLevelNits: 200
            },
            type: 'static-hdr-metadata'
        });

        expect(presenter.updateRenderSettings).toHaveBeenCalledWith(
            expect.objectContaining({
                mode: 'hdr-to-sdr',
                toneMapping: expect.objectContaining({ inputPeakNits: 4_000 })
            }),
            1,
            true
        );

        presenter.updateRenderSettings.mockClear();
        customPlaybackController.eventHandler({
            generation: 1,
            metadata: {
                masteringDisplayMaximumLuminanceNits: 100,
                masteringDisplayMinimumLuminanceNits: 0.005,
                maximumContentLightLevelNits: 100,
                maximumFrameAverageLightLevelNits: 50
            },
            type: 'static-hdr-metadata'
        });
        expect(presenter.updateRenderSettings).toHaveBeenCalledWith(
            expect.objectContaining({
                toneMapping: expect.objectContaining({
                    inputPeakNits: 100,
                    paperWhiteNits: 100
                })
            }),
            1,
            true
        );

        const defaults = createDefaultWebGPUUserSettings();
        userSettingsMockState.webGPUPlaybackSettings = JSON.stringify({
            ...defaults,
            render: {
                ...defaults.render,
                automaticInputPeakNits: false
            }
        });
        presenter.updateRenderSettings.mockClear();
        customPlaybackController.eventHandler({
            generation: 1,
            metadata: {
                masteringDisplayMaximumLuminanceNits: 3_000,
                masteringDisplayMinimumLuminanceNits: 0.005,
                maximumContentLightLevelNits: 400,
                maximumFrameAverageLightLevelNits: 150
            },
            type: 'static-hdr-metadata'
        });
        expect(presenter.updateRenderSettings).not.toHaveBeenCalled();
        const detectedInputPeakNits = player.getDetectedInputPeakNits();
        expect(detectedInputPeakNits).toBe(3_000);
        if (detectedInputPeakNits === null) {
            throw new Error('Expected a retained detected input peak');
        }
        const restoredAutomaticSettings = createConfiguredHDRRenderSettings(
            defaults,
            detectedInputPeakNits
        );
        expect(player.updateRenderSettings(restoredAutomaticSettings, true)).toBe(true);
        expect(presenter.updateRenderSettings).toHaveBeenCalledWith(
            expect.objectContaining({
                toneMapping: expect.objectContaining({ inputPeakNits: 3_000 })
            }),
            1,
            true
        );
    });

    it('selects the per-frame Dolby Vision reconstruction pipeline', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.dolbyVisionAuthorized = true;
        customDecodeMockState.dolbyVision = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.hdr = true;
        customDecodeMockState.videoDecoderBackend = 'bundled-hevc';
        customDecodeMockState.videoOutputMode = 'raw-planes';

        const options = createKnownDolbyVisionPlayOptions({ playMethod: 'DirectPlay' });
        await player.play(options);
        const customPlaybackController = getCustomPlaybackController();

        expect(backend.play).not.toHaveBeenCalled();
        expect(presenter.prewarmDolbyVisionPresentationAuthorization).toHaveBeenCalled();
        expect(presenter.configureColorPipeline).toHaveBeenCalledWith({
            automaticInputPeakNits: true,
            inputMode: 'raw-dolby-vision',
            profile: 8,
            rawFrameFormat: 'I420P10',
            settings: expect.objectContaining({
                mode: 'hdr-to-sdr',
                outputTransfer: 'srgb',
                toneMapping: expect.objectContaining({ inputPeakNits: 4_000 })
            })
        }, 1);
        expect(customPlaybackController.play).toHaveBeenCalledWith(
            expect.objectContaining({
                dolbyVisionProfile: 8,
                rawVideoFrameFormat: 'I420P10',
                videoDecoderBackend: 'bundled-hevc',
                videoOutputMode: 'raw-planes'
            })
        );
    });

    it('selects the separately authorized Profile 7 MEL/base-fallback pipeline', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.dolbyVisionAuthorized = true;
        customDecodeMockState.dolbyVision = true;
        customDecodeMockState.dolbyVisionProfile7 = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.hdr = true;
        customDecodeMockState.videoDecoderBackend = 'bundled-hevc';
        customDecodeMockState.videoOutputMode = 'raw-planes';

        await player.play(createKnownProfile7DolbyVisionPlayOptions({
            playMethod: 'DirectPlay'
        }));
        const customPlaybackController = getCustomPlaybackController();

        expect(backend.play).not.toHaveBeenCalled();
        expect(presenter.configureColorPipeline).toHaveBeenCalledWith({
            automaticInputPeakNits: true,
            inputMode: 'raw-dolby-vision',
            profile: 7,
            rawFrameFormat: 'I420P10',
            settings: expect.objectContaining({
                mode: 'hdr-to-sdr',
                toneMapping: expect.objectContaining({ inputPeakNits: 4_000 })
            })
        }, 1);
        expect(customPlaybackController.play).toHaveBeenCalledWith(
            expect.objectContaining({ dolbyVisionProfile: 7 })
        );
        expect(customPlaybackController.play.mock.calls[0]?.[0])
            .not.toHaveProperty('discardDolbyVisionEnhancementLayer');
    });

    it('starts a Profile 7 route that discards its EL without a qualified EL decoder', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.dolbyVisionAuthorized = true;
        customDecodeMockState.discardDolbyVisionEnhancementLayer = true;
        customDecodeMockState.dolbyVision = true;
        customDecodeMockState.dolbyVisionProfile7 = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.hdr = true;
        customDecodeMockState.videoDecoderBackend = 'bundled-hevc';
        customDecodeMockState.videoOutputMode = 'raw-planes';

        await player.play(createKnownProfile7DolbyVisionPlayOptions({
            playMethod: 'DirectPlay'
        }));

        expect(backend.play).not.toHaveBeenCalled();
        expect(getCustomPlaybackController().play).toHaveBeenCalledWith(
            expect.objectContaining({ discardDolbyVisionEnhancementLayer: true, dolbyVisionProfile: 7 })
        );
    });

    it.each([
        {
            expectedTarget: { profile: 4, rawFrameFormat: 'I420P10' },
            label: 'Profile 4 over Main 10',
            videoStream: PROFILE_4_MAIN10_STREAM
        },
        {
            expectedTarget: { profile: 7, rawFrameFormat: 'I422P10' },
            label: 'Profile 7 over a 10-bit 4:2:2 range extension',
            videoStream: PROFILE_7_RANGE_EXTENSION_STREAM
        },
        {
            expectedTarget: { profile: 8, rawFrameFormat: 'I420' },
            label: 'Profile 8 over an 8-bit Main base',
            videoStream: PROFILE_8_MAIN_STREAM
        },
        {
            expectedTarget: { profile: 5, rawFrameFormat: 'I420' },
            label: 'Profile 5 over an 8-bit Main base',
            videoStream: PROFILE_5_MAIN_STREAM
        },
        {
            expectedTarget: { profile: 7, rawFrameFormat: 'I420P10' },
            label: 'Profile 7 over Main 10',
            videoStream: PROFILE_7_MAIN10_STREAM
        },
        {
            expectedTarget: { profile: 8, rawFrameFormat: 'I420P10' },
            label: 'Profile 8 over Main 10',
            videoStream: PROFILE_8_MAIN10_STREAM
        },
        {
            // Profile 10.0 shares Profile 5's reconstruction
            expectedTarget: { profile: 5, rawFrameFormat: 'I420P10' },
            label: 'AV1 Profile 10.0',
            videoStream: PROFILE_10_0_STREAM
        }
    ])('waits at eligibility for the reconstruction key, prewarmed or first-use: $label', async ({
        expectedTarget,
        videoStream
    }) => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.dolbyVisionAuthorized = true;
        vi.spyOn(console, 'warn').mockImplementation((): void => undefined);

        await player.play(createVideoStreamPlayOptions(videoStream));

        // A prewarmed key probes again on a GPU device recreated after negotiation, so every target waits
        expect(presenter.waitForDolbyVisionAuthorizationPrewarm.mock.calls).toEqual([ [ expectedTarget ] ]);
    });

    it.each([
        {
            authorization: 'isRawDolbyVisionProfile7PresentationAuthorized',
            label: 'Profile 7 over a 10-bit 4:2:2 range extension',
            rawFrameFormat: 'I422P10',
            videoStream: PROFILE_7_RANGE_EXTENSION_STREAM
        },
        {
            authorization: 'isRawDolbyVisionProfile4PresentationAuthorized',
            label: 'Profile 4 over an 8-bit Main base',
            rawFrameFormat: 'I420',
            videoStream: PROFILE_4_MAIN_STREAM
        }
    ] as const)('authorizes $label for eligibility in its own raw format', async ({
        authorization,
        rawFrameFormat,
        videoStream
    }) => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.dolbyVisionAuthorized = true;
        vi.spyOn(console, 'warn').mockImplementation((): void => undefined);

        await player.play(createVideoStreamPlayOptions(videoStream));

        expect(presenter[authorization]).toHaveBeenCalledWith(rawFrameFormat);
    });

    it.each([
        {
            label: 'AV1 HDR10',
            rawOnly: true,
            videoStream: {
                BitDepth: 10,
                Codec: 'av1',
                ColorPrimaries: 'bt2020',
                ColorSpace: 'bt2020nc',
                ColorTransfer: 'smpte2084',
                Profile: 'Main',
                VideoRange: 'HDR',
                VideoRangeType: 'HDR10'
            }
        },
        {
            label: 'VP9 HLG',
            rawOnly: true,
            videoStream: {
                BitDepth: 10,
                Codec: 'vp9',
                ColorPrimaries: 'bt2020',
                ColorSpace: 'bt2020nc',
                ColorTransfer: 'arib-std-b67',
                Profile: 'Profile 2',
                VideoRange: 'HDR',
                VideoRangeType: 'HLG'
            }
        },
        {
            label: 'the declared PQ base of AV1 Profile 10.1',
            rawOnly: true,
            videoStream: {
                BitDepth: 10,
                BlPresentFlag: true,
                Codec: 'av1',
                ColorPrimaries: 'bt2020',
                ColorSpace: 'bt2020nc',
                ColorTransfer: 'smpte2084',
                DvBlSignalCompatibilityId: 1,
                DvProfile: 10,
                Profile: 'Main',
                RpuPresentFlag: true,
                VideoRange: 'HDR',
                VideoRangeType: 'DOVIWithHDR10'
            }
        },
        {
            label: 'HEVC Rext 10-bit 4:2:2 HDR10',
            rawOnly: true,
            videoStream: {
                BitDepth: 10,
                Codec: 'hevc',
                ColorPrimaries: 'bt2020',
                ColorSpace: 'bt2020nc',
                ColorTransfer: 'smpte2084',
                PixelFormat: 'yuv422p10le',
                Profile: 'Rext',
                VideoRange: 'HDR',
                VideoRangeType: 'HDR10'
            }
        },
        {
            label: 'AV1 Profile 10.0, which declares no base',
            rawOnly: false,
            videoStream: {
                BitDepth: 10,
                BlPresentFlag: true,
                Codec: 'av1',
                DvBlSignalCompatibilityId: 0,
                DvProfile: 10,
                Profile: 'Main',
                RpuPresentFlag: true,
                VideoRangeType: 'DOVI'
            }
        },
        {
            label: 'HEVC Main 10 HDR10, which native external presentation can take',
            rawOnly: false,
            videoStream: {
                BitDepth: 10,
                Codec: 'hevc',
                ColorPrimaries: 'bt2020',
                ColorSpace: 'bt2020nc',
                ColorTransfer: 'smpte2084',
                Profile: 'Main 10',
                VideoRange: 'HDR',
                VideoRangeType: 'HDR10'
            }
        }
    ])('waits at eligibility for raw HDR, whatever the external result, only for raw-only HDR: $label', async ({
        rawOnly,
        videoStream
    }) => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.authorizedExternalHDRRouteKeys = [
            EXTERNAL_PQ_ROUTE_KEY
        ];
        vi.spyOn(console, 'warn').mockImplementation((): void => undefined);

        await player.play(createVideoStreamPlayOptions(videoStream));

        expect(presenter.waitForRawHDRAuthorizationPrewarm).toHaveBeenCalledTimes(rawOnly ? 1 : 0);
    });

    it('starts the raw-only HDR and first-use Dolby Vision waits together at eligibility', async () => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        // The RPU key is still pending, so the declared base may need raw HDR
        vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
        const rawHDRWait = createDeferred<void>();
        presenter.waitForRawHDRAuthorizationPrewarm.mockImplementation(() => rawHDRWait.promise);

        const playPromise = player.play(createVideoStreamPlayOptions(PROFILE_8_1_RANGE_EXTENSION_STREAM));
        await vi.waitFor(() => expect(presenter.waitForRawHDRAuthorizationPrewarm).toHaveBeenCalledOnce());
        const dolbyVisionWaitCalls = [ ...presenter.waitForDolbyVisionAuthorizationPrewarm.mock.calls ];
        rawHDRWait.resolve();
        await playPromise;

        expect(dolbyVisionWaitCalls).toEqual([ [ { profile: 8, rawFrameFormat: 'I422P10' } ] ]);
    });

    it('skips the raw HDR wait at eligibility once the item\'s single-layer RPU route is authorized', async () => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.dolbyVisionAuthorized = true;
        vi.spyOn(console, 'warn').mockImplementation((): void => undefined);

        // Profile 10.1 reconstructs before its declared PQ base, which shares the raw AV1 capability
        await player.play(createVideoStreamPlayOptions(PROFILE_10_1_STREAM));

        expect(presenter.waitForRawHDRAuthorizationPrewarm).not.toHaveBeenCalled();
        expect(presenter.waitForDolbyVisionAuthorizationPrewarm.mock.calls).toEqual([
            [ { profile: 8, rawFrameFormat: 'I420P10' } ]
        ]);
    });

    it('reads the raw HDR keys only after the raw-only HDR wait settles at eligibility', async () => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
        vi.mocked(getCustomPlaybackEligibility).mockClear();
        const rawHDRWait = createDeferred<void>();
        presenter.waitForRawHDRAuthorizationPrewarm.mockImplementation(() => rawHDRWait.promise);

        const playPromise = player.play(createVideoStreamPlayOptions(AV1_HDR10_STREAM));
        await vi.waitFor(() => expect(presenter.waitForRawHDRAuthorizationPrewarm).toHaveBeenCalledOnce());
        // The probe settles only when its wait does
        presenterMockState.authorizedRawHDRRouteKeys = [ RAW_PQ_ROUTE_KEY ];
        rawHDRWait.resolve();
        await playPromise;

        expect(getLastEligibilityOptions()).toMatchObject({
            allowRawHDR: true,
            authorizedRawHDRRouteKeys: [ RAW_PQ_ROUTE_KEY ]
        });
    });

    it('probes a played source whose video probes the negotiated item did not run', async () => {
        const player = new WebGPUPlayer();
        playbackPreferencesMockState.customDecodeEnabled = true;
        vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
        const audioProbes: ReadonlySet<CustomDecodeProbe> = new Set<CustomDecodeProbe>(CUSTOM_DECODE_AUDIO_PROBES);
        const probeStates = {} as Record<CustomDecodeProbe, CustomDecodeProbeState>;
        for (const probe of [ ...CUSTOM_DECODE_AUDIO_PROBES, ...CUSTOM_DECODE_VIDEO_PROBES ]) {
            probeStates[probe] = audioProbes.has(probe) ? 'probed' : 'not-probed';
        }
        const audioOnlyCapabilities = {
            audio: {},
            probeStates,
            telemetry: { reason: 'complete' },
            video: {}
        } as unknown as CustomDecodeCapabilities;
        vi.mocked(probeCustomDecodeCapabilities).mockResolvedValueOnce(audioOnlyCapabilities);
        await player.getDeviceProfile({ Id: 'audio-only-item' }, { isRetry: false });
        vi.mocked(probeCustomDecodeCapabilities).mockClear();
        vi.mocked(getCustomPlaybackEligibility).mockClear();
        const options = createVideoStreamPlayOptions(AV1_HDR10_STREAM);

        await player.play(options);

        expect(probeCustomDecodeCapabilities).toHaveBeenCalledExactlyOnceWith(options.mediaSource);
        expect(vi.mocked(getCustomPlaybackEligibility).mock.lastCall?.[1]).not.toBe(audioOnlyCapabilities);
    });

    it('reuses the negotiated capabilities when they cover the played source', async () => {
        const player = new WebGPUPlayer();
        playbackPreferencesMockState.customDecodeEnabled = true;
        vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
        await player.getDeviceProfile({ Id: 'item' }, { isRetry: false });
        const negotiatedCapabilities = player.getCustomDecodeCapabilities();
        vi.mocked(probeCustomDecodeCapabilities).mockClear();
        vi.mocked(getCustomPlaybackEligibility).mockClear();

        await player.play(createVideoStreamPlayOptions(AV1_HDR10_STREAM));

        expect(probeCustomDecodeCapabilities).not.toHaveBeenCalled();
        expect(vi.mocked(getCustomPlaybackEligibility).mock.lastCall?.[1]).toBe(negotiatedCapabilities);
    });

    it('supersedes a play whose session stops during the raw-only HDR wait at eligibility', async () => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
        vi.mocked(getCustomPlaybackEligibility).mockClear();
        const rawHDRWait = createDeferred<void>();
        presenter.waitForRawHDRAuthorizationPrewarm.mockImplementation(() => rawHDRWait.promise);

        const playPromise = player.play(createVideoStreamPlayOptions(AV1_HDR10_STREAM));
        await vi.waitFor(() => expect(presenter.waitForRawHDRAuthorizationPrewarm).toHaveBeenCalledOnce());
        const stopPromise = player.stop(false);
        rawHDRWait.resolve();

        await expect(playPromise).resolves.toBe(PLAYBACK_SUPERSEDED);
        await stopPromise;
        expect(getCustomPlaybackEligibility).not.toHaveBeenCalled();
    });

    it.each([
        'DirectStream',
        'Transcode'
    ])('skips every authorization wait at eligibility for a %s play', async (playMethod: string) => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.dolbyVisionAuthorized = true;
        presenterMockState.authorizedRawHDRRouteKeys = [ RAW_PQ_ROUTE_KEY, RAW_SDR_ROUTE_KEY ];
        vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
        vi.mocked(getCustomPlaybackEligibility).mockClear();

        await player.play({
            ...createVideoStreamPlayOptions(PROFILE_8_1_RANGE_EXTENSION_STREAM),
            playMethod
        });

        // Custom playback accepts DirectPlay alone, whatever is authorized
        expect(presenter.waitForRawSDRAuthorizationPrewarm).not.toHaveBeenCalled();
        expect(presenter.waitForRawHDRAuthorizationPrewarm).not.toHaveBeenCalled();
        expect(presenter.waitForDolbyVisionAuthorizationPrewarm).not.toHaveBeenCalled();
        expect(getLastEligibilityOptions()).toMatchObject({
            allowDolbyVision: false,
            allowRawHDR: false,
            allowRawSDR: false,
            authorizedRawHDRRouteKeys: []
        });
    });

    it.each([
        { hdrToneMappingEnabled: true },
        { hdrToneMappingEnabled: false }
    ])('passes the raw SDR keys at eligibility for a declared 10-bit SDR base (tone mapping $hdrToneMappingEnabled)', async ({
        hdrToneMappingEnabled
    }) => {
        const player = new WebGPUPlayer();
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = hdrToneMappingEnabled;
        presenterMockState.authorizedRawHDRRouteKeys = [ RAW_PQ_ROUTE_KEY, RAW_SDR_ROUTE_KEY ];
        vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
        vi.mocked(getCustomPlaybackEligibility).mockClear();

        // Profile 10.2 without an authorized RPU route presents its declared SDR base through raw SDR
        await player.play(createVideoStreamPlayOptions(PROFILE_10_2_STREAM));

        expect(getLastEligibilityOptions()).toMatchObject({
            allowRawHDR: false,
            allowRawSDR: true,
            authorizedRawHDRRouteKeys: [ RAW_SDR_ROUTE_KEY ]
        });
    });

    it('reports each dual-layer Dolby Vision authorization for the requested raw base-layer format', () => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        const dualLayerRoutes = [
            'profile4-base',
            'profile4-fel',
            'profile7-base',
            'profile7-fel'
        ] as const;

        for (const route of dualLayerRoutes) {
            presenter.getDolbyVisionAuthorizationTelemetry.mockClear();
            player.getDolbyVisionAuthorizationTelemetry(route, 'I422P10');
            player.getDolbyVisionAuthorizationTelemetry(route);

            // Without a format each reports the prewarmed I420P10 key
            expect(presenter.getDolbyVisionAuthorizationTelemetry.mock.calls).toEqual([ [ route, 'I422P10' ], [ route, 'I420P10' ] ]);
        }
    });

    it('presents an oversized Profile 7 source through its native HDR10 base', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.dolbyVisionAuthorized = true;
        presenterMockState.authorizedExternalHDRRouteKeys = [
            EXTERNAL_PQ_ROUTE_KEY
        ];
        customDecodeMockState.dolbyVision = true;
        customDecodeMockState.dolbyVisionProfile7 = true;
        customDecodeMockState.dolbyVisionProfile7HDR10Base = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.hdr = true;
        customDecodeMockState.nativeHDRTransfer = 'pq';
        customDecodeMockState.neutralizeHDRColorMetadata = true;
        customDecodeMockState.videoDecoderBackend = 'native';
        customDecodeMockState.videoOutputMode = 'video-frame';

        await player.play(createKnownProfile7DolbyVisionPlayOptions({
            playMethod: 'DirectPlay'
        }));
        const customPlaybackController = getCustomPlaybackController();

        expect(backend.play).not.toHaveBeenCalled();
        expect(presenter.prewarmExternalHDRPresentationAuthorization).toHaveBeenCalled();
        expect(presenter.configureColorPipeline).toHaveBeenCalledWith({
            automaticInputPeakNits: true,
            inputMode: 'external-hdr',
            metadata: expect.objectContaining({
                bitDepth: 10,
                matrix: 'bt2020-ncl',
                primaries: 'bt2020',
                transfer: 'pq'
            }),
            settings: expect.objectContaining({
                mode: 'hdr-to-sdr',
                toneMapping: expect.objectContaining({ inputPeakNits: 1_000 })
            })
        }, 1);
        expect(customPlaybackController.play).toHaveBeenCalledWith(
            expect.objectContaining({
                dolbyVisionProfile: null,
                nativeHDRTransfer: 'pq',
                neutralizeHDRColorMetadata: true,
                rawVideoFrameFormat: null,
                videoDecoderBackend: 'native',
                videoOutputMode: 'video-frame'
            })
        );
    });

    it('presents an oversized Profile 8.1 source through its native HDR10 base', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.dolbyVisionAuthorized = true;
        presenterMockState.authorizedExternalHDRRouteKeys = [
            EXTERNAL_PQ_ROUTE_KEY
        ];
        customDecodeMockState.dolbyVision = true;
        customDecodeMockState.dolbyVisionProfile8HDR10Base = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.hdr = true;
        customDecodeMockState.nativeHDRTransfer = 'pq';
        customDecodeMockState.neutralizeHDRColorMetadata = true;
        customDecodeMockState.videoDecoderBackend = 'native';
        customDecodeMockState.videoOutputMode = 'video-frame';

        await player.play(createKnownProfile8HDR10BasePlayOptions({
            playMethod: 'DirectPlay'
        }));
        const customPlaybackController = getCustomPlaybackController();

        expect(backend.play).not.toHaveBeenCalled();
        expect(presenter.prewarmExternalHDRPresentationAuthorization).toHaveBeenCalled();
        expect(presenter.configureColorPipeline).toHaveBeenCalledWith({
            automaticInputPeakNits: true,
            inputMode: 'external-hdr',
            metadata: expect.objectContaining({
                bitDepth: 10,
                matrix: 'bt2020-ncl',
                primaries: 'bt2020',
                transfer: 'pq'
            }),
            settings: expect.objectContaining({
                mode: 'hdr-to-sdr',
                toneMapping: expect.objectContaining({ inputPeakNits: 1_000 })
            })
        }, 1);
        expect(customPlaybackController.play).toHaveBeenCalledWith(
            expect.objectContaining({
                dolbyVisionProfile: null,
                nativeHDRTransfer: 'pq',
                neutralizeHDRColorMetadata: true,
                rawVideoFrameFormat: null,
                videoDecoderBackend: 'native',
                videoOutputMode: 'video-frame'
            })
        );
    });

    it('presents an oversized Profile 8.4 source through its native HLG base', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        playbackPreferencesMockState.hdrToneMappingEnabled = true;
        presenterMockState.dolbyVisionAuthorized = true;
        presenterMockState.authorizedExternalHDRRouteKeys = [
            EXTERNAL_HLG_ROUTE_KEY
        ];
        customDecodeMockState.dolbyVision = true;
        customDecodeMockState.dolbyVisionProfile8HLGBase = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.hdr = true;
        customDecodeMockState.nativeHDRTransfer = 'hlg';
        customDecodeMockState.neutralizeHDRColorMetadata = true;
        customDecodeMockState.videoDecoderBackend = 'native';
        customDecodeMockState.videoOutputMode = 'video-frame';

        await player.play(createKnownProfile8HLGBasePlayOptions({
            playMethod: 'DirectPlay'
        }));
        const customPlaybackController = getCustomPlaybackController();

        expect(backend.play).not.toHaveBeenCalled();
        expect(presenter.prewarmExternalHDRPresentationAuthorization).toHaveBeenCalled();
        expect(presenter.configureColorPipeline).toHaveBeenCalledWith({
            automaticInputPeakNits: true,
            inputMode: 'external-hdr',
            metadata: expect.objectContaining({
                bitDepth: 10,
                matrix: 'bt2020-ncl',
                primaries: 'bt2020',
                transfer: 'hlg'
            }),
            settings: expect.objectContaining({
                mode: 'hdr-to-sdr',
                toneMapping: expect.objectContaining({ inputPeakNits: 1_000 })
            })
        }, 1);
        expect(customPlaybackController.play).toHaveBeenCalledWith(
            expect.objectContaining({
                dolbyVisionProfile: null,
                nativeHDRTransfer: 'hlg',
                neutralizeHDRColorMetadata: true,
                rawVideoFrameFormat: null,
                videoDecoderBackend: 'native',
                videoOutputMode: 'video-frame'
            })
        );

        presenter.updateRenderSettings.mockClear();
        customPlaybackController.eventHandler({
            generation: 1,
            metadata: {
                masteringDisplayMaximumLuminanceNits: 4_000,
                masteringDisplayMinimumLuminanceNits: 0.005,
                maximumContentLightLevelNits: 1_000,
                maximumFrameAverageLightLevelNits: 400
            },
            type: 'static-hdr-metadata'
        });
        expect(presenter.updateRenderSettings).not.toHaveBeenCalled();
    });

    it('keeps HDR on native video when custom tone mapping is disabled', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.hdr = true;
        customDecodeMockState.videoOutputMode = 'raw-planes';

        const options = createKnownHDRPlayOptions({ playMethod: 'DirectPlay' });
        await player.play(options);

        expect(customDecodeMockState.instances).toHaveLength(0);
        expect(backend.play).toHaveBeenCalledWith(options);
        expect(presenter.attach).not.toHaveBeenCalled();
        expect(presenter.endSession).toHaveBeenLastCalledWith(1);
    });

    it('prewarms selected audio synchronously and transfers it to custom playback', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.audioTrackIndex = 1;
        const options = createKnownSDRAudioPlayOptions();

        const playPromise = player.play(options);
        expect(audioPrewarmMockState.sampleRates).toEqual([48_000]);
        await playPromise;

        expect(audioPrewarmMockState.factoryLeases).toEqual([
            audioPrewarmMockState.leases[0]
        ]);
        await player.stop(false);
        expect(audioPrewarmMockState.leases[0].close).toHaveBeenCalledOnce();
    });

    it.each([ 3_000, 12_345, 96_000, 192_000 ])(
        'prewarms the 48-kHz PCM output for bounded %i-Hz source audio',
        async sourceSampleRate => {
            const player = new WebGPUPlayer();
            const backend = getBackend();
            const container = document.createElement('div');
            const video = document.createElement('video');
            container.appendChild(video);
            backend.presentationSurface = { container, video };
            playbackPreferencesMockState.customDecodeEnabled = true;
            customDecodeMockState.eligible = true;
            customDecodeMockState.audioTrackIndex = 1;

            const playPromise = player.play(
                createKnownSDRAudioPlayOptions(sourceSampleRate)
            );
            expect(audioPrewarmMockState.sampleRates).toEqual([ 48_000 ]);
            await playPromise;

            expect(audioPrewarmMockState.factoryLeases).toEqual([
                audioPrewarmMockState.leases[0]
            ]);
        }
    );

    it('forces stereo and forwards a persisted bounded downmix snapshot', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.audioTrackIndex = 1;
        customDecodeMockState.audioSourceChannelCount = 8;
        audioPrewarmMockState.maximumChannelCount = 8;
        const defaults = createDefaultWebGPUUserSettings();
        userSettingsMockState.webGPUPlaybackSettings = JSON.stringify({
            ...defaults,
            audio: {
                downmix: {
                    centerLevel: 0.5,
                    outputGain: 0.75,
                    surroundLevel: 0.25,
                    version: 1
                },
                forceStereoDownmix: true
            }
        });

        await player.play(createKnownSDRAudioPlayOptions());

        expect(getCustomPlaybackController().play).toHaveBeenCalledWith(
            expect.objectContaining({
                audioDownmixSettings: {
                    centerLevel: 0.5,
                    outputGain: 0.75,
                    surroundLevel: 0.25,
                    version: 1
                },
                decodedAudioOutputChannelCount: 2
            })
        );
    });

    it('rejects invalid live downmix settings and safely ignores inactive playback', () => {
        const player = new WebGPUPlayer();

        expect(player.updateAudioDownmixSettings(
            createDefaultAudioDownmixSettings()
        )).toBe(false);
        expect(() => player.updateAudioDownmixSettings({
            centerLevel: 1,
            outputGain: 11,
            surroundLevel: 1,
            version: 1
        })).toThrow(RangeError);
    });

    it('forwards live downmix settings and retains attempted gains for track changes', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.audioTrackIndex = 1;
        customDecodeMockState.audioSourceChannelCount = 6;

        await player.play(createKnownSDRAudioPlayOptions());

        const customPlaybackController = getCustomPlaybackController();
        const appliedSettings = {
            centerLevel: 0.5,
            outputGain: 0.75,
            surroundLevel: 0.25,
            version: 1 as const
        };
        expect(player.updateAudioDownmixSettings(appliedSettings)).toBe(true);
        expect(customPlaybackController.updateAudioDownmixSettings).toHaveBeenCalledWith(
            appliedSettings
        );
        expect(customPlaybackController.updateAudioDownmixSettings.mock.calls[0][0])
            .not.toBe(appliedSettings);

        const attemptedSettings = {
            centerLevel: 0.4,
            outputGain: 0.8,
            surroundLevel: 0.6,
            version: 1 as const
        };
        customPlaybackController.updateAudioDownmixSettings.mockReturnValueOnce(false);
        expect(player.updateAudioDownmixSettings(attemptedSettings)).toBe(false);
        expect(customPlaybackController.updateAudioDownmixSettings).toHaveBeenLastCalledWith(
            attemptedSettings
        );
        expect(customPlaybackController.updateAudioDownmixSettings.mock.calls[1][0])
            .not.toBe(attemptedSettings);

        attemptedSettings.centerLevel = 1.5;
        player.setAudioStreamIndex(3);
        await vi.waitFor(() => (
            expect(customPlaybackController.setAudioStreamIndex).toHaveBeenCalledWith(
                1,
                'decoded-pcm',
                2,
                {
                    centerLevel: 0.4,
                    outputGain: 0.8,
                    surroundLevel: 0.6,
                    version: 1
                }
            )
        ));
    });

    it.each([
        { expectedOutput: 6, maximumOutput: 6, sourceChannels: 6 },
        { expectedOutput: 8, maximumOutput: 8, sourceChannels: 8 },
        // A 7.1 bed folds into a 5.1 destination, and three-channel audio selects 5.1 on a 7.1 destination
        { expectedOutput: 6, maximumOutput: 6, sourceChannels: 8 },
        { expectedOutput: 6, maximumOutput: 8, sourceChannels: 3 },
        { expectedOutput: 2, maximumOutput: 2, sourceChannels: 8 }
    ])(
        'selects $expectedOutput decoded channels for $sourceChannels-channel audio on a $maximumOutput-channel destination',
        async ({ expectedOutput, maximumOutput, sourceChannels }) => {
            const player = new WebGPUPlayer();
            const backend = getBackend();
            const container = document.createElement('div');
            const video = document.createElement('video');
            container.appendChild(video);
            backend.presentationSurface = { container, video };
            playbackPreferencesMockState.customDecodeEnabled = true;
            customDecodeMockState.eligible = true;
            customDecodeMockState.audioTrackIndex = 1;
            customDecodeMockState.audioSourceChannelCount = sourceChannels;
            audioPrewarmMockState.maximumChannelCount = maximumOutput;
            userSettingsMockState.audioDownmixAlgorithm = 'rfc-7845';

            await player.play(createKnownSDRAudioPlayOptions());

            expect(getCustomPlaybackController().play).toHaveBeenCalledWith(
                expect.objectContaining({
                    audioDownmixAlgorithm: 'rfc-7845',
                    decodedAudioOutputChannelCount: expectedOutput
                })
            );
        }
    );

    it('declines live audio output settings without an active custom playback session', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };

        await expect(player.applyAudioOutputSettings(true, 'rfc-7845')).resolves.toBe(false);

        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.audioTrackIndex = 1;
        customDecodeMockState.audioSourceChannelCount = 6;
        await player.play(createKnownSDRAudioPlayOptions());
        const customPlaybackController = getCustomPlaybackController();
        customPlaybackController.getAudioOutputMaximumChannelCount.mockReturnValue(6);
        await player.stop(false);

        await expect(player.applyAudioOutputSettings(true, 'rfc-7845')).resolves.toBe(false);
        // A detached controller's device change no longer reaches the player
        customPlaybackController.eventHandler({
            generation: 1,
            maximumChannelCount: 6,
            type: 'audio-output-changed'
        });
        expect(customPlaybackController.reconfigureAudioOutput).not.toHaveBeenCalled();
    });

    it('applies force stereo and the downmix algorithm to live decoded audio', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.audioTrackIndex = 1;
        customDecodeMockState.audioSourceChannelCount = 8;
        const defaults = createDefaultWebGPUUserSettings();
        const sessionDownmixSettings = {
            centerLevel: 0.4,
            outputGain: 0.6,
            surroundLevel: 0.5,
            version: 1 as const
        };
        userSettingsMockState.webGPUPlaybackSettings = JSON.stringify({
            ...defaults,
            audio: {
                downmix: sessionDownmixSettings,
                forceStereoDownmix: false
            }
        });
        await player.play(createKnownSDRAudioPlayOptions());
        const customPlaybackController = getCustomPlaybackController();
        customPlaybackController.getAudioOutputMaximumChannelCount.mockReturnValue(8);

        await expect(player.applyAudioOutputSettings(true, 'rfc-7845')).resolves.toBe(true);
        expect(customPlaybackController.reconfigureAudioOutput).toHaveBeenLastCalledWith({
            audioDownmixAlgorithm: 'rfc-7845',
            audioDownmixSettings: sessionDownmixSettings,
            decodedAudioOutputChannelCount: 2
        });
        await expect(player.applyAudioOutputSettings(false, 'ac-4')).resolves.toBe(true);
        expect(customPlaybackController.reconfigureAudioOutput).toHaveBeenLastCalledWith({
            audioDownmixAlgorithm: 'ac-4',
            audioDownmixSettings: sessionDownmixSettings,
            decodedAudioOutputChannelCount: 8
        });

        // The session keeps the applied choice over the persisted one for later switches
        await expect(player.applyAudioOutputSettings(true, 'dave750')).resolves.toBe(true);
        customPlaybackController.eventHandler({
            generation: 1,
            maximumChannelCount: 8,
            type: 'audio-output-changed'
        });
        expect(customPlaybackController.reconfigureAudioOutput).toHaveBeenCalledTimes(4);
        expect(customPlaybackController.reconfigureAudioOutput).toHaveBeenLastCalledWith({
            audioDownmixAlgorithm: 'dave750',
            audioDownmixSettings: sessionDownmixSettings,
            decodedAudioOutputChannelCount: 2
        });
        player.setAudioStreamIndex(3);
        await vi.waitFor(() => (
            expect(customPlaybackController.setAudioStreamIndex).toHaveBeenCalledWith(
                1,
                'decoded-pcm',
                2,
                sessionDownmixSettings
            )
        ));
    });

    it('resolves false when the live session declines or fails the layout switch', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.audioTrackIndex = 1;
        customDecodeMockState.audioSourceChannelCount = 6;
        await player.play(createKnownSDRAudioPlayOptions());
        const customPlaybackController = getCustomPlaybackController();
        customPlaybackController.getAudioOutputMaximumChannelCount.mockReturnValue(6);
        const consoleWarning = vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
        const switchError = new Error('Layout switch failed');
        customPlaybackController.reconfigureAudioOutput
            .mockResolvedValueOnce(false)
            .mockRejectedValueOnce(switchError);

        // The controller declines a switch it cannot start, such as one during startup
        await expect(player.applyAudioOutputSettings(true, 'ac-4')).resolves.toBe(false);
        expect(consoleWarning).not.toHaveBeenCalled();
        await expect(player.applyAudioOutputSettings(false, 'ac-4')).resolves.toBe(false);
        expect(consoleWarning).toHaveBeenCalledExactlyOnceWith(
            'Unable to switch the WebGPU audio output layout',
            switchError
        );
        expect(customPlaybackController.reconfigureAudioOutput).toHaveBeenCalledTimes(2);
        expect(customPlaybackController.reconfigureAudioOutput).toHaveBeenLastCalledWith({
            audioDownmixAlgorithm: 'ac-4',
            audioDownmixSettings: createDefaultAudioDownmixSettings(),
            decodedAudioOutputChannelCount: 6
        });

        // A failed switch does not block the next one
        await expect(player.applyAudioOutputSettings(true, 'ac-4')).resolves.toBe(true);
    });

    it('re-evaluates the decoded layout when the custom audio output device changes', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.audioTrackIndex = 1;
        customDecodeMockState.audioSourceChannelCount = 6;
        await player.play(createKnownSDRAudioPlayOptions());
        const customPlaybackController = getCustomPlaybackController();
        expect(customPlaybackController.play).toHaveBeenCalledWith(
            expect.objectContaining({ decodedAudioOutputChannelCount: 2 })
        );
        const consoleWarning = vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
        const switchError = new Error('Layout switch failed');
        customPlaybackController.getAudioOutputMaximumChannelCount.mockReturnValue(6);
        customPlaybackController.reconfigureAudioOutput.mockRejectedValueOnce(switchError);

        customPlaybackController.eventHandler({
            generation: 1,
            maximumChannelCount: 6,
            type: 'audio-output-changed'
        });

        expect(customPlaybackController.reconfigureAudioOutput).toHaveBeenCalledExactlyOnceWith({
            audioDownmixAlgorithm: 'standard-lo-ro',
            audioDownmixSettings: createDefaultAudioDownmixSettings(),
            decodedAudioOutputChannelCount: 6
        });
        // A failed switch is reported instead of escaping the event path
        await vi.waitFor(() => expect(consoleWarning).toHaveBeenCalledWith(
            'Unable to switch the WebGPU audio output layout',
            switchError
        ));

        customPlaybackController.getAudioOutputMaximumChannelCount.mockReturnValue(2);
        customPlaybackController.eventHandler({
            generation: 1,
            maximumChannelCount: 2,
            type: 'audio-output-changed'
        });
        expect(customPlaybackController.reconfigureAudioOutput).toHaveBeenLastCalledWith({
            audioDownmixAlgorithm: 'standard-lo-ro',
            audioDownmixSettings: createDefaultAudioDownmixSettings(),
            decodedAudioOutputChannelCount: 2
        });
    });

    it.each([
        [ 'native media audio', 'native-media' as const, 1 ],
        [ 'video-only playback', 'decoded-pcm' as const, null ]
    ])('keeps %s out of live output layout switches', async (
        _label,
        audioOutputMode,
        audioTrackIndex
    ) => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.audioOutputMode = audioOutputMode;
        customDecodeMockState.audioTrackIndex = audioTrackIndex;
        customDecodeMockState.audioSourceChannelCount = 6;
        await player.play(createKnownSDRAudioPlayOptions());
        const customPlaybackController = getCustomPlaybackController();
        customPlaybackController.getAudioOutputMaximumChannelCount.mockReturnValue(6);

        await expect(player.applyAudioOutputSettings(true, 'rfc-7845')).resolves.toBe(false);
        customPlaybackController.eventHandler({
            generation: 1,
            maximumChannelCount: 6,
            type: 'audio-output-changed'
        });

        expect(customPlaybackController.reconfigureAudioOutput).not.toHaveBeenCalled();
    });

    it.each([
        { expectedOutput: 2, liveMaximum: 2, prewarmMaximum: 8 },
        { expectedOutput: 8, liveMaximum: 8, prewarmMaximum: 2 },
        { expectedOutput: 8, liveMaximum: null, prewarmMaximum: 8 }
    ])(
        'switches 8-channel audio to $expectedOutput channels from a $liveMaximum live and $prewarmMaximum prewarm maximum',
        async ({ expectedOutput, liveMaximum, prewarmMaximum }) => {
            const player = new WebGPUPlayer();
            const backend = getBackend();
            const container = document.createElement('div');
            const video = document.createElement('video');
            container.appendChild(video);
            backend.presentationSurface = { container, video };
            playbackPreferencesMockState.customDecodeEnabled = true;
            customDecodeMockState.eligible = true;
            customDecodeMockState.audioTrackIndex = 1;
            customDecodeMockState.audioSourceChannelCount = 8;
            audioPrewarmMockState.maximumChannelCount = prewarmMaximum;
            await player.play(createKnownSDRAudioPlayOptions());
            const customPlaybackController = getCustomPlaybackController();
            // The live output knows its current device; the prewarm only knew the startup one
            customPlaybackController.getAudioOutputMaximumChannelCount.mockReturnValue(liveMaximum);

            player.setAudioStreamIndex(3);

            await vi.waitFor(() => (
                expect(customPlaybackController.setAudioStreamIndex).toHaveBeenCalledWith(
                    1,
                    'decoded-pcm',
                    expectedOutput,
                    createDefaultAudioDownmixSettings()
                )
            ));
            expect(customPlaybackController.getAudioOutputMaximumChannelCount).toHaveBeenCalled();
        }
    );

    it('closes the PCM prewarm before starting exact native media audio', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.audioOutputMode = 'native-media';
        customDecodeMockState.audioTrackIndex = 1;

        await player.play(createKnownSDRAudioPlayOptions());

        const customPlaybackController = getCustomPlaybackController();
        expect(audioPrewarmMockState.sampleRates).toEqual([ 48_000 ]);
        expect(audioPrewarmMockState.leases).toHaveLength(1);
        expect(audioPrewarmMockState.leases[0].close).toHaveBeenCalledOnce();
        expect(audioPrewarmMockState.factoryLeases).toEqual([ null ]);
        expect(customPlaybackController.play).toHaveBeenCalledWith(
            expect.objectContaining({
                audioOutputMode: 'native-media',
                audioTrackIndex: 1
            })
        );
        expect(player.getCustomPlaybackEligibility()).toMatchObject({
            audioOutputMode: 'native-media',
            eligible: true
        });
    });

    it('supplies the owned native-audio bridge factory to an audio controller', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.audioOutputMode = 'native-media';
        customDecodeMockState.audioTrackIndex = 1;

        await player.play(createKnownSDRAudioPlayOptions());

        expect(getCustomPlaybackController().nativeAudioBridgeFactory).toEqual(
            expect.any(Function)
        );
    });

    it.each([
        { channelCount: 6, expectedAudioOutputMode: 'native-media' },
        { channelCount: 2, expectedAudioOutputMode: null }
    ])('selects native media only for the exact measured layout %#', async ({
        channelCount,
        expectedAudioOutputMode
    }) => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.audioEligibilityOverride = selectExactNativeAudioRouteForMock;
        customDecodeMockState.eligible = true;
        nativeAudioCapabilityMockState.capabilities =
            createPartialNativeMediaAudioCapabilities();
        const options = createKnownSDRNativeAudioPlayOptions(channelCount);

        await player.play(options);

        if (expectedAudioOutputMode === 'native-media') {
            const customPlaybackController = getCustomPlaybackController();
            expect(backend.play).not.toHaveBeenCalled();
            expect(customPlaybackController.play).toHaveBeenCalledWith(
                expect.objectContaining({
                    audioOutputMode: 'native-media',
                    audioTrackIndex: 0
                })
            );
            expect(player.getNativeMediaAudioCapabilities()).toEqual(
                nativeAudioCapabilityMockState.capabilities
            );
            return;
        }

        expect(customDecodeMockState.instances).toHaveLength(0);
        expect(backend.play).toHaveBeenCalledWith(options);
        expect(player.getCustomPlaybackEligibility()).toEqual({
            eligible: false,
            reason: 'audio-layout-unsupported'
        });
    });

    it('closes an unused audio prewarm before native playback', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = false;
        const options = createKnownSDRAudioPlayOptions();

        const playPromise = player.play(options);
        expect(audioPrewarmMockState.sampleRates).toEqual([48_000]);
        await playPromise;

        expect(audioPrewarmMockState.factoryLeases).toHaveLength(0);
        expect(audioPrewarmMockState.leases[0].close).toHaveBeenCalledOnce();
        expect(backend.play).toHaveBeenCalledWith(options);
    });

    it.each([
        {
            configure: (): void => undefined,
            expectedReason: 'invalid-options',
            options: createKnownSDRPlayOptions({ playMethod: 'DirectPlay' })
        },
        {
            configure: (): void => {
                customDecodeMockState.audioEligibilityOverride = (): MockAudioEligibilityOverride => ({
                    eligible: false,
                    reason: 'audio-layout-unsupported'
                });
            },
            expectedReason: 'audio-layout-unsupported',
            options: createKnownSDRPlayOptions({ playMethod: 'DirectPlay' })
        },
        {
            // Custom decode turns off between startup and the eligibility read
            configure: (): void => {
                playbackPreferencesMockState.customDecodeEnabledPromises.push(
                    Promise.resolve(false)
                );
            },
            expectedReason: 'eligibility-unavailable',
            options: createKnownSDRPlayOptions({ playMethod: 'DirectPlay' })
        },
        {
            configure: (): void => {
                customDecodeMockState.eligible = true;
            },
            expectedReason: 'webgpu-presentation-disabled',
            // A source without a known range stays on direct HTML presentation
            options: {
                mediaSource: { MediaStreams: [{ Type: 'Video' }] },
                playMethod: 'DirectPlay'
            }
        }
    ])('warns why a declined source falls back to native playback: $expectedReason', async ({
        configure,
        expectedReason,
        options
    }) => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        playbackPreferencesMockState.customDecodeEnabled = true;
        configure();
        const consoleWarning = vi.spyOn(console, 'warn').mockImplementation((): void => undefined);

        await player.play(options);

        expect(consoleWarning).toHaveBeenCalledExactlyOnceWith(
            'Custom playback is ineligible; using the HTML backend',
            expectedReason
        );
        expect(backend.play).toHaveBeenCalledWith(options);
    });

    it('starts native playback before prewarm close and makes stop await cleanup', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const deferredClose = createDeferred<void>();
        audioPrewarmMockState.nextClosePromise = deferredClose.promise;
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = false;

        await player.play(createKnownSDRAudioPlayOptions());
        expect(backend.play).toHaveBeenCalledOnce();

        const stopPromise = player.stop(false);
        let stopSettled = false;
        const observedStopPromise = stopPromise.then((): void => {
            stopSettled = true;
        });
        await Promise.resolve();
        expect(stopSettled).toBe(false);

        deferredClose.resolve();
        await stopPromise;
        await observedStopPromise;
        expect(stopSettled).toBe(true);
        expect(audioPrewarmMockState.leases[0].close).toHaveBeenCalledOnce();
    });

    it('does not prewarm disabled or malformed selected audio metadata', async () => {
        const disabledPlayer = new WebGPUPlayer();
        await disabledPlayer.play(createKnownSDRAudioPlayOptions());
        expect(audioPrewarmMockState.sampleRates).toHaveLength(0);

        playbackPreferencesMockState.customDecodeEnabled = true;
        const unsafePlayer = new WebGPUPlayer();
        await unsafePlayer.play(createKnownSDRAudioPlayOptions(TEXT_SAMPLE_RATE));
        expect(audioPrewarmMockState.sampleRates).toHaveLength(0);

        const zeroRatePlayer = new WebGPUPlayer();
        await zeroRatePlayer.play(createKnownSDRAudioPlayOptions(ZERO_SAMPLE_RATE));
        expect(audioPrewarmMockState.sampleRates).toHaveLength(0);
    });

    it('prewarms decoded audio for a source rate past 192 kHz', async () => {
        playbackPreferencesMockState.customDecodeEnabled = true;
        const player = new WebGPUPlayer();

        await player.play(createKnownSDRAudioPlayOptions(DXD_SAMPLE_RATE));

        expect(audioPrewarmMockState.sampleRates).toHaveLength(1);
    });

    it('closes a transferred prewarm once when custom playback falls back', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.audioTrackIndex = 1;

        await player.play(createKnownSDRAudioPlayOptions());
        const customPlaybackController = getCustomPlaybackController();
        await customPlaybackController.fallbackHook({
            disposition: 'same-session-native',
            generation: 1,
            mediaTimeMicroseconds: 2_000_000,
            preserveHTMLSession: true,
            reason: 'lifecycle-failed'
        });

        expect(audioPrewarmMockState.leases[0].close).toHaveBeenCalledOnce();
        expect(backend.play).toHaveBeenCalledOnce();
    });

    it('falls back to the same HTML session at the custom clock position', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        const options = createKnownSDRPlayOptions({ playMethod: 'DirectPlay' });
        await player.play(options);
        const customPlaybackController = getCustomPlaybackController();
        customPlaybackController.currentTimeMicroseconds = 2_500_000;
        await customPlaybackController.fallbackHook({
            disposition: 'same-session-native',
            generation: 1,
            mediaTimeMicroseconds: 2_500_000,
            preserveHTMLSession: true,
            reason: 'lifecycle-failed'
        });

        expect(backend.play).toHaveBeenCalledOnce();
        expect(backend.play).toHaveBeenCalledWith({
            ...options,
            playerStartPositionTicks: 25_000_000,
            suppressInitialUnpause: true
        });
        expect(backend.stop).not.toHaveBeenCalled();
        expect(presenter.endSession).toHaveBeenCalledWith(2);
        expect(customPlaybackController.destroy).toHaveBeenCalledOnce();

        player.currentTime(2_500);
        expect(customPlaybackController.seek).not.toHaveBeenCalled();
        expect(backend.currentTime).toHaveBeenCalledWith(2_500);
    });

    it('uses the latest seek requested while custom audio teardown is pending', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        const options = createKnownSDRPlayOptions({ playMethod: 'DirectPlay' });
        await player.play(options);
        const customPlaybackController = getCustomPlaybackController();
        const destroy = createDeferred<void>();
        customPlaybackController.destroy.mockReturnValueOnce(destroy.promise);
        const fallbackPromise = customPlaybackController.fallbackHook({
            disposition: 'same-session-native',
            generation: 1,
            mediaTimeMicroseconds: 2_500_000,
            preserveHTMLSession: true,
            reason: 'lifecycle-failed'
        });

        player.currentTime(9_000);
        expect(player.currentTime()).toBe(9_000);
        expect(backend.currentTime).not.toHaveBeenCalledWith(9_000);
        destroy.resolve(undefined);
        await fallbackPromise;

        expect(backend.play).toHaveBeenCalledWith({
            ...options,
            playerStartPositionTicks: 90_000_000,
            suppressInitialUnpause: true
        });
    });

    it('applies a seek requested while native fallback is initializing', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        const nativePlay = createDeferred<unknown>();
        backend.play.mockReturnValueOnce(nativePlay.promise);
        const fallbackPromise = customPlaybackController.fallbackHook({
            disposition: 'same-session-native',
            generation: 1,
            mediaTimeMicroseconds: 2_500_000,
            preserveHTMLSession: true,
            reason: 'lifecycle-failed'
        });
        await vi.waitFor(() => expect(backend.play).toHaveBeenCalledOnce());

        player.currentTime(12_000);
        expect(player.currentTime()).toBe(12_000);
        expect(backend.currentTime).not.toHaveBeenCalledWith(12_000);
        nativePlay.resolve(undefined);
        await fallbackPromise;

        expect(backend.currentTime).toHaveBeenCalledWith(12_000);
        expect(player.currentTime()).toBe(12_000);
    });

    it('ignores a stale custom seek failure after a newer seek wins', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        const staleSeek = createDeferred<unknown>();
        customPlaybackController.seek.mockImplementationOnce(
            (): Promise<unknown> => staleSeek.promise
        );

        player.currentTime(8_000);
        player.currentTime(9_000);
        await vi.waitFor(() => (
            expect(customPlaybackController.seek).toHaveBeenCalledTimes(2)
        ));
        staleSeek.reject(new Error('stale seek failed'));
        await Promise.resolve();
        await Promise.resolve();

        expect(backend.play).not.toHaveBeenCalled();
        expect(player.currentTime()).toBe(9_000);
    });

    it('requests source renegotiation without replaying a custom-only URL natively', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        const errorListener = vi.fn();
        Events.on(player, 'error', errorListener);

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        customPlaybackController.currentTimeMicroseconds = 2_500_000;
        const fallbackRequest = {
            disposition: 'renegotiate-source',
            generation: 1,
            mediaTimeMicroseconds: 2_500_000,
            preserveHTMLSession: true,
            reason: 'source-unsupported'
        };

        await expect(customPlaybackController.fallbackHook(fallbackRequest))
            .resolves.toBeUndefined();
        await expect(customPlaybackController.fallbackHook(fallbackRequest))
            .resolves.toBeUndefined();

        expect(backend.play).not.toHaveBeenCalled();
        expect(customPlaybackController.destroy).toHaveBeenCalledOnce();
        expect(errorListener).toHaveBeenCalledOnce();
        expect(errorListener.mock.calls[0][1]).toEqual({
            type: MediaError.MEDIA_NOT_SUPPORTED
        });
        expect(player.currentTime()).toBe(2_500);
    });

    it('lets PlaybackManager accept established source renegotiation synchronously', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        const errorListener = vi.fn();
        const renegotiationListener = vi.fn((
            _event: unknown,
            request: { accept: () => void }
        ): void => {
            request.accept();
        });
        Events.on(player, 'error', errorListener);
        Events.on(player, 'sourcerenegotiationrequired', renegotiationListener);

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        await expect(customPlaybackController.fallbackHook({
            disposition: 'renegotiate-source',
            generation: 1,
            mediaTimeMicroseconds: 2_500_000,
            preserveHTMLSession: true,
            reason: 'source-unsupported'
        })).resolves.toBeUndefined();

        expect(renegotiationListener).toHaveBeenCalledOnce();
        expect(renegotiationListener.mock.calls[0][1]).toEqual(expect.objectContaining({
            errorType: MediaError.MEDIA_NOT_SUPPORTED,
            reason: 'source-unsupported'
        }));
        expect(errorListener).not.toHaveBeenCalled();
        expect(backend.play).not.toHaveBeenCalled();
    });

    it('tears down owned audio before one server renegotiation signal', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        await player.getDeviceProfile({ Id: 'item' }, { isRetry: false });
        const errorListener = vi.fn();
        Events.on(player, 'error', errorListener);

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        const destroy = createDeferred<void>();
        customPlaybackController.destroy.mockReturnValueOnce(destroy.promise);
        const fallbackPromise = customPlaybackController.fallbackHook({
            disposition: 'renegotiate-source',
            generation: 1,
            mediaTimeMicroseconds: 2_500_000,
            preserveHTMLSession: true,
            reason: 'decode-failed'
        });

        await Promise.resolve();
        expect(errorListener).not.toHaveBeenCalled();
        expect(backend.play).not.toHaveBeenCalled();
        destroy.resolve(undefined);
        await fallbackPromise;
        customPlaybackController.eventHandler({
            generation: 1,
            message: 'stale terminal decoder error',
            recoverable: false,
            type: 'error'
        });

        expect(customPlaybackController.destroy).toHaveBeenCalledOnce();
        expect(backend.play).not.toHaveBeenCalled();
        expect(errorListener).toHaveBeenCalledOnce();
        expect(errorListener.mock.calls[0][1]).toEqual({
            type: MediaError.MEDIA_NOT_SUPPORTED
        });
    });

    it('presents clock-selected decoded frames through the push renderer', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        const decodedFrame = {
            durationMicroseconds: 41_667,
            frame: { close: vi.fn() },
            mediaTimeMicroseconds: 1_000_000,
            outputMode: 'video-frame'
        };
        customPlaybackController.takeCurrentFrame.mockReturnValueOnce(decodedFrame);

        runNextAnimationFrame();

        expect(presenter.presentDecodedFrame).toHaveBeenCalledWith(
            decodedFrame,
            1,
            expect.any(Function)
        );
        expect(customPlaybackController.notifyFramePresented).toHaveBeenCalledWith(decodedFrame);
        expect(animationFrameMockState.callbacks.size).toBe(1);
    });

    it('acknowledges a decoded VideoFrame only after GPU work completes', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        const decodedFrame = {
            durationMicroseconds: 41_667,
            frame: { close: vi.fn() },
            mediaTimeMicroseconds: 1_000_000,
            outputMode: 'video-frame'
        };
        const submissionCompletionHandlers: Array<(gpuWorkCompleted: boolean) => void> = [];
        presenter.presentDecodedFrame.mockImplementationOnce((
            _frame: unknown,
            _generation: number,
            completedHandler: (gpuWorkCompleted: boolean) => void
        ): boolean => {
            submissionCompletionHandlers.push(completedHandler);
            return true;
        });
        customPlaybackController.takeCurrentFrame.mockReturnValueOnce(decodedFrame);

        runNextAnimationFrame();

        expect(customPlaybackController.notifyFramePresented).not.toHaveBeenCalled();
        expect(submissionCompletionHandlers).toHaveLength(1);
        submissionCompletionHandlers[0](true);
        expect(customPlaybackController.notifyFramePresented).toHaveBeenCalledWith(decodedFrame);
    });

    it('discards a decoded VideoFrame after submitted GPU work rejects', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        const decodedFrame = {
            durationMicroseconds: 41_667,
            frame: { close: vi.fn() },
            mediaTimeMicroseconds: 1_000_000,
            outputMode: 'video-frame'
        };
        const submissionCompletionHandlers: Array<(gpuWorkCompleted: boolean) => void> = [];
        presenter.presentDecodedFrame.mockImplementationOnce((
            _frame: unknown,
            _generation: number,
            completedHandler: (gpuWorkCompleted: boolean) => void
        ): boolean => {
            submissionCompletionHandlers.push(completedHandler);
            return true;
        });
        customPlaybackController.takeCurrentFrame.mockReturnValueOnce(decodedFrame);

        runNextAnimationFrame();
        expect(submissionCompletionHandlers).toHaveLength(1);
        submissionCompletionHandlers[0](false);

        expect(customPlaybackController.notifyFramePresented).not.toHaveBeenCalled();
        expect(customPlaybackController.notifyFrameDiscarded).toHaveBeenCalledWith(decodedFrame);
    });

    it('ignores stale GPU completion after custom playback stops', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        const decodedFrame = {
            durationMicroseconds: 41_667,
            frame: { close: vi.fn() },
            mediaTimeMicroseconds: 1_000_000,
            outputMode: 'video-frame'
        };
        const submissionCompletionHandlers: Array<(gpuWorkCompleted: boolean) => void> = [];
        presenter.presentDecodedFrame.mockImplementationOnce((
            _frame: unknown,
            _generation: number,
            completedHandler: (gpuWorkCompleted: boolean) => void
        ): boolean => {
            submissionCompletionHandlers.push(completedHandler);
            return true;
        });
        customPlaybackController.takeCurrentFrame.mockReturnValueOnce(decodedFrame);

        runNextAnimationFrame();
        expect(submissionCompletionHandlers).toHaveLength(1);
        await player.stop(false);
        customPlaybackController.notifyFrameDiscarded.mockReturnValueOnce(false);
        submissionCompletionHandlers[0](false);

        expect(customPlaybackController.notifyFrameDiscarded).toHaveBeenCalledWith(decodedFrame);
        expect(backend.play).not.toHaveBeenCalled();
    });

    it('does not acknowledge a decoded frame rejected by the presenter', async () => {
        const consoleWarning = vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        const decodedFrame = {
            durationMicroseconds: 41_667,
            frame: { close: vi.fn() },
            mediaTimeMicroseconds: 1_000_000,
            outputMode: 'video-frame'
        };
        customPlaybackController.takeCurrentFrame.mockReturnValueOnce(decodedFrame);
        presenter.presentDecodedFrame.mockReturnValueOnce(false);

        runNextAnimationFrame();

        expect(customPlaybackController.notifyFramePresented).not.toHaveBeenCalled();
        expect(customPlaybackController.notifyFrameDiscarded).toHaveBeenCalledWith(decodedFrame);
        expect(animationFrameMockState.callbacks.size).toBe(0);
        expect(consoleWarning).toHaveBeenCalledOnce();
        consoleWarning.mockRestore();
    });

    it('discards and retries while the presenter is recovering', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        const decodedFrame = {
            durationMicroseconds: 41_667,
            frame: { close: vi.fn() },
            mediaTimeMicroseconds: 1_000_000,
            outputMode: 'video-frame'
        };
        customPlaybackController.takeCurrentFrame.mockReturnValueOnce(decodedFrame);
        presenter.presentDecodedFrame.mockReturnValueOnce(false);
        presenter.getTelemetry.mockReturnValueOnce({ state: 'initializing' });

        runNextAnimationFrame();

        expect(customPlaybackController.notifyFrameDiscarded).toHaveBeenCalledWith(decodedFrame);
        expect(backend.play).not.toHaveBeenCalled();
        expect(animationFrameMockState.callbacks.size).toBe(1);
    });

    it('keeps polling a paused generation until its first decoded frame arrives', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        player.pause();
        expect(animationFrameMockState.callbacks.size).toBe(1);

        runNextAnimationFrame();
        expect(animationFrameMockState.callbacks.size).toBe(1);
        const decodedFrame = {
            durationMicroseconds: 41_667,
            frame: { close: vi.fn() },
            mediaTimeMicroseconds: 1_000_000,
            outputMode: 'video-frame'
        };
        customPlaybackController.takeCurrentFrame.mockReturnValueOnce(decodedFrame);
        runNextAnimationFrame();

        expect(presenter.presentDecodedFrame).toHaveBeenCalledWith(
            decodedFrame,
            1,
            expect.any(Function)
        );
        expect(customPlaybackController.notifyFramePresented).toHaveBeenCalledWith(decodedFrame);
        expect(animationFrameMockState.callbacks.size).toBe(0);
    });

    it('replaces the one-shot paused poll with a continuous loop on resume', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        player.pause();
        player.resume();

        expect(animationFrameMockState.callbacks.size).toBe(1);
        runNextAnimationFrame();
        expect(animationFrameMockState.callbacks.size).toBe(1);
    });

    it('drains hidden custom playback on a timer until the page returns', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        vi.useFakeTimers();

        try {
            changeDocumentVisibility('hidden');
            expect(customPlaybackController.setPageVisibility).toHaveBeenLastCalledWith(false);
            await vi.advanceTimersByTimeAsync(
                CUSTOM_PLAYBACK_BACKGROUND_DRAIN_INTERVAL_MILLISECONDS - 1
            );
            expect(customPlaybackController.drainBackgroundVideo).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(customPlaybackController.drainBackgroundVideo).toHaveBeenCalledOnce();
            await vi.advanceTimersByTimeAsync(
                CUSTOM_PLAYBACK_BACKGROUND_DRAIN_INTERVAL_MILLISECONDS * 2
            );
            expect(customPlaybackController.drainBackgroundVideo).toHaveBeenCalledTimes(3);

            changeDocumentVisibility('visible');
            await vi.advanceTimersByTimeAsync(
                CUSTOM_PLAYBACK_BACKGROUND_DRAIN_INTERVAL_MILLISECONDS * 4
            );

            expect(customPlaybackController.setPageVisibility.mock.calls).toEqual([
                [ true ],
                [ false ],
                [ true ]
            ]);
            expect(customPlaybackController.drainBackgroundVideo).toHaveBeenCalledTimes(3);
            // The loop pending before the page hid resumes without a duplicate
            expect(animationFrameMockState.callbacks.size).toBe(1);
            runNextAnimationFrame();
            expect(customPlaybackController.takeCurrentFrame).toHaveBeenCalledOnce();
        } finally {
            restoreDocumentVisibility();
        }
    });

    it('polls a paused custom frame on return only after a video resync request', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        player.pause();
        runNextAnimationFrame();
        customPlaybackController.takeCurrentFrame.mockReturnValueOnce({
            durationMicroseconds: 41_667,
            frame: { close: vi.fn() },
            mediaTimeMicroseconds: 1_000_000,
            outputMode: 'video-frame'
        });
        runNextAnimationFrame();
        expect(animationFrameMockState.callbacks.size).toBe(0);
        vi.useFakeTimers();

        try {
            changeDocumentVisibility('hidden');
            changeDocumentVisibility('visible');
            await vi.advanceTimersByTimeAsync(CUSTOM_PLAYBACK_BACKGROUND_DRAIN_INTERVAL_MILLISECONDS);
            expect(customPlaybackController.takeCurrentFrame).toHaveBeenCalledTimes(2);

            const resyncedFrame = {
                durationMicroseconds: 41_667,
                frame: { close: vi.fn() },
                mediaTimeMicroseconds: 1_500_000,
                outputMode: 'video-frame'
            };
            changeDocumentVisibility('hidden');
            customPlaybackController.setPageVisibility.mockReturnValueOnce(true);
            customPlaybackController.takeCurrentFrame.mockReturnValueOnce(resyncedFrame);
            changeDocumentVisibility('visible');
            await vi.advanceTimersByTimeAsync(CUSTOM_PLAYBACK_BACKGROUND_DRAIN_INTERVAL_MILLISECONDS);

            expect(customPlaybackController.setPageVisibility).toHaveBeenLastCalledWith(true);
            expect(customPlaybackController.takeCurrentFrame).toHaveBeenCalledTimes(3);
            expect(presenter.presentDecodedFrame).toHaveBeenLastCalledWith(
                resyncedFrame,
                1,
                expect.any(Function)
            );
            expect(customPlaybackController.notifyFramePresented)
                .toHaveBeenLastCalledWith(resyncedFrame);
        } finally {
            restoreDocumentVisibility();
        }
    });

    it('drains custom playback that starts hidden until its controller is detached', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        vi.useFakeTimers();

        try {
            changeDocumentVisibility('hidden');
            await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
            const customPlaybackController = getCustomPlaybackController();
            expect(customPlaybackController.setPageVisibility.mock.calls).toEqual([ [ false ] ]);
            await vi.advanceTimersByTimeAsync(CUSTOM_PLAYBACK_BACKGROUND_DRAIN_INTERVAL_MILLISECONDS);
            expect(customPlaybackController.drainBackgroundVideo).toHaveBeenCalledOnce();

            await player.stop(false);
            await vi.advanceTimersByTimeAsync(
                CUSTOM_PLAYBACK_BACKGROUND_DRAIN_INTERVAL_MILLISECONDS * 4
            );

            expect(customPlaybackController.destroy).toHaveBeenCalledOnce();
            expect(customPlaybackController.drainBackgroundVideo).toHaveBeenCalledOnce();
        } finally {
            restoreDocumentVisibility();
        }
    });

    it('re-decodes one paused frame after presentation invalidation without restarting HTML playback', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        customPlaybackController.currentTimeMicroseconds = 2_750_000;
        player.pause();
        expect(backend.notifyCustomPlaybackPaused).toHaveBeenCalledOnce();

        presenter.decodedPresentationRefreshHandler(1);
        presenter.decodedPresentationRefreshHandler(2);
        presenter.decodedPresentationRefreshHandler(1);
        customPlaybackController.eventHandler({
            generation: 2,
            reason: 'startup',
            type: 'waiting'
        });

        expect(presenter.seek).toHaveBeenCalledWith(2);
        expect(presenter.setDecodedFramePushMode).toHaveBeenCalledWith(true, 2);
        expect(customPlaybackController.seek).toHaveBeenCalledOnce();
        expect(customPlaybackController.seek).toHaveBeenCalledWith(2_750_000);
        expect(backend.notifyCustomPlaybackWaiting).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(customPlaybackController.playbackState).toBe('paused'));
        expect(backend.notifyCustomPlaybackPaused).toHaveBeenCalledOnce();
        expect(animationFrameMockState.callbacks.size).toBe(1);
        expect(backend.play).not.toHaveBeenCalled();
    });

    it('preserves an unpause requested during a paused presentation refresh', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        const deferredRefresh = createDeferred<{
            fallbackReason: null
            generation: number
            status: 'started'
        }>();
        let resumeRequested = false;
        customPlaybackController.seek.mockImplementationOnce((mediaTimeMicroseconds: number) => {
            customPlaybackController.currentTimeMicroseconds = mediaTimeMicroseconds;
            customPlaybackController.playbackState = 'seeking';
            customPlaybackController.eventHandler({
                generation: 2,
                previousState: 'paused',
                state: 'seeking',
                type: 'statechange'
            });
            customPlaybackController.eventHandler({
                generation: 2,
                reason: 'startup',
                type: 'waiting'
            });
            return deferredRefresh.promise.then(result => {
                customPlaybackController.playbackState = resumeRequested ? 'playing' : 'paused';
                customPlaybackController.eventHandler({
                    generation: 2,
                    previousState: 'seeking',
                    state: customPlaybackController.playbackState,
                    type: 'statechange'
                });
                if (resumeRequested) {
                    customPlaybackController.eventHandler({ generation: 2, type: 'playing' });
                }
                return result;
            });
        });
        customPlaybackController.resume.mockImplementationOnce(() => {
            resumeRequested = true;
        });
        customPlaybackController.currentTimeMicroseconds = 2_750_000;
        player.pause();
        const unpauseListener = vi.fn();
        Events.on(player, 'unpause', unpauseListener);

        presenter.decodedPresentationRefreshHandler(1);
        expect(customPlaybackController.playbackState).toBe('seeking');
        expect(backend.notifyCustomPlaybackWaiting).not.toHaveBeenCalled();
        player.resume();
        deferredRefresh.resolve({
            fallbackReason: null,
            generation: 2,
            status: 'started'
        });

        await vi.waitFor(() => expect(customPlaybackController.playbackState).toBe('playing'));
        expect(backend.notifyCustomPlaybackPlaying).toHaveBeenLastCalledWith(true);
        expect(unpauseListener).toHaveBeenCalledOnce();
        expect(backend.notifyCustomPlaybackPaused).toHaveBeenCalledOnce();
        expect(backend.notifyCustomPlaybackWaiting).not.toHaveBeenCalled();
        expect(backend.play).not.toHaveBeenCalled();
    });

    it('preserves the paused shell event when a user seek supersedes a refresh', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        const deferredRefresh = createDeferred<{
            fallbackReason: null
            generation: number
            status: 'superseded'
        }>();
        customPlaybackController.seek.mockImplementationOnce((mediaTimeMicroseconds: number) => {
            customPlaybackController.currentTimeMicroseconds = mediaTimeMicroseconds;
            customPlaybackController.playbackState = 'seeking';
            customPlaybackController.eventHandler({
                generation: 2,
                previousState: 'paused',
                state: 'seeking',
                type: 'statechange'
            });
            customPlaybackController.eventHandler({
                generation: 2,
                reason: 'startup',
                type: 'waiting'
            });
            return deferredRefresh.promise;
        }).mockImplementationOnce((mediaTimeMicroseconds: number) => {
            customPlaybackController.currentTimeMicroseconds = mediaTimeMicroseconds;
            customPlaybackController.eventHandler({
                generation: 3,
                reason: 'startup',
                type: 'waiting'
            });
            return Promise.resolve().then(() => {
                customPlaybackController.playbackState = 'playing';
                customPlaybackController.eventHandler({
                    generation: 3,
                    previousState: 'seeking',
                    state: 'playing',
                    type: 'statechange'
                });
                customPlaybackController.eventHandler({ generation: 3, type: 'playing' });
                return {
                    fallbackReason: null,
                    generation: 3,
                    status: 'started'
                };
            });
        });
        customPlaybackController.resume.mockImplementationOnce(() => undefined);
        customPlaybackController.currentTimeMicroseconds = 2_750_000;
        player.pause();
        const unpauseListener = vi.fn();
        Events.on(player, 'unpause', unpauseListener);

        presenter.decodedPresentationRefreshHandler(1);
        player.resume();
        player.currentTime(3_250);

        await vi.waitFor(() => expect(customPlaybackController.playbackState).toBe('playing'));
        expect(customPlaybackController.seek).toHaveBeenCalledTimes(2);
        expect(customPlaybackController.seek).toHaveBeenLastCalledWith(3_250_000);
        expect(backend.notifyCustomPlaybackPlaying).toHaveBeenLastCalledWith(true);
        expect(unpauseListener).toHaveBeenCalledOnce();
        expect(backend.notifyCustomPlaybackPaused).toHaveBeenCalledOnce();
        expect(backend.notifyCustomPlaybackWaiting).toHaveBeenCalledOnce();

        deferredRefresh.resolve({
            fallbackReason: null,
            generation: 2,
            status: 'superseded'
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(unpauseListener).toHaveBeenCalledOnce();
    });

    it('discards a pending paused presentation refresh when playback stops', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        const deferredRefresh = createDeferred<{
            fallbackReason: null
            generation: number
            status: 'started'
        }>();
        customPlaybackController.seek.mockReturnValueOnce(deferredRefresh.promise);
        player.pause();
        presenter.decodedPresentationRefreshHandler(1);
        expect(customPlaybackController.seek).toHaveBeenCalledOnce();

        await player.stop(false);
        deferredRefresh.resolve({
            fallbackReason: null,
            generation: 2,
            status: 'started'
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(animationFrameMockState.callbacks.size).toBe(0);
        expect(backend.play).not.toHaveBeenCalled();
        expect(customPlaybackController.destroy).toHaveBeenCalledOnce();
    });

    it('reports custom playback as seekable only while its duration is known', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();

        expect(player.seekable()).toBe(true);
        // The host seeks by percent of duration; an unprobed source has none
        customPlaybackController.durationMicroseconds = null;
        expect(player.seekable()).toBe(false);
        expect(player.duration()).toBeNull();
    });

    it('routes custom clock, pause, gain, mute, and stream controls through the shell', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        const pauseListener = vi.fn();
        const playingListener = vi.fn();
        const timeListener = vi.fn();
        const waitingListener = vi.fn();
        Events.on(player, 'pause', pauseListener);
        Events.on(player, 'playing', playingListener);
        Events.on(player, 'timeupdate', timeListener);
        Events.on(player, 'waiting', waitingListener);

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        customPlaybackController.currentTimeMicroseconds = 3_250_000;
        customPlaybackController.eventHandler({
            currentTimeMicroseconds: 3_250_000,
            durationMicroseconds: 60_000_000,
            generation: 1,
            type: 'timeupdate'
        });
        customPlaybackController.eventHandler({
            generation: 1,
            reason: 'video-frame',
            type: 'waiting'
        });
        player.pause();
        player.resume();
        player.setVolume('80');
        player.setMute(true);
        customDecodeMockState.audioTrackIndex = 1;
        player.setAudioStreamIndex(3);
        await vi.waitFor(() => (
            expect(customPlaybackController.setAudioStreamIndex).toHaveBeenCalledWith(
                1,
                'decoded-pcm',
                2,
                createDefaultAudioDownmixSettings()
            )
        ));

        expect(player.currentTime()).toBe(3_250);
        expect(player.duration()).toBe(60_000);
        expect(timeListener).toHaveBeenCalled();
        expect(waitingListener).toHaveBeenCalledOnce();
        expect(pauseListener).toHaveBeenCalledOnce();
        expect(playingListener).toHaveBeenCalledTimes(2);
        expect(customPlaybackController.pause).toHaveBeenCalledOnce();
        expect(customPlaybackController.resume).toHaveBeenCalledOnce();
        const lastVolume = customPlaybackController.setVolume.mock.calls.at(-1)?.[0];
        expect(lastVolume).toBeCloseTo(0.512);
        expect(customPlaybackController.setNormalizationGain).toHaveBeenLastCalledWith(1);
        expect(customPlaybackController.setMuted).toHaveBeenLastCalledWith(true);
        expect(backend.setVolume).toHaveBeenLastCalledWith(80);
        expect(customPlaybackController.setAudioStreamIndex).toHaveBeenCalledWith(
            1,
            'decoded-pcm',
            2,
            createDefaultAudioDownmixSettings()
        );
        expect(player.getVolume()).toBe(80);
        expect(player.isMuted()).toBe(true);
    });

    it('rejects empty, nonnumeric, and out-of-range volume values', () => {
        const player = new WebGPUPlayer();

        expect(() => player.setVolume('')).toThrow(RangeError);
        expect(() => player.setVolume('not-a-volume')).toThrow(RangeError);
        expect(() => player.setVolume(-1)).toThrow(RangeError);
        expect(() => player.setVolume(101)).toThrow(RangeError);
    });

    it('applies the selected Jellyfin normalization gain independently of slider volume', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        const options = createKnownSDRAudioPlayOptions();
        const mediaSource = options.mediaSource as Record<string, unknown>;
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        options.item = { NormalizationGain: 20 * Math.log10(2) };
        mediaSource.albumNormalizationGain = 20 * Math.log10(0.5);
        userSettingsMockState.audioNormalizationMode = 'AlbumGain';
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.audioTrackIndex = 1;

        await player.play(options);

        const customPlaybackController = getCustomPlaybackController();
        expect(customPlaybackController.setNormalizationGain).toHaveBeenCalledOnce();
        expect(customPlaybackController.setNormalizationGain.mock.calls[0]?.[0])
            .toBeCloseTo(0.5);
        expect(customPlaybackController.setVolume).toHaveBeenCalledWith(0.125);
    });

    it('preserves normalization and logical volume across native fallback', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        const options = createKnownSDRAudioPlayOptions();
        const mediaSource = options.mediaSource as Record<string, unknown>;
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        options.item = { NormalizationGain: 20 * Math.log10(2) };
        mediaSource.albumNormalizationGain = 20 * Math.log10(0.5);
        userSettingsMockState.audioNormalizationMode = 'AlbumGain';
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.audioTrackIndex = 1;

        await player.play(options);
        const customPlaybackController = getCustomPlaybackController();
        await customPlaybackController.fallbackHook({
            disposition: 'same-session-native',
            generation: 1,
            mediaTimeMicroseconds: 2_500_000,
            preserveHTMLSession: true,
            reason: 'lifecycle-failed'
        });

        const fallbackVolume = backend.setVolume.mock.calls.at(-1)?.[0] as number;
        expect((fallbackVolume / 100) ** 3).toBeCloseTo(0.0625);
        expect(player.getVolume()).toBe(50);

        player.setVolume(80);
        const adjustedVolume = backend.setVolume.mock.calls.at(-1)?.[0] as number;
        expect((adjustedVolume / 100) ** 3).toBeCloseTo(0.256);
        expect(player.getVolume()).toBe(80);

        player.destroy();
        expect(backend.setVolume).toHaveBeenLastCalledWith(80);
    });

    it('makes overlapping custom audio selections strictly last-write-wins', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.audioTrackIndex = 1;
        customDecodeMockState.audioSourceChannelCount = 8;
        audioPrewarmMockState.maximumChannelCount = 8;
        const defaults = createDefaultWebGPUUserSettings();
        const sessionDownmixSettings = {
            centerLevel: 0.4,
            outputGain: 0.6,
            surroundLevel: 0.5,
            version: 1 as const
        };
        userSettingsMockState.webGPUPlaybackSettings = JSON.stringify({
            ...defaults,
            audio: {
                downmix: sessionDownmixSettings,
                forceStereoDownmix: false
            }
        });
        await player.play(createKnownSDRAudioPlayOptions());
        expect(player.getCustomPlaybackSelectedAudioStreamIndex()).toBe(1);
        const customPlaybackController = getCustomPlaybackController();
        userSettingsMockState.webGPUPlaybackSettings = JSON.stringify({
            ...defaults,
            audio: {
                downmix: {
                    centerLevel: 0,
                    outputGain: 0,
                    surroundLevel: 0,
                    version: 1
                },
                forceStereoDownmix: true
            }
        });
        const firstSelection = createDeferred<boolean>();
        const secondSelection = createDeferred<boolean>();
        playbackPreferencesMockState.customDecodeEnabledPromises.push(
            firstSelection.promise,
            secondSelection.promise
        );

        player.setAudioStreamIndex(3);
        player.setAudioStreamIndex(4);
        expect(player.getCustomPlaybackSelectedAudioStreamIndex()).toBe(4);
        secondSelection.resolve(true);
        await vi.waitFor(() => (
            expect(customPlaybackController.setAudioStreamIndex).toHaveBeenCalledOnce()
        ));
        firstSelection.resolve(true);
        await Promise.resolve();
        await Promise.resolve();

        expect(customPlaybackController.setAudioStreamIndex).toHaveBeenCalledOnce();
        expect(customPlaybackController.setAudioStreamIndex).toHaveBeenCalledWith(
            1,
            'decoded-pcm',
            8,
            sessionDownmixSettings
        );
    });

    it('reports custom pipeline stats and delegates live renderer controls', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const stats = await player.getStats() as {
            categories: Array<{ stats: Array<{ label: string, value: string }> }>
        };
        const settings: HDRToSDRRenderSettings = {
            display: { brightness: 0, contrast: 1, saturation: 1 },
            mode: 'hdr-to-sdr' as const,
            outputTransfer: 'srgb' as const,
            toneMapping: {
                desaturationStrength: 0.25,
                exposure: 0,
                inputPeakNits: 1_000,
                operator: 'aces' as const,
                outputPeakNits: 100,
                paperWhiteNits: 203
            },
            version: RENDER_SETTINGS_VERSION
        };

        expect(stats.categories[0].stats).toContainEqual({
            label: 'Playback pipeline',
            value: 'WebCodecs / WebGPU'
        });
        // Engine codes reach the overlay as translated text
        expect(stats.categories[1].stats).toContainEqual({
            label: 'Video path',
            value: 'WebCodecs decoder / Video frames'
        });
        expect(stats.categories[0].stats).toContainEqual({ label: 'State', value: 'Idle' });
        // Stale discards count as dropped too, and the timing rows round to whole milliseconds
        expect(stats.categories[1].stats).toEqual(expect.arrayContaining([
            { label: 'Dropped / queued frames', value: '2 / 0' },
            { label: 'Stale frames discarded', value: '2' },
            { label: 'Late frames / worst lag', value: '4 / 100 ms' },
            { label: 'Clock resets / largest jump', value: '3 / 42 ms' }
        ]));
        expect(backend.getStats).not.toHaveBeenCalled();
        expect(player.updateRenderSettings(settings)).toBe(true);
        expect(presenter.updateRenderSettings).toHaveBeenCalledWith(settings, 1, true);
        expect(player.getRenderSettings()).toEqual({
            mode: 'identity-sdr',
            version: RENDER_SETTINGS_VERSION
        });
    });

    it('preserves a custom audio switch when later falling back to native playback', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        const options = {
            audioStreamIndex: 1,
            mediaSource: {
                DefaultAudioStreamIndex: 1,
                MediaStreams: [{ Type: 'Video', VideoRangeType: 'SDR' }]
            },
            playMethod: 'DirectPlay'
        };

        await player.play(options);
        const customPlaybackController = getCustomPlaybackController();
        customDecodeMockState.audioTrackIndex = 1;
        player.setAudioStreamIndex(3);
        await vi.waitFor(() => (
            expect(customPlaybackController.setAudioStreamIndex).toHaveBeenCalledWith(
                1,
                'decoded-pcm',
                2,
                createDefaultAudioDownmixSettings()
            )
        ));
        await customPlaybackController.fallbackHook({
            disposition: 'same-session-native',
            generation: 2,
            mediaTimeMicroseconds: 4_000_000,
            preserveHTMLSession: true,
            reason: 'lifecycle-failed'
        });

        expect(backend.play).toHaveBeenCalledWith({
            ...options,
            audioStreamIndex: 3,
            mediaSource: {
                ...options.mediaSource,
                DefaultAudioStreamIndex: 3
            },
            playerStartPositionTicks: 40_000_000,
            suppressInitialUnpause: true
        });
    });

    it('uses same-session native fallback after augmentation only with exact base-profile proof', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        backend.profile = createNativeCompatibleProfile();
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        await player.getDeviceProfile({ Id: 'item' }, { isRetry: false });
        const options = createNativeCompatiblePlayOptions();

        await player.play(options);
        const customPlaybackController = getCustomPlaybackController();
        await customPlaybackController.fallbackHook({
            disposition: 'same-session-native',
            generation: 1,
            mediaTimeMicroseconds: 4_000_000,
            preserveHTMLSession: true,
            reason: 'lifecycle-failed'
        });

        expect(backend.play).toHaveBeenCalledOnce();
        expect(backend.play).toHaveBeenCalledWith({
            ...options,
            playerStartPositionTicks: 40_000_000,
            suppressInitialUnpause: true
        });
    });

    it('does not use a prior item native profile as current-session fallback proof', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        backend.profile = createNativeCompatibleProfile();
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        const errorListener = vi.fn();
        Events.on(player, 'error', errorListener);
        await player.getDeviceProfile({ Id: 'previous-item' }, { isRetry: false });
        const options = createNativeCompatiblePlayOptions();

        await player.play(options);
        const customPlaybackController = getCustomPlaybackController();
        await customPlaybackController.fallbackHook({
            disposition: 'same-session-native',
            generation: 1,
            mediaTimeMicroseconds: 4_000_000,
            preserveHTMLSession: true,
            reason: 'lifecycle-failed'
        });

        expect(backend.play).not.toHaveBeenCalled();
        expect(errorListener).toHaveBeenCalledOnce();
        expect(errorListener.mock.calls[0][1]).toEqual({
            type: MediaError.MEDIA_NOT_SUPPORTED
        });
    });

    it('coalesces repeated custom fallback requests into one native start', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        const nativePlay = createDeferred<unknown>();
        backend.play.mockReturnValue(nativePlay.promise);

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        const request = {
            disposition: 'same-session-native',
            generation: 1,
            mediaTimeMicroseconds: 4_000_000,
            preserveHTMLSession: true,
            reason: 'lifecycle-failed'
        };
        const firstFallback = customPlaybackController.fallbackHook(request);
        const secondFallback = customPlaybackController.fallbackHook(request);
        await vi.waitFor(() => expect(backend.play).toHaveBeenCalledOnce());
        nativePlay.resolve(undefined);
        await Promise.all([ firstFallback, secondFallback ]);

        expect(customPlaybackController.destroy).toHaveBeenCalledOnce();
        expect(backend.play).toHaveBeenCalledOnce();
    });

    it('emits one terminal error when an established native fallback fails', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        const defaults = createDefaultWebGPUUserSettings();
        userSettingsMockState.webGPUPlaybackSettings = JSON.stringify({
            ...defaults,
            render: {
                ...defaults.render,
                automaticInputPeakNits: false
            }
        });
        const errorListener = vi.fn();
        Events.on(player, 'error', errorListener);

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        const fallbackError = new Error('native fallback failed');
        backend.play.mockRejectedValueOnce(fallbackError);
        await expect(customPlaybackController.fallbackHook({
            disposition: 'same-session-native',
            generation: 1,
            mediaTimeMicroseconds: 4_000_000,
            preserveHTMLSession: true,
            reason: 'lifecycle-failed'
        })).rejects.toBe(fallbackError);

        expect(backend.play).toHaveBeenCalledOnce();
        expect(backend.stop).toHaveBeenCalledOnce();
        expect(errorListener).toHaveBeenCalledOnce();
        expect(errorListener.mock.calls[0][1]).toEqual({
            type: MediaError.PLAYER_ERROR
        });
    });

    it('renegotiates a decoder failure during custom startup without a native source attempt', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.startupFallback = true;
        const errorListener = vi.fn();
        Events.on(player, 'error', errorListener);

        // Without an accepting listener the start resolves first, so the stock retry ladder sees a recorded start
        await expect(player.play(
            createKnownSDRPlayOptions({ playMethod: 'DirectPlay' })
        )).resolves.toBeUndefined();

        expect(backend.play).not.toHaveBeenCalled();
        expect(errorListener).not.toHaveBeenCalled();
        await waitForMacrotask();
        expect(errorListener).toHaveBeenCalledOnce();
        expect(errorListener.mock.calls[0][1]).toEqual({
            type: MediaError.MEDIA_NOT_SUPPORTED
        });
        expect(player.currentTime()).toBe(1_000);
    });

    it('completes accepted startup renegotiation without superseding the UI session', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.startupFallback = true;
        const errorListener = vi.fn();
        const renegotiationListener = vi.fn((
            _event: unknown,
            request: { accept: () => void }
        ): void => {
            request.accept();
        });
        Events.on(player, 'error', errorListener);
        Events.on(player, 'sourcerenegotiationrequired', renegotiationListener);

        await expect(player.play(
            createKnownSDRPlayOptions({ playMethod: 'DirectPlay' })
        )).resolves.toBeUndefined();

        expect(renegotiationListener).toHaveBeenCalledOnce();
        expect(errorListener).not.toHaveBeenCalled();
        expect(backend.play).not.toHaveBeenCalled();
        // An accepted request leaves no error deferred behind the start
        await waitForMacrotask();
        expect(errorListener).not.toHaveBeenCalled();
    });

    it('rejects asynchronous source-renegotiation acceptance', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.startupFallback = true;
        const errorListener = vi.fn();
        Events.on(player, 'error', errorListener);
        Events.on(player, 'sourcerenegotiationrequired', (
            _event: unknown,
            request: { accept: () => void }
        ): void => {
            void Promise.resolve().then(request.accept);
        });

        await expect(player.play(
            createKnownSDRPlayOptions({ playMethod: 'DirectPlay' })
        )).resolves.toBeUndefined();
        await Promise.resolve();

        // The late acceptance neither suppresses nor duplicates the deferred error
        expect(errorListener).not.toHaveBeenCalled();
        await waitForMacrotask();
        expect(errorListener).toHaveBeenCalledOnce();
        expect(errorListener.mock.calls[0][1]).toEqual({
            type: MediaError.MEDIA_NOT_SUPPORTED
        });
    });

    it('drops a deferred startup renegotiation error when playback stops first', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.startupFallback = true;
        const errorListener = vi.fn();
        // Never accepts, so the request is deferred to the generic error contract
        const renegotiationListener = vi.fn();
        Events.on(player, 'error', errorListener);
        Events.on(player, 'sourcerenegotiationrequired', renegotiationListener);

        await expect(player.play(
            createKnownSDRPlayOptions({ playMethod: 'DirectPlay' })
        )).resolves.toBeUndefined();
        // Only promise reactions have run since the start resolved, so the error timer is still pending
        const stopPromise = player.stop(false);
        await waitForMacrotask();
        await stopPromise;
        await waitForMacrotask();

        expect(renegotiationListener).toHaveBeenCalledOnce();
        expect(errorListener).not.toHaveBeenCalled();
        expect(backend.stop).toHaveBeenCalledOnce();
        expect(backend.play).not.toHaveBeenCalled();
    });

    it('drops a deferred startup renegotiation error when a newer play starts first', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.startupFallback = true;
        const errorListener = vi.fn();
        // Never accepts, so the request is deferred to the generic error contract
        const renegotiationListener = vi.fn();
        Events.on(player, 'error', errorListener);
        Events.on(player, 'sourcerenegotiationrequired', renegotiationListener);

        await expect(player.play(
            createKnownSDRPlayOptions({ playMethod: 'DirectPlay' })
        )).resolves.toBeUndefined();
        // Only promise reactions have run since the start resolved, so the error timer is still pending
        customDecodeMockState.startupFallback = false;
        const replacementPlayPromise = player.play(
            createKnownSDRPlayOptions({ playMethod: 'DirectPlay' })
        );
        await waitForMacrotask();
        await expect(replacementPlayPromise).resolves.toBeUndefined();
        await waitForMacrotask();

        expect(renegotiationListener).toHaveBeenCalledOnce();
        expect(errorListener).not.toHaveBeenCalled();
        expect(customDecodeMockState.instances).toHaveLength(2);
        expect(getCustomPlaybackController().playbackState).toBe('playing');
        expect(backend.play).not.toHaveBeenCalled();
    });

    it('reports a pending play during startup renegotiation but not to its deferred error', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.startupFallback = true;
        const pendingPlayReports: Array<{ event: string, pendingPlay: boolean }> = [];
        // A listener that never accepts leaves the request on the generic error contract
        Events.on(player, 'sourcerenegotiationrequired', (): void => {
            pendingPlayReports.push({
                event: 'sourcerenegotiationrequired',
                pendingPlay: player.hasPendingPlay()
            });
        });
        Events.on(player, 'error', (): void => {
            pendingPlayReports.push({ event: 'error', pendingPlay: player.hasPendingPlay() });
        });

        await expect(player.play(
            createKnownSDRPlayOptions({ playMethod: 'DirectPlay' })
        )).resolves.toBeUndefined();
        expect(player.hasPendingPlay()).toBe(false);
        await waitForMacrotask();

        expect(pendingPlayReports).toEqual([
            { event: 'sourcerenegotiationrequired', pendingPlay: true },
            { event: 'error', pendingPlay: false }
        ]);
    });

    it('uses native playback when the custom presentation cannot initialize', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        presenter.configureColorPipeline.mockResolvedValueOnce(false);
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        const options = createKnownSDRPlayOptions({ playMethod: 'DirectPlay' });
        await player.play(options);

        expect(backend.prepareCustomPlayback).toHaveBeenCalledOnce();
        expect(customDecodeMockState.instances).toHaveLength(0);
        expect(backend.play).toHaveBeenCalledWith(options);
    });

    it('renegotiates instead of replaying a widened source when presentation fails', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        presenter.configureColorPipeline.mockResolvedValueOnce(false);
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        const errorListener = vi.fn();
        Events.on(player, 'error', errorListener);
        await player.getDeviceProfile({ Id: 'item' }, { isRetry: false });

        const result = await player.play(createKnownSDRPlayOptions({
            playMethod: 'DirectPlay',
            playerStartPositionTicks: 20_000_000
        }));

        expect(result).toBeUndefined();
        expect(backend.play).not.toHaveBeenCalled();
        expect(errorListener).not.toHaveBeenCalled();
        await waitForMacrotask();
        expect(errorListener).toHaveBeenCalledOnce();
        expect(errorListener.mock.calls[0][1]).toEqual({
            type: MediaError.MEDIA_NOT_SUPPORTED
        });
        expect(player.currentTime()).toBe(2_000);
    });

    it('renegotiates a widened source when custom decode is disabled before play', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        const errorListener = vi.fn();
        Events.on(player, 'error', errorListener);
        await player.getDeviceProfile({ Id: 'item' }, { isRetry: false });
        playbackPreferencesMockState.customDecodeEnabled = false;

        const result = await player.play(createKnownSDRPlayOptions({
            playMethod: 'DirectPlay',
            playerStartPositionTicks: 20_000_000
        }));

        expect(result).toBeUndefined();
        expect(backend.play).not.toHaveBeenCalled();
        expect(errorListener).not.toHaveBeenCalled();
        await waitForMacrotask();
        expect(errorListener).toHaveBeenCalledOnce();
        expect(errorListener.mock.calls[0][1]).toEqual({
            type: MediaError.MEDIA_NOT_SUPPORTED
        });
        expect(player.currentTime()).toBe(2_000);
    });

    it('renegotiates a widened direct-stream source when custom decode is disabled', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        const errorListener = vi.fn();
        Events.on(player, 'error', errorListener);
        await player.getDeviceProfile({ Id: 'item' }, { isRetry: false });
        playbackPreferencesMockState.customDecodeEnabled = false;

        const result = await player.play(createKnownSDRPlayOptions({
            playMethod: 'DirectStream',
            playerStartPositionTicks: 20_000_000
        }));

        expect(result).toBeUndefined();
        expect(backend.play).not.toHaveBeenCalled();
        expect(errorListener).not.toHaveBeenCalled();
        await waitForMacrotask();
        expect(errorListener).toHaveBeenCalledOnce();
        expect(errorListener.mock.calls[0][1]).toEqual({
            type: MediaError.MEDIA_NOT_SUPPORTED
        });
        expect(player.currentTime()).toBe(2_000);
    });

    it('bounds custom setup and retries a widened source from its session start', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        presenter.configureColorPipeline.mockReturnValue(new Promise<boolean>(() => undefined));
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        const errorListener = vi.fn();
        Events.on(player, 'error', errorListener);
        await player.getDeviceProfile({ Id: 'item' }, { isRetry: false });
        vi.useFakeTimers();

        const playPromise = player.play(createKnownSDRPlayOptions({
            playMethod: 'DirectPlay',
            playerStartPositionTicks: 30_000_000
        }));
        await vi.advanceTimersByTimeAsync(0);
        expect(presenter.configureColorPipeline).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(
            microsecondsToMilliseconds(CUSTOM_PLAYBACK_SETUP_TIMEOUT_MICROSECONDS)
        );

        await expect(playPromise).resolves.toBeUndefined();
        expect(player.getCustomPlaybackSetupTelemetry()).toEqual({
            stage: 'presentation',
            status: 'timeout'
        });
        expect(backend.play).not.toHaveBeenCalled();
        expect(errorListener).not.toHaveBeenCalled();
        // The deferred error rides a zero-delay timer on the fake clock
        await vi.runOnlyPendingTimersAsync();
        expect(errorListener).toHaveBeenCalledOnce();
        expect(errorListener.mock.calls[0][1]).toEqual({
            type: MediaError.MEDIA_NOT_SUPPORTED
        });
        expect(player.currentTime()).toBe(3_000);
    });

    it('leaves a started controller to its own progress-aware startup bound', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.holdPlay = true;
        await player.getDeviceProfile({ Id: 'item' }, { isRetry: false });
        vi.useFakeTimers();

        void player.play(createKnownSDRPlayOptions({
            playMethod: 'DirectPlay',
            playerStartPositionTicks: 0
        }));
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(
            microsecondsToMilliseconds(CUSTOM_PLAYBACK_SETUP_TIMEOUT_MICROSECONDS) + 1_000
        );

        // The setup deadline was released when the controller started
        expect(player.getCustomPlaybackSetupTelemetry()).toEqual({
            stage: 'controller',
            status: 'in-progress'
        });
        expect(backend.play).not.toHaveBeenCalled();
    });

    it('keeps augmentation conservative across an overlapping retry profile query', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = false;
        const errorListener = vi.fn();
        Events.on(player, 'error', errorListener);
        await player.getDeviceProfile({ Id: 'item' }, { isRetry: false });
        await player.getDeviceProfile({ Id: 'item' }, { isRetry: true });
        player.currentTime(42_000);

        const result = await player.play(createKnownSDRPlayOptions({
            playMethod: 'DirectPlay',
            playerStartPositionTicks: 0
        }));

        expect(result).toBeUndefined();
        expect(backend.play).not.toHaveBeenCalled();
        expect(errorListener).not.toHaveBeenCalled();
        await waitForMacrotask();
        expect(errorListener).toHaveBeenCalledOnce();
        expect(errorListener.mock.calls[0][1]).toEqual({
            type: MediaError.MEDIA_NOT_SUPPORTED
        });
        expect(player.currentTime()).toBe(0);
    });

    it('warns why a declined widened source requests renegotiation', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = false;
        const errorListener = vi.fn();
        Events.on(player, 'error', errorListener);
        await player.getDeviceProfile({ Id: 'item' }, { isRetry: false });
        const consoleWarning = vi.spyOn(console, 'warn').mockImplementation((): void => undefined);

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));

        expect(consoleWarning).toHaveBeenCalledExactlyOnceWith(
            'Custom playback is ineligible; requesting source renegotiation',
            'invalid-options'
        );
        expect(backend.play).not.toHaveBeenCalled();
        await waitForMacrotask();
        expect(errorListener).toHaveBeenCalledOnce();
    });

    it('advances the shared generation when presentation falls back', async () => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        await player.play(createKnownSDRPlayOptions());

        presenter.fallbackHandler(1);
        player.currentTime(1_000);

        expect(presenter.seek).toHaveBeenCalledWith(3);
    });

    it('keeps unknown and HDR inputs on direct HTML presentation', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        const HDRPlayOptions = {
            mediaSource: {
                MediaStreams: [{ Type: 'Video', VideoRangeType: 'HDR10' }]
            }
        };

        await expect(player.play(HDRPlayOptions)).resolves.toBe(HDRPlayOptions);

        expect(presenter.startSession).not.toHaveBeenCalled();
        expect(presenter.attach).not.toHaveBeenCalled();
        expect(presenter.endSession).toHaveBeenCalledWith(1);
    });

    it('converts player timing through integer microseconds at millisecond boundaries', () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();

        backend.currentTimeMilliseconds = 12.3456789;
        backend.durationMilliseconds = 98.7654321;
        expect(player.currentTime()).toBe(12.346);
        expect(player.duration()).toBe(98.765);

        player.currentTime(-12.3456789);
        expect(backend.currentTime).toHaveBeenLastCalledWith(-12.346);
    });

    it('exposes the complete manager-facing delegation surface', () => {
        const player = new WebGPUPlayer();
        const methodNames = [
            'canPlayMediaType', 'canPlayItem', 'supportsPlayMethod', 'supportsVideoStreamCopy',
            'getDeviceProfile',
            'supports', 'currentSrc', 'cancelPendingPlay', 'play', 'stop', 'destroy', 'currentTime',
            'duration', 'seekable', 'pause', 'resume', 'unpause', 'paused',
            'setSubtitleStreamIndex', 'setSecondarySubtitleStreamIndex',
            'resetSubtitleOffset', 'setSubtitleOffset', 'getSubtitleOffset',
            'enableShowingSubtitleOffset',
            'disableShowingSubtitleOffset', 'isShowingSubtitleOffsetEnabled',
            'canSetAudioStreamIndex', 'setAudioStreamIndex', 'setVolume', 'getVolume',
            'volumeUp', 'volumeDown', 'setMute', 'isMuted', 'setPlaybackRate',
            'getPlaybackRate', 'getSupportedPlaybackRates', 'setBrightness',
            'getBrightness', 'setAspectRatio', 'getAspectRatio',
            'getSupportedAspectRatios', 'setPictureInPictureEnabled',
            'isPictureInPictureEnabled', 'togglePictureInPicture',
            'setAirPlayEnabled', 'isAirPlayEnabled', 'toggleAirPlay',
            'getBufferedRanges', 'getStats', 'getPresentationTelemetry'
        ];

        for (const methodName of methodNames) {
            expect(typeof player[methodName as keyof WebGPUPlayer]).toBe('function');
        }
    });

    it('delegates playback, track, output, and reporting methods to the owned backend', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const bufferedRanges = [{ start: 1, end: 2 }];
        const stats = { categories: [{ type: 'video' }] };
        const statsPromise = Promise.resolve(stats);
        backend.getBufferedRanges.mockReturnValue(bufferedRanges);
        backend.getStats.mockReturnValue(statsPromise);

        player.pause();
        player.resume();
        player.unpause();
        player.resetSubtitleOffset();
        player.setSubtitleStreamIndex(3);
        player.setSecondarySubtitleStreamIndex(4);
        player.setAudioStreamIndex(5);
        player.setVolume(62);
        player.setMute(true);
        player.setPlaybackRate(1.25);
        player.setBrightness(80);
        player.setAspectRatio('cover');
        player.setPictureInPictureEnabled(true);
        player.togglePictureInPicture();
        player.setAirPlayEnabled(true);
        player.toggleAirPlay();

        expect(backend.pause).toHaveBeenCalledOnce();
        expect(backend.resume).toHaveBeenCalledOnce();
        expect(backend.unpause).toHaveBeenCalledOnce();
        expect(backend.resetSubtitleOffset).toHaveBeenCalledOnce();
        expect(backend.setSubtitleStreamIndex).toHaveBeenCalledWith(3);
        expect(backend.setSecondarySubtitleStreamIndex).toHaveBeenCalledWith(4);
        expect(backend.setAudioStreamIndex).toHaveBeenCalledWith(5);
        expect(backend.setVolume).toHaveBeenCalledWith(62);
        expect(backend.setMute).toHaveBeenCalledWith(true);
        expect(backend.setPlaybackRate).toHaveBeenCalledWith(1.25);
        expect(backend.setBrightness).toHaveBeenCalledWith(80);
        expect(backend.setAspectRatio).toHaveBeenCalledWith('cover');
        expect(presenter.refresh).toHaveBeenCalledWith(0);
        expect(backend.setPictureInPictureEnabled).toHaveBeenCalledWith(true);
        expect(backend.togglePictureInPicture).toHaveBeenCalledOnce();
        expect(backend.setAirPlayEnabled).toHaveBeenCalledWith(true);
        expect(backend.toggleAirPlay).toHaveBeenCalledOnce();
        expect(player.getVolume()).toBe(50);
        expect(player.isMuted()).toBe(false);
        expect(player.getPlaybackRate()).toBe(1);
        expect(player.getBrightness()).toBe(100);
        expect(player.isPictureInPictureEnabled()).toBe(false);
        expect(player.isAirPlayEnabled()).toBe(false);
        expect(player.getBufferedRanges()).toBe(bufferedRanges);
        expect(player.getStats()).toBe(statsPromise);
        await expect(statsPromise).resolves.toBe(stats);
    });

    it('mirrors backend status properties and masks native-output modes without an HTML session', () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        backend.isFetching = true;
        backend.forcedFullscreen = true;

        expect(player.isFetching).toBe(true);
        expect(player.forcedFullscreen).toBe(true);
        expect(player.supports('PictureInPicture')).toBe(false);
        expect(player.supports('AirPlay')).toBe(false);
        expect(player.supports('PlaybackRate')).toBe(false);
        expect(player.supports('SetBrightness')).toBe(false);
        expect(player.supports('SetAspectRatio')).toBe(true);
    });

    it('exposes native-output capabilities only while direct HTML playback is authoritative', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const nativeOutputFeatures = [
            'AirPlay',
            'PictureInPicture',
            'PlaybackRate',
            'SetBrightness'
        ];

        await player.play({
            mediaSource: {
                MediaStreams: [{ Type: 'Video', VideoRangeType: 'HDR10' }]
            }
        });

        for (const feature of nativeOutputFeatures) {
            expect(player.supports(feature)).toBe(true);
        }

        await player.stop(false);
        for (const feature of nativeOutputFeatures) {
            expect(player.supports(feature)).toBe(false);
        }
        expect(backend.supports).toHaveBeenCalledTimes(nativeOutputFeatures.length);
    });

    it('restores native-output capabilities after WebGPU presentation falls back', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };

        await player.play(createKnownSDRPlayOptions());

        expect(player.supports('PictureInPicture')).toBe(false);
        expect(player.supports('PlaybackRate')).toBe(false);

        presenter.fallbackHandler(1);

        expect(player.supports('PictureInPicture')).toBe(true);
        expect(player.supports('PlaybackRate')).toBe(true);
    });

    it('keeps custom capabilities and ranges masked until native fallback is established', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        const bufferedRanges = [{ start: 1, end: 2 }];
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        backend.getBufferedRanges.mockReturnValue(bufferedRanges);
        playbackPreferencesMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        const customDestroy = createDeferred<void>();
        const nativePlay = createDeferred<unknown>();
        customPlaybackController.destroy.mockReturnValueOnce(customDestroy.promise);
        backend.play.mockReturnValueOnce(nativePlay.promise);

        expect(player.supports('AirPlay')).toBe(false);
        expect(player.supports('SetBrightness')).toBe(false);
        expect(player.getBufferedRanges()).toEqual([]);

        const fallbackPromise = customPlaybackController.fallbackHook({
            disposition: 'same-session-native',
            generation: 1,
            mediaTimeMicroseconds: 4_000_000,
            preserveHTMLSession: true,
            reason: 'lifecycle-failed'
        });

        expect(customPlaybackController.destroy).toHaveBeenCalledOnce();
        expect(backend.play).not.toHaveBeenCalled();
        expect(player.supports('AirPlay')).toBe(false);
        expect(player.getBufferedRanges()).toEqual([]);

        customDestroy.resolve(undefined);
        await vi.waitFor(() => expect(backend.play).toHaveBeenCalledOnce());
        expect(player.supports('AirPlay')).toBe(false);
        expect(player.getBufferedRanges()).toEqual([]);

        nativePlay.resolve(undefined);
        await fallbackPromise;

        expect(player.supports('AirPlay')).toBe(true);
        expect(player.supports('SetBrightness')).toBe(true);
        expect(player.getBufferedRanges()).toBe(bufferedRanges);
    });
});

describe('WebGPUPlayer event and lifecycle contract', () => {
    beforeEach(() => {
        htmlPlayerMockState.instances.length = 0;
        htmlPlayerMockState.owners.length = 0;
        htmlPlayerMockState.constructorOptions.length = 0;
        presenterMockState.instances.length = 0;
        playbackPreferencesMockState.customDecodeEnabled = false;
        customDecodeMockState.audioEligibilityOverride = null;
        customDecodeMockState.eligible = false;
        customDecodeMockState.audioOutputMode = 'decoded-pcm';
        customDecodeMockState.audioTrackIndex = null;
        customDecodeMockState.instances.length = 0;
        customProfileMockState.augmentationCalls.length = 0;
        customProfileMockState.runtimeAvailable = true;
        nativeAudioCapabilityMockState.capabilities = null;
    });

    it('pins the complete HTML backend event surface', () => {
        expect(HTML_PLAYER_EVENTS).toEqual(EXPECTED_HTML_PLAYER_EVENTS);
    });

    it.each(EXPECTED_HTML_PLAYER_EVENTS)('forwards %s once with wrapper identity and unchanged arguments', async eventName => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const listener = vi.fn();
        const firstArgument = { value: 1 };
        const secondArgument = ['second'];
        Events.on(player, eventName, listener);

        await player.play({});
        Events.trigger(backend, eventName, [firstArgument, secondArgument]);

        expect(listener).toHaveBeenCalledOnce();
        expect(listener.mock.contexts[0]).toBe(player);
        expect(listener.mock.calls[0][0]).toEqual({ type: eventName });
        expect(listener.mock.calls[0][1]).toBe(firstArgument);
        expect(listener.mock.calls[0][2]).toBe(secondArgument);
    });

    it('replaces forwarding handlers without duplicating events across sessions', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const listener = vi.fn();
        Events.on(player, 'timeupdate', listener);

        await player.play({ source: 1 });
        await player.play({ source: 2 });
        Events.trigger(backend, 'timeupdate');

        expect(listener).toHaveBeenCalledOnce();
    });

    it('serializes overlapping backend play requests and skips stale presentation', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const firstPlayDeferred = createDeferred<unknown>();
        const secondPlayDeferred = createDeferred<unknown>();
        backend.play.mockImplementation((options: { source: number }) => {
            return options.source === 1 ? firstPlayDeferred.promise : secondPlayDeferred.promise;
        });

        const firstPlayPromise = player.play({ source: 1 });
        const secondPlayPromise = player.play({ source: 2 });

        expect(backend.play).toHaveBeenCalledOnce();
        expect(backend.play).toHaveBeenCalledWith({ source: 1 });

        firstPlayDeferred.resolve('first');
        await vi.waitFor(() => expect(backend.play).toHaveBeenCalledTimes(2));
        expect(backend.stop).toHaveBeenCalledOnce();
        expect(backend.stop).toHaveBeenCalledWith(false);
        expect(backend.play).toHaveBeenLastCalledWith({ source: 2 });

        secondPlayDeferred.resolve('second');
        await expect(firstPlayPromise).resolves.toBe(PLAYBACK_SUPERSEDED);
        await expect(secondPlayPromise).resolves.toBe('second');
        expect(getPresenter().attach).not.toHaveBeenCalled();
    });

    it('does not queue stop behind an unresolved backend play request', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const playDeferred = createDeferred<unknown>();
        backend.play.mockReturnValueOnce(playDeferred.promise);

        const playPromise = player.play({ source: 1 });
        const stopPromise = player.stop(false);

        expect(backend.cancelPendingPlay).toHaveBeenCalled();
        expect(backend.stop).toHaveBeenCalledOnce();
        expect(backend.stop).toHaveBeenCalledWith(false);

        playDeferred.resolve(undefined);
        await expect(playPromise).resolves.toBe(PLAYBACK_SUPERSEDED);
        await stopPromise;
    });

    it('cancels replacement playback while it waits for an asynchronous stop', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const destructiveStopDeferred = createDeferred<void>();
        await player.play({ source: 1 });
        backend.stop.mockReturnValueOnce(destructiveStopDeferred.promise);

        const stopPromise = player.stop(true);
        const replacementPlayPromise = player.play({ source: 2 });
        expect(backend.play).toHaveBeenCalledTimes(1);

        player.cancelPendingPlay();
        destructiveStopDeferred.resolve(undefined);

        await stopPromise;
        await expect(replacementPlayPromise).resolves.toBe(PLAYBACK_SUPERSEDED);
        expect(backend.play).toHaveBeenCalledTimes(1);
        expect(backend.play).not.toHaveBeenCalledWith({ source: 2 });
    });

    it('leaves established playback active when there is no pending play', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const waitingListener = vi.fn();
        Events.on(player, 'waiting', waitingListener);
        await player.play({ source: 1 });
        const endSessionCallCount = presenter.endSession.mock.calls.length;
        backend.cancelPendingPlay.mockClear();

        player.cancelPendingPlay();
        Events.trigger(backend, 'waiting');

        expect(backend.cancelPendingPlay).toHaveBeenCalledOnce();
        expect(waitingListener).toHaveBeenCalledOnce();
        expect(presenter.endSession).toHaveBeenCalledTimes(endSessionCallCount);
        expect(backend.stop).not.toHaveBeenCalled();
    });

    it('reports a pending play only until its backend start resolves', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const playDeferred = createDeferred<unknown>();
        backend.play.mockReturnValueOnce(playDeferred.promise);

        expect(player.hasPendingPlay()).toBe(false);
        const playPromise = player.play({ source: 1 });
        expect(player.hasPendingPlay()).toBe(true);
        await vi.waitFor(() => expect(backend.play).toHaveBeenCalledOnce());
        expect(player.hasPendingPlay()).toBe(true);

        playDeferred.resolve('started');
        await expect(playPromise).resolves.toBe('started');
        expect(player.hasPendingPlay()).toBe(false);
    });

    it.each([
        {
            invalidate: (player: WebGPUPlayer): Promise<unknown> => player.stop(false),
            invalidation: 'stop(false)'
        },
        {
            invalidate: (player: WebGPUPlayer): Promise<unknown> => {
                player.cancelPendingPlay();
                return Promise.resolve();
            },
            invalidation: 'cancelPendingPlay()'
        }
    ])('stops reporting a pending play once $invalidation supersedes it', async ({ invalidate }) => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const playDeferred = createDeferred<unknown>();
        backend.play.mockReturnValueOnce(playDeferred.promise);

        const playPromise = player.play({ source: 1 });
        expect(player.hasPendingPlay()).toBe(true);
        const invalidationPromise = invalidate(player);
        // The superseded start is still unresolved, but it no longer belongs to the current session
        expect(player.hasPendingPlay()).toBe(false);

        playDeferred.resolve(undefined);
        await expect(playPromise).resolves.toBe(PLAYBACK_SUPERSEDED);
        await invalidationPromise;
        expect(player.hasPendingPlay()).toBe(false);
    });

    it('discards a retained forwarding callback from an older generation', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend() as MockHTMLPlayer & {
            _callbacks: Record<string, Array<(event: { type: string }) => void>>
        };
        const listener = vi.fn();
        Events.on(player, 'timeupdate', listener);

        await player.play({ source: 1 });
        const staleHandler = backend._callbacks.timeupdate[0];
        await player.play({ source: 2 });
        staleHandler.call(backend, { type: 'timeupdate' });

        expect(listener).not.toHaveBeenCalled();
    });

    it('forwards stop(false) once per session and reuses the owned backend', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        await player.play({ source: 1 });

        await player.stop(false);
        await player.stop(false);
        expect(backend.stop).toHaveBeenCalledTimes(1);
        expect(backend.stop).toHaveBeenCalledWith(false);
        expect(backend.destroy).not.toHaveBeenCalled();

        await player.play({ source: 2 });
        await player.stop(false);
        expect(htmlPlayerMockState.instances).toHaveLength(1);
        expect(backend.stop).toHaveBeenCalledTimes(2);
    });

    it('prevents reentrant destroy from duplicating backend teardown during stop(true)', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        backend.stop.mockImplementation((destroyPlayer: boolean) => {
            Events.trigger(backend, 'stopped', [{ src: 'backend-source' }]);
            if (destroyPlayer) {
                backend.destroy();
            }
            return Promise.resolve();
        });
        Events.on(player, 'stopped', () => player.destroy());
        await player.play({});

        await player.stop(true);

        expect(backend.stop).toHaveBeenCalledOnce();
        expect(backend.stop).toHaveBeenCalledWith(true);
        expect(backend.destroy).toHaveBeenCalledOnce();
    });

    it('retires stopped forwarding before a listener requests another stop', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const stoppedListener = vi.fn();
        let nestedStopPromise: Promise<unknown> | null = null;
        backend.stop.mockImplementation(() => {
            Events.trigger(backend, 'stopped');
            return Promise.resolve();
        });
        Events.on(player, 'stopped', () => {
            stoppedListener();
            nestedStopPromise = player.stop(false);
        });
        await player.play({});

        await player.stop(false);
        await nestedStopPromise;

        expect(stoppedListener).toHaveBeenCalledOnce();
        expect(backend.stop).toHaveBeenCalledOnce();
    });

    it('starts a play requested by stopped only after destructive stop completes', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const operationOrder: string[] = [];
        let replacementPlayPromise: Promise<unknown> | null = null;
        backend.play.mockImplementation((options: { source: number }) => {
            operationOrder.push(`play-${options.source}`);
            return Promise.resolve(options);
        });
        backend.destroy.mockImplementation(() => {
            operationOrder.push('destroy');
        });
        backend.stop.mockImplementation((destroyPlayer: boolean) => {
            operationOrder.push('stop-start');
            Events.trigger(backend, 'stopped');
            if (destroyPlayer) {
                backend.destroy();
            }
            operationOrder.push('stop-end');
            return Promise.resolve();
        });
        Events.on(player, 'stopped', () => {
            replacementPlayPromise = player.play({ source: 2 });
        });
        await player.play({ source: 1 });
        operationOrder.length = 0;

        await player.stop(true);
        await replacementPlayPromise;

        expect(operationOrder).toEqual([
            'stop-start',
            'destroy',
            'stop-end',
            'play-2'
        ]);
    });

    it('invalidates presentation and forwarding when the backend stops naturally', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const playResult = { source: 1 };
        const playDeferred = createDeferred<unknown>();
        const stoppedListener = vi.fn();
        const waitingListener = vi.fn();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        backend.play.mockReturnValue(playDeferred.promise);
        Events.on(player, 'stopped', stoppedListener);
        Events.on(player, 'waiting', waitingListener);

        const playerPlayPromise = player.play(playResult);
        Events.trigger(backend, 'stopped', [{ src: 'backend-source' }]);
        playDeferred.resolve(playResult);
        await expect(playerPlayPromise).resolves.toBe(PLAYBACK_SUPERSEDED);
        Events.trigger(backend, 'waiting');

        expect(stoppedListener).toHaveBeenCalledOnce();
        expect(presenter.endSession).toHaveBeenCalledWith(2);
        expect(presenter.attach).not.toHaveBeenCalled();
        expect(waitingListener).not.toHaveBeenCalled();
    });

    it('starts replacement playback from natural stopped without stopping the ended backend again', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        let replacementPlayPromise: Promise<unknown> | null = null;
        Events.on(player, 'stopped', () => {
            replacementPlayPromise = player.play({ source: 2 });
        });
        await player.play({ source: 1 });

        Events.trigger(backend, 'stopped');
        await replacementPlayPromise;

        expect(backend.stop).not.toHaveBeenCalled();
        expect(backend.play).toHaveBeenCalledTimes(2);
        expect(backend.play).toHaveBeenLastCalledWith({ source: 2 });
    });

    it('detaches forwarding and never attaches presentation after rejected playback', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const waitingListener = vi.fn();
        const playbackError = new Error('simulated playback rejection');
        backend.play.mockRejectedValueOnce(playbackError);
        Events.on(player, 'waiting', waitingListener);

        await expect(player.play({})).rejects.toBe(playbackError);
        Events.trigger(backend, 'waiting');

        expect(presenter.endSession).toHaveBeenCalledWith(2);
        expect(presenter.attach).not.toHaveBeenCalled();
        expect(waitingListener).not.toHaveBeenCalled();
    });

    it('invalidates unresolved playback before forwarding a backend error', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const playDeferred = createDeferred<unknown>();
        const errorListener = vi.fn();
        backend.play.mockReturnValueOnce(playDeferred.promise);
        Events.on(player, 'error', errorListener);

        const playPromise = player.play(createKnownSDRPlayOptions());
        Events.trigger(backend, 'error', [{ code: 3 }]);
        playDeferred.resolve(undefined);

        await expect(playPromise).resolves.toBe(PLAYBACK_SUPERSEDED);
        expect(errorListener).toHaveBeenCalledOnce();
        expect(presenter.endSession).toHaveBeenCalledWith(2);
        expect(presenter.attach).not.toHaveBeenCalled();
    });

    it('retires backend forwarding after the first terminal error', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const errorListener = vi.fn();
        const waitingListener = vi.fn();
        Events.on(player, 'error', errorListener);
        Events.on(player, 'waiting', waitingListener);
        await player.play({});

        Events.trigger(backend, 'error', [{ code: 3 }]);
        Events.trigger(backend, 'error', [{ code: 3 }]);
        Events.trigger(backend, 'waiting');

        expect(errorListener).toHaveBeenCalledOnce();
        expect(waitingListener).not.toHaveBeenCalled();
    });

    it('escalates a pending reusable stop to destructive teardown', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const reusableStopDeferred = createDeferred<void>();
        backend.stop.mockImplementation((destroyPlayer: boolean) => {
            if (destroyPlayer) {
                backend.destroy();
                return Promise.resolve();
            }

            return reusableStopDeferred.promise;
        });
        await player.play({});

        const reusableStopPromise = player.stop(false);
        const destructiveStopPromise = player.stop(true);
        expect(backend.stop).toHaveBeenCalledTimes(2);
        expect(backend.stop).toHaveBeenNthCalledWith(1, false);
        expect(backend.stop).toHaveBeenNthCalledWith(2, true);
        expect(backend.destroy).toHaveBeenCalledOnce();
        await Promise.all([reusableStopPromise, destructiveStopPromise]);

        expect(backend.stop).toHaveBeenCalledTimes(2);
        expect(backend.stop).toHaveBeenNthCalledWith(1, false);
        expect(backend.stop).toHaveBeenNthCalledWith(2, true);
        expect(backend.destroy).toHaveBeenCalledOnce();
        reusableStopDeferred.resolve();
    });

    it('finishes queued teardown before starting a newer session', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const reusableStopDeferred = createDeferred<void>();
        backend.stop.mockImplementation((destroyPlayer: boolean) => {
            if (destroyPlayer) {
                backend.destroy();
                return Promise.resolve();
            }

            return reusableStopDeferred.promise;
        });
        await player.play({ source: 1 });

        const reusableStopPromise = player.stop(false);
        const destructiveStopPromise = player.stop(true);
        const replacementPlayPromise = player.play({ source: 2 });
        expect(backend.play).toHaveBeenCalledTimes(1);
        await Promise.all([
            reusableStopPromise,
            destructiveStopPromise,
            replacementPlayPromise
        ]);

        expect(backend.stop).toHaveBeenCalledTimes(2);
        expect(backend.stop).toHaveBeenNthCalledWith(1, false);
        expect(backend.stop).toHaveBeenNthCalledWith(2, true);
        expect(backend.destroy).toHaveBeenCalledOnce();
        expect(backend.play).toHaveBeenLastCalledWith({ source: 2 });
        reusableStopDeferred.resolve();
    });

    it('waits for asynchronous destructive teardown before starting playback', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const destructiveStopDeferred = createDeferred<void>();
        backend.stop.mockImplementation((destroyPlayer: boolean) => {
            if (destroyPlayer) {
                return destructiveStopDeferred.promise;
            }

            return Promise.resolve();
        });
        await player.play({ source: 1 });

        const stopPromise = player.stop(true);
        const replacementPlayPromise = player.play({ source: 2 });
        expect(backend.play).toHaveBeenCalledTimes(1);

        destructiveStopDeferred.resolve();
        await Promise.all([stopPromise, replacementPlayPromise]);

        expect(backend.play).toHaveBeenCalledTimes(2);
        expect(backend.play).toHaveBeenLastCalledWith({ source: 2 });
    });

    it('allows destroy to retire a pending reusable stop before later playback', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const reusableStopDeferred = createDeferred<void>();
        backend.stop.mockImplementation(() => {
            Events.trigger(backend, 'stopped');
            return reusableStopDeferred.promise;
        });
        await player.play({ source: 1 });

        const stopPromise = player.stop(false);
        player.destroy();
        const replacementPlayPromise = player.play({ source: 2 });

        await Promise.all([stopPromise, replacementPlayPromise]);
        expect(backend.destroy).toHaveBeenCalledOnce();
        expect(backend.play).toHaveBeenCalledTimes(2);
        expect(backend.play).toHaveBeenLastCalledWith({ source: 2 });
        reusableStopDeferred.resolve();
    });

    it('returns the original stop promise when stopped starts a new session reentrantly', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        backend.stop.mockImplementation(() => {
            Events.trigger(backend, 'stopped');
            return Promise.resolve('stopped');
        });
        Events.on(player, 'stopped', () => {
            void player.play({ source: 2 });
        });
        await player.play({ source: 1 });

        await expect(player.stop(false)).resolves.toBe('stopped');

        expect(backend.play).toHaveBeenCalledTimes(2);
    });

    it('allows destroy to finish teardown after stop(true) throws synchronously', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const stopError = new Error('simulated stop throw');
        backend.stop.mockImplementation(() => {
            throw stopError;
        });
        await player.play({});

        await expect(player.stop(true)).rejects.toBe(stopError);
        player.destroy();

        expect(backend.stop).toHaveBeenCalledOnce();
        expect(backend.destroy).toHaveBeenCalledOnce();
    });

    it('allows destroy to finish teardown after stop(true) rejects', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const stopError = new Error('simulated stop rejection');
        backend.stop.mockRejectedValueOnce(stopError);
        await player.play({});

        await expect(player.stop(true)).rejects.toBe(stopError);
        player.destroy();

        expect(backend.stop).toHaveBeenCalledOnce();
        expect(backend.destroy).toHaveBeenCalledOnce();
    });

    it('makes direct destroy idempotent and rebinds on the next play', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        await player.play({ source: 1 });

        player.destroy();
        player.destroy();
        expect(backend.destroy).toHaveBeenCalledTimes(1);

        await player.play({ source: 2 });
        player.destroy();
        expect(backend.destroy).toHaveBeenCalledTimes(2);
    });

    it('does not forward backend events after destroy', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const listener = vi.fn();
        Events.on(player, 'waiting', listener);
        await player.play({});

        player.destroy();
        Events.trigger(backend, 'waiting');

        expect(listener).not.toHaveBeenCalled();
    });
});

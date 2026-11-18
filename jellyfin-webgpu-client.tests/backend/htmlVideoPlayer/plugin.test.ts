import type { VideoVobSubOptions } from 'libbitsub';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { PLAYBACK_SUPERSEDED } from 'addons/webGPUPlayer/constants/playbackResult';
import CustomPlaybackMediaElement from 'addons/webGPUPlayer/CustomPlaybackMediaElement';
import browser from 'scripts/browser';
import appSettings from 'scripts/settings/appSettings';
import { currentSettings as userSettings } from 'scripts/settings/userSettings';
import Events from 'utils/events';
import type { Microseconds } from 'webgpu-player/MediaTime';

type Deferred<Value> = {
    promise: Promise<Value>
    reject: (reason?: unknown) => void
    resolve: (value: Value) => void
};

type SubtitleTrackEvent = {
    EndPositionTicks: number
    StartPositionTicks: number
    Text: string
};

type AssSubtitleRendererOptions = Record<string, unknown> & {
    canvas?: HTMLCanvasElement
    onError?: () => void
    renderAhead?: number
    timeOffset?: number
    video?: HTMLVideoElement
};

type BitmapSubtitleRendererMock = {
    canvas: HTMLCanvasElement | null
    createCanvas: () => void
    dispose: Mock
    format: 'pgs' | 'vobsub'
    getSubtitleTime: () => number
    options: VideoVobSubOptions
    setDebandEnabled?: Mock
    setDebandRange?: Mock
    setDebandThreshold?: Mock
    setDisplaySettings: Mock
    timeOffset: number
    updateCanvasSize: Mock
};

type AssStyle = {
    Alignment: number
    MarginL: number
    MarginR: number
    MarginV: number
    Name: string
};

type PictureRectangle = { height: number, width: number, x: number, y: number };

type PresentedPictureGeometry = {
    box: PictureRectangle
    frame: PictureRectangle
    visible: PictureRectangle
};

type TestMediaStream = {
    Codec?: string
    DeliveryMethod?: string
    DeliveryUrl?: string
    Index: number
    IsExternal?: boolean
    IsExternalUrl?: boolean
    Path?: string
    Type: string
};

type TestPlayOptions = {
    aspectRatio?: string
    fullscreen: boolean
    item: { ServerId: string }
    mediaSource: {
        Container: string
        DefaultAudioStreamIndex: number
        DefaultSecondarySubtitleStreamIndex: number
        DefaultSubtitleStreamIndex: number
        MediaAttachments?: Array<{ DeliveryUrl: string, MimeType: string }>
        MediaStreams: TestMediaStream[]
        TranscodingUrl?: string
    }
    playMethod: string
    playerStartPositionTicks: number
    transcodingOffsetTicks?: number
    url: string
};

type HtmlVideoPlayerTestHarness = {
    _currentPlayOptions: unknown
    cancelPendingPlay: () => void
    createMediaElement: (options: { fullscreen: boolean }, playSessionGeneration?: number) => Promise<HTMLVideoElement | null>
    _setSubtitleOffset: (offset: number | string) => void
    currentTime: (timeMilliseconds?: number) => number | undefined
    currentSrc: () => string | undefined
    destroy: () => void
    getStats: () => Promise<{
        categories: Array<{
            stats: Array<{ label: string, value: string }>
            type?: string
        }>
    }>
    getPresentationSurface: () => { container: HTMLDivElement, video: HTMLVideoElement } | null
    isFetching: boolean
    onError: (event: Event) => void
    notifyCustomPlaybackEnded: () => boolean
    notifyCustomPlaybackPaused: () => boolean
    notifyCustomPlaybackPlaying: () => boolean
    notifyCustomPlaybackTimeUpdate: (timeMilliseconds: number) => boolean
    notifyCustomPlaybackWaiting: () => boolean
    notifyPresentedPictureGeometry: (geometry: PresentedPictureGeometry | null) => boolean
    onPlay: () => void
    pause: () => void
    play: (options: ReturnType<typeof createPlayOptions>) => Promise<unknown>
    prepareCustomPlayback: (options: ReturnType<typeof createPlayOptions>) => Promise<
        { container: HTMLDivElement, video: HTMLVideoElement } | string | null
    >
    renderPgs: (...renderArguments: unknown[]) => void
    setAspectRatio: (aspectRatio: string) => void
    setSubtitleStreamIndex: (index: number) => void
    stop: (destroyPlayer: boolean) => Promise<void>
    unpause: () => void
    updateVideoUrl: (options: ReturnType<typeof createPlayOptions>, playSessionGeneration?: number) => Promise<void>
    updateSubtitleText: (timeMilliseconds: number) => void
};

const subtitleAppearanceHelperMock = vi.hoisted(() => ({
    applyStyles: vi.fn(),
    getStyles: vi.fn(() => ({ text: [] }))
}));

const playbackManagerMock = vi.hoisted(() => ({
    getSubtitleUrl: vi.fn((track: { DeliveryUrl: string }) => track.DeliveryUrl),
    getMaxStreamingBitrate: vi.fn(() => 10_000_000),
    trackHasSecondarySubtitleSupport: vi.fn(() => true)
}));

const htmlMediaHelperMock = vi.hoisted(() => ({
    applySrc: vi.fn<(element: { src: string }, source: string) => Promise<void>>().mockResolvedValue(undefined),
    bindEventsToHlsPlayer: vi.fn<(...eventArguments: unknown[]) => void>(),
    destroyCastPlayer: vi.fn(),
    destroyFlvPlayer: vi.fn(),
    destroyHlsPlayer: vi.fn(),
    enableHlsJsPlayerForCodecs: vi.fn<(mediaSource?: { Container?: string }, mediaType?: string) => boolean>().mockReturnValue(false),
    getBufferedRanges: vi.fn(() => []),
    getCrossOriginValue: vi.fn(() => null),
    getSavedVolume: vi.fn(() => 1),
    handleHlsJsMediaError: vi.fn(),
    isValidDuration: vi.fn(() => true),
    onEndedInternal: vi.fn(),
    onErrorInternal: vi.fn(),
    playWithPromise: vi.fn(() => Promise.resolve()),
    resetSrc: vi.fn(),
    saveVolume: vi.fn(),
    seekOnPlaybackStart: vi.fn()
}));

const itemHelperMock = vi.hoisted(() => ({
    isLocalItem: vi.fn(() => false)
}));

const webSettingsMock = vi.hoisted(() => ({
    getIncludeCorsCredentials: vi.fn(() => Promise.resolve(false))
}));

const hlsModuleMock = vi.hoisted(() => {
    const instances: Array<{ config: Record<string, unknown> }> = [];

    class MockHls {
        static readonly ErrorTypes = Object.freeze({
            ['MEDIA_ERROR']: 'legacy-media-error',
            ['NETWORK_ERROR']: 'legacy-network-error'
        });
        static readonly Events = Object.freeze({
            ['ERROR']: 'legacy-error',
            ['MANIFEST_PARSED']: 'legacy-manifest-parsed'
        });
        static readonly DefaultConfig = {
            backBufferLength: Number.POSITIVE_INFINITY,
            liveBackBufferLength: null,
            lowLatencyMode: true
        };

        attachMedia = vi.fn();
        readonly config: Record<string, unknown>;
        destroy = vi.fn();
        loadSource = vi.fn();
        on = vi.fn();
        startLoad = vi.fn();

        constructor(config: Record<string, unknown>) {
            this.config = config;
            instances.push(this);
        }
    }

    return { instances, MockHls };
});

const serverConnectionsMock = vi.hoisted(() => {
    const apiClient = {
        accessToken: vi.fn(() => 'test-token'),
        getJSON: vi.fn(() => Promise.resolve([])),
        getNamedConfiguration: vi.fn(() => Promise.resolve({ EnableFallbackFont: false })),
        getUrl: vi.fn((url: string) => url)
    };
    return {
        apiClient,
        getApiClient: vi.fn(() => apiClient)
    };
});

const specializedSubtitleRendererMock = vi.hoisted(() => {
    const assInstances: Array<{
        dispose: Mock
        getStyles: Mock
        options: AssSubtitleRendererOptions
        resetRenderAheadCache: Mock
        resize: Mock
        setCurrentTime: Mock
        setIsPaused: Mock
        setStyle: Mock
        timeOffset: number
    }> = [];
    const bitmapInstances: BitmapSubtitleRendererMock[] = [];
    // The styles the next ASS renderers' worker reports
    const assStyles: AssStyle[] = [];

    class MockAssRenderer {
        readonly dispose = vi.fn();
        readonly getStyles = vi.fn((onSuccess: (styles: unknown[]) => void) => {
            onSuccess(assStyles.map((style, index) => ({ ...style, _index: index })));
        });
        readonly options: AssSubtitleRendererOptions;
        readonly resetRenderAheadCache = vi.fn();
        readonly resize = vi.fn();
        readonly setCurrentTime = vi.fn();
        readonly setIsPaused = vi.fn();
        readonly setStyle = vi.fn();
        timeOffset: number;

        constructor(options: AssSubtitleRendererOptions) {
            this.options = options;
            this.timeOffset = options.timeOffset ?? 0;
            assInstances.push(this);
        }
    }

    /**
     * Mirrors the public surface of the libbitsub video renderers used by the player, and the protected layout of their overlay canvas: a canvas in the
     * video's parent, over the bounds `getVideoContentBounds` measures, which libbitsub creates once its WebAssembly loads.
     */
    class MockBitmapSubtitleRenderer {
        canvas: HTMLCanvasElement | null = null;
        readonly options: VideoVobSubOptions;
        timeOffset: number;

        constructor(options: VideoVobSubOptions) {
            this.options = options;
            this.timeOffset = options.timeOffset ?? 0;
            // Spies wrap the methods a subclass overrides, which then still run
            const spied = this as unknown as { dispose: () => void, setDisplaySettings: () => void, updateCanvasSize: () => void };
            vi.spyOn(spied, 'dispose');
            vi.spyOn(spied, 'setDisplaySettings');
            vi.spyOn(spied, 'updateCanvasSize');
            bitmapInstances.push(this as unknown as BitmapSubtitleRendererMock);
        }

        createCanvas(): void {
            this.canvas = document.createElement('canvas');
            this.options.video.parentElement?.appendChild(this.canvas);
            this.updateCanvasSize();
        }

        dispose(): void {
            this.canvas?.parentElement?.removeChild(this.canvas);
            this.canvas = null;
        }

        getVideoContentBounds(): { height: number, width: number, x: number, y: number } {
            const rectangle = this.options.video.getBoundingClientRect();
            return { height: rectangle.height, width: rectangle.width, x: 0, y: 0 };
        }

        setDisplaySettings(): void {
            // Display settings only reach the renderer's layout
        }

        updateCanvasSize(): void {
            if (!this.canvas) {
                return;
            }
            const bounds = this.getVideoContentBounds();
            this.canvas.width = Math.max(1, bounds.width * window.devicePixelRatio);
            this.canvas.height = Math.max(1, bounds.height * window.devicePixelRatio);
            this.canvas.style.left = `${bounds.x}px`;
            this.canvas.style.top = `${bounds.y}px`;
            this.canvas.style.width = `${bounds.width}px`;
            this.canvas.style.height = `${bounds.height}px`;
        }

        /** Returns the subtitle time that libbitsub samples on each animation frame. */
        getSubtitleTime(): number {
            return this.options.video.currentTime + this.timeOffset;
        }
    }

    class MockPgsRenderer extends MockBitmapSubtitleRenderer {
        readonly format = 'pgs';
    }

    class MockVobSubRenderer extends MockBitmapSubtitleRenderer {
        readonly format = 'vobsub';
        readonly setDebandEnabled = vi.fn();
        readonly setDebandRange = vi.fn();
        readonly setDebandThreshold = vi.fn();
    }

    return {
        assInstances,
        assStyles,
        bitmapInstances,
        MockAssRenderer,
        MockPgsRenderer,
        MockVobSubRenderer,
        warmup: vi.fn(() => Promise.resolve())
    };
});

vi.mock('screenfull', () => ({
    default: {
        exit: vi.fn(),
        isEnabled: false,
        request: vi.fn(() => Promise.resolve())
    }
}));

vi.mock('apps/legacy/features/playback/utils/subtitleStyles', () => ({
    useCustomSubtitles: vi.fn(() => false)
}));

vi.mock('components/subtitlesettings/subtitleappearancehelper', () => ({
    default: subtitleAppearanceHelperMock
}));

vi.mock('lib/jellyfin-apiclient', () => ({
    ServerConnections: serverConnectionsMock
}));

vi.mock('@jellyfin/libass-wasm', () => ({
    default: specializedSubtitleRendererMock.MockAssRenderer
}));

vi.mock('libbitsub', () => ({
    PgsRenderer: specializedSubtitleRendererMock.MockPgsRenderer,
    VobSubRenderer: specializedSubtitleRendererMock.MockVobSubRenderer,
    warmup: specializedSubtitleRendererMock.warmup
}));

vi.mock('scripts/settings/userSettings', () => ({
    currentSettings: {
        getSubtitleAppearanceSettings: vi.fn(() => ({ verticalPosition: '0' }))
    }
}));

vi.mock('scripts/browser', () => ({
    default: {
        edge: false,
        firefox: false,
        iOS: false,
        ps4: false,
        slow: false,
        supportsCssAnimation: vi.fn(() => false),
        web0s: false
    }
}));

vi.mock('scripts/settings/appSettings', () => ({
    default: {
        aspectRatio: vi.fn(() => 'auto'),
        alwaysBurnInSubtitleWhenTranscoding: vi.fn(() => false),
        get: vi.fn((): string | null => null)
    }
}));

vi.mock('components/apphost', () => ({
    appHost: {
        supports: vi.fn(() => true)
    }
}));

vi.mock('components/loading/loading', () => ({
    default: {
        hide: vi.fn(),
        show: vi.fn()
    }
}));

vi.mock('utils/dom', () => ({
    default: {
        addEventListener: vi.fn(),
        whichAnimationEvent: vi.fn(() => 'animationend')
    }
}));

vi.mock('components/playback/playbackmanager', () => ({
    playbackManager: playbackManagerMock
}));

vi.mock('components/router/appRouter', () => ({
    appRouter: {
        baseUrl: vi.fn(() => ''),
        showVideoOsd: vi.fn(() => Promise.resolve())
    }
}));

vi.mock('addons/webGPUPlayer/backend/htmlMediaHelper', () => htmlMediaHelperMock);

vi.mock('components/itemHelper', () => ({
    default: itemHelperMock
}));

vi.mock('lib/globalize', () => ({
    default: {
        translate: vi.fn((value: string) => value)
    }
}));

vi.mock('scripts/browserDeviceProfile', () => ({
    canPlaySecondaryAudio: vi.fn(() => false),
    default: vi.fn(() => ({}))
}));

vi.mock('scripts/settings/webSettings', () => ({
    getIncludeCorsCredentials: webSettingsMock.getIncludeCorsCredentials
}));

vi.mock('hls.js/dist/hls.js', () => ({
    default: hlsModuleMock.MockHls
}));

vi.mock('components/backdrop/backdrop', () => ({
    setBackdropTransparency: vi.fn(),
    ['TRANSPARENCY_LEVEL']: {
        Backdrop: 'backdrop',
        None: 'none'
    }
}));

import { HtmlVideoPlayer } from 'addons/webGPUPlayer/backend/htmlVideoPlayer/plugin';

const TRACK_START_TICKS = 0;
const TRACK_END_TICKS = 20_000_000;

function createDeferred<Value>(): Deferred<Value> {
    let resolvePromise: (value: Value) => void = () => {
        throw new Error('Deferred promise was not initialized');
    };
    let rejectPromise: (reason?: unknown) => void = () => {
        throw new Error('Deferred promise was not initialized');
    };
    const promise = new Promise<Value>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    return { promise, reject: rejectPromise, resolve: resolvePromise };
}

function createFetchResponse(trackEvents: SubtitleTrackEvent[]): Response {
    return {
        json: vi.fn(() => Promise.resolve({ TrackEvents: trackEvents })),
        ok: true
    } as unknown as Response;
}

function createTrack(index: number, deliveryUrl: string) {
    return {
        Codec: 'srt',
        DeliveryMethod: 'External',
        DeliveryUrl: deliveryUrl,
        Index: index,
        IsExternal: true,
        Type: 'Subtitle'
    };
}

function createSpecializedTrack(index: number, codec: string, deliveryUrl: string): TestMediaStream {
    return {
        Codec: codec,
        DeliveryMethod: 'External',
        DeliveryUrl: deliveryUrl,
        Index: index,
        IsExternal: true,
        Type: 'Subtitle'
    };
}

function createRectangle(left: number, top: number, width: number, height: number): DOMRect {
    return {
        bottom: top + height,
        height,
        left,
        right: left + width,
        top,
        width,
        x: left,
        y: top,
        toJSON: () => ({})
    };
}

class ImmediateXMLHttpRequest {
    onerror: (() => void) | null = null;
    onload: (() => void) | null = null;
    responseURL = '';

    open(...requestArguments: [string, string, boolean]): void {
        this.responseURL = requestArguments[1];
    }

    send(): void {
        this.onload?.();
    }
}

function createPlayOptions(url: string, container = 'MP4'): TestPlayOptions {
    return {
        fullscreen: false,
        item: { ServerId: 'server' },
        mediaSource: {
            Container: container,
            DefaultAudioStreamIndex: 0,
            DefaultSecondarySubtitleStreamIndex: -1,
            DefaultSubtitleStreamIndex: -1,
            MediaStreams: []
        },
        playMethod: 'DirectPlay',
        playerStartPositionTicks: 0,
        url
    };
}

async function createPlayer(useWebGPUHLSRuntime = false): Promise<HtmlVideoPlayerTestHarness> {
    const player = new HtmlVideoPlayer(undefined, true, useWebGPUHLSRuntime) as unknown as HtmlVideoPlayerTestHarness;
    await player.createMediaElement({ fullscreen: false });
    player._currentPlayOptions = {
        item: { ServerId: 'server' },
        mediaSource: {
            MediaStreams: [
                createTrack(0, 'https://example.test/first.vtt'),
                createTrack(1, 'https://example.test/second.vtt')
            ]
        },
        playMethod: 'DirectPlay'
    };
    return player;
}

beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'devicePixelRatio', {
        configurable: true,
        value: 1
    });
    vi.mocked(browser.supportsCssAnimation).mockReturnValue(false);
    htmlMediaHelperMock.applySrc.mockImplementation((element: { src: string }, source: string) => {
        element.src = source;
        return Promise.resolve();
    });
    htmlMediaHelperMock.enableHlsJsPlayerForCodecs.mockReturnValue(false);
    htmlMediaHelperMock.playWithPromise.mockReturnValue(Promise.resolve());
    itemHelperMock.isLocalItem.mockReturnValue(false);
    webSettingsMock.getIncludeCorsCredentials.mockReturnValue(Promise.resolve(false));
    hlsModuleMock.instances.length = 0;
    specializedSubtitleRendererMock.assInstances.length = 0;
    specializedSubtitleRendererMock.bitmapInstances.length = 0;
    specializedSubtitleRendererMock.assStyles.length = 0;
    vi.mocked(appSettings.aspectRatio).mockReturnValue('auto');
    vi.mocked(appSettings.get).mockReturnValue(null);
    serverConnectionsMock.apiClient.getNamedConfiguration.mockResolvedValue({ EnableFallbackFont: false });
    serverConnectionsMock.apiClient.getJSON.mockResolvedValue([]);
});

describe('HtmlVideoPlayer custom presentation shell', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('prepares the normal DOM surface without assigning a native source', async () => {
        const player = new HtmlVideoPlayer(undefined, true) as unknown as HtmlVideoPlayerTestHarness;
        const options = createPlayOptions('https://example.test/custom.mkv', 'MKV');

        const surface = await player.prepareCustomPlayback(options);

        expect(surface).toMatchObject({
            container: expect.any(HTMLDivElement),
            video: expect.any(HTMLVideoElement)
        });
        expect(player.currentSrc()).toBe(options.url);
        expect(htmlMediaHelperMock.applySrc).not.toHaveBeenCalled();
        expect(htmlMediaHelperMock.playWithPromise).not.toHaveBeenCalled();
        expect(htmlMediaHelperMock.resetSrc).toHaveBeenCalledOnce();
    });

    it('does not gate a custom fullscreen surface on the cosmetic zoom animation', async () => {
        const player = new HtmlVideoPlayer(undefined, true) as unknown as HtmlVideoPlayerTestHarness;
        const options = createPlayOptions('https://example.test/custom.mkv', 'MKV');
        options.fullscreen = true;
        vi.mocked(browser.supportsCssAnimation).mockReturnValue(true);

        const surface = await player.prepareCustomPlayback(options);

        expect(surface).toMatchObject({
            container: expect.any(HTMLDivElement),
            video: expect.any(HTMLVideoElement)
        });
        expect(typeof surface === 'object' ? surface?.container.style.animation : null).toBe('');
    });

    it('forwards custom clock events and retires natural end exactly once', async () => {
        const player = new HtmlVideoPlayer(undefined, true) as unknown as HtmlVideoPlayerTestHarness;
        const eventOrder: string[] = [];
        for (const eventName of [
            'unpause',
            'playing',
            'timeupdate',
            'pause',
            'waiting'
        ]) {
            Events.on(player, eventName, () => eventOrder.push(eventName));
        }
        const updateSubtitleText = vi.spyOn(player, 'updateSubtitleText');
        await player.prepareCustomPlayback(createPlayOptions('https://example.test/custom.mp4'));

        expect(player.notifyCustomPlaybackPlaying()).toBe(true);
        expect(player.notifyCustomPlaybackTimeUpdate(2_500)).toBe(true);
        expect(player.notifyCustomPlaybackPaused()).toBe(true);
        expect(player.notifyCustomPlaybackWaiting()).toBe(true);

        expect(player.currentTime()).toBe(2_500);
        expect(updateSubtitleText).toHaveBeenCalledWith(2_500);
        expect(eventOrder).toEqual([
            'unpause',
            'playing',
            'timeupdate',
            'pause',
            'waiting'
        ]);
        expect(player.notifyCustomPlaybackEnded()).toBe(true);
        expect(player.notifyCustomPlaybackEnded()).toBe(false);
        expect(htmlMediaHelperMock.onEndedInternal).toHaveBeenCalledOnce();
        expect(player.currentSrc()).toBeUndefined();
    });

    it('leaves the media events a custom playback reports on its element to that playback', async () => {
        const player = new HtmlVideoPlayer(undefined, true) as unknown as HtmlVideoPlayerTestHarness;
        const playerEvents: string[] = [];
        for (const eventName of [ 'playing', 'pause', 'unpause', 'timeupdate', 'waiting', 'stopped' ]) {
            Events.on(player, eventName, () => playerEvents.push(eventName));
        }
        const options = createPlayOptions('https://example.test/custom.mkv', 'MKV');
        await player.prepareCustomPlayback(options);
        const video = player.getPresentationSurface()?.video;
        if (!video) {
            throw new Error('Custom presentation surface was not created');
        }
        const mediaElement = new CustomPlaybackMediaElement(video, options.url, {
            currentTime: () => 0 as Microseconds,
            duration: () => 60_000_000 as Microseconds,
            pause: vi.fn(),
            play: vi.fn(),
            playbackRate: () => 1,
            seek: vi.fn()
        });

        mediaElement.notifyReady();
        mediaElement.notifyPlaying();
        mediaElement.notifyTimeUpdate();
        mediaElement.notifyWaiting();
        mediaElement.notifyStateChange('paused');
        mediaElement.notifyEnded();
        mediaElement.detach();
        await Promise.resolve();

        // The playback's controller notifies this player itself; handling the element's reports too would end the playback twice
        expect(playerEvents).toEqual([]);
        expect(htmlMediaHelperMock.onEndedInternal).not.toHaveBeenCalled();
        expect(htmlMediaHelperMock.seekOnPlaybackStart).not.toHaveBeenCalled();
        video.dispatchEvent(new Event('pause'));
        expect(playerEvents).toEqual([ 'pause' ]);
    });

    it('suppresses only the first native unpause during same-session fallback', () => {
        const player = new HtmlVideoPlayer(undefined, true) as unknown as HtmlVideoPlayerTestHarness;
        const unpauseListener = vi.fn();
        Events.on(player, 'unpause', unpauseListener);
        player._currentPlayOptions = { suppressInitialUnpause: true };

        player.onPlay();
        player.onPlay();

        expect(unpauseListener).toHaveBeenCalledOnce();
    });
});

describe('HtmlVideoPlayer playback controls', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('consumes the AbortError from a play request interrupted by pause', async () => {
        const player = await createPlayer();
        const surface = player.getPresentationSurface();
        expect(surface).not.toBeNull();
        if (!surface) {
            throw new Error('Video presentation surface was not created');
        }

        const pendingPlay = createDeferred<void>();
        let paused = false;
        Object.defineProperty(surface.video, 'paused', {
            configurable: true,
            get: () => paused
        });
        vi.spyOn(surface.video, 'play').mockReturnValue(pendingPlay.promise);
        vi.spyOn(surface.video, 'pause').mockImplementation(() => {
            paused = true;
        });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        player.unpause();
        player.pause();
        pendingPlay.reject(new DOMException('The play() request was interrupted by a call to pause().', 'AbortError'));
        await Promise.resolve();
        await Promise.resolve();

        expect(surface.video.play).toHaveBeenCalledOnce();
        expect(surface.video.pause).toHaveBeenCalledOnce();
        expect(consoleError).not.toHaveBeenCalled();

        player.destroy();
    });

    it('keeps an AbortError visible when playback remains unpaused', async () => {
        const player = await createPlayer();
        const surface = player.getPresentationSurface();
        expect(surface).not.toBeNull();
        if (!surface) {
            throw new Error('Video presentation surface was not created');
        }

        Object.defineProperty(surface.video, 'paused', {
            configurable: true,
            value: false
        });
        vi.spyOn(surface.video, 'play').mockRejectedValue(new DOMException(
            'The play() request was interrupted by a new load request.',
            'AbortError'
        ));
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        player.unpause();
        await Promise.resolve();
        await Promise.resolve();

        expect(consoleError).toHaveBeenCalledOnce();
        expect(consoleError.mock.calls[0]?.[0]).toContain('error calling video.play');
        expect(consoleError.mock.calls[0]?.[0]).toContain('AbortError');

        player.destroy();
    });

    it('keeps unexpected asynchronous play failures visible', async () => {
        const player = await createPlayer();
        const surface = player.getPresentationSurface();
        expect(surface).not.toBeNull();
        if (!surface) {
            throw new Error('Video presentation surface was not created');
        }

        const playbackError = new DOMException('The media format is unsupported', 'NotSupportedError');
        vi.spyOn(surface.video, 'play').mockRejectedValue(playbackError);
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        player.unpause();
        await Promise.resolve();
        await Promise.resolve();

        expect(consoleError).toHaveBeenCalledOnce();
        expect(consoleError.mock.calls[0]?.[0]).toContain('error calling video.play');
        expect(consoleError.mock.calls[0]?.[0]).toContain('NotSupportedError');

        player.destroy();
    });

    it('keeps synchronous play failures visible', async () => {
        const player = await createPlayer();
        const surface = player.getPresentationSurface();
        expect(surface).not.toBeNull();
        if (!surface) {
            throw new Error('Video presentation surface was not created');
        }

        const playbackError = new DOMException('The media element is unavailable', 'InvalidStateError');
        vi.spyOn(surface.video, 'play').mockImplementation(() => {
            throw playbackError;
        });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        expect(() => player.unpause()).not.toThrow();
        expect(consoleError).toHaveBeenCalledOnce();
        expect(consoleError.mock.calls[0]?.[0]).toContain('error calling video.play');
        expect(consoleError.mock.calls[0]?.[0]).toContain('InvalidStateError');

        player.destroy();
    });
});

describe('HtmlVideoPlayer specialized subtitle renderers', () => {
    beforeEach(() => {
        vi.stubGlobal('XMLHttpRequest', ImmediateXMLHttpRequest);
        // No script header reads unless a test serves one
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))));
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.unstubAllGlobals();
    });

    it('owns ASS canvas clocking, pause state, seeking, offsets, resize, and stop cleanup', async () => {
        const player = new HtmlVideoPlayer(undefined, true) as unknown as HtmlVideoPlayerTestHarness;
        const options = createPlayOptions('https://example.test/custom.mkv', 'MKV');
        options.mediaSource.MediaStreams = [
            createSpecializedTrack(0, 'ass', 'https://example.test/subtitles.ass')
        ];
        options.transcodingOffsetTicks = 5_000_000;
        await player.prepareCustomPlayback(options);
        const surface = player.getPresentationSurface();
        expect(surface).not.toBeNull();
        if (!surface) {
            throw new Error('Custom presentation surface was not created');
        }
        vi.spyOn(surface.video, 'pause').mockImplementation(() => undefined);

        Object.defineProperty(surface.container, 'clientWidth', { configurable: true, value: 800 });
        Object.defineProperty(surface.container, 'clientHeight', { configurable: true, value: 450 });
        vi.spyOn(surface.container, 'getBoundingClientRect').mockReturnValue(createRectangle(10, 20, 800, 450));
        vi.spyOn(surface.video, 'getBoundingClientRect').mockReturnValue(createRectangle(110, 70, 600, 300));

        player.setSubtitleStreamIndex(0);
        await vi.waitFor(() => {
            expect(specializedSubtitleRendererMock.assInstances).toHaveLength(1);
        });
        const renderer = specializedSubtitleRendererMock.assInstances[0];
        const canvas = renderer.options.canvas;

        expect(renderer.options.video).toBeUndefined();
        expect(renderer.options.timeOffset).toBe(0);
        expect(renderer.options.renderAhead).toBe(0);
        expect(canvas).toBeInstanceOf(HTMLCanvasElement);
        // Before the presenter places the picture, the canvas spans the video's box, in a clip frame over it
        const frameElement = canvas?.parentElement;
        expect(frameElement?.classList.contains('htmlVideoPlayerCustomSubtitleFrame')).toBe(true);
        expect(frameElement?.parentElement).toBe(surface.container);
        expect(frameElement?.style).toMatchObject({ height: '300px', left: '100px', top: '50px', width: '600px' });
        expect(canvas?.style).toMatchObject({ height: '300px', left: '0px', top: '0px', width: '600px' });
        expect(renderer.resize).toHaveBeenLastCalledWith(600, 300, 0, 0);
        expect(renderer.setCurrentTime).toHaveBeenLastCalledWith(0.5);
        expect(renderer.setIsPaused).toHaveBeenLastCalledWith(true, 0.5);

        expect(player.notifyCustomPlaybackPlaying()).toBe(true);
        expect(renderer.setIsPaused).toHaveBeenLastCalledWith(false, 0.5);
        expect(player.notifyCustomPlaybackTimeUpdate(2_000)).toBe(true);
        expect(renderer.setCurrentTime).toHaveBeenLastCalledWith(2.5);
        expect(player.notifyCustomPlaybackPaused()).toBe(true);
        expect(renderer.setIsPaused).toHaveBeenLastCalledWith(true, 2.5);

        player.currentTime(6_000);
        expect(renderer.resetRenderAheadCache).toHaveBeenLastCalledWith(false);
        expect(renderer.setCurrentTime).toHaveBeenLastCalledWith(6.5);
        player._setSubtitleOffset(1.25);
        expect(renderer.setCurrentTime).toHaveBeenLastCalledWith(7.75);

        await player.stop(false);
        expect(renderer.dispose).toHaveBeenCalledOnce();
        expect(canvas?.isConnected).toBe(false);
        expect(document.querySelectorAll('.htmlVideoPlayerCustomSubtitleCanvas')).toHaveLength(0);
        expect(frameElement?.isConnected).toBe(false);
    });

    it.each([
        {
            // A 4:3 picture pillarboxed in a 16:9 box: the whole frame is the picture, inside the box
            name: 'pillarboxed',
            geometry: {
                box: { height: 1_080, width: 1_920, x: 0, y: 0 },
                frame: { height: 1_080, width: 1_440, x: 240, y: 0 },
                visible: { height: 1_080, width: 1_440, x: 240, y: 0 }
            },
            pixelRatio: 1.5,
            backing: [ 2_160, 1_620 ]
        },
        {
            // A cropped 2.40:1 film on an ultrawide box: its 16:9 frame reaches past the box's top and bottom by the bars
            name: 'black bar crop on an ultrawide box',
            geometry: {
                box: { height: 1_080, width: 2_560, x: 0, y: 0 },
                frame: { height: 1_440, width: 2_560, x: 0, y: -180 },
                visible: { height: 3_200 / 3, width: 2_560, x: 0, y: 20 / 3 }
            },
            pixelRatio: 1,
            backing: [ 2_560, 1_440 ]
        },
        {
            // Browser zoom below 100% keeps the backing below the CSS size
            name: 'zoomed out',
            geometry: {
                box: { height: 800, width: 1_000, x: 30, y: 40 },
                frame: { height: 562.5, width: 1_000, x: 0, y: 118.75 },
                visible: { height: 562.5, width: 1_000, x: 0, y: 118.75 }
            },
            pixelRatio: 0.75,
            backing: [ 750, 422 ]
        }
    ])('places ASS over the presented source frame, $name', async ({ geometry, pixelRatio, backing }) => {
        const player = new HtmlVideoPlayer(undefined, true) as unknown as HtmlVideoPlayerTestHarness;
        const options = createPlayOptions('https://example.test/custom.mkv', 'MKV');
        options.mediaSource.MediaStreams = [
            createSpecializedTrack(0, 'ass', 'https://example.test/subtitles.ass')
        ];
        await player.prepareCustomPlayback(options);
        const surface = player.getPresentationSurface();
        if (!surface) {
            throw new Error('Custom presentation surface was not created');
        }
        vi.spyOn(surface.video, 'pause').mockImplementation(() => undefined);
        Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: pixelRatio });
        expect(player.notifyPresentedPictureGeometry(geometry)).toBe(true);

        player.setSubtitleStreamIndex(0);
        await vi.waitFor(() => {
            expect(specializedSubtitleRendererMock.assInstances).toHaveLength(1);
        });
        const renderer = specializedSubtitleRendererMock.assInstances[0];
        const canvas = renderer.options.canvas;

        expect(canvas?.parentElement?.style).toMatchObject({
            height: `${geometry.box.height}px`,
            left: `${geometry.box.x}px`,
            top: `${geometry.box.y}px`,
            width: `${geometry.box.width}px`
        });
        expect(canvas?.style).toMatchObject({
            height: `${geometry.frame.height}px`,
            left: `${geometry.frame.x}px`,
            top: `${geometry.frame.y}px`,
            width: `${geometry.frame.width}px`
        });
        expect(renderer.resize).toHaveBeenLastCalledWith(backing[0], backing[1], 0, 0);
        player.destroy();
    });

    it('refits ASS at the custom clock on each presented geometry while paused, and keeps it until playback ends', async () => {
        const player = new HtmlVideoPlayer(undefined, true) as unknown as HtmlVideoPlayerTestHarness;
        const options = createPlayOptions('https://example.test/custom.mkv', 'MKV');
        options.mediaSource.MediaStreams = [
            createSpecializedTrack(0, 'ass', 'https://example.test/subtitles.ass')
        ];
        await player.prepareCustomPlayback(options);
        const surface = player.getPresentationSurface();
        if (!surface) {
            throw new Error('Custom presentation surface was not created');
        }
        vi.spyOn(surface.video, 'pause').mockImplementation(() => undefined);
        player.setSubtitleStreamIndex(0);
        await vi.waitFor(() => {
            expect(specializedSubtitleRendererMock.assInstances).toHaveLength(1);
        });
        const renderer = specializedSubtitleRendererMock.assInstances[0];
        const canvas = renderer.options.canvas;
        player.notifyCustomPlaybackTimeUpdate(2_500);
        expect(player.notifyCustomPlaybackPaused()).toBe(true);
        renderer.setCurrentTime.mockClear();

        // The paused window turns into a 4:3 box, where cover cuts the 16:9 frame's sides
        player.notifyPresentedPictureGeometry({
            box: { height: 1_080, width: 1_440, x: 240, y: 0 },
            frame: { height: 1_080, width: 1_920, x: -240, y: 0 },
            visible: { height: 1_080, width: 1_440, x: 0, y: 0 }
        });
        expect(canvas?.parentElement?.style).toMatchObject({ height: '1080px', left: '240px', top: '0px', width: '1440px' });
        expect(canvas?.style).toMatchObject({ height: '1080px', left: '-240px', top: '0px', width: '1920px' });
        expect(renderer.resize).toHaveBeenLastCalledWith(1_920, 1_080, 0, 0);
        expect(renderer.setCurrentTime).toHaveBeenLastCalledWith(2.5);

        // Nothing presents between sessions of the same playback, and the overlay spans the box again until the picture returns
        vi.spyOn(surface.video, 'getBoundingClientRect').mockReturnValue(createRectangle(0, 0, 640, 360));
        Object.defineProperty(surface.container, 'clientWidth', { configurable: true, value: 640 });
        Object.defineProperty(surface.container, 'clientHeight', { configurable: true, value: 360 });
        vi.spyOn(surface.container, 'getBoundingClientRect').mockReturnValue(createRectangle(0, 0, 640, 360));
        player.notifyPresentedPictureGeometry(null);
        expect(canvas?.style).toMatchObject({ height: '360px', left: '0px', top: '0px', width: '640px' });
        expect(renderer.resize).toHaveBeenLastCalledWith(640, 360, 0, 0);

        await player.stop(false);
        renderer.resize.mockClear();
        expect(player.notifyPresentedPictureGeometry({
            box: { height: 1_080, width: 1_920, x: 0, y: 0 },
            frame: { height: 1_080, width: 1_920, x: 0, y: 0 },
            visible: { height: 1_080, width: 1_920, x: 0, y: 0 }
        })).toBe(false);
        expect(renderer.resize).not.toHaveBeenCalled();
    });

    it('moves unpositioned ASS lines onto the screen while the frame is cut, and restores the script\'s margins after', async () => {
        const fetchMock = vi.fn(() => Promise.resolve(new Response(
            '[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 480\n\n[V4+ Styles]\nFormat: Name, Alignment, MarginL, MarginR, MarginV\n'
        )));
        vi.stubGlobal('fetch', fetchMock);
        // libass's alignments: 2 is bottom center, 4 | 2 top center, 8 | 1 middle left
        specializedSubtitleRendererMock.assStyles.push(
            { Alignment: 2, MarginL: 10, MarginR: 10, MarginV: 20, Name: 'Default' },
            { Alignment: 4 | 2, MarginL: 10, MarginR: 10, MarginV: 15, Name: 'Top' },
            { Alignment: 8 | 1, MarginL: 30, MarginR: 0, MarginV: 5, Name: 'Sign' }
        );
        const player = new HtmlVideoPlayer(undefined, true) as unknown as HtmlVideoPlayerTestHarness;
        const options = createPlayOptions('https://example.test/custom.mkv', 'MKV');
        options.mediaSource.MediaStreams = [
            createSpecializedTrack(0, 'ass', 'https://example.test/subtitles.ass')
        ];
        await player.prepareCustomPlayback(options);
        const surface = player.getPresentationSurface();
        if (!surface) {
            throw new Error('Custom presentation surface was not created');
        }
        vi.spyOn(surface.video, 'pause').mockImplementation(() => undefined);
        player.notifyCustomPlaybackTimeUpdate(4_000);
        expect(player.notifyCustomPlaybackPaused()).toBe(true);
        // Cover in the 16:9 box cuts 180px of the 1440px-high 4:3 frame at the top and the bottom: 60 of 480 script lines
        player.notifyPresentedPictureGeometry({
            box: { height: 1_080, width: 1_920, x: 0, y: 0 },
            frame: { height: 1_440, width: 1_920, x: 0, y: -180 },
            visible: { height: 1_080, width: 1_920, x: 0, y: 0 }
        });
        player.setSubtitleStreamIndex(0);
        await vi.waitFor(() => {
            expect(specializedSubtitleRendererMock.assInstances).toHaveLength(1);
        });
        const renderer = specializedSubtitleRendererMock.assInstances[0];
        await vi.waitFor(() => expect(renderer.setStyle).toHaveBeenCalledTimes(3));
        expect(fetchMock).toHaveBeenCalledWith('https://example.test/subtitles.ass', expect.anything());
        expect(renderer.setStyle.mock.calls).toEqual([
            [ { MarginL: 10, MarginR: 10, MarginV: 80 }, 0 ],
            [ { MarginL: 10, MarginR: 10, MarginV: 75 }, 1 ],
            [ { MarginL: 30, MarginR: 0, MarginV: 5 }, 2 ]
        ]);
        // The paused frame redraws with them, at the custom clock
        expect(renderer.setCurrentTime).toHaveBeenLastCalledWith(4);

        // A time update with the same cut changes no style
        player.notifyCustomPlaybackTimeUpdate(4_000);
        expect(renderer.setStyle).toHaveBeenCalledTimes(3);

        // A side cut moves the side margins: 120 of 1920px is 40 of 640 script columns
        renderer.setStyle.mockClear();
        renderer.resize.mockClear();
        // The renderer sized its canvas to the frame already, which the cut leaves as it is
        const canvas = renderer.options.canvas as HTMLCanvasElement;
        canvas.width = 1_920;
        canvas.height = 1_080;
        player.notifyPresentedPictureGeometry({
            box: { height: 1_080, width: 1_680, x: 120, y: 0 },
            frame: { height: 1_080, width: 1_920, x: -120, y: 0 },
            visible: { height: 1_080, width: 1_680, x: 0, y: 0 }
        });
        expect(renderer.setStyle.mock.calls).toEqual([
            [ { MarginL: 50, MarginR: 50, MarginV: 20 }, 0 ],
            [ { MarginL: 50, MarginR: 50, MarginV: 15 }, 1 ],
            [ { MarginL: 70, MarginR: 40, MarginV: 5 }, 2 ]
        ]);
        // libass keeps a shown line where it placed it until its frame size changes, so a size a line taller and back lays the lines out again
        expect(renderer.resize.mock.calls).toEqual([ [ 1_920, 1_081, 0, 0 ], [ 1_920, 1_080, 0, 0 ] ]);
        expect(renderer.setStyle.mock.invocationCallOrder[2]).toBeLessThan(renderer.resize.mock.invocationCallOrder[0]);

        // Once nothing is cut, the script's own margins return exactly
        renderer.setStyle.mockClear();
        player.notifyPresentedPictureGeometry({
            box: { height: 1_080, width: 1_920, x: 0, y: 0 },
            frame: { height: 1_080, width: 1_920, x: 0, y: 0 },
            visible: { height: 1_080, width: 1_920, x: 0, y: 0 }
        });
        expect(renderer.setStyle.mock.calls).toEqual([
            [ { MarginL: 10, MarginR: 10, MarginV: 20 }, 0 ],
            [ { MarginL: 10, MarginR: 10, MarginV: 15 }, 1 ],
            [ { MarginL: 30, MarginR: 0, MarginV: 5 }, 2 ]
        ]);

        // A pillarboxed frame stays inside the box, so the script keeps its own margins
        renderer.setStyle.mockClear();
        player.notifyPresentedPictureGeometry({
            box: { height: 1_080, width: 1_920, x: 0, y: 0 },
            frame: { height: 1_080, width: 1_440, x: 240, y: 0 },
            visible: { height: 1_080, width: 1_440, x: 240, y: 0 }
        });
        expect(renderer.setStyle).not.toHaveBeenCalled();

        // The ended renderer's adjusted styles go with its worker, which held the only copy of the script
        await player.stop(false);
        expect(renderer.dispose).toHaveBeenCalledOnce();
    });

    it('keeps the script\'s margins when its resolution cannot be read', async () => {
        specializedSubtitleRendererMock.assStyles.push({ Alignment: 2, MarginL: 10, MarginR: 10, MarginV: 20, Name: 'Default' });
        const consoleWarning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
        const player = new HtmlVideoPlayer(undefined, true) as unknown as HtmlVideoPlayerTestHarness;
        const options = createPlayOptions('https://example.test/custom.mkv', 'MKV');
        options.mediaSource.MediaStreams = [
            createSpecializedTrack(0, 'ass', 'https://example.test/subtitles.ass')
        ];
        await player.prepareCustomPlayback(options);
        player.setSubtitleStreamIndex(0);
        await vi.waitFor(() => {
            expect(specializedSubtitleRendererMock.assInstances).toHaveLength(1);
        });
        const renderer = specializedSubtitleRendererMock.assInstances[0];
        await vi.waitFor(() => expect(consoleWarning).toHaveBeenCalledOnce());

        player.notifyPresentedPictureGeometry({
            box: { height: 1_080, width: 1_920, x: 0, y: 0 },
            frame: { height: 1_440, width: 1_920, x: 0, y: -180 },
            visible: { height: 1_080, width: 1_920, x: 0, y: 0 }
        });
        expect(renderer.setStyle).not.toHaveBeenCalled();
        player.destroy();
    });

    it('places libbitsub over the presented source frame in a clip frame, and removes it with the renderer', async () => {
        const player = new HtmlVideoPlayer(undefined, true) as unknown as HtmlVideoPlayerTestHarness;
        const options = createPlayOptions('https://example.test/custom.mkv', 'MKV');
        options.mediaSource.MediaStreams = [
            createSpecializedTrack(0, 'pgssub', 'https://example.test/first.sup')
        ];
        await player.prepareCustomPlayback(options);
        const surface = player.getPresentationSurface();
        if (!surface) {
            throw new Error('Custom presentation surface was not created');
        }
        vi.spyOn(surface.video, 'pause').mockImplementation(() => undefined);
        vi.spyOn(surface.video, 'getBoundingClientRect').mockReturnValue(createRectangle(0, 0, 1_920, 1_080));
        Object.defineProperty(surface.container, 'clientWidth', { configurable: true, value: 1_920 });
        Object.defineProperty(surface.container, 'clientHeight', { configurable: true, value: 1_080 });
        vi.spyOn(surface.container, 'getBoundingClientRect').mockReturnValue(createRectangle(0, 0, 1_920, 1_080));
        player.setSubtitleStreamIndex(0);
        await vi.waitFor(() => {
            expect(specializedSubtitleRendererMock.bitmapInstances).toHaveLength(1);
        });
        const renderer = specializedSubtitleRendererMock.bitmapInstances[0];
        expect(renderer.options.displaySettings).toEqual({ aspectMode: 'contain' });

        // libbitsub creates its canvas in the video's parent once its WebAssembly loads, and the renderer moves it into its clip frame
        renderer.createCanvas();
        const canvas = renderer.canvas;
        const frameElement = canvas?.parentElement;
        expect(frameElement?.classList.contains('htmlVideoPlayerCustomSubtitleFrame')).toBe(true);
        expect(frameElement?.parentElement).toBe(surface.container);
        expect(canvas?.style).toMatchObject({ height: '1080px', left: '0px', top: '0px', width: '1920px' });

        // The cropped picture's frame reaches past the ultrawide box, and the subtitles fit it by the user's subtitle aspect setting, 'stretch' by default
        expect(player.notifyPresentedPictureGeometry({
            box: { height: 1_080, width: 2_560, x: 0, y: 0 },
            frame: { height: 1_440, width: 2_560, x: 0, y: -180 },
            visible: { height: 3_200 / 3, width: 2_560, x: 0, y: 20 / 3 }
        })).toBe(true);
        expect(renderer.setDisplaySettings).toHaveBeenLastCalledWith({ aspectMode: 'stretch' });
        expect(frameElement?.style).toMatchObject({ height: '1080px', left: '0px', top: '0px', width: '2560px' });
        expect(canvas?.style).toMatchObject({ height: '1440px', left: '0px', top: '-180px', width: '2560px' });

        // Over the frame the user's setting holds whatever the player's aspect, as on native playback
        vi.mocked(userSettings.getSubtitleAppearanceSettings).mockReturnValue({ aspectMode: 'Contain', verticalPosition: '0' });
        player.setAspectRatio('cover');
        expect(renderer.setDisplaySettings).toHaveBeenLastCalledWith({ aspectMode: 'contain' });
        vi.mocked(userSettings.getSubtitleAppearanceSettings).mockReturnValue({ verticalPosition: '0' });

        // Without a picture the overlay spans the box and follows the player's aspect again
        player.notifyPresentedPictureGeometry(null);
        expect(renderer.setDisplaySettings).toHaveBeenLastCalledWith({ aspectMode: 'contain' });
        expect(canvas?.style).toMatchObject({ height: '1080px', left: '0px', top: '0px', width: '1920px' });

        renderer.options.onLoaded?.();
        await player.stop(false);
        expect(renderer.dispose).toHaveBeenCalledOnce();
        expect(canvas?.isConnected).toBe(false);
        expect(frameElement?.isConnected).toBe(false);
    });

    it('drives libbitsub PGS from the custom clock, offsets, seeks, aspect changes, track switching, and cleanup', async () => {
        const player = new HtmlVideoPlayer(undefined, true) as unknown as HtmlVideoPlayerTestHarness;
        const options = createPlayOptions('https://example.test/custom.mkv', 'MKV');
        options.mediaSource.MediaStreams = [
            createSpecializedTrack(0, 'pgssub', 'https://example.test/first.sup'),
            createSpecializedTrack(1, 'pgssub', 'https://example.test/second.sup')
        ];
        options.transcodingOffsetTicks = 2_500_000;
        await player.prepareCustomPlayback(options);
        const surface = player.getPresentationSurface();
        expect(surface).not.toBeNull();
        if (!surface) {
            throw new Error('Custom presentation surface was not created');
        }
        vi.spyOn(surface.video, 'pause').mockImplementation(() => undefined);

        player.setSubtitleStreamIndex(0);
        await vi.waitFor(() => {
            expect(specializedSubtitleRendererMock.bitmapInstances).toHaveLength(1);
        });
        const firstRenderer = specializedSubtitleRendererMock.bitmapInstances[0];

        // The libbitsub renderer owns its overlay canvas and samples the owned source-less video
        expect(firstRenderer.format).toBe('pgs');
        expect(firstRenderer.options.video).toBe(surface.video);
        expect(firstRenderer.options).not.toHaveProperty('canvas');
        expect(firstRenderer.options.subUrl).toBe('https://example.test/first.sup');
        expect(firstRenderer.options.displaySettings).toEqual({ aspectMode: 'contain' });
        expect(document.querySelectorAll('.htmlVideoPlayerCustomSubtitleCanvas')).toHaveLength(0);
        expect(firstRenderer.getSubtitleTime()).toBeCloseTo(0.25);
        firstRenderer.options.onLoaded?.();
        expect(firstRenderer.getSubtitleTime()).toBeCloseTo(0.25);
        expect(firstRenderer.updateCanvasSize).toHaveBeenCalled();

        expect(player.notifyCustomPlaybackTimeUpdate(3_000)).toBe(true);
        expect(firstRenderer.getSubtitleTime()).toBeCloseTo(3.25);
        player._setSubtitleOffset(-0.75);
        expect(firstRenderer.getSubtitleTime()).toBeCloseTo(2.5);
        player.currentTime(6_000);
        expect(firstRenderer.getSubtitleTime()).toBeCloseTo(5.5);

        // A stale default playback position on the source-less video must not shift subtitle time
        Object.defineProperty(surface.video, 'currentTime', { configurable: true, value: 7 });
        player.notifyCustomPlaybackTimeUpdate(4_000);
        expect(firstRenderer.getSubtitleTime()).toBeCloseTo(3.5);
        player._setSubtitleOffset(0);

        // The overlay spans the whole source-less video, so its fit follows the presenter object-fit
        const canvasUpdateCount = firstRenderer.updateCanvasSize.mock.calls.length;
        player.setAspectRatio('cover');
        expect(firstRenderer.setDisplaySettings).toHaveBeenLastCalledWith({ aspectMode: 'cover' });
        player.setAspectRatio('fill');
        expect(firstRenderer.setDisplaySettings).toHaveBeenLastCalledWith({ aspectMode: 'stretch' });
        player.setAspectRatio('auto');
        expect(firstRenderer.setDisplaySettings).toHaveBeenLastCalledWith({ aspectMode: 'contain' });
        expect(firstRenderer.updateCanvasSize).toHaveBeenCalledTimes(canvasUpdateCount + 3);

        vi.mocked(appSettings.aspectRatio).mockReturnValue('fill');
        // The custom clock advances while libbitsub is still being imported
        const renderPgs = player.renderPgs.bind(player);
        vi.spyOn(player, 'renderPgs').mockImplementationOnce((...renderArguments: unknown[]) => {
            renderPgs(...renderArguments);
            player.notifyCustomPlaybackPaused();
            player.notifyCustomPlaybackTimeUpdate(9_000);
        });
        player.setSubtitleStreamIndex(1);
        await vi.waitFor(() => {
            expect(specializedSubtitleRendererMock.bitmapInstances).toHaveLength(2);
        });
        const secondRenderer = specializedSubtitleRendererMock.bitmapInstances[1];
        expect(firstRenderer.dispose).toHaveBeenCalledOnce();
        expect(secondRenderer.options.video).toBe(surface.video);
        expect(secondRenderer.options.displaySettings).toEqual({ aspectMode: 'stretch' });
        expect(secondRenderer.getSubtitleTime()).toBeCloseTo(4.25);

        // The settled load resynchronizes the offset captured before the clock advanced
        secondRenderer.options.onLoaded?.();
        expect(secondRenderer.getSubtitleTime()).toBeCloseTo(9.25);
        expect(secondRenderer.updateCanvasSize).toHaveBeenCalled();

        await player.stop(false);
        expect(secondRenderer.dispose).toHaveBeenCalledOnce();
    });

    it('drives libbitsub VobSub on the custom path from the server Matroska subtitle file', async () => {
        const player = new HtmlVideoPlayer(undefined, true) as unknown as HtmlVideoPlayerTestHarness;
        const options = createPlayOptions('https://example.test/custom.mkv', 'MKV');
        options.mediaSource.MediaStreams = [
            createSpecializedTrack(
                2,
                'DVDSUB',
                'https://example.test/Videos/item/source/Subtitles/2/0/Stream.vobsub?ApiKey=test-token'
            )
        ];
        await player.prepareCustomPlayback(options);
        const surface = player.getPresentationSurface();
        if (!surface) {
            throw new Error('Custom presentation surface was not created');
        }
        vi.spyOn(surface.video, 'pause').mockImplementation(() => undefined);

        player.setSubtitleStreamIndex(2);
        await vi.waitFor(() => {
            expect(specializedSubtitleRendererMock.bitmapInstances).toHaveLength(1);
        });
        const renderer = specializedSubtitleRendererMock.bitmapInstances[0];

        // Every supported server serves the extracted track raw only as Stream.mks, and libbitsub reads Matroska by that name
        expect(renderer.format).toBe('vobsub');
        expect(renderer.options).toMatchObject({
            displaySettings: { aspectMode: 'contain' },
            fileName: 'Stream.mks',
            subUrl: 'https://example.test/Videos/item/source/Subtitles/2/0/Stream.mks?ApiKey=test-token',
            video: surface.video
        });
        expect(renderer.options).not.toHaveProperty('idxUrl');

        renderer.options.onLoaded?.();
        expect(renderer.setDebandEnabled).toHaveBeenCalledWith(true);
        expect(player.notifyCustomPlaybackTimeUpdate(3_000)).toBe(true);
        expect(renderer.getSubtitleTime()).toBeCloseTo(3);
        player.currentTime(12_500);
        expect(renderer.getSubtitleTime()).toBeCloseTo(12.5);

        await player.stop(false);
        expect(renderer.dispose).toHaveBeenCalledOnce();
    });

    it('does not install an ASS renderer after its track generation is retired', async () => {
        const configuration = createDeferred<{ EnableFallbackFont: boolean }>();
        serverConnectionsMock.apiClient.getNamedConfiguration.mockReturnValueOnce(configuration.promise);
        const player = new HtmlVideoPlayer(undefined, true) as unknown as HtmlVideoPlayerTestHarness;
        const options = createPlayOptions('https://example.test/custom.mkv', 'MKV');
        options.mediaSource.MediaStreams = [
            createSpecializedTrack(0, 'ass', 'https://example.test/subtitles.ass')
        ];
        await player.prepareCustomPlayback(options);

        player.setSubtitleStreamIndex(0);
        await vi.waitFor(() => {
            expect(serverConnectionsMock.apiClient.getNamedConfiguration).toHaveBeenCalledOnce();
        });
        player.setSubtitleStreamIndex(-1);
        await Promise.resolve();
        configuration.resolve({ EnableFallbackFont: false });
        await Promise.resolve();
        await Promise.resolve();

        expect(specializedSubtitleRendererMock.assInstances).toHaveLength(0);
        expect(document.querySelectorAll('.htmlVideoPlayerCustomSubtitleCanvas')).toHaveLength(0);
    });

    it('preserves the native video-coupled specialized renderer paths', async () => {
        const player = new HtmlVideoPlayer(undefined, true) as unknown as HtmlVideoPlayerTestHarness;
        const options = createPlayOptions('https://example.test/native.mp4');
        options.mediaSource.MediaStreams = [
            createSpecializedTrack(0, 'ass', 'https://example.test/subtitles.ass'),
            createSpecializedTrack(1, 'pgssub', 'https://example.test/subtitles.sup')
        ];
        // Playback start reselects the default track, which must keep the active renderer
        options.mediaSource.DefaultSubtitleStreamIndex = 1;
        options.transcodingOffsetTicks = 10_000_000;
        await player.play(options);
        const nativeVideo = player.getPresentationSurface()?.video;
        expect(nativeVideo).toBeDefined();
        vi.spyOn(nativeVideo as HTMLVideoElement, 'pause').mockImplementation(() => undefined);

        player.setSubtitleStreamIndex(0);
        await vi.waitFor(() => {
            expect(specializedSubtitleRendererMock.assInstances).toHaveLength(1);
        });
        const renderer = specializedSubtitleRendererMock.assInstances[0];

        expect(renderer.options.video).toBe(player.getPresentationSurface()?.video);
        expect(renderer.options.canvas).toBeUndefined();
        expect(renderer.options.timeOffset).toBe(1);
        expect(renderer.options.renderAhead).toBe(90);
        expect(document.querySelectorAll('.htmlVideoPlayerCustomSubtitleCanvas')).toHaveLength(0);

        vi.mocked(userSettings.getSubtitleAppearanceSettings).mockReturnValue({
            aspectMode: 'cover',
            verticalPosition: '0'
        });
        player.setSubtitleStreamIndex(1);
        await vi.waitFor(() => {
            expect(specializedSubtitleRendererMock.bitmapInstances).toHaveLength(1);
        });
        const pgsRenderer = specializedSubtitleRendererMock.bitmapInstances[0];
        expect(renderer.dispose).toHaveBeenCalledOnce();
        expect(pgsRenderer.format).toBe('pgs');
        expect(pgsRenderer.options).toMatchObject({
            displaySettings: { aspectMode: 'cover' },
            prefetchWindow: { after: 2, before: 1 },
            rangeRequests: true,
            streamingLoad: true,
            subUrl: 'https://example.test/subtitles.sup',
            timeOffset: 1,
            video: nativeVideo
        });
        expect(pgsRenderer.options).not.toHaveProperty('canvas');
        pgsRenderer.options.onLoaded?.();
        expect(pgsRenderer.timeOffset).toBe(1);

        player._setSubtitleOffset(0.5);
        expect(pgsRenderer.timeOffset).toBe(1.5);
        player.setAspectRatio('cover');
        expect(pgsRenderer.setDisplaySettings).not.toHaveBeenCalled();
        expect(pgsRenderer.updateCanvasSize).toHaveBeenCalled();

        // The start seek resynchronizes the native offset and overlay size
        pgsRenderer.timeOffset = 0;
        const canvasUpdateCount = pgsRenderer.updateCanvasSize.mock.calls.length;
        nativeVideo?.dispatchEvent(new Event('playing'));
        const onMediaReady = htmlMediaHelperMock.seekOnPlaybackStart.mock.lastCall?.[3] as (() => void) | undefined;
        expect(onMediaReady).toBeTypeOf('function');
        onMediaReady?.();
        expect(pgsRenderer.timeOffset).toBe(1.5);
        expect(pgsRenderer.updateCanvasSize).toHaveBeenCalledTimes(canvasUpdateCount + 1);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(pgsRenderer.dispose).not.toHaveBeenCalled();
        expect(specializedSubtitleRendererMock.bitmapInstances).toHaveLength(1);

        await player.stop(false);
        expect(pgsRenderer.dispose).toHaveBeenCalledOnce();
    });

    it('renders native VobSub from the server Matroska subtitle file with deband settings', async () => {
        const fetchMock = vi.fn(() => Promise.reject(new Error('VobSub must not use the text subtitle path')));
        vi.stubGlobal('fetch', fetchMock);
        document.getElementById('htmlvideoplayer-cuestyle')?.remove();
        const player = new HtmlVideoPlayer(undefined, false) as unknown as HtmlVideoPlayerTestHarness;
        const options = createPlayOptions('https://example.test/native.mkv', 'MKV');
        options.mediaSource.MediaStreams = [
            createSpecializedTrack(
                0,
                'dvdsub',
                'https://example.test/Videos/item/source/Subtitles/0/0/Stream.vobsub?ApiKey=test-token'
            )
        ];
        await player.play(options);
        const nativeVideo = player.getPresentationSurface()?.video;
        expect(nativeVideo).toBeDefined();
        vi.spyOn(nativeVideo as HTMLVideoElement, 'pause').mockImplementation(() => undefined);

        player.setSubtitleStreamIndex(0);
        await vi.waitFor(() => {
            expect(specializedSubtitleRendererMock.bitmapInstances).toHaveLength(1);
        });
        const vobSubRenderer = specializedSubtitleRendererMock.bitmapInstances[0];

        expect(vobSubRenderer.format).toBe('vobsub');
        expect(vobSubRenderer.options).toMatchObject({
            fileName: 'Stream.mks',
            subUrl: 'https://example.test/Videos/item/source/Subtitles/0/0/Stream.mks?ApiKey=test-token',
            timeOffset: 0,
            video: nativeVideo
        });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(nativeVideo?.textTracks.length).toBe(0);
        expect(document.getElementById('htmlvideoplayer-cuestyle')).toBeNull();

        vobSubRenderer.options.onLoaded?.();
        expect(vobSubRenderer.setDebandEnabled).toHaveBeenCalledWith(true);
        expect(vobSubRenderer.setDebandThreshold).toHaveBeenCalledWith(64);
        expect(vobSubRenderer.setDebandRange).toHaveBeenCalledWith(15);
        expect(vobSubRenderer.updateCanvasSize).toHaveBeenCalled();

        await player.stop(false);
        expect(vobSubRenderer.dispose).toHaveBeenCalledOnce();
    });

    it('falls back to a VobSub MKS file name hint without a usable path', async () => {
        playbackManagerMock.getSubtitleUrl.mockReturnValueOnce('https://example.test/subtitle-stream');
        const player = new HtmlVideoPlayer(undefined, false) as unknown as HtmlVideoPlayerTestHarness;
        const options = createPlayOptions('https://example.test/native.mkv', 'MKV');
        options.mediaSource.MediaStreams = [{
            Codec: 'vobsub',
            DeliveryMethod: 'External',
            Index: 0,
            IsExternal: true,
            Type: 'Subtitle'
        }];
        await player.play(options);

        player.setSubtitleStreamIndex(0);
        await vi.waitFor(() => {
            expect(specializedSubtitleRendererMock.bitmapInstances).toHaveLength(1);
        });

        expect(specializedSubtitleRendererMock.bitmapInstances[0].options.fileName).toBe('subtitle.mks');
        player.destroy();
    });

    it('keeps a VobSub URL that is not a server subtitle stream', async () => {
        const player = new HtmlVideoPlayer(undefined, false) as unknown as HtmlVideoPlayerTestHarness;
        const options = createPlayOptions('https://example.test/native.mkv', 'MKV');
        options.mediaSource.MediaStreams = [
            { ...createSpecializedTrack(0, 'dvdsub', 'https://cdn.example.test/Stream.sub'), IsExternalUrl: true },
            createSpecializedTrack(1, 'dvdsub', 'https://cdn.example.test/movie.mks')
        ];
        await player.play(options);

        player.setSubtitleStreamIndex(0);
        await vi.waitFor(() => {
            expect(specializedSubtitleRendererMock.bitmapInstances).toHaveLength(1);
        });
        expect(specializedSubtitleRendererMock.bitmapInstances[0].options).toMatchObject({
            fileName: 'Stream.sub',
            subUrl: 'https://cdn.example.test/Stream.sub'
        });

        player.setSubtitleStreamIndex(1);
        await vi.waitFor(() => {
            expect(specializedSubtitleRendererMock.bitmapInstances).toHaveLength(2);
        });
        expect(specializedSubtitleRendererMock.bitmapInstances[1].options).toMatchObject({
            fileName: 'movie.mks',
            subUrl: 'https://cdn.example.test/movie.mks'
        });
        player.destroy();
    });

    it('tracks bitmap subtitle loads and ends them when the track changes', async () => {
        const player = new HtmlVideoPlayer(undefined, true) as unknown as HtmlVideoPlayerTestHarness;
        const fetchEvents: string[] = [];
        Events.on(player, 'beginFetch', () => fetchEvents.push('beginFetch'));
        Events.on(player, 'endFetch', () => fetchEvents.push('endFetch'));
        const options = createPlayOptions('https://example.test/custom.mkv', 'MKV');
        options.mediaSource.MediaStreams = [
            createSpecializedTrack(0, 'pgssub', 'https://example.test/first.sup'),
            createSpecializedTrack(1, 'pgssub', 'https://example.test/second.sup')
        ];
        await player.prepareCustomPlayback(options);
        const video = player.getPresentationSurface()?.video;
        expect(video).toBeDefined();
        vi.spyOn(video as HTMLVideoElement, 'pause').mockImplementation(() => undefined);

        player.setSubtitleStreamIndex(0);
        await vi.waitFor(() => {
            expect(specializedSubtitleRendererMock.bitmapInstances).toHaveLength(1);
        });
        const firstRenderer = specializedSubtitleRendererMock.bitmapInstances[0];
        firstRenderer.options.onLoading?.();
        expect(player.isFetching).toBe(true);

        player.setSubtitleStreamIndex(1);
        await vi.waitFor(() => {
            expect(specializedSubtitleRendererMock.bitmapInstances).toHaveLength(2);
        });
        const secondRenderer = specializedSubtitleRendererMock.bitmapInstances[1];
        expect(player.isFetching).toBe(false);
        expect(fetchEvents).toEqual(['beginFetch', 'endFetch']);

        // A renderer retired mid-load is released once its load settles, without touching its successor
        expect(firstRenderer.dispose).not.toHaveBeenCalled();
        const secondCanvasUpdateCount = secondRenderer.updateCanvasSize.mock.calls.length;
        firstRenderer.options.onLoading?.();
        firstRenderer.options.onLoaded?.();
        expect(firstRenderer.dispose).toHaveBeenCalledOnce();
        expect(secondRenderer.updateCanvasSize).toHaveBeenCalledTimes(secondCanvasUpdateCount);
        expect(player.isFetching).toBe(false);

        secondRenderer.options.onLoading?.();
        expect(player.isFetching).toBe(true);
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        secondRenderer.options.onError?.(new Error('Subtitle fetch failed'));
        expect(consoleError).toHaveBeenCalledWith('[libbitsub] pgs error', expect.any(Error));
        expect(secondRenderer.dispose).not.toHaveBeenCalled();
        expect(player.isFetching).toBe(false);
        expect(fetchEvents).toEqual(['beginFetch', 'endFetch', 'beginFetch', 'endFetch']);

        // A settled renderer is disposed as soon as its track changes
        player.setSubtitleStreamIndex(0);
        await vi.waitFor(() => {
            expect(specializedSubtitleRendererMock.bitmapInstances).toHaveLength(3);
        });
        const thirdRenderer = specializedSubtitleRendererMock.bitmapInstances[2];
        expect(secondRenderer.dispose).toHaveBeenCalledOnce();

        // A renderer retired mid-load also settles through onError without reporting a stale failure
        thirdRenderer.options.onLoading?.();
        player.setSubtitleStreamIndex(1);
        await vi.waitFor(() => {
            expect(specializedSubtitleRendererMock.bitmapInstances).toHaveLength(4);
        });
        const fourthRenderer = specializedSubtitleRendererMock.bitmapInstances[3];
        consoleError.mockClear();
        thirdRenderer.options.onError?.(new Error('Retired subtitle fetch failed'));
        expect(thirdRenderer.dispose).toHaveBeenCalledOnce();
        expect(consoleError).not.toHaveBeenCalled();
        expect(player.isFetching).toBe(false);
        expect(fetchEvents).toEqual([
            'beginFetch',
            'endFetch',
            'beginFetch',
            'endFetch',
            'beginFetch',
            'endFetch'
        ]);

        fourthRenderer.options.onLoaded?.();
        await player.stop(false);
        expect(fourthRenderer.dispose).toHaveBeenCalledOnce();
    });

    it('balances the fetch state when a session ends during a bitmap subtitle load', async () => {
        const player = new HtmlVideoPlayer(undefined, true) as unknown as HtmlVideoPlayerTestHarness;
        const fetchEvents: string[] = [];
        Events.on(player, 'beginFetch', () => fetchEvents.push('beginFetch'));
        Events.on(player, 'endFetch', () => fetchEvents.push('endFetch'));
        const options = createPlayOptions('https://example.test/custom.mkv', 'MKV');
        options.mediaSource.MediaStreams = [
            createSpecializedTrack(0, 'pgssub', 'https://example.test/subtitles.sup')
        ];
        await player.prepareCustomPlayback(options);
        const video = player.getPresentationSurface()?.video;
        expect(video).toBeDefined();
        vi.spyOn(video as HTMLVideoElement, 'pause').mockImplementation(() => undefined);

        player.setSubtitleStreamIndex(0);
        await vi.waitFor(() => {
            expect(specializedSubtitleRendererMock.bitmapInstances).toHaveLength(1);
        });
        const renderer = specializedSubtitleRendererMock.bitmapInstances[0];
        renderer.options.onLoading?.();
        expect(player.isFetching).toBe(true);

        await player.stop(false);
        expect(player.isFetching).toBe(false);
        expect(fetchEvents).toEqual(['beginFetch', 'endFetch']);
        expect(renderer.dispose).not.toHaveBeenCalled();

        // The stale load settles after the session ended
        const canvasUpdateCount = renderer.updateCanvasSize.mock.calls.length;
        renderer.options.onLoaded?.();
        expect(renderer.dispose).toHaveBeenCalledOnce();
        expect(renderer.updateCanvasSize).toHaveBeenCalledTimes(canvasUpdateCount);
        expect(fetchEvents).toEqual(['beginFetch', 'endFetch']);
    });

    it('does not construct a libbitsub renderer after its track generation is retired', async () => {
        const player = new HtmlVideoPlayer(undefined, true) as unknown as HtmlVideoPlayerTestHarness;
        const options = createPlayOptions('https://example.test/custom.mkv', 'MKV');
        options.mediaSource.MediaStreams = [
            createSpecializedTrack(0, 'pgssub', 'https://example.test/subtitles.sup')
        ];
        await player.prepareCustomPlayback(options);
        const video = player.getPresentationSurface()?.video;
        expect(video).toBeDefined();
        vi.spyOn(video as HTMLVideoElement, 'pause').mockImplementation(() => undefined);
        const renderPgs = player.renderPgs.bind(player);
        const renderRequested = createDeferred<void>();
        vi.spyOn(player, 'renderPgs').mockImplementation((...renderArguments: unknown[]) => {
            renderPgs(...renderArguments);
            // Retire the render while libbitsub is still being imported
            void player.stop(false);
            renderRequested.resolve(undefined);
        });

        player.setSubtitleStreamIndex(0);
        await renderRequested.promise;
        await import('libbitsub');
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(specializedSubtitleRendererMock.bitmapInstances).toHaveLength(0);
    });

    it('prewarms libbitsub only when client bitmap rendering is available', async () => {
        const nativePlayer = new HtmlVideoPlayer(undefined, false) as unknown as HtmlVideoPlayerTestHarness;
        await nativePlayer.play(createPlayOptions('https://example.test/first.mp4'));
        expect(specializedSubtitleRendererMock.warmup).not.toHaveBeenCalled();

        vi.mocked(appSettings.get).mockImplementation((name: string) => (name === 'subtitlerenderpgs' ? 'true' : null));
        await nativePlayer.play(createPlayOptions('https://example.test/second.mp4'));
        await vi.waitFor(() => {
            expect(specializedSubtitleRendererMock.warmup).toHaveBeenCalledOnce();
        });
        nativePlayer.destroy();

        vi.mocked(appSettings.get).mockReturnValue(null);
        const customPlayer = new HtmlVideoPlayer(undefined, true) as unknown as HtmlVideoPlayerTestHarness;
        await customPlayer.prepareCustomPlayback(createPlayOptions('https://example.test/custom.mkv', 'MKV'));
        await vi.waitFor(() => {
            expect(specializedSubtitleRendererMock.warmup).toHaveBeenCalledTimes(2);
        });
        customPlayer.destroy();
    });
});

describe('HtmlVideoPlayer subtitle generations', () => {
    let fetchMock: Mock;
    let pendingResponses: Map<string, Deferred<Response>>;

    beforeEach(() => {
        pendingResponses = new Map<string, Deferred<Response>>();
        pendingResponses.set('https://example.test/first.js', createDeferred<Response>());
        pendingResponses.set('https://example.test/second.js', createDeferred<Response>());
        fetchMock = vi.fn((input: RequestInfo | URL) => {
            const pendingResponse = pendingResponses.get(input.toString());
            if (!pendingResponse) {
                return Promise.reject(new Error(`Unexpected subtitle URL: ${input.toString()}`));
            }

            return pendingResponse.promise;
        });
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        document.body.innerHTML = '';
        document.head.querySelectorAll('[id$="-cuestyle"]').forEach((element) => {
            element.remove();
        });
        vi.unstubAllGlobals();
    });

    it('discards a subtitle fetch completed after a newer track selection', async () => {
        const player = await createPlayer();

        player.setSubtitleStreamIndex(0);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        player.setSubtitleStreamIndex(1);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

        pendingResponses.get('https://example.test/second.js')?.resolve(createFetchResponse([{
            EndPositionTicks: TRACK_END_TICKS,
            StartPositionTicks: TRACK_START_TICKS,
            Text: 'Second track'
        }]));
        await vi.waitFor(() => expect(document.querySelector('.videoSubtitlesInner')).not.toBeNull());

        pendingResponses.get('https://example.test/first.js')?.resolve(createFetchResponse([{
            EndPositionTicks: TRACK_END_TICKS,
            StartPositionTicks: TRACK_START_TICKS,
            Text: 'Stale first track'
        }]));
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        player.updateSubtitleText(1_000);

        const subtitlesElement = document.querySelector('.videoSubtitlesInner');
        expect(subtitlesElement?.textContent).toContain('Second track');
        expect(subtitlesElement?.textContent).not.toContain('Stale first track');
    });

    it('discards a subtitle fetch completed after a retained player is stopped', async () => {
        const player = await createPlayer();
        const endFetchListener = vi.fn();
        Events.on(player, 'endFetch', endFetchListener);

        player.setSubtitleStreamIndex(0);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        expect(player.isFetching).toBe(true);
        await player.stop(false);
        expect(player.isFetching).toBe(false);
        // Stopping balances the abandoned beginFetch once
        expect(endFetchListener).toHaveBeenCalledOnce();

        pendingResponses.get('https://example.test/first.js')?.resolve(createFetchResponse([{
            EndPositionTicks: TRACK_END_TICKS,
            StartPositionTicks: TRACK_START_TICKS,
            Text: 'Stopped track'
        }]));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(player.getPresentationSurface()).not.toBeNull();
        expect(document.querySelector('.videoSubtitlesInner')).toBeNull();
        expect(endFetchListener).toHaveBeenCalledOnce();
    });

    it('renders a local text track in the forced DOM subtitle layer', async () => {
        itemHelperMock.isLocalItem.mockReturnValue(true);
        fetchMock.mockResolvedValue(createFetchResponse([{
            EndPositionTicks: TRACK_END_TICKS,
            StartPositionTicks: TRACK_START_TICKS,
            Text: 'Local track'
        }]));
        const player = await createPlayer();
        const localTrack = {
            ...createTrack(0, 'https://example.test/local.vtt'),
            IsExternal: false,
            Path: 'https://example.test/local.js'
        };
        player._currentPlayOptions = {
            item: { ServerId: 'server' },
            mediaSource: { MediaStreams: [localTrack] },
            playMethod: 'DirectPlay'
        };

        player.setSubtitleStreamIndex(0);
        await vi.waitFor(() => expect(document.querySelector('.videoSubtitlesInner')).not.toBeNull());
        player.updateSubtitleText(1_000);

        expect(document.querySelector('.videoSubtitlesInner')?.textContent).toContain('Local track');
        expect(player.getPresentationSurface()?.video.textTracks.length).toBe(0);
    });
});

describe('HtmlVideoPlayer play generations', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('awaits WebGPU audio routing before assigning an autoplay source', async () => {
        const outputReady = createDeferred<void>();
        const prepareAudioOutput = vi.fn(async (): Promise<void> => outputReady.promise);
        const player = new HtmlVideoPlayer(undefined, true, true, prepareAudioOutput) as unknown as HtmlVideoPlayerTestHarness;

        const playPromise = player.play(createPlayOptions('https://example.test/routed.mp4'));
        await vi.waitFor(() => expect(prepareAudioOutput).toHaveBeenCalledTimes(1));
        expect(htmlMediaHelperMock.applySrc).not.toHaveBeenCalled();
        expect(htmlMediaHelperMock.playWithPromise).not.toHaveBeenCalled();

        outputReady.resolve(undefined);
        await playPromise;
        expect(htmlMediaHelperMock.applySrc).toHaveBeenCalledTimes(1);
        expect(htmlMediaHelperMock.playWithPromise).toHaveBeenCalledTimes(1);
    });

    it('resolves a superseded play and blocks its deferred source continuation', async () => {
        const player = await createPlayer();
        const firstApply = createDeferred<void>();
        htmlMediaHelperMock.applySrc.mockImplementationOnce(async (element: { src: string }, source: string) => {
            await firstApply.promise;
            element.src = source;
        });

        const firstPlay = player.play(createPlayOptions('https://example.test/first.mp4'));
        await vi.waitFor(() => expect(htmlMediaHelperMock.applySrc).toHaveBeenCalledTimes(1));

        const secondPlay = player.play(createPlayOptions('https://example.test/second.mp4'));
        await expect(firstPlay).resolves.toBe(PLAYBACK_SUPERSEDED);
        await secondPlay;

        firstApply.resolve(undefined);
        await Promise.resolve();
        await Promise.resolve();

        expect(player.getPresentationSurface()?.video.src).toBe('https://example.test/second.mp4');
        expect(player.currentSrc()).toBe('https://example.test/second.mp4');
        expect(htmlMediaHelperMock.playWithPromise).toHaveBeenCalledTimes(1);
    });

    it('does not continue a play whose media element creation was superseded', async () => {
        const player = await createPlayer();
        const currentVideo = player.getPresentationSurface()?.video;
        expect(currentVideo).toBeDefined();

        const firstCreate = createDeferred<HTMLVideoElement | null>();
        const originalCreateMediaElement = player.createMediaElement.bind(player);
        vi.spyOn(player, 'createMediaElement')
            .mockImplementationOnce(() => firstCreate.promise)
            .mockImplementation((options, playSessionGeneration) => originalCreateMediaElement(options, playSessionGeneration));

        const firstPlay = player.play(createPlayOptions('https://example.test/first.mp4'));
        const secondPlay = player.play(createPlayOptions('https://example.test/second.mp4'));
        await expect(firstPlay).resolves.toBe(PLAYBACK_SUPERSEDED);
        await secondPlay;

        firstCreate.resolve(currentVideo ?? null);
        await Promise.resolve();
        await Promise.resolve();

        expect(htmlMediaHelperMock.applySrc).toHaveBeenCalledTimes(1);
        expect(player.currentSrc()).toBe('https://example.test/second.mp4');
    });

    it('does not continue a play whose URL update was superseded', async () => {
        const player = await createPlayer();
        const firstUrlUpdate = createDeferred<void>();
        const originalUpdateVideoUrl = player.updateVideoUrl.bind(player);
        vi.spyOn(player, 'updateVideoUrl')
            .mockImplementationOnce(() => firstUrlUpdate.promise)
            .mockImplementation((options, playSessionGeneration) => originalUpdateVideoUrl(options, playSessionGeneration));

        const firstPlay = player.play(createPlayOptions('https://example.test/first.mp4'));
        await vi.waitFor(() => expect(player.updateVideoUrl).toHaveBeenCalledTimes(1));
        const secondPlay = player.play(createPlayOptions('https://example.test/second.mp4'));
        await expect(firstPlay).resolves.toBe(PLAYBACK_SUPERSEDED);
        await secondPlay;

        firstUrlUpdate.resolve(undefined);
        await Promise.resolve();
        await Promise.resolve();

        expect(htmlMediaHelperMock.applySrc).toHaveBeenCalledTimes(1);
        expect(player.currentSrc()).toBe('https://example.test/second.mp4');
    });

    it('invalidates guarded source mutations after playback setup rejects', async () => {
        const player = await createPlayer();
        let guardedSourceElement: { src: string } | null = null;
        const setupError = new Error('Source setup failed');
        htmlMediaHelperMock.applySrc.mockImplementationOnce((element: { src: string }) => {
            guardedSourceElement = element;
            return Promise.reject(setupError);
        });

        await expect(player.play(createPlayOptions('https://example.test/failed.mp4'))).rejects.toBe(setupError);
        expect(guardedSourceElement).not.toBeNull();

        const staleSourceElement = guardedSourceElement as unknown as { src: string };
        staleSourceElement.src = 'https://example.test/stale.mp4';

        expect(player.getPresentationSurface()?.video.src).not.toBe('https://example.test/stale.mp4');
        expect(player.currentSrc()).toBeUndefined();
    });

    it('stops an in-flight play without allowing it to call play afterward', async () => {
        const player = await createPlayer();
        const pendingApply = createDeferred<void>();
        htmlMediaHelperMock.applySrc.mockImplementationOnce(async () => pendingApply.promise);

        const playPromise = player.play(createPlayOptions('https://example.test/stopped.mp4'));
        await vi.waitFor(() => expect(htmlMediaHelperMock.applySrc).toHaveBeenCalledTimes(1));
        await player.stop(false);
        await expect(playPromise).resolves.toBe(PLAYBACK_SUPERSEDED);

        pendingApply.resolve(undefined);
        await Promise.resolve();
        await Promise.resolve();

        expect(htmlMediaHelperMock.playWithPromise).not.toHaveBeenCalled();
    });

    it('pauses a native source whose play promise is explicitly canceled', async () => {
        const player = await createPlayer();
        const video = player.getPresentationSurface()?.video;
        expect(video).toBeDefined();
        const pause = vi.spyOn(video as HTMLVideoElement, 'pause').mockImplementation(() => undefined);
        const pendingNativePlay = createDeferred<void>();
        htmlMediaHelperMock.playWithPromise.mockReturnValueOnce(pendingNativePlay.promise);

        const playPromise = player.play(createPlayOptions('https://example.test/pending.mp4'));
        await vi.waitFor(() => expect(htmlMediaHelperMock.playWithPromise).toHaveBeenCalledTimes(1));
        player.cancelPendingPlay();
        await expect(playPromise).resolves.toBe(PLAYBACK_SUPERSEDED);

        expect(pause).toHaveBeenCalledTimes(1);
        pendingNativePlay.resolve(undefined);
    });

    it('destroys an in-flight play without allowing it to call play afterward', async () => {
        const player = await createPlayer();
        const pendingApply = createDeferred<void>();
        htmlMediaHelperMock.applySrc.mockImplementationOnce(async () => pendingApply.promise);

        const playPromise = player.play(createPlayOptions('https://example.test/destroyed.mp4'));
        await vi.waitFor(() => expect(htmlMediaHelperMock.applySrc).toHaveBeenCalledTimes(1));
        player.destroy();
        await expect(playPromise).resolves.toBe(PLAYBACK_SUPERSEDED);

        pendingApply.resolve(undefined);
        await Promise.resolve();
        await Promise.resolve();

        expect(htmlMediaHelperMock.playWithPromise).not.toHaveBeenCalled();
        expect(player.getPresentationSurface()).toBeNull();
    });

    it('cancels an in-flight play when the media element ends', async () => {
        const player = await createPlayer();
        const pendingApply = createDeferred<void>();
        htmlMediaHelperMock.applySrc.mockImplementationOnce(async () => pendingApply.promise);

        const playPromise = player.play(createPlayOptions('https://example.test/ended.mp4'));
        await vi.waitFor(() => expect(htmlMediaHelperMock.applySrc).toHaveBeenCalledTimes(1));
        player.getPresentationSurface()?.video.dispatchEvent(new Event('ended'));
        await expect(playPromise).resolves.toBe(PLAYBACK_SUPERSEDED);

        pendingApply.resolve(undefined);
        await Promise.resolve();
        expect(htmlMediaHelperMock.playWithPromise).not.toHaveBeenCalled();
    });

    it('cancels an in-flight play on a fatal media error', async () => {
        const player = await createPlayer();
        const pendingApply = createDeferred<void>();
        htmlMediaHelperMock.applySrc.mockImplementationOnce(async () => pendingApply.promise);
        const video = player.getPresentationSurface()?.video;
        expect(video).toBeDefined();
        Object.defineProperty(video, 'error', {
            configurable: true,
            value: { code: 4, message: 'Unsupported source' }
        });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const playPromise = player.play(createPlayOptions('https://example.test/error.mp4'));
        await vi.waitFor(() => expect(htmlMediaHelperMock.applySrc).toHaveBeenCalledTimes(1));
        player.onError({ target: video } as unknown as Event);
        await expect(playPromise).resolves.toBe(PLAYBACK_SUPERSEDED);

        pendingApply.resolve(undefined);
        await Promise.resolve();
        expect(htmlMediaHelperMock.playWithPromise).not.toHaveBeenCalled();
        expect(htmlMediaHelperMock.onErrorInternal).toHaveBeenCalled();
        consoleError.mockRestore();
    });

    it('does not construct HLS after its credential lookup is superseded', async () => {
        const player = await createPlayer();
        const firstCredentialLookup = createDeferred<boolean>();
        htmlMediaHelperMock.enableHlsJsPlayerForCodecs.mockImplementation((mediaSource?: { Container?: string }) => {
            return mediaSource?.Container === 'HLS';
        });
        webSettingsMock.getIncludeCorsCredentials
            .mockImplementationOnce(() => firstCredentialLookup.promise)
            .mockResolvedValue(false);

        const firstPlay = player.play(createPlayOptions('https://example.test/first.m3u8', 'HLS'));
        await vi.waitFor(() => expect(webSettingsMock.getIncludeCorsCredentials).toHaveBeenCalledTimes(1));
        const secondPlay = player.play(createPlayOptions('https://example.test/second.mp4'));
        await expect(firstPlay).resolves.toBe(PLAYBACK_SUPERSEDED);
        await secondPlay;

        firstCredentialLookup.resolve(false);
        await Promise.resolve();
        await Promise.resolve();

        expect(hlsModuleMock.instances).toHaveLength(0);
        expect(htmlMediaHelperMock.bindEventsToHlsPlayer).not.toHaveBeenCalled();
        expect(player.currentSrc()).toBe('https://example.test/second.mp4');
    });

    it.each([
        [ 'legacy then WebGPU', false, true ],
        [ 'WebGPU then legacy', true, false ]
    ])('shares the HLS runtime when loaded %s', async (
        _loadOrder,
        firstUsesWebGPUHLSRuntime,
        secondUsesWebGPUHLSRuntime
    ) => {
        htmlMediaHelperMock.enableHlsJsPlayerForCodecs.mockReturnValue(true);
        htmlMediaHelperMock.bindEventsToHlsPlayer.mockImplementation((...eventArguments: unknown[]) => {
            const resolveHlsSource = eventArguments[4] as () => void;
            resolveHlsSource();
        });

        const firstPlayer = await createPlayer(firstUsesWebGPUHLSRuntime);
        await firstPlayer.play(createPlayOptions('https://example.test/first.m3u8', 'HLS'));
        const secondPlayer = await createPlayer(secondUsesWebGPUHLSRuntime);
        await secondPlayer.play(createPlayOptions('https://example.test/second.m3u8', 'HLS'));

        expect(hlsModuleMock.instances).toHaveLength(2);

        const firstSessionCallbacks = htmlMediaHelperMock.bindEventsToHlsPlayer.mock.calls[0][6] as {
            hlsRuntime: unknown
        };
        const secondSessionCallbacks = htmlMediaHelperMock.bindEventsToHlsPlayer.mock.calls[1][6] as {
            hlsRuntime: unknown
        };
        expect(firstSessionCallbacks.hlsRuntime).toBe(hlsModuleMock.MockHls);
        expect(secondSessionCallbacks.hlsRuntime).toBe(hlsModuleMock.MockHls);
    });

    it('keeps established HLS callbacks current when no startup is pending', async () => {
        const player = await createPlayer();
        const terminalError = 'established-hls-error';
        let rejectHlsSource: ((error?: unknown) => void) | null = null;
        htmlMediaHelperMock.enableHlsJsPlayerForCodecs.mockReturnValue(true);
        htmlMediaHelperMock.bindEventsToHlsPlayer.mockImplementationOnce((...eventArguments: unknown[]) => {
            const resolveHlsSource = eventArguments[4] as () => void;
            rejectHlsSource = eventArguments[5] as (error?: unknown) => void;
            resolveHlsSource();
        });

        await player.play(createPlayOptions('https://example.test/established.m3u8', 'HLS'));
        expect(rejectHlsSource).not.toBeNull();
        const destroyHlsCallCount = htmlMediaHelperMock.destroyHlsPlayer.mock.calls.length;
        player.cancelPendingPlay();
        expect(htmlMediaHelperMock.destroyHlsPlayer).toHaveBeenCalledTimes(destroyHlsCallCount);
        const rejectEstablishedHlsSource = rejectHlsSource as unknown as (error?: unknown) => void;
        rejectEstablishedHlsSource(terminalError);

        expect(htmlMediaHelperMock.onErrorInternal).toHaveBeenCalledWith(player, terminalError);
    });

    it('turns an HLS rejection after startup into a terminal player error', async () => {
        const player = await createPlayer();
        const terminalError = 'fatal-hls-after-start';
        let rejectHlsSource: ((error?: unknown) => void) | null = null;
        htmlMediaHelperMock.enableHlsJsPlayerForCodecs.mockReturnValue(true);
        htmlMediaHelperMock.bindEventsToHlsPlayer.mockImplementationOnce((...eventArguments: unknown[]) => {
            const resolveHlsSource = eventArguments[4] as () => void;
            rejectHlsSource = eventArguments[5] as (error?: unknown) => void;
            resolveHlsSource();
        });

        await player.play(createPlayOptions('https://example.test/started.m3u8', 'HLS'));
        expect(rejectHlsSource).not.toBeNull();
        const rejectStartedHlsSource = rejectHlsSource as unknown as (error?: unknown) => void;
        rejectStartedHlsSource(terminalError);

        expect(htmlMediaHelperMock.destroyHlsPlayer).toHaveBeenCalled();
        expect(htmlMediaHelperMock.onErrorInternal).toHaveBeenCalledWith(player, terminalError);
    });

    it('bounds WebGPU-owned HLS ranges while retaining byte-aware forward buffering', async () => {
        const player = await createPlayer(true);
        htmlMediaHelperMock.enableHlsJsPlayerForCodecs.mockReturnValue(true);
        htmlMediaHelperMock.bindEventsToHlsPlayer.mockImplementationOnce((...eventArguments: unknown[]) => {
            const resolveHlsSource = eventArguments[4] as () => void;
            resolveHlsSource();
        });

        await player.play(createPlayOptions('https://example.test/master.m3u8', 'HLS'));

        expect(hlsModuleMock.instances).toHaveLength(1);
        expect(hlsModuleMock.instances[0].config).toEqual(expect.objectContaining({
            backBufferLength: 6,
            frontBufferFlushThreshold: 6,
            lowLatencyMode: false,
            maxBufferLength: 6,
            maxMaxBufferLength: 30
        }));
        expect(playbackManagerMock.getMaxStreamingBitrate).not.toHaveBeenCalled();
        expect(hlsModuleMock.MockHls.DefaultConfig.backBufferLength).toBe(Number.POSITIVE_INFINITY);
        expect(hlsModuleMock.MockHls.DefaultConfig.liveBackBufferLength).toBeNull();
        expect(hlsModuleMock.MockHls.DefaultConfig.lowLatencyMode).toBe(true);
    });

    it('preserves legacy HTML HLS retention below the high bitrate limit', async () => {
        const player = await createPlayer();
        htmlMediaHelperMock.enableHlsJsPlayerForCodecs.mockReturnValue(true);
        htmlMediaHelperMock.bindEventsToHlsPlayer.mockImplementationOnce((...eventArguments: unknown[]) => {
            const resolveHlsSource = eventArguments[4] as () => void;
            resolveHlsSource();
        });

        await player.play(createPlayOptions('https://example.test/master.m3u8', 'HLS'));

        expect(hlsModuleMock.instances).toHaveLength(1);
        expect(hlsModuleMock.instances[0].config).toEqual(expect.objectContaining({
            backBufferLength: Number.POSITIVE_INFINITY,
            liveBackBufferLength: 90,
            maxBufferLength: 30,
            maxMaxBufferLength: 30
        }));
        expect(hlsModuleMock.instances[0].config).not.toHaveProperty('frontBufferFlushThreshold');
    });

    it('keeps the legacy 6 s HTML HLS buffer at high bitrates', async () => {
        const browserFlags = browser as unknown as Record<string, unknown>;
        browserFlags.chrome = true;
        playbackManagerMock.getMaxStreamingBitrate.mockReturnValueOnce(25_000_000);
        try {
            const player = await createPlayer();
            htmlMediaHelperMock.enableHlsJsPlayerForCodecs.mockReturnValue(true);
            htmlMediaHelperMock.bindEventsToHlsPlayer.mockImplementationOnce((...eventArguments: unknown[]) => {
                const resolveHlsSource = eventArguments[4] as () => void;
                resolveHlsSource();
            });

            await player.play(createPlayOptions('https://example.test/master.m3u8', 'HLS'));

            expect(playbackManagerMock.getMaxStreamingBitrate).toHaveBeenCalledWith(player);
            expect(hlsModuleMock.instances).toHaveLength(1);
            expect(hlsModuleMock.instances[0].config).toEqual(expect.objectContaining({
                backBufferLength: Number.POSITIVE_INFINITY,
                liveBackBufferLength: 90,
                maxBufferLength: 6,
                maxMaxBufferLength: 6
            }));
        } finally {
            browserFlags.chrome = false;
        }
    });
});

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import CustomPlaybackPictureInPicture, {
    type CustomPlaybackPictureInPictureOptions
} from 'addons/webGPUPlayer/CustomPlaybackPictureInPicture';
import type { PresentedPicture, PresentedPictureObserver } from 'webgpu-player/presentation/WebGPUPresenter';
import { installPictureInPictureFake, type PictureInPictureFake } from './pictureInPictureFake';

type MockOptions = { [Member in keyof CustomPlaybackPictureInPictureOptions]: Mock<CustomPlaybackPictureInPictureOptions[Member]> };

let browser: PictureInPictureFake;
let observers: PresentedPictureObserver[];
let stopObserving: Mock;
let animationFrames: Map<number, FrameRequestCallback>;

function createOptions(): MockOptions {
    return {
        observePictures: vi.fn((observer: PresentedPictureObserver): (() => void) => {
            observers.push(observer);
            return stopObserving;
        }),
        onChange: vi.fn(),
        onPausedOpen: vi.fn(),
        pause: vi.fn(),
        play: vi.fn()
    };
}

function setVisibility(state: DocumentVisibilityState): void {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
}

function runAnimationFrames(): void {
    const callbacks = [ ...animationFrames.values() ];
    animationFrames.clear();
    for (const callback of callbacks) {
        callback(0);
    }
}

/** Lets the media events queued so far reach their listeners */
async function deliverEvents(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

/** Opens the window and returns its video once the window's events arrived */
async function openWindow(pictureInPicture: CustomPlaybackPictureInPicture): Promise<HTMLVideoElement> {
    await pictureInPicture.enter();
    await deliverEvents();
    return browser.streamVideos[0] as HTMLVideoElement;
}

function createPicture(overrides: Partial<PresentedPicture> = {}): PresentedPicture {
    return {
        canvas: document.createElement('canvas'),
        height: 562.5,
        width: 1_000,
        x: 0,
        y: 218.75,
        ...overrides
    };
}

describe('CustomPlaybackPictureInPicture', () => {
    beforeEach(() => {
        observers = [];
        stopObserving = vi.fn();
        animationFrames = new Map();
        let nextAnimationFrame = 1;
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback): number => {
            const identifier = nextAnimationFrame;
            nextAnimationFrame += 1;
            animationFrames.set(identifier, callback);
            return identifier;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn((identifier: number): void => {
            animationFrames.delete(identifier);
        }));
        browser = installPictureInPictureFake();
        setVisibility('visible');
    });

    afterEach(() => {
        browser.uninstall();
        vi.unstubAllGlobals();
        Reflect.deleteProperty(document, 'visibilityState');
    });

    it('needs the Picture-in-Picture API and canvas capture', () => {
        expect(CustomPlaybackPictureInPicture.isSupported()).toBe(true);

        Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: false });
        expect(CustomPlaybackPictureInPicture.isSupported()).toBe(false);

        Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: true });
        Reflect.deleteProperty(HTMLCanvasElement.prototype, 'captureStream');
        expect(CustomPlaybackPictureInPicture.isSupported()).toBe(false);
    });

    it('opens the window on a video of its own, out of the document, once the stream sized it', async () => {
        browser.capturedStreamsSendFrames = false;
        const options = createOptions();
        const pictureInPicture = new CustomPlaybackPictureInPicture(options);

        const entered = pictureInPicture.enter();
        const video = browser.streamVideos[0] as HTMLVideoElement;
        await deliverEvents();
        // A video without a size cannot enter picture-in-picture, so the request waits for the stream's first frame
        expect(video.requestPictureInPicture).not.toHaveBeenCalled();
        expect(video.isConnected).toBe(false);
        expect(video.muted).toBe(true);
        expect(browser.context.fillRect).toHaveBeenCalledOnce();

        browser.loadMetadata(video);
        await entered;
        await deliverEvents();
        expect(browser.pictureInPictureElement()).toBe(video);
        expect(pictureInPicture.isOpen()).toBe(true);
        expect(options.onChange).toHaveBeenCalledOnce();
        expect(options.observePictures).toHaveBeenCalledOnce();

        await pictureInPicture.exit();
        await deliverEvents();
        expect(pictureInPicture.isOpen()).toBe(false);
        expect(options.onChange).toHaveBeenCalledTimes(2);

        // A second window reuses the video, which already has its size, so the request goes out at once
        const reopened = pictureInPicture.enter();
        await Promise.resolve();
        expect(video.requestPictureInPicture).toHaveBeenCalledTimes(2);
        await reopened;
        expect(browser.streamVideos).toEqual([ video ]);
    });

    it('rejects a window whose stream sends no frame, and stops copying pictures', async () => {
        browser.capturedStreamsSendFrames = false;
        vi.useFakeTimers();
        try {
            const pictureInPicture = new CustomPlaybackPictureInPicture(createOptions());
            const rejection = expect(pictureInPicture.enter()).rejects.toMatchObject({ name: 'InvalidStateError' });

            await vi.advanceTimersByTimeAsync(2_000);
            await rejection;
            expect(stopObserving).toHaveBeenCalledOnce();
            expect(pictureInPicture.isOpen()).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('copies each presented picture, cropped to its region, while the window is open', async () => {
        const pictureInPicture = new CustomPlaybackPictureInPicture(createOptions());
        pictureInPicture.setPlaying(true);
        await openWindow(pictureInPicture);
        const picture = createPicture();

        observers[0](picture);

        expect(browser.context.drawImage).toHaveBeenCalledExactlyOnceWith(picture.canvas, 0, 218.75, 1_000, 562.5, 0, 0, 1_000, 563);

        await pictureInPicture.exit();
        await deliverEvents();
        expect(stopObserving).toHaveBeenCalledOnce();
    });

    it('scales a picture down to 1920 on its longer side, and skips an empty one', async () => {
        const pictureInPicture = new CustomPlaybackPictureInPicture(createOptions());
        pictureInPicture.setPlaying(true);
        await openWindow(pictureInPicture);
        const picture = createPicture({ height: 1_600, width: 3_840, y: 280 });

        observers[0](createPicture({ height: 0 }));
        observers[0](picture);

        expect(browser.context.drawImage).toHaveBeenCalledExactlyOnceWith(picture.canvas, 0, 280, 3_840, 1_600, 0, 0, 1_920, 800);
    });

    it('plays and pauses its video with the playback, and hands the window\'s own pause and play to the playback', async () => {
        const options = createOptions();
        const pictureInPicture = new CustomPlaybackPictureInPicture(options);
        pictureInPicture.setPlaying(true);
        const video = await openWindow(pictureInPicture);
        expect(video.paused).toBe(false);

        pictureInPicture.setPlaying(false);
        await deliverEvents();
        pictureInPicture.setPlaying(true);
        await deliverEvents();
        expect(video.paused).toBe(false);
        expect(options.pause).not.toHaveBeenCalled();
        expect(options.play).not.toHaveBeenCalled();

        // Closing the window pauses its video, as Chromium does
        video.pause();
        await deliverEvents();
        expect(options.pause).toHaveBeenCalledOnce();

        pictureInPicture.setPlaying(false);
        await deliverEvents();
        void video.play();
        await deliverEvents();
        expect(options.play).toHaveBeenCalledOnce();
        expect(options.pause).toHaveBeenCalledOnce();
    });

    it('shows a picture copied while paused by playing the video until it renders that frame', async () => {
        const options = createOptions();
        const pictureInPicture = new CustomPlaybackPictureInPicture(options);
        const video = await openWindow(pictureInPicture);
        // The window opened on a paused playback, which draws its picture again for the copy
        expect(options.onPausedOpen).toHaveBeenCalledOnce();
        expect(video.paused).toBe(true);

        observers[0](createPicture());
        expect(video.paused).toBe(false);
        // The video's own play event arrives before its next frame renders, and is no play of the window's
        await deliverEvents();
        expect(options.play).not.toHaveBeenCalled();

        browser.renderFrame(video);
        expect(video.paused).toBe(true);
        await deliverEvents();
        expect(options.play).not.toHaveBeenCalled();
        expect(options.pause).not.toHaveBeenCalled();
    });

    it('keeps a video playing that showed a paused picture once the playback plays before the frame renders', async () => {
        const options = createOptions();
        const pictureInPicture = new CustomPlaybackPictureInPicture(options);
        const video = await openWindow(pictureInPicture);

        observers[0](createPicture());
        pictureInPicture.setPlaying(true);
        browser.renderFrame(video);
        await deliverEvents();

        expect(video.paused).toBe(false);
        expect(options.play).not.toHaveBeenCalled();
    });

    it('reports presentation visible while the hidden page paints for the open window', async () => {
        const options = createOptions();
        const pictureInPicture = new CustomPlaybackPictureInPicture(options);
        pictureInPicture.setPlaying(true);
        await openWindow(pictureInPicture);
        options.onChange.mockClear();

        setVisibility('hidden');
        pictureInPicture.handlePageVisibilityChange();
        // A hidden page that stops painting, as most do, runs no animation frame, so presentation stays hidden
        expect(pictureInPicture.isPresentedWhileHidden()).toBe(false);

        runAnimationFrames();
        expect(pictureInPicture.isPresentedWhileHidden()).toBe(true);
        expect(options.onChange).toHaveBeenCalledOnce();

        setVisibility('visible');
        pictureInPicture.handlePageVisibilityChange();
        expect(pictureInPicture.isPresentedWhileHidden()).toBe(false);
        expect(animationFrames.size).toBe(0);

        setVisibility('hidden');
        pictureInPicture.handlePageVisibilityChange();
        await pictureInPicture.exit();
        await deliverEvents();
        // A closed window keeps no presentation visible, whatever frame runs later
        runAnimationFrames();
        expect(pictureInPicture.isPresentedWhileHidden()).toBe(false);
    });
});

import type { PresentedPicture, PresentedPictureObserver } from 'webgpu-player/presentation/WebGPUPresenter';

/** What the window reads from a custom playback, and what it tells the playback */
export type CustomPlaybackPictureInPictureOptions = {
    /** Hands each picture presentation draws to the observer, in the task that drew it, until the returned function stops it */
    observePictures: (observer: PresentedPictureObserver) => () => void
    /** The window opened or closed, or the hidden page painted for it, which decides whether presentation still reaches the window */
    onChange: () => void
    /** The window opened on a paused playback, whose picture it shows once presentation draws it again */
    onPausedOpen: () => void
    /** The window's own controls paused its video, as closing the window does */
    pause: () => void
    /** The window's own controls played its video */
    play: () => void
};

// The ready state from which a video knows its size, which a picture-in-picture request needs
const HAVE_METADATA = 1;
// The stream's first frame arrives within a few animation frames, well inside the user activation a request needs
const METADATA_TIMEOUT_MILLISECONDS = 2_000;
// The picture a window shows before presentation drew one: black, at 16:9
const PLACEHOLDER_WIDTH = 16;
const PLACEHOLDER_HEIGHT = 9;
// The longest side of the window's picture, which bounds the copy and the stream on a large screen; a window is rarely wider
const MAXIMUM_PICTURE_DIMENSION = 1_920;
// How long a paused video plays to show a picture copied while paused, unless it reports the frame first
const REVEAL_TIMEOUT_MILLISECONDS = 250;

/** Resolves once a video knows its size, and rejects when its stream sends no frame in time. */
function waitForMetadata(video: HTMLVideoElement): Promise<void> {
    if (video.readyState >= HAVE_METADATA) {
        return Promise.resolve();
    }
    return new Promise<void>((resolve, reject): void => {
        const settle = (): void => {
            globalThis.clearTimeout(timeout);
            video.removeEventListener('loadedmetadata', settle);
            resolve();
        };
        const timeout = globalThis.setTimeout((): void => {
            video.removeEventListener('loadedmetadata', settle);
            reject(new DOMException('The picture-in-picture stream sent no frame', 'InvalidStateError'));
        }, METADATA_TIMEOUT_MILLISECONDS);
        video.addEventListener('loadedmetadata', settle);
    });
}

/**
 * Shows a custom playback in a picture-in-picture window.
 *
 * Custom playback presents into a WebGPU canvas, and its `<video>` has no source, so the window shows a `<video>` of its own:
 * each picture the presenter draws is copied, cropped to the picture, into a 2D canvas whose captured stream the window's video plays.
 * The presenter hands each picture over in the task that drew it, the only time a WebGPU canvas can be read.
 * The window's video stays out of the document, so scripts that find the player as the page's first `<video>` still find the player's own.
 * It plays while the playback plays and pauses while it pauses, which the window's controls show, and a pause or play of the window's own,
 * as closing the window pauses its video, reaches the playback.
 * Chromium keeps painting a hidden page while one of its videos is in picture-in-picture, so presentation reaches the window while the page is hidden;
 * an animation frame that runs while the page is hidden tells the page so.
 */
export default class CustomPlaybackPictureInPicture {
    private readonly options: CustomPlaybackPictureInPictureOptions;
    private canvas: HTMLCanvasElement | null = null;
    private context: CanvasRenderingContext2D | null = null;
    private video: HTMLVideoElement | null = null;
    private stopObservingPictures: (() => void) | null = null;
    private entering: Promise<void> | null = null;
    private open = false;
    // Whether the playback plays, which the window's video follows
    private playing = false;
    // Whether the page painted for the open window while hidden, so presentation reaches the window
    private paintedWhileHidden = false;
    private hiddenPaintRequest: number | null = null;
    // A paused stream keeps the picture it rendered last, so the video plays until it renders a picture copied while paused
    private revealingPicture = false;

    constructor(options: CustomPlaybackPictureInPictureOptions) {
        this.options = options;
    }

    /** Returns whether the browser can show a custom playback in a picture-in-picture window. */
    static isSupported(): boolean {
        return typeof document !== 'undefined'
            // eslint-disable-next-line compat/compat -- A browser without the Picture-in-Picture API leaves it undefined
            && document.pictureInPictureEnabled === true
            && typeof HTMLVideoElement.prototype.requestPictureInPicture === 'function'
            && typeof HTMLCanvasElement.prototype.captureStream === 'function';
    }

    /** Returns whether the window is open. */
    isOpen(): boolean {
        return this.open;
    }

    /** Returns whether presentation reaches the open window while the page is hidden, which only a hidden page that keeps painting does. */
    isPresentedWhileHidden(): boolean {
        return this.open && this.paintedWhileHidden;
    }

    /**
     * Opens the window, which the browser allows during a user's gesture, or while another video is in picture-in-picture.
     * The window shows the picture last copied, or black, until presentation draws the next one.
     */
    enter(): Promise<void> {
        this.entering ??= this.openWindow().finally((): void => {
            this.entering = null;
        });
        return this.entering;
    }

    /** Closes the window. */
    exit(): Promise<void> {
        const video = this.video;
        if (!video || document.pictureInPictureElement !== video) {
            return Promise.resolve();
        }
        // eslint-disable-next-line compat/compat -- Only an open window, which needs the API, has an element
        return document.exitPictureInPicture();
    }

    /** Follows the playback's state: the window's video plays while the playback plays. */
    setPlaying(playing: boolean): void {
        this.playing = playing;
        const video = this.video;
        if (!video) {
            return;
        }
        if (playing) {
            this.playVideo(video);
        } else if (!this.revealingPicture) {
            this.pauseVideo(video);
        }
    }

    /** Finds out again whether the page paints for the window, once the page was shown or hidden. */
    handlePageVisibilityChange(): void {
        this.paintedWhileHidden = false;
        this.requestHiddenPaint();
    }

    private async openWindow(): Promise<void> {
        const video = this.prepareVideo();
        this.stopObservingPictures ??= this.options.observePictures(this.copyPicture);
        try {
            await waitForMetadata(video);
            await video.requestPictureInPicture();
        } catch (error) {
            if (!this.open) {
                this.stopCopying();
            }
            throw error;
        }
    }

    /** Returns the window's video, made at the first window: muted, out of the document, playing the 2D canvas's stream. */
    private prepareVideo(): HTMLVideoElement {
        if (this.video) {
            return this.video;
        }
        const canvas = document.createElement('canvas');
        canvas.width = PLACEHOLDER_WIDTH;
        canvas.height = PLACEHOLDER_HEIGHT;
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) {
            throw new DOMException('The picture-in-picture canvas has no 2D context', 'NotSupportedError');
        }
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.srcObject = canvas.captureStream();
        video.addEventListener('enterpictureinpicture', this.handleEnter);
        video.addEventListener('leavepictureinpicture', this.handleLeave);
        video.addEventListener('pause', this.handleVideoPause);
        video.addEventListener('play', this.handleVideoPlay);
        // The stream carries the draws made after its capture began, so the placeholder's draw gives the video its size
        context.fillRect(0, 0, PLACEHOLDER_WIDTH, PLACEHOLDER_HEIGHT);
        this.canvas = canvas;
        this.context = context;
        this.video = video;
        if (this.playing) {
            this.playVideo(video);
        }
        return video;
    }

    /** Copies a presented picture into the stream's canvas, in the task that drew it, at most MAXIMUM_PICTURE_DIMENSION on its longer side. */
    private readonly copyPicture = (picture: PresentedPicture): void => {
        const canvas = this.canvas;
        const context = this.context;
        const video = this.video;
        if (!canvas || !context || !video || picture.width < 1 || picture.height < 1) {
            return;
        }
        const scale = Math.min(1, MAXIMUM_PICTURE_DIMENSION / Math.max(picture.width, picture.height));
        const width = Math.max(1, Math.round(picture.width * scale));
        const height = Math.max(1, Math.round(picture.height * scale));
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
        context.drawImage(picture.canvas, picture.x, picture.y, picture.width, picture.height, 0, 0, width, height);
        if (!this.playing) {
            this.revealPicture(video);
        }
    };

    /** Plays a paused video until it renders the frame just copied, then pauses it again unless the playback plays by then. */
    private revealPicture(video: HTMLVideoElement): void {
        if (this.revealingPicture || !video.paused) {
            return;
        }
        this.revealingPicture = true;
        let settled = false;
        const settle = (): void => {
            if (settled) {
                return;
            }
            settled = true;
            globalThis.clearTimeout(timeout);
            this.revealingPicture = false;
            if (!this.playing) {
                this.pauseVideo(video);
            }
        };
        const timeout = globalThis.setTimeout(settle, REVEAL_TIMEOUT_MILLISECONDS);
        if (typeof video.requestVideoFrameCallback === 'function') {
            video.requestVideoFrameCallback(settle);
        }
        this.playVideo(video);
    }

    private playVideo(video: HTMLVideoElement): void {
        if (!video.paused) {
            return;
        }
        video.play().catch((error: unknown): void => {
            console.warn('Unable to play the picture-in-picture video', error);
        });
    }

    private pauseVideo(video: HTMLVideoElement): void {
        if (!video.paused) {
            video.pause();
        }
    }

    private stopCopying(): void {
        this.stopObservingPictures?.();
        this.stopObservingPictures = null;
    }

    /** Asks for an animation frame while the open window's page is hidden; one that runs then shows the page still paints. */
    private requestHiddenPaint(): void {
        this.cancelHiddenPaint();
        if (!this.open || document.visibilityState !== 'hidden') {
            return;
        }
        this.hiddenPaintRequest = globalThis.requestAnimationFrame((): void => {
            this.hiddenPaintRequest = null;
            if (this.open && document.visibilityState === 'hidden' && !this.paintedWhileHidden) {
                this.paintedWhileHidden = true;
                this.options.onChange();
            }
        });
    }

    private cancelHiddenPaint(): void {
        if (this.hiddenPaintRequest !== null) {
            globalThis.cancelAnimationFrame(this.hiddenPaintRequest);
            this.hiddenPaintRequest = null;
        }
    }

    private readonly handleEnter = (): void => {
        this.open = true;
        this.paintedWhileHidden = false;
        this.requestHiddenPaint();
        this.options.onChange();
        if (!this.playing) {
            this.options.onPausedOpen();
        }
    };

    private readonly handleLeave = (): void => {
        this.open = false;
        this.paintedWhileHidden = false;
        this.cancelHiddenPaint();
        this.stopCopying();
        this.options.onChange();
    };

    // The video pauses and plays only as the playback does, so a pause or play against the playback's state came from the window
    private readonly handleVideoPause = (): void => {
        if (this.video?.paused && this.playing && !this.revealingPicture) {
            this.options.pause();
        }
    };

    private readonly handleVideoPlay = (): void => {
        if (this.video && !this.video.paused && !this.playing && !this.revealingPicture) {
            this.options.play();
        }
    };
}

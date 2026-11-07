import { vi, type Mock } from 'vitest';

type MediaState = {
    paused: boolean
    readyState: number
    srcObject: MediaProvider | null
};

/** The Picture-in-Picture, media, and canvas behavior of a browser, which jsdom lacks */
export type PictureInPictureFake = {
    /** Whether a captured stream sends its first frame, which gives the video playing it its size */
    capturedStreamsSendFrames: boolean
    /** The 2D context every canvas returns */
    context: { drawImage: Mock, fillRect: Mock }
    /** Gives a video its size, as its stream's first frame does */
    loadMetadata: (video: HTMLMediaElement) => void
    /** The element in picture-in-picture, which `document.pictureInPictureElement` reads */
    pictureInPictureElement: () => HTMLVideoElement | null
    /** Renders the next frame of a video, which runs its video frame callbacks */
    renderFrame: (video: HTMLVideoElement) => void
    /** The videos a captured stream was assigned to, in order */
    streamVideos: HTMLMediaElement[]
    /** Restores what the fake replaced */
    uninstall: () => void
};

// The ready state from which a video knows its size
const HAVE_METADATA = 1;

/** Installs the fake on the prototypes and the document; vitest restores the spies, and `uninstall` the rest. */
export function installPictureInPictureFake(): PictureInPictureFake {
    const mediaStates = new WeakMap<HTMLMediaElement, MediaState>();
    const stateOf = (element: HTMLMediaElement): MediaState => {
        let state = mediaStates.get(element);
        if (!state) {
            state = { paused: true, readyState: 0, srcObject: null };
            mediaStates.set(element, state);
        }
        return state;
    };
    // The browser fires a media element's events in a later task than the call that caused them
    const fireLater = (element: EventTarget, type: string): void => {
        queueMicrotask((): void => {
            element.dispatchEvent(new Event(type));
        });
    };
    const loadMetadata = (video: HTMLMediaElement): void => {
        stateOf(video).readyState = HAVE_METADATA;
        video.dispatchEvent(new Event('loadedmetadata'));
    };
    const frameCallbacks = new Map<HTMLVideoElement, Array<() => void>>();
    const capturedStreams = new WeakSet<object>();
    // The element in picture-in-picture, which every page shares
    const pictureInPictureWindow: { element: HTMLVideoElement | null } = { element: null };
    const replaced: Array<{ descriptor: PropertyDescriptor | undefined, key: PropertyKey, target: object }> = [];
    const replace = (target: object, key: PropertyKey, descriptor: PropertyDescriptor): void => {
        replaced.push({ descriptor: Object.getOwnPropertyDescriptor(target, key), key, target });
        Object.defineProperty(target, key, { configurable: true, ...descriptor });
    };
    const fake: PictureInPictureFake = {
        capturedStreamsSendFrames: true,
        context: { drawImage: vi.fn(), fillRect: vi.fn() },
        loadMetadata,
        pictureInPictureElement: (): HTMLVideoElement | null => pictureInPictureWindow.element,
        renderFrame: (video: HTMLVideoElement): void => {
            const callbacks = frameCallbacks.get(video) ?? [];
            frameCallbacks.delete(video);
            for (const callback of callbacks) {
                callback();
            }
        },
        streamVideos: [],
        uninstall: (): void => {
            // Restored in reverse, so a property replaced twice gets its first descriptor back
            for (let index = replaced.length - 1; index >= 0; index -= 1) {
                const { descriptor, key, target } = replaced[index];
                if (descriptor) {
                    Object.defineProperty(target, key, descriptor);
                } else {
                    Reflect.deleteProperty(target, key);
                }
            }
        }
    };

    vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function (this: HTMLMediaElement): boolean {
        return stateOf(this).paused;
    });
    vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockImplementation(function (this: HTMLMediaElement): number {
        return stateOf(this).readyState;
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement): Promise<void> {
        const state = stateOf(this);
        if (state.paused) {
            state.paused = false;
            fireLater(this, 'play');
        }
        return Promise.resolve();
    });
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement): void {
        const state = stateOf(this);
        if (!state.paused) {
            state.paused = true;
            fireLater(this, 'pause');
        }
    });
    // The spy takes getContext's last overload, so the 2D context passes as what that one returns
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake.context as unknown as ReturnType<HTMLCanvasElement['getContext']>);
    replace(HTMLCanvasElement.prototype, 'captureStream', {
        value: vi.fn((): MediaStream => {
            const stream = { getTracks: (): MediaStreamTrack[] => [] };
            capturedStreams.add(stream);
            return stream as unknown as MediaStream;
        })
    });
    replace(HTMLMediaElement.prototype, 'srcObject', {
        get(this: HTMLMediaElement): MediaProvider | null {
            return stateOf(this).srcObject;
        },
        set(this: HTMLMediaElement, stream: MediaProvider | null): void {
            const state = stateOf(this);
            state.srcObject = stream;
            state.readyState = 0;
            if (!stream || !capturedStreams.has(stream)) {
                return;
            }
            fake.streamVideos.push(this);
            // The canvas draws right after its capture began, and that frame gives the video its size
            if (fake.capturedStreamsSendFrames) {
                queueMicrotask((): void => {
                    if (state.srcObject === stream) {
                        loadMetadata(this);
                    }
                });
            }
        }
    });
    replace(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
        value: vi.fn(function (this: HTMLVideoElement, callback: () => void): number {
            const callbacks = frameCallbacks.get(this) ?? [];
            callbacks.push(callback);
            frameCallbacks.set(this, callbacks);
            return callbacks.length;
        })
    });
    replace(HTMLVideoElement.prototype, 'requestPictureInPicture', {
        value: vi.fn(function (this: HTMLVideoElement): Promise<PictureInPictureWindow> {
            if (stateOf(this).readyState < HAVE_METADATA) {
                return Promise.reject(new DOMException('Metadata for the video element are not loaded yet.', 'InvalidStateError'));
            }
            const previousElement = pictureInPictureWindow.element;
            pictureInPictureWindow.element = this;
            if (previousElement && previousElement !== this) {
                fireLater(previousElement, 'leavepictureinpicture');
            }
            fireLater(this, 'enterpictureinpicture');
            return Promise.resolve({} as PictureInPictureWindow);
        })
    });
    replace(document, 'pictureInPictureEnabled', { value: true });
    replace(document, 'pictureInPictureElement', { get: (): Element | null => pictureInPictureWindow.element });
    replace(document, 'exitPictureInPicture', {
        value: vi.fn((): Promise<void> => {
            const element = pictureInPictureWindow.element;
            pictureInPictureWindow.element = null;
            if (element) {
                fireLater(element, 'leavepictureinpicture');
            }
            return Promise.resolve();
        })
    });
    return fake;
}

import {
    microsecondsToSeconds,
    secondsToMicroseconds,
    type Microseconds
} from 'webgpu-player/MediaTime';
import type { CustomPlaybackState } from 'webgpu-player/pipeline/CustomPlaybackControllerTypes';

/** What a custom playback's `<video>` reads from the playback and asks of it */
export type CustomPlaybackMediaControls = {
    currentTime: () => Microseconds
    /** Null while the duration is unknown */
    duration: () => Microseconds | null
    pause: () => void
    play: () => void
    playbackRate: () => number
    seek: (time: Microseconds) => void
};

type PendingPlay = {
    reject: (error: DOMException) => void
    resolve: () => void
};

const HAVE_NOTHING = 0;
const HAVE_CURRENT_DATA = 2;
const HAVE_FUTURE_DATA = 3;
const HAVE_ENOUGH_DATA = 4;

// Members of HTMLMediaElement.prototype, shadowed on the element itself
const SHADOWED_MEMBERS = [
    'currentSrc',
    'currentTime',
    'duration',
    'ended',
    'pause',
    'paused',
    'play',
    'playbackRate',
    'readyState',
    'seeking'
] as const;

type ShadowedMember = typeof SHADOWED_MEMBERS[number];

// A source-less element cannot enter picture-in-picture, so the attribute tells page scripts, such as an automatic picture-in-picture, not to try
const DISABLE_PICTURE_IN_PICTURE_ATTRIBUTE = 'disablepictureinpicture';

const reportedEvents = new WeakSet<Event>();

/** Returns whether a media event reports a custom playback rather than the element's own media; the HTML player's handlers skip these. */
export function isCustomPlaybackMediaEvent(event: Event): boolean {
    return reportedEvents.has(event);
}

function isSameDescriptor(descriptor: PropertyDescriptor | undefined, expected: PropertyDescriptor): boolean {
    return descriptor !== undefined
        && descriptor.get === expected.get
        && descriptor.set === expected.set
        && descriptor.value === expected.value;
}

/**
 * Reports a custom playback through its `<video>`, which has no source of its own, to the page's other scripts.
 *
 * Custom playback decodes and presents without the element, so the element would stay paused at zero, with no source, and fire no media events.
 * Scripts that follow the player through its element, such as Jellyfin Enhanced's pause screen, tab-switch pause, and playback rating badge, would see nothing play.
 * While a custom playback owns the element, the element's playback members are shadowed on the element itself:
 * `paused`, `ended`, `seeking`, `readyState`, `currentTime`, `duration`, `playbackRate`, and `currentSrc` read the playback,
 * `play()`, `pause()`, and a `currentTime` write control it, and the element fires the media events of a playing element.
 * The events fire as microtasks, in order, so a listener never runs inside the controller call that caused it.
 */
export default class CustomPlaybackMediaElement {
    private readonly video: HTMLVideoElement;
    private readonly source: string;
    private readonly controls: CustomPlaybackMediaControls;
    private readonly installedDescriptors = new Map<ShadowedMember, PropertyDescriptor>();
    private readonly previousDescriptors = new Map<ShadowedMember, PropertyDescriptor | undefined>();
    private readonly pictureInPictureWasDisabled: boolean;
    private pendingPlays: PendingPlay[] = [];
    private queuedEventTypes: string[] = [];
    private eventDispatchQueued = false;
    private attached = true;
    // A custom playback starts playing, as an autoplaying element does
    private paused = false;
    private ended = false;
    private readyState = HAVE_NOTHING;
    private metadataReported = false;
    private seekTime: Microseconds | null = null;
    // Whether the controller entered its seeking state during the current seek, which its next playing or paused state then completes
    private controllerSeeking = false;

    constructor(video: HTMLVideoElement, source: string, controls: CustomPlaybackMediaControls) {
        this.video = video;
        this.source = source;
        this.controls = controls;
        this.pictureInPictureWasDisabled = video.hasAttribute(DISABLE_PICTURE_IN_PICTURE_ATTRIBUTE);
        this.shadowMembers();
        if (!this.pictureInPictureWasDisabled) {
            video.setAttribute(DISABLE_PICTURE_IN_PICTURE_ATTRIBUTE, '');
        }
        this.queueEvent('loadstart');
        this.queueEvent('play');
    }

    /** Follows the controller's state: playing and paused set the element's paused state, and complete a seek the controller ran. */
    notifyStateChange(state: CustomPlaybackState): void {
        if (!this.attached) {
            return;
        }
        if (state === 'seeking') {
            this.controllerSeeking = this.seekTime !== null;
            return;
        }
        if (state !== 'playing' && state !== 'paused') {
            return;
        }
        if (this.controllerSeeking) {
            this.completeSeek();
        }
        if (state === 'playing') {
            this.setPlaying();
        } else {
            this.setPaused();
        }
    }

    /** Completes the current seek once the playback started again at its position. */
    notifySeeked(): void {
        if (this.attached) {
            this.completeSeek();
        }
    }

    /** Reports the first frame ready, and with the first one the metadata. */
    notifyReady(): void {
        if (!this.attached) {
            return;
        }
        this.readyState = HAVE_ENOUGH_DATA;
        if (this.metadataReported) {
            return;
        }
        this.metadataReported = true;
        if (this.controls.duration() !== null) {
            this.queueEvent('durationchange');
        }
        this.queueEvent('loadedmetadata');
        this.queueEvent('loadeddata');
        this.queueEvent('canplay');
        this.queueEvent('canplaythrough');
    }

    notifyPlaying(): void {
        if (!this.attached) {
            return;
        }
        this.readyState = HAVE_ENOUGH_DATA;
        if (this.paused) {
            return;
        }
        this.queueEvent('playing');
        this.settlePendingPlays(null);
    }

    notifyWaiting(): void {
        if (!this.attached) {
            return;
        }
        this.readyState = Math.min(this.readyState, HAVE_CURRENT_DATA);
        if (!this.paused) {
            this.queueEvent('waiting');
        }
    }

    notifyTimeUpdate(): void {
        if (this.attached) {
            this.queueEvent('timeupdate');
        }
    }

    /** Reports a seek to a media time, which the element's `currentTime` reads until the seek completes. */
    notifySeeking(time: Microseconds): void {
        if (!this.attached) {
            return;
        }
        if (this.seekTime === null) {
            this.controllerSeeking = false;
        }
        this.seekTime = time;
        this.ended = false;
        this.queueEvent('seeking');
    }

    notifyEnded(): void {
        if (!this.attached) {
            return;
        }
        this.queueEvent('timeupdate');
        this.setPaused();
        this.ended = true;
        this.queueEvent('ended');
    }

    /** Hands the element back to its own media: the shadows go, a playing element reports a pause, and the element reports its media gone. */
    detach(): void {
        if (!this.attached) {
            return;
        }
        this.attached = false;
        for (const [ member, installedDescriptor ] of this.installedDescriptors) {
            // A member another script replaced meanwhile stays as that script left it
            if (!isSameDescriptor(Object.getOwnPropertyDescriptor(this.video, member), installedDescriptor)) {
                continue;
            }
            const previousDescriptor = this.previousDescriptors.get(member);
            if (previousDescriptor) {
                Object.defineProperty(this.video, member, previousDescriptor);
            } else {
                Reflect.deleteProperty(this.video, member);
            }
        }
        if (!this.pictureInPictureWasDisabled) {
            this.video.removeAttribute(DISABLE_PICTURE_IN_PICTURE_ATTRIBUTE);
        }
        this.settlePendingPlays(new DOMException('The play() request was interrupted because the playback ended.', 'AbortError'));
        this.setPaused();
        this.queueEvent('emptied');
    }

    private shadowMembers(): void {
        const video = this.video;
        // A shadow that outlives the playback, kept by another script, reads and calls the element's own member
        const accessor = <Value>(member: ShadowedMember, get: () => Value, set?: (value: number) => void): PropertyDescriptor => ({
            get: (): unknown => (this.attached ? get() : Reflect.get(HTMLMediaElement.prototype, member, video)),
            set: set && ((value: number): void => {
                if (this.attached) {
                    set(value);
                } else {
                    Reflect.set(HTMLMediaElement.prototype, member, value, video);
                }
            })
        });
        const descriptors: Record<ShadowedMember, PropertyDescriptor> = {
            currentSrc: accessor('currentSrc', (): string => this.source),
            currentTime: accessor(
                'currentTime',
                (): number => microsecondsToSeconds(this.seekTime ?? this.controls.currentTime()),
                (value: number): void => {
                    this.seek(value);
                }
            ),
            duration: accessor('duration', (): number => {
                const duration = this.controls.duration();
                return duration === null ? Number.NaN : microsecondsToSeconds(duration);
            }),
            ended: accessor('ended', (): boolean => this.ended),
            pause: {
                value: (): void => {
                    if (this.attached) {
                        this.pause();
                    } else {
                        HTMLMediaElement.prototype.pause.call(video);
                    }
                },
                writable: true
            },
            paused: accessor('paused', (): boolean => this.paused),
            play: {
                value: (): Promise<void> => (this.attached ? this.play() : HTMLMediaElement.prototype.play.call(video)),
                writable: true
            },
            playbackRate: accessor(
                'playbackRate',
                (): number => this.controls.playbackRate(),
                (value: number): void => {
                    this.setPlaybackRate(value);
                }
            ),
            readyState: accessor('readyState', (): number => this.readyState),
            seeking: accessor('seeking', (): boolean => this.seekTime !== null)
        };
        for (const member of SHADOWED_MEMBERS) {
            const descriptor: PropertyDescriptor = { ...descriptors[member], configurable: true };
            this.previousDescriptors.set(member, Object.getOwnPropertyDescriptor(video, member));
            this.installedDescriptors.set(member, descriptor);
            Object.defineProperty(video, member, descriptor);
        }
    }

    private play(): Promise<void> {
        const playPromise = new Promise<void>((resolve, reject): void => {
            this.pendingPlays.push({ reject, resolve });
        });
        this.setPlaying();
        this.controls.play();
        // An element already playing resolves at once; otherwise the next playing report resolves it
        if (!this.paused && this.readyState >= HAVE_FUTURE_DATA) {
            this.settlePendingPlays(null);
        }
        return playPromise;
    }

    private pause(): void {
        this.setPaused();
        this.controls.pause();
    }

    private seek(value: number): void {
        const seconds = Number(value);
        if (!Number.isFinite(seconds)) {
            throw new TypeError('The provided double value is non-finite.');
        }
        const duration = this.controls.duration();
        const boundedSeconds = duration === null ? seconds : Math.min(seconds, microsecondsToSeconds(duration));
        this.controls.seek(secondsToMicroseconds(Math.max(boundedSeconds, 0)));
    }

    private setPlaybackRate(value: number): void {
        const playbackRate = Number(value);
        if (!Number.isFinite(playbackRate)) {
            throw new TypeError('The provided double value is non-finite.');
        }
        // Custom playback keeps its rate, as its players offer no other
        if (playbackRate !== this.controls.playbackRate()) {
            throw new DOMException(`The provided playback rate (${playbackRate}) is not supported.`, 'NotSupportedError');
        }
    }

    private setPlaying(): void {
        if (!this.paused) {
            return;
        }
        this.paused = false;
        this.queueEvent('play');
    }

    private setPaused(): void {
        if (this.paused) {
            return;
        }
        this.paused = true;
        this.queueEvent('pause');
        this.settlePendingPlays(new DOMException('The play() request was interrupted by a call to pause().', 'AbortError'));
    }

    private completeSeek(): void {
        if (this.seekTime === null) {
            return;
        }
        this.seekTime = null;
        this.controllerSeeking = false;
        this.queueEvent('timeupdate');
        this.queueEvent('seeked');
    }

    private settlePendingPlays(error: DOMException | null): void {
        const pendingPlays = this.pendingPlays;
        this.pendingPlays = [];
        for (const pendingPlay of pendingPlays) {
            if (error) {
                pendingPlay.reject(error);
            } else {
                pendingPlay.resolve();
            }
        }
    }

    private queueEvent(type: string): void {
        this.queuedEventTypes.push(type);
        if (this.eventDispatchQueued) {
            return;
        }
        this.eventDispatchQueued = true;
        void Promise.resolve().then((): void => {
            this.dispatchQueuedEvents();
        });
    }

    private dispatchQueuedEvents(): void {
        this.eventDispatchQueued = false;
        const eventTypes = this.queuedEventTypes;
        this.queuedEventTypes = [];
        for (const eventType of eventTypes) {
            const event = new Event(eventType);
            reportedEvents.add(event);
            this.video.dispatchEvent(event);
        }
    }
}

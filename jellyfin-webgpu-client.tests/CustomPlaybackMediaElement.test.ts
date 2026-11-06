import { describe, expect, it, vi, type Mock } from 'vitest';

import CustomPlaybackMediaElement, {
    isCustomPlaybackMediaEvent,
    type CustomPlaybackMediaControls
} from 'addons/webGPUPlayer/CustomPlaybackMediaElement';
import type { Microseconds } from 'webgpu-player/MediaTime';

const SOURCE = 'https://server.test/Videos/0123456789abcdef0123456789abcdef/stream.mkv?Static=true';

const MEDIA_EVENT_TYPES = [
    'canplay',
    'canplaythrough',
    'durationchange',
    'emptied',
    'ended',
    'loadeddata',
    'loadedmetadata',
    'loadstart',
    'pause',
    'play',
    'playing',
    'seeked',
    'seeking',
    'timeupdate',
    'waiting'
] as const;

type ControlsState = {
    currentTime: Microseconds
    duration: Microseconds | null
    playbackRate: number
};

type MockControls = { [Member in keyof CustomPlaybackMediaControls]: Mock<CustomPlaybackMediaControls[Member]> };

function createControls(): { controls: MockControls, state: ControlsState } {
    const state: ControlsState = {
        currentTime: 5_000_000 as Microseconds,
        duration: 60_000_000 as Microseconds,
        playbackRate: 1
    };
    const controls: MockControls = {
        currentTime: vi.fn((): Microseconds => state.currentTime),
        duration: vi.fn((): Microseconds | null => state.duration),
        pause: vi.fn(),
        play: vi.fn(),
        playbackRate: vi.fn((): number => state.playbackRate),
        seek: vi.fn()
    };
    return { controls, state };
}

/** Records the media events the element fires; one the custom playback did not report is prefixed with `native:` */
function recordMediaEvents(video: HTMLVideoElement): string[] {
    const events: string[] = [];
    for (const type of MEDIA_EVENT_TYPES) {
        video.addEventListener(type, (event: Event): void => {
            events.push(isCustomPlaybackMediaEvent(event) ? type : `native:${type}`);
        });
    }
    return events;
}

/** Returns after the microtask the element delivers its queued events in */
async function deliverQueuedEvents(): Promise<void> {
    await Promise.resolve();
}

describe('CustomPlaybackMediaElement', () => {
    it('reports the playback through the element and hands the element back on detach', () => {
        const video = document.createElement('video');
        const { controls, state } = createControls();
        const mediaElement = new CustomPlaybackMediaElement(video, SOURCE, controls);

        expect(video.paused).toBe(false);
        expect(video.ended).toBe(false);
        expect(video.seeking).toBe(false);
        expect(video.readyState).toBe(0);
        expect(video.currentSrc).toBe(SOURCE);
        expect(video.currentTime).toBe(5);
        expect(video.duration).toBe(60);
        expect(video.playbackRate).toBe(1);
        expect(video.hasAttribute('disablepictureinpicture')).toBe(true);
        state.duration = null;
        expect(video.duration).toBeNaN();

        mediaElement.detach();

        expect(Object.getOwnPropertyNames(video)).toEqual([]);
        expect(video.paused).toBe(true);
        expect(video.currentSrc).toBe('');
        expect(video.currentTime).toBe(0);
        expect(video.hasAttribute('disablepictureinpicture')).toBe(false);
    });

    it('fires the events of an element that loads, plays, stalls, and pauses, after the call that caused them', async () => {
        const video = document.createElement('video');
        const events = recordMediaEvents(video);
        const { controls } = createControls();
        const mediaElement = new CustomPlaybackMediaElement(video, SOURCE, controls);

        mediaElement.notifyWaiting();
        mediaElement.notifyStateChange('playing');
        mediaElement.notifyReady();
        mediaElement.notifyPlaying();
        expect(events).toEqual([]);
        expect(video.readyState).toBe(4);

        mediaElement.notifyTimeUpdate();
        mediaElement.notifyWaiting();
        expect(video.readyState).toBe(2);
        mediaElement.notifyPlaying();
        mediaElement.notifyStateChange('paused');
        // A seek's startup ends in another ready, which reports no second load
        mediaElement.notifyReady();
        // A paused element neither waits nor plays
        mediaElement.notifyWaiting();
        mediaElement.notifyPlaying();
        await deliverQueuedEvents();

        expect(events).toEqual([
            'loadstart',
            'play',
            'waiting',
            'durationchange',
            'loadedmetadata',
            'loadeddata',
            'canplay',
            'canplaythrough',
            'playing',
            'timeupdate',
            'waiting',
            'playing',
            'pause'
        ]);
        expect(video.paused).toBe(true);
    });

    it('plays and pauses the playback from the element, reporting each change once', async () => {
        const video = document.createElement('video');
        const events = recordMediaEvents(video);
        const { controls } = createControls();
        const mediaElement = new CustomPlaybackMediaElement(video, SOURCE, controls);
        mediaElement.notifyReady();
        mediaElement.notifyPlaying();

        video.pause();
        expect(video.paused).toBe(true);
        expect(controls.pause).toHaveBeenCalledOnce();
        // The controller follows the pause it was asked for
        mediaElement.notifyStateChange('paused');

        const playPromise = video.play();
        expect(video.paused).toBe(false);
        expect(controls.play).toHaveBeenCalledOnce();
        mediaElement.notifyStateChange('playing');
        mediaElement.notifyPlaying();
        await expect(playPromise).resolves.toBeUndefined();
        // Playing already, a play resolves at once
        await expect(video.play()).resolves.toBeUndefined();
        await deliverQueuedEvents();

        // After the load: one pause and one play, though the controller reported each state change too
        expect(events.slice(events.indexOf('canplaythrough') + 1)).toEqual([ 'playing', 'pause', 'play', 'playing' ]);
    });

    it('rejects a play that a pause, the end, or a detach interrupts', async () => {
        const video = document.createElement('video');
        const { controls } = createControls();
        const mediaElement = new CustomPlaybackMediaElement(video, SOURCE, controls);
        mediaElement.notifyStateChange('paused');

        const pausedPlay = video.play();
        video.pause();
        await expect(pausedPlay).rejects.toMatchObject({ name: 'AbortError' });

        const endedPlay = video.play();
        mediaElement.notifyEnded();
        await expect(endedPlay).rejects.toMatchObject({ name: 'AbortError' });

        mediaElement.notifyStateChange('paused');
        const detachedPlay = video.play();
        mediaElement.detach();
        await expect(detachedPlay).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('seeks within the playback when the element time is written, and only while it reports the playback', () => {
        const video = document.createElement('video');
        const { controls, state } = createControls();
        const mediaElement = new CustomPlaybackMediaElement(video, SOURCE, controls);

        video.currentTime = 30.5;
        video.currentTime = 90;
        video.currentTime = -4;
        state.duration = null;
        video.currentTime = 3600;

        expect(controls.seek.mock.calls).toEqual([ [ 30_500_000 ], [ 60_000_000 ], [ 0 ], [ 3_600_000_000 ] ]);
        expect(() => {
            video.currentTime = Number.NaN;
        }).toThrow(TypeError);
        mediaElement.detach();
        video.currentTime = 10;
        expect(controls.seek).toHaveBeenCalledTimes(4);
    });

    it('reads the seek target while seeking and completes the seek when the controller ran it', async () => {
        const video = document.createElement('video');
        const events = recordMediaEvents(video);
        const { controls } = createControls();
        const mediaElement = new CustomPlaybackMediaElement(video, SOURCE, controls);
        await deliverQueuedEvents();

        mediaElement.notifySeeking(30_000_000 as Microseconds);
        expect(video.seeking).toBe(true);
        expect(video.currentTime).toBe(30);
        // A pause before the controller starts the seek leaves it seeking
        mediaElement.notifyStateChange('paused');
        expect(video.seeking).toBe(true);
        mediaElement.notifyStateChange('seeking');
        mediaElement.notifyStateChange('paused');
        expect(video.seeking).toBe(false);
        expect(video.currentTime).toBe(5);

        // The controller's own seek, as a paused frame refresh runs, is no seek of the element
        mediaElement.notifyStateChange('seeking');
        mediaElement.notifyStateChange('paused');
        await deliverQueuedEvents();

        expect(events.slice(2)).toEqual([ 'seeking', 'pause', 'timeupdate', 'seeked' ]);
    });

    it('completes a seek whose controller was already seeking once the playback started at its position', async () => {
        const video = document.createElement('video');
        const events = recordMediaEvents(video);
        const { controls } = createControls();
        const mediaElement = new CustomPlaybackMediaElement(video, SOURCE, controls);
        await deliverQueuedEvents();

        mediaElement.notifySeeking(10_000_000 as Microseconds);
        mediaElement.notifySeeking(20_000_000 as Microseconds);
        expect(video.currentTime).toBe(20);
        mediaElement.notifyStateChange('playing');
        expect(video.seeking).toBe(true);
        mediaElement.notifySeeked();
        mediaElement.notifySeeked();
        await deliverQueuedEvents();

        expect(video.seeking).toBe(false);
        expect(events.slice(2)).toEqual([ 'seeking', 'seeking', 'timeupdate', 'seeked' ]);
    });

    it('reports the end as a pause, then ended', async () => {
        const video = document.createElement('video');
        const events = recordMediaEvents(video);
        const { controls } = createControls();
        const mediaElement = new CustomPlaybackMediaElement(video, SOURCE, controls);

        mediaElement.notifyEnded();
        expect(video.paused).toBe(true);
        expect(video.ended).toBe(true);
        mediaElement.detach();
        await deliverQueuedEvents();

        expect(events).toEqual([ 'loadstart', 'play', 'timeupdate', 'pause', 'ended', 'emptied' ]);
    });

    it('reports a pause and the media gone when a playing element is detached, and nothing after', async () => {
        const video = document.createElement('video');
        const events = recordMediaEvents(video);
        const { controls } = createControls();
        const mediaElement = new CustomPlaybackMediaElement(video, SOURCE, controls);

        mediaElement.detach();
        mediaElement.notifyPlaying();
        mediaElement.notifyTimeUpdate();
        mediaElement.notifySeeking(1_000_000 as Microseconds);
        mediaElement.notifyEnded();
        mediaElement.detach();
        await deliverQueuedEvents();

        expect(events).toEqual([ 'loadstart', 'play', 'pause', 'emptied' ]);
        expect(video.seeking).toBe(false);
    });

    it('keeps the playback rate and refuses another while it reports the playback', () => {
        const video = document.createElement('video');
        const { controls } = createControls();
        const mediaElement = new CustomPlaybackMediaElement(video, SOURCE, controls);

        video.playbackRate = 1;
        expect(video.playbackRate).toBe(1);
        expect(() => {
            video.playbackRate = 2;
        }).toThrow(expect.objectContaining({ name: 'NotSupportedError' }));
        expect(video.playbackRate).toBe(1);
        mediaElement.detach();
        video.playbackRate = 2;
        expect(video.playbackRate).toBe(2);
    });

    it('leaves what other scripts set on the element', () => {
        const video = document.createElement('video');
        video.setAttribute('disablepictureinpicture', '');
        const { controls } = createControls();
        const mediaElement = new CustomPlaybackMediaElement(video, SOURCE, controls);
        const ownPlay = vi.fn(() => Promise.resolve());
        video.play = ownPlay;

        mediaElement.detach();

        expect(video.play).toBe(ownPlay);
        expect(video.hasAttribute('disablepictureinpicture')).toBe(true);
        expect(Object.getOwnPropertyNames(video)).toEqual([ 'play' ]);
    });

    it('tells its events from the element\'s own', async () => {
        const video = document.createElement('video');
        const events = recordMediaEvents(video);
        const { controls } = createControls();
        const mediaElement = new CustomPlaybackMediaElement(video, SOURCE, controls);

        video.dispatchEvent(new Event('pause'));
        mediaElement.notifyTimeUpdate();
        await deliverQueuedEvents();

        expect(events).toEqual([ 'native:pause', 'loadstart', 'play', 'timeupdate' ]);
    });
});

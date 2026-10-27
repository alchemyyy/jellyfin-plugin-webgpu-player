/**
 * Keeps the display awake while custom playback is playing.
 *
 * Custom playback renders to a canvas and plays audio through Web Audio, and its `<video>` has no source.
 * Browsers take their own display wake lock only for a playing `<video>` with a video track,
 * so without this the display sleeps mid-playback.
 * The browser drops the lock whenever the page is hidden, so a visible page requests it again.
 */
export default class ScreenWakeLock {
    /** The lock currently held, if any. */
    private sentinel: WakeLockSentinel | null = null;
    /** An in-flight lock request, which blocks duplicate requests. */
    private pendingRequest: Promise<void> | null = null;
    /** Whether playback currently wants the display kept awake. */
    private wanted = false;

    /** Requests the lock now, and again whenever the page becomes visible, until `release` is called. */
    acquire(): void {
        this.wanted = true;
        this.request();
    }

    /** Releases any held lock and stops requesting it again. */
    release(): void {
        this.wanted = false;
        const sentinel = this.sentinel;
        this.sentinel = null;
        if (sentinel && !sentinel.released) {
            sentinel.release().catch((error: unknown): void => {
                console.warn('Unable to release the screen wake lock', error);
            });
        }
    }

    /** Requests the lock again after the page becomes visible, if playback still wants it. */
    handleVisibilityChange(): void {
        if (this.wanted) {
            this.request();
        }
    }

    /** Requests the lock unless one is held or pending, or the page is hidden. */
    private request(): void {
        // eslint-disable-next-line compat/compat -- Browsers without the Screen Wake Lock API skip the request
        const wakeLock = typeof navigator === 'undefined' ? undefined : navigator.wakeLock;
        if (!wakeLock
            || this.pendingRequest
            || (this.sentinel && !this.sentinel.released)
            || (typeof document !== 'undefined' && document.visibilityState !== 'visible')) {
            return;
        }

        this.pendingRequest = wakeLock.request('screen').then((sentinel: WakeLockSentinel): void => {
            this.pendingRequest = null;
            if (!this.wanted) {
                void sentinel.release();
                return;
            }
            this.sentinel = sentinel;
        }, (error: unknown): void => {
            this.pendingRequest = null;
            console.warn('Unable to acquire a screen wake lock', error);
        });
    }
}

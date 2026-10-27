import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ScreenWakeLock from 'addons/webGPUPlayer/ScreenWakeLock';

type MockSentinel = {
    release: ReturnType<typeof vi.fn>
    released: boolean
};

function createSentinel(): MockSentinel {
    const sentinel: MockSentinel = {
        release: vi.fn((): Promise<void> => {
            sentinel.released = true;
            return Promise.resolve();
        }),
        released: false
    };
    return sentinel;
}

function setVisibility(state: DocumentVisibilityState): void {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
}

describe('ScreenWakeLock', () => {
    let sentinels: MockSentinel[];
    let request: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        sentinels = [];
        request = vi.fn((): Promise<MockSentinel> => {
            const sentinel = createSentinel();
            sentinels.push(sentinel);
            return Promise.resolve(sentinel);
        });
        Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request } });
        setVisibility('visible');
    });

    afterEach(() => {
        Reflect.deleteProperty(navigator, 'wakeLock');
        Reflect.deleteProperty(document, 'visibilityState');
    });

    it('requests a screen lock once while acquired and releases it', async () => {
        const wakeLock = new ScreenWakeLock();

        wakeLock.acquire();
        wakeLock.acquire();
        await vi.waitFor(() => expect(sentinels).toHaveLength(1));
        wakeLock.acquire();

        expect(request).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledWith('screen');

        wakeLock.release();
        expect(sentinels[0].release).toHaveBeenCalledTimes(1);
    });

    it('releases a lock that resolves after release was requested', async () => {
        const wakeLock = new ScreenWakeLock();

        wakeLock.acquire();
        wakeLock.release();

        await vi.waitFor(() => expect(sentinels[0]?.release).toHaveBeenCalledTimes(1));
    });

    it('waits for a visible page and requests again after the browser drops the lock', async () => {
        const wakeLock = new ScreenWakeLock();
        setVisibility('hidden');

        wakeLock.acquire();
        expect(request).not.toHaveBeenCalled();

        setVisibility('visible');
        wakeLock.handleVisibilityChange();
        await vi.waitFor(() => expect(sentinels).toHaveLength(1));

        sentinels[0].released = true;
        wakeLock.handleVisibilityChange();
        await vi.waitFor(() => expect(sentinels).toHaveLength(2));
    });

    it('does not request on visibility changes after release', () => {
        const wakeLock = new ScreenWakeLock();

        wakeLock.handleVisibilityChange();

        expect(request).not.toHaveBeenCalled();
    });

    it('ignores browsers without the Screen Wake Lock API and failed requests', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        request.mockRejectedValueOnce(new Error('NotAllowedError'));
        const wakeLock = new ScreenWakeLock();

        wakeLock.acquire();
        await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));

        Reflect.deleteProperty(navigator, 'wakeLock');
        expect(() => wakeLock.acquire()).not.toThrow();
        warn.mockRestore();
    });
});

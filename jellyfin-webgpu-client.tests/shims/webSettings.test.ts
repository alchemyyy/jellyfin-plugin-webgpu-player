import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchLocalMock = vi.hoisted(() => vi.fn());

vi.mock('utils/fetchLocal', () => ({ default: fetchLocalMock }));

type WebSettingsModule = typeof import('addons/webGPUPlayer/shims/webSettings');

function createResponse(body: unknown, ok = true): Response {
    return {
        json: () => Promise.resolve(body),
        ok
    } as Response;
}

/** Loads a fresh module, because the config.json lookup is cached for the page lifetime. */
async function loadWebSettings(): Promise<WebSettingsModule> {
    vi.resetModules();
    return import('addons/webGPUPlayer/shims/webSettings');
}

describe('webSettings shim', () => {
    beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    describe('getIncludeCorsCredentials', () => {
        it('fetches config.json once, bypassing the HTTP cache like the host', async () => {
            fetchLocalMock.mockResolvedValue(createResponse({ includeCorsCredentials: true }));
            const webSettings = await loadWebSettings();

            await expect(webSettings.getIncludeCorsCredentials()).resolves.toBe(true);
            await expect(webSettings.getIncludeCorsCredentials()).resolves.toBe(true);

            expect(fetchLocalMock).toHaveBeenCalledTimes(1);
            expect(fetchLocalMock).toHaveBeenCalledWith('config.json', { cache: 'no-store' });
        });

        it('falls back to the default configuration when config.json is unavailable', async () => {
            fetchLocalMock.mockResolvedValue(createResponse({}, false));
            await expect((await loadWebSettings()).getIncludeCorsCredentials()).resolves.toBe(false);

            fetchLocalMock.mockRejectedValue(new TypeError('Local request failed'));
            await expect((await loadWebSettings()).getIncludeCorsCredentials()).resolves.toBe(false);
        });

        it('treats a missing flag as disabled', async () => {
            fetchLocalMock.mockResolvedValue(createResponse({ multiserver: true }));

            await expect((await loadWebSettings()).getIncludeCorsCredentials()).resolves.toBe(false);
        });
    });
});

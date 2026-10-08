import { afterEach, describe, expect, it, vi } from 'vitest';

type BrowserFlags = {
    firefox?: boolean
    tizen?: boolean
    tizenVersion?: number
    web0sVersion?: number
};

const browserMock = vi.hoisted((): BrowserFlags => ({}));

vi.mock('scripts/browser', () => ({ default: browserMock }));

import buildDeviceProfile, { canPlaySecondaryAudio } from 'addons/webGPUPlayer/shims/browserDeviceProfile';

// jsdom defines audioTracks as a read-only getter, so a stand-in object carries the track list
function createVideoElement(withAudioTracks: boolean): HTMLVideoElement & { audioTracks?: unknown } {
    return { audioTracks: withAudioTracks ? [] : undefined } as unknown as HTMLVideoElement & { audioTracks?: unknown };
}

describe('browserDeviceProfile shim', () => {
    afterEach(() => {
        for (const flag of Object.keys(browserMock)) {
            delete browserMock[flag as keyof BrowserFlags];
        }
    });

    it('requires HTMLMediaElement.audioTracks', () => {
        expect(canPlaySecondaryAudio(createVideoElement(false))).toBe(false);
        expect(canPlaySecondaryAudio(createVideoElement(true))).toBe(true);
    });

    it('excludes Firefox, which exposes only the first track', () => {
        browserMock.firefox = true;

        expect(canPlaySecondaryAudio(createVideoElement(true))).toBe(false);
    });

    it('allows Tizen from 5.5 up to, but not including, 8', () => {
        browserMock.tizen = true;
        for (const [ tizenVersion, expected ] of [ [ 5, false ], [ 5.5, true ], [ 7, true ], [ 8, false ] ] as const) {
            browserMock.tizenVersion = tizenVersion;
            expect(canPlaySecondaryAudio(createVideoElement(true))).toBe(expected);
        }
    });

    it('requires webOS 4 or later', () => {
        browserMock.web0sVersion = 3;
        expect(canPlaySecondaryAudio(createVideoElement(true))).toBe(false);
        browserMock.web0sVersion = 4;
        expect(canPlaySecondaryAudio(createVideoElement(true))).toBe(true);
    });

    it('never builds a profile, because appHost.getDeviceProfile supplies it', () => {
        expect(() => buildDeviceProfile()).toThrow('appHost.getDeviceProfile');
    });
});

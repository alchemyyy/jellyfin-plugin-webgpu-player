import { describe, expect, it } from 'vitest';

import {
    normalizeVideoPlayerPreference,
    VideoPlayerPreference
} from 'addons/webGPUPlayer/PreferredVideoPlayer';

describe('PreferredVideoPlayer', () => {
    it.each([
        VideoPlayerPreference.Auto,
        VideoPlayerPreference.HTML,
        VideoPlayerPreference.WEBGPU
    ])('preserves supported preference %s', preference => {
        expect(normalizeVideoPlayerPreference(preference)).toBe(preference);
    });

    it.each([ undefined, null, '', 'native', 1 ])(
        'normalizes unsupported preference %s to auto',
        preference => {
            expect(normalizeVideoPlayerPreference(preference)).toBe(VideoPlayerPreference.Auto);
        }
    );
});

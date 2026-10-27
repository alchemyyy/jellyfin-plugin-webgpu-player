import { describe, expect, it } from 'vitest';

import { createCompatibleProfiles } from 'addons/webGPUPlayer/custom/CustomDeviceProfile';

const AVI_CONTAINER = 'avi';
const AIFF_CONTAINER = 'aiff';
const TRANSPORT_STREAM_CONTAINERS = 'ts,m2ts,mts';
const SUPPORTED_VIDEO_CODECS = [ 'h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg2video' ] as const;
const SUPPORTED_AUDIO_CODECS = [ 'aac', 'mp3', 'ac3', 'eac3', 'flac', 'vorbis', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'pcm_alaw' ] as const;

describe('the direct-play containers of the custom path', () => {
    it('advertises AVI with the codecs the fork\'s AVI demuxer and the engine\'s routes play', () => {
        const profiles = createCompatibleProfiles(SUPPORTED_VIDEO_CODECS, SUPPORTED_AUDIO_CODECS);

        expect(profiles).toContainEqual({
            AudioCodec: 'aac,mp3,ac3,flac,vorbis,pcm_s16le,pcm_s24le,pcm_f32le,pcm_alaw',
            Container: AVI_CONTAINER,
            Type: 'Video',
            VideoCodec: 'h264,hevc,vp8,vp9,av1'
        });
    });

    it('keeps MPEG-2 and E-AC-3 out of AVI', () => {
        const aviProfiles = createCompatibleProfiles(SUPPORTED_VIDEO_CODECS, SUPPORTED_AUDIO_CODECS)
            .filter(profile => profile.Container === AVI_CONTAINER);

        expect(aviProfiles).toHaveLength(1);
        const [ aviProfile ] = aviProfiles;
        expect(aviProfile.VideoCodec?.split(',')).not.toContain('mpeg2video');
        expect(aviProfile.AudioCodec?.split(',')).not.toContain('eac3');
    });

    it('advertises MPEG-1, MPEG-2, and VC-1 in MPEG-TS and M2TS, which the fork demuxes', () => {
        const profiles = createCompatibleProfiles([ 'h264', 'mpeg1video', 'mpeg2video', 'vc1', 'wmv3' ], [ 'ac3', 'mp3' ]);

        expect(profiles).toContainEqual({
            AudioCodec: 'mp3,ac3',
            Container: TRANSPORT_STREAM_CONTAINERS,
            Type: 'Video',
            VideoCodec: 'h264,mpeg1video,mpeg2video,vc1'
        });
    });

    it('advertises no AIFF, since the custom path plays only items with video', () => {
        const profiles = createCompatibleProfiles(SUPPORTED_VIDEO_CODECS, SUPPORTED_AUDIO_CODECS);

        expect(profiles.some(profile => profile.Container?.split(',').includes(AIFF_CONTAINER))).toBe(false);
    });
});

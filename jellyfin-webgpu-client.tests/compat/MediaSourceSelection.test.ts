import type { MediaSourceInfo } from '@jellyfin/sdk/lib/generated-client/models/media-source-info';
import { describe, expect, it, vi } from 'vitest';

import {
    selectOptimalMediaSource,
    supportsDirectPlay,
    type DirectPlayEnvironment,
    type EndpointInfo
} from 'addons/webGPUPlayer/compat/MediaSourceSelection';

function createEnvironment(endpointInfo: EndpointInfo = { IsInNetwork: true, IsLocal: true }, supportsRemoteVideo = true): DirectPlayEnvironment {
    return {
        getEndpointInfo: vi.fn(() => Promise.resolve(endpointInfo)),
        supportsRemoteVideo
    };
}

function createHTTPSource(overrides: Partial<MediaSourceInfo> = {}): MediaSourceInfo {
    return {
        Id: 'source',
        Path: 'https://media.example/video.mkv',
        Protocol: 'Http',
        RequiredHttpHeaders: {},
        SupportsDirectPlay: true,
        SupportsDirectStream: true,
        SupportsTranscoding: true,
        ...overrides
    };
}

describe('supportsDirectPlay', () => {
    it('rejects sources the server does not direct play', async () => {
        await expect(supportsDirectPlay(createHTTPSource({ SupportsDirectPlay: false }), createEnvironment()))
            .resolves.toBe(false);
    });

    it('rejects file sources, which play through the static stream URL instead', async () => {
        await expect(supportsDirectPlay(createHTTPSource({ Protocol: 'File' }), createEnvironment()))
            .resolves.toBe(false);
    });

    it('rejects remote sources when the host cannot play remote video', async () => {
        await expect(supportsDirectPlay(createHTTPSource({ IsRemote: true }), createEnvironment(undefined, false)))
            .resolves.toBe(false);
    });

    it('rejects sources that need request headers', async () => {
        const headers = [ 'Referer' ] as unknown as MediaSourceInfo['RequiredHttpHeaders'];
        await expect(supportsDirectPlay(createHTTPSource({ RequiredHttpHeaders: headers }), createEnvironment()))
            .resolves.toBe(false);
    });

    it('allows an HTTP source that can only direct play without asking for the endpoint', async () => {
        const environment = createEnvironment();

        await expect(supportsDirectPlay(
            createHTTPSource({ SupportsDirectStream: false, SupportsTranscoding: false }),
            environment
        )).resolves.toBe(true);
        expect(environment.getEndpointInfo).not.toHaveBeenCalled();
    });

    it('allows remote sources without checking the endpoint', async () => {
        const environment = createEnvironment({ IsInNetwork: false });

        await expect(supportsDirectPlay(createHTTPSource({ IsRemote: true }), environment)).resolves.toBe(true);
        expect(environment.getEndpointInfo).not.toHaveBeenCalled();
    });

    it('requires an in-network connection for local sources', async () => {
        await expect(supportsDirectPlay(createHTTPSource(), createEnvironment({ IsInNetwork: false })))
            .resolves.toBe(false);
        await expect(supportsDirectPlay(createHTTPSource(), createEnvironment({ IsInNetwork: true, IsLocal: true })))
            .resolves.toBe(true);
    });

    it('rejects loopback paths unless the client runs on the server machine', async () => {
        const loopbackSource = createHTTPSource({ Path: 'http://127.0.0.1/video.mkv' });

        await expect(supportsDirectPlay(loopbackSource, createEnvironment({ IsInNetwork: true, IsLocal: false })))
            .resolves.toBe(false);
        await expect(supportsDirectPlay(loopbackSource, createEnvironment({ IsInNetwork: true, IsLocal: true })))
            .resolves.toBe(true);
    });

    it('evaluates folder rips even when the server did not offer direct play', async () => {
        await expect(supportsDirectPlay(
            createHTTPSource({ SupportsDirectPlay: false, VideoType: 'BluRay' }),
            createEnvironment()
        )).resolves.toBe(true);
    });
});

describe('selectOptimalMediaSource', () => {
    const environment = createEnvironment();

    it('returns null without sources', async () => {
        await expect(selectOptimalMediaSource('item', [], environment)).resolves.toBeNull();
    });

    it('prefers the played item own source even when it must transcode', async () => {
        const ownSource = createHTTPSource({
            Id: 'item',
            Protocol: 'File',
            SupportsDirectPlay: false,
            SupportsDirectStream: false
        });
        const otherVersion = createHTTPSource({ Id: 'version' });

        const selection = await selectOptimalMediaSource('item', [ otherVersion, ownSource ], environment);

        expect(selection).toEqual({ enableDirectPlay: false, mediaSource: ownSource });
    });

    it('falls back to direct play, then direct stream, then transcoding, then the first source', async () => {
        const transcodeOnly = createHTTPSource({
            Id: 'transcode',
            Protocol: 'File',
            SupportsDirectPlay: false,
            SupportsDirectStream: false
        });
        const directStream = createHTTPSource({ Id: 'stream', Protocol: 'File', SupportsDirectPlay: false });
        const directPlay = createHTTPSource({ Id: 'direct' });
        const unplayable = createHTTPSource({
            Id: 'unplayable',
            Protocol: 'File',
            SupportsDirectPlay: false,
            SupportsDirectStream: false,
            SupportsTranscoding: false
        });

        await expect(selectOptimalMediaSource('item', [ transcodeOnly, directStream, directPlay ], environment))
            .resolves.toEqual({ enableDirectPlay: true, mediaSource: directPlay });
        await expect(selectOptimalMediaSource('item', [ transcodeOnly, directStream ], environment))
            .resolves.toEqual({ enableDirectPlay: false, mediaSource: directStream });
        await expect(selectOptimalMediaSource('item', [ unplayable, transcodeOnly ], environment))
            .resolves.toEqual({ enableDirectPlay: false, mediaSource: transcodeOnly });
        await expect(selectOptimalMediaSource('item', [ unplayable ], environment))
            .resolves.toEqual({ enableDirectPlay: false, mediaSource: unplayable });
    });
});

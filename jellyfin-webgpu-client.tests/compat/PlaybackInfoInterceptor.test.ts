import axios, { type AxiosAdapter, type AxiosInstance, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlaybackBitrateRequest } from 'addons/webGPUPlayer/compat/PlaybackBitratePolicy';
import type { PlaybackInfoRequestBody } from 'addons/webGPUPlayer/compat/PlaybackInfoPolicy';

const appHostMock = vi.hoisted(() => ({
    supports: vi.fn((): boolean => true)
}));
const serverConnectionsMock = vi.hoisted(() => ({
    getApi: vi.fn(),
    getApiClient: vi.fn()
}));

vi.mock('components/apphost', () => ({ appHost: appHostMock }));
vi.mock('lib/jellyfin-apiclient', () => ({ ServerConnections: serverConnectionsMock }));

import {
    ensurePlaybackInfoInterceptors,
    markPlaybackInfoNegotiation,
    NEGOTIATION_MARKER_PROPERTY,
    takePlaybackInfoNegotiation,
    type NegotiationItem,
    type NegotiationPlayer
} from 'addons/webGPUPlayer/compat/PlaybackInfoInterceptor';

const DETECTED_BITRATE = 20_000_000;
const PLAYBACK_INFO_URL = 'https://server.example/jellyfin/Items/item/PlaybackInfo?userId=user';
const DOLBY_VISION_STREAM = { Type: 'Video', VideoRangeType: 'DOVI' };
const SDR_STREAM = { Type: 'Video', VideoRangeType: 'SDR' };

type CapturedRequest = {
    body: PlaybackInfoRequestBody
    url: string | undefined
};

type ApiClientMock = {
    getCurrentUserId: () => string
    getEndpointInfo: () => Promise<{ IsInNetwork: boolean, IsLocal: boolean }>
    getItem: ReturnType<typeof vi.fn>
};

function hasDolbyVision(mediaStreams: unknown): boolean {
    return Array.isArray(mediaStreams)
        && mediaStreams.some((stream: { VideoRangeType?: string }) => stream.VideoRangeType === 'DOVI');
}

// Mirrors the WebGPU player's bitrate and stream-copy rules
function createPlayer(overrides: Partial<NegotiationPlayer> = {}): NegotiationPlayer {
    return {
        getMaxStreamingBitrate: (bitrateRequest?: PlaybackBitrateRequest): number | null => (
            bitrateRequest?.purpose === 'transcode-output' ? bitrateRequest.fallbackBitrate ?? null : null
        ),
        streamInfo: null,
        supportsVideoStreamCopy: (_item: unknown, _mediaSourceId: string | null | undefined, mediaStreams: unknown): boolean => (
            !hasDolbyVision(mediaStreams)
        ),
        ...overrides
    };
}

function createApiClient(): ApiClientMock {
    return {
        getCurrentUserId: () => 'user',
        getEndpointInfo: () => Promise.resolve({ IsInNetwork: true, IsLocal: true }),
        getItem: vi.fn(() => Promise.resolve({ MediaStreams: [ SDR_STREAM ] }))
    };
}

function createTranscodeOnlySource(id = 'item'): Record<string, unknown> {
    return {
        Id: id,
        Protocol: 'File',
        SupportsDirectPlay: false,
        SupportsDirectStream: false,
        SupportsTranscoding: true,
        TranscodingUrl: '/videos/item/master.m3u8'
    };
}

/** Creates an axios instance whose adapter records requests and answers with queued PlaybackInfo bodies. */
function createRecordingInstance(responseBodies: unknown[]): { instance: AxiosInstance, requests: CapturedRequest[] } {
    const requests: CapturedRequest[] = [];
    const adapter: AxiosAdapter = (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
        const body = typeof config.data === 'string' ? JSON.parse(config.data) as PlaybackInfoRequestBody : {};
        requests.push({ body, url: config.url });
        return Promise.resolve({
            config,
            data: responseBodies.shift(),
            headers: {},
            status: 200,
            statusText: 'OK'
        });
    };
    return { instance: axios.create({ adapter }), requests };
}

function postPlaybackInfo(instance: AxiosInstance, body: PlaybackInfoRequestBody): Promise<AxiosResponse> {
    return instance.request({
        data: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
        url: PLAYBACK_INFO_URL
    });
}

describe('markPlaybackInfoNegotiation', () => {
    it('marks a copy of the profile and leaves the returned profile untouched', () => {
        const profile = { Name: 'stock' };

        const markedProfile = markPlaybackInfoNegotiation(profile, createPlayer(), { Id: 'item' }, undefined);

        expect(markedProfile).not.toBe(profile);
        expect(markedProfile).toMatchObject({ Name: 'stock' });
        expect(typeof (markedProfile as Record<string, unknown>)[NEGOTIATION_MARKER_PROPERTY]).toBe('string');
        expect(profile).toEqual({ Name: 'stock' });
    });

    it('passes non-object profiles through', () => {
        expect(markPlaybackInfoNegotiation(null, createPlayer(), {}, undefined)).toBeNull();
    });
});

describe('takePlaybackInfoNegotiation', () => {
    it('ignores bodies without the marker', () => {
        const body: PlaybackInfoRequestBody = { DeviceProfile: { Name: 'stock' } };

        expect(takePlaybackInfoNegotiation(body)).toBeUndefined();
        expect(body.DeviceProfile).toEqual({ Name: 'stock' });
    });

    it('strips the marker and returns the tracked negotiation', () => {
        const player = createPlayer();
        const item: NegotiationItem = { Id: 'item' };
        const body: PlaybackInfoRequestBody = {
            DeviceProfile: markPlaybackInfoNegotiation({ Name: 'stock' }, player, item, { isRetry: false })
        };

        expect(takePlaybackInfoNegotiation(body)).toEqual({ item, player, purpose: 'stream-change' });
        expect(body.DeviceProfile).toEqual({ Name: 'stock' });
    });

    it('strips an expired marker without returning a negotiation', () => {
        const expiredProfile = markPlaybackInfoNegotiation({ Name: 'stock' }, createPlayer(), {}, undefined);
        for (let index = 0; index < 40; index += 1) {
            markPlaybackInfoNegotiation({}, createPlayer(), {}, undefined);
        }
        const body: PlaybackInfoRequestBody = { DeviceProfile: expiredProfile };

        expect(takePlaybackInfoNegotiation(body)).toBeNull();
        expect(body.DeviceProfile).toEqual({ Name: 'stock' });
    });
});

describe('ensurePlaybackInfoInterceptors', () => {
    beforeEach(() => {
        serverConnectionsMock.getApi.mockReset();
        serverConnectionsMock.getApiClient.mockReset();
    });

    it('installs the interceptors once per axios instance', () => {
        const instance = axios.create();
        serverConnectionsMock.getApi.mockReturnValue({ axiosInstance: instance });
        const requestUse = vi.spyOn(instance.interceptors.request, 'use');
        const responseUse = vi.spyOn(instance.interceptors.response, 'use');

        expect(ensurePlaybackInfoInterceptors('server')).toBe(true);
        expect(ensurePlaybackInfoInterceptors('server')).toBe(true);

        expect(serverConnectionsMock.getApi).toHaveBeenCalledWith('server');
        expect(requestUse).toHaveBeenCalledTimes(1);
        expect(responseUse).toHaveBeenCalledTimes(1);
    });

    it('reports hosts without an SDK axios instance', () => {
        serverConnectionsMock.getApi.mockReturnValue(undefined);

        expect(ensurePlaybackInfoInterceptors('server')).toBe(false);
    });
});

describe('PlaybackInfo interception through axios', () => {
    let apiClient: ApiClientMock;

    beforeEach(() => {
        apiClient = createApiClient();
        serverConnectionsMock.getApiClient.mockReturnValue(apiClient);
        appHostMock.supports.mockReturnValue(true);
    });

    function install(responseBodies: unknown[]): { instance: AxiosInstance, requests: CapturedRequest[] } {
        const recording = createRecordingInstance(responseBodies);
        serverConnectionsMock.getApi.mockReturnValue({ axiosInstance: recording.instance });
        expect(ensurePlaybackInfoInterceptors('server')).toBe(true);
        return recording;
    }

    it('leaves requests the WebGPU player did not negotiate untouched', async () => {
        const { instance, requests } = install([ { MediaSources: [ createTranscodeOnlySource() ] } ]);

        await postPlaybackInfo(instance, {
            DeviceProfile: { Name: 'stock' },
            IsPlayback: true,
            MaxStreamingBitrate: DETECTED_BITRATE
        });

        expect(requests).toHaveLength(1);
        expect(requests[0].body).toEqual({
            DeviceProfile: { Name: 'stock' },
            IsPlayback: true,
            MaxStreamingBitrate: DETECTED_BITRATE
        });
    });

    it('selects without bitrate, then sizes the transcode the server decided', async () => {
        const sizedPlaybackInfo = { MediaSources: [ createTranscodeOnlySource() ], PlaySessionId: 'second' };
        const { instance, requests } = install([
            { MediaSources: [ createTranscodeOnlySource() ], PlaySessionId: 'first' },
            sizedPlaybackInfo
        ]);
        const item: NegotiationItem = { Id: 'item', MediaStreams: [ SDR_STREAM ], ServerId: 'server' };

        const response = await postPlaybackInfo(instance, {
            DeviceProfile: markPlaybackInfoNegotiation({ Name: 'webgpu' }, createPlayer(), item, undefined),
            IsPlayback: true,
            MaxStreamingBitrate: DETECTED_BITRATE,
            StartTimeTicks: 0
        });

        expect(requests).toHaveLength(2);
        expect(requests[0].body).toEqual({
            DeviceProfile: { Name: 'webgpu' },
            IsPlayback: true,
            StartTimeTicks: 0
        });
        expect(requests[1].url).toBe(PLAYBACK_INFO_URL);
        expect(requests[1].body).toEqual({
            DeviceProfile: { Name: 'webgpu' },
            EnableDirectPlay: false,
            EnableDirectStream: false,
            IsPlayback: true,
            MaxStreamingBitrate: DETECTED_BITRATE,
            MediaSourceId: 'item',
            StartTimeTicks: 0
        });
        expect(response.data).toBe(sizedPlaybackInfo);
        // Item streams were known, so no source item was fetched for the stream-copy check
        expect(apiClient.getItem).not.toHaveBeenCalled();
    });

    it('does not re-issue when the server keeps direct play or reports an error', async () => {
        const directPlaySource = { ...createTranscodeOnlySource(), SupportsDirectPlay: true, SupportsDirectStream: true };
        const { instance, requests } = install([
            { MediaSources: [ directPlaySource ] },
            { ErrorCode: 'NoCompatibleStream', MediaSources: [] }
        ]);
        const item: NegotiationItem = { Id: 'item', MediaStreams: [ SDR_STREAM ], ServerId: 'server' };

        await postPlaybackInfo(instance, {
            DeviceProfile: markPlaybackInfoNegotiation({}, createPlayer(), item, undefined),
            IsPlayback: true,
            MaxStreamingBitrate: DETECTED_BITRATE
        });
        const errorResponse = await postPlaybackInfo(instance, {
            DeviceProfile: markPlaybackInfoNegotiation({}, createPlayer(), item, undefined),
            IsPlayback: true,
            MaxStreamingBitrate: DETECTED_BITRATE
        });

        expect(requests).toHaveLength(2);
        expect(errorResponse.data).toEqual({ ErrorCode: 'NoCompatibleStream', MediaSources: [] });
    });

    it('does not size sources that must be opened, which keep the stock live stream path', async () => {
        const { instance, requests } = install([
            { MediaSources: [ { ...createTranscodeOnlySource(), RequiresOpening: true } ] }
        ]);

        await postPlaybackInfo(instance, {
            DeviceProfile: markPlaybackInfoNegotiation({}, createPlayer(), { Id: 'item', ServerId: 'server' }, undefined),
            IsPlayback: true,
            MaxStreamingBitrate: DETECTED_BITRATE
        });

        expect(requests).toHaveLength(1);
    });

    it('fetches the source item streams to veto Dolby Vision stream copy on first play', async () => {
        apiClient.getItem.mockResolvedValue({ MediaStreams: [ DOLBY_VISION_STREAM ] });
        const { instance, requests } = install([ { MediaSources: [] } ]);

        await postPlaybackInfo(instance, {
            DeviceProfile: markPlaybackInfoNegotiation({}, createPlayer(), { Id: 'item', ServerId: 'server' }, undefined),
            IsPlayback: true,
            MediaSourceId: 'version'
        });

        expect(apiClient.getItem).toHaveBeenCalledWith('user', 'version');
        expect(requests[0].body.AllowVideoStreamCopy).toBe(false);
    });

    it('uses known version streams for the veto without fetching', async () => {
        const { instance, requests } = install([ { MediaSources: [] } ]);
        const item: NegotiationItem = {
            Id: 'item',
            MediaSources: [ { Id: 'version', MediaStreams: [ DOLBY_VISION_STREAM ] } ],
            ServerId: 'server'
        };

        await postPlaybackInfo(instance, {
            DeviceProfile: markPlaybackInfoNegotiation({}, createPlayer(), item, undefined),
            IsPlayback: true,
            MediaSourceId: 'version'
        });

        expect(apiClient.getItem).not.toHaveBeenCalled();
        expect(requests[0].body.AllowVideoStreamCopy).toBe(false);
    });

    it('allows stream copy for live TV channels without fetching, as the fork did', async () => {
        const { instance, requests } = install([ { MediaSources: [] } ]);

        await postPlaybackInfo(instance, {
            DeviceProfile: markPlaybackInfoNegotiation({}, createPlayer(), { Id: 'channel', ServerId: 'server', Type: 'TvChannel' }, undefined),
            IsPlayback: true
        });

        expect(apiClient.getItem).not.toHaveBeenCalled();
        expect(requests[0].body).not.toHaveProperty('AllowVideoStreamCopy');
    });

    it('keeps a running Dolby Vision transcode a transcode without video stream copy', async () => {
        const { instance, requests } = install([ { MediaSources: [] } ]);
        const player = createPlayer({
            streamInfo: {
                mediaSource: { MediaStreams: [ DOLBY_VISION_STREAM ] },
                playMethod: 'Transcode'
            }
        });

        await postPlaybackInfo(instance, {
            AudioStreamIndex: 3,
            DeviceProfile: markPlaybackInfoNegotiation({}, player, { Id: 'item', ServerId: 'server' }, { isRetry: false }),
            IsPlayback: true,
            MaxStreamingBitrate: DETECTED_BITRATE,
            MediaSourceId: 'item'
        });

        expect(requests).toHaveLength(1);
        expect(requests[0].body).toEqual({
            AllowVideoStreamCopy: false,
            AudioStreamIndex: 3,
            DeviceProfile: {},
            EnableDirectPlay: false,
            EnableDirectStream: false,
            IsPlayback: true,
            MaxStreamingBitrate: DETECTED_BITRATE,
            MediaSourceId: 'item'
        });
    });

    it('ignores other endpoints and methods', async () => {
        const { instance, requests } = install([ {}, {} ]);
        const markedProfile = markPlaybackInfoNegotiation({}, createPlayer(), { Id: 'item' }, undefined);
        const body = JSON.stringify({ DeviceProfile: markedProfile, MaxStreamingBitrate: DETECTED_BITRATE });

        await instance.request({ data: body, method: 'POST', url: 'https://server.example/Sessions/Playing' });
        await instance.request({ method: 'GET', url: PLAYBACK_INFO_URL });

        expect(requests[0].body).toEqual(JSON.parse(body));
    });
});

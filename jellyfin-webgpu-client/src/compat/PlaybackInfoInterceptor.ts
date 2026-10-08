import type { PlaybackInfoResponse } from '@jellyfin/sdk/lib/generated-client/models/playback-info-response';
import type { AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from 'axios';

import { appHost } from 'components/apphost';
import { AppFeature } from 'constants/appFeature';
import { ServerConnections } from 'lib/jellyfin-apiclient';

import {
    selectOptimalMediaSource,
    type DirectPlayEnvironment,
    type MediaSourceSelection
} from './MediaSourceSelection';
import {
    applyPlaybackInfoRequestPolicy,
    createTranscodeSizingRequestBody,
    getPlaybackInfoNegotiationPurpose,
    needsTranscodeSizingRequest,
    PlaybackInfoNegotiationPurpose,
    type NegotiatingPlayer,
    type PlaybackInfoRequestBody,
    type TranscodeSizingRequest
} from './PlaybackInfoPolicy';
import { shouldAllowVideoStreamCopy } from './PlaybackStreamCopyPolicy';

// Applies the WebGPU player's negotiation rules to the stock PlaybackManager's PlaybackInfo requests.
// The SDK posts PlaybackInfo through the global axios instance, and getDeviceProfile runs before every
// request, so a marker in the returned device profile identifies the requests this player negotiates
// NOTE: LiveStreams/Open goes through apiClient.ajax, not axios, and keeps the stock behavior

/** DeviceProfile property that carries the negotiation token; it is removed before the request is sent */
export const NEGOTIATION_MARKER_PROPERTY = 'WebGPUPlayerNegotiation';

const MAXIMUM_TRACKED_NEGOTIATIONS = 32;
const PLAYBACK_INFO_PATH_PATTERN = /\/Items\/[^/?#]+\/PlaybackInfo(?:[?#]|$)/i;
const POST_METHOD = 'post';
const LIVE_TV_ITEM_TYPES = new Set([ 'TvChannel', 'LiveTvChannel' ]);

/** Media source fields the stream-copy check reads from a queued item */
type NegotiationMediaSource = {
    Id?: string | null
    MediaStreams?: unknown[] | null
};

/** Item fields the negotiation rules read */
export type NegotiationItem = {
    Id?: string | null
    MediaSources?: NegotiationMediaSource[] | null
    MediaStreams?: unknown[] | null
    ServerId?: string | null
    Type?: string | null
};

/** Player members the negotiation rules read; streamInfo is written by the stock PlaybackManager */
export type NegotiationPlayer = NegotiatingPlayer & {
    streamInfo?: {
        mediaSource?: { MediaStreams?: unknown } | null
        playMethod?: string | null
    } | null
    supportsVideoStreamCopy?: (item: unknown, mediaSourceId: string | null | undefined, mediaStreams: unknown) => boolean
};

type NegotiationRecord = Readonly<{
    item: NegotiationItem
    player: NegotiationPlayer
    purpose: PlaybackInfoNegotiationPurpose
}>;

type TranscodeSizingFollowUp = TranscodeSizingRequest & Readonly<{
    itemId: string | null | undefined
    serverId: string | null | undefined
}>;

type NegotiatedRequestConfig = InternalAxiosRequestConfig & {
    webGPUPlayerTranscodeSizing?: TranscodeSizingFollowUp
};

type DeviceProfileRecord = Record<string, unknown>;

const negotiations = new Map<string, NegotiationRecord>();
const installedAxiosInstances = new WeakSet<AxiosInstance>();
let negotiationSequence = 0;

/** Tags a device profile copy so its PlaybackInfo request can be matched to this negotiation. */
export function markPlaybackInfoNegotiation<Profile>(
    profile: Profile,
    player: NegotiationPlayer,
    item: NegotiationItem,
    deviceProfileOptions: unknown
): Profile {
    if (!profile || typeof profile !== 'object') {
        return profile;
    }

    negotiationSequence += 1;
    const token = `webgpu-negotiation-${negotiationSequence}`;
    negotiations.set(token, {
        item,
        player,
        purpose: getPlaybackInfoNegotiationPurpose(deviceProfileOptions)
    });
    // Profiles fetched only for capability checks never reach a request, so old entries expire
    while (negotiations.size > MAXIMUM_TRACKED_NEGOTIATIONS) {
        const oldestToken = negotiations.keys().next().value;
        if (oldestToken === undefined) {
            break;
        }
        negotiations.delete(oldestToken);
    }
    // The host may reuse the profile it returned, so only a copy carries the marker
    return { ...profile, [NEGOTIATION_MARKER_PROPERTY]: token };
}

/** Removes the marker from a request body and returns its negotiation, if it is still tracked. */
export function takePlaybackInfoNegotiation(body: PlaybackInfoRequestBody): NegotiationRecord | null | undefined {
    const deviceProfile = body.DeviceProfile as DeviceProfileRecord | null | undefined;
    if (!deviceProfile || typeof deviceProfile !== 'object' || !(NEGOTIATION_MARKER_PROPERTY in deviceProfile)) {
        // Undefined: the request was not negotiated by the WebGPU player
        return undefined;
    }

    const token = deviceProfile[NEGOTIATION_MARKER_PROPERTY];
    const unmarkedProfile: DeviceProfileRecord = { ...deviceProfile };
    delete unmarkedProfile[NEGOTIATION_MARKER_PROPERTY];
    body.DeviceProfile = unmarkedProfile as PlaybackInfoRequestBody['DeviceProfile'];
    return typeof token === 'string' ? negotiations.get(token) ?? null : null;
}

function isPlaybackInfoRequest(config: InternalAxiosRequestConfig): boolean {
    return (config.method || '').toLowerCase() === POST_METHOD
        && typeof config.url === 'string'
        && PLAYBACK_INFO_PATH_PATTERN.test(config.url);
}

function parseRequestBody(data: unknown): PlaybackInfoRequestBody | null {
    if (typeof data === 'string') {
        try {
            const parsed: unknown = JSON.parse(data);
            return parsed && typeof parsed === 'object' ? parsed as PlaybackInfoRequestBody : null;
        } catch {
            return null;
        }
    }
    return data && typeof data === 'object' ? { ...(data as PlaybackInfoRequestBody) } : null;
}

function getApiClient(serverId: string | null | undefined): ReturnType<typeof ServerConnections.getApiClient> | null {
    return serverId ? ServerConnections.getApiClient(serverId) ?? null : null;
}

function findMediaSourceStreams(item: NegotiationItem, mediaSourceId: string): unknown[] | null {
    const mediaSource = item.MediaSources?.find(source => source.Id === mediaSourceId);
    if (Array.isArray(mediaSource?.MediaStreams)) {
        return mediaSource.MediaStreams;
    }
    return mediaSourceId === item.Id && Array.isArray(item.MediaStreams) ? item.MediaStreams : null;
}

/**
 * Returns the streams the fork's PlaybackManager passed to the stream-copy veto:
 * the playing source for stream changes, and the fetched source item for playback.
 */
async function getVetoMediaStreams(
    record: NegotiationRecord,
    body: PlaybackInfoRequestBody
): Promise<unknown[] | undefined> {
    if (record.purpose === PlaybackInfoNegotiationPurpose.StreamChange) {
        const mediaStreams = record.player.streamInfo?.mediaSource?.MediaStreams;
        return Array.isArray(mediaStreams) ? mediaStreams : undefined;
    }
    if (body.IsPlayback !== true) {
        return undefined;
    }
    if (LIVE_TV_ITEM_TYPES.has(record.item.Type ?? '')) {
        return [];
    }

    const sourceItemId = body.MediaSourceId || record.item.Id;
    if (!sourceItemId) {
        return [];
    }
    const knownStreams = findMediaSourceStreams(record.item, sourceItemId);
    if (knownStreams) {
        return knownStreams;
    }

    // Queued items usually lack streams; PlaybackManager fetches the same source item for playback
    const apiClient = getApiClient(record.item.ServerId);
    if (!apiClient) {
        return [];
    }
    try {
        const sourceItem = await apiClient.getItem(apiClient.getCurrentUserId(), sourceItemId);
        return Array.isArray(sourceItem?.MediaStreams) ? sourceItem.MediaStreams : [];
    } catch (error) {
        console.warn('[WebGPUPlayer] unable to load source streams for the stream-copy check', error);
        return [];
    }
}

/** Rewrites a marked PlaybackInfo request with the WebGPU player's negotiation rules. */
export async function interceptPlaybackInfoRequest(
    config: InternalAxiosRequestConfig
): Promise<InternalAxiosRequestConfig> {
    if (!isPlaybackInfoRequest(config)) {
        return config;
    }
    const body = parseRequestBody(config.data);
    if (!body) {
        return config;
    }
    const record = takePlaybackInfoNegotiation(body);
    if (record === undefined) {
        return config;
    }
    if (record === null) {
        // An expired negotiation still must not leak its marker
        config.data = JSON.stringify(body);
        return config;
    }

    const vetoMediaStreams = await getVetoMediaStreams(record, body);
    const decision = applyPlaybackInfoRequestPolicy(body, {
        allowVideoStreamCopy: shouldAllowVideoStreamCopy(
            record.player,
            record.item,
            body.MediaSourceId,
            vetoMediaStreams
        ),
        currentPlayMethod: record.player.streamInfo?.playMethod,
        player: record.player,
        purpose: record.purpose
    });
    config.data = JSON.stringify(decision.body);
    if (decision.transcodeSizing) {
        (config as NegotiatedRequestConfig).webGPUPlayerTranscodeSizing = {
            ...decision.transcodeSizing,
            itemId: record.item.Id,
            serverId: record.item.ServerId
        };
    }
    return config;
}

function createDirectPlayEnvironment(serverId: string | null | undefined): DirectPlayEnvironment | null {
    const apiClient = getApiClient(serverId);
    if (!apiClient) {
        return null;
    }
    return {
        getEndpointInfo: () => apiClient.getEndpointInfo(),
        supportsRemoteVideo: appHost.supports(AppFeature.RemoteVideo)
    };
}

/**
 * Sizes a transcode that a bitrate-free first selection fixed: like the fork's PlaybackManager,
 * it re-issues the request once with the original bitrate and returns that response instead.
 */
export async function interceptPlaybackInfoResponse(
    axiosInstance: AxiosInstance,
    response: AxiosResponse<PlaybackInfoResponse>
): Promise<AxiosResponse<PlaybackInfoResponse>> {
    const config = response.config as NegotiatedRequestConfig;
    const sizing = config.webGPUPlayerTranscodeSizing;
    if (!sizing) {
        return response;
    }
    const playbackInfo = response.data;
    if (!playbackInfo || playbackInfo.ErrorCode || !Array.isArray(playbackInfo.MediaSources)) {
        return response;
    }
    const sentBody = parseRequestBody(config.data);
    const environment = createDirectPlayEnvironment(sizing.serverId);
    if (!sentBody || !environment) {
        return response;
    }

    let selection: MediaSourceSelection | null;
    try {
        selection = await selectOptimalMediaSource(sizing.itemId, playbackInfo.MediaSources, environment);
    } catch (error) {
        // PlaybackManager repeats the same selection and reports its failure
        console.warn('[WebGPUPlayer] unable to evaluate the selected media source', error);
        return response;
    }
    if (!selection || !needsTranscodeSizingRequest(sizing, selection)) {
        return response;
    }

    const sizedBody = createTranscodeSizingRequestBody(
        sentBody,
        selection.mediaSource.Id,
        sizing.transcodingBitrate
    );
    const sizedConfig: NegotiatedRequestConfig = {
        ...config,
        data: JSON.stringify(sizedBody),
        webGPUPlayerTranscodeSizing: undefined
    };
    return axiosInstance.request<PlaybackInfoResponse>(sizedConfig);
}

/** Installs the PlaybackInfo interceptors once per axios instance; returns whether they are active. */
export function ensurePlaybackInfoInterceptors(serverId: string | null | undefined): boolean {
    const getApi = (ServerConnections as { getApi?: (id?: string | null) => { axiosInstance?: AxiosInstance } | undefined }).getApi;
    if (typeof getApi !== 'function') {
        return false;
    }
    const axiosInstance = getApi.call(ServerConnections, serverId)?.axiosInstance;
    if (!axiosInstance?.interceptors) {
        return false;
    }
    if (!installedAxiosInstances.has(axiosInstance)) {
        installedAxiosInstances.add(axiosInstance);
        axiosInstance.interceptors.request.use(interceptPlaybackInfoRequest);
        axiosInstance.interceptors.response.use(
            (response: AxiosResponse): Promise<AxiosResponse> => interceptPlaybackInfoResponse(axiosInstance, response)
        );
    }
    return true;
}

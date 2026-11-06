import { resolvePlaybackMediaSource } from 'webgpu-player/capability/CustomPlaybackEligibility';
import type { CustomDecodeMediaSource } from 'webgpu-player/demux/CustomDecodeMediaSource';
import type { CustomDecodeSourcePrefetch } from 'webgpu-player/pipeline/CustomDecodeSession';

// Starts a direct play's first media range read while PlaybackManager still negotiates the playback, in the decode worker the playback then takes.
// The read is for the exact stream URL PlaybackManager builds when PlaybackInfo picks direct play of the item's file, and the engine's run continues on
// it only over that same URL; any other start, a stop, or a new request ends it

// Jellyfin's stream endpoint, whose cross-origin 206 responses hide Content-Range; the engine accepts them on a bounded Content-Length
const JELLYFIN_MEDIA_STREAM_PATH_PATTERN = /\/Videos\/[^/]+\/stream(?:\.[^/]+)?$/i;
const DIRECT_PLAY_METHOD = 'DirectPlay';
const FILE_PROTOCOL = 'File';
const VIDEO_MEDIA_TYPE = 'Video';
// Items that play a tuner's stream rather than a file
const LIVE_TV_ITEM_TYPES = new Set([ 'LiveTvChannel', 'Program', 'TvChannel' ]);
// Folder rips, which PlaybackManager may play from their own path
const FOLDER_RIP_VIDEO_TYPES = new Set([ 'BluRay', 'Dvd', 'HdDvd' ]);
const PLACEHOLDER_MEDIA_SOURCE_TYPE = 'Placeholder';

/** Media source fields the prediction reads, as Jellyfin's item and PlaybackInfo responses carry them */
type PredictedMediaSource = {
    Container?: string | null
    ETag?: string | null
    Id?: string | null
    IsInfiniteStream?: boolean | null
    IsRemote?: boolean | null
    LiveStreamId?: string | null
    Protocol?: string | null
    RequiresOpening?: boolean | null
    SupportsDirectPlay?: boolean | null
    Type?: string | null
    VideoType?: string | null
};

/** Item fields the prediction reads from the item PlaybackManager negotiates */
type PredictedItem = {
    Id?: string | null
    IsPlaceHolder?: boolean | null
    MediaSources?: PredictedMediaSource[] | null
    MediaType?: string | null
    Type?: string | null
};

/** The stream PlaybackManager hands the player: its URL, play method, item, and media source */
type PlayedStream = {
    item?: { Id?: string | null } | null
    mediaSource?: { ETag?: string | null, Id?: string | null, LiveStreamId?: string | null } | null
    playMethod?: string | null
    url?: string | null
};

/** The ApiClient members PlaybackManager's createStreamInfo builds a static stream URL with */
export type StreamURLBuilder = {
    accessToken: () => string | null | undefined
    deviceId: () => string | null | undefined
    getUrl: (name: string, params?: Record<string, unknown>) => string
};

/** The direct play a negotiation is predicted to pick, by the static stream URL PlaybackManager builds for it */
export type DirectPlayStreamPrediction = Readonly<{
    eTag: string | null
    itemId: string
    mediaSourceId: string
    url: string
}>;

/** Starts the engine's prefetch of a media source */
export type SourcePrefetcher = (source: CustomDecodeMediaSource) => CustomDecodeSourcePrefetch;

/** Returns the engine's media source for a Jellyfin stream URL, which a playback and the prefetch for it both name. */
export function createStreamURLSource(url: string): CustomDecodeMediaSource {
    return { hiddenContentRangePathPattern: JELLYFIN_MEDIA_STREAM_PATH_PATTERN, kind: 'url', url };
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

/** Returns the media source a negotiation picks without a choice of its own: the one the request names, or the item's only one. */
function selectPredictedMediaSource(item: PredictedItem, requestedMediaSourceId: string | null): PredictedMediaSource | null {
    const mediaSources = item.MediaSources;
    if (!Array.isArray(mediaSources)) {
        return null;
    }
    if (requestedMediaSourceId !== null) {
        return mediaSources.find((mediaSource: PredictedMediaSource): boolean => mediaSource.Id === requestedMediaSourceId) ?? null;
    }
    // Among several versions, PlaybackInfo's order and PlaybackManager's selection pick one
    return mediaSources.length === 1 ? mediaSources[0] : null;
}

/** Returns whether a media source is a file Jellyfin serves from a static stream, which PlaybackManager does not play from its own path. */
function isStaticFileMediaSource(mediaSource: PredictedMediaSource): boolean {
    return mediaSource.Protocol === FILE_PROTOCOL
        && mediaSource.SupportsDirectPlay === true
        && mediaSource.IsRemote !== true
        && mediaSource.RequiresOpening !== true
        && mediaSource.IsInfiniteStream !== true
        && !mediaSource.LiveStreamId
        && mediaSource.Type !== PLACEHOLDER_MEDIA_SOURCE_TYPE
        && !FOLDER_RIP_VIDEO_TYPES.has(mediaSource.VideoType ?? '');
}

/**
 * Predicts the static stream URL PlaybackManager's createStreamInfo builds when PlaybackInfo picks direct play of the item's file, built by the same
 * ApiClient with the same parameters in the same order.
 * Returns null for anything else: no video, live TV, a placeholder, several versions without one requested, or a source that is no local file.
 */
export function predictDirectPlayStream(
    itemValue: unknown,
    requestedMediaSourceId: string | null,
    apiClient: StreamURLBuilder
): DirectPlayStreamPrediction | null {
    if (!itemValue || typeof itemValue !== 'object') {
        return null;
    }
    const item = itemValue as PredictedItem;
    if (
        !isNonEmptyString(item.Id)
        || item.MediaType !== VIDEO_MEDIA_TYPE
        || item.IsPlaceHolder === true
        || LIVE_TV_ITEM_TYPES.has(item.Type ?? '')
    ) {
        return null;
    }
    const mediaSource = selectPredictedMediaSource(item, requestedMediaSourceId);
    if (!mediaSource || !isNonEmptyString(mediaSource.Id) || !isNonEmptyString(mediaSource.Container) || !isStaticFileMediaSource(mediaSource)) {
        return null;
    }

    const streamParameters: Record<string, unknown> = {
        Static: true,
        mediaSourceId: mediaSource.Id,
        deviceId: apiClient.deviceId(),
        ApiKey: apiClient.accessToken()
    };
    const eTag = isNonEmptyString(mediaSource.ETag) ? mediaSource.ETag : null;
    if (eTag !== null) {
        streamParameters.Tag = eTag;
    }
    return {
        eTag,
        itemId: item.Id,
        mediaSourceId: mediaSource.Id,
        url: apiClient.getUrl(`Videos/${item.Id}/stream.${mediaSource.Container.toLowerCase()}`, streamParameters)
    };
}

/** Returns whether a start plays the predicted stream: direct play of the same item, media source, and file tag, at the same URL. */
export function isPredictedDirectPlay(prediction: DirectPlayStreamPrediction, options: unknown): boolean {
    if (!options || typeof options !== 'object') {
        return false;
    }
    const stream = options as PlayedStream;
    return stream.url === prediction.url
        && stream.playMethod === DIRECT_PLAY_METHOD
        && stream.item?.Id === prediction.itemId
        && stream.mediaSource?.Id === prediction.mediaSourceId
        && (stream.mediaSource.ETag ?? null) === prediction.eTag
        && !stream.mediaSource.LiveStreamId;
}

/** Loads the engine's prefetch with the custom playback chunk, which the playback that follows loads anyway; a static import would put it in the entry bundle. */
async function loadEngineSourcePrefetcher(): Promise<SourcePrefetcher> {
    const { prefetchCustomDecodeSource } = await import(
        /* webpackChunkName: "webgpu-custom-playback" */
        'webgpu-player/pipeline/CustomDecodeSession'
    );
    return (source: CustomDecodeMediaSource): CustomDecodeSourcePrefetch => prefetchCustomDecodeSource(source);
}

/** One head read, from the negotiation it is predicted for until it is canceled. */
class HeadPrefetch {
    // Known once the client defaults settled, and null when the negotiation is not predicted to direct play a file
    public prediction: DirectPlayStreamPrediction | null = null;
    private canceled = false;
    private enginePrefetch: CustomDecodeSourcePrefetch | null = null;

    public async begin(
        ready: Promise<void>,
        predict: () => DirectPlayStreamPrediction | null,
        loadSourcePrefetcher: () => Promise<SourcePrefetcher>
    ): Promise<void> {
        await ready;
        if (this.canceled) {
            return;
        }
        const prediction = predict();
        // The engine plays a URL resolved against the page, and names the prefetch's source the same way
        const source = prediction ? resolvePlaybackMediaSource(createStreamURLSource(prediction.url)) : null;
        if (!prediction || !source) {
            return;
        }
        this.prediction = prediction;
        const prefetchSource = await loadSourcePrefetcher();
        if (!this.canceled) {
            this.enginePrefetch = prefetchSource(source);
        }
    }

    /** Ends the read: the engine releases its source unless a run took it over, and a read not yet started never starts. */
    public cancel(): void {
        this.canceled = true;
        this.enginePrefetch?.cancel();
        this.enginePrefetch = null;
    }
}

/**
 * The head reads of one player: the one started for the negotiation in progress, and the one the latest start claimed.
 * A start of the predicted stream claims the read and releases it once the start is over, which the engine ignores once its run took the read over;
 * any other start, a stop, and a new playback request cancel it.
 */
export class DirectPlayHeadPrefetches {
    private claimed: HeadPrefetch | null = null;
    private pending: HeadPrefetch | null = null;

    public constructor(private readonly loadSourcePrefetcher: () => Promise<SourcePrefetcher> = loadEngineSourcePrefetcher) {}

    /**
     * Starts the head read of the stream a negotiation is predicted to direct play, in place of one started before that no start claimed.
     * The prediction runs once `ready` resolves, as the negotiation adopts the client defaults first.
     */
    public start(ready: Promise<void>, predict: () => DirectPlayStreamPrediction | null): void {
        this.pending?.cancel();
        const prefetch = new HeadPrefetch();
        this.pending = prefetch;
        prefetch.begin(ready, predict, this.loadSourcePrefetcher).catch((error: unknown): void => {
            console.warn('[WebGPUPlayer] unable to start reading the stream ahead of its playback', error);
        });
    }

    /** Hands the pending read to a start of its predicted stream, and cancels it for any other start; returns the read the start claimed. */
    public claim(options: unknown): HeadPrefetch | null {
        const prefetch = this.pending;
        this.pending = null;
        if (!prefetch) {
            return null;
        }
        if (!prefetch.prediction || !isPredictedDirectPlay(prefetch.prediction, options)) {
            prefetch.cancel();
            return null;
        }
        this.claimed?.cancel();
        this.claimed = prefetch;
        return prefetch;
    }

    /** Releases a claimed read once its start is over; a run that took the read over keeps it. */
    public release(prefetch: HeadPrefetch | null): void {
        if (!prefetch) {
            return;
        }
        prefetch.cancel();
        if (this.claimed === prefetch) {
            this.claimed = null;
        }
    }

    /** Cancels every read, as a stop, a destroyed player, or a new playback request does. */
    public cancel(): void {
        this.pending?.cancel();
        this.pending = null;
        this.claimed?.cancel();
        this.claimed = null;
    }
}

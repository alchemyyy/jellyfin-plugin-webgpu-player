import { describe, expect, it, vi, type Mock } from 'vitest';

import {
    createStreamURLSource,
    DirectPlayHeadPrefetches,
    isPredictedDirectPlay,
    predictDirectPlayStream,
    type DirectPlayStreamPrediction,
    type SourcePrefetcher,
    type StreamURLBuilder
} from 'addons/webGPUPlayer/DirectPlayHeadPrefetch';

type Deferred<T> = {
    promise: Promise<T>
    resolve: (value: T) => void
};

type MediaSource = Record<string, unknown>;
type Item = Record<string, unknown>;

const SERVER_ADDRESS = 'https://jellyfin.example/jf';
const DEVICE_ID = 'device id/1';
const ACCESS_TOKEN = 'token+&=';

/** Builds a query string like jellyfin-apiclient's paramsToString, which skips null, undefined, and empty values. */
function paramsToString(params: Record<string, unknown>): string {
    const values: string[] = [];
    for (const [ key, value ] of Object.entries(params)) {
        if (value !== null && value !== undefined && value !== '') {
            values.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
        }
    }
    return values.join('&');
}

/** An ApiClient whose getUrl builds URLs as jellyfin-apiclient does. */
function createApiClient(): StreamURLBuilder {
    return {
        accessToken: (): string => ACCESS_TOKEN,
        deviceId: (): string => DEVICE_ID,
        getUrl: (name: string, params?: Record<string, unknown>): string => {
            let url = SERVER_ADDRESS;
            if (!name.startsWith('/')) {
                url += '/';
            }
            url += name;
            if (params) {
                const query = paramsToString(params);
                if (query) {
                    url += `?${query}`;
                }
            }
            return url;
        }
    };
}

/** The URL PlaybackManager's createStreamInfo builds for a video media source that supports direct play, as the vendored Jellyfin Web does. */
function createStreamInfoURL(apiClient: StreamURLBuilder, item: Item, mediaSource: MediaSource): string {
    const mediaSourceContainer = String(mediaSource.Container || '').toLowerCase();
    const directOptions: Record<string, unknown> = {
        Static: true,
        mediaSourceId: mediaSource.Id,
        deviceId: apiClient.deviceId(),
        ApiKey: apiClient.accessToken()
    };
    if (mediaSource.ETag) {
        directOptions.Tag = mediaSource.ETag;
    }
    if (mediaSource.LiveStreamId) {
        directOptions.LiveStreamId = mediaSource.LiveStreamId;
    }
    return apiClient.getUrl('Videos/' + String(item.Id) + '/stream.' + mediaSourceContainer, directOptions);
}

function createMediaSource(changes: MediaSource = {}): MediaSource {
    return {
        Container: 'MKV',
        ETag: 'etag',
        Id: 'source',
        IsInfiniteStream: false,
        IsRemote: false,
        Protocol: 'File',
        RequiresOpening: false,
        SupportsDirectPlay: true,
        Type: 'Default',
        VideoType: 'VideoFile',
        ...changes
    };
}

function createItem(changes: Item = {}, mediaSources: MediaSource[] = [ createMediaSource() ]): Item {
    return {
        Id: 'item',
        MediaSources: mediaSources,
        MediaType: 'Video',
        ServerId: 'server',
        Type: 'Movie',
        ...changes
    };
}

function predict(item: Item, requestedMediaSourceId: string | null = null): DirectPlayStreamPrediction {
    const prediction = predictDirectPlayStream(item, requestedMediaSourceId, createApiClient());
    if (!prediction) {
        throw new Error('expected a prediction');
    }
    return prediction;
}

/** The stream PlaybackManager hands the player for the predicted direct play */
function createPlayedStream(prediction: DirectPlayStreamPrediction, changes: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        item: { Id: prediction.itemId },
        mediaSource: { ETag: prediction.eTag ?? undefined, Id: prediction.mediaSourceId },
        playMethod: 'DirectPlay',
        url: prediction.url,
        ...changes
    };
}

function createDeferred<T>(): Deferred<T> {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>(resolvePromise => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

/** Lets every pending promise reaction run. */
async function flush(): Promise<void> {
    await new Promise<void>(resolve => {
        setTimeout(resolve, 0);
    });
}

type EnginePrefetcher = {
    // One cancel per prefetch the engine started, in start order
    cancels: Mock[]
    prefetch: Mock<SourcePrefetcher>
};

function createEnginePrefetcher(): EnginePrefetcher {
    const cancels: Mock[] = [];
    const prefetch = vi.fn<SourcePrefetcher>(() => {
        const cancel = vi.fn();
        cancels.push(cancel);
        return { cancel };
    });
    return { cancels, prefetch };
}

function createPrefetches(enginePrefetcher: EnginePrefetcher): DirectPlayHeadPrefetches {
    return new DirectPlayHeadPrefetches(() => Promise.resolve(enginePrefetcher.prefetch));
}

describe('predictDirectPlayStream', () => {
    it('builds the URL PlaybackManager builds for the direct play of the item\'s file', () => {
        const apiClient = createApiClient();
        const mediaSource = createMediaSource();
        const item = createItem({}, [ mediaSource ]);

        const prediction = predictDirectPlayStream(item, null, apiClient);

        expect(prediction).toEqual({
            eTag: 'etag',
            itemId: 'item',
            mediaSourceId: 'source',
            url: createStreamInfoURL(apiClient, item, mediaSource)
        });
        expect(prediction?.url).toBe(
            'https://jellyfin.example/jf/Videos/item/stream.mkv?Static=true&mediaSourceId=source&deviceId=device%20id%2F1&ApiKey=token%2B%26%3D&Tag=etag'
        );
    });

    it('builds the URL without a tag for a media source without an ETag', () => {
        const apiClient = createApiClient();
        for (const eTag of [ undefined, null, '' ]) {
            const mediaSource = createMediaSource({ ETag: eTag });
            const item = createItem({}, [ mediaSource ]);

            const prediction = predictDirectPlayStream(item, null, apiClient);

            expect(prediction?.eTag).toBeNull();
            expect(prediction?.url).toBe(createStreamInfoURL(apiClient, item, mediaSource));
            expect(prediction?.url).not.toContain('Tag=');
        }
    });

    it('builds the URL of the media source a request names among several', () => {
        const apiClient = createApiClient();
        const requestedMediaSource = createMediaSource({ Container: 'mp4', ETag: 'other-etag', Id: 'version' });
        const item = createItem({}, [ createMediaSource(), requestedMediaSource ]);

        const prediction = predictDirectPlayStream(item, 'version', apiClient);

        expect(prediction).toEqual({
            eTag: 'other-etag',
            itemId: 'item',
            mediaSourceId: 'version',
            url: createStreamInfoURL(apiClient, item, requestedMediaSource)
        });
    });

    it.each([
        [ 'no item', null, null ],
        [ 'an item that is no object', 'item', null ],
        [ 'an item without an ID', createItem({ Id: undefined }), null ],
        [ 'audio', createItem({ MediaType: 'Audio' }), null ],
        [ 'a TV channel', createItem({ Type: 'TvChannel' }), null ],
        [ 'a live TV channel', createItem({ Type: 'LiveTvChannel' }), null ],
        [ 'a program', createItem({ Type: 'Program' }), null ],
        [ 'a placeholder item', createItem({ IsPlaceHolder: true }), null ],
        [ 'an item without media sources', createItem({ MediaSources: undefined }), null ],
        [ 'an item with no media source', createItem({}, []), null ],
        [ 'several versions without a requested one', createItem({}, [ createMediaSource(), createMediaSource({ Id: 'version' }) ]), null ],
        [ 'a requested version the item lacks', createItem(), 'version' ],
        [ 'a remote protocol', createItem({}, [ createMediaSource({ Protocol: 'Http' }) ]), null ],
        [ 'no direct play support', createItem({}, [ createMediaSource({ SupportsDirectPlay: false }) ]), null ],
        [ 'unknown direct play support', createItem({}, [ createMediaSource({ SupportsDirectPlay: undefined }) ]), null ],
        [ 'a remote media source', createItem({}, [ createMediaSource({ IsRemote: true }) ]), null ],
        [ 'a media source that requires opening', createItem({}, [ createMediaSource({ RequiresOpening: true }) ]), null ],
        [ 'an infinite stream', createItem({}, [ createMediaSource({ IsInfiniteStream: true }) ]), null ],
        [ 'a live stream', createItem({}, [ createMediaSource({ LiveStreamId: 'live' }) ]), null ],
        [ 'a placeholder media source', createItem({}, [ createMediaSource({ Type: 'Placeholder' }) ]), null ],
        [ 'a Blu-ray folder', createItem({}, [ createMediaSource({ VideoType: 'BluRay' }) ]), null ],
        [ 'a DVD folder', createItem({}, [ createMediaSource({ VideoType: 'Dvd' }) ]), null ],
        [ 'an HD DVD folder', createItem({}, [ createMediaSource({ VideoType: 'HdDvd' }) ]), null ],
        [ 'a media source without a container', createItem({}, [ createMediaSource({ Container: '' }) ]), null ],
        [ 'a media source without an ID', createItem({}, [ createMediaSource({ Id: null }) ]), null ]
    ])('predicts nothing for %s', (_description, item, requestedMediaSourceId) => {
        const apiClient = createApiClient();
        const getUrl = vi.spyOn(apiClient, 'getUrl');

        expect(predictDirectPlayStream(item, requestedMediaSourceId, apiClient)).toBeNull();
        expect(getUrl).not.toHaveBeenCalled();
    });
});

describe('isPredictedDirectPlay', () => {
    const prediction = predict(createItem());

    it('accepts the direct play of the predicted stream', () => {
        expect(isPredictedDirectPlay(prediction, createPlayedStream(prediction))).toBe(true);
    });

    it('accepts a stream without a tag for a prediction without one', () => {
        const untaggedPrediction = predict(createItem({}, [ createMediaSource({ ETag: undefined }) ]));

        expect(isPredictedDirectPlay(untaggedPrediction, createPlayedStream(untaggedPrediction, { mediaSource: { Id: 'source' } }))).toBe(true);
        expect(isPredictedDirectPlay(untaggedPrediction, createPlayedStream(untaggedPrediction, { mediaSource: { ETag: 'etag', Id: 'source' } }))).toBe(false);
    });

    it.each([
        [ 'no options', undefined ],
        [ 'options that are no object', 'options' ],
        [ 'a transcode', createPlayedStream(prediction, { playMethod: 'Transcode', url: 'https://jellyfin.example/jf/videos/item/master.m3u8' }) ],
        [ 'a transcode at the predicted URL', createPlayedStream(prediction, { playMethod: 'Transcode' }) ],
        [ 'a direct stream', createPlayedStream(prediction, { playMethod: 'DirectStream' }) ],
        [ 'another item', createPlayedStream(prediction, { item: { Id: 'other' } }) ],
        [ 'another media source', createPlayedStream(prediction, { mediaSource: { ETag: 'etag', Id: 'version' } }) ],
        [ 'another URL', createPlayedStream(prediction, { url: `${prediction.url}&StartTimeTicks=0` }) ],
        [ 'another tag', createPlayedStream(prediction, { mediaSource: { ETag: 'changed', Id: 'source' } }) ],
        [ 'a live stream', createPlayedStream(prediction, { mediaSource: { ETag: 'etag', Id: 'source', LiveStreamId: 'live' } }) ]
    ])('rejects %s', (_description, options) => {
        expect(isPredictedDirectPlay(prediction, options)).toBe(false);
    });
});

describe('createStreamURLSource', () => {
    it('names the URL with Jellyfin\'s stream path pattern', () => {
        const source = createStreamURLSource('https://jellyfin.example/Videos/item/stream.mkv?Static=true');

        expect(source).toEqual({ hiddenContentRangePathPattern: expect.any(RegExp) as unknown, kind: 'url', url: 'https://jellyfin.example/Videos/item/stream.mkv?Static=true' });
        const { hiddenContentRangePathPattern } = source as { hiddenContentRangePathPattern: RegExp };
        expect(hiddenContentRangePathPattern.test('/jf/Videos/item/stream.mkv')).toBe(true);
        expect(hiddenContentRangePathPattern.test('/Videos/item/stream')).toBe(true);
        expect(hiddenContentRangePathPattern.test('/Videos/item/master.m3u8')).toBe(false);
    });
});

describe('DirectPlayHeadPrefetches', () => {
    const prediction = predict(createItem());

    it('starts the engine prefetch of the predicted stream once the negotiation is ready', async () => {
        const enginePrefetcher = createEnginePrefetcher();
        const prefetches = createPrefetches(enginePrefetcher);
        const ready = createDeferred<void>();
        const predictStream = vi.fn((): DirectPlayStreamPrediction => prediction);

        prefetches.start(ready.promise, predictStream);
        await flush();
        expect(predictStream).not.toHaveBeenCalled();
        expect(enginePrefetcher.prefetch).not.toHaveBeenCalled();

        ready.resolve();
        await flush();
        expect(predictStream).toHaveBeenCalledTimes(1);
        expect(enginePrefetcher.prefetch).toHaveBeenCalledTimes(1);
        expect(enginePrefetcher.prefetch).toHaveBeenCalledWith(createStreamURLSource(prediction.url));
    });

    it('keeps the read a start of the predicted stream claims until it is released', async () => {
        const enginePrefetcher = createEnginePrefetcher();
        const prefetches = createPrefetches(enginePrefetcher);
        prefetches.start(Promise.resolve(), () => prediction);
        await flush();

        const claimed = prefetches.claim(createPlayedStream(prediction));
        expect(claimed).not.toBeNull();
        expect(enginePrefetcher.cancels[0]).not.toHaveBeenCalled();

        prefetches.release(claimed);
        expect(enginePrefetcher.cancels[0]).toHaveBeenCalledTimes(1);
        // Released reads are no longer canceled with the rest
        prefetches.cancel();
        expect(enginePrefetcher.cancels[0]).toHaveBeenCalledTimes(1);
    });

    it('cancels the read at once for a start of another stream', async () => {
        const enginePrefetcher = createEnginePrefetcher();
        const prefetches = createPrefetches(enginePrefetcher);
        prefetches.start(Promise.resolve(), () => prediction);
        await flush();

        expect(prefetches.claim(createPlayedStream(prediction, { playMethod: 'Transcode' }))).toBeNull();
        expect(enginePrefetcher.cancels[0]).toHaveBeenCalledTimes(1);
    });

    it('claims nothing without a pending read, and releases nothing for an unclaimed start', () => {
        const prefetches = createPrefetches(createEnginePrefetcher());

        expect(prefetches.claim(createPlayedStream(prediction))).toBeNull();
        expect(() => prefetches.release(null)).not.toThrow();
    });

    it('cancels both the pending and the claimed read', async () => {
        const enginePrefetcher = createEnginePrefetcher();
        const prefetches = createPrefetches(enginePrefetcher);
        prefetches.start(Promise.resolve(), () => prediction);
        await flush();
        expect(prefetches.claim(createPlayedStream(prediction))).not.toBeNull();
        prefetches.start(Promise.resolve(), () => prediction);
        await flush();
        expect(enginePrefetcher.cancels).toHaveLength(2);
        expect(enginePrefetcher.cancels[0]).not.toHaveBeenCalled();

        prefetches.cancel();

        expect(enginePrefetcher.cancels[0]).toHaveBeenCalledTimes(1);
        expect(enginePrefetcher.cancels[1]).toHaveBeenCalledTimes(1);
    });

    it('cancels a claimed read that a later claim replaces', async () => {
        const enginePrefetcher = createEnginePrefetcher();
        const prefetches = createPrefetches(enginePrefetcher);
        prefetches.start(Promise.resolve(), () => prediction);
        await flush();
        const firstClaim = prefetches.claim(createPlayedStream(prediction));
        prefetches.start(Promise.resolve(), () => prediction);
        await flush();

        const secondClaim = prefetches.claim(createPlayedStream(prediction));

        expect(enginePrefetcher.cancels[0]).toHaveBeenCalledTimes(1);
        expect(enginePrefetcher.cancels[1]).not.toHaveBeenCalled();
        // The first start settling later leaves the second start's read alone
        prefetches.release(firstClaim);
        expect(enginePrefetcher.cancels[1]).not.toHaveBeenCalled();
        prefetches.release(secondClaim);
        expect(enginePrefetcher.cancels[1]).toHaveBeenCalledTimes(1);
    });

    it('cancels a pending read that another start replaces', async () => {
        const enginePrefetcher = createEnginePrefetcher();
        const prefetches = createPrefetches(enginePrefetcher);
        prefetches.start(Promise.resolve(), () => prediction);
        await flush();

        prefetches.start(Promise.resolve(), () => prediction);
        expect(enginePrefetcher.cancels[0]).toHaveBeenCalledTimes(1);
        await flush();
        expect(enginePrefetcher.prefetch).toHaveBeenCalledTimes(2);
        expect(enginePrefetcher.cancels[1]).not.toHaveBeenCalled();
    });

    it('never predicts a read another start replaced before the negotiation was ready', async () => {
        const enginePrefetcher = createEnginePrefetcher();
        const prefetches = createPrefetches(enginePrefetcher);
        const firstPredict = vi.fn((): DirectPlayStreamPrediction => prediction);
        prefetches.start(createDeferred<void>().promise, firstPredict);

        prefetches.start(Promise.resolve(), () => prediction);
        await flush();

        expect(firstPredict).not.toHaveBeenCalled();
        expect(enginePrefetcher.prefetch).toHaveBeenCalledTimes(1);
    });

    it('never starts a read canceled before the engine prefetch loaded', async () => {
        const enginePrefetcher = createEnginePrefetcher();
        const loader = createDeferred<SourcePrefetcher>();
        const prefetches = new DirectPlayHeadPrefetches(() => loader.promise);
        prefetches.start(Promise.resolve(), () => prediction);
        await flush();

        prefetches.cancel();
        loader.resolve(enginePrefetcher.prefetch);
        await flush();

        expect(enginePrefetcher.prefetch).not.toHaveBeenCalled();
    });

    it('never starts a read for a negotiation not predicted to direct play', async () => {
        const enginePrefetcher = createEnginePrefetcher();
        const loadSourcePrefetcher = vi.fn(() => Promise.resolve(enginePrefetcher.prefetch));
        const prefetches = new DirectPlayHeadPrefetches(loadSourcePrefetcher);

        prefetches.start(Promise.resolve(), () => null);
        await flush();

        expect(loadSourcePrefetcher).not.toHaveBeenCalled();
        expect(enginePrefetcher.prefetch).not.toHaveBeenCalled();
        expect(prefetches.claim(createPlayedStream(prediction))).toBeNull();
    });

    it('never starts a read of a URL the engine cannot play', async () => {
        const enginePrefetcher = createEnginePrefetcher();
        const prefetches = createPrefetches(enginePrefetcher);

        prefetches.start(Promise.resolve(), () => ({ ...prediction, url: 'ftp://jellyfin.example/Videos/item/stream.mkv' }));
        await flush();

        expect(enginePrefetcher.prefetch).not.toHaveBeenCalled();
    });

    it('warns instead of failing when the engine prefetch cannot load', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const prefetches = new DirectPlayHeadPrefetches(() => Promise.reject(new Error('chunk failed')));

        prefetches.start(Promise.resolve(), () => prediction);
        await flush();

        expect(warn).toHaveBeenCalledTimes(1);
    });
});

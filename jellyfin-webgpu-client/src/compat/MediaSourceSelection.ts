import type { MediaSourceInfo } from '@jellyfin/sdk/lib/generated-client/models/media-source-info';

// Replica of the stock PlaybackManager's module-private getOptimalMediaSource and supportsDirectPlay, so the PlaybackInfo interceptor sees the source and direct-play flag PlaybackManager will pick

const FOLDER_RIP_VIDEO_TYPES = new Set([ 'BluRay', 'Dvd', 'HdDvd' ]);
const HTTP_PROTOCOL = 'Http';
const LOOPBACK_HOST_NAMES = [ 'localhost', '127.0.0.1' ];

export type EndpointInfo = {
    IsInNetwork?: boolean
    IsLocal?: boolean
};

/** Host facts that decide whether a source can play from its own path */
export type DirectPlayEnvironment = {
    getEndpointInfo: () => Promise<EndpointInfo>
    supportsRemoteVideo: boolean
};

export type MediaSourceSelection = {
    enableDirectPlay: boolean
    mediaSource: MediaSourceInfo
};

async function isHostReachable(mediaSource: MediaSourceInfo, environment: DirectPlayEnvironment): Promise<boolean> {
    if (mediaSource.IsRemote) {
        return true;
    }

    const endpointInfo = await environment.getEndpointInfo();
    if (!endpointInfo.IsInNetwork) {
        // Media source is in network, but the connection is out of network
        return false;
    }
    if (!endpointInfo.IsLocal) {
        const path = (mediaSource.Path || '').toLowerCase();
        // A loopback path only works when the client runs on the server machine
        return !LOOPBACK_HOST_NAMES.some(hostName => path.includes(hostName));
    }
    return true;
}

/** Returns whether the stock PlaybackManager would play the source from its own path. */
export async function supportsDirectPlay(mediaSource: MediaSourceInfo, environment: DirectPlayEnvironment): Promise<boolean> {
    // Folder rip hacks, because the stream building engine does not support them yet
    const isFolderRip = FOLDER_RIP_VIDEO_TYPES.has(mediaSource.VideoType ?? '');
    if (!mediaSource.SupportsDirectPlay && !isFolderRip) {
        return false;
    }
    if (mediaSource.IsRemote && !environment.supportsRemoteVideo) {
        return false;
    }

    // NOTE: The host tests .length, which a header dictionary lacks, so only a non-empty array blocks
    const requiredHeaderCount = (mediaSource.RequiredHttpHeaders as { length?: number } | null | undefined)?.length;
    if (mediaSource.Protocol !== HTTP_PROTOCOL || requiredHeaderCount) {
        return false;
    }
    // If this is the only way it can be played, allow it
    if (!mediaSource.SupportsDirectStream && !mediaSource.SupportsTranscoding) {
        return true;
    }
    return isHostReachable(mediaSource, environment);
}

/** Picks the source the stock PlaybackManager plays, preferring the played item's own source. */
export async function selectOptimalMediaSource(
    itemId: string | null | undefined,
    mediaSources: readonly MediaSourceInfo[],
    environment: DirectPlayEnvironment
): Promise<MediaSourceSelection | null> {
    if (mediaSources.length === 0) {
        return null;
    }

    const directPlayResults = await Promise.all(
        mediaSources.map(mediaSource => supportsDirectPlay(mediaSource, environment))
    );
    const candidates: MediaSourceSelection[] = mediaSources.map((mediaSource, index) => ({
        enableDirectPlay: directPlayResults[index] || false,
        mediaSource
    }));

    const ownSource = candidates.find(candidate => candidate.mediaSource.Id === itemId);
    if (ownSource && (
        ownSource.enableDirectPlay
        || ownSource.mediaSource.SupportsDirectStream
        || ownSource.mediaSource.SupportsTranscoding
    )) {
        return ownSource;
    }

    return candidates.find(candidate => candidate.enableDirectPlay)
        ?? candidates.find(candidate => candidate.mediaSource.SupportsDirectStream)
        ?? candidates.find(candidate => candidate.mediaSource.SupportsTranscoding)
        ?? candidates[0];
}

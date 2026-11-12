import loading from 'components/loading/loading';
import { playbackManager } from 'components/playback/playbackmanager';

import { holdOutdatedPageReload } from '../OutdatedPageReload';

import { installOsdDoubleClickSelectionGuard } from './OsdDoubleClickSelection';
import { installPlaybackManagerHooks } from './PlaybackManagerHooks';
import { installPlayerSettingsMenu, type PlayerSettingsMenuPlayer } from './PlayerSettingsMenu';
import { installSettingsEntryPoints } from './SettingsEntryPoints';

/** Player members the host-compatible hooks use */
export type HostCompatiblePlayer = PlayerSettingsMenuPlayer & {
    beginPlaybackRequest: (mediaSourceId: string | null) => () => void
    cancelPendingPlayForNewRequest: () => boolean
    isRequestStartPending: () => boolean
};

const hostCompatiblePlayers = new Set<HostCompatiblePlayer>();

/** Notes a playback request on every add-on player, and holds an outdated page's reload; returns the function that ends it on each. */
function beginPlaybackRequest(mediaSourceId: string | null): () => void {
    const endReloadHold = holdOutdatedPageReload();
    const endRequests = Array.from(hostCompatiblePlayers, (player: HostCompatiblePlayer): (() => void) => player.beginPlaybackRequest(mediaSourceId));
    return (): void => {
        for (const endRequest of endRequests) {
            endRequest();
        }
        endReloadHold();
    };
}

/** Cancels pending starts on every add-on player; returns whether any start was pending. */
function cancelPendingPlays(): boolean {
    let cancelled = false;
    for (const player of hostCompatiblePlayers) {
        cancelled = player.cancelPendingPlayForNewRequest() || cancelled;
    }
    return cancelled;
}

/** Returns whether no add-on player has completed or lost a start for the latest request. */
function isRequestStartPending(): boolean {
    for (const player of hostCompatiblePlayers) {
        if (!player.isRequestStartPending()) {
            return false;
        }
    }
    return true;
}

function hideLoading(): void {
    loading.hide();
}

/** Installs the PlaybackManager hooks, settings entry points, player settings menu items, and OSD double-click guard once; call after the host bridge is bound. */
export function installHostCompatibleMode(player: HostCompatiblePlayer): void {
    hostCompatiblePlayers.add(player);
    installPlaybackManagerHooks(playbackManager, { beginPlaybackRequest, cancelPendingPlays, hideLoading, isRequestStartPending });
    installSettingsEntryPoints(player);
    installPlayerSettingsMenu(player);
    installOsdDoubleClickSelectionGuard();
}

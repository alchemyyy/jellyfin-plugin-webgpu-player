import loading from 'components/loading/loading';
import { playbackManager } from 'components/playback/playbackmanager';

import { installPlaybackManagerHooks } from './PlaybackManagerHooks';
import { installSettingsEntryPoints, type SettingsEntryPlayer } from './SettingsEntryPoints';

/** Player members the host-compatible hooks use */
export type HostCompatiblePlayer = SettingsEntryPlayer & {
    cancelPendingPlayForNewRequest: () => boolean
    isRequestStartPending: () => boolean
};

const hostCompatiblePlayers = new Set<HostCompatiblePlayer>();

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

/** Installs the PlaybackManager hooks and settings entry points once; call after the host bridge is bound. */
export function installHostCompatibleMode(player: HostCompatiblePlayer): void {
    hostCompatiblePlayers.add(player);
    installPlaybackManagerHooks(playbackManager, { cancelPendingPlays, hideLoading, isRequestStartPending });
    installSettingsEntryPoints(player);
}

import loading from 'components/loading/loading';
import { playbackManager } from 'components/playback/playbackmanager';

import { installPlaybackManagerHooks } from './PlaybackManagerHooks';
import { installSettingsEntryPoints, type SettingsEntryPlayer } from './SettingsEntryPoints';

/** Player members the host-compatible hooks use */
export type HostCompatiblePlayer = SettingsEntryPlayer & {
    cancelPendingPlayForNewRequest: () => boolean
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

function hideLoading(): void {
    loading.hide();
}

/** Installs the PlaybackManager hooks and settings entry points once; call after the host bridge is bound. */
export function installHostCompatibleMode(player: HostCompatiblePlayer): void {
    hostCompatiblePlayers.add(player);
    installPlaybackManagerHooks(playbackManager, { cancelPendingPlays, hideLoading });
    installSettingsEntryPoints(player);
}

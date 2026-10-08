import type { appHost } from 'components/apphost';
import type confirm from 'components/confirm/confirm';
import type loading from 'components/loading/loading';
import type { PlaybackManager } from 'components/playback/playbackmanager';
import type { appRouter } from 'components/router/appRouter';
import type toast from 'components/toast/toast';
import type globalize from 'lib/globalize';
import type { ServerConnections } from 'lib/jellyfin-apiclient';
import type * as inputManager from 'scripts/inputManager';
import type appSettings from 'scripts/settings/appSettings';
import type * as dashboard from 'utils/dashboard';
import type Events from 'utils/events';

import { bindAppHost } from './appHost';
import { bindAppRouter } from './appRouter';
import { bindAppSettings } from './appSettings';
import { bindConfirm } from './confirm';
import { bindDashboard } from './dashboard';
import { bindGlobalize } from './globalize';
import { bindInputManager } from './inputManager';
import { bindLoading } from './loading';
import { bindPlaybackManager } from './playbackManager';
import { bindServerConnections } from './serverConnections';
import { bindToast } from './toast';

/** Dependencies the host's plugin manager passes to a window-loaded plugin constructor */
export type HostPluginBag = Readonly<{
    events: typeof Events
    loading: typeof loading
    appSettings: typeof appSettings
    playbackManager: PlaybackManager
    globalize: typeof globalize
    appHost: typeof appHost
    appRouter: typeof appRouter
    inputManager: typeof inputManager
    toast: typeof toast
    confirm: typeof confirm
    dashboard: typeof dashboard
    ServerConnections: typeof ServerConnections
}>;

const REQUIRED_BAG_MEMBERS = [
    'loading',
    'appSettings',
    'playbackManager',
    'globalize',
    'appHost',
    'appRouter',
    'inputManager',
    'toast',
    'confirm',
    'dashboard',
    'ServerConnections'
] as const;

/** Throws when the host passes a bag without a dependency the add-on bridges. */
function assertCompleteBag(bag: HostPluginBag): void {
    if (!bag || typeof bag !== 'object') {
        throw new TypeError('The WebGPU player add-on requires the plugin manager dependency bag');
    }
    for (const memberName of REQUIRED_BAG_MEMBERS) {
        if (bag[memberName] == null) {
            throw new TypeError(`The plugin manager dependency bag has no ${memberName}`);
        }
    }
}

/** Points every bridged host module at the host's own singletons. */
export function bindHostBridge(bag: HostPluginBag): void {
    assertCompleteBag(bag);
    bindLoading(bag.loading);
    bindAppSettings(bag.appSettings);
    bindPlaybackManager(bag.playbackManager);
    bindGlobalize(bag.globalize);
    bindAppHost(bag.appHost);
    bindAppRouter(bag.appRouter);
    bindInputManager(bag.inputManager);
    bindToast(bag.toast);
    bindConfirm(bag.confirm);
    bindDashboard(bag.dashboard);
    bindServerConnections(bag.ServerConnections);
}

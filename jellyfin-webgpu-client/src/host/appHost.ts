import type { appHost as HostAppHost } from 'components/apphost';

// Bridge for components/apphost: a live named export filled from the plugin bag

export let appHost: typeof HostAppHost;

/** Binds the host's appHost object from the plugin bag. */
export function bindAppHost(value: typeof HostAppHost): void {
    appHost = value;
}

import type HostServerConnections from 'lib/jellyfin-apiclient/ServerConnections';

// Bridge for lib/jellyfin-apiclient/ServerConnections: a live default export filled from the plugin bag

let serverConnections: typeof HostServerConnections;

/** Binds the host's ServerConnections singleton from the plugin bag. */
export function bindServerConnections(value: typeof HostServerConnections): void {
    serverConnections = value;
}

export { serverConnections as default };

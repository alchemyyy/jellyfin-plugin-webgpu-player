import type HostAppSettings from 'scripts/settings/appSettings';

// Bridge for scripts/settings/appSettings: a live default export filled from the plugin bag

let appSettings: typeof HostAppSettings;

/** Binds the host's AppSettings instance from the plugin bag. */
export function bindAppSettings(value: typeof HostAppSettings): void {
    appSettings = value;
}

export { appSettings as default };

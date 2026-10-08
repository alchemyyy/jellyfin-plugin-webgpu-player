import type { appRouter as HostAppRouter } from 'components/router/appRouter';

// Bridge for components/router/appRouter: a live named export filled from the plugin bag

export let appRouter: typeof HostAppRouter;

/** Binds the host's AppRouter instance from the plugin bag. */
export function bindAppRouter(value: typeof HostAppRouter): void {
    appRouter = value;
}

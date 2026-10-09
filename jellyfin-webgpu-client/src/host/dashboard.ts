import type * as HostDashboard from 'utils/dashboard';

// Bridge for utils/dashboard: the module namespace comes from the plugin bag

type DashboardModule = typeof HostDashboard;

let dashboard: DashboardModule;
let dashboardDefault: DashboardModule['default'];

/** Binds the host's dashboard module namespace from the plugin bag. */
export function bindDashboard(value: DashboardModule): void {
    dashboard = value;
    dashboardDefault = value.default;
}

/** Runs a handler for a page event on the page with the given id. */
export function pageIdOn(...parameters: Parameters<DashboardModule['pageIdOn']>): ReturnType<DashboardModule['pageIdOn']> {
    return dashboard.pageIdOn(...parameters);
}

/** Runs a handler for a page event on pages with the given class. */
export function pageClassOn(...parameters: Parameters<DashboardModule['pageClassOn']>): ReturnType<DashboardModule['pageClassOn']> {
    return dashboard.pageClassOn(...parameters);
}

export { dashboardDefault as default };

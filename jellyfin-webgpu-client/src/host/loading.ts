import type HostLoading from 'components/loading/loading';

// Bridge for components/loading/loading: the default object and its named functions, filled from the plugin bag

let loading: typeof HostLoading;

/** Binds the host's loading indicator from the plugin bag. */
export function bindLoading(value: typeof HostLoading): void {
    loading = value;
}

/** Shows the host's loading indicator. */
export function show(): void {
    loading.show();
}

/** Hides the host's loading indicator. */
export function hide(): void {
    loading.hide();
}

export { loading as default };

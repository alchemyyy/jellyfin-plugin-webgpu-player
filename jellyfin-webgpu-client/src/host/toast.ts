import type HostToast from 'components/toast/toast';

// Bridge for components/toast/toast: a live default export filled from the plugin bag

let toast: typeof HostToast;

/** Binds the host's toast function from the plugin bag. */
export function bindToast(value: typeof HostToast): void {
    toast = value;
}

export { toast as default };

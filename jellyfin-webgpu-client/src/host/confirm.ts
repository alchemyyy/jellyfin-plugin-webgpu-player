import type HostConfirm from 'components/confirm/confirm';

// Bridge for components/confirm/confirm: a live default export filled from the plugin bag

let confirm: typeof HostConfirm;

/** Binds the host's confirm dialog function from the plugin bag. */
export function bindConfirm(value: typeof HostConfirm): void {
    confirm = value;
}

export { confirm as default };

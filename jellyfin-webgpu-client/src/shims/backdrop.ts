import Dashboard from 'utils/dashboard';

// Shim for components/backdrop/backdrop: the host keeps backdrop state in module scope, so the add-on drives the host's own instance through the Dashboard object from the plugin bag

/** Transparency levels, identical to the host's TRANSPARENCY_LEVEL */
export const TRANSPARENCY_LEVEL = {
    Full: 'full',
    Backdrop: 'backdrop',
    None: 'none'
};

/** Sets the host's backdrop, background, and document transparency. */
export function setBackdropTransparency(level: string): void {
    Dashboard.setBackdropTransparency(level);
}

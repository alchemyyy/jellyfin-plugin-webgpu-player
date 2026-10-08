// Shim for components/layoutManager: the host instance is not in the plugin bag, but it mirrors its
// active layout onto <html> as layout-tv, layout-mobile, or layout-desktop

const TV_LAYOUT_CLASS = 'layout-tv';
const MOBILE_LAYOUT_CLASS = 'layout-mobile';
const DESKTOP_LAYOUT_CLASS = 'layout-desktop';

export const SETTING_KEY = 'layout';

function hasDocumentClass(className: string): boolean {
    return typeof document !== 'undefined'
        && document.documentElement.classList.contains(className);
}

/** Read-only view of the host's active layout */
class LayoutManager {
    get tv(): boolean {
        return hasDocumentClass(TV_LAYOUT_CLASS);
    }

    get mobile(): boolean {
        return hasDocumentClass(MOBILE_LAYOUT_CLASS);
    }

    get desktop(): boolean {
        return hasDocumentClass(DESKTOP_LAYOUT_CLASS);
    }
}

const layoutManager = new LayoutManager();

export default layoutManager;

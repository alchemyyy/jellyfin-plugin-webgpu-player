// The stock host registers emby-select only from lazily loaded pages, and a second registration throws, so the add-on cannot register it.
// Until the host does, the settings panel labels its selects itself

const EMBY_SELECT_SELECTOR = 'select[is="emby-select"]';
// emby-select's attach step skips elements that already carry this class, so a later upgrade adds no second label
const EMBY_SELECT_CLASS = 'emby-select';
const SELECT_LABEL_CLASS = 'selectLabel';
// Polyfilled upgrades run from a MutationObserver, before this macrotask
const UPGRADE_SETTLE_DELAY_MILLISECONDS = 0;

/** Adds the label emby-select would create to every select the host has not upgraded. */
export function labelSelectsAwaitingHostUpgrade(root: ParentNode): void {
    for (const select of Array.from(root.querySelectorAll<HTMLSelectElement>(EMBY_SELECT_SELECTOR))) {
        const parent = select.parentNode;
        if (select.classList.contains(EMBY_SELECT_CLASS) || !parent) {
            continue;
        }
        select.classList.add(EMBY_SELECT_CLASS);
        const label = document.createElement('label');
        label.textContent = select.getAttribute('label') || '';
        label.classList.add(SELECT_LABEL_CLASS);
        if (select.id) {
            label.htmlFor = select.id;
        }
        parent.insertBefore(label, select);
    }
}

/** Labels the panel's selects once registered host elements have had their chance to upgrade. */
export function scheduleSelectLabelFallback(root: ParentNode): void {
    globalThis.setTimeout((): void => {
        labelSelectsAwaitingHostUpgrade(root);
    }, UPGRADE_SETTLE_DELAY_MILLISECONDS);
}

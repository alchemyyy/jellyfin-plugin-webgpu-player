// The WebGPU Player settings page: the client defaults, whose editor the add-on renders in the user's language,
// and the decoder packages and pass files the server offers, which an administrator uploads, deletes, enables, and disables.
// The server's ModuleController answers every change with the new listing, so the page renders whatever the server holds afterwards.

const ROUTE = 'WebGPUPlayer';
const LISTING_PATH = `${ROUTE}/Catalog/All`;
const ENABLED_SEGMENT = 'Enabled';
const UPLOADED_SOURCE = 'uploaded';
const BINARY_CONTENT_TYPE = 'application/octet-stream';
const PASS_FILE_NAME_PARAMETER = 'fileName';
const BYTES_PER_KIBIBYTE = 1024;
const SIZE_FRACTION_DIGITS = 1;
const DETAIL_SEPARATOR = ' · ';
const LIST_SEPARATOR = ', ';
const ADDON_MISSING_MESSAGE = 'The WebGPU Player add-on is not loaded in this page, so the client defaults cannot be edited. Reload the page to load it.';

// Each module kind's listing property, route, and how an entry describes what it holds
const KINDS = {
    decoderPackages: {
        describe: describeDecoderPackage,
        route: `${ROUTE}/DecoderPackages`,
        uploadPath: () => `${ROUTE}/DecoderPackages`
    },
    passes: {
        describe: describePassFile,
        route: `${ROUTE}/Passes`,
        uploadPath: file => `${ROUTE}/Passes?${PASS_FILE_NAME_PARAMETER}=${encodeURIComponent(file.name)}`
    }
};

/** Returns the headers that sign a request in as the dashboard's user. */
function getAuthorizationHeaders() {
    return { Authorization: `MediaBrowser Token="${window.ApiClient.accessToken()}"` };
}

/** Sends a request to the plugin's route and returns the listing it answers with; rejects with the server's failed check and detail. */
async function requestListing(method, path, body) {
    const headers = getAuthorizationHeaders();
    if (body !== undefined) {
        headers['Content-Type'] = BINARY_CONTENT_TYPE;
    }
    const response = await fetch(window.ApiClient.getUrl(path), { body, headers, method });
    if (response.ok) {
        return response.json();
    }
    let problem = `http-${response.status}`;
    try {
        const answer = await response.json();
        if (answer && typeof answer.code === 'string') {
            problem = `${answer.code}: ${answer.detail}`;
        }
    } catch {
        // A response without a problem body keeps its status as the problem
    }
    throw new Error(problem);
}

function formatSize(byteLength) {
    return `${(byteLength / BYTES_PER_KIBIBYTE).toFixed(SIZE_FRACTION_DIGITS)} KiB`;
}

/** Returns what a decoder package decodes: its id, kind, codecs, and a video decoder's formats. */
function describeDecoderPackage(info) {
    const parts = [ info.id, info.kind, info.codecs.join(LIST_SEPARATOR) ];
    if (info.outputFormats.length > 0) {
        parts.push(info.outputFormats.join(LIST_SEPARATOR));
    }
    if (info.monochrome) {
        parts.push('monochrome');
    }
    parts.push(formatSize(info.byteLength));
    return { detail: parts.join(DETAIL_SEPARATOR), title: info.name };
}

/** Returns what a pass file holds: its passes' names and its size. */
function describePassFile(info) {
    return {
        detail: [ info.passNames.join(LIST_SEPARATOR), formatSize(info.byteLength) ].join(DETAIL_SEPARATOR),
        title: info.fileName
    };
}

/** Returns where an entry stands: its source, and whether clients get it. */
function describeState(entry) {
    if (entry.replaced) {
        return 'bundled, replaced by an upload';
    }
    if (entry.problem) {
        return `${entry.source}, not offered: ${entry.problem}`;
    }
    return entry.offered ? `${entry.source}, offered` : `${entry.source}, disabled`;
}

function createTextElement(className, text) {
    const element = document.createElement('div');
    element.className = className;
    element.textContent = text;
    return element;
}

/** Creates one entry's row: its description, its enabled switch, and a delete button for an upload. */
function createEntryElement(kindName, entry) {
    const kind = KINDS[kindName];
    const description = entry.info ? kind.describe(entry.info) : { detail: entry.fileName, title: entry.key };
    const item = document.createElement('div');
    item.className = 'listItem listItem-border';

    const body = document.createElement('div');
    body.className = 'listItemBody three-line';
    body.append(
        createTextElement('listItemBodyText', description.title),
        createTextElement('listItemBodyText secondary', description.detail),
        createTextElement('listItemBodyText secondary', describeState(entry))
    );
    item.append(body);

    // The key's state applies to whichever version holds it, so a replaced bundled file has no switch of its own
    if (!entry.replaced) {
        const label = document.createElement('label');
        label.className = 'checkboxContainer';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.setAttribute('is', 'emby-checkbox');
        checkbox.checked = entry.enabled;
        checkbox.dataset.enableKind = kindName;
        checkbox.dataset.key = entry.key;
        const caption = document.createElement('span');
        caption.textContent = 'Enabled';
        label.append(checkbox, caption);
        item.append(label);
    }

    if (entry.source === UPLOADED_SOURCE) {
        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'listItemButton paper-icon-button-light';
        removeButton.title = `Delete ${entry.fileName}`;
        removeButton.setAttribute('aria-label', removeButton.title);
        removeButton.dataset.removeKind = kindName;
        removeButton.dataset.key = entry.key;
        const icon = document.createElement('span');
        icon.className = 'material-icons delete';
        icon.setAttribute('aria-hidden', 'true');
        removeButton.append(icon);
        item.append(removeButton);
    }
    return item;
}

/** Renders the add-on's client defaults editor into its container; without the add-on, or when the editor fails, the container shows a message instead. */
async function mountClientDefaultsEditor(container) {
    try {
        // The bootstrap script the plugin adds to index.html defines the factory, which resolves to the add-on's entry
        const factory = window.WebGPUPlayer;
        if (typeof factory !== 'function') {
            container.textContent = ADDON_MISSING_MESSAGE;
            return;
        }
        const Addon = await factory();
        if (typeof Addon?.renderClientDefaultsEditor !== 'function') {
            container.textContent = ADDON_MISSING_MESSAGE;
            return;
        }
        await Addon.renderClientDefaultsEditor(container);
    } catch (error) {
        container.textContent = `${ADDON_MISSING_MESSAGE} (${error instanceof Error ? error.message : String(error)})`;
    }
}

export default function (view) {
    const statusElement = view.querySelector('[data-status]');
    // Changes run one at a time, so each renders the listing its own answer carries
    let pendingChange = Promise.resolve();

    const setStatus = message => {
        statusElement.textContent = message;
    };

    const render = listing => {
        for (const kindName of Object.keys(KINDS)) {
            const list = view.querySelector(`[data-list="${kindName}"]`);
            list.replaceChildren(...listing[kindName].map(entry => createEntryElement(kindName, entry)));
        }
    };

    /** Queues a change after the pending ones; its result renders, and its failure shows in the status line. */
    const runChange = change => {
        pendingChange = pendingChange
            .then(change)
            .then(({ listing, message }) => {
                if (listing) {
                    render(listing);
                }
                setStatus(message);
            })
            .catch(error => {
                setStatus(error instanceof Error ? error.message : String(error));
            });
    };

    const refresh = () => {
        runChange(async () => ({ listing: await requestListing('GET', LISTING_PATH), message: '' }));
    };

    /** Uploads each chosen file in turn; each one the server refuses is named with the failed check. */
    const upload = (kindName, files) => {
        runChange(async () => {
            const failures = [];
            let listing = null;
            for (const file of files) {
                try {
                    listing = await requestListing('POST', KINDS[kindName].uploadPath(file), file);
                } catch (error) {
                    failures.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            return {
                listing: listing ?? await requestListing('GET', LISTING_PATH),
                message: failures.length === 0 ? `Uploaded ${files.length} file(s).` : `Not uploaded: ${failures.join('; ')}`
            };
        });
    };

    const setEnabled = (kindName, key, enabled) => {
        runChange(async () => ({
            listing: await requestListing(enabled ? 'PUT' : 'DELETE', `${KINDS[kindName].route}/${encodeURIComponent(key)}/${ENABLED_SEGMENT}`),
            message: `${key} ${enabled ? 'enabled' : 'disabled'}.`
        }));
    };

    const remove = (kindName, key) => {
        runChange(async () => ({
            listing: await requestListing('DELETE', `${KINDS[kindName].route}/${encodeURIComponent(key)}`),
            message: `${key} deleted.`
        }));
    };

    view.addEventListener('click', event => {
        const target = event.target instanceof Element ? event.target : null;
        const uploadButton = target?.closest('[data-upload]');
        if (uploadButton) {
            const fileInput = view.querySelector(`[data-files="${uploadButton.dataset.upload}"]`);
            fileInput.value = '';
            fileInput.click();
            return;
        }
        const removeButton = target?.closest('[data-remove-kind]');
        if (removeButton) {
            remove(removeButton.dataset.removeKind, removeButton.dataset.key);
        }
    });

    view.addEventListener('change', event => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) {
            return;
        }
        if (target.dataset.files) {
            const files = Array.from(target.files ?? []);
            if (files.length > 0) {
                upload(target.dataset.files, files);
            }
            return;
        }
        if (target.dataset.enableKind) {
            setEnabled(target.dataset.enableKind, target.dataset.key, target.checked);
        }
    });

    view.addEventListener('viewshow', () => {
        void mountClientDefaultsEditor(view.querySelector('[data-client-defaults]'));
        refresh();
    });
}

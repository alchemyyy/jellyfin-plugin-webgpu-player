import escapeHtml from 'escape-html';

import globalize from 'lib/globalize';

import { DECODER_PACKAGE_FILE_EXTENSION, type DecoderPackage } from 'webgpu-player/decode/packages/DecoderPackage';
import type {
    StoredDecoderPackage,
    StoredDecoderPackageFailure,
    StoredDecoderPackages
} from 'webgpu-player/decode/packages/DecoderPackageStore';

import { addDecoderPackage, loadStoredDecoderPackages, removeDecoderPackage } from '../DecoderPackages';
import type { ServerDecoderPackage, ServerModuleCatalog } from '../ServerModules';
import { HIDDEN_CLASS, setStatus, translateToHTML } from './SettingsPanelHTML';

// The decoders section of the playback settings panel: the decoder packages the user adds in this browser, and the ones the server offers.
// The user's packages live in IndexedDB apart from the settings, and a playback reads them when it starts; a server package downloads when a playback needs it

// The package files the picker offers: WebAssembly modules
const PACKAGE_FILE_TYPES = `${DECODER_PACKAGE_FILE_EXTENSION},application/wasm`;
const LIST_SEPARATOR = ', ';
const FILE_UNSUPPORTED_FAILURE = 'package-file-unsupported';
const STALE_PACKAGE_FAILURE = 'package-stale';

export type DecoderPackageSectionContext = Readonly<{
    cleanupCallbacks: Array<() => void>
    isActive: () => boolean
    panel: HTMLElement
    /** What the server offers, read once as the panel opens; it rejects when the server cannot be reached */
    serverCatalog: Promise<ServerModuleCatalog>
}>;

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function requireSectionElement<ElementType extends Element>(panel: ParentNode, selector: string): ElementType {
    const element = panel.querySelector<ElementType>(selector);
    if (!element) {
        throw new Error(`WebGPU settings panel is missing ${selector}`);
    }
    return element;
}

/** Returns what a package decodes: a video package's codecs and output formats, or an audio package's codecs. */
function describePackage(decoderPackage: DecoderPackage): string {
    if (decoderPackage.kind === 'video') {
        return globalize.translate(
            'WebGPUDecoderPackageVideo',
            decoderPackage.manifest.accepts.codecs.join(LIST_SEPARATOR),
            decoderPackage.manifest.outputFormats.join(LIST_SEPARATOR)
        );
    }
    return globalize.translate('WebGPUDecoderPackageAudio', decoderPackage.manifest.codecs.join(LIST_SEPARATOR));
}

/** Returns a package's entry: its title with its remove button, then its lines. */
function createEntryHTML(id: string, title: string, lines: readonly string[]): string {
    const linesHTML = lines
        .map((line: string): string => `<div class="fieldDescription webgpuSettingsDecoderState">${escapeHtml(line)}</div>`)
        .join('');
    return `
        <div class="webgpuSettingsDecoder">
            <div class="webgpuSettingsDecoderHeader">
                <span class="webgpuSettingsDecoderName">${escapeHtml(title)}</span>
                <button
                    aria-label="${translateToHTML('WebGPURemoveDecoderPackage', title)}"
                    class="webgpuSettingsRemoveDecoder"
                    data-remove-decoder="${escapeHtml(id)}"
                    is="paper-icon-button-light"
                    title="${translateToHTML('WebGPURemoveDecoderPackage', title)}"
                    type="button"
                ><span class="material-icons delete" aria-hidden="true"></span></button>
            </div>
            ${linesHTML}
        </div>`;
}

function createPackageHTML(stored: StoredDecoderPackage): string {
    return createEntryHTML(stored.decoderPackage.id, stored.decoderPackage.name, [ describePackage(stored.decoderPackage), stored.fileName ]);
}

/** Returns the entry of a stored package that no longer loads, as after an engine update tightened a check, so it can be removed. */
function createFailureHTML(failure: StoredDecoderPackageFailure): string {
    return createEntryHTML(failure.id, failure.fileName, [
        globalize.translate('WebGPUDecoderPackageUnusable', `${STALE_PACKAGE_FAILURE}: ${failure.detail}`)
    ]);
}

/** Returns the decoders section's HTML: the help, the package list, and the add button. */
export function createDecoderPackageSectionHTML(): string {
    return `
        <section class="webgpuSettingsSection" aria-labelledby="webgpu-decoders-title">
            <h3 class="webgpuSettingsSectionTitle" id="webgpu-decoders-title">
                ${translateToHTML('WebGPUDecoders')}
            </h3>
            <div class="fieldDescription">${translateToHTML('WebGPUDecoderPackagesHelp')}</div>
            <div class="fieldDescription" data-server-decoders></div>
            <div class="webgpuSettingsDecoders" data-decoder-packages></div>
            <input
                accept="${PACKAGE_FILE_TYPES}"
                class="${HIDDEN_CLASS}"
                data-decoder-package-files
                multiple
                type="file"
            />
            <div aria-live="polite" class="webgpuSettingsStatus" data-decoder-status role="status"></div>
            <div class="webgpuSettingsButtonRow">
                <button
                    class="raised webgpuSettingsAddDecoders"
                    is="emby-button"
                    type="button"
                >${translateToHTML('WebGPUAddDecoderPackages')}</button>
            </div>
        </section>`;
}

/** Binds the decoders section's controls; each change stores at once and applies from the next playback. */
export function bindDecoderPackageSection(context: DecoderPackageSectionContext): void {
    const { panel } = context;
    const serverDecoders = requireSectionElement<HTMLElement>(panel, '[data-server-decoders]');
    const packageList = requireSectionElement<HTMLElement>(panel, '[data-decoder-packages]');
    const packageFileInput = requireSectionElement<HTMLInputElement>(panel, '[data-decoder-package-files]');
    const statusElement = requireSectionElement<HTMLElement>(panel, '[data-decoder-status]');
    const addPackagesButton = requireSectionElement<HTMLButtonElement>(panel, '.webgpuSettingsAddDecoders');
    // Operations run one at a time, so a list read never interleaves with a store change
    let pendingOperation: Promise<void> = Promise.resolve();
    let pendingOperationCount = 0;

    const render = (stored: StoredDecoderPackages): void => {
        packageList.innerHTML = [
            ...stored.packages.map(createPackageHTML),
            ...stored.failures.map(createFailureHTML)
        ].join('');
    };

    const describeList = (stored: StoredDecoderPackages): string => {
        const count = stored.packages.length + stored.failures.length;
        return count === 0 ?
            globalize.translate('WebGPUDecoderPackagesNone') :
            globalize.translate('WebGPUDecoderPackagesSummary', count);
    };

    /** Reads the stored packages into the list; the notice, when there is one, replaces the list's summary. */
    const refresh = async (notice: string | null): Promise<void> => {
        let stored: StoredDecoderPackages;
        try {
            stored = await loadStoredDecoderPackages();
        } catch (error) {
            if (context.isActive()) {
                const failure = globalize.translate('WebGPUDecoderPackagesStorageFailed', getErrorMessage(error));
                setStatus(statusElement, notice === null ? failure : globalize.translate('WebGPUJoinedSentences', notice, failure));
            }
            return;
        }
        if (!context.isActive()) {
            return;
        }
        render(stored);
        setStatus(statusElement, notice ?? describeList(stored));
    };

    /** Queues an operation after the pending ones; the add button waits for the queue to empty. */
    const runOperation = (operation: () => Promise<void>): void => {
        pendingOperationCount += 1;
        addPackagesButton.disabled = true;
        pendingOperation = pendingOperation
            .then(operation)
            .catch((error: unknown): void => {
                console.warn(`WebGPU decoder packages: ${getErrorMessage(error)}`);
            })
            .finally((): void => {
                pendingOperationCount -= 1;
                addPackagesButton.disabled = pendingOperationCount > 0;
            });
    };

    /** Stores each chosen file the engine accepts; each one it refuses is named in the notice with the failed check. */
    const addPackageFiles = async (chosenFiles: readonly File[]): Promise<void> => {
        const failures: string[] = [];
        for (const chosenFile of chosenFiles) {
            // The extension check comes before the read, so a mistaken pick, such as a media file, is never read
            if (!chosenFile.name.toLowerCase().endsWith(DECODER_PACKAGE_FILE_EXTENSION)) {
                failures.push(globalize.translate('WebGPUDecoderPackageNotAdded', chosenFile.name, FILE_UNSUPPORTED_FAILURE));
                continue;
            }
            try {
                await addDecoderPackage(chosenFile.name, await chosenFile.arrayBuffer());
            } catch (error) {
                failures.push(globalize.translate('WebGPUDecoderPackageNotAdded', chosenFile.name, getErrorMessage(error)));
            }
        }
        await refresh(failures.length === 0 ? null : failures.join(' '));
    };

    const removePackage = async (id: string): Promise<void> => {
        let failure: string | null = null;
        try {
            await removeDecoderPackage(id);
        } catch (error) {
            failure = globalize.translate('WebGPUDecoderPackagesStorageFailed', getErrorMessage(error));
        }
        await refresh(failure);
    };

    const onAddPackages = (): void => {
        packageFileInput.value = '';
        packageFileInput.click();
    };

    const onPackageFilesChosen = (): void => {
        const chosenFiles = Array.from(packageFileInput.files ?? []);
        if (chosenFiles.length > 0) {
            runOperation((): Promise<void> => addPackageFiles(chosenFiles));
        }
    };

    const onPackageListClick = (event: Event): void => {
        const target = event.target;
        const removeButton = target instanceof Element ? target.closest<HTMLElement>('[data-remove-decoder]') : null;
        const id = removeButton?.dataset.removeDecoder;
        if (id !== undefined) {
            runOperation((): Promise<void> => removePackage(id));
        }
    };

    const listeners: Array<[EventTarget, string, (event: Event) => void]> = [
        [ addPackagesButton, 'click', onAddPackages ],
        [ packageFileInput, 'change', onPackageFilesChosen ],
        [ packageList, 'click', onPackageListClick ]
    ];
    for (const [ target, type, listener ] of listeners) {
        target.addEventListener(type, listener);
    }
    context.cleanupCallbacks.push((): void => {
        for (const [ target, type, listener ] of listeners) {
            target.removeEventListener(type, listener);
        }
    });

    runOperation((): Promise<void> => refresh(null));

    // The server's packages are named only; a playback downloads the one it needs
    void context.serverCatalog.then((catalog: ServerModuleCatalog): void => {
        if (!context.isActive()) {
            return;
        }
        const names = catalog.decoderPackages.map((entry: ServerDecoderPackage): string => entry.name);
        setStatus(serverDecoders, names.length === 0 ?
            globalize.translate('WebGPUServerDecodersNone') :
            globalize.translate('WebGPUServerDecoders', names.join(LIST_SEPARATOR)));
    }, (error: unknown): void => {
        if (context.isActive()) {
            setStatus(serverDecoders, globalize.translate('WebGPUServerDecodersUnavailable', getErrorMessage(error)));
        }
    });
}

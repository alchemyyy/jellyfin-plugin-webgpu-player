import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlanReport } from 'webgpu-player/presentation/passes/PassTypes';
import { createHDRToSDRRenderSettings } from 'webgpu-player/presentation/RenderSettings';
import type { PresentationPresetFile } from 'webgpu-player/presentation/WebGPUPresenter';
import type WebGPUPlayer from 'addons/webGPUPlayer/WebGPUPlayer';
import {
    createDefaultWebGPUUserSettings,
    MAXIMUM_PRESENTATION_FILE_COUNT,
    MAXIMUM_PRESENTATION_PASS_SOURCE_LENGTH,
    type StoredPresentationFile,
    type WebGPUUserSettings
} from 'addons/webGPUPlayer/WebGPUUserSettings';
import {
    CUSTOM_AUDIO_DOWNMIX_ALGORITHMS,
    DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM
} from 'webgpu-player/audio/processing/CustomAudioDownmixAlgorithm';
import { translateSourceString } from '../host/globalizeMock';
import { installIndexedDBFake } from '../indexedDBFake';
import {
    BLANK_PASS_SOURCE,
    INVERT_PASS_NAME,
    INVERT_PASS_SOURCE,
    MISSING_SHAPE_PASS_NAME,
    MISSING_SHAPE_PASS_SOURCE,
    SATURATION_PARAMETER_DEFAULT,
    SATURATION_PARAMETER_MAXIMUM,
    SATURATION_PARAMETER_MINIMUM,
    SATURATION_PARAMETER_NAME,
    SATURATION_PASS_NAME,
    SATURATION_PASS_SOURCE,
    STORED_SATURATION
} from '../presentationPassSources';

type AudioOutputSnapshotMock = {
    activeDeviceId: string | null
    devices: Array<{ deviceId: string, label: string }>
    messageCode: string
    pickerAvailable: boolean
    selectedDeviceAvailability: 'active' | 'available' | 'unavailable' | 'unknown'
    selectedDeviceId: string | null
    status: string
};

const storageMockState = vi.hoisted(() => ({
    audioDownmixAlgorithm: 'standard-lo-ro',
    // Makes local storage refuse writes, as a full quota does
    refusedWriteError: null as DOMException | null,
    value: null as string | null
}));

const hostCommandMockState = vi.hoisted(() => ({
    // Playback info toggles the video OSD runs once its dynamic import of the overlay module resolves
    pendingPlaybackInfoToggles: [] as Array<() => void>
}));

const audioOutputManagerMockState = vi.hoisted(() => {
    const listeners = new Set<(snapshot: AudioOutputSnapshotMock) => void>();
    return {
        cancelCount: 0,
        listeners,
        pickerRevision: 0,
        redetectCount: 0,
        requestPromise: null as Promise<string | null> | null,
        requestResult: null as string | null,
        snapshot: {
            activeDeviceId: null,
            devices: [] as Array<{ deviceId: string, label: string }>,
            messageCode: 'default-saved',
            pickerAvailable: false,
            selectedDeviceAvailability: 'unknown',
            selectedDeviceId: null as string | null,
            status: 'default'
        } as AudioOutputSnapshotMock
    };
});

// What the server offers the panel when it opens: a catalog, or the failure its read rejects with; and each pass file's source by name
const serverModuleMockState = vi.hoisted(() => ({
    catalog: { decoderPackages: [], passes: [] } as {
        decoderPackages: Array<Record<string, unknown>>
        passes: Array<{ byteLength: number, contentHash: string, fileName: string, passNames: string[] }>
    },
    catalogFailure: null as string | null,
    passSources: new Map<string, string>()
}));

vi.mock('addons/webGPUPlayer/ServerModules', () => ({
    fetchServerPassSource: vi.fn((fileName: string): Promise<string> => {
        const source = serverModuleMockState.passSources.get(fileName);
        return source === undefined ?
            Promise.reject(new Error(`server-request-failed: WebGPUPlayer/Passes/${fileName} HTTP 404`)) :
            Promise.resolve(source);
    }),
    loadServerModuleCatalog: vi.fn(() => (serverModuleMockState.catalogFailure === null ?
        Promise.resolve(serverModuleMockState.catalog) :
        Promise.reject(new Error(serverModuleMockState.catalogFailure))))
}));

vi.mock('components/layoutManager', () => ({
    default: { tv: false }
}));

// Shortened texts for the audio output statuses these tests match; every other key renders its source string
vi.mock('lib/globalize', async () => {
    // The factory runs before the module's imports, so it loads the source strings itself
    const globalizeMock = await import('../host/globalizeMock');
    const translations: Record<string, string> = {
        WebGPUAudioOutputDescription: 'System default follows operating-system output changes.',
        WebGPUAudioOutputStatusDefaultSaved: 'The system default audio output is saved.',
        WebGPUAudioOutputStatusPickerNotAllowed: 'Audio output selection is blocked.',
        WebGPUAudioOutputStatusSelectedEnumerationFailed: 'Available outputs could not be refreshed; the selected output remains active.',
        WebGPUAudioOutputStatusSelectedSaved: 'The selected audio output is saved.',
        WebGPUAudioOutputStatusSelectedUnavailableDefault: 'The saved output is unavailable; using the system default.'
    };
    return {
        default: {
            translate: (key: string, ...values: Array<string | number>): string => (
                translations[key] ?? globalizeMock.translateSourceString(key, ...values)
            )
        }
    };
});

// WebGPUUserSettings persists through the host user settings, which the add-on build redirects to its shim
vi.mock('scripts/settings/userSettings', () => ({
    currentSettings: {
        get: vi.fn((): string | null => storageMockState.value),
        set: vi.fn((_name: string, value: string): void => {
            if (storageMockState.refusedWriteError) {
                throw storageMockState.refusedWriteError;
            }
            storageMockState.value = value;
        })
    }
}));

// The dialog reads the downmix algorithm from the add-on shim directly
vi.mock('addons/webGPUPlayer/shims/userSettings', () => ({
    webGPUAudioDownmixAlgorithm: vi.fn((value?: string): string => {
        if (value !== undefined) {
            storageMockState.audioDownmixAlgorithm = value;
        }
        return storageMockState.audioDownmixAlgorithm;
    })
}));

vi.mock('elements/emby-button/emby-button', () => ({}));
vi.mock('elements/emby-button/paper-icon-button-light', () => ({}));
vi.mock('elements/emby-checkbox/emby-checkbox', () => ({}));
vi.mock('elements/emby-input/emby-input', () => ({}));
vi.mock('elements/emby-select/emby-select', () => ({}));
vi.mock('elements/emby-slider/emby-slider', () => ({}));
vi.mock('material-design-icons-iconfont', () => ({}));
vi.mock('addons/webGPUPlayer/ui/WebGPUPlaybackSettingsDialog.scss', () => ({}));
vi.mock('webgpu-player/audio/output/WebGPUAudioOutputManager', () => ({
    getWebGPUAudioOutputManager: (): object => ({
        cancelAudioOutputSelectionRequest: vi.fn((): void => {
            audioOutputManagerMockState.cancelCount += 1;
            audioOutputManagerMockState.pickerRevision += 1;
        }),
        getSnapshot: vi.fn(() => ({
            ...audioOutputManagerMockState.snapshot,
            devices: audioOutputManagerMockState.snapshot.devices.map(device => ({ ...device }))
        })),
        redetectAudioOutputs: vi.fn((): Promise<void> => {
            audioOutputManagerMockState.redetectCount += 1;
            return Promise.resolve();
        }),
        requestAudioOutputSelection: vi.fn((): Promise<string | null> => {
            const requestRevision = audioOutputManagerMockState.pickerRevision + 1;
            audioOutputManagerMockState.pickerRevision = requestRevision;
            const requestPromise = audioOutputManagerMockState.requestPromise
                ?? Promise.resolve(audioOutputManagerMockState.requestResult);
            return requestPromise.then((deviceId): string | null => (
                audioOutputManagerMockState.pickerRevision === requestRevision ?
                    deviceId :
                    null
            )).catch((): null => {
                if (audioOutputManagerMockState.pickerRevision === requestRevision) {
                    audioOutputManagerMockState.snapshot.messageCode = 'picker-not-allowed';
                    audioOutputManagerMockState.snapshot.status = 'error';
                    for (const listener of audioOutputManagerMockState.listeners) {
                        listener(audioOutputManagerMockState.snapshot);
                    }
                }
                return null;
            });
        }),
        setSelectedDeviceId: vi.fn((deviceId: string | null): Promise<void> => {
            audioOutputManagerMockState.pickerRevision += 1;
            audioOutputManagerMockState.snapshot.selectedDeviceId = deviceId;
            audioOutputManagerMockState.snapshot.activeDeviceId = deviceId;
            audioOutputManagerMockState.snapshot.selectedDeviceAvailability = deviceId ?
                'active' :
                'unknown';
            audioOutputManagerMockState.snapshot.status = deviceId ? 'selected' : 'default';
            audioOutputManagerMockState.snapshot.messageCode = deviceId ?
                'selected-active' :
                'default-active';
            for (const listener of audioOutputManagerMockState.listeners) {
                listener({
                    ...audioOutputManagerMockState.snapshot,
                    devices: audioOutputManagerMockState.snapshot.devices.map(
                        device => ({ ...device })
                    )
                });
            }
            return Promise.resolve();
        }),
        subscribe: vi.fn((listener: (snapshot: typeof audioOutputManagerMockState.snapshot) => void) => {
            audioOutputManagerMockState.listeners.add(listener);
            listener(audioOutputManagerMockState.snapshot);
            return (): void => {
                audioOutputManagerMockState.listeners.delete(listener);
            };
        })
    })
}));

// The video OSD answers togglestats by creating the playback info overlay, and later by toggling its hide class
vi.mock('scripts/inputManager', () => ({
    handleCommand: vi.fn((command: string): void => {
        if (command !== 'togglestats') {
            return;
        }
        hostCommandMockState.pendingPlaybackInfoToggles.push((): void => {
            const playbackInfo = document.querySelector<HTMLElement>('.playerStats');
            if (!playbackInfo) {
                const createdPlaybackInfo = document.createElement('div');
                createdPlaybackInfo.classList.add('playerStats');
                document.body.appendChild(createdPlaybackInfo);
                return;
            }
            playbackInfo.classList.toggle('hide');
        });
    })
}));

import { handleCommand } from 'scripts/inputManager';
import { addPassSource } from 'addons/webGPUPlayer/PresentationPassStore';
import {
    showWebGPUPlaybackSettingsPanel,
    toggleWebGPUPlaybackSettingsPanel
} from 'addons/webGPUPlayer/ui/WebGPUPlaybackSettingsDialog';
import {
    configureCapabilityProbeStore,
    getDefaultCapabilityProbeStore,
    readStoredCapabilityProbeVerdictState
} from 'webgpu-player/capability/CapabilityProbeStore';

type AnimationFrameHarness = {
    callbacks: Map<number, FrameRequestCallback>
    nextIdentifier: number
};

// The viewport size and the bounds the placement tests report for the panel, playback info, and the OSD controls
type PlacementHarness = {
    OSDControlsBounds: DOMRect
    panelLeft: number
    playbackInfoBounds: DOMRect
    viewportHeight: number
    viewportWidth: number
};

// The panel's size and default top at a 16px font
const PLACEMENT_PANEL_DEFAULT_TOP = 80;
const PLACEMENT_PANEL_HEIGHT = 600;
const PLACEMENT_PANEL_WIDTH = 672;
const PLACEMENT_STYLE_ATTRIBUTE = 'data-placement-harness';

function requirePanelElement<ElementType extends Element>(
    panel: HTMLElement,
    selector: string
): ElementType {
    const element = panel.querySelector<ElementType>(selector);
    if (!element) {
        throw new Error(`Expected panel element ${selector}`);
    }
    return element;
}

// The panel's audio status texts, verbatim from the source strings
const AUDIO_DOWNMIX_LIVE_STATUS =
    'Downmix gains applied live and saved for the active WebGPU stereo downmix.';
const AUDIO_DOWNMIX_PENDING_STATUS =
    'Saved. No active compatible WebGPU stereo downmix accepted the live gain change; '
    + 'the gains will apply to the next compatible client-decoded downmix.';
const AUDIO_OUTPUT_LAYOUT_APPLYING_STATUS = 'Switching the active WebGPU client-decoded audio...';
const AUDIO_OUTPUT_LAYOUT_LIVE_STATUS =
    'Applied to the active WebGPU client-decoded audio; audio pauses briefly while it switches.';
const AUDIO_OUTPUT_LAYOUT_PENDING_STATUS =
    'No active WebGPU client-decoded audio; it applies to the next client-decoded playback.';

/** Builds the status a force stereo or downmix algorithm change shows. */
function createLayoutChangeStatus(layoutStatus: string): string {
    return `Saved. ${layoutStatus} Downmix gains are unchanged.`;
}

/** Resolves once every queued microtask has run, such as a settled layout status update. */
function flushMicrotasks(): Promise<void> {
    return new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, 0);
    });
}

/** Runs the host's pending playback info toggles in request order, then lets the panel's observers react. */
async function runHostPlaybackInfoToggles(): Promise<void> {
    const toggles = hostCommandMockState.pendingPlaybackInfoToggles.splice(0);
    for (const toggle of toggles) {
        toggle();
    }
    await flushMicrotasks();
}

function createBounds(left: number, top: number, width: number, height: number): DOMRect {
    return {
        bottom: top + height,
        height,
        left,
        right: left + width,
        top,
        width,
        x: left,
        y: top
    } as DOMRect;
}

/**
 * Adds the video OSD page with its bottom controls, sets the panel's font size, and reports the harness's viewport size and bounds, with the panel's top following its --webgpu-settings-top property.
 */
function installPlacementHarness(harness: PlacementHarness): void {
    const playbackPage = document.createElement('div');
    playbackPage.id = 'videoOsdPage';
    playbackPage.innerHTML = '<div class="videoOsdBottom videoOsdBottom-maincontrols">'
        + '<div class="osdControls"></div></div>';
    document.body.appendChild(playbackPage);
    const panelFontStyle = document.createElement('style');
    panelFontStyle.setAttribute(PLACEMENT_STYLE_ATTRIBUTE, '');
    panelFontStyle.textContent = '.webgpuSettingsPanel { font-size: 16px; }';
    document.head.appendChild(panelFontStyle);
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(
        (): number => harness.viewportHeight
    );
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(
        (): number => harness.viewportWidth
    );
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
        function (this: Element): DOMRect {
            if (this.classList.contains('osdControls')) {
                return harness.OSDControlsBounds;
            }
            if (this.classList.contains('playerStats')) {
                return harness.playbackInfoBounds;
            }
            if (this instanceof HTMLElement && this.classList.contains('webgpuSettingsPanel')) {
                const panelTop = parseFloat(this.style.getPropertyValue('--webgpu-settings-top'));
                return createBounds(
                    harness.panelLeft,
                    Number.isNaN(panelTop) ? PLACEMENT_PANEL_DEFAULT_TOP : panelTop,
                    PLACEMENT_PANEL_WIDTH,
                    PLACEMENT_PANEL_HEIGHT
                );
            }
            return createBounds(0, 0, 0, 0);
        }
    );
}

// One default button per setting the panel offers, HDR output, deinterlacing, and GPU decode slicing included
const DEFAULT_SETTING_BUTTON_COUNT = 20;

// What a player reports before any shader pass runs
const EMPTY_PLAN_REPORT: PlanReport = { activePasses: [], inactivePasses: [] };

// The step of an f32 parameter's input
const FLOAT_PARAMETER_STEP = 'any';
// A saturation the user types, inside the declared range
const CHANGED_SATURATION = 1.5;
// Rejection details and failures the presentation tests report, and the states the panel shows for them
const INVERT_REJECTION_DETAIL = "domain 'display' after OUTPUT";
const DUPLICATE_REJECTION_DETAIL = 'pass 3';
const MISSING_SHAPE_HEADER_FAILURE = "header-invalid: line 1: Missing required directive 'shape'";
const PARAMETER_PENDING_ERROR = `pass-unknown: '${SATURATION_PASS_NAME}'`;
const HDR_OUTPUT_FAILURE = 'no HDR display';
const DEINTERLACE_FAILURE = 'device-lost';
const SATURATION_PASS_FILE_NAME = 'saturation.wgsl';
const INVERT_PASS_FILE_NAME = 'invert.wgsl';
const BLANK_PASS_FILE_NAME = 'blank.wgsl';
// One store for the file, since the pass source store keeps its connection for the page
const indexedDBFake = installIndexedDBFake();
// Where the pass source store keeps the sources, under keys counting up from 1
const PASS_SOURCE_DATABASE_NAME = 'webGPUPlayerPresentation';
const PASS_SOURCE_STORE_NAME = 'passSources';
const FIRST_SOURCE_KEY = 1;
const SECOND_SOURCE_KEY = 2;
// A key the settings hold that the store has no source for
const MISSING_SOURCE_KEY = 99;
const QUOTA_ERROR = new DOMException('The quota has been exceeded', 'QuotaExceededError');
// One file of the saturation pass, then the invert pass, as an mpv-style shader of several passes
const SATURATION_THEN_INVERT_FILE_SOURCE = `${SATURATION_PASS_SOURCE}${INVERT_PASS_SOURCE}`;
const SATURATION_THEN_INVERT_PASS_COUNT = 2;
// Two versions of one server pass file, by their content hashes, and the catalog entries the server offers
const FIRST_SERVER_CONTENT_HASH = 'a'.repeat(64);
const SECOND_SERVER_CONTENT_HASH = 'b'.repeat(64);
const SERVER_SATURATION_PASS = {
    byteLength: SATURATION_PASS_SOURCE.length,
    contentHash: FIRST_SERVER_CONTENT_HASH,
    fileName: SATURATION_PASS_FILE_NAME,
    passNames: [ SATURATION_PASS_NAME ]
};
const SERVER_HEVC_PACKAGE = { codecs: [ 'hevc' ], id: 'hevc', kind: 'video', name: 'HEVC', outputFormats: [ 'I420' ] };
const SERVER_TRUEHD_PACKAGE = { codecs: [ 'truehd', 'mlp' ], id: 'truehd', kind: 'audio', name: 'TrueHD', outputFormats: [] };
const SERVER_UNAVAILABLE_FAILURE = 'server-request-failed: WebGPUPlayer/Catalog HTTP 502';

type PresentationPlayerMethods = Pick<
    WebGPUPlayer,
    'getPresentationPlanReport' | 'setDeinterlaceMode' | 'setHDROutputEnabled' | 'setPresentationParameter' | 'setPresentationPreset'
>;

/** A file the panel lists, as its title and the state text of each of its passes. */
type PassRow = Readonly<{
    name: string
    states: readonly string[]
}>;

/** Builds the presentation calls the panel makes when it opens, which succeed without passes. */
function createPresentationPlayerMethods(): PresentationPlayerMethods {
    return {
        getPresentationPlanReport: vi.fn((): PlanReport => EMPTY_PLAN_REPORT),
        setDeinterlaceMode: vi.fn((): Promise<void> => Promise.resolve()),
        setHDROutputEnabled: vi.fn((): Promise<void> => Promise.resolve()),
        setPresentationParameter: vi.fn(),
        setPresentationPreset: vi.fn((): Promise<PlanReport> => Promise.resolve(EMPTY_PLAN_REPORT))
    };
}

/** Builds a player whose render and audio calls succeed, with the given presentation calls. */
function createPresentationTestPlayer(presentationMethods: PresentationPlayerMethods): WebGPUPlayer {
    return {
        applyAudioOutputSettings: vi.fn((): Promise<boolean> => Promise.resolve(false)),
        getDetectedInputPeakNits: vi.fn(() => 1_000),
        getRenderSettings: vi.fn(() => createHDRToSDRRenderSettings()),
        updateAudioDownmixSettings: vi.fn(() => true),
        updateRenderSettings: vi.fn(() => true),
        ...presentationMethods
    } as unknown as WebGPUPlayer;
}

/** Builds a player whose render and audio calls succeed, for the placement tests. */
function createPlacementTestPlayer(): WebGPUPlayer {
    return createPresentationTestPlayer(createPresentationPlayerMethods());
}

/** Stores the presentation settings the panel loads, the defaults for those not given, beside the stored settings the suite starts from. */
function storePresentation(presentation: Partial<WebGPUUserSettings['presentation']>): void {
    storageMockState.value = JSON.stringify({
        ...JSON.parse(storageMockState.value ?? '{}') as object,
        presentation: { ...createDefaultWebGPUUserSettings().presentation, ...presentation }
    });
}

/** Reads the presentation settings the panel saved. */
function readSavedPresentation(): WebGPUUserSettings['presentation'] {
    return (JSON.parse(storageMockState.value ?? '{}') as WebGPUUserSettings).presentation;
}

/** Reads each file the panel lists, in order. */
function readPassRows(panel: HTMLElement): PassRow[] {
    const rows: PassRow[] = [];
    for (const passElement of panel.querySelectorAll<HTMLElement>('.webgpuSettingsPass')) {
        rows.push({
            name: requirePanelElement<HTMLElement>(passElement, '.webgpuSettingsPassName').textContent,
            states: Array.from(passElement.querySelectorAll<HTMLElement>('.webgpuSettingsPassState'), (state: HTMLElement): string => state.textContent)
        });
    }
    return rows;
}

/** Reads the sources the pass source store holds, by key. */
function readStoredSources(): ReadonlyMap<number, unknown> {
    return indexedDBFake.readStore(PASS_SOURCE_DATABASE_NAME, PASS_SOURCE_STORE_NAME);
}

/** Returns each saved file's store key. */
function readSavedSourceKeys(): number[] {
    return readSavedPresentation().files.map((file: StoredPresentationFile): number => file.sourceKey);
}

/** Opens the panel and lets it read the shader sources, which its pass list waits for. */
async function openPanelWithSources(player: WebGPUPlayer): Promise<Readonly<{ panel: HTMLElement, panelPromise: Promise<void> }>> {
    const panelPromise = showWebGPUPlaybackSettingsPanel(player);
    const panel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
    await flushMicrotasks();
    return { panel, panelPromise };
}

/** Chooses pass files in the panel's file input, as the file picker would. */
function choosePassFiles(passFileInput: HTMLInputElement, files: readonly File[]): void {
    Object.defineProperty(passFileInput, 'files', { configurable: true, value: files });
    passFileInput.dispatchEvent(new Event('change'));
}

describe('WebGPUPlaybackSettingsPanel', () => {
    let animationFrames: AnimationFrameHarness;

    beforeEach(() => {
        vi.clearAllMocks();
        hostCommandMockState.pendingPlaybackInfoToggles.length = 0;
        audioOutputManagerMockState.cancelCount = 0;
        audioOutputManagerMockState.pickerRevision = 0;
        audioOutputManagerMockState.redetectCount = 0;
        audioOutputManagerMockState.listeners.clear();
        audioOutputManagerMockState.requestPromise = null;
        audioOutputManagerMockState.requestResult = null;
        audioOutputManagerMockState.snapshot = {
            activeDeviceId: null,
            devices: [],
            messageCode: 'default-saved',
            pickerAvailable: false,
            selectedDeviceAvailability: 'unknown',
            selectedDeviceId: null,
            status: 'default'
        };
        while (document.body.firstChild) {
            document.body.removeChild(document.body.firstChild);
        }
        animationFrames = {
            callbacks: new Map<number, FrameRequestCallback>(),
            nextIdentifier: 1
        };
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback): number => {
            const identifier = animationFrames.nextIdentifier;
            animationFrames.nextIdentifier += 1;
            animationFrames.callbacks.set(identifier, callback);
            return identifier;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn((identifier: number): void => {
            animationFrames.callbacks.delete(identifier);
        }));

        const defaults = createDefaultWebGPUUserSettings();
        serverModuleMockState.catalog = { decoderPackages: [], passes: [] };
        serverModuleMockState.catalogFailure = null;
        serverModuleMockState.passSources.clear();
        // The suite unstubs its globals after each test
        indexedDBFake.install();
        indexedDBFake.clear();
        storageMockState.refusedWriteError = null;
        storageMockState.audioDownmixAlgorithm = DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM;
        storageMockState.value = JSON.stringify({
            ...defaults,
            render: {
                automaticInputPeakNits: false,
                settings: createHDRToSDRRenderSettings({
                    toneMapping: { inputPeakNits: 900 }
                })
            }
        });
    });

    afterEach(async () => {
        // A test that fails with its panel open would leave it the module's one active panel, which every later open reuses
        document.querySelector<HTMLButtonElement>('.webgpuSettingsPanel .webgpuSettingsClose')?.click();
        await flushMicrotasks();
        vi.unstubAllGlobals();
        document.documentElement.removeAttribute('dir');
        for (const placementStyle of document.head.querySelectorAll(`[${PLACEMENT_STYLE_ATTRIBUTE}]`)) {
            placementStyle.remove();
        }
    });

    it('reuses one non-modal panel below playback info and restores individual defaults', async () => {
        const playbackInfo = document.createElement('div');
        playbackInfo.classList.add('playerStats');
        playbackInfo.getBoundingClientRect = vi.fn(() => ({
            bottom: 320,
            height: 200,
            left: 24,
            right: 424,
            top: 120,
            width: 400,
            x: 24,
            y: 120
        } as DOMRect));
        document.body.appendChild(playbackInfo);

        const activeRenderSettings = createHDRToSDRRenderSettings({
            toneMapping: { inputPeakNits: 900 }
        });
        const player = {
            applyAudioOutputSettings: vi.fn((): Promise<boolean> => Promise.resolve(true)),
            getDetectedInputPeakNits: vi.fn(() => 4_000),
            getRenderSettings: vi.fn(() => activeRenderSettings),
            updateAudioDownmixSettings: vi.fn(() => true),
            updateRenderSettings: vi.fn(() => true),
            ...createPresentationPlayerMethods()
        } as unknown as WebGPUPlayer;

        const firstOpenPromise = showWebGPUPlaybackSettingsPanel(player);
        const secondOpenPromise = showWebGPUPlaybackSettingsPanel(player);
        expect(secondOpenPromise).toBe(firstOpenPromise);
        const panels = document.querySelectorAll<HTMLElement>('.webgpuSettingsPanel');
        expect(panels).toHaveLength(1);
        const panel = panels[0];
        expect(panel.tagName).toBe('ASIDE');
        expect(panel.style.getPropertyValue('--webgpu-settings-top')).toBe('328px');
        expect(document.querySelector('.dialogBackdrop')).toBeNull();
        expect(document.querySelector('.dialogContainer')).toBeNull();
        const defaultButtons = Array.from(
            panel.querySelectorAll<HTMLButtonElement>('[data-default-setting]')
        );
        expect(defaultButtons).toHaveLength(DEFAULT_SETTING_BUTTON_COUNT);
        expect(new Set(defaultButtons.map(button => button.dataset.defaultSetting)).size).toBe(DEFAULT_SETTING_BUTTON_COUNT);
        // Each is an icon, named by its label and tooltip
        expect(defaultButtons.every(button => (
            button.getAttribute('aria-label')?.startsWith('Restore ') === true && button.title === button.getAttribute('aria-label')
        ))).toBe(true);
        expect(requirePanelElement<HTMLInputElement>(
            panel,
            '[data-setting-slider="centerLevel"]'
        ).max).toBe('2');
        expect(requirePanelElement<HTMLInputElement>(
            panel,
            '[data-setting-slider="surroundLevel"]'
        ).max).toBe('2');
        expect(requirePanelElement<HTMLInputElement>(
            panel,
            '[data-setting-slider="outputGain"]'
        ).max).toBe('10');
        expect(requirePanelElement<HTMLInputElement>(
            panel,
            '[data-setting-number="outputGain"]'
        ).max).toBe('10');
        expect(player.updateRenderSettings).toHaveBeenCalledWith(
            expect.objectContaining({
                toneMapping: expect.objectContaining({ inputPeakNits: 900 })
            }),
            false
        );

        const brightnessInput = requirePanelElement<HTMLInputElement>(
            panel,
            '[data-setting-number="brightness"]'
        );
        brightnessInput.value = '0.25';
        brightnessInput.dispatchEvent(new Event('change'));

        const automaticInputPeakCheckbox = requirePanelElement<HTMLInputElement>(
            panel,
            '[data-setting-checkbox="automaticInputPeakNits"]'
        );
        automaticInputPeakCheckbox.checked = true;
        automaticInputPeakCheckbox.dispatchEvent(new Event('change'));

        const forceStereoCheckbox = requirePanelElement<HTMLInputElement>(
            panel,
            '[data-setting-checkbox="forceStereoDownmix"]'
        );
        forceStereoCheckbox.checked = true;
        forceStereoCheckbox.dispatchEvent(new Event('change'));

        const pendingCallbacks = Array.from(animationFrames.callbacks.values());
        animationFrames.callbacks.clear();
        for (const callback of pendingCallbacks) {
            callback(0);
        }
        expect(player.updateRenderSettings).toHaveBeenLastCalledWith(
            expect.objectContaining({
                display: expect.objectContaining({ brightness: 0.25 }),
                toneMapping: expect.objectContaining({ inputPeakNits: 4_000 })
            }),
            true
        );

        const savedSettings = JSON.parse(storageMockState.value ?? '{}') as {
            audio?: { forceStereoDownmix?: boolean }
            render?: {
                automaticInputPeakNits?: boolean
                settings?: { display?: { brightness?: number } }
            }
        };
        expect(savedSettings).toMatchObject({
            audio: { forceStereoDownmix: true },
            render: {
                automaticInputPeakNits: true,
                settings: { display: { brightness: 0.25 } }
            }
        });

        const operatorSelect = requirePanelElement<HTMLSelectElement>(
            panel,
            '[data-setting-select="operator"]'
        );
        operatorSelect.value = 'aces';
        operatorSelect.dispatchEvent(new Event('change'));
        automaticInputPeakCheckbox.checked = false;
        automaticInputPeakCheckbox.dispatchEvent(new Event('change'));
        for (const settingKey of [
            'brightness',
            'operator',
            'audioDownmixAlgorithm',
            'automaticInputPeakNits',
            'forceStereoDownmix'
        ]) {
            requirePanelElement<HTMLButtonElement>(
                panel,
                `[data-default-setting="${settingKey}"]`
            ).click();
        }

        const defaultedSettings = JSON.parse(storageMockState.value ?? '{}') as {
            audio?: { forceStereoDownmix?: boolean }
            render?: {
                automaticInputPeakNits?: boolean
                settings?: {
                    display?: { brightness?: number }
                    toneMapping?: { operator?: string }
                }
            }
        };
        // Each restores the plugin's default, whatever it is, over the value the test set
        const defaultSettings = createDefaultWebGPUUserSettings();
        expect(defaultedSettings).toMatchObject({
            audio: { forceStereoDownmix: defaultSettings.audio.forceStereoDownmix },
            render: {
                automaticInputPeakNits: defaultSettings.render.automaticInputPeakNits,
                settings: {
                    display: { brightness: defaultSettings.render.settings.display.brightness },
                    toneMapping: { operator: defaultSettings.render.settings.toneMapping.operator }
                }
            }
        });

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await firstOpenPromise;
        expect(panel.isConnected).toBe(false);

        const thirdOpenPromise = showWebGPUPlaybackSettingsPanel(player);
        const reopenedPanel = requirePanelElement<HTMLElement>(
            document.body,
            '.webgpuSettingsPanel'
        );
        expect(reopenedPanel).not.toBe(panel);
        requirePanelElement<HTMLButtonElement>(
            reopenedPanel,
            '.webgpuSettingsClose'
        ).click();
        await thirdOpenPromise;
    });

    it('saves the per-browser playback preferences as restart-required', async () => {
        const player = {
            applyAudioOutputSettings: vi.fn((): Promise<boolean> => Promise.resolve(false)),
            getDetectedInputPeakNits: vi.fn(() => null),
            getRenderSettings: vi.fn(() => createHDRToSDRRenderSettings()),
            updateAudioDownmixSettings: vi.fn(() => true),
            updateRenderSettings: vi.fn(() => true),
            ...createPresentationPlayerMethods()
        } as unknown as WebGPUPlayer;
        type SavedPlayback = { playback?: { enableCustomDecode?: boolean, enableGPUDecodeSlicing?: boolean, enableHDRToneMapping?: boolean } };
        const readSavedPlayback = (): SavedPlayback['playback'] => (
            JSON.parse(storageMockState.value ?? '{}') as SavedPlayback
        ).playback;

        const panelPromise = showWebGPUPlaybackSettingsPanel(player);
        const panel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        const customDecodeCheckbox = requirePanelElement<HTMLInputElement>(
            panel,
            '[data-setting-checkbox="enableCustomDecode"]'
        );
        const HDRToneMappingCheckbox = requirePanelElement<HTMLInputElement>(
            panel,
            '[data-setting-checkbox="enableHDRToneMapping"]'
        );
        const GPUDecodeSlicingCheckbox = requirePanelElement<HTMLInputElement>(
            panel,
            '[data-setting-checkbox="enableGPUDecodeSlicing"]'
        );
        const playbackStatus = requirePanelElement<HTMLElement>(panel, '[data-playback-status]');
        expect(customDecodeCheckbox.checked).toBe(true);
        expect(HDRToneMappingCheckbox.checked).toBe(true);
        expect(HDRToneMappingCheckbox.disabled).toBe(false);
        expect(GPUDecodeSlicingCheckbox.checked).toBe(false);
        expect(GPUDecodeSlicingCheckbox.disabled).toBe(false);

        // HDR tone mapping and GPU decode run only on the custom decode path, so their switches follow custom decode
        customDecodeCheckbox.checked = false;
        customDecodeCheckbox.dispatchEvent(new Event('change'));
        expect(readSavedPlayback()).toEqual({ enableCustomDecode: false, enableGPUDecodeSlicing: false, enableHDRToneMapping: true });
        expect(HDRToneMappingCheckbox.disabled).toBe(true);
        expect(GPUDecodeSlicingCheckbox.disabled).toBe(true);
        expect(playbackStatus.textContent).toContain('restart-required');

        requirePanelElement<HTMLButtonElement>(
            panel,
            '[data-default-setting="enableCustomDecode"]'
        ).click();
        HDRToneMappingCheckbox.checked = false;
        HDRToneMappingCheckbox.dispatchEvent(new Event('change'));
        GPUDecodeSlicingCheckbox.checked = true;
        GPUDecodeSlicingCheckbox.dispatchEvent(new Event('change'));
        expect(readSavedPlayback()).toEqual({ enableCustomDecode: true, enableGPUDecodeSlicing: true, enableHDRToneMapping: false });
        expect(HDRToneMappingCheckbox.disabled).toBe(false);
        expect(GPUDecodeSlicingCheckbox.disabled).toBe(false);

        requirePanelElement<HTMLButtonElement>(
            panel,
            '[data-default-setting="enableGPUDecodeSlicing"]'
        ).click();
        expect(readSavedPlayback()).toEqual({ enableCustomDecode: true, enableGPUDecodeSlicing: false, enableHDRToneMapping: false });
        expect(GPUDecodeSlicingCheckbox.checked).toBe(false);
        GPUDecodeSlicingCheckbox.checked = true;
        GPUDecodeSlicingCheckbox.dispatchEvent(new Event('change'));

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsResetAll').click();
        expect(readSavedPlayback()).toEqual({ enableCustomDecode: true, enableGPUDecodeSlicing: false, enableHDRToneMapping: true });
        expect(HDRToneMappingCheckbox.checked).toBe(true);
        expect(GPUDecodeSlicingCheckbox.checked).toBe(false);

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('clears the stored decoder test results, so the next negotiation probes again', async () => {
        const player = {
            applyAudioOutputSettings: vi.fn((): Promise<boolean> => Promise.resolve(false)),
            getDetectedInputPeakNits: vi.fn(() => null),
            getRenderSettings: vi.fn(() => createHDRToSDRRenderSettings()),
            updateAudioDownmixSettings: vi.fn(() => true),
            updateRenderSettings: vi.fn(() => true),
            ...createPresentationPlayerMethods()
        } as unknown as WebGPUPlayer;
        configureCapabilityProbeStore({ buildKey: 'asset-key-webpack-hash' });
        await getDefaultCapabilityProbeStore().write('native-sdr:hevc', {
            codec: 'hevc',
            codecString: 'hvc1.1.6.L120.90',
            reason: 'decode-output-verified',
            status: 'supported'
        });
        expect(readStoredCapabilityProbeVerdictState()?.probes).toEqual([ 'native-sdr:hevc' ]);

        const panelPromise = showWebGPUPlaybackSettingsPanel(player);
        const panel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClearProbeCache').click();

        expect(readStoredCapabilityProbeVerdictState()).toBeNull();
        expect(requirePanelElement<HTMLElement>(panel, '[data-playback-status]').textContent).toContain('tests this browser');
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
        configureCapabilityProbeStore({ buildKey: '' });
    });

    it('focuses the first opened panel and restores its invoking element on close', async () => {
        const invokingButton = document.createElement('button');
        invokingButton.type = 'button';
        document.body.appendChild(invokingButton);
        invokingButton.focus();
        const player = {
            applyAudioOutputSettings: vi.fn((): Promise<boolean> => Promise.resolve(false)),
            getDetectedInputPeakNits: vi.fn(() => 1_000),
            getRenderSettings: vi.fn(() => createHDRToSDRRenderSettings()),
            updateAudioDownmixSettings: vi.fn(() => true),
            updateRenderSettings: vi.fn(() => true),
            ...createPresentationPlayerMethods()
        } as unknown as WebGPUPlayer;

        const panelPromise = showWebGPUPlaybackSettingsPanel(player);
        const panel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        const closeButton = requirePanelElement<HTMLButtonElement>(
            panel,
            '.webgpuSettingsClose'
        );
        expect(document.activeElement).toBe(closeButton);

        closeButton.click();
        await panelPromise;

        expect(document.activeElement).toBe(invokingButton);
        expect(audioOutputManagerMockState.cancelCount).toBe(1);
    });

    it('toggles the panel closed and open again from the invoking button', async () => {
        const invokingButton = document.createElement('button');
        invokingButton.type = 'button';
        document.body.appendChild(invokingButton);
        invokingButton.focus();
        const player = {
            applyAudioOutputSettings: vi.fn((): Promise<boolean> => Promise.resolve(false)),
            getDetectedInputPeakNits: vi.fn(() => 1_000),
            getRenderSettings: vi.fn(() => createHDRToSDRRenderSettings()),
            updateAudioDownmixSettings: vi.fn(() => true),
            updateRenderSettings: vi.fn(() => true),
            ...createPresentationPlayerMethods()
        } as unknown as WebGPUPlayer;

        const openPromise = toggleWebGPUPlaybackSettingsPanel(player);
        const panel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');

        const closePromise = toggleWebGPUPlaybackSettingsPanel(player);
        expect(closePromise).toBe(openPromise);
        expect(panel.isConnected).toBe(false);
        await closePromise;
        expect(document.activeElement).toBe(invokingButton);

        // A toggle right after closing opens a new panel instead of closing the old one again
        const reopenPromise = toggleWebGPUPlaybackSettingsPanel(player);
        const reopenedPanel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        expect(reopenedPanel).not.toBe(panel);
        expect(document.querySelectorAll('.webgpuSettingsPanel')).toHaveLength(1);
        await expect(toggleWebGPUPlaybackSettingsPanel(player)).resolves.toBeUndefined();
        await reopenPromise;
        expect(reopenedPanel.isConnected).toBe(false);
    });

    it('keeps wheel input over the panel from reaching the OSD volume handler', async () => {
        const player = {
            applyAudioOutputSettings: vi.fn((): Promise<boolean> => Promise.resolve(false)),
            getDetectedInputPeakNits: vi.fn(() => 1_000),
            getRenderSettings: vi.fn(() => createHDRToSDRRenderSettings()),
            updateAudioDownmixSettings: vi.fn(() => true),
            updateRenderSettings: vi.fn(() => true),
            ...createPresentationPlayerMethods()
        } as unknown as WebGPUPlayer;
        // The host's video OSD listens for wheel events on the document in the bubble phase
        const documentWheelListener = vi.fn();
        document.addEventListener('wheel', documentWheelListener);
        try {
            const panelPromise = showWebGPUPlaybackSettingsPanel(player);
            const panel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
            const panelWheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 });
            requirePanelElement<HTMLElement>(panel, '[data-setting-slider="brightness"]').dispatchEvent(panelWheel);

            expect(documentWheelListener).not.toHaveBeenCalled();
            // The panel itself still scrolls
            expect(panelWheel.defaultPrevented).toBe(false);

            requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
            await panelPromise;
            document.body.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 }));
            expect(documentWheelListener).toHaveBeenCalledOnce();
        } finally {
            document.removeEventListener('wheel', documentWheelListener);
        }
    });

    it('ends above the OSD controls and opens playback info beside it until the panel closes', async () => {
        const harness: PlacementHarness = {
            OSDControlsBounds: createBounds(0, 900, 1920, 150),
            panelLeft: 24,
            playbackInfoBounds: createBounds(704, 80, 400, 300),
            viewportHeight: 1080,
            viewportWidth: 1920
        };
        installPlacementHarness(harness);
        const player = createPlacementTestPlayer();

        const panelPromise = toggleWebGPUPlaybackSettingsPanel(player);
        const panel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        expect(handleCommand).toHaveBeenCalledTimes(1);
        expect(handleCommand).toHaveBeenLastCalledWith('togglestats');
        // 900 - 8 - 80
        expect(panel.style.getPropertyValue('--webgpu-settings-max-height')).toBe('812px');

        await runHostPlaybackInfoToggles();
        const playbackInfo = requirePanelElement<HTMLElement>(document.body, '.playerStats');
        expect(playbackInfo.classList.contains('webgpuSettingsPlaybackInfo')).toBe(true);
        // The panel's right edge, 24 + 672, plus the gap
        expect(playbackInfo.style.getPropertyValue('--webgpu-playback-info-offset')).toBe('704px');
        expect(panel.style.getPropertyValue('--webgpu-settings-top')).toBe('');

        // Hidden OSD controls measure empty, so the panel keeps the 180px they reserve at the bottom edge
        harness.OSDControlsBounds = createBounds(0, 0, 0, 0);
        harness.viewportHeight = 900;
        window.dispatchEvent(new Event('resize'));
        // 900 - 180 - 8 - 80
        expect(panel.style.getPropertyValue('--webgpu-settings-max-height')).toBe('632px');
        harness.OSDControlsBounds = createBounds(0, 700, 1920, 200);
        window.dispatchEvent(new Event('resize'));
        // 700 - 8 - 80
        expect(panel.style.getPropertyValue('--webgpu-settings-max-height')).toBe('612px');

        await toggleWebGPUPlaybackSettingsPanel(player);
        await panelPromise;
        expect(handleCommand).toHaveBeenCalledTimes(2);
        expect(playbackInfo.classList.contains('webgpuSettingsPlaybackInfo')).toBe(false);
        expect(playbackInfo.style.getPropertyValue('--webgpu-playback-info-offset')).toBe('');
        await runHostPlaybackInfoToggles();
        expect(playbackInfo.classList.contains('hide')).toBe(true);
    });

    it('places playback info beside the panel from the right edge in a right-to-left layout', async () => {
        document.documentElement.setAttribute('dir', 'rtl');
        installPlacementHarness({
            OSDControlsBounds: createBounds(0, 900, 1920, 150),
            panelLeft: 1920 - 24 - PLACEMENT_PANEL_WIDTH,
            playbackInfoBounds: createBounds(816, 80, 400, 300),
            viewportHeight: 1080,
            viewportWidth: 1920
        });

        const panelPromise = showWebGPUPlaybackSettingsPanel(createPlacementTestPlayer());
        const panel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        await runHostPlaybackInfoToggles();
        const playbackInfo = requirePanelElement<HTMLElement>(document.body, '.playerStats');
        expect(playbackInfo.classList.contains('webgpuSettingsPlaybackInfo')).toBe(true);
        // The panel's left edge is 24 + 672 from the right edge, plus the gap
        expect(playbackInfo.style.getPropertyValue('--webgpu-playback-info-offset')).toBe('704px');

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('moves the panel below playback info when the viewport has no room beside it', async () => {
        // 900 - (24 + 672) leaves 204px beside the panel, short of 22em at 16px
        installPlacementHarness({
            OSDControlsBounds: createBounds(0, 700, 900, 150),
            panelLeft: 24,
            playbackInfoBounds: createBounds(24, 80, 400, 300),
            viewportHeight: 850,
            viewportWidth: 900
        });

        const panelPromise = showWebGPUPlaybackSettingsPanel(createPlacementTestPlayer());
        const panel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        await runHostPlaybackInfoToggles();
        const playbackInfo = requirePanelElement<HTMLElement>(document.body, '.playerStats');
        expect(playbackInfo.classList.contains('webgpuSettingsPlaybackInfo')).toBe(false);
        // 80 + 300 + 8, then 700 - 8 - 388
        expect(panel.style.getPropertyValue('--webgpu-settings-top')).toBe('388px');
        expect(panel.style.getPropertyValue('--webgpu-settings-max-height')).toBe('304px');

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('leaves playback info that was already showing open after the panel closes', async () => {
        installPlacementHarness({
            OSDControlsBounds: createBounds(0, 900, 1920, 150),
            panelLeft: 24,
            playbackInfoBounds: createBounds(704, 80, 400, 300),
            viewportHeight: 1080,
            viewportWidth: 1920
        });
        const playbackInfo = document.createElement('div');
        playbackInfo.classList.add('playerStats');
        document.body.appendChild(playbackInfo);

        const panelPromise = showWebGPUPlaybackSettingsPanel(createPlacementTestPlayer());
        const panel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        expect(handleCommand).not.toHaveBeenCalled();
        expect(playbackInfo.classList.contains('webgpuSettingsPlaybackInfo')).toBe(true);

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
        expect(handleCommand).not.toHaveBeenCalled();
        expect(playbackInfo.classList.contains('webgpuSettingsPlaybackInfo')).toBe(false);
        expect(playbackInfo.classList.contains('hide')).toBe(false);
    });

    it('keeps playback info closed after the user closes it while the panel is open', async () => {
        installPlacementHarness({
            OSDControlsBounds: createBounds(0, 900, 1920, 150),
            panelLeft: 24,
            playbackInfoBounds: createBounds(704, 80, 400, 300),
            viewportHeight: 1080,
            viewportWidth: 1920
        });

        const panelPromise = showWebGPUPlaybackSettingsPanel(createPlacementTestPlayer());
        const panel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        await runHostPlaybackInfoToggles();
        const playbackInfo = requirePanelElement<HTMLElement>(document.body, '.playerStats');
        // The overlay's close button hides it without a command
        playbackInfo.classList.add('hide');
        await flushMicrotasks();
        expect(playbackInfo.classList.contains('webgpuSettingsPlaybackInfo')).toBe(false);

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
        expect(handleCommand).toHaveBeenCalledTimes(1);
    });

    it('undoes its playback info request when the panel closes before the host shows it', async () => {
        installPlacementHarness({
            OSDControlsBounds: createBounds(0, 900, 1920, 150),
            panelLeft: 24,
            playbackInfoBounds: createBounds(704, 80, 400, 300),
            viewportHeight: 1080,
            viewportWidth: 1920
        });
        const player = createPlacementTestPlayer();

        const panelPromise = toggleWebGPUPlaybackSettingsPanel(player);
        await toggleWebGPUPlaybackSettingsPanel(player);
        await panelPromise;
        expect(handleCommand).toHaveBeenCalledTimes(2);

        // The host runs both toggles once its overlay module loads: the first shows playback info, the second hides it
        await runHostPlaybackInfoToggles();
        const playbackInfo = requirePanelElement<HTMLElement>(document.body, '.playerStats');
        expect(playbackInfo.classList.contains('hide')).toBe(true);
        expect(playbackInfo.classList.contains('webgpuSettingsPlaybackInfo')).toBe(false);
    });

    it('applies gains, force stereo, and the downmix algorithm live', async () => {
        const activeRenderSettings = createHDRToSDRRenderSettings();
        const applyAudioOutputSettings = vi.fn((): Promise<boolean> => Promise.resolve(true));
        const updateAudioDownmixSettings = vi.fn(() => true);
        const player = {
            applyAudioOutputSettings,
            getDetectedInputPeakNits: vi.fn(() => 1_000),
            getRenderSettings: vi.fn(() => activeRenderSettings),
            updateAudioDownmixSettings,
            updateRenderSettings: vi.fn(() => true),
            ...createPresentationPlayerMethods()
        } as unknown as WebGPUPlayer;
        const panelPromise = showWebGPUPlaybackSettingsPanel(player);
        const panel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        const audioStatus = requirePanelElement<HTMLElement>(panel, '[data-audio-status]');

        const gainEdits = [
            { key: 'centerLevel', value: '0.4' },
            { key: 'surroundLevel', value: '0.6' },
            { key: 'outputGain', value: '0.8' }
        ];
        for (const gainEdit of gainEdits) {
            const numberInput = requirePanelElement<HTMLInputElement>(
                panel,
                `[data-setting-number="${gainEdit.key}"]`
            );
            numberInput.value = gainEdit.value;
            numberInput.dispatchEvent(new Event('change'));
            expect(updateAudioDownmixSettings).toHaveBeenLastCalledWith(
                expect.objectContaining({ [gainEdit.key]: Number(gainEdit.value) })
            );
            expect(audioStatus.textContent).toBe(AUDIO_DOWNMIX_LIVE_STATUS);
        }
        // Gains alone never switch the output layout
        expect(applyAudioOutputSettings).not.toHaveBeenCalled();

        const liveUpdateCount = updateAudioDownmixSettings.mock.calls.length;
        const forceStereoCheckbox = requirePanelElement<HTMLInputElement>(
            panel,
            '[data-setting-checkbox="forceStereoDownmix"]'
        );
        forceStereoCheckbox.checked = true;
        forceStereoCheckbox.dispatchEvent(new Event('change'));
        expect(updateAudioDownmixSettings).toHaveBeenCalledTimes(liveUpdateCount);
        expect(applyAudioOutputSettings).toHaveBeenLastCalledWith(
            true,
            DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM
        );
        // The status reports the switch until the session answers
        expect(audioStatus.textContent).toBe(
            'Saved. Switching the active WebGPU client-decoded audio... Downmix gains are unchanged.'
        );
        await flushMicrotasks();
        expect(audioStatus.textContent).toBe(
            createLayoutChangeStatus(AUDIO_OUTPUT_LAYOUT_LIVE_STATUS)
        );

        const audioDownmixAlgorithmSelect = requirePanelElement<HTMLSelectElement>(
            panel,
            '[data-setting-select="audioDownmixAlgorithm"]'
        );
        expect(audioDownmixAlgorithmSelect.value).toBe(
            DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM
        );
        audioDownmixAlgorithmSelect.value = CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845;
        audioDownmixAlgorithmSelect.dispatchEvent(new Event('change'));
        expect(storageMockState.audioDownmixAlgorithm).toBe(
            CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845
        );
        expect(updateAudioDownmixSettings).toHaveBeenCalledTimes(liveUpdateCount);
        expect(applyAudioOutputSettings).toHaveBeenLastCalledWith(
            true,
            CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845
        );
        expect(audioStatus.textContent).toBe(
            createLayoutChangeStatus(AUDIO_OUTPUT_LAYOUT_APPLYING_STATUS)
        );
        await flushMicrotasks();
        expect(audioStatus.textContent).toBe(
            createLayoutChangeStatus(AUDIO_OUTPUT_LAYOUT_LIVE_STATUS)
        );

        requirePanelElement<HTMLButtonElement>(
            panel,
            '[data-default-setting="audioDownmixAlgorithm"]'
        ).click();
        expect(storageMockState.audioDownmixAlgorithm).toBe(
            DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM
        );
        expect(audioDownmixAlgorithmSelect.value).toBe(
            DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM
        );
        expect(applyAudioOutputSettings).toHaveBeenLastCalledWith(
            true,
            DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM
        );
        await flushMicrotasks();

        const layoutApplicationCount = applyAudioOutputSettings.mock.calls.length;
        requirePanelElement<HTMLButtonElement>(
            panel,
            '[data-default-setting="centerLevel"]'
        ).click();
        expect(updateAudioDownmixSettings).toHaveBeenLastCalledWith(
            expect.objectContaining({ centerLevel: 1 })
        );
        expect(applyAudioOutputSettings).toHaveBeenCalledTimes(layoutApplicationCount);
        expect(audioStatus.textContent).toBe(AUDIO_DOWNMIX_LIVE_STATUS);

        audioDownmixAlgorithmSelect.value = CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.AC4;
        audioDownmixAlgorithmSelect.dispatchEvent(new Event('change'));
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsResetAudio').click();
        expect(updateAudioDownmixSettings).toHaveBeenLastCalledWith(
            createDefaultWebGPUUserSettings().audio.downmix
        );
        expect(applyAudioOutputSettings).toHaveBeenLastCalledWith(
            false,
            DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM
        );
        expect(forceStereoCheckbox.checked).toBe(false);
        // A reset leads with the gain status and has no unchanged-gains suffix
        expect(audioStatus.textContent).toBe(
            `${AUDIO_DOWNMIX_LIVE_STATUS} ${AUDIO_OUTPUT_LAYOUT_APPLYING_STATUS}`
        );
        await flushMicrotasks();
        expect(audioStatus.textContent).toBe(
            `${AUDIO_DOWNMIX_LIVE_STATUS} ${AUDIO_OUTPUT_LAYOUT_LIVE_STATUS}`
        );
        expect(storageMockState.audioDownmixAlgorithm).toBe(
            DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM
        );

        audioDownmixAlgorithmSelect.value = CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750;
        audioDownmixAlgorithmSelect.dispatchEvent(new Event('change'));
        forceStereoCheckbox.checked = true;
        forceStereoCheckbox.dispatchEvent(new Event('change'));
        expect(applyAudioOutputSettings).toHaveBeenLastCalledWith(
            true,
            CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750
        );
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsResetAll').click();
        expect(updateAudioDownmixSettings).toHaveBeenLastCalledWith(
            createDefaultWebGPUUserSettings().audio.downmix
        );
        expect(applyAudioOutputSettings).toHaveBeenLastCalledWith(
            false,
            DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM
        );
        expect(audioStatus.textContent).toBe(
            `${AUDIO_DOWNMIX_LIVE_STATUS} ${AUDIO_OUTPUT_LAYOUT_APPLYING_STATUS}`
        );
        await flushMicrotasks();
        expect(audioStatus.textContent).toBe(
            `${AUDIO_DOWNMIX_LIVE_STATUS} ${AUDIO_OUTPUT_LAYOUT_LIVE_STATUS}`
        );
        expect(storageMockState.audioDownmixAlgorithm).toBe(
            DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM
        );

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('reports output layout changes as pending without active client-decoded audio', async () => {
        const applyAudioOutputSettings = vi.fn((): Promise<boolean> => Promise.resolve(false));
        const player = {
            applyAudioOutputSettings,
            getDetectedInputPeakNits: vi.fn(() => 1_000),
            getRenderSettings: vi.fn(() => createHDRToSDRRenderSettings()),
            updateAudioDownmixSettings: vi.fn(() => false),
            updateRenderSettings: vi.fn(() => true),
            ...createPresentationPlayerMethods()
        } as unknown as WebGPUPlayer;
        const panelPromise = showWebGPUPlaybackSettingsPanel(player);
        const panel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        const audioStatus = requirePanelElement<HTMLElement>(panel, '[data-audio-status]');
        const forceStereoCheckbox = requirePanelElement<HTMLInputElement>(
            panel,
            '[data-setting-checkbox="forceStereoDownmix"]'
        );
        const audioDownmixAlgorithmSelect = requirePanelElement<HTMLSelectElement>(
            panel,
            '[data-setting-select="audioDownmixAlgorithm"]'
        );

        forceStereoCheckbox.checked = true;
        forceStereoCheckbox.dispatchEvent(new Event('change'));
        expect(applyAudioOutputSettings).toHaveBeenLastCalledWith(
            true,
            DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM
        );
        expect(audioStatus.textContent).toBe(
            createLayoutChangeStatus(AUDIO_OUTPUT_LAYOUT_APPLYING_STATUS)
        );
        await flushMicrotasks();
        expect(audioStatus.textContent).toBe(
            createLayoutChangeStatus(AUDIO_OUTPUT_LAYOUT_PENDING_STATUS)
        );
        expect(JSON.parse(storageMockState.value ?? '{}')).toMatchObject({
            audio: { forceStereoDownmix: true }
        });

        audioDownmixAlgorithmSelect.value = CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.NightModeDialogue;
        audioDownmixAlgorithmSelect.dispatchEvent(new Event('change'));
        expect(applyAudioOutputSettings).toHaveBeenLastCalledWith(
            true,
            CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.NightModeDialogue
        );
        expect(audioStatus.textContent).toBe(
            createLayoutChangeStatus(AUDIO_OUTPUT_LAYOUT_APPLYING_STATUS)
        );
        await flushMicrotasks();
        expect(audioStatus.textContent).toBe(
            createLayoutChangeStatus(AUDIO_OUTPUT_LAYOUT_PENDING_STATUS)
        );
        expect(storageMockState.audioDownmixAlgorithm).toBe(
            CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.NightModeDialogue
        );

        for (const resetSelector of [ '.webgpuSettingsResetAudio', '.webgpuSettingsResetAll' ]) {
            requirePanelElement<HTMLButtonElement>(panel, resetSelector).click();
            expect(applyAudioOutputSettings).toHaveBeenLastCalledWith(
                false,
                DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM
            );
            expect(audioStatus.textContent).toBe(
                `${AUDIO_DOWNMIX_PENDING_STATUS} ${AUDIO_OUTPUT_LAYOUT_APPLYING_STATUS}`
            );
            await flushMicrotasks();
            expect(audioStatus.textContent).toBe(
                `${AUDIO_DOWNMIX_PENDING_STATUS} ${AUDIO_OUTPUT_LAYOUT_PENDING_STATUS}`
            );
        }

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('ignores a layout result after a newer audio status or after close', async () => {
        const layoutResults: Array<(appliedLive: boolean) => void> = [];
        const applyAudioOutputSettings = vi.fn((): Promise<boolean> => (
            new Promise<boolean>((resolve): void => {
                layoutResults.push(resolve);
            })
        ));
        const player = {
            applyAudioOutputSettings,
            getDetectedInputPeakNits: vi.fn(() => 1_000),
            getRenderSettings: vi.fn(() => createHDRToSDRRenderSettings()),
            updateAudioDownmixSettings: vi.fn(() => true),
            updateRenderSettings: vi.fn(() => true),
            ...createPresentationPlayerMethods()
        } as unknown as WebGPUPlayer;
        const panelPromise = showWebGPUPlaybackSettingsPanel(player);
        const panel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        const audioStatus = requirePanelElement<HTMLElement>(panel, '[data-audio-status]');
        const forceStereoCheckbox = requirePanelElement<HTMLInputElement>(
            panel,
            '[data-setting-checkbox="forceStereoDownmix"]'
        );
        const audioDownmixAlgorithmSelect = requirePanelElement<HTMLSelectElement>(
            panel,
            '[data-setting-select="audioDownmixAlgorithm"]'
        );
        const outputGainInput = requirePanelElement<HTMLInputElement>(
            panel,
            '[data-setting-number="outputGain"]'
        );

        // A newer layout change supersedes the result of the earlier switch
        forceStereoCheckbox.checked = true;
        forceStereoCheckbox.dispatchEvent(new Event('change'));
        audioDownmixAlgorithmSelect.value = CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.AC4;
        audioDownmixAlgorithmSelect.dispatchEvent(new Event('change'));
        expect(layoutResults).toHaveLength(2);
        layoutResults[0](true);
        await flushMicrotasks();
        expect(audioStatus.textContent).toBe(
            createLayoutChangeStatus(AUDIO_OUTPUT_LAYOUT_APPLYING_STATUS)
        );
        layoutResults[1](false);
        await flushMicrotasks();
        expect(audioStatus.textContent).toBe(
            createLayoutChangeStatus(AUDIO_OUTPUT_LAYOUT_PENDING_STATUS)
        );

        // A gain status written while a switch is pending also wins
        forceStereoCheckbox.checked = false;
        forceStereoCheckbox.dispatchEvent(new Event('change'));
        outputGainInput.value = '0.5';
        outputGainInput.dispatchEvent(new Event('change'));
        expect(audioStatus.textContent).toBe(AUDIO_DOWNMIX_LIVE_STATUS);
        layoutResults[2](true);
        await flushMicrotasks();
        expect(audioStatus.textContent).toBe(AUDIO_DOWNMIX_LIVE_STATUS);

        // A result that arrives after close leaves the closed panel untouched
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsResetAudio').click();
        const statusAtClose = `${AUDIO_DOWNMIX_LIVE_STATUS} ${AUDIO_OUTPUT_LAYOUT_APPLYING_STATUS}`;
        expect(audioStatus.textContent).toBe(statusAtClose);
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
        layoutResults[3](true);
        await flushMicrotasks();
        expect(audioStatus.textContent).toBe(statusAtClose);
        expect(applyAudioOutputSettings).toHaveBeenCalledTimes(4);
    });

    it('redetects audio outputs from the panel without changing saved settings', async () => {
        const applyAudioOutputSettings = vi.fn((): Promise<boolean> => Promise.resolve(false));
        const player = {
            applyAudioOutputSettings,
            getDetectedInputPeakNits: vi.fn(() => 1_000),
            getRenderSettings: vi.fn(() => createHDRToSDRRenderSettings()),
            updateAudioDownmixSettings: vi.fn(() => true),
            updateRenderSettings: vi.fn(() => true),
            ...createPresentationPlayerMethods()
        } as unknown as WebGPUPlayer;
        const savedSettings = storageMockState.value;
        const panelPromise = showWebGPUPlaybackSettingsPanel(player);
        const panel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        const redetectButton = requirePanelElement<HTMLButtonElement>(
            panel,
            '[data-audio-output-redetect]'
        );
        expect(redetectButton.textContent).toBe('Re-detect output');
        expect(redetectButton.title).toBe(
            'Re-read the current output device and switch active audio to its speaker layout'
        );
        expect(audioOutputManagerMockState.redetectCount).toBe(0);

        redetectButton.click();
        redetectButton.click();

        expect(audioOutputManagerMockState.redetectCount).toBe(2);
        expect(applyAudioOutputSettings).not.toHaveBeenCalled();
        expect(storageMockState.value).toBe(savedSettings);

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
        redetectButton.click();
        expect(audioOutputManagerMockState.redetectCount).toBe(2);
    });

    it('reports when no compatible active downmix accepts a live gain update', async () => {
        const activeRenderSettings = createHDRToSDRRenderSettings();
        const updateAudioDownmixSettings = vi.fn(() => false);
        const player = {
            applyAudioOutputSettings: vi.fn((): Promise<boolean> => Promise.resolve(false)),
            getDetectedInputPeakNits: vi.fn(() => 1_000),
            getRenderSettings: vi.fn(() => activeRenderSettings),
            updateAudioDownmixSettings,
            updateRenderSettings: vi.fn(() => true),
            ...createPresentationPlayerMethods()
        } as unknown as WebGPUPlayer;
        const panelPromise = showWebGPUPlaybackSettingsPanel(player);
        const panel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        const outputGain = requirePanelElement<HTMLInputElement>(
            panel,
            '[data-setting-slider="outputGain"]'
        );
        outputGain.value = '0.5';
        outputGain.dispatchEvent(new Event('input'));

        expect(updateAudioDownmixSettings).toHaveBeenCalledWith(
            expect.objectContaining({ outputGain: 0.5 })
        );
        expect(requirePanelElement<HTMLElement>(
            panel,
            '[data-audio-status]'
        ).textContent).toContain('No active compatible WebGPU stereo downmix');

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('lists permitted outputs, persists live choices, and reflects hotplug fallback', async () => {
        const defaults = createDefaultWebGPUUserSettings();
        storageMockState.value = JSON.stringify({
            ...defaults,
            audio: { ...defaults.audio, outputDeviceId: 'speaker-a' }
        });
        audioOutputManagerMockState.snapshot = {
            activeDeviceId: 'speaker-a',
            devices: [
                { deviceId: 'speaker-a', label: '' },
                { deviceId: 'speaker-b', label: 'Headphones' }
            ],
            messageCode: 'selected-active',
            pickerAvailable: true,
            selectedDeviceAvailability: 'active',
            selectedDeviceId: 'speaker-a',
            status: 'selected'
        };
        const player = {
            applyAudioOutputSettings: vi.fn((): Promise<boolean> => Promise.resolve(false)),
            getDetectedInputPeakNits: vi.fn(() => 1_000),
            getRenderSettings: vi.fn(() => createHDRToSDRRenderSettings()),
            updateAudioDownmixSettings: vi.fn(() => true),
            updateRenderSettings: vi.fn(() => true),
            ...createPresentationPlayerMethods()
        } as unknown as WebGPUPlayer;
        const panelPromise = showWebGPUPlaybackSettingsPanel(player);
        const panel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        const outputSelect = requirePanelElement<HTMLSelectElement>(
            panel,
            '[data-audio-output-select]'
        );
        expect(Array.from(outputSelect.options).map(option => option.textContent)).toEqual([
            'Default',
            'Audio output 1',
            'Headphones'
        ]);
        expect(outputSelect.value).toBe('speaker-a');

        outputSelect.value = 'speaker-b';
        outputSelect.dispatchEvent(new Event('change'));
        expect(JSON.parse(storageMockState.value ?? '{}')).toMatchObject({
            audio: { outputDeviceId: 'speaker-b' }
        });

        audioOutputManagerMockState.snapshot = {
            activeDeviceId: null,
            devices: [ { deviceId: 'speaker-a', label: '' } ],
            messageCode: 'selected-unavailable-default',
            pickerAvailable: true,
            selectedDeviceAvailability: 'unavailable',
            selectedDeviceId: 'speaker-b',
            status: 'fallback'
        };
        for (const listener of audioOutputManagerMockState.listeners) {
            listener(audioOutputManagerMockState.snapshot);
        }
        expect(outputSelect.selectedOptions[0]?.textContent).toBe(
            'Previously selected output (unavailable)'
        );
        expect(requirePanelElement<HTMLElement>(
            panel,
            '[data-audio-output-status]'
        ).textContent).toContain('saved output is unavailable');

        audioOutputManagerMockState.requestResult = 'rotated-output';
        requirePanelElement<HTMLButtonElement>(panel, '[data-audio-output-picker]').click();
        await vi.waitFor(() => expect(
            JSON.parse(storageMockState.value ?? '{}')
        ).toMatchObject({ audio: { outputDeviceId: 'rotated-output' } }));

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
        expect(audioOutputManagerMockState.listeners.size).toBe(0);
    });

    it('invalidates late picker success and rejection after dropdown changes', async () => {
        const defaults = createDefaultWebGPUUserSettings();
        storageMockState.value = JSON.stringify(defaults);
        audioOutputManagerMockState.snapshot = {
            activeDeviceId: null,
            devices: [
                { deviceId: 'speaker-a', label: 'Speakers' },
                { deviceId: 'speaker-b', label: 'Headphones' }
            ],
            messageCode: 'default-active',
            pickerAvailable: true,
            selectedDeviceAvailability: 'unknown',
            selectedDeviceId: null,
            status: 'default'
        };
        let resolvePicker: (deviceId: string | null) => void = (
            deviceId: string | null
        ): void => {
            throw new Error(`Missing picker resolver for ${deviceId ?? 'default'}`);
        };
        audioOutputManagerMockState.requestPromise = new Promise<string | null>((resolve): void => {
            resolvePicker = resolve;
        });
        const player = {
            applyAudioOutputSettings: vi.fn((): Promise<boolean> => Promise.resolve(false)),
            getDetectedInputPeakNits: vi.fn(() => 1_000),
            getRenderSettings: vi.fn(() => createHDRToSDRRenderSettings()),
            updateAudioDownmixSettings: vi.fn(() => true),
            updateRenderSettings: vi.fn(() => true),
            ...createPresentationPlayerMethods()
        } as unknown as WebGPUPlayer;
        const panelPromise = showWebGPUPlaybackSettingsPanel(player);
        const panel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        const outputSelect = requirePanelElement<HTMLSelectElement>(
            panel,
            '[data-audio-output-select]'
        );
        const pickerButton = requirePanelElement<HTMLButtonElement>(
            panel,
            '[data-audio-output-picker]'
        );

        pickerButton.click();
        outputSelect.value = 'speaker-b';
        outputSelect.dispatchEvent(new Event('change'));
        resolvePicker('late-success');
        await Promise.resolve();
        await Promise.resolve();
        expect(JSON.parse(storageMockState.value ?? '{}')).toMatchObject({
            audio: { outputDeviceId: 'speaker-b' }
        });
        expect(requirePanelElement<HTMLElement>(
            panel,
            '[data-audio-output-status]'
        ).textContent).toContain('Using the selected audio output');

        let rejectPicker: (error: unknown) => void = (error: unknown): void => {
            throw new Error(`Missing picker rejecter for ${String(error)}`);
        };
        audioOutputManagerMockState.requestPromise = new Promise<string | null>(
            (_resolve, reject): void => {
                rejectPicker = reject;
            }
        );
        pickerButton.click();
        outputSelect.value = 'speaker-a';
        outputSelect.dispatchEvent(new Event('change'));
        rejectPicker(new DOMException('Late denial', 'NotAllowedError'));
        await Promise.resolve();
        await Promise.resolve();
        expect(JSON.parse(storageMockState.value ?? '{}')).toMatchObject({
            audio: { outputDeviceId: 'speaker-a' }
        });
        expect(requirePanelElement<HTMLElement>(
            panel,
            '[data-audio-output-status]'
        ).textContent).not.toContain('blocked');
        expect(audioOutputManagerMockState.cancelCount).toBe(2);

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('invalidates late picker success and rejection after audio resets', async () => {
        const defaults = createDefaultWebGPUUserSettings();
        storageMockState.value = JSON.stringify({
            ...defaults,
            audio: { ...defaults.audio, outputDeviceId: 'speaker-a' }
        });
        audioOutputManagerMockState.snapshot = {
            activeDeviceId: 'speaker-a',
            devices: [ { deviceId: 'speaker-a', label: 'Speakers' } ],
            messageCode: 'selected-active',
            pickerAvailable: true,
            selectedDeviceAvailability: 'active',
            selectedDeviceId: 'speaker-a',
            status: 'selected'
        };
        let resolvePicker: (deviceId: string | null) => void = (
            deviceId: string | null
        ): void => {
            throw new Error(`Missing picker resolver for ${deviceId ?? 'default'}`);
        };
        audioOutputManagerMockState.requestPromise = new Promise<string | null>((resolve): void => {
            resolvePicker = resolve;
        });
        const player = {
            applyAudioOutputSettings: vi.fn((): Promise<boolean> => Promise.resolve(false)),
            getDetectedInputPeakNits: vi.fn(() => 1_000),
            getRenderSettings: vi.fn(() => createHDRToSDRRenderSettings()),
            updateAudioDownmixSettings: vi.fn(() => true),
            updateRenderSettings: vi.fn(() => true),
            ...createPresentationPlayerMethods()
        } as unknown as WebGPUPlayer;
        const panelPromise = showWebGPUPlaybackSettingsPanel(player);
        const panel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        const pickerButton = requirePanelElement<HTMLButtonElement>(
            panel,
            '[data-audio-output-picker]'
        );

        pickerButton.click();
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsResetAudio').click();
        resolvePicker('late-success');
        await Promise.resolve();
        await Promise.resolve();
        expect(JSON.parse(storageMockState.value ?? '{}')).toMatchObject({
            audio: { outputDeviceId: null }
        });

        let rejectPicker: (error: unknown) => void = (error: unknown): void => {
            throw new Error(`Missing picker rejecter for ${String(error)}`);
        };
        audioOutputManagerMockState.requestPromise = new Promise<string | null>(
            (_resolve, reject): void => {
                rejectPicker = reject;
            }
        );
        pickerButton.click();
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsResetAll').click();
        rejectPicker(new DOMException('Late denial', 'NotAllowedError'));
        await Promise.resolve();
        await Promise.resolve();
        expect(JSON.parse(storageMockState.value ?? '{}')).toMatchObject({
            audio: { outputDeviceId: null }
        });
        expect(requirePanelElement<HTMLElement>(
            panel,
            '[data-audio-output-status]'
        ).textContent).not.toContain('blocked');
        expect(audioOutputManagerMockState.cancelCount).toBe(2);

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('labels an unenumerated active selection without claiming it is unavailable', async () => {
        const defaults = createDefaultWebGPUUserSettings();
        storageMockState.value = JSON.stringify({
            ...defaults,
            audio: { ...defaults.audio, outputDeviceId: 'speaker-a' }
        });
        audioOutputManagerMockState.snapshot = {
            activeDeviceId: 'speaker-a',
            devices: [],
            messageCode: 'selected-enumeration-failed',
            pickerAvailable: true,
            selectedDeviceAvailability: 'active',
            selectedDeviceId: 'speaker-a',
            status: 'selected'
        };
        const player = {
            applyAudioOutputSettings: vi.fn((): Promise<boolean> => Promise.resolve(false)),
            getDetectedInputPeakNits: vi.fn(() => 1_000),
            getRenderSettings: vi.fn(() => createHDRToSDRRenderSettings()),
            updateAudioDownmixSettings: vi.fn(() => true),
            updateRenderSettings: vi.fn(() => true),
            ...createPresentationPlayerMethods()
        } as unknown as WebGPUPlayer;
        const panelPromise = showWebGPUPlaybackSettingsPanel(player);
        const panel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        const outputSelect = requirePanelElement<HTMLSelectElement>(
            panel,
            '[data-audio-output-select]'
        );

        expect(outputSelect.selectedOptions[0]?.textContent).toBe('Selected output (active)');
        expect(outputSelect.selectedOptions[0]?.disabled).toBe(false);
        expect(requirePanelElement<HTMLElement>(
            panel,
            '[data-audio-output-status]'
        ).textContent).toContain('selected output remains active');

        audioOutputManagerMockState.snapshot = {
            ...audioOutputManagerMockState.snapshot,
            activeDeviceId: null,
            messageCode: 'selected-saved',
            selectedDeviceAvailability: 'unknown',
            status: 'inactive'
        };
        for (const listener of audioOutputManagerMockState.listeners) {
            listener(audioOutputManagerMockState.snapshot);
        }
        expect(outputSelect.selectedOptions[0]?.textContent).toBe(
            'Selected output (availability unknown)'
        );
        expect(outputSelect.selectedOptions[0]?.disabled).toBe(false);

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('ignores a picker completion after close and does not mutate a reopened panel', async () => {
        let resolvePicker: (deviceId: string | null) => void = (
            deviceId: string | null
        ): void => {
            throw new Error(`Missing picker resolver for ${deviceId ?? 'default'}`);
        };
        audioOutputManagerMockState.requestPromise = new Promise<string | null>((resolve): void => {
            resolvePicker = resolve;
        });
        audioOutputManagerMockState.snapshot.pickerAvailable = true;
        const player = {
            applyAudioOutputSettings: vi.fn((): Promise<boolean> => Promise.resolve(false)),
            getDetectedInputPeakNits: vi.fn(() => 1_000),
            getRenderSettings: vi.fn(() => createHDRToSDRRenderSettings()),
            updateAudioDownmixSettings: vi.fn(() => true),
            updateRenderSettings: vi.fn(() => true),
            ...createPresentationPlayerMethods()
        } as unknown as WebGPUPlayer;

        const firstPanelPromise = showWebGPUPlaybackSettingsPanel(player);
        const firstPanel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        requirePanelElement<HTMLButtonElement>(firstPanel, '[data-audio-output-picker]').click();
        requirePanelElement<HTMLButtonElement>(firstPanel, '.webgpuSettingsClose').click();
        await firstPanelPromise;

        audioOutputManagerMockState.requestPromise = null;
        const secondPanelPromise = showWebGPUPlaybackSettingsPanel(player);
        const secondPanel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        resolvePicker('late-output');
        await Promise.resolve();
        await Promise.resolve();

        expect(JSON.parse(storageMockState.value ?? '{}')).toMatchObject({
            audio: { outputDeviceId: null }
        });
        expect(requirePanelElement<HTMLSelectElement>(
            secondPanel,
            '[data-audio-output-select]'
        ).value).toBe('');
        requirePanelElement<HTMLButtonElement>(secondPanel, '.webgpuSettingsClose').click();
        await secondPanelPromise;
    });

    it('lists each stored shader pass with its plan state and applies parameter changes live', async () => {
        const presentationMethods = createPresentationPlayerMethods();
        vi.mocked(presentationMethods.getPresentationPlanReport).mockReturnValue({
            activePasses: [ SATURATION_PASS_NAME ],
            inactivePasses: [
                { detail: INVERT_REJECTION_DETAIL, name: INVERT_PASS_NAME, reason: 'domain-unreachable' },
                { detail: DUPLICATE_REJECTION_DETAIL, name: SATURATION_PASS_NAME, reason: 'duplicate-name' }
            ]
        });
        storePresentation({
            files: [
                { parameters: { [SATURATION_PARAMETER_NAME]: STORED_SATURATION }, sourceKey: await addPassSource(SATURATION_PASS_SOURCE) },
                { parameters: {}, sourceKey: await addPassSource(INVERT_PASS_SOURCE) },
                { parameters: {}, sourceKey: await addPassSource(SATURATION_PASS_SOURCE) },
                { parameters: {}, sourceKey: await addPassSource(MISSING_SHAPE_PASS_SOURCE) }
            ],
            hdrOutput: false
        });

        const { panel, panelPromise } = await openPanelWithSources(createPresentationTestPlayer(presentationMethods));
        const presentationStatus = requirePanelElement<HTMLElement>(panel, '[data-presentation-status]');
        expect(readPassRows(panel)).toEqual([
            { name: SATURATION_PASS_NAME, states: [ translateSourceString('WebGPUShaderPassActive') ] },
            { name: INVERT_PASS_NAME, states: [ `domain-unreachable: ${INVERT_REJECTION_DETAIL}` ] },
            // The plan leaves out the later of two passes with one name
            { name: SATURATION_PASS_NAME, states: [ `duplicate-name: ${DUPLICATE_REJECTION_DETAIL}` ] },
            { name: MISSING_SHAPE_PASS_NAME, states: [ MISSING_SHAPE_HEADER_FAILURE ] }
        ]);
        const parameterSelector = `[data-parameter-name="${SATURATION_PARAMETER_NAME}"]`;
        const parameterInput = requirePanelElement<HTMLInputElement>(panel, `[data-file-index="0"]${parameterSelector}`);
        expect(parameterInput.min).toBe(String(SATURATION_PARAMETER_MINIMUM));
        expect(parameterInput.max).toBe(String(SATURATION_PARAMETER_MAXIMUM));
        expect(parameterInput.step).toBe(FLOAT_PARAMETER_STEP);
        expect(parameterInput.value).toBe(String(STORED_SATURATION));
        expect(requirePanelElement<HTMLInputElement>(panel, `[data-file-index="2"]${parameterSelector}`).value)
            .toBe(String(SATURATION_PARAMETER_DEFAULT));

        parameterInput.value = String(CHANGED_SATURATION);
        parameterInput.dispatchEvent(new Event('change', { bubbles: true }));
        expect(presentationMethods.setPresentationParameter)
            .toHaveBeenCalledWith(SATURATION_PASS_NAME, SATURATION_PARAMETER_NAME, CHANGED_SATURATION);
        expect(readSavedPresentation().files[0].parameters).toEqual({ [SATURATION_PARAMETER_NAME]: CHANGED_SATURATION });
        expect(presentationStatus.textContent).toBe(translateSourceString('WebGPUShaderPassParameterApplied'));
        // The save keeps the list as it is, so the edited input keeps its focus
        expect(parameterInput.isConnected).toBe(true);

        // A pass the player does not run yet takes the saved value when its preset next applies
        vi.mocked(presentationMethods.setPresentationParameter).mockImplementationOnce((): void => {
            throw new RangeError(PARAMETER_PENDING_ERROR);
        });
        parameterInput.value = String(SATURATION_PARAMETER_MAXIMUM);
        parameterInput.dispatchEvent(new Event('change', { bubbles: true }));
        expect(readSavedPresentation().files[0].parameters).toEqual({ [SATURATION_PARAMETER_NAME]: SATURATION_PARAMETER_MAXIMUM });
        expect(presentationStatus.textContent)
            .toBe(translateSourceString('WebGPUShaderPassParameterPending', PARAMETER_PENDING_ERROR));

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('lists a file of several passes as one entry, with a named state per pass and parameters every declaring pass takes', async () => {
        const presentationMethods = createPresentationPlayerMethods();
        vi.mocked(presentationMethods.getPresentationPlanReport).mockReturnValue({
            activePasses: [ SATURATION_PASS_NAME ],
            inactivePasses: [ { detail: INVERT_REJECTION_DETAIL, name: INVERT_PASS_NAME, reason: 'domain-unreachable' } ]
        });
        storePresentation({ files: [ { parameters: {}, sourceKey: await addPassSource(SATURATION_THEN_INVERT_FILE_SOURCE) } ], hdrOutput: false });

        const { panel, panelPromise } = await openPanelWithSources(createPresentationTestPlayer(presentationMethods));
        expect(readPassRows(panel)).toEqual([ {
            name: translateSourceString('WebGPUShaderPassFile', SATURATION_PASS_NAME, SATURATION_THEN_INVERT_PASS_COUNT),
            states: [
                `${SATURATION_PASS_NAME}: ${translateSourceString('WebGPUShaderPassActive')}`,
                `${INVERT_PASS_NAME}: domain-unreachable: ${INVERT_REJECTION_DETAIL}`
            ]
        } ]);

        const parameterInput = requirePanelElement<HTMLInputElement>(panel, `[data-file-index="0"][data-parameter-name="${SATURATION_PARAMETER_NAME}"]`);
        parameterInput.value = String(CHANGED_SATURATION);
        parameterInput.dispatchEvent(new Event('change', { bubbles: true }));
        // Only the pass that declares the parameter takes it
        expect(presentationMethods.setPresentationParameter).toHaveBeenCalledTimes(1);
        expect(presentationMethods.setPresentationParameter)
            .toHaveBeenCalledWith(SATURATION_PASS_NAME, SATURATION_PARAMETER_NAME, CHANGED_SATURATION);
        expect(readSavedPresentation().files[0].parameters).toEqual({ [SATURATION_PARAMETER_NAME]: CHANGED_SATURATION });

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('adds chosen shader pass files, skipping invalid ones, and removes passes singly or all at once', async () => {
        const presentationMethods = createPresentationPlayerMethods();
        vi.mocked(presentationMethods.setPresentationPreset)
            .mockResolvedValueOnce({ activePasses: [ SATURATION_PASS_NAME, INVERT_PASS_NAME ], inactivePasses: [] })
            .mockResolvedValueOnce({ activePasses: [ INVERT_PASS_NAME ], inactivePasses: [] });
        const { panel, panelPromise } = await openPanelWithSources(createPresentationTestPlayer(presentationMethods));
        const passFileInput = requirePanelElement<HTMLInputElement>(panel, '[data-presentation-pass-files]');
        const removePassesButton = requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsRemovePasses');
        const presentationStatus = requirePanelElement<HTMLElement>(panel, '[data-presentation-status]');
        expect(removePassesButton.disabled).toBe(true);

        const openFilePicker = vi.spyOn(passFileInput, 'click').mockImplementation((): void => undefined);
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsAddPasses').click();
        expect(openFilePicker).toHaveBeenCalledTimes(1);
        choosePassFiles(passFileInput, [
            new File([ SATURATION_PASS_SOURCE ], SATURATION_PASS_FILE_NAME),
            new File([ BLANK_PASS_SOURCE ], BLANK_PASS_FILE_NAME),
            new File([ INVERT_PASS_SOURCE ], INVERT_PASS_FILE_NAME)
        ]);
        await flushMicrotasks();

        const addedFiles: PresentationPresetFile[] = [
            { parameters: {}, source: SATURATION_PASS_SOURCE },
            { parameters: {}, source: INVERT_PASS_SOURCE }
        ];
        expect(presentationMethods.setPresentationPreset).toHaveBeenLastCalledWith(addedFiles);
        // The settings hold each file's key, and the store its source
        expect(readSavedPresentation().files).toEqual([
            { parameters: {}, sourceKey: FIRST_SOURCE_KEY },
            { parameters: {}, sourceKey: SECOND_SOURCE_KEY }
        ]);
        expect(readStoredSources()).toEqual(new Map([ [ FIRST_SOURCE_KEY, SATURATION_PASS_SOURCE ], [ SECOND_SOURCE_KEY, INVERT_PASS_SOURCE ] ]));
        expect(readPassRows(panel)).toEqual([
            { name: SATURATION_PASS_NAME, states: [ translateSourceString('WebGPUShaderPassActive') ] },
            { name: INVERT_PASS_NAME, states: [ translateSourceString('WebGPUShaderPassActive') ] }
        ]);
        expect(presentationStatus.textContent).toBe(translateSourceString(
            'WebGPUJoinedSentences',
            translateSourceString(
                'WebGPUShaderPassFilesSkipped',
                BLANK_PASS_FILE_NAME,
                MAXIMUM_PRESENTATION_FILE_COUNT,
                MAXIMUM_PRESENTATION_PASS_SOURCE_LENGTH
            ),
            translateSourceString('WebGPUShaderPassesSummary', addedFiles.length, 0)
        ));
        expect(removePassesButton.disabled).toBe(false);

        requirePanelElement<HTMLButtonElement>(panel, '[data-remove-file="0"]').click();
        await flushMicrotasks();
        expect(presentationMethods.setPresentationPreset).toHaveBeenLastCalledWith(addedFiles.slice(1));
        expect(readPassRows(panel)).toEqual([
            { name: INVERT_PASS_NAME, states: [ translateSourceString('WebGPUShaderPassActive') ] }
        ]);
        // A removed file's source goes with it
        expect(readStoredSources()).toEqual(new Map([ [ SECOND_SOURCE_KEY, INVERT_PASS_SOURCE ] ]));

        removePassesButton.click();
        await flushMicrotasks();
        expect(presentationMethods.setPresentationPreset).toHaveBeenLastCalledWith([]);
        expect(readSavedPresentation().files).toEqual([]);
        expect(readStoredSources().size).toBe(0);
        expect(readPassRows(panel)).toEqual([]);
        expect(presentationStatus.textContent).toBe(translateSourceString('WebGPUShaderPassesNone'));
        expect(removePassesButton.disabled).toBe(true);

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('ignores a shader pass result that a newer change superseded', async () => {
        let resolveAddedPreset: (report: PlanReport) => void = (report: PlanReport): void => {
            throw new Error(`Missing preset resolver for ${report.activePasses.join(', ')}`);
        };
        const presentationMethods = createPresentationPlayerMethods();
        vi.mocked(presentationMethods.setPresentationPreset).mockImplementationOnce((): Promise<PlanReport> => (
            new Promise<PlanReport>((resolve): void => {
                resolveAddedPreset = resolve;
            })
        ));
        const { panel, panelPromise } = await openPanelWithSources(createPresentationTestPlayer(presentationMethods));
        const presentationStatus = requirePanelElement<HTMLElement>(panel, '[data-presentation-status]');
        choosePassFiles(
            requirePanelElement<HTMLInputElement>(panel, '[data-presentation-pass-files]'),
            [ new File([ SATURATION_PASS_SOURCE ], SATURATION_PASS_FILE_NAME) ]
        );
        await flushMicrotasks();
        expect(presentationStatus.textContent).toBe(translateSourceString('WebGPUShaderPassesApplying'));

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsRemovePasses').click();
        await flushMicrotasks();
        resolveAddedPreset({ activePasses: [ SATURATION_PASS_NAME ], inactivePasses: [] });
        await flushMicrotasks();

        expect(readPassRows(panel)).toEqual([]);
        expect(presentationStatus.textContent).toBe(translateSourceString('WebGPUShaderPassesNone'));
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('saves HDR output, applies it live, and restores its default', async () => {
        const presentationMethods = createPresentationPlayerMethods();
        const { panel, panelPromise } = await openPanelWithSources(createPresentationTestPlayer(presentationMethods));
        const HDROutputCheckbox = requirePanelElement<HTMLInputElement>(panel, '[data-setting-checkbox="hdrOutput"]');
        const presentationStatus = requirePanelElement<HTMLElement>(panel, '[data-hdr-output-status]');
        expect(HDROutputCheckbox.checked).toBe(false);

        HDROutputCheckbox.checked = true;
        HDROutputCheckbox.dispatchEvent(new Event('change'));
        await flushMicrotasks();
        expect(presentationMethods.setHDROutputEnabled).toHaveBeenLastCalledWith(true);
        expect(readSavedPresentation().hdrOutput).toBe(true);
        expect(presentationStatus.textContent).toBe(translateSourceString('WebGPUHDROutputApplied'));

        vi.mocked(presentationMethods.setHDROutputEnabled).mockRejectedValueOnce(new Error(HDR_OUTPUT_FAILURE));
        requirePanelElement<HTMLButtonElement>(panel, '[data-default-setting="hdrOutput"]').click();
        await flushMicrotasks();
        expect(HDROutputCheckbox.checked).toBe(false);
        expect(presentationMethods.setHDROutputEnabled).toHaveBeenLastCalledWith(false);
        expect(readSavedPresentation().hdrOutput).toBe(false);
        expect(presentationStatus.textContent).toBe(translateSourceString('WebGPUHDROutputFailed', HDR_OUTPUT_FAILURE));

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('shows the stored deinterlacing mode, saves and applies each mode live, and restores its default', async () => {
        const presentationMethods = createPresentationPlayerMethods();
        storePresentation({ deinterlaceMode: 'off' });
        const { panel, panelPromise } = await openPanelWithSources(createPresentationTestPlayer(presentationMethods));
        const deinterlaceSelect = requirePanelElement<HTMLSelectElement>(panel, '[data-setting-select="deinterlaceMode"]');
        const deinterlaceStatus = requirePanelElement<HTMLElement>(panel, '[data-deinterlace-mode-status]');
        expect(Array.from(deinterlaceSelect.options, (option: HTMLOptionElement): string => option.value)).toEqual([ 'double-rate', 'single-rate', 'off' ]);
        expect(deinterlaceSelect.value).toBe('off');
        // Opening the panel shows the stored mode without applying it again
        expect(presentationMethods.setDeinterlaceMode).not.toHaveBeenCalled();

        for (const mode of [ 'single-rate', 'double-rate', 'off' ] as const) {
            deinterlaceSelect.value = mode;
            deinterlaceSelect.dispatchEvent(new Event('change'));
            await flushMicrotasks();
            expect(presentationMethods.setDeinterlaceMode).toHaveBeenLastCalledWith(mode);
            expect(readSavedPresentation().deinterlaceMode).toBe(mode);
            expect(deinterlaceStatus.textContent).toBe(translateSourceString('WebGPUDeinterlaceApplied'));
        }

        vi.mocked(presentationMethods.setDeinterlaceMode).mockRejectedValueOnce(new Error(DEINTERLACE_FAILURE));
        requirePanelElement<HTMLButtonElement>(panel, '[data-default-setting="deinterlaceMode"]').click();
        await flushMicrotasks();
        expect(deinterlaceSelect.value).toBe('double-rate');
        expect(presentationMethods.setDeinterlaceMode).toHaveBeenLastCalledWith('double-rate');
        expect(readSavedPresentation().deinterlaceMode).toBe('double-rate');
        expect(deinterlaceStatus.textContent).toBe(translateSourceString('WebGPUDeinterlaceFailed', DEINTERLACE_FAILURE));

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('restores and reapplies the presentation defaults on reset all', async () => {
        const presentationMethods = createPresentationPlayerMethods();
        storePresentation({ deinterlaceMode: 'single-rate', files: [ { parameters: {}, sourceKey: await addPassSource(INVERT_PASS_SOURCE) } ], hdrOutput: true });
        const { panel, panelPromise } = await openPanelWithSources(createPresentationTestPlayer(presentationMethods));
        const HDROutputCheckbox = requirePanelElement<HTMLInputElement>(panel, '[data-setting-checkbox="hdrOutput"]');
        expect(HDROutputCheckbox.checked).toBe(true);
        expect(readPassRows(panel)).toHaveLength(1);

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsResetAll').click();
        await flushMicrotasks();

        const defaultPresentation = createDefaultWebGPUUserSettings().presentation;
        expect(readSavedPresentation()).toEqual(defaultPresentation);
        expect(presentationMethods.setHDROutputEnabled).toHaveBeenLastCalledWith(defaultPresentation.hdrOutput);
        expect(presentationMethods.setDeinterlaceMode).toHaveBeenLastCalledWith(defaultPresentation.deinterlaceMode);
        expect(requirePanelElement<HTMLSelectElement>(panel, '[data-setting-select="deinterlaceMode"]').value).toBe(defaultPresentation.deinterlaceMode);
        expect(presentationMethods.setPresentationPreset).toHaveBeenLastCalledWith(defaultPresentation.files);
        expect(HDROutputCheckbox.checked).toBe(defaultPresentation.hdrOutput);
        expect(readPassRows(panel)).toEqual([]);
        // The reset files' sources go with them
        expect(readStoredSources().size).toBe(0);
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('lists a stored file whose source is missing, leaves it out of the preset, and removes it', async () => {
        const presentationMethods = createPresentationPlayerMethods();
        const invertSourceKey = await addPassSource(INVERT_PASS_SOURCE);
        storePresentation({
            files: [ { parameters: {}, sourceKey: MISSING_SOURCE_KEY }, { parameters: {}, sourceKey: invertSourceKey } ],
            hdrOutput: false
        });

        const { panel, panelPromise } = await openPanelWithSources(createPresentationTestPlayer(presentationMethods));
        expect(readPassRows(panel)).toEqual([
            { name: translateSourceString('WebGPUShaderPassSourceMissing'), states: [ `source-missing: key ${MISSING_SOURCE_KEY}` ] },
            { name: INVERT_PASS_NAME, states: [ translateSourceString('WebGPUShaderPassWaiting') ] }
        ]);

        requirePanelElement<HTMLButtonElement>(panel, '[data-remove-file="0"]').click();
        await flushMicrotasks();
        expect(presentationMethods.setPresentationPreset).toHaveBeenLastCalledWith([ { parameters: {}, source: INVERT_PASS_SOURCE } ]);
        expect(readSavedSourceKeys()).toEqual([ invertSourceKey ]);
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('names a file the store refuses, and adds the files it takes', async () => {
        const presentationMethods = createPresentationPlayerMethods();
        const { panel, panelPromise } = await openPanelWithSources(createPresentationTestPlayer(presentationMethods));
        const presentationStatus = requirePanelElement<HTMLElement>(panel, '[data-presentation-status]');
        indexedDBFake.failNextWrite(QUOTA_ERROR);

        choosePassFiles(requirePanelElement<HTMLInputElement>(panel, '[data-presentation-pass-files]'), [
            new File([ SATURATION_PASS_SOURCE ], SATURATION_PASS_FILE_NAME),
            new File([ INVERT_PASS_SOURCE ], INVERT_PASS_FILE_NAME)
        ]);
        await flushMicrotasks();

        expect(presentationMethods.setPresentationPreset).toHaveBeenLastCalledWith([ { parameters: {}, source: INVERT_PASS_SOURCE } ]);
        expect(readStoredSources()).toEqual(new Map([ [ FIRST_SOURCE_KEY, INVERT_PASS_SOURCE ] ]));
        const notice = translateSourceString(
            'WebGPUJoinedSentences',
            translateSourceString(
                'WebGPUShaderPassFilesSkipped',
                SATURATION_PASS_FILE_NAME,
                MAXIMUM_PRESENTATION_FILE_COUNT,
                MAXIMUM_PRESENTATION_PASS_SOURCE_LENGTH
            ),
            translateSourceString('WebGPUShaderPassesStorageFailed', `source-add-failed: ${QUOTA_ERROR.name}: ${QUOTA_ERROR.message}`)
        );
        expect(presentationStatus.textContent).toBe(translateSourceString(
            'WebGPUJoinedSentences',
            notice,
            translateSourceString('WebGPUShaderPassesSummary', 0, 0)
        ));
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('reports a settings save the browser refuses, keeps the change for this page, and keeps the stored source', async () => {
        const presentationMethods = createPresentationPlayerMethods();
        const { panel, panelPromise } = await openPanelWithSources(createPresentationTestPlayer(presentationMethods));
        const presentationStatus = requirePanelElement<HTMLElement>(panel, '[data-presentation-status]');
        storageMockState.refusedWriteError = QUOTA_ERROR;

        choosePassFiles(
            requirePanelElement<HTMLInputElement>(panel, '[data-presentation-pass-files]'),
            [ new File([ INVERT_PASS_SOURCE ], INVERT_PASS_FILE_NAME) ]
        );
        await flushMicrotasks();

        expect(presentationMethods.setPresentationPreset).toHaveBeenLastCalledWith([ { parameters: {}, source: INVERT_PASS_SOURCE } ]);
        expect(readPassRows(panel).map((row: PassRow): string => row.name)).toEqual([ INVERT_PASS_NAME ]);
        expect(presentationStatus.textContent).toBe(translateSourceString(
            'WebGPUJoinedSentences',
            translateSourceString('WebGPUSettingsSaveFailed', `settings-save-failed: ${QUOTA_ERROR.name}: ${QUOTA_ERROR.message}`),
            translateSourceString('WebGPUShaderPassesSummary', 0, 0)
        ));
        // The page still uses the file, so its source stays
        expect(readStoredSources()).toEqual(new Map([ [ FIRST_SOURCE_KEY, INVERT_PASS_SOURCE ] ]));
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('offers the server\'s passes the preset does not hold, and downloads one when the user adds it', async () => {
        const presentationMethods = createPresentationPlayerMethods();
        serverModuleMockState.catalog = { decoderPackages: [], passes: [ SERVER_SATURATION_PASS ] };
        serverModuleMockState.passSources.set(SATURATION_PASS_FILE_NAME, SATURATION_PASS_SOURCE);
        const { panel, panelPromise } = await openPanelWithSources(createPresentationTestPlayer(presentationMethods));
        const serverPassSelect = requirePanelElement<HTMLSelectElement>(panel, '[data-server-passes]');
        expect(Array.from(serverPassSelect.options, (option: HTMLOptionElement): string => option.value)).toEqual([ SATURATION_PASS_FILE_NAME ]);
        expect(serverPassSelect.disabled).toBe(false);

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsAddServerPass').click();
        await flushMicrotasks();

        expect(readSavedPresentation().files).toEqual([ {
            parameters: {},
            server: { contentHash: FIRST_SERVER_CONTENT_HASH, fileName: SATURATION_PASS_FILE_NAME },
            sourceKey: FIRST_SOURCE_KEY
        } ]);
        expect(readStoredSources()).toEqual(new Map([ [ FIRST_SOURCE_KEY, SATURATION_PASS_SOURCE ] ]));
        expect(presentationMethods.setPresentationPreset).toHaveBeenLastCalledWith([ { parameters: {}, source: SATURATION_PASS_SOURCE } ]);
        expect(readPassRows(panel)[0].states).toContain(translateSourceString('WebGPUShaderPassFromServer', SATURATION_PASS_FILE_NAME));
        // The preset holds the server's only pass now
        expect(serverPassSelect.options[0].textContent).toBe(translateSourceString('WebGPUServerPassesNone'));
        expect(serverPassSelect.disabled).toBe(true);
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('replaces the source of a server file the server has a newer version of, keeping its key and parameters', async () => {
        const presentationMethods = createPresentationPlayerMethods();
        const sourceKey = await addPassSource(INVERT_PASS_SOURCE);
        storePresentation({
            files: [ { parameters: { [SATURATION_PARAMETER_NAME]: STORED_SATURATION }, server: { contentHash: FIRST_SERVER_CONTENT_HASH, fileName: SATURATION_PASS_FILE_NAME }, sourceKey } ],
            hdrOutput: false
        });
        serverModuleMockState.catalog = { decoderPackages: [], passes: [ { ...SERVER_SATURATION_PASS, contentHash: SECOND_SERVER_CONTENT_HASH } ] };
        serverModuleMockState.passSources.set(SATURATION_PASS_FILE_NAME, SATURATION_PASS_SOURCE);

        const { panel, panelPromise } = await openPanelWithSources(createPresentationTestPlayer(presentationMethods));
        await vi.waitFor(() => expect(readStoredSources()).toEqual(new Map([ [ sourceKey, SATURATION_PASS_SOURCE ] ])));
        await flushMicrotasks();

        expect(readSavedPresentation().files).toEqual([ {
            parameters: { [SATURATION_PARAMETER_NAME]: STORED_SATURATION },
            server: { contentHash: SECOND_SERVER_CONTENT_HASH, fileName: SATURATION_PASS_FILE_NAME },
            sourceKey
        } ]);
        expect(presentationMethods.setPresentationPreset).toHaveBeenLastCalledWith([
            { parameters: { [SATURATION_PARAMETER_NAME]: STORED_SATURATION }, source: SATURATION_PASS_SOURCE }
        ]);
        expect(requirePanelElement<HTMLElement>(panel, '[data-presentation-status]').textContent)
            .toContain(translateSourceString('WebGPUServerPassesUpdated', SATURATION_PASS_FILE_NAME));
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('names the decoders the server offers', async () => {
        serverModuleMockState.catalog = { decoderPackages: [ SERVER_HEVC_PACKAGE, SERVER_TRUEHD_PACKAGE ], passes: [] };

        const { panel, panelPromise } = await openPanelWithSources(createPlacementTestPlayer());

        expect(requirePanelElement<HTMLElement>(panel, '[data-server-decoders]').textContent)
            .toBe(translateSourceString('WebGPUServerDecoders', `${SERVER_HEVC_PACKAGE.name}, ${SERVER_TRUEHD_PACKAGE.name}`));
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('says why the server offers nothing when it cannot be reached', async () => {
        serverModuleMockState.catalogFailure = SERVER_UNAVAILABLE_FAILURE;

        const { panel, panelPromise } = await openPanelWithSources(createPlacementTestPlayer());
        await flushMicrotasks();
        const serverPassSelect = requirePanelElement<HTMLSelectElement>(panel, '[data-server-passes]');

        expect(requirePanelElement<HTMLElement>(panel, '[data-server-decoders]').textContent)
            .toBe(translateSourceString('WebGPUServerDecodersUnavailable', SERVER_UNAVAILABLE_FAILURE));
        expect(serverPassSelect.options[0].textContent).toBe(translateSourceString('WebGPUServerPassesUnavailable', SERVER_UNAVAILABLE_FAILURE));
        expect(serverPassSelect.disabled).toBe(true);
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });
});

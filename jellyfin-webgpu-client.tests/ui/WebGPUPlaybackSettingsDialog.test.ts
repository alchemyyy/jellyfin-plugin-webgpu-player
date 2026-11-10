import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlanReport } from 'webgpu-player/presentation/passes/PassTypes';
import { createHDRToSDRRenderSettings } from 'webgpu-player/presentation/RenderSettings';
import type { PresentationPresetFile } from 'webgpu-player/presentation/WebGPUPresenter';
import type WebGPUPlayer from 'addons/webGPUPlayer/WebGPUPlayer';
import { setClientDefaults } from 'addons/webGPUPlayer/ClientDefaults';
import { ensureDefaultPresentationFiles } from 'addons/webGPUPlayer/DefaultPresentationFiles';
import { applySettingsButtonPlacement } from 'addons/webGPUPlayer/compat/SettingsEntryPoints';
import type { WebGPUFailureReport } from 'addons/webGPUPlayer/WebGPUFailureDiagnosis';
import {
    createDefaultWebGPUUserSettings,
    loadWebGPUUserSettings,
    MAXIMUM_PRESENTATION_FILE_COUNT,
    MAXIMUM_PRESENTATION_PASS_SOURCE_LENGTH,
    WEBGPU_USER_SETTINGS_VERSION,
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
    defaultAudioDownmixAlgorithm: 'standard-lo-ro',
    // Every local setting but the panel's settings, such as the default shader files, by name
    otherValues: new Map<string, string>(),
    // Makes local storage refuse writes, as a full quota does
    refusedWriteError: null as DOMException | null,
    settingsKey: 'webGPUPlaybackSettings',
    value: null as string | null
}));

const hostCommandMockState = vi.hoisted(() => ({
    // Playback info toggles the video OSD runs once its dynamic import of the overlay module resolves
    pendingPlaybackInfoToggles: [] as Array<() => void>
}));

// The last WebGPU failure report of the page, which the interface window offers to show
const failureWarningMockState = vi.hoisted(() => ({
    report: null as object | null
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

// The crashed probes the stored verdicts name, which only a stopped page records; the rest of the stored state is the engine's own
const probeStoreMockState = vi.hoisted(() => ({
    crashedProbes: [] as CrashedCapabilityProbe[]
}));

vi.mock('webgpu-player/capability/CapabilityProbeStore', async importOriginal => {
    const probeStore = await importOriginal<typeof import('webgpu-player/capability/CapabilityProbeStore')>();
    return {
        ...probeStore,
        readStoredCapabilityProbeVerdictState: (): CapabilityProbeStoreState | null => {
            const state = probeStore.readStoredCapabilityProbeVerdictState();
            return state && { ...state, crashedProbes: probeStoreMockState.crashedProbes };
        }
    };
});

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
        get: vi.fn((name: string): string | null => (
            name === storageMockState.settingsKey ? storageMockState.value : storageMockState.otherValues.get(name) ?? null
        )),
        set: vi.fn((name: string, value: string): void => {
            if (storageMockState.refusedWriteError) {
                throw storageMockState.refusedWriteError;
            }
            if (name === storageMockState.settingsKey) {
                storageMockState.value = value;
            } else {
                storageMockState.otherValues.set(name, value);
            }
        })
    }
}));

// The dialog reads the downmix algorithm from the add-on shim directly; the default is the server's when it sets one
vi.mock('addons/webGPUPlayer/shims/userSettings', () => ({
    getDefaultAudioDownmixAlgorithm: vi.fn((): string => storageMockState.defaultAudioDownmixAlgorithm),
    webGPUAudioDownmixAlgorithm: vi.fn((value?: string): string => {
        if (value !== undefined) {
            storageMockState.audioDownmixAlgorithm = value;
        }
        return storageMockState.audioDownmixAlgorithm;
    })
}));

// The OSD places its entry to the panel as the settings say; these tests count the requests to place it anew
vi.mock('addons/webGPUPlayer/compat/SettingsEntryPoints', () => ({
    applySettingsButtonPlacement: vi.fn()
}));

// The failure warning diagnoses failures in a chunk of its own; the interface window only reads the last report and opens its dialog
vi.mock('addons/webGPUPlayer/WebGPUFailureWarning', () => ({
    getLastWebGPUFailureReport: vi.fn((): object | null => failureWarningMockState.report),
    noteWebGPUFailure: vi.fn(),
    showWebGPUFailureReport: vi.fn((): Promise<void> => Promise.resolve())
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
import { showWebGPUFailureReport } from 'addons/webGPUPlayer/WebGPUFailureWarning';
import {
    configureCapabilityProbeStore,
    getDefaultCapabilityProbeStore,
    readStoredCapabilityProbeVerdictState,
    type CapabilityProbeStoreState,
    type CrashedCapabilityProbe
} from 'webgpu-player/capability/CapabilityProbeStore';

type AnimationFrameHarness = {
    callbacks: Map<number, FrameRequestCallback>
    nextIdentifier: number
};

// The viewport size, the bounds of the OSD controls and playback info, and each window's content height by window id, which the layout tests report
type LayoutHarness = {
    contentHeights: Record<string, number>
    OSDControlsBounds: DOMRect
    playbackInfoBounds: DOMRect
    viewportHeight: number
    viewportWidth: number
};

/** A window's stored arrangement, as the windows save it. */
type StoredWindowState = Readonly<{
    collapsed: boolean
    position: unknown
    visible: boolean
}>;

const SETTINGS_WINDOWS_SELECTOR = '[data-settings-windows]';
// Where the windows keep their arrangement through the host's user settings
const WINDOW_STATE_STORAGE_KEY = 'webGPUSettingsWindows';
const MASTER_WINDOW_ID = 'playback';
// The section windows, in the order the master lists them, then the host's playback info
const SECTION_WINDOW_IDS = [ 'picture', 'pipeline', 'audio', 'interface' ] as const;
const PLAYBACK_INFO_WINDOW_ID = 'playbackInfo';
// The height of a window's title bar, the windows' font size, and the master window's width at that font, 21em
const WINDOW_CHROME_HEIGHT = 40;
const LAYOUT_FONT_SIZE = 16;
const MASTER_WINDOW_WIDTH = 21 * LAYOUT_FONT_SIZE;
// The room's start corner at a 16px font: a 0.75em margin, and the OSD's top bar, 5em, above it
const ROOM_LEFT = 12;
const ROOM_TOP = 80;
const WINDOW_GAP = 8;
// Master content taller than any room, so the master always shrinks to the room's height
const TALL_MASTER_CONTENT_HEIGHT = 2_000;
const LAYOUT_STYLE_ATTRIBUTE = 'data-layout-harness';

let animationFrames: AnimationFrameHarness = { callbacks: new Map<number, FrameRequestCallback>(), nextIdentifier: 1 };

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
 * Adds the video OSD page with its bottom controls, sets the windows' font size, and reports the harness's viewport size and bounds;
 * a window's title bar is its whole offset height, and its body's scroll height is the window's content height while it shows.
 */
function installLayoutHarness(harness: LayoutHarness): void {
    const playbackPage = document.createElement('div');
    playbackPage.id = 'videoOsdPage';
    playbackPage.innerHTML = '<div class="videoOsdBottom videoOsdBottom-maincontrols">'
        + '<div class="osdControls"></div></div>';
    document.body.appendChild(playbackPage);
    const windowsFontStyle = document.createElement('style');
    windowsFontStyle.setAttribute(LAYOUT_STYLE_ATTRIBUTE, '');
    windowsFontStyle.textContent = `${SETTINGS_WINDOWS_SELECTOR} { font-size: ${LAYOUT_FONT_SIZE}px; }`;
    document.head.appendChild(windowsFontStyle);
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(
        (): number => harness.viewportHeight
    );
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(
        (): number => harness.viewportWidth
    );
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(
        function (this: HTMLElement): number {
            return this.matches('[data-window]') ? WINDOW_CHROME_HEIGHT : 0;
        }
    );
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(
        function (this: Element): number {
            if (!(this instanceof HTMLElement) || !this.matches('[data-window-body]') || this.hidden) {
                return 0;
            }
            return harness.contentHeights[this.closest<HTMLElement>('[data-window]')?.dataset.window ?? ''] ?? 0;
        }
    );
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
        function (this: Element): DOMRect {
            // A hidden page lays nothing out, so its elements measure empty
            if (this.closest('.hide')) {
                return createBounds(0, 0, 0, 0);
            }
            if (this.classList.contains('osdControls')) {
                return harness.OSDControlsBounds;
            }
            if (this.classList.contains('playerStats')) {
                return harness.playbackInfoBounds;
            }
            return createBounds(0, 0, 0, 0);
        }
    );
}

/** A full HD viewport with the OSD controls along its bottom from 900px, playback info of 400 by 300 pixels, and a master window taller than the room. */
function createFullHDLayoutHarness(): LayoutHarness {
    return {
        contentHeights: { [MASTER_WINDOW_ID]: TALL_MASTER_CONTENT_HEIGHT },
        OSDControlsBounds: createBounds(0, 900, 1920, 150),
        playbackInfoBounds: createBounds(0, 0, 400, 300),
        viewportHeight: 1080,
        viewportWidth: 1920
    };
}

/** Runs the pending animation frame callbacks, such as the windows' layout and the render settings' application. */
function runAnimationFrames(): void {
    const callbacks = Array.from(animationFrames.callbacks.values());
    animationFrames.callbacks.clear();
    for (const callback of callbacks) {
        callback(0);
    }
}

/** Returns the open settings windows' root. */
function requireSettingsWindows(): HTMLElement {
    return requirePanelElement<HTMLElement>(document.body, SETTINGS_WINDOWS_SELECTOR);
}

/** Returns one settings window by its id. */
function requireWindow(panel: HTMLElement, id: string): HTMLElement {
    return requirePanelElement<HTMLElement>(panel, `[data-window="${id}"]`);
}

/** Returns the master window's list entry that shows or hides a window. */
function requireWindowToggle(panel: HTMLElement, id: string): HTMLButtonElement {
    return requirePanelElement<HTMLButtonElement>(panel, `[data-window-toggle="${id}"]`);
}

/** Reads each window's stored arrangement, by window id. */
function readStoredWindowState(): Readonly<Record<string, StoredWindowState>> {
    const stored = storageMockState.otherValues.get(WINDOW_STATE_STORAGE_KEY);
    if (stored === undefined) {
        return {};
    }
    // The windows wrote this value themselves in this test
    const storedState = JSON.parse(stored) as Readonly<{ windows: Record<string, StoredWindowState> }>;
    return storedState.windows;
}

/** Presses a key on an element, as the keyboard would. */
function pressKey(target: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...init });
    target.dispatchEvent(event);
    return event;
}

/** Types text into a number field, which applies it only on Enter. */
function typeNumber(field: HTMLInputElement, text: string): void {
    field.value = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Types text into a number field and applies it with Enter. */
function commitNumber(field: HTMLInputElement, text: string): void {
    typeNumber(field, text);
    pressKey(field, 'Enter');
}

// One default button per setting the windows offer, the settings button placement, the decoder test timing, HDR output, black bar crop,
// deinterlacing, GPU decode slicing, the speaker layout, binaural rendering, and the failure warning included
const DEFAULT_SETTING_BUTTON_COUNT = 26;

// What a player reports before any shader pass runs
const EMPTY_PLAN_REPORT: PlanReport = { activePasses: [], inactivePasses: [] };

// The step of the saturation parameter's field: a hundredth of its range, 0 to 2
const SATURATION_PARAMETER_STEP = 0.01;
// A saturation the user types, inside the declared range
const CHANGED_SATURATION = 1.5;
// Rejection details and failures the presentation tests report, and the states the panel shows for them
const INVERT_REJECTION_DETAIL = "domain 'display' after OUTPUT";
const DUPLICATE_REJECTION_DETAIL = 'pass 3';
const MISSING_SHAPE_HEADER_FAILURE = "header-invalid: line 1: Missing required directive 'shape'";
const PARAMETER_PENDING_ERROR = `pass-unknown: '${SATURATION_PASS_NAME}'`;
const HDR_OUTPUT_FAILURE = 'no HDR display';
const BLACK_BAR_CROP_FAILURE = 'out-of-memory';
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
    | 'getActivePresentationPlan'
    | 'getPresentationPlanReport'
    | 'getPresentationRoute'
    | 'setBlackBarCropEnabled'
    | 'setDeinterlaceMode'
    | 'setHDROutputEnabled'
    | 'setPresentationParameter'
    | 'setPresentationPreset'
>;

/** A file the panel lists, as its title and the state text of each of its passes. */
type PassRow = Readonly<{
    name: string
    states: readonly string[]
}>;

/** Builds the presentation calls the windows make when they open, which succeed without passes, and the pipeline graph's getters. */
function createPresentationPlayerMethods(): PresentationPlayerMethods {
    return {
        getActivePresentationPlan: vi.fn(() => null),
        getPresentationPlanReport: vi.fn((): PlanReport => EMPTY_PLAN_REPORT),
        getPresentationRoute: vi.fn(() => null),
        setBlackBarCropEnabled: vi.fn((): Promise<void> => Promise.resolve()),
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

/** Builds a player whose render, audio, and presentation calls succeed. */
function createTestPlayer(): WebGPUPlayer {
    return createPresentationTestPlayer(createPresentationPlayerMethods());
}

/** Stores the presentation settings the panel loads, the defaults for those not given, beside the stored settings the suite starts from. */
function storePresentation(presentation: Partial<WebGPUUserSettings['presentation']>): void {
    storageMockState.value = JSON.stringify({
        ...JSON.parse(storageMockState.value ?? '{}') as object,
        presentation: { ...createDefaultWebGPUUserSettings().presentation, ...presentation }
    });
}

/** Reads the settings the panel saved, over the defaults they follow. */
function readSavedSettings(): WebGPUUserSettings {
    return loadWebGPUUserSettings();
}

/** Reads the presentation settings the panel saved. */
function readSavedPresentation(): WebGPUUserSettings['presentation'] {
    return readSavedSettings().presentation;
}

/** Reads each file the windows list, in order. */
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
    return (readSavedPresentation().files ?? []).map((file: StoredPresentationFile): number => file.sourceKey);
}

/** Returns the panel's restore-default shader passes button. */
function getRestoreDefaultPassesButton(panel: HTMLElement): HTMLButtonElement {
    return requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsRestoreDefaultPasses');
}

/** Sets the server's default preset to the saturation file the server offers, with a parameter value, as an administrator would. */
function setDefaultSaturationPreset(): void {
    serverModuleMockState.catalog = { decoderPackages: [], passes: [ SERVER_SATURATION_PASS ] };
    serverModuleMockState.passSources.set(SATURATION_PASS_FILE_NAME, SATURATION_PASS_SOURCE);
    setClientDefaults({ presentationFiles: [ { fileName: SATURATION_PASS_FILE_NAME, parameters: { [SATURATION_PARAMETER_NAME]: STORED_SATURATION } } ] });
}

/** Opens the windows and lets them read the shader sources, which their pass list waits for. */
async function openPanelWithSources(player: WebGPUPlayer): Promise<Readonly<{ panel: HTMLElement, panelPromise: Promise<void> }>> {
    const panelPromise = showWebGPUPlaybackSettingsPanel(player);
    const panel = requireSettingsWindows();
    await flushMicrotasks();
    return { panel, panelPromise };
}

/** Chooses pass files in the panel's file input, as the file picker would. */
function choosePassFiles(passFileInput: HTMLInputElement, files: readonly File[]): void {
    Object.defineProperty(passFileInput, 'files', { configurable: true, value: files });
    passFileInput.dispatchEvent(new Event('change'));
}

/** Returns a parameter value as its field shows it, at the step's two decimals. */
function formatSaturation(value: number): string {
    return value.toFixed(2);
}

describe('WebGPUPlaybackSettingsPanel', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        hostCommandMockState.pendingPlaybackInfoToggles.length = 0;
        failureWarningMockState.report = null;
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
        probeStoreMockState.crashedProbes = [];
        // The suite unstubs its globals after each test
        indexedDBFake.install();
        indexedDBFake.clear();
        storageMockState.otherValues.clear();
        storageMockState.refusedWriteError = null;
        storageMockState.audioDownmixAlgorithm = DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM;
        storageMockState.defaultAudioDownmixAlgorithm = DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM;
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
        // A test that fails with its windows open would leave them the module's one active set, which every later open reuses
        document.querySelector<HTMLButtonElement>(`${SETTINGS_WINDOWS_SELECTOR} .webgpuSettingsClose`)?.click();
        await flushMicrotasks();
        vi.unstubAllGlobals();
        setClientDefaults({});
        document.documentElement.removeAttribute('dir');
        for (const layoutStyle of document.head.querySelectorAll(`[${LAYOUT_STYLE_ATTRIBUTE}]`)) {
            layoutStyle.remove();
        }
    });

    it('reuses one non-modal set of windows and restores individual defaults', async () => {
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
        const roots = document.querySelectorAll<HTMLElement>(SETTINGS_WINDOWS_SELECTOR);
        expect(roots).toHaveLength(1);
        const panel = roots[0];
        expect(panel.classList.contains('webgpuUi')).toBe(true);
        // The pinned master window, then the section windows, which stay hidden until the user shows them, expanded
        expect(Array.from(panel.querySelectorAll<HTMLElement>('[data-window]'), (frame: HTMLElement): string => frame.dataset.window ?? ''))
            .toEqual([ MASTER_WINDOW_ID, ...SECTION_WINDOW_IDS ]);
        expect(requireWindow(panel, MASTER_WINDOW_ID).hidden).toBe(false);
        expect(requireWindow(panel, MASTER_WINDOW_ID).querySelector('[data-window-collapse]')).toBeNull();
        for (const id of SECTION_WINDOW_IDS) {
            const frame = requireWindow(panel, id);
            expect(frame.hidden).toBe(true);
            expect(frame.classList.contains('webgpuWindow-collapsed')).toBe(false);
            expect(requirePanelElement<HTMLElement>(frame, '[data-window-body]').hidden).toBe(false);
        }
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
        // The slider spans the gains worth sweeping through; the typed field reaches the engine's hard range
        expect(requirePanelElement<HTMLInputElement>(
            panel,
            '[data-setting-slider="outputGain"]'
        ).max).toBe('3');
        expect(requirePanelElement<HTMLInputElement>(
            panel,
            '[data-setting-number="outputGain"]'
        ).dataset.numberMaximum).toBe('10');
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
        commitNumber(brightnessInput, '0.25');
        // An emptied field keeps the setting rather than taking 0, and shows it again
        commitNumber(brightnessInput, '');
        expect(brightnessInput.value).toBe('0.25');
        // Typed text applies only on Enter: Escape and leaving the field show the applied value again
        typeNumber(brightnessInput, '0.4');
        expect(brightnessInput.classList.contains('webgpuUncommitted')).toBe(true);
        pressKey(brightnessInput, 'Escape');
        expect(brightnessInput.value).toBe('0.25');
        expect(panel.isConnected).toBe(true);
        typeNumber(brightnessInput, '0.4');
        brightnessInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        expect(brightnessInput.value).toBe('0.25');
        expect(readSavedSettings().render.settings.display.brightness).toBe(0.25);

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

        runAnimationFrames();
        expect(player.updateRenderSettings).toHaveBeenLastCalledWith(
            expect.objectContaining({
                display: expect.objectContaining({ brightness: 0.25 }),
                toneMapping: expect.objectContaining({ inputPeakNits: 4_000 })
            }),
            true
        );

        expect(readSavedSettings()).toMatchObject({
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

        // Each restores the plugin's default, whatever it is, over the value the test set
        const defaultSettings = createDefaultWebGPUUserSettings();
        expect(readSavedSettings()).toMatchObject({
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
        const reopenedPanel = requireSettingsWindows();
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
        const readSavedPlayback = (): WebGPUUserSettings['playback'] => readSavedSettings().playback;

        const panelPromise = showWebGPUPlaybackSettingsPanel(player);
        const panel = requireSettingsWindows();
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
        expect(readSavedPlayback()).toEqual({
            decoderTestTiming: 'automatic',
            enableCustomDecode: false,
            enableGPUDecodeSlicing: false,
            enableHDRToneMapping: true
        });
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
        expect(readSavedPlayback()).toEqual({
            decoderTestTiming: 'automatic',
            enableCustomDecode: true,
            enableGPUDecodeSlicing: true,
            enableHDRToneMapping: false
        });
        expect(HDRToneMappingCheckbox.disabled).toBe(false);
        expect(GPUDecodeSlicingCheckbox.disabled).toBe(false);

        requirePanelElement<HTMLButtonElement>(
            panel,
            '[data-default-setting="enableGPUDecodeSlicing"]'
        ).click();
        expect(readSavedPlayback()).toEqual({
            decoderTestTiming: 'automatic',
            enableCustomDecode: true,
            enableGPUDecodeSlicing: false,
            enableHDRToneMapping: false
        });
        expect(GPUDecodeSlicingCheckbox.checked).toBe(false);
        GPUDecodeSlicingCheckbox.checked = true;
        GPUDecodeSlicingCheckbox.dispatchEvent(new Event('change'));

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsResetAll').click();
        expect(readSavedPlayback()).toEqual({
            decoderTestTiming: 'automatic',
            enableCustomDecode: true,
            enableGPUDecodeSlicing: false,
            enableHDRToneMapping: true
        });
        expect(HDRToneMappingCheckbox.checked).toBe(true);
        expect(GPUDecodeSlicingCheckbox.checked).toBe(false);

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('saves this browser\'s decoder test timing for the next page load, keeps it through the other playback preferences, and restores the server\'s default', async () => {
        storageMockState.value = JSON.stringify({ playback: { decoderTestTiming: 'playback' }, version: WEBGPU_USER_SETTINGS_VERSION });
        setClientDefaults({ decoderTestTiming: 'background' });
        const { panel, panelPromise } = await openPanelWithSources(createTestPlayer());
        const timingSelect = requirePanelElement<HTMLSelectElement>(panel, '[data-setting-select="decoderTestTiming"]');
        const playbackStatus = requirePanelElement<HTMLElement>(panel, '[data-playback-status]');
        expect(Array.from(timingSelect.options, (option: HTMLOptionElement): string => option.value))
            .toEqual([ 'automatic', 'background', 'playback' ]);
        expect(Array.from(timingSelect.options, (option: HTMLOptionElement): string => option.textContent)).toEqual([
            translateSourceString('WebGPUDecoderTestTimingAutomatic'),
            translateSourceString('WebGPUDecoderTestTimingBackground'),
            translateSourceString('WebGPUDecoderTestTimingPlayback')
        ]);
        expect(timingSelect.value).toBe('playback');

        timingSelect.value = 'automatic';
        timingSelect.dispatchEvent(new Event('change'));
        expect(readSavedSettings().playback.decoderTestTiming).toBe('automatic');
        expect(playbackStatus.textContent).toBe(translateSourceString('WebGPUDecoderTestTimingSavedStatus'));

        // Another playback preference keeps the timing chosen
        const customDecodeCheckbox = requirePanelElement<HTMLInputElement>(panel, '[data-setting-checkbox="enableCustomDecode"]');
        customDecodeCheckbox.checked = false;
        customDecodeCheckbox.dispatchEvent(new Event('change'));
        expect(readSavedSettings().playback.decoderTestTiming).toBe('automatic');
        expect(readSavedSettings().playback.enableCustomDecode).toBe(false);

        requirePanelElement<HTMLButtonElement>(panel, '[data-default-setting="decoderTestTiming"]').click();
        expect(timingSelect.value).toBe('background');
        // The restored timing is not stored, so it follows the server's default from now on
        expect(JSON.parse(storageMockState.value ?? '')).not.toHaveProperty('playback.decoderTestTiming');
        setClientDefaults({ decoderTestTiming: 'playback' });
        expect(readSavedSettings().playback.decoderTestTiming).toBe('playback');

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
        const panel = requireSettingsWindows();
        // No probe stopped a page, so the panel names none
        expect(requirePanelElement<HTMLElement>(panel, '[data-crashed-probes]').classList.contains('hide')).toBe(true);
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClearProbeCache').click();

        expect(readStoredCapabilityProbeVerdictState()).toBeNull();
        expect(requirePanelElement<HTMLElement>(panel, '[data-playback-status]').textContent).toContain('tests this browser');
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
        configureCapabilityProbeStore({ buildKey: '' });
    });

    it('names the probes that stopped a page with their browser calls until the results are cleared', async () => {
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
        probeStoreMockState.crashedProbes = [
            { probe: 'native-audio', steps: [ 'check mp4a.40.2', 'decode aac' ] },
            { probe: 'native-hdr:av1', steps: [] }
        ];

        const panelPromise = showWebGPUPlaybackSettingsPanel(player);
        const panel = requireSettingsWindows();
        const crashedProbes = requirePanelElement<HTMLElement>(panel, '[data-crashed-probes]');

        expect(crashedProbes.classList.contains('hide')).toBe(false);
        expect(crashedProbes.textContent).toBe(translateSourceString(
            'WebGPUCrashedProbes',
            `${translateSourceString('WebGPUCrashedProbeSteps', 'native-audio', 'check mp4a.40.2, decode aac')}, native-hdr:av1`
        ));
        expect(crashedProbes.textContent).toContain('native-audio (check mp4a.40.2, decode aac), native-hdr:av1');

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClearProbeCache').click();

        expect(readStoredCapabilityProbeVerdictState()).toBeNull();
        expect(crashedProbes.classList.contains('hide')).toBe(true);
        expect(crashedProbes.textContent).toBe('');
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
        const panel = requireSettingsWindows();
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
        const panel = requireSettingsWindows();

        const closePromise = toggleWebGPUPlaybackSettingsPanel(player);
        expect(closePromise).toBe(openPromise);
        expect(panel.isConnected).toBe(false);
        await closePromise;
        expect(document.activeElement).toBe(invokingButton);

        // A toggle right after closing opens a new panel instead of closing the old one again
        const reopenPromise = toggleWebGPUPlaybackSettingsPanel(player);
        const reopenedPanel = requireSettingsWindows();
        expect(reopenedPanel).not.toBe(panel);
        expect(document.querySelectorAll(SETTINGS_WINDOWS_SELECTOR)).toHaveLength(1);
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
            const panel = requireSettingsWindows();
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

    it('keeps the windows above the OSD controls, and keeps their room while the controls hide', async () => {
        const harness = createFullHDLayoutHarness();
        installLayoutHarness(harness);

        const panelPromise = showWebGPUPlaybackSettingsPanel(createTestPlayer());
        const panel = requireSettingsWindows();
        const master = requireWindow(panel, MASTER_WINDOW_ID);
        const masterBody = requirePanelElement<HTMLElement>(master, '[data-window-body]');
        runAnimationFrames();
        // The master is pinned to the room's start corner, below the OSD's top bar
        expect(master.style.left).toBe(`${ROOM_LEFT}px`);
        expect(master.style.top).toBe(`${ROOM_TOP}px`);
        expect(master.style.width).toBe(`${MASTER_WINDOW_WIDTH}px`);
        // 900 - 8 - 80, less the title bar
        expect(masterBody.style.maxHeight).toBe('772px');

        // Hidden OSD controls measure empty, so the windows keep the 180px they reserve at the bottom edge
        harness.OSDControlsBounds = createBounds(0, 0, 0, 0);
        harness.viewportHeight = 900;
        window.dispatchEvent(new Event('resize'));
        runAnimationFrames();
        // 900 - 180 - 8 - 80 - 40
        expect(masterBody.style.maxHeight).toBe('592px');
        harness.OSDControlsBounds = createBounds(0, 700, 1920, 200);
        window.dispatchEvent(new Event('resize'));
        runAnimationFrames();
        // 700 - 8 - 80 - 40
        expect(masterBody.style.maxHeight).toBe('572px');

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('ends above the controls of the OSD page that shows, not those of an earlier page the host keeps hidden', async () => {
        // The host's view manager keeps an earlier playback's OSD page in the document, hidden, here ahead of the one that shows
        const earlierPage = document.createElement('div');
        earlierPage.id = 'videoOsdPage';
        earlierPage.classList.add('hide');
        earlierPage.innerHTML = '<div class="videoOsdBottom videoOsdBottom-maincontrols"><div class="osdControls"></div></div>';
        document.body.prepend(earlierPage);
        try {
            installLayoutHarness(createFullHDLayoutHarness());

            const panelPromise = showWebGPUPlaybackSettingsPanel(createTestPlayer());
            const panel = requireSettingsWindows();
            runAnimationFrames();
            // 900 - 8 - 80 - 40
            expect(requirePanelElement<HTMLElement>(requireWindow(panel, MASTER_WINDOW_ID), '[data-window-body]').style.maxHeight).toBe('772px');

            requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
            await panelPromise;
        } finally {
            earlierPage.remove();
        }
    });

    it('pins the master window to the right corner in a right-to-left layout', async () => {
        document.documentElement.setAttribute('dir', 'rtl');
        installLayoutHarness(createFullHDLayoutHarness());

        const panelPromise = showWebGPUPlaybackSettingsPanel(createTestPlayer());
        const panel = requireSettingsWindows();
        runAnimationFrames();
        expect(requireWindow(panel, MASTER_WINDOW_ID).style.left).toBe(`${1920 - ROOM_LEFT - MASTER_WINDOW_WIDTH}px`);

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('shows playback info as a window beside the master once the user shows it, and hides it when the windows close', async () => {
        installLayoutHarness(createFullHDLayoutHarness());
        const player = createTestPlayer();

        const panelPromise = toggleWebGPUPlaybackSettingsPanel(player);
        const panel = requireSettingsWindows();
        // Hidden until the user shows it
        expect(handleCommand).not.toHaveBeenCalled();
        expect(requireWindowToggle(panel, PLAYBACK_INFO_WINDOW_ID).getAttribute('aria-pressed')).toBe('false');
        requireWindowToggle(panel, PLAYBACK_INFO_WINDOW_ID).click();
        expect(handleCommand).toHaveBeenCalledTimes(1);
        expect(handleCommand).toHaveBeenLastCalledWith('togglestats');

        await runHostPlaybackInfoToggles();
        const playbackInfo = requirePanelElement<HTMLElement>(document.body, '.playerStats');
        expect(requireWindowToggle(panel, PLAYBACK_INFO_WINDOW_ID).getAttribute('aria-pressed')).toBe('true');
        runAnimationFrames();
        expect(playbackInfo.classList.contains('webgpuSettingsHostedWindow')).toBe(true);
        expect(playbackInfo.style.position).toBe('fixed');
        expect(playbackInfo.style.left).toMatch(/^\d+px$/);
        expect(playbackInfo.style.top).toMatch(/^\d+px$/);
        // Beside the master window, which takes the room's whole height, past the gap
        expect(parseFloat(playbackInfo.style.left)).toBeGreaterThanOrEqual(ROOM_LEFT + MASTER_WINDOW_WIDTH + WINDOW_GAP);
        expect(parseFloat(playbackInfo.style.top)).toBeGreaterThanOrEqual(ROOM_TOP);

        await toggleWebGPUPlaybackSettingsPanel(player);
        await panelPromise;
        expect(handleCommand).toHaveBeenCalledTimes(2);
        // The host's element gets its own placement back
        expect(playbackInfo.classList.contains('webgpuSettingsHostedWindow')).toBe(false);
        expect(playbackInfo.style.position).toBe('');
        expect(playbackInfo.style.left).toBe('');
        expect(playbackInfo.style.top).toBe('');
        await runHostPlaybackInfoToggles();
        expect(playbackInfo.classList.contains('hide')).toBe(true);
    });

    it('leaves playback info that was already showing open after the windows close, with its own inline placement back', async () => {
        installLayoutHarness(createFullHDLayoutHarness());
        const playbackInfo = document.createElement('div');
        playbackInfo.classList.add('playerStats');
        playbackInfo.style.left = '5px';
        document.body.appendChild(playbackInfo);

        const panelPromise = showWebGPUPlaybackSettingsPanel(createTestPlayer());
        const panel = requireSettingsWindows();
        expect(handleCommand).not.toHaveBeenCalled();
        expect(requireWindowToggle(panel, PLAYBACK_INFO_WINDOW_ID).getAttribute('aria-pressed')).toBe('true');
        runAnimationFrames();
        expect(playbackInfo.style.position).toBe('fixed');
        expect(playbackInfo.style.left).not.toBe('5px');

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
        expect(handleCommand).not.toHaveBeenCalled();
        expect(playbackInfo.classList.contains('hide')).toBe(false);
        expect(playbackInfo.classList.contains('webgpuSettingsHostedWindow')).toBe(false);
        expect(playbackInfo.style.left).toBe('5px');
        expect(playbackInfo.style.position).toBe('');
    });

    it('undoes its playback info request when the windows close before the host shows it', async () => {
        const player = createTestPlayer();

        const panelPromise = toggleWebGPUPlaybackSettingsPanel(player);
        requireWindowToggle(requireSettingsWindows(), PLAYBACK_INFO_WINDOW_ID).click();
        await toggleWebGPUPlaybackSettingsPanel(player);
        await panelPromise;
        expect(handleCommand).toHaveBeenCalledTimes(2);

        // The host runs both toggles once its overlay module loads: the first shows playback info, the second hides it
        await runHostPlaybackInfoToggles();
        const playbackInfo = requirePanelElement<HTMLElement>(document.body, '.playerStats');
        expect(playbackInfo.classList.contains('hide')).toBe(true);
        expect(playbackInfo.classList.contains('webgpuSettingsHostedWindow')).toBe(false);
    });

    it('keeps playback info hidden on the next open after the user closes it with its own button, but not after the host hides it by itself', async () => {
        const player = createTestPlayer();

        let panelPromise = showWebGPUPlaybackSettingsPanel(player);
        let panel = requireSettingsWindows();
        requireWindowToggle(panel, PLAYBACK_INFO_WINDOW_ID).click();
        await runHostPlaybackInfoToggles();
        const playbackInfo = requirePanelElement<HTMLElement>(document.body, '.playerStats');
        // The overlay's close button hides it without a command
        playbackInfo.innerHTML = '<button type="button">x</button>';
        requirePanelElement<HTMLButtonElement>(playbackInfo, 'button').click();
        playbackInfo.classList.add('hide');
        await flushMicrotasks();
        expect(requireWindowToggle(panel, PLAYBACK_INFO_WINDOW_ID).getAttribute('aria-pressed')).toBe('false');
        expect(readStoredWindowState()[PLAYBACK_INFO_WINDOW_ID].visible).toBe(false);
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
        expect(handleCommand).toHaveBeenCalledTimes(1);

        // The next open leaves it hidden, and the user shows it from the master's list
        panelPromise = showWebGPUPlaybackSettingsPanel(player);
        panel = requireSettingsWindows();
        expect(handleCommand).toHaveBeenCalledTimes(1);
        requireWindowToggle(panel, PLAYBACK_INFO_WINDOW_ID).click();
        expect(handleCommand).toHaveBeenCalledTimes(2);
        expect(readStoredWindowState()[PLAYBACK_INFO_WINDOW_ID].visible).toBe(true);
        await runHostPlaybackInfoToggles();
        expect(playbackInfo.classList.contains('hide')).toBe(false);

        // The host hiding it by itself, as when the playback ends, changes nothing the user chose
        playbackInfo.classList.add('hide');
        await flushMicrotasks();
        expect(readStoredWindowState()[PLAYBACK_INFO_WINDOW_ID].visible).toBe(true);
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
        expect(handleCommand).toHaveBeenCalledTimes(2);

        panelPromise = showWebGPUPlaybackSettingsPanel(player);
        panel = requireSettingsWindows();
        expect(handleCommand).toHaveBeenCalledTimes(3);
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('shows and hides the section windows from the master\'s list and their own hide buttons, keeps that for the next open, and resets the layout', async () => {
        const player = createTestPlayer();

        let panelPromise = showWebGPUPlaybackSettingsPanel(player);
        let panel = requireSettingsWindows();
        const windowList = requirePanelElement<HTMLElement>(requireWindow(panel, MASTER_WINDOW_ID), '[data-settings-window-list]');
        expect(Array.from(windowList.querySelectorAll<HTMLElement>('[data-window-toggle]'), (toggle: HTMLElement): string => toggle.dataset.windowToggle ?? ''))
            .toEqual([ ...SECTION_WINDOW_IDS, PLAYBACK_INFO_WINDOW_ID ]);
        const audioToggle = requireWindowToggle(panel, 'audio');
        // Every window but the master starts hidden
        expect(audioToggle.getAttribute('aria-pressed')).toBe('false');
        expect(requireWindow(panel, 'audio').hidden).toBe(true);
        audioToggle.click();
        expect(requireWindow(panel, 'audio').hidden).toBe(false);
        expect(audioToggle.getAttribute('aria-pressed')).toBe('true');

        // A window shown again opens expanded, though the user had collapsed it
        requirePanelElement<HTMLButtonElement>(requireWindow(panel, 'audio'), '[data-window-collapse]').click();
        expect(readStoredWindowState().audio.collapsed).toBe(true);
        audioToggle.click();
        expect(requireWindow(panel, 'audio').hidden).toBe(true);
        expect(audioToggle.getAttribute('aria-pressed')).toBe('false');
        expect(readStoredWindowState().audio.visible).toBe(false);
        audioToggle.click();
        expect(requireWindow(panel, 'audio').hidden).toBe(false);
        expect(requireWindow(panel, 'audio').classList.contains('webgpuWindow-collapsed')).toBe(false);
        expect(audioToggle.getAttribute('aria-pressed')).toBe('true');
        expect(readStoredWindowState().audio).toEqual({ collapsed: false, position: null, visible: true });

        requireWindowToggle(panel, 'interface').click();
        requirePanelElement<HTMLButtonElement>(requireWindow(panel, 'interface'), '[data-window-hide]').click();
        expect(requireWindow(panel, 'interface').hidden).toBe(true);
        expect(requireWindowToggle(panel, 'interface').getAttribute('aria-pressed')).toBe('false');
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;

        panelPromise = showWebGPUPlaybackSettingsPanel(player);
        panel = requireSettingsWindows();
        expect(requireWindow(panel, 'interface').hidden).toBe(true);
        expect(requireWindow(panel, 'audio').hidden).toBe(false);

        // The layout reset returns every window to its default: hidden, and expanded once shown again
        requirePanelElement<HTMLButtonElement>(requireWindow(panel, 'audio'), '[data-window-collapse]').click();
        requirePanelElement<HTMLButtonElement>(panel, '[data-reset-layout]').click();
        expect(requireWindow(panel, 'audio').hidden).toBe(true);
        expect(readStoredWindowState().interface).toEqual({ collapsed: false, position: null, visible: false });
        expect(readStoredWindowState().audio).toEqual({ collapsed: false, position: null, visible: false });
        expect(requireWindow(panel, 'audio').classList.contains('webgpuWindow-collapsed')).toBe(false);
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('shows and hides every listed window at once from the buttons above the list, opening the hidden ones expanded', async () => {
        const panelPromise = showWebGPUPlaybackSettingsPanel(createTestPlayer());
        const panel = requireSettingsWindows();
        requirePanelElement<HTMLButtonElement>(panel, '[data-show-all-windows]').click();
        for (const id of SECTION_WINDOW_IDS) {
            expect(requireWindow(panel, id).hidden).toBe(false);
        }
        await runHostPlaybackInfoToggles();
        const playbackInfo = requirePanelElement<HTMLElement>(document.body, '.playerStats');
        expect(playbackInfo.classList.contains('hide')).toBe(false);
        requirePanelElement<HTMLButtonElement>(requireWindow(panel, 'audio'), '[data-window-collapse]').click();
        requirePanelElement<HTMLButtonElement>(requireWindow(panel, 'pipeline'), '[data-window-hide]').click();

        requirePanelElement<HTMLButtonElement>(panel, '[data-hide-all-windows]').click();
        for (const id of SECTION_WINDOW_IDS) {
            expect(requireWindow(panel, id).hidden).toBe(true);
            expect(requireWindowToggle(panel, id).getAttribute('aria-pressed')).toBe('false');
            expect(readStoredWindowState()[id].visible).toBe(false);
        }
        expect(requireWindow(panel, MASTER_WINDOW_ID).hidden).toBe(false);
        await runHostPlaybackInfoToggles();
        expect(playbackInfo.classList.contains('hide')).toBe(true);
        expect(readStoredWindowState()[PLAYBACK_INFO_WINDOW_ID].visible).toBe(false);

        requirePanelElement<HTMLButtonElement>(panel, '[data-show-all-windows]').click();
        for (const id of SECTION_WINDOW_IDS) {
            expect(requireWindow(panel, id).hidden).toBe(false);
            // The window the user had collapsed opens expanded too
            expect(requireWindow(panel, id).classList.contains('webgpuWindow-collapsed')).toBe(false);
            expect(readStoredWindowState()[id]).toEqual({ collapsed: false, position: null, visible: true });
        }
        await runHostPlaybackInfoToggles();
        expect(playbackInfo.classList.contains('hide')).toBe(false);
        expect(requireWindowToggle(panel, PLAYBACK_INFO_WINDOW_ID).getAttribute('aria-pressed')).toBe('true');

        // A window that shows already keeps its collapse
        requirePanelElement<HTMLButtonElement>(requireWindow(panel, 'picture'), '[data-window-collapse]').click();
        requirePanelElement<HTMLButtonElement>(panel, '[data-show-all-windows]').click();
        expect(requireWindow(panel, 'picture').classList.contains('webgpuWindow-collapsed')).toBe(true);
        expect(handleCommand).toHaveBeenCalledTimes(3);

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('expands and collapses a section window from its square and its title, and keeps that for the next open', async () => {
        const player = createTestPlayer();

        let panelPromise = showWebGPUPlaybackSettingsPanel(player);
        let panel = requireSettingsWindows();
        let picture = requireWindow(panel, 'picture');
        const collapseButton = requirePanelElement<HTMLButtonElement>(picture, '[data-window-collapse]');
        expect(collapseButton.getAttribute('aria-expanded')).toBe('true');

        collapseButton.click();
        expect(picture.classList.contains('webgpuWindow-collapsed')).toBe(true);
        expect(requirePanelElement<HTMLElement>(picture, '[data-window-body]').hidden).toBe(true);
        expect(collapseButton.getAttribute('aria-expanded')).toBe('false');
        expect(requirePanelElement<HTMLElement>(picture, '[data-window-title]').getAttribute('aria-expanded')).toBe('false');
        expect(readStoredWindowState().picture.collapsed).toBe(true);
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;

        panelPromise = showWebGPUPlaybackSettingsPanel(player);
        panel = requireSettingsWindows();
        picture = requireWindow(panel, 'picture');
        expect(picture.classList.contains('webgpuWindow-collapsed')).toBe(true);
        // Enter on the title expands it again
        pressKey(requirePanelElement<HTMLElement>(picture, '[data-window-title]'), 'Enter');
        expect(picture.classList.contains('webgpuWindow-collapsed')).toBe(false);
        expect(requirePanelElement<HTMLElement>(picture, '[data-window-body]').hidden).toBe(false);
        expect(readStoredWindowState().picture.collapsed).toBe(false);
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('closes on Escape from anywhere in the windows', async () => {
        const panelPromise = showWebGPUPlaybackSettingsPanel(createTestPlayer());
        const panel = requireSettingsWindows();

        const escape = pressKey(requirePanelElement<HTMLInputElement>(panel, '[data-setting-checkbox="enableCustomDecode"]'), 'Escape');
        expect(escape.defaultPrevented).toBe(true);
        await panelPromise;
        expect(panel.isConnected).toBe(false);
    });

    it('shows and hides a listed window with its digit, except while a field takes the typing', async () => {
        const panelPromise = showWebGPUPlaybackSettingsPanel(createTestPlayer());
        const panel = requireSettingsWindows();
        const closeButton = requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose');

        pressKey(closeButton, '1', { code: 'Digit1' });
        expect(requireWindow(panel, 'picture').hidden).toBe(false);
        expect(readStoredWindowState().picture.visible).toBe(true);
        // Shown, it takes the focus on its title
        expect(document.activeElement).toBe(requirePanelElement<HTMLElement>(requireWindow(panel, 'picture'), '[data-window-title]'));
        pressKey(closeButton, '1', { code: 'Numpad1' });
        expect(requireWindow(panel, 'picture').hidden).toBe(true);
        expect(readStoredWindowState().picture.visible).toBe(false);

        // A select takes its digits to choose an option
        pressKey(requirePanelElement<HTMLSelectElement>(panel, '[data-setting-select="decoderTestTiming"]'), '4', { code: 'Digit4' });
        expect(requireWindow(panel, 'interface').hidden).toBe(true);
        pressKey(closeButton, '4', { code: 'Digit4' });
        expect(requireWindow(panel, 'interface').hidden).toBe(false);

        closeButton.click();
        await panelPromise;
    });

    it('keeps key presses in the windows from reaching the OSD key handler', async () => {
        // The host's video OSD listens for keys on the document: Space pauses, the arrows seek and change the volume
        const documentKeyListener = vi.fn();
        document.addEventListener('keydown', documentKeyListener);
        try {
            const panelPromise = showWebGPUPlaybackSettingsPanel(createTestPlayer());
            const panel = requireSettingsWindows();
            pressKey(requirePanelElement<HTMLInputElement>(panel, '[data-setting-checkbox="enableCustomDecode"]'), ' ');
            pressKey(requirePanelElement<HTMLInputElement>(panel, '[data-setting-slider="brightness"]'), 'ArrowUp');
            pressKey(requirePanelElement<HTMLInputElement>(panel, '[data-setting-number="exposure"]'), 'ArrowLeft');
            pressKey(requirePanelElement<HTMLInputElement>(panel, '[data-setting-number="exposure"]'), 'ArrowUp');
            expect(documentKeyListener).not.toHaveBeenCalled();

            requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
            await panelPromise;
            pressKey(document.body, ' ');
            expect(documentKeyListener).toHaveBeenCalledOnce();
        } finally {
            document.removeEventListener('keydown', documentKeyListener);
        }
    });

    it('follows the player in the pipeline graph only while the pipeline window is expanded', async () => {
        const presentationMethods = createPresentationPlayerMethods();
        const { panel, panelPromise } = await openPanelWithSources(createPresentationTestPlayer(presentationMethods));
        const pipeline = requireWindow(panel, 'pipeline');
        // Hidden at first, the window does not follow the player
        expect(presentationMethods.getActivePresentationPlan).not.toHaveBeenCalled();

        // Shown, and so expanded, it follows the player at once
        requireWindowToggle(panel, 'pipeline').click();
        expect(presentationMethods.getActivePresentationPlan).toHaveBeenCalledTimes(1);
        expect(presentationMethods.getPresentationRoute).toHaveBeenCalledTimes(1);
        expect(requirePanelElement<HTMLElement>(pipeline, '[data-pipeline-graph]').childElementCount).toBe(1);

        // Collapsed, it stops following; expanded again, it follows anew
        requirePanelElement<HTMLButtonElement>(pipeline, '[data-window-collapse]').click();
        expect(presentationMethods.getActivePresentationPlan).toHaveBeenCalledTimes(1);
        requirePanelElement<HTMLButtonElement>(pipeline, '[data-window-collapse]').click();
        expect(presentationMethods.getActivePresentationPlan).toHaveBeenCalledTimes(2);

        // Hidden, it stops following; shown again, expanded, it follows anew
        requirePanelElement<HTMLButtonElement>(pipeline, '[data-window-hide]').click();
        requireWindowToggle(panel, 'pipeline').click();
        expect(presentationMethods.getActivePresentationPlan).toHaveBeenCalledTimes(3);

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
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
        const panel = requireSettingsWindows();
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
            commitNumber(numberInput, gainEdit.value);
            expect(updateAudioDownmixSettings).toHaveBeenLastCalledWith(
                expect.objectContaining({ [gainEdit.key]: Number(gainEdit.value) })
            );
            expect(audioStatus.textContent).toBe(AUDIO_DOWNMIX_LIVE_STATUS);
        }
        // ArrowUp steps the shown value and applies it; a typed gain may pass the slider's span up to the engine's limit
        const outputGainInput = requirePanelElement<HTMLInputElement>(panel, '[data-setting-number="outputGain"]');
        pressKey(outputGainInput, 'ArrowUp');
        expect(updateAudioDownmixSettings).toHaveBeenLastCalledWith(expect.objectContaining({ outputGain: 0.81 }));
        expect(outputGainInput.value).toBe('0.81');
        commitNumber(outputGainInput, '5');
        expect(updateAudioDownmixSettings).toHaveBeenLastCalledWith(expect.objectContaining({ outputGain: 5 }));
        expect(requirePanelElement<HTMLInputElement>(panel, '[data-setting-slider="outputGain"]').value).toBe('3');
        expect(requirePanelElement<HTMLElement>(panel, '[data-control="outputGain"]').classList.contains('webgpuBeyondSlider')).toBe(true);
        commitNumber(outputGainInput, '20');
        expect(updateAudioDownmixSettings).toHaveBeenLastCalledWith(expect.objectContaining({ outputGain: 10 }));
        expect(outputGainInput.value).toBe('10.00');
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
            expect.objectContaining({ forceStereoDownmix: true }),
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
            expect.objectContaining({ forceStereoDownmix: true }),
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
            expect.objectContaining({ forceStereoDownmix: true }),
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
            expect.objectContaining({ forceStereoDownmix: false }),
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
            expect.objectContaining({ forceStereoDownmix: true }),
            CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750
        );
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsResetAll').click();
        expect(updateAudioDownmixSettings).toHaveBeenLastCalledWith(
            createDefaultWebGPUUserSettings().audio.downmix
        );
        expect(applyAudioOutputSettings).toHaveBeenLastCalledWith(
            expect.objectContaining({ forceStereoDownmix: false }),
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

    it('saves the speaker layout and binaural rendering and applies them live', async () => {
        const applyAudioOutputSettings = vi.fn((): Promise<boolean> => Promise.resolve(true));
        const player = {
            applyAudioOutputSettings,
            getDetectedInputPeakNits: vi.fn(() => 1_000),
            getRenderSettings: vi.fn(() => createHDRToSDRRenderSettings()),
            updateAudioDownmixSettings: vi.fn(() => true),
            updateRenderSettings: vi.fn(() => true),
            ...createPresentationPlayerMethods()
        } as unknown as WebGPUPlayer;
        const panelPromise = showWebGPUPlaybackSettingsPanel(player);
        const panel = requireSettingsWindows();
        const audioStatus = requirePanelElement<HTMLElement>(panel, '[data-audio-status]');
        const speakerLayoutSelect = requirePanelElement<HTMLSelectElement>(panel, '[data-setting-select="speakerLayout"]');
        const binauralCheckbox = requirePanelElement<HTMLInputElement>(panel, '[data-setting-checkbox="binauralHeadphones"]');
        expect(speakerLayoutSelect.value).toBe('auto');
        expect(binauralCheckbox.checked).toBe(false);

        speakerLayoutSelect.value = '5.1.4';
        speakerLayoutSelect.dispatchEvent(new Event('change'));
        expect(readSavedSettings()).toMatchObject({ audio: { speakerLayout: '5.1.4' } });
        expect(applyAudioOutputSettings).toHaveBeenLastCalledWith(
            expect.objectContaining({ binauralHeadphones: false, speakerLayout: '5.1.4' }),
            DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM
        );
        await flushMicrotasks();
        expect(audioStatus.textContent).toBe(createLayoutChangeStatus(AUDIO_OUTPUT_LAYOUT_LIVE_STATUS));

        binauralCheckbox.checked = true;
        binauralCheckbox.dispatchEvent(new Event('change'));
        expect(readSavedSettings()).toMatchObject({ audio: { binauralHeadphones: true, speakerLayout: '5.1.4' } });
        expect(applyAudioOutputSettings).toHaveBeenLastCalledWith(
            expect.objectContaining({ binauralHeadphones: true, speakerLayout: '5.1.4' }),
            DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM
        );

        for (const settingKey of [ 'speakerLayout', 'binauralHeadphones' ]) {
            requirePanelElement<HTMLButtonElement>(panel, `[data-default-setting="${settingKey}"]`).click();
        }
        expect(speakerLayoutSelect.value).toBe('auto');
        expect(binauralCheckbox.checked).toBe(false);
        expect(readSavedSettings()).toMatchObject({ audio: { binauralHeadphones: false, speakerLayout: 'auto' } });
        expect(applyAudioOutputSettings).toHaveBeenLastCalledWith(
            expect.objectContaining({ binauralHeadphones: false, speakerLayout: 'auto' }),
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
        const panel = requireSettingsWindows();
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
            expect.objectContaining({ forceStereoDownmix: true }),
            DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM
        );
        expect(audioStatus.textContent).toBe(
            createLayoutChangeStatus(AUDIO_OUTPUT_LAYOUT_APPLYING_STATUS)
        );
        await flushMicrotasks();
        expect(audioStatus.textContent).toBe(
            createLayoutChangeStatus(AUDIO_OUTPUT_LAYOUT_PENDING_STATUS)
        );
        expect(readSavedSettings()).toMatchObject({
            audio: { forceStereoDownmix: true }
        });

        audioDownmixAlgorithmSelect.value = CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.NightModeDialogue;
        audioDownmixAlgorithmSelect.dispatchEvent(new Event('change'));
        expect(applyAudioOutputSettings).toHaveBeenLastCalledWith(
            expect.objectContaining({ forceStereoDownmix: true }),
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
                expect.objectContaining({ forceStereoDownmix: false }),
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
        const panel = requireSettingsWindows();
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
        commitNumber(outputGainInput, '0.5');
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
        const panel = requireSettingsWindows();
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
        const panel = requireSettingsWindows();
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
        const panel = requireSettingsWindows();
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
        expect(readSavedSettings()).toMatchObject({
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
            readSavedSettings()
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
        const panel = requireSettingsWindows();
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
        expect(readSavedSettings()).toMatchObject({
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
        expect(readSavedSettings()).toMatchObject({
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
        const panel = requireSettingsWindows();
        const pickerButton = requirePanelElement<HTMLButtonElement>(
            panel,
            '[data-audio-output-picker]'
        );

        pickerButton.click();
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsResetAudio').click();
        resolvePicker('late-success');
        await Promise.resolve();
        await Promise.resolve();
        expect(readSavedSettings()).toMatchObject({
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
        expect(readSavedSettings()).toMatchObject({
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
        const panel = requireSettingsWindows();
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
        const firstPanel = requireSettingsWindows();
        requirePanelElement<HTMLButtonElement>(firstPanel, '[data-audio-output-picker]').click();
        requirePanelElement<HTMLButtonElement>(firstPanel, '.webgpuSettingsClose').click();
        await firstPanelPromise;

        audioOutputManagerMockState.requestPromise = null;
        const secondPanelPromise = showWebGPUPlaybackSettingsPanel(player);
        const secondPanel = requireSettingsWindows();
        resolvePicker('late-output');
        await Promise.resolve();
        await Promise.resolve();

        expect(readSavedSettings()).toMatchObject({
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
        expect(parameterInput.dataset.numberMinimum).toBe(String(SATURATION_PARAMETER_MINIMUM));
        expect(parameterInput.dataset.numberMaximum).toBe(String(SATURATION_PARAMETER_MAXIMUM));
        expect(parameterInput.dataset.numberStep).toBe(String(SATURATION_PARAMETER_STEP));
        expect(parameterInput.value).toBe(formatSaturation(STORED_SATURATION));
        expect(requirePanelElement<HTMLInputElement>(panel, `[data-file-index="2"]${parameterSelector}`).value)
            .toBe(formatSaturation(SATURATION_PARAMETER_DEFAULT));

        commitNumber(parameterInput, String(CHANGED_SATURATION));
        expect(presentationMethods.setPresentationParameter)
            .toHaveBeenCalledWith(SATURATION_PASS_NAME, SATURATION_PARAMETER_NAME, CHANGED_SATURATION);
        expect(readSavedPresentation().files?.[0].parameters).toEqual({ [SATURATION_PARAMETER_NAME]: CHANGED_SATURATION });
        expect(presentationStatus.textContent).toBe(translateSourceString('WebGPUShaderPassParameterApplied'));
        // The save keeps the list as it is, so the edited input keeps its focus
        expect(parameterInput.isConnected).toBe(true);

        // A pass the player does not run yet takes the saved value when its preset next applies
        vi.mocked(presentationMethods.setPresentationParameter).mockImplementationOnce((): void => {
            throw new RangeError(PARAMETER_PENDING_ERROR);
        });
        commitNumber(parameterInput, String(SATURATION_PARAMETER_MAXIMUM));
        expect(readSavedPresentation().files?.[0].parameters).toEqual({ [SATURATION_PARAMETER_NAME]: SATURATION_PARAMETER_MAXIMUM });
        expect(presentationStatus.textContent)
            .toBe(translateSourceString('WebGPUShaderPassParameterPending', PARAMETER_PENDING_ERROR));

        // ArrowDown steps from the shown value and applies it
        pressKey(parameterInput, 'ArrowDown');
        const steppedSaturation = SATURATION_PARAMETER_MAXIMUM - SATURATION_PARAMETER_STEP;
        expect(presentationMethods.setPresentationParameter)
            .toHaveBeenLastCalledWith(SATURATION_PASS_NAME, SATURATION_PARAMETER_NAME, steppedSaturation);
        expect(readSavedPresentation().files?.[0].parameters).toEqual({ [SATURATION_PARAMETER_NAME]: steppedSaturation });
        expect(parameterInput.value).toBe(formatSaturation(steppedSaturation));

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
        commitNumber(parameterInput, String(CHANGED_SATURATION));
        // Only the pass that declares the parameter takes it
        expect(presentationMethods.setPresentationParameter).toHaveBeenCalledTimes(1);
        expect(presentationMethods.setPresentationParameter)
            .toHaveBeenCalledWith(SATURATION_PASS_NAME, SATURATION_PARAMETER_NAME, CHANGED_SATURATION);
        expect(readSavedPresentation().files?.[0].parameters).toEqual({ [SATURATION_PARAMETER_NAME]: CHANGED_SATURATION });
        // An emptied field keeps the parameter rather than taking 0, and shows it again
        commitNumber(parameterInput, '');
        expect(parameterInput.value).toBe(formatSaturation(CHANGED_SATURATION));
        expect(presentationMethods.setPresentationParameter).toHaveBeenCalledTimes(1);
        expect(readSavedPresentation().files?.[0].parameters).toEqual({ [SATURATION_PARAMETER_NAME]: CHANGED_SATURATION });

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

    it('offers the settings button placements, places the button anew on a change, and restores the server\'s default placement', async () => {
        storageMockState.value = JSON.stringify({ osd: { settingsButtonPlacement: 'after-settings' }, version: WEBGPU_USER_SETTINGS_VERSION });
        setClientDefaults({ settingsButtonPlacement: 'settings-menu' });
        const { panel, panelPromise } = await openPanelWithSources(createTestPlayer());
        const placementSelect = requirePanelElement<HTMLSelectElement>(panel, '[data-setting-select="settingsButtonPlacement"]');
        expect(Array.from(placementSelect.options, (option: HTMLOptionElement): string => option.value))
            .toEqual([ 'before-settings', 'after-settings', 'controls-end', 'settings-menu' ]);
        expect(Array.from(placementSelect.options, (option: HTMLOptionElement): string => option.textContent)).toEqual([
            translateSourceString('WebGPUSettingsButtonPlacementBeforeSettings'),
            translateSourceString('WebGPUSettingsButtonPlacementAfterSettings'),
            translateSourceString('WebGPUSettingsButtonPlacementControlsEnd'),
            translateSourceString('WebGPUSettingsButtonPlacementSettingsMenu')
        ]);
        expect(placementSelect.value).toBe('after-settings');
        expect(applySettingsButtonPlacement).not.toHaveBeenCalled();

        placementSelect.value = 'controls-end';
        placementSelect.dispatchEvent(new Event('change'));
        expect(readSavedSettings().osd.settingsButtonPlacement).toBe('controls-end');
        expect(applySettingsButtonPlacement).toHaveBeenCalledTimes(1);

        requirePanelElement<HTMLButtonElement>(panel, '[data-default-setting="settingsButtonPlacement"]').click();
        expect(placementSelect.value).toBe('settings-menu');
        expect(applySettingsButtonPlacement).toHaveBeenCalledTimes(2);
        // The restored placement is not stored, so it follows the server's default from now on
        expect(JSON.parse(storageMockState.value ?? '')).not.toHaveProperty('osd');
        setClientDefaults({ settingsButtonPlacement: 'controls-end' });
        expect(readSavedSettings().osd.settingsButtonPlacement).toBe('controls-end');

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('restores the server\'s default downmix algorithm alone, on an audio reset, and on a full reset', async () => {
        storageMockState.defaultAudioDownmixAlgorithm = CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750;
        storageMockState.audioDownmixAlgorithm = CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.AC4;
        const { panel, panelPromise } = await openPanelWithSources(createTestPlayer());
        const algorithmSelect = requirePanelElement<HTMLSelectElement>(panel, '[data-setting-select="audioDownmixAlgorithm"]');
        expect(algorithmSelect.value).toBe(CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.AC4);

        requirePanelElement<HTMLButtonElement>(panel, '[data-default-setting="audioDownmixAlgorithm"]').click();
        expect(algorithmSelect.value).toBe(CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750);
        expect(storageMockState.audioDownmixAlgorithm).toBe(CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750);
        for (const resetSelector of [ '.webgpuSettingsResetAudio', '.webgpuSettingsResetAll' ]) {
            algorithmSelect.value = CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845;
            algorithmSelect.dispatchEvent(new Event('change'));
            expect(storageMockState.audioDownmixAlgorithm).toBe(CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845);

            requirePanelElement<HTMLButtonElement>(panel, resetSelector).click();
            expect(algorithmSelect.value).toBe(CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750);
            expect(storageMockState.audioDownmixAlgorithm).toBe(CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750);
        }
        // A full reset also returns the settings button to its default placement
        expect(applySettingsButtonPlacement).toHaveBeenCalledTimes(1);

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

    it('saves black bar crop, applies it live, and restores its default', async () => {
        const presentationMethods = createPresentationPlayerMethods();
        const { panel, panelPromise } = await openPanelWithSources(createPresentationTestPlayer(presentationMethods));
        const blackBarCropCheckbox = requirePanelElement<HTMLInputElement>(panel, '[data-setting-checkbox="blackBarCrop"]');
        const blackBarCropStatus = requirePanelElement<HTMLElement>(panel, '[data-black-bar-crop-status]');
        expect(blackBarCropCheckbox.checked).toBe(false);

        blackBarCropCheckbox.checked = true;
        blackBarCropCheckbox.dispatchEvent(new Event('change'));
        await flushMicrotasks();
        expect(presentationMethods.setBlackBarCropEnabled).toHaveBeenLastCalledWith(true);
        expect(readSavedPresentation().blackBarCrop).toBe(true);
        expect(blackBarCropStatus.textContent).toBe(translateSourceString('WebGPUBlackBarCropApplied'));

        vi.mocked(presentationMethods.setBlackBarCropEnabled).mockRejectedValueOnce(new Error(BLACK_BAR_CROP_FAILURE));
        requirePanelElement<HTMLButtonElement>(panel, '[data-default-setting="blackBarCrop"]').click();
        await flushMicrotasks();
        expect(blackBarCropCheckbox.checked).toBe(false);
        expect(presentationMethods.setBlackBarCropEnabled).toHaveBeenLastCalledWith(false);
        expect(readSavedPresentation().blackBarCrop).toBe(false);
        expect(blackBarCropStatus.textContent).toBe(translateSourceString('WebGPUBlackBarCropFailed', BLACK_BAR_CROP_FAILURE));

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
        storePresentation({
            blackBarCrop: true,
            deinterlaceMode: 'single-rate',
            files: [ { parameters: {}, sourceKey: await addPassSource(INVERT_PASS_SOURCE) } ],
            hdrOutput: true
        });
        const { panel, panelPromise } = await openPanelWithSources(createPresentationTestPlayer(presentationMethods));
        const HDROutputCheckbox = requirePanelElement<HTMLInputElement>(panel, '[data-setting-checkbox="hdrOutput"]');
        const blackBarCropCheckbox = requirePanelElement<HTMLInputElement>(panel, '[data-setting-checkbox="blackBarCrop"]');
        expect(HDROutputCheckbox.checked).toBe(true);
        expect(blackBarCropCheckbox.checked).toBe(true);
        expect(readPassRows(panel)).toHaveLength(1);

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsResetAll').click();
        await flushMicrotasks();

        const defaultPresentation = createDefaultWebGPUUserSettings().presentation;
        expect(readSavedPresentation()).toEqual(defaultPresentation);
        expect(presentationMethods.setHDROutputEnabled).toHaveBeenLastCalledWith(defaultPresentation.hdrOutput);
        expect(presentationMethods.setBlackBarCropEnabled).toHaveBeenLastCalledWith(defaultPresentation.blackBarCrop);
        expect(presentationMethods.setDeinterlaceMode).toHaveBeenLastCalledWith(defaultPresentation.deinterlaceMode);
        expect(requirePanelElement<HTMLSelectElement>(panel, '[data-setting-select="deinterlaceMode"]').value).toBe(defaultPresentation.deinterlaceMode);
        // No default preset on the server resolves to no files
        expect(presentationMethods.setPresentationPreset).toHaveBeenLastCalledWith([]);
        expect(HDROutputCheckbox.checked).toBe(defaultPresentation.hdrOutput);
        expect(blackBarCropCheckbox.checked).toBe(defaultPresentation.blackBarCrop);
        expect(readPassRows(panel)).toEqual([]);
        // The reset files' sources go with them
        expect(readStoredSources().size).toBe(0);
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('hands the server\'s default files to the player on reset all, and keeps their sources', async () => {
        const presentationMethods = createPresentationPlayerMethods();
        storePresentation({ files: [ { parameters: {}, sourceKey: await addPassSource(INVERT_PASS_SOURCE) } ] });
        setDefaultSaturationPreset();
        const { panel, panelPromise } = await openPanelWithSources(createPresentationTestPlayer(presentationMethods));
        expect(readPassRows(panel).map((row: PassRow): string => row.name)).toEqual([ INVERT_PASS_NAME ]);

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsResetAll').click();
        await vi.waitFor(() => expect(presentationMethods.setPresentationPreset).toHaveBeenLastCalledWith([
            { parameters: { [SATURATION_PARAMETER_NAME]: STORED_SATURATION }, source: SATURATION_PASS_SOURCE }
        ]));
        await flushMicrotasks();

        expect(readSavedPresentation().files).toBeNull();
        expect(readPassRows(panel).map((row: PassRow): string => row.name)).toEqual([ SATURATION_PASS_NAME ]);
        // The user's file goes, and the default file the reset made stays
        expect(readStoredSources()).toEqual(new Map([ [ SECOND_SOURCE_KEY, SATURATION_PASS_SOURCE ] ]));
        expect(getRestoreDefaultPassesButton(panel).disabled).toBe(true);
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('shows the server\'s default files while the user follows them, makes an edit the user\'s own preset, and restores the default', async () => {
        const presentationMethods = createPresentationPlayerMethods();
        setDefaultSaturationPreset();
        // The player makes sure of the default files before it opens the panel
        const [ defaultFile ] = await ensureDefaultPresentationFiles();
        const { panel, panelPromise } = await openPanelWithSources(createPresentationTestPlayer(presentationMethods));
        const parameterInput = requirePanelElement<HTMLInputElement>(panel, `[data-file-index="0"][data-parameter-name="${SATURATION_PARAMETER_NAME}"]`);
        expect(readPassRows(panel).map((row: PassRow): string => row.name)).toEqual([ SATURATION_PASS_NAME ]);
        expect(parameterInput.value).toBe(formatSaturation(STORED_SATURATION));
        expect(getRestoreDefaultPassesButton(panel).disabled).toBe(true);

        commitNumber(parameterInput, String(CHANGED_SATURATION));
        expect(readSavedPresentation().files).toEqual([ { ...defaultFile, parameters: { [SATURATION_PARAMETER_NAME]: CHANGED_SATURATION } } ]);
        expect(getRestoreDefaultPassesButton(panel).disabled).toBe(false);

        getRestoreDefaultPassesButton(panel).click();
        await flushMicrotasks();
        expect(readSavedPresentation().files).toBeNull();
        expect(presentationMethods.setPresentationPreset).toHaveBeenLastCalledWith([
            { parameters: { [SATURATION_PARAMETER_NAME]: STORED_SATURATION }, source: SATURATION_PASS_SOURCE }
        ]);
        expect(requirePanelElement<HTMLInputElement>(panel, `[data-parameter-name="${SATURATION_PARAMETER_NAME}"]`).value).toBe(formatSaturation(STORED_SATURATION));
        expect(getRestoreDefaultPassesButton(panel).disabled).toBe(true);

        // Removing the default file stores an empty preset of the user's own, and the default file keeps its source
        requirePanelElement<HTMLButtonElement>(panel, '[data-remove-file="0"]').click();
        await flushMicrotasks();
        expect(readSavedPresentation().files).toEqual([]);
        expect(presentationMethods.setPresentationPreset).toHaveBeenLastCalledWith([]);
        expect(readStoredSources()).toEqual(new Map([ [ defaultFile.sourceKey, SATURATION_PASS_SOURCE ] ]));
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

        const { panel, panelPromise } = await openPanelWithSources(createTestPlayer());

        expect(requirePanelElement<HTMLElement>(panel, '[data-server-decoders]').textContent)
            .toBe(translateSourceString('WebGPUServerDecoders', `${SERVER_HEVC_PACKAGE.name}, ${SERVER_TRUEHD_PACKAGE.name}`));
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('says why the server offers nothing when it cannot be reached', async () => {
        serverModuleMockState.catalogFailure = SERVER_UNAVAILABLE_FAILURE;

        const { panel, panelPromise } = await openPanelWithSources(createTestPlayer());
        await flushMicrotasks();
        const serverPassSelect = requirePanelElement<HTMLSelectElement>(panel, '[data-server-passes]');

        expect(requirePanelElement<HTMLElement>(panel, '[data-server-decoders]').textContent)
            .toBe(translateSourceString('WebGPUServerDecodersUnavailable', SERVER_UNAVAILABLE_FAILURE));
        expect(serverPassSelect.options[0].textContent).toBe(translateSourceString('WebGPUServerPassesUnavailable', SERVER_UNAVAILABLE_FAILURE));
        expect(serverPassSelect.disabled).toBe(true);
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('moves a shader pass file up and down, saving the new order and applying the reordered preset', async () => {
        const presentationMethods = createPresentationPlayerMethods();
        const saturationSourceKey = await addPassSource(SATURATION_PASS_SOURCE);
        const invertSourceKey = await addPassSource(INVERT_PASS_SOURCE);
        storePresentation({
            files: [ { parameters: {}, sourceKey: saturationSourceKey }, { parameters: {}, sourceKey: invertSourceKey } ],
            hdrOutput: false
        });

        const { panel, panelPromise } = await openPanelWithSources(createPresentationTestPlayer(presentationMethods));
        expect(readPassRows(panel).map((row: PassRow): string => row.name)).toEqual([ SATURATION_PASS_NAME, INVERT_PASS_NAME ]);
        // The first file cannot move up, nor the last down
        expect(requirePanelElement<HTMLButtonElement>(panel, '[data-move-file="0"][data-move-direction="-1"]').disabled).toBe(true);
        expect(requirePanelElement<HTMLButtonElement>(panel, '[data-move-file="1"][data-move-direction="1"]').disabled).toBe(true);

        requirePanelElement<HTMLButtonElement>(panel, '[data-move-file="0"][data-move-direction="1"]').click();
        await flushMicrotasks();
        expect(readSavedSourceKeys()).toEqual([ invertSourceKey, saturationSourceKey ]);
        expect(presentationMethods.setPresentationPreset).toHaveBeenLastCalledWith([
            { parameters: {}, source: INVERT_PASS_SOURCE },
            { parameters: {}, source: SATURATION_PASS_SOURCE }
        ]);
        expect(readPassRows(panel).map((row: PassRow): string => row.name)).toEqual([ INVERT_PASS_NAME, SATURATION_PASS_NAME ]);

        requirePanelElement<HTMLButtonElement>(panel, '[data-move-file="1"][data-move-direction="-1"]').click();
        await flushMicrotasks();
        expect(readSavedSourceKeys()).toEqual([ saturationSourceKey, invertSourceKey ]);
        expect(presentationMethods.setPresentationPreset).toHaveBeenLastCalledWith([
            { parameters: {}, source: SATURATION_PASS_SOURCE },
            { parameters: {}, source: INVERT_PASS_SOURCE }
        ]);
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('saves the WebGPU failure warning switch and restores its default', async () => {
        const defaultWarning = createDefaultWebGPUUserSettings().osd.webGPUFailureWarning;
        const { panel, panelPromise } = await openPanelWithSources(createTestPlayer());
        const warningCheckbox = requirePanelElement<HTMLInputElement>(requireWindow(panel, 'interface'), '[data-setting-checkbox="webGPUFailureWarning"]');
        expect(warningCheckbox.checked).toBe(defaultWarning);

        warningCheckbox.checked = !defaultWarning;
        warningCheckbox.dispatchEvent(new Event('change'));
        expect(readSavedSettings().osd.webGPUFailureWarning).toBe(!defaultWarning);

        requirePanelElement<HTMLButtonElement>(panel, '[data-default-setting="webGPUFailureWarning"]').click();
        expect(warningCheckbox.checked).toBe(defaultWarning);
        expect(readSavedSettings().osd.webGPUFailureWarning).toBe(defaultWarning);
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('offers the last WebGPU failure report only when the page has one, and opens it', async () => {
        const firstOpen = await openPanelWithSources(createTestPlayer());
        expect(requirePanelElement<HTMLButtonElement>(firstOpen.panel, '.webgpuSettingsShowFailureReport').disabled).toBe(true);
        requirePanelElement<HTMLButtonElement>(firstOpen.panel, '.webgpuSettingsClose').click();
        await firstOpen.panelPromise;

        const report = { diagnosis: { cause: 'gpu-blocklisted' }, facts: {} } as unknown as WebGPUFailureReport;
        failureWarningMockState.report = report;
        const secondOpen = await openPanelWithSources(createTestPlayer());
        const reportButton = requirePanelElement<HTMLButtonElement>(secondOpen.panel, '.webgpuSettingsShowFailureReport');
        expect(reportButton.disabled).toBe(false);
        reportButton.click();
        expect(showWebGPUFailureReport).toHaveBeenCalledOnce();
        expect(showWebGPUFailureReport).toHaveBeenCalledWith(report);
        requirePanelElement<HTMLButtonElement>(secondOpen.panel, '.webgpuSettingsClose').click();
        await secondOpen.panelPromise;
    });

    it('restores each window\'s settings from its title bar reset, leaving the other windows\' settings', async () => {
        const presentationMethods = createPresentationPlayerMethods();
        storePresentation({
            blackBarCrop: true,
            deinterlaceMode: 'single-rate',
            files: [ { parameters: {}, sourceKey: await addPassSource(INVERT_PASS_SOURCE) } ],
            hdrOutput: true
        });
        const defaults = createDefaultWebGPUUserSettings();
        const { panel, panelPromise } = await openPanelWithSources(createPresentationTestPlayer(presentationMethods));
        const forceStereoCheckbox = requirePanelElement<HTMLInputElement>(panel, '[data-setting-checkbox="forceStereoDownmix"]');
        forceStereoCheckbox.checked = true;
        forceStereoCheckbox.dispatchEvent(new Event('change'));

        // Pipeline: black bar crop, deinterlacing, and the shader passes, back to the server's default preset; HDR output belongs to the picture window
        requirePanelElement<HTMLButtonElement>(requireWindow(panel, 'pipeline'), '.webgpuSettingsResetPipeline[data-reset-window="pipeline"]').click();
        await flushMicrotasks();
        expect(readSavedPresentation()).toEqual({ ...defaults.presentation, hdrOutput: true });
        expect(presentationMethods.setBlackBarCropEnabled).toHaveBeenLastCalledWith(defaults.presentation.blackBarCrop);
        expect(presentationMethods.setDeinterlaceMode).toHaveBeenLastCalledWith(defaults.presentation.deinterlaceMode);
        expect(presentationMethods.setPresentationPreset).toHaveBeenLastCalledWith([]);
        expect(presentationMethods.setHDROutputEnabled).not.toHaveBeenCalled();
        expect(readPassRows(panel)).toEqual([]);

        // Picture: tone mapping, the display, and HDR output
        commitNumber(requirePanelElement<HTMLInputElement>(panel, '[data-setting-number="brightness"]'), '0.3');
        const operatorSelect = requirePanelElement<HTMLSelectElement>(panel, '[data-setting-select="operator"]');
        operatorSelect.value = 'aces';
        operatorSelect.dispatchEvent(new Event('change'));
        expect(readSavedSettings().render.settings.display.brightness).toBe(0.3);
        requirePanelElement<HTMLButtonElement>(requireWindow(panel, 'picture'), '.webgpuSettingsResetRender[data-reset-window="picture"]').click();
        await flushMicrotasks();
        expect(readSavedSettings().render.settings.display.brightness).toBe(defaults.render.settings.display.brightness);
        expect(readSavedSettings().render.settings.toneMapping.operator).toBe(defaults.render.settings.toneMapping.operator);
        expect(operatorSelect.value).toBe(defaults.render.settings.toneMapping.operator);
        expect(readSavedPresentation().hdrOutput).toBe(defaults.presentation.hdrOutput);
        expect(presentationMethods.setHDROutputEnabled).toHaveBeenLastCalledWith(defaults.presentation.hdrOutput);

        // Interface: the settings button placement and the failure warning
        const placementSelect = requirePanelElement<HTMLSelectElement>(panel, '[data-setting-select="settingsButtonPlacement"]');
        placementSelect.value = 'controls-end';
        placementSelect.dispatchEvent(new Event('change'));
        const warningCheckbox = requirePanelElement<HTMLInputElement>(panel, '[data-setting-checkbox="webGPUFailureWarning"]');
        warningCheckbox.checked = !defaults.osd.webGPUFailureWarning;
        warningCheckbox.dispatchEvent(new Event('change'));
        requirePanelElement<HTMLButtonElement>(requireWindow(panel, 'interface'), '.webgpuSettingsResetInterface[data-reset-window="interface"]').click();
        expect(readSavedSettings().osd).toEqual(defaults.osd);
        expect(placementSelect.value).toBe(defaults.osd.settingsButtonPlacement);
        expect(warningCheckbox.checked).toBe(defaults.osd.webGPUFailureWarning);
        // Once for the change, once for the reset
        expect(applySettingsButtonPlacement).toHaveBeenCalledTimes(2);

        // Playback, in the master's title bar
        const customDecodeCheckbox = requirePanelElement<HTMLInputElement>(panel, '[data-setting-checkbox="enableCustomDecode"]');
        customDecodeCheckbox.checked = false;
        customDecodeCheckbox.dispatchEvent(new Event('change'));
        requirePanelElement<HTMLButtonElement>(requireWindow(panel, MASTER_WINDOW_ID), '.webgpuSettingsResetPlayback[data-reset-window="playback"]').click();
        expect(readSavedSettings().playback).toEqual(defaults.playback);
        expect(customDecodeCheckbox.checked).toBe(defaults.playback.enableCustomDecode);
        expect(requirePanelElement<HTMLElement>(panel, '[data-playback-status]').textContent).toBe(translateSourceString('WebGPUPlaybackChangesSavedStatus'));

        // The audio window's settings stayed through every other window's reset
        expect(readSavedSettings().audio.forceStereoDownmix).toBe(true);
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });
});

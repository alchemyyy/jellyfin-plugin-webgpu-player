import globalize from 'lib/globalize';

import {
    BROWSER_GUIDES,
    CHROMIUM_FLAGS,
    CHROMIUM_GPU_REPORT_LABELS,
    CHROMIUM_LINUX_WEBGPU_COMMAND_LINE,
    detectBrowserIdentity,
    FIREFOX_SUPPORT_LABELS,
    FIREFOX_WEBGPU_PREFERENCES,
    getGuideBrowser,
    LIBREWOLF_WEBGPU_OVERRIDE,
    OPERATING_SYSTEM_NAMES,
    readBrowserEnvironment,
    type BrowserFamily,
    type BrowserGuide,
    type BrowserIdentity,
    type ChromiumBrowserGuide,
    type FirefoxBrowserGuide,
    type GuideBrowserId,
    type SafariBrowserGuide
} from './BrowserIdentity';
import type { WebGPUFailureSource } from './WebGPUFailureWarning';

// Why WebGPU failed on this page, told from what the page can observe: its own context, navigator.gpu, a fresh adapter request, the WebGL renderer, and the browser.
// The facts are gathered once per failure; the diagnosis is pure, so the dialog diagnoses the same facts again for the browser the user picks.
// NOTE: A page cannot read the browser's GPU report or settings, so most causes are likely rather than certain, and the steps name the pages that tell for sure

/** What a request for an adapter returned: an adapter, null, an error, nothing in time, or no request where navigator.gpu is missing. */
export type WebGPUAdapterProbe =
    | Readonly<{ adapter: WebGPUAdapterSummary, result: 'adapter' }>
    | Readonly<{ message: string, result: 'rejected' }>
    | Readonly<{ result: 'null' | 'skipped' | 'timeout' }>;

/** The adapter's information, each text empty where the browser hides it. */
export type WebGPUAdapterSummary = Readonly<{
    architecture: string
    description: string
    device: string
    /** Whether the adapter is a software one; null where the browser does not say */
    isFallbackAdapter: boolean | null
    vendor: string
}>;

/** The WebGL renderer, which names the GPU the browser renders with; skipped in the Firefox family, where LibreWolf asks the user before WebGL. */
export type WebGLRendererProbe =
    | Readonly<{ renderer: string, result: 'renderer', vendor: string }>
    | Readonly<{ result: 'skipped' | 'unavailable' }>;

/** The last loss of the presenter's device on this page. */
export type WebGPUDeviceLostFacts = Readonly<{
    message: string
    reason: string
}>;

/** What the page observed around a WebGPU failure. */
export type WebGPUFailureFacts = Readonly<{
    /** A fresh request for the default adapter */
    adapter: WebGPUAdapterProbe
    browser: BrowserIdentity
    /** The processor architecture user agent data reports, such as arm or x86; null where the browser does not say */
    cpuArchitecture: string | null
    deviceLost: WebGPUDeviceLostFacts | null
    /** A request for a software adapter, made only when the default request returned null */
    fallbackAdapter: WebGPUAdapterProbe
    gpuPresent: boolean
    origin: string
    secureContext: boolean
    /** The failure the engine reported */
    source: WebGPUFailureSource
    userAgent: string
    webGL: WebGLRendererProbe
}>;

export type WebGPUFailureCause =
    | 'device-failed'
    | 'device-lost'
    | 'gpu-blocked'
    | 'gpu-crashed'
    | 'hardware-acceleration-off'
    | 'insecure-context'
    | 'rendering-failed'
    | 'software-renderer'
    | 'unknown'
    | 'webgpu-missing'
    | 'webgpu-not-shipped';

export type WebGPUFailureConfidence = 'certain' | 'likely' | 'possible';

export type WebGPUFixStepCode =
    | 'check-firefox-support'
    | 'check-gpu-report'
    | 'enable-hardware-acceleration'
    | 'enable-hardware-acceleration-firefox'
    | 'enable-hardware-acceleration-menu'
    | 'enable-unsafe-webgpu-flag'
    | 'enable-vulkan-flag'
    | 'firefox-android'
    | 'firefox-enable-preference'
    | 'firefox-ignore-blocklist'
    | 'firefox-troubleshoot-mode'
    | 'ios-uses-webkit'
    | 'librewolf-overrides'
    | 'linux-command-line'
    | 'reload-page'
    | 'report-problem'
    | 'reset-flags'
    | 'restart-browser'
    | 'safari-feature-flag-ios'
    | 'safari-feature-flag-macos'
    | 'safari-lockdown-mode'
    | 'update-browser'
    | 'update-browser-latest'
    | 'update-gpu-driver'
    | 'update-system'
    | 'use-firefox-nightly'
    | 'use-https'
    | 'use-real-gpu';

/** A step's argument: an address, preference or command to copy, a label the browser shows, or plain text such as a browser's name. */
export type WebGPUFixStepArgument = Readonly<{ kind: 'code' | 'label' | 'text', value: string }>;

export type WebGPUFixStep = Readonly<{ args: readonly WebGPUFixStepArgument[], code: WebGPUFixStepCode }>;

/** One line of the report's details: a technical name, and its value as observed. */
export type WebGPUFailureFactLine = Readonly<{ label: string, value: string }>;

export type WebGPUFailureDiagnosis = Readonly<{
    /** The browser the steps are written for */
    browser: GuideBrowserId
    cause: WebGPUFailureCause
    confidence: WebGPUFailureConfidence
    /** The explanation's string key and arguments: a cause reads differently by browser and system */
    explanation: Readonly<{ args: readonly string[], key: string }>
    facts: readonly WebGPUFailureFactLine[]
    /** The fixes to try, in order */
    steps: readonly WebGPUFixStep[]
}>;

export type WebGPUFailureReport = Readonly<{
    diagnosis: WebGPUFailureDiagnosis
    facts: WebGPUFailureFacts
}>;

/** Each cause's headline. */
export const WEBGPU_FAILURE_CAUSE_KEYS: Readonly<Record<WebGPUFailureCause, string>> = Object.freeze({
    'device-failed': 'WebGPUFailureCauseDeviceFailed',
    'device-lost': 'WebGPUFailureCauseDeviceLost',
    'gpu-blocked': 'WebGPUFailureCauseGPUBlocked',
    'gpu-crashed': 'WebGPUFailureCauseGPUCrashed',
    'hardware-acceleration-off': 'WebGPUFailureCauseHardwareAccelerationOff',
    'insecure-context': 'WebGPUFailureCauseInsecureContext',
    'rendering-failed': 'WebGPUFailureCauseRenderingFailed',
    'software-renderer': 'WebGPUFailureCauseSoftwareRenderer',
    'unknown': 'WebGPUFailureCauseUnknown',
    'webgpu-missing': 'WebGPUFailureCauseWebGPUMissing',
    'webgpu-not-shipped': 'WebGPUFailureCauseWebGPUNotShipped'
});

/** How sure each confidence is, as a sentence. */
export const WEBGPU_FAILURE_CONFIDENCE_KEYS: Readonly<Record<WebGPUFailureConfidence, string>> = Object.freeze({
    certain: 'WebGPUFailureConfidenceCertain',
    likely: 'WebGPUFailureConfidenceLikely',
    possible: 'WebGPUFailureConfidencePossible'
});

/** Each fix step's text, whose {n} placeholders take the step's arguments. */
export const WEBGPU_FIX_STEP_KEYS: Readonly<Record<WebGPUFixStepCode, string>> = Object.freeze({
    'check-firefox-support': 'WebGPUFailureStepCheckFirefoxSupport',
    'check-gpu-report': 'WebGPUFailureStepCheckGPUReport',
    'enable-hardware-acceleration': 'WebGPUFailureStepEnableHardwareAcceleration',
    'enable-hardware-acceleration-firefox': 'WebGPUFailureStepEnableHardwareAccelerationFirefox',
    'enable-hardware-acceleration-menu': 'WebGPUFailureStepEnableHardwareAccelerationMenu',
    'enable-unsafe-webgpu-flag': 'WebGPUFailureStepEnableUnsafeWebGPUFlag',
    'enable-vulkan-flag': 'WebGPUFailureStepEnableVulkanFlag',
    'firefox-android': 'WebGPUFailureStepFirefoxAndroid',
    'firefox-enable-preference': 'WebGPUFailureStepFirefoxEnablePreference',
    'firefox-ignore-blocklist': 'WebGPUFailureStepFirefoxIgnoreBlocklist',
    'firefox-troubleshoot-mode': 'WebGPUFailureStepFirefoxTroubleshootMode',
    'ios-uses-webkit': 'WebGPUFailureStepIOSUsesWebKit',
    'librewolf-overrides': 'WebGPUFailureStepLibreWolfOverrides',
    'linux-command-line': 'WebGPUFailureStepLinuxCommandLine',
    'reload-page': 'WebGPUFailureStepReloadPage',
    'report-problem': 'WebGPUFailureStepReportProblem',
    'reset-flags': 'WebGPUFailureStepResetFlags',
    'restart-browser': 'WebGPUFailureStepRestartBrowser',
    'safari-feature-flag-ios': 'WebGPUFailureStepSafariFeatureFlagIOS',
    'safari-feature-flag-macos': 'WebGPUFailureStepSafariFeatureFlagMacOS',
    'safari-lockdown-mode': 'WebGPUFailureStepSafariLockdownMode',
    'update-browser': 'WebGPUFailureStepUpdateBrowser',
    'update-browser-latest': 'WebGPUFailureStepUpdateBrowserLatest',
    'update-gpu-driver': 'WebGPUFailureStepUpdateGPUDriver',
    'update-system': 'WebGPUFailureStepUpdateSystem',
    'use-firefox-nightly': 'WebGPUFailureStepUseFirefoxNightly',
    'use-https': 'WebGPUFailureStepUseHTTPS',
    'use-real-gpu': 'WebGPUFailureStepUseRealGPU'
});

// Each probe waits this long; a GPU process that hangs answers no request
const ADAPTER_TIMEOUT_MILLISECONDS = 3_000;
const HIGH_ENTROPY_TIMEOUT_MILLISECONDS = 2_000;
// Firefox release builds refuse the adapter with this sentence where WebGPU has not shipped
const RELEASE_GATE_PATTERN = /not yet available in Release/i;
// Software renderers: SwiftShader (Chromium), WARP and the Basic Render Driver (Windows), llvmpipe and softpipe (Mesa)
const SOFTWARE_RENDERER_PATTERN = /SwiftShader|Basic Render Driver|\bWARP\b|llvmpipe|softpipe/i;
// The first versions with WebGPU on by default, from the gpuweb implementation status
const CHROMIUM_WEBGPU_VERSION = 113;
const CHROMIUM_ANDROID_WEBGPU_VERSION = 121;
const CHROMIUM_LINUX_WEBGPU_VERSION = 144;
const FIREFOX_WINDOWS_WEBGPU_VERSION = 141;
const FIREFOX_MACOS_WEBGPU_VERSION = 147;
const SAFARI_WEBGPU_VERSION = 26;
const ARM_ARCHITECTURE = 'arm';
// The engine's presentation reasons where WebGPU itself works but drawing with it failed
const RENDERING_REASONS: Readonly<Partial<Record<string, true>>> = Object.freeze({
    'canvas-configuration-failed': true,
    'canvas-context-unavailable': true,
    'pipeline-creation-failed': true
});
// Placeholders a translated text keeps its arguments in, so the text around them can be escaped apart from them
const ARGUMENT_START = '\uE000';
const ARGUMENT_END = '\uE001';
const ARGUMENT_PATTERN = /\uE000(\d+)\uE001/;
const SKIPPED_PROBE: WebGPUAdapterProbe = Object.freeze({ result: 'skipped' });

/** Whether WebGPU is on by default for a browser, system and version, as the page can tell. */
type ShippingVerdict =
    | Readonly<{ kind: 'flag-only' | 'not-on-platform' | 'shipped' | 'some-gpus' | 'unknown' }>
    | Readonly<{ kind: 'too-old', minimumVersion: number }>;

type DiagnosisContext = Readonly<{
    /** The picked browser's name, which on iOS and iPadOS may differ from the guide's */
    browserName: string
    facts: WebGPUFailureFacts
    guide: BrowserGuide
    osName: string
    shipping: ShippingVerdict
    /** The engine version, when the picked browser shares the detected engine */
    version: number | null
}>;

type Finding = Readonly<{
    cause: WebGPUFailureCause
    confidence: WebGPUFailureConfidence
    explanation: Readonly<{ args: readonly string[], key: string }>
}>;

type NavigatorWithUserAgentData = Navigator & Readonly<{
    userAgentData?: Readonly<{ getHighEntropyValues?: (hints: readonly string[]) => Promise<Readonly<Record<string, unknown>>> }>
}>;

function getErrorMessage(error: unknown): string {
    if (error instanceof Error || error instanceof DOMException) {
        return `${error.name}: ${error.message}`;
    }
    return String(error);
}

/** Resolves with the promise's value, or null once the time is up; a rejection rejects. */
function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<Readonly<{ value: T }> | null> {
    return new Promise((resolve, reject): void => {
        const timer = setTimeout((): void => resolve(null), milliseconds);
        promise.then((value: T): void => {
            clearTimeout(timer);
            resolve({ value });
        }, (error: unknown): void => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

function readText(record: Readonly<Record<string, unknown>>, key: string): string {
    const value = record[key];
    return typeof value === 'string' ? value : '';
}

function readFallbackFlag(info: Readonly<Record<string, unknown>>, adapter: GPUAdapter): boolean | null {
    if (typeof info.isFallbackAdapter === 'boolean') {
        return info.isFallbackAdapter;
    }
    // Before GPUAdapterInfo had it, the adapter said so itself
    const legacy = (adapter as unknown as Readonly<{ isFallbackAdapter?: unknown }>).isFallbackAdapter;
    return typeof legacy === 'boolean' ? legacy : null;
}

function readAdapterSummary(adapter: GPUAdapter): WebGPUAdapterSummary {
    // The attributes are getters, so they read through the record too
    const info = ((adapter as Partial<Pick<GPUAdapter, 'info'>>).info ?? {}) as Readonly<Record<string, unknown>>;
    return {
        architecture: readText(info, 'architecture'),
        description: readText(info, 'description'),
        device: readText(info, 'device'),
        isFallbackAdapter: readFallbackFlag(info, adapter),
        vendor: readText(info, 'vendor')
    };
}

async function probeAdapter(gpu: GPU, options?: GPURequestAdapterOptions): Promise<WebGPUAdapterProbe> {
    try {
        const timed = await withTimeout(gpu.requestAdapter(options), ADAPTER_TIMEOUT_MILLISECONDS);
        if (timed === null) {
            return { result: 'timeout' };
        }
        return timed.value ? { adapter: readAdapterSummary(timed.value), result: 'adapter' } : { result: 'null' };
    } catch (error) {
        return { message: getErrorMessage(error), result: 'rejected' };
    }
}

function readWebGLRenderer(family: BrowserFamily): WebGLRendererProbe {
    if (family === 'firefox' || typeof document === 'undefined') {
        return { result: 'skipped' };
    }
    try {
        const context = document.createElement('canvas').getContext('webgl');
        if (!context) {
            return { result: 'unavailable' };
        }
        try {
            const debugInfo = context.getExtension('WEBGL_debug_renderer_info');
            const renderer: unknown = context.getParameter(debugInfo ? debugInfo.UNMASKED_RENDERER_WEBGL : context.RENDERER);
            const vendor: unknown = context.getParameter(debugInfo ? debugInfo.UNMASKED_VENDOR_WEBGL : context.VENDOR);
            return { renderer: String(renderer ?? ''), result: 'renderer', vendor: String(vendor ?? '') };
        } finally {
            // Browsers keep few WebGL contexts, so this one goes at once
            context.getExtension('WEBGL_lose_context')?.loseContext();
        }
    } catch {
        return { result: 'unavailable' };
    }
}

async function readCpuArchitecture(): Promise<string | null> {
    const userAgentData = typeof navigator === 'undefined' ? undefined : (navigator as NavigatorWithUserAgentData).userAgentData;
    if (typeof userAgentData?.getHighEntropyValues !== 'function') {
        return null;
    }
    try {
        const timed = await withTimeout(userAgentData.getHighEntropyValues([ 'architecture', 'bitness' ]), HIGH_ENTROPY_TIMEOUT_MILLISECONDS);
        const architecture = timed === null ? '' : readText(timed.value, 'architecture');
        return architecture === '' ? null : architecture;
    } catch {
        return null;
    }
}

/**
 * Gathers what the page can observe about a WebGPU failure; each probe gives up after a few seconds, and nothing throws.
 * The software adapter is requested only when the default request returned null.
 */
export async function collectWebGPUFailureFacts(source: WebGPUFailureSource, deviceLost: WebGPUDeviceLostFacts | null): Promise<WebGPUFailureFacts> {
    const environment = readBrowserEnvironment();
    const browser = detectBrowserIdentity(environment);
    const gpu = typeof navigator === 'undefined' ? null : navigator.gpu ?? null;
    const [ adapter, cpuArchitecture ] = await Promise.all([ gpu ? probeAdapter(gpu) : SKIPPED_PROBE, readCpuArchitecture() ]);
    const fallbackAdapter = gpu && adapter.result === 'null' ? await probeAdapter(gpu, { forceFallbackAdapter: true }) : SKIPPED_PROBE;
    return {
        adapter,
        browser,
        cpuArchitecture,
        deviceLost,
        fallbackAdapter,
        gpuPresent: gpu !== null,
        origin: typeof window === 'undefined' ? '' : window.location.origin,
        // eslint-disable-next-line compat/compat -- A browser without isSecureContext reads as insecure, which it is to WebGPU
        secureContext: typeof window !== 'undefined' && window.isSecureContext === true,
        source,
        userAgent: environment.userAgent,
        webGL: readWebGLRenderer(browser.family)
    };
}

function getChromiumShipping(facts: WebGPUFailureFacts, version: number | null): ShippingVerdict {
    const isOlderThan = (minimumVersion: number): boolean => version !== null && version < minimumVersion;
    switch (facts.browser.os) {
        case 'windows':
            if (facts.cpuArchitecture === ARM_ARCHITECTURE) {
                return { kind: 'flag-only' };
            }
            return isOlderThan(CHROMIUM_WEBGPU_VERSION) ? { kind: 'too-old', minimumVersion: CHROMIUM_WEBGPU_VERSION } : { kind: 'shipped' };
        case 'chromeos':
        case 'macos':
            return isOlderThan(CHROMIUM_WEBGPU_VERSION) ? { kind: 'too-old', minimumVersion: CHROMIUM_WEBGPU_VERSION } : { kind: 'shipped' };
        // Linux and Android have WebGPU only for some GPUs, Android from Android 12
        case 'linux':
            return isOlderThan(CHROMIUM_LINUX_WEBGPU_VERSION) ? { kind: 'too-old', minimumVersion: CHROMIUM_LINUX_WEBGPU_VERSION } : { kind: 'some-gpus' };
        case 'android':
            return isOlderThan(CHROMIUM_ANDROID_WEBGPU_VERSION) ? { kind: 'too-old', minimumVersion: CHROMIUM_ANDROID_WEBGPU_VERSION } : { kind: 'some-gpus' };
        default:
            return { kind: 'unknown' };
    }
}

function getFirefoxShipping(facts: WebGPUFailureFacts, version: number | null): ShippingVerdict {
    switch (facts.browser.os) {
        case 'windows':
            return version !== null && version < FIREFOX_WINDOWS_WEBGPU_VERSION ?
                { kind: 'too-old', minimumVersion: FIREFOX_WINDOWS_WEBGPU_VERSION } :
                { kind: 'shipped' };
        // Apple Silicon Macs only; the page cannot tell them from Intel Macs
        case 'macos':
            return version !== null && version < FIREFOX_MACOS_WEBGPU_VERSION ?
                { kind: 'too-old', minimumVersion: FIREFOX_MACOS_WEBGPU_VERSION } :
                { kind: 'some-gpus' };
        case 'android':
        case 'linux':
            return { kind: 'not-on-platform' };
        default:
            return { kind: 'unknown' };
    }
}

function getShipping(facts: WebGPUFailureFacts, guide: BrowserGuide, version: number | null): ShippingVerdict {
    switch (guide.family) {
        case 'chromium':
            return getChromiumShipping(facts, version);
        case 'firefox':
            return getFirefoxShipping(facts, version);
        default:
            if (version === null) {
                return { kind: 'unknown' };
            }
            return version < SAFARI_WEBGPU_VERSION ? { kind: 'too-old', minimumVersion: SAFARI_WEBGPU_VERSION } : { kind: 'shipped' };
    }
}

function createContext(facts: WebGPUFailureFacts, browser: GuideBrowserId): DiagnosisContext {
    // Every browser on iOS and iPadOS is Safari's engine, so Safari's guide applies to each
    const guide = facts.browser.os === 'ios' ? BROWSER_GUIDES.safari : BROWSER_GUIDES[browser];
    const version = guide.family === facts.browser.family ? facts.browser.majorVersion : null;
    // Safari runs only on Apple's systems, so its guide picked on another system is the Mac's
    const os = guide.family === 'safari' && facts.browser.os !== 'ios' ? 'macos' : facts.browser.os;
    return {
        browserName: BROWSER_GUIDES[browser].name,
        facts,
        guide,
        osName: OPERATING_SYSTEM_NAMES[os],
        shipping: getShipping(facts, guide, version),
        version
    };
}

function find(cause: WebGPUFailureCause, confidence: WebGPUFailureConfidence, key: string, ...args: string[]): Finding {
    return { cause, confidence, explanation: { args, key } };
}

function getSoftwareRenderer(facts: WebGPUFailureFacts): string | null {
    if (facts.webGL.result === 'renderer' && SOFTWARE_RENDERER_PATTERN.test(facts.webGL.renderer)) {
        return facts.webGL.renderer;
    }
    return null;
}

/** Explains a missing navigator.gpu in a secure context: no WebGPU in this browser and system yet, else turned off. */
function findMissingCause(context: DiagnosisContext): Finding {
    const { browserName, guide, osName, shipping } = context;
    switch (shipping.kind) {
        case 'too-old':
            return findTooOld(context, shipping.minimumVersion, 'certain');
        case 'not-on-platform':
            return find('webgpu-not-shipped', 'certain', 'WebGPUFailureCauseNotOnPlatformHelp', browserName, osName);
        case 'flag-only':
            return find('webgpu-not-shipped', 'likely', 'WebGPUFailureCauseFlagOnlyHelp', browserName);
        case 'some-gpus':
            return guide.family === 'firefox' ?
                find('webgpu-not-shipped', 'likely', 'WebGPUFailureCauseFirefoxIntelMacHelp', browserName) :
                find('webgpu-not-shipped', 'likely', 'WebGPUFailureCauseSomeGPUsHelp', browserName, osName);
        case 'unknown':
            return find('webgpu-missing', 'possible', 'WebGPUFailureCauseWebGPUMissingHelp', browserName);
        default:
            if (guide.family === 'firefox') {
                return find('webgpu-missing', 'likely', 'WebGPUFailureCauseWebGPUMissingFirefoxHelp', browserName);
            }
            return guide.family === 'safari' ?
                find('webgpu-missing', 'likely', 'WebGPUFailureCauseWebGPUMissingSafariHelp', browserName) :
                find('webgpu-missing', 'likely', 'WebGPUFailureCauseWebGPUMissingChromiumHelp', browserName);
    }
}

function findTooOld(context: DiagnosisContext, minimumVersion: number, confidence: WebGPUFailureConfidence): Finding {
    const version = String(context.version);
    return context.guide.family === 'safari' ?
        find('webgpu-not-shipped', confidence, 'WebGPUFailureCauseSafariTooOldHelp', version, String(minimumVersion), context.osName) :
        find('webgpu-not-shipped', confidence, 'WebGPUFailureCauseTooOldHelp', context.browserName, version, String(minimumVersion));
}

/** Explains an adapter request that returned null: crashes, an unsupported system, software rendering, hardware acceleration off, or a blocked GPU. */
function findNullAdapterCause(context: DiagnosisContext): Finding {
    const { browserName, facts, guide, osName, shipping } = context;
    if (facts.deviceLost !== null) {
        return find('gpu-crashed', 'likely', 'WebGPUFailureCauseGPUCrashedHelp', browserName);
    }
    if (shipping.kind === 'too-old') {
        return findTooOld(context, shipping.minimumVersion, 'likely');
    }
    if (shipping.kind === 'flag-only') {
        return find('webgpu-not-shipped', 'likely', 'WebGPUFailureCauseFlagOnlyHelp', browserName);
    }
    if (shipping.kind === 'not-on-platform') {
        return find('webgpu-not-shipped', 'likely', 'WebGPUFailureCauseNotOnPlatformHelp', browserName, osName);
    }
    const softwareRenderer = getSoftwareRenderer(facts);
    if (softwareRenderer !== null) {
        return find('software-renderer', 'likely', 'WebGPUFailureCauseSoftwareRendererHelp', browserName, softwareRenderer);
    }
    if (guide.family === 'chromium' && facts.webGL.result === 'unavailable') {
        return find('hardware-acceleration-off', 'likely', 'WebGPUFailureCauseHardwareAccelerationOffHelp', browserName);
    }
    if (shipping.kind === 'some-gpus') {
        return guide.family === 'firefox' ?
            find('webgpu-not-shipped', 'possible', 'WebGPUFailureCauseFirefoxIntelMacHelp', browserName) :
            find('webgpu-not-shipped', 'likely', 'WebGPUFailureCauseSomeGPUsHelp', browserName, osName);
    }
    if (facts.webGL.result === 'renderer') {
        return find('gpu-blocked', 'likely', 'WebGPUFailureCauseGPUBlockedHelp', browserName, facts.webGL.renderer);
    }
    return guide.family === 'safari' ?
        find('unknown', 'possible', 'WebGPUFailureCauseNoAdapterHelp', browserName) :
        find('gpu-blocked', 'possible', 'WebGPUFailureCauseGPUBlockedUnnamedHelp', browserName);
}

/** Explains a failure while an adapter is available again: a software adapter, a lost device, a refused device, or a drawing failure. */
function findDeviceCause(context: DiagnosisContext, adapter: WebGPUAdapterSummary): Finding {
    const { browserName, facts } = context;
    const { source } = facts;
    if (adapter.isFallbackAdapter === true) {
        return find('software-renderer', 'likely', 'WebGPUFailureCauseFallbackAdapterHelp', browserName);
    }
    if (facts.deviceLost !== null || (source.kind === 'presentation' && source.reason === 'device-recovery-failed')) {
        return find('device-lost', 'likely', 'WebGPUFailureCauseDeviceLostHelp', browserName);
    }
    if (source.kind === 'presentation' && source.reason === 'device-request-failed') {
        return find('device-failed', 'likely', 'WebGPUFailureCauseDeviceFailedHelp', source.detail);
    }
    if (source.kind === 'presentation' && RENDERING_REASONS[source.reason] === true) {
        return find('rendering-failed', 'possible', 'WebGPUFailureCauseRenderingFailedHelp', source.reason, source.detail);
    }
    const softwareRenderer = getSoftwareRenderer(facts);
    if (softwareRenderer !== null) {
        return find('software-renderer', 'possible', 'WebGPUFailureCauseSoftwareRendererHelp', browserName, softwareRenderer);
    }
    return find('unknown', 'possible', 'WebGPUFailureCauseTransientHelp', browserName);
}

function findCause(context: DiagnosisContext): Finding {
    const { browserName, facts, osName } = context;
    const { adapter, source } = facts;
    if (!facts.secureContext || source.reason === 'insecure-context') {
        return find('insecure-context', 'certain', 'WebGPUFailureCauseInsecureContextHelp', facts.origin);
    }
    if (adapter.result === 'rejected' && RELEASE_GATE_PATTERN.test(adapter.message)) {
        return find('webgpu-not-shipped', 'certain', 'WebGPUFailureCauseReleaseBuildHelp', browserName, osName);
    }
    if (!facts.gpuPresent) {
        return findMissingCause(context);
    }
    switch (adapter.result) {
        case 'adapter':
            return findDeviceCause(context, adapter.adapter);
        case 'null':
            return findNullAdapterCause(context);
        case 'timeout':
            return find('gpu-crashed', 'possible', 'WebGPUFailureCauseAdapterTimeoutHelp', browserName);
        case 'rejected':
            return find('gpu-blocked', 'possible', 'WebGPUFailureCauseAdapterRejectedHelp', browserName, adapter.message);
        default:
            return find('unknown', 'possible', 'WebGPUFailureCauseTransientHelp', browserName);
    }
}

function code(value: string): WebGPUFixStepArgument {
    return { kind: 'code', value };
}

function label(value: string): WebGPUFixStepArgument {
    return { kind: 'label', value };
}

function text(value: string): WebGPUFixStepArgument {
    return { kind: 'text', value };
}

function step(stepCode: WebGPUFixStepCode, ...args: WebGPUFixStepArgument[]): WebGPUFixStep {
    return { args, code: stepCode };
}

function createHardwareAccelerationStep(guide: ChromiumBrowserGuide | FirefoxBrowserGuide): WebGPUFixStep {
    if (guide.family === 'firefox') {
        const setting = guide.hardwareAcceleration;
        return step(
            'enable-hardware-acceleration-firefox',
            code(setting.page),
            label(setting.recommendedLabel),
            label(setting.label),
            text(guide.name)
        );
    }
    const { label: settingLabel, location: settingLocation } = guide.hardwareAcceleration;
    return settingLocation.kind === 'page' ?
        step('enable-hardware-acceleration', code(settingLocation.address), label(settingLabel), text(guide.name)) :
        step('enable-hardware-acceleration-menu', label(settingLocation.path), label(settingLabel), text(guide.name));
}

function createReportPageStep(guide: ChromiumBrowserGuide | FirefoxBrowserGuide): WebGPUFixStep {
    return guide.family === 'chromium' ?
        step(
            'check-gpu-report',
            code(guide.gpuReportPage),
            label(CHROMIUM_GPU_REPORT_LABELS.webGPU),
            label(CHROMIUM_GPU_REPORT_LABELS.problems),
            label(CHROMIUM_GPU_REPORT_LABELS.download)
        ) :
        step('check-firefox-support', code(guide.gpuReportPage), label(FIREFOX_SUPPORT_LABELS.graphics), label(FIREFOX_SUPPORT_LABELS.failureLog));
}

function createUnsafeFlagStep(guide: ChromiumBrowserGuide): WebGPUFixStep {
    return step(
        'enable-unsafe-webgpu-flag',
        code(`${guide.flagsPage}/#${CHROMIUM_FLAGS.unsafeWebGPU.id}`),
        label(CHROMIUM_FLAGS.unsafeWebGPU.label),
        text(guide.name)
    );
}

function createUpdateStep(context: DiagnosisContext): WebGPUFixStep {
    const { shipping } = context;
    if (context.guide.family === 'safari') {
        return step('update-system', text(context.osName), text(String(SAFARI_WEBGPU_VERSION)));
    }
    return shipping.kind === 'too-old' ?
        step('update-browser', text(context.browserName), text(String(shipping.minimumVersion))) :
        step('update-browser-latest', text(context.browserName));
}

function createSafariFlagStep(context: DiagnosisContext, guide: SafariBrowserGuide): WebGPUFixStep {
    const { ios, macos } = guide.featureFlags;
    return context.facts.browser.os === 'ios' ?
        step('safari-feature-flag-ios', label(ios.path), label(ios.earlierPath), label(ios.flag)) :
        step('safari-feature-flag-macos', label(macos.advancedPath), label(macos.developerFeaturesLabel), label(macos.flagsPath), label(macos.flag));
}

function getChromiumNotShippedSteps(context: DiagnosisContext, guide: ChromiumBrowserGuide): WebGPUFixStep[] {
    const { os } = context.facts.browser;
    if (context.shipping.kind === 'flag-only') {
        return [ createUnsafeFlagStep(guide) ];
    }
    const steps = [ createUpdateStep(context) ];
    // Elsewhere an update is enough; on Linux and Android the GPU may need the flag too
    if (os === 'android' || os === 'linux') {
        steps.push(createUnsafeFlagStep(guide));
    }
    if (os === 'linux') {
        steps.push(
            step('enable-vulkan-flag', code(`${guide.flagsPage}/#${CHROMIUM_FLAGS.vulkan.id}`), label(CHROMIUM_FLAGS.vulkan.label)),
            step('linux-command-line', text(guide.name), code(CHROMIUM_LINUX_WEBGPU_COMMAND_LINE)),
            createReportPageStep(guide)
        );
    }
    return steps;
}

function getFirefoxNotShippedSteps(context: DiagnosisContext): WebGPUFixStep[] {
    const { facts, shipping } = context;
    if (shipping.kind === 'too-old') {
        return [ createUpdateStep(context) ];
    }
    if (facts.browser.os === 'android') {
        return [ step('firefox-android', code('about:config'), code(FIREFOX_WEBGPU_PREFERENCES.ignoreBlocklist), code('true')) ];
    }
    // Linux, and Intel Macs, which a page tells from Apple Silicon only by the release build's refusal
    const platform = facts.browser.os === 'macos' ? 'Intel Macs' : context.osName;
    return [ step('use-firefox-nightly', text(context.browserName), text(platform)) ];
}

function getNotShippedSteps(context: DiagnosisContext): WebGPUFixStep[] {
    const { guide } = context;
    switch (guide.family) {
        case 'chromium':
            return getChromiumNotShippedSteps(context, guide);
        case 'firefox':
            return getFirefoxNotShippedSteps(context);
        default:
            return [ createUpdateStep(context), createSafariFlagStep(context, guide) ];
    }
}

function getMissingSteps(context: DiagnosisContext): WebGPUFixStep[] {
    const { guide } = context;
    switch (guide.family) {
        case 'chromium':
            return [ step('reset-flags', code(guide.flagsPage), label('Reset all')), createHardwareAccelerationStep(guide), createReportPageStep(guide) ];
        case 'firefox': {
            const steps = [ step('firefox-enable-preference', code(guide.configPage), code(FIREFOX_WEBGPU_PREFERENCES.enabled), code('true'), text(guide.name)) ];
            if (guide.overridesFile !== null) {
                steps.push(step('librewolf-overrides', code(LIBREWOLF_WEBGPU_OVERRIDE), code(guide.overridesFile)));
            }
            steps.push(createReportPageStep(guide));
            return steps;
        }
        default:
            return [ createSafariFlagStep(context, guide), step('safari-lockdown-mode') ];
    }
}

/** The steps for causes that differ by family only in their report page; Safari has none. */
function withReportPage(guide: BrowserGuide, steps: readonly WebGPUFixStep[]): WebGPUFixStep[] {
    return guide.family === 'safari' ? [ ...steps ] : [ ...steps, createReportPageStep(guide) ];
}

function getSoftwareRendererSteps(context: DiagnosisContext): WebGPUFixStep[] {
    const { guide } = context;
    const browserName = text(guide.name);
    switch (guide.family) {
        case 'chromium':
            return [
                createHardwareAccelerationStep(guide),
                step('use-real-gpu'),
                step('update-gpu-driver'),
                step('reset-flags', code(guide.flagsPage), label('Reset all')),
                step('restart-browser', browserName),
                createReportPageStep(guide)
            ];
        case 'firefox':
            return [ createHardwareAccelerationStep(guide), step('use-real-gpu'), step('update-gpu-driver'), createReportPageStep(guide) ];
        default:
            return [ step('use-real-gpu'), createUpdateStep(context) ];
    }
}

function getHardwareAccelerationSteps(context: DiagnosisContext): WebGPUFixStep[] {
    const { guide } = context;
    switch (guide.family) {
        case 'chromium':
            return [ createHardwareAccelerationStep(guide), step('use-real-gpu'), createReportPageStep(guide) ];
        case 'firefox':
            return [ createHardwareAccelerationStep(guide), step('firefox-troubleshoot-mode', text(guide.name)), createReportPageStep(guide) ];
        default:
            return [ createUpdateStep(context) ];
    }
}

function getBlockedSteps(context: DiagnosisContext): WebGPUFixStep[] {
    const { guide } = context;
    switch (guide.family) {
        case 'chromium':
            return [ step('update-gpu-driver'), step('restart-browser', text(guide.name)), createReportPageStep(guide), createUnsafeFlagStep(guide) ];
        case 'firefox':
            return [
                step('update-gpu-driver'),
                createReportPageStep(guide),
                step('firefox-ignore-blocklist', code(guide.configPage), code(FIREFOX_WEBGPU_PREFERENCES.ignoreBlocklist), code('true'))
            ];
        default:
            return [ createUpdateStep(context) ];
    }
}

function getCauseSteps(cause: WebGPUFailureCause, context: DiagnosisContext): WebGPUFixStep[] {
    const { browserName, guide } = context;
    const restart = step('restart-browser', text(browserName));
    switch (cause) {
        case 'insecure-context':
            return [ step('use-https', text(context.facts.origin)) ];
        case 'webgpu-not-shipped':
            return getNotShippedSteps(context);
        case 'webgpu-missing':
            return getMissingSteps(context);
        case 'hardware-acceleration-off':
            return getHardwareAccelerationSteps(context);
        case 'software-renderer':
            return getSoftwareRendererSteps(context);
        case 'gpu-blocked':
            return getBlockedSteps(context);
        case 'gpu-crashed':
            return withReportPage(guide, [ restart, step('update-gpu-driver') ]);
        case 'device-failed':
            return withReportPage(guide, [ step('update-gpu-driver'), step('update-browser-latest', text(browserName)) ]);
        case 'device-lost':
            return [ step('reload-page'), step('update-gpu-driver'), restart ];
        case 'rendering-failed':
            return [ step('reload-page'), step('update-browser-latest', text(browserName)), step('update-gpu-driver') ];
        default:
            return withReportPage(guide, [ step('reload-page'), restart ]);
    }
}

function getSteps(cause: WebGPUFailureCause, context: DiagnosisContext): WebGPUFixStep[] {
    const steps = getCauseSteps(cause, context);
    if (cause === 'insecure-context') {
        return steps;
    }
    // On iOS and iPadOS the picked browser runs on Safari's engine, which the steps are about
    const picked = context.browserName;
    const leading = context.facts.browser.os === 'ios' && picked !== BROWSER_GUIDES.safari.name ? [ step('ios-uses-webkit', text(picked)) ] : [];
    return [ ...leading, ...steps, step('report-problem') ];
}

function describeProbe(probe: WebGPUAdapterProbe): string {
    switch (probe.result) {
        case 'adapter':
            return 'adapter';
        case 'rejected':
            return `rejected: ${probe.message}`;
        case 'timeout':
            return `timeout after ${ADAPTER_TIMEOUT_MILLISECONDS} ms`;
        default:
            return probe.result;
    }
}

function describeAdapter(adapter: WebGPUAdapterSummary): string {
    const parts = [ adapter.vendor, adapter.architecture, adapter.device, adapter.description ].filter((part: string): boolean => part !== '');
    const named = parts.length > 0 ? parts.join(' / ') : '(no information)';
    return adapter.isFallbackAdapter === null ? named : `${named}; isFallbackAdapter: ${String(adapter.isFallbackAdapter)}`;
}

function describeWebGL(webGL: WebGLRendererProbe): string {
    switch (webGL.result) {
        case 'renderer':
            return webGL.vendor === '' ? webGL.renderer : `${webGL.renderer} (${webGL.vendor})`;
        case 'skipped':
            return 'not checked';
        default:
            return 'unavailable';
    }
}

/** Returns the report's details: the engine's failure as reported, then what the page observed, as technical name and value. */
export function describeWebGPUFailureFacts(facts: WebGPUFailureFacts): WebGPUFailureFactLine[] {
    const { browser, source } = facts;
    const lines: WebGPUFailureFactLine[] = [ { label: 'failure', value: `${source.kind}: ${source.reason}` } ];
    if (source.kind === 'presentation' && source.detail !== '') {
        lines.push({ label: 'detail', value: source.detail });
    }
    if (facts.deviceLost !== null) {
        lines.push({ label: 'device lost', value: `${facts.deviceLost.reason}: ${facts.deviceLost.message}` });
    }
    lines.push(
        { label: 'browser', value: `${browser.browser} ${browser.majorVersion ?? '?'} (${browser.family}, ${browser.os})` },
        { label: 'architecture', value: facts.cpuArchitecture ?? 'unknown' },
        { label: 'isSecureContext', value: String(facts.secureContext) },
        { label: 'origin', value: facts.origin },
        { label: 'navigator.gpu', value: facts.gpuPresent ? 'present' : 'missing' }
    );
    if (facts.adapter.result !== 'skipped') {
        lines.push({ label: 'requestAdapter()', value: describeProbe(facts.adapter) });
    }
    if (facts.adapter.result === 'adapter') {
        lines.push({ label: 'adapter', value: describeAdapter(facts.adapter.adapter) });
    }
    if (facts.fallbackAdapter.result !== 'skipped') {
        lines.push({ label: 'requestAdapter({ forceFallbackAdapter: true })', value: describeProbe(facts.fallbackAdapter) });
    }
    if (facts.fallbackAdapter.result === 'adapter') {
        lines.push({ label: 'fallback adapter', value: describeAdapter(facts.fallbackAdapter.adapter) });
    }
    lines.push({ label: 'WebGL renderer', value: describeWebGL(facts.webGL) }, { label: 'userAgent', value: facts.userAgent });
    return lines;
}

/**
 * Diagnoses a WebGPU failure from its facts: the likely cause, how sure that is, and the fixes to try in order, written for a browser.
 * The browser defaults to the detected one; on iOS and iPadOS the steps are Safari's for every browser.
 */
export function diagnoseWebGPUFailure(facts: WebGPUFailureFacts, browser: GuideBrowserId = getGuideBrowser(facts.browser)): WebGPUFailureDiagnosis {
    const context = createContext(facts, browser);
    const finding = findCause(context);
    return {
        browser,
        cause: finding.cause,
        confidence: finding.confidence,
        explanation: finding.explanation,
        facts: describeWebGPUFailureFacts(facts),
        steps: getSteps(finding.cause, context)
    };
}

/**
 * Translates a key whose {n} placeholders take arguments that are written apart from the text around them.
 * formatText writes each run of translated text, and formatArgument each argument, so HTML can escape the text and mark up the arguments.
 */
export function formatWebGPUFailureText<Argument>(
    key: string,
    args: readonly Argument[],
    formatText: (value: string) => string,
    formatArgument: (argument: Argument) => string
): string {
    const placeholders = args.map((_argument: Argument, index: number): string => `${ARGUMENT_START}${index}${ARGUMENT_END}`);
    // Splitting on a pattern with a group alternates text and the argument indexes
    return globalize.translate(key, ...placeholders)
        .split(ARGUMENT_PATTERN)
        .map((part: string, index: number): string => (index % 2 === 0 ? formatText(part) : formatArgument(args[Number(part)])))
        .join('');
}

function formatPlainArgument(argument: WebGPUFixStepArgument): string {
    return argument.kind === 'label' ? `"${argument.value}"` : argument.value;
}

/** Writes a fix step as plain text, each label the browser shows in quotes. */
export function formatWebGPUFixStepText(fixStep: WebGPUFixStep): string {
    return formatWebGPUFailureText(WEBGPU_FIX_STEP_KEYS[fixStep.code], fixStep.args, (value: string): string => value, formatPlainArgument);
}

/** Translates a diagnosis's explanation. */
export function translateWebGPUFailureExplanation(diagnosis: WebGPUFailureDiagnosis): string {
    return globalize.translate(diagnosis.explanation.key, ...diagnosis.explanation.args);
}

/** Writes a report as plain text for copying: the cause, the fixes for a browser, defaulting to the report's, then the details. */
export function formatWebGPUFailureReport(report: WebGPUFailureReport, browser: GuideBrowserId = report.diagnosis.browser): string {
    const diagnosis = browser === report.diagnosis.browser ? report.diagnosis : diagnoseWebGPUFailure(report.facts, browser);
    return [
        globalize.translate('WebGPUFailureReportTitle'),
        `${globalize.translate(WEBGPU_FAILURE_CAUSE_KEYS[diagnosis.cause])} (${diagnosis.cause}, ${diagnosis.confidence})`,
        translateWebGPUFailureExplanation(diagnosis),
        '',
        globalize.translate('WebGPUFailureFixHeading', BROWSER_GUIDES[browser].name),
        ...diagnosis.steps.map((fixStep: WebGPUFixStep, index: number): string => `${index + 1}. ${formatWebGPUFixStepText(fixStep)}`),
        '',
        globalize.translate('WebGPUFailureDetails'),
        ...diagnosis.facts.map((line: WebGPUFailureFactLine): string => `${line.label}: ${line.value}`)
    ].join('\n');
}

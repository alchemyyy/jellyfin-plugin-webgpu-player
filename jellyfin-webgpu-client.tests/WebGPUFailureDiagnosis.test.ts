import { describe, expect, it, vi } from 'vitest';

vi.mock('lib/globalize', async () => {
    // The factory runs before the module's imports, so it loads the source strings itself
    const globalizeMock = await import('./host/globalizeMock');
    return { default: { translate: globalizeMock.translateSourceString } };
});

import type { BrowserIdentity } from 'addons/webGPUPlayer/BrowserIdentity';
import {
    diagnoseWebGPUFailure,
    formatWebGPUFailureReport,
    formatWebGPUFixStepText,
    type WebGPUAdapterProbe,
    type WebGPUFailureFacts,
    type WebGPUFixStep
} from 'addons/webGPUPlayer/WebGPUFailureDiagnosis';

const CHROME_WINDOWS: BrowserIdentity = { browser: 'chrome', family: 'chromium', majorVersion: 141, os: 'windows' };
const FIREFOX_WINDOWS: BrowserIdentity = { browser: 'firefox', family: 'firefox', majorVersion: 144, os: 'windows' };
const FIREFOX_LINUX: BrowserIdentity = { browser: 'firefox', family: 'firefox', majorVersion: 144, os: 'linux' };
const SAFARI_MACOS: BrowserIdentity = { browser: 'safari', family: 'safari', majorVersion: 26, os: 'macos' };
const HARDWARE_RENDERER = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 (0x00002206) Direct3D11 vs_5_0 ps_5_0, D3D11)';
const SWIFTSHADER_RENDERER = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';
const NULL_ADAPTER: WebGPUAdapterProbe = { result: 'null' };
const HARDWARE_ADAPTER: WebGPUAdapterProbe = {
    adapter: { architecture: 'ampere', description: '', device: '', isFallbackAdapter: false, vendor: 'nvidia' },
    result: 'adapter'
};
const RELEASE_GATE_MESSAGE = 'NotSupportedError: WebGPU is not yet available in Release or late Beta builds.';

function createFacts(overrides: Partial<WebGPUFailureFacts> = {}): WebGPUFailureFacts {
    return {
        adapter: NULL_ADAPTER,
        browser: CHROME_WINDOWS,
        cpuArchitecture: 'x86',
        deviceLost: null,
        fallbackAdapter: { result: 'skipped' },
        gpuPresent: true,
        origin: 'https://jellyfin.example',
        secureContext: true,
        source: { detail: 'requestAdapter: null', kind: 'presentation', reason: 'adapter-unavailable' },
        userAgent: 'Mozilla/5.0 Chrome/141.0.0.0',
        webGL: { renderer: HARDWARE_RENDERER, result: 'renderer', vendor: 'Google Inc. (NVIDIA)' },
        ...overrides
    };
}

function getStepCodes(steps: readonly WebGPUFixStep[]): string[] {
    return steps.map((fixStep: WebGPUFixStep): string => fixStep.code);
}

function getCodeArguments(steps: readonly WebGPUFixStep[]): string[] {
    return steps.flatMap((fixStep: WebGPUFixStep): string[] => fixStep.args
        .filter((argument): boolean => argument.kind === 'code')
        .map((argument): string => argument.value));
}

// eslint-disable-next-line sonarjs/no-clear-text-protocols -- an insecure origin is the case under test
const INSECURE_ORIGIN = 'http://192.168.1.10:8096';

describe('diagnoseWebGPUFailure', () => {
    it('names an insecure page for certain, with HTTPS as the only fix', () => {
        const diagnosis = diagnoseWebGPUFailure(createFacts({
            gpuPresent: false,
            origin: INSECURE_ORIGIN,
            secureContext: false,
            source: { kind: 'runtime', reason: 'insecure-context' }
        }));

        expect(diagnosis).toMatchObject({ cause: 'insecure-context', confidence: 'certain' });
        expect(diagnosis.explanation.args).toEqual([ INSECURE_ORIGIN ]);
        expect(getStepCodes(diagnosis.steps)).toEqual([ 'use-https' ]);
    });

    it('names a Firefox release build\'s refusal on Linux for certain, with Firefox Nightly as the fix', () => {
        const diagnosis = diagnoseWebGPUFailure(createFacts({
            adapter: { message: RELEASE_GATE_MESSAGE, result: 'rejected' },
            browser: FIREFOX_LINUX,
            webGL: { result: 'skipped' }
        }));

        expect(diagnosis).toMatchObject({ cause: 'webgpu-not-shipped', confidence: 'certain' });
        expect(getStepCodes(diagnosis.steps)).toEqual([ 'use-firefox-nightly', 'report-problem' ]);
        expect(diagnosis.steps[0].args.map((argument) => argument.value)).toEqual([ 'Firefox', 'Linux' ]);
    });

    it('names a Firefox without navigator.gpu on Linux as not shipped there', () => {
        const diagnosis = diagnoseWebGPUFailure(createFacts({ adapter: { result: 'skipped' }, browser: FIREFOX_LINUX, gpuPresent: false, webGL: { result: 'skipped' } }));

        expect(diagnosis).toMatchObject({ cause: 'webgpu-not-shipped', confidence: 'certain' });
        expect(diagnosis.explanation).toEqual({ args: [ 'Firefox', 'Linux' ], key: 'WebGPUFailureCauseNotOnPlatformHelp' });
    });

    it('names Firefox on Android as not shipped, with the Beta and Nightly preference', () => {
        const diagnosis = diagnoseWebGPUFailure(createFacts({
            adapter: { result: 'skipped' },
            browser: { ...FIREFOX_LINUX, os: 'android' },
            gpuPresent: false,
            webGL: { result: 'skipped' }
        }));

        expect(getStepCodes(diagnosis.steps)).toEqual([ 'firefox-android', 'report-problem' ]);
        expect(getCodeArguments(diagnosis.steps)).toContain('gfx.webgpu.ignore-blocklist');
    });

    it('names a Firefox without navigator.gpu on Windows as turned off, with dom.webgpu.enabled, and for LibreWolf its overrides file too', () => {
        const facts = createFacts({ adapter: { result: 'skipped' }, browser: FIREFOX_WINDOWS, gpuPresent: false, webGL: { result: 'skipped' } });

        const firefox = diagnoseWebGPUFailure(facts);
        expect(firefox).toMatchObject({ browser: 'firefox', cause: 'webgpu-missing', confidence: 'likely' });
        expect(getStepCodes(firefox.steps)).toEqual([ 'firefox-enable-preference', 'check-firefox-support', 'report-problem' ]);
        expect(getCodeArguments(firefox.steps)).toEqual([ 'about:config', 'dom.webgpu.enabled', 'true', 'about:support' ]);

        const libreWolf = diagnoseWebGPUFailure(facts, 'librewolf');
        expect(getStepCodes(libreWolf.steps)).toEqual([ 'firefox-enable-preference', 'librewolf-overrides', 'check-firefox-support', 'report-problem' ]);
        expect(getCodeArguments(libreWolf.steps)).toContain('librewolf.overrides.cfg');
        expect(getCodeArguments(libreWolf.steps)).toContain('defaultPref("dom.webgpu.enabled", true);');
    });

    it('names an old Firefox on Windows as too old, with an update', () => {
        const diagnosis = diagnoseWebGPUFailure(createFacts({
            adapter: { result: 'skipped' },
            browser: { ...FIREFOX_WINDOWS, majorVersion: 128 },
            gpuPresent: false,
            webGL: { result: 'skipped' }
        }));

        expect(diagnosis).toMatchObject({ cause: 'webgpu-not-shipped', confidence: 'certain' });
        expect(diagnosis.steps[0]).toEqual({ args: [ { kind: 'text', value: 'Firefox' }, { kind: 'text', value: '141' } ], code: 'update-browser' });
    });

    it('names Safari before 26 as not shipped, with the system update and the feature flag of macOS or iOS', () => {
        const macOS = diagnoseWebGPUFailure(createFacts({
            adapter: { result: 'skipped' },
            browser: { ...SAFARI_MACOS, majorVersion: 18 },
            gpuPresent: false,
            webGL: { renderer: 'Apple GPU', result: 'renderer', vendor: 'Apple Inc.' }
        }));
        expect(macOS).toMatchObject({ cause: 'webgpu-not-shipped', confidence: 'certain' });
        expect(macOS.explanation).toEqual({ args: [ '18', '26', 'macOS' ], key: 'WebGPUFailureCauseSafariTooOldHelp' });
        expect(getStepCodes(macOS.steps)).toEqual([ 'update-system', 'safari-feature-flag-macos', 'report-problem' ]);

        const iOS = diagnoseWebGPUFailure(createFacts({
            adapter: { result: 'skipped' },
            browser: { browser: 'safari', family: 'safari', majorVersion: 18, os: 'ios' },
            gpuPresent: false
        }));
        expect(getStepCodes(iOS.steps)).toEqual([ 'update-system', 'safari-feature-flag-ios', 'report-problem' ]);
    });

    it('writes Safari\'s steps for every browser on iOS, after a note that it runs on Safari\'s engine', () => {
        const diagnosis = diagnoseWebGPUFailure(createFacts({
            adapter: { result: 'skipped' },
            browser: { browser: 'chrome', family: 'safari', majorVersion: null, os: 'ios' },
            gpuPresent: false
        }));

        expect(diagnosis.browser).toBe('chrome');
        expect(diagnosis.cause).toBe('webgpu-missing');
        expect(getStepCodes(diagnosis.steps)).toEqual([ 'ios-uses-webkit', 'safari-feature-flag-ios', 'safari-lockdown-mode', 'report-problem' ]);
        expect(diagnosis.steps[0].args).toEqual([ { kind: 'text', value: 'Chrome' } ]);
    });

    it('names a Safari 26 without navigator.gpu as turned off, with the feature flag and Lockdown Mode', () => {
        const diagnosis = diagnoseWebGPUFailure(createFacts({ adapter: { result: 'skipped' }, browser: SAFARI_MACOS, gpuPresent: false }));

        expect(diagnosis).toMatchObject({ cause: 'webgpu-missing', confidence: 'likely' });
        expect(getStepCodes(diagnosis.steps)).toEqual([ 'safari-feature-flag-macos', 'safari-lockdown-mode', 'report-problem' ]);
    });

    it('names Chromium on Windows on ARM as flag only, with the unsafe WebGPU flag of the picked browser', () => {
        const facts = createFacts({ cpuArchitecture: 'arm' });

        const chrome = diagnoseWebGPUFailure(facts);
        expect(chrome).toMatchObject({ cause: 'webgpu-not-shipped', confidence: 'likely' });
        expect(getStepCodes(chrome.steps)).toEqual([ 'enable-unsafe-webgpu-flag', 'report-problem' ]);
        expect(getCodeArguments(chrome.steps)).toEqual([ 'chrome://flags/#enable-unsafe-webgpu' ]);
        expect(getCodeArguments(diagnoseWebGPUFailure(facts, 'edge').steps)).toEqual([ 'edge://flags/#enable-unsafe-webgpu' ]);
    });

    it('names Chromium on Linux without an adapter as not shipped for this GPU, with the flags and the command line', () => {
        const diagnosis = diagnoseWebGPUFailure(createFacts({
            browser: { ...CHROME_WINDOWS, majorVersion: 146, os: 'linux' },
            webGL: { renderer: 'ANGLE (AMD, AMD Radeon RX 6800 (radeonsi navi21 LLVM 19.1.1), OpenGL 4.6)', result: 'renderer', vendor: 'AMD' }
        }));

        expect(diagnosis).toMatchObject({ cause: 'webgpu-not-shipped', confidence: 'likely' });
        expect(getStepCodes(diagnosis.steps)).toEqual([
            'update-browser-latest',
            'enable-unsafe-webgpu-flag',
            'enable-vulkan-flag',
            'linux-command-line',
            'check-gpu-report',
            'report-problem'
        ]);
        expect(getCodeArguments(diagnosis.steps)).toContain('--enable-unsafe-webgpu --ozone-platform=x11 --use-angle=vulkan --enable-features=Vulkan,VulkanFromANGLE');
    });

    it('names an old Chromium on Linux as too old', () => {
        const diagnosis = diagnoseWebGPUFailure(createFacts({ browser: { ...CHROME_WINDOWS, majorVersion: 130, os: 'linux' } }));

        expect(diagnosis.cause).toBe('webgpu-not-shipped');
        expect(diagnosis.explanation).toEqual({ args: [ 'Chrome', '130', '144' ], key: 'WebGPUFailureCauseTooOldHelp' });
        expect(diagnosis.steps[0].code).toBe('update-browser');
    });

    it('names a software WebGL renderer as software rendering, with hardware acceleration first', () => {
        const diagnosis = diagnoseWebGPUFailure(createFacts({
            fallbackAdapter: HARDWARE_ADAPTER,
            webGL: { renderer: SWIFTSHADER_RENDERER, result: 'renderer', vendor: 'Google Inc. (Google)' }
        }));

        expect(diagnosis).toMatchObject({ cause: 'software-renderer', confidence: 'likely' });
        expect(diagnosis.explanation.args).toEqual([ 'Chrome', SWIFTSHADER_RENDERER ]);
        expect(getStepCodes(diagnosis.steps)).toEqual([
            'enable-hardware-acceleration',
            'use-real-gpu',
            'update-gpu-driver',
            'reset-flags',
            'restart-browser',
            'check-gpu-report',
            'report-problem'
        ]);
        expect(getCodeArguments(diagnosis.steps)).toEqual([ 'chrome://settings/system', 'chrome://flags', 'chrome://gpu' ]);
    });

    it('names Microsoft\'s software renderer of Remote Desktop as software rendering', () => {
        const diagnosis = diagnoseWebGPUFailure(createFacts({
            webGL: { renderer: 'ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)', result: 'renderer', vendor: 'Microsoft' }
        }));

        expect(diagnosis.cause).toBe('software-renderer');
    });

    it('names a software adapter that is the only one as software rendering', () => {
        const diagnosis = diagnoseWebGPUFailure(createFacts({
            adapter: { adapter: { architecture: 'swiftshader', description: '', device: '', isFallbackAdapter: true, vendor: 'google' }, result: 'adapter' }
        }));

        expect(diagnosis).toMatchObject({ cause: 'software-renderer', confidence: 'likely' });
        expect(diagnosis.explanation.key).toBe('WebGPUFailureCauseFallbackAdapterHelp');
    });

    it('names Chromium without WebGL or an adapter as hardware acceleration off, at the picked browser\'s setting', () => {
        const facts = createFacts({ webGL: { result: 'unavailable' } });

        const chrome = diagnoseWebGPUFailure(facts);
        expect(chrome).toMatchObject({ cause: 'hardware-acceleration-off', confidence: 'likely' });
        expect(chrome.steps[0]).toEqual({
            args: [
                { kind: 'code', value: 'chrome://settings/system' },
                { kind: 'label', value: 'Use graphics acceleration when available' },
                { kind: 'text', value: 'Chrome' }
            ],
            code: 'enable-hardware-acceleration'
        });

        const vivaldi = diagnoseWebGPUFailure(facts, 'vivaldi');
        expect(vivaldi.steps[0]).toEqual({
            args: [
                { kind: 'label', value: 'Settings > Performance' },
                { kind: 'label', value: 'Use Hardware Acceleration When Available' },
                { kind: 'text', value: 'Vivaldi' }
            ],
            code: 'enable-hardware-acceleration-menu'
        });
        expect(getCodeArguments(diagnoseWebGPUFailure(facts, 'brave').steps)).toEqual([ 'brave://settings/system', 'brave://gpu' ]);
        expect(getCodeArguments(diagnoseWebGPUFailure(facts, 'opera').steps)).toEqual([ 'opera://settings/system', 'opera://gpu' ]);
    });

    it('names a hardware WebGL renderer without an adapter as a blocked GPU, with the driver first', () => {
        const diagnosis = diagnoseWebGPUFailure(createFacts());

        expect(diagnosis).toMatchObject({ cause: 'gpu-blocked', confidence: 'likely' });
        expect(diagnosis.explanation.args).toEqual([ 'Chrome', HARDWARE_RENDERER ]);
        expect(getStepCodes(diagnosis.steps)).toEqual([ 'update-gpu-driver', 'restart-browser', 'check-gpu-report', 'enable-unsafe-webgpu-flag', 'report-problem' ]);
    });

    it('names a Firefox without an adapter on Windows as a possibly blocked GPU, with the blocklist preference last', () => {
        const diagnosis = diagnoseWebGPUFailure(createFacts({ browser: FIREFOX_WINDOWS, webGL: { result: 'skipped' } }));

        expect(diagnosis).toMatchObject({ cause: 'gpu-blocked', confidence: 'possible' });
        expect(getStepCodes(diagnosis.steps)).toEqual([ 'update-gpu-driver', 'check-firefox-support', 'firefox-ignore-blocklist', 'report-problem' ]);
    });

    it('names a lost device followed by no adapter as a crashed graphics process, with a restart first', () => {
        const diagnosis = diagnoseWebGPUFailure(createFacts({
            deviceLost: { message: 'GPU process crashed', reason: 'unknown' },
            source: { detail: 'recovery attempts exhausted', kind: 'presentation', reason: 'device-recovery-failed' }
        }));

        expect(diagnosis).toMatchObject({ cause: 'gpu-crashed', confidence: 'likely' });
        expect(getStepCodes(diagnosis.steps)).toEqual([ 'restart-browser', 'update-gpu-driver', 'check-gpu-report', 'report-problem' ]);
    });

    it('names an adapter request that never answers as a possible crash', () => {
        expect(diagnoseWebGPUFailure(createFacts({ adapter: { result: 'timeout' } }))).toMatchObject({ cause: 'gpu-crashed', confidence: 'possible' });
    });

    it('names a lost device with the adapter back as a device loss, with a reload first', () => {
        const diagnosis = diagnoseWebGPUFailure(createFacts({
            adapter: HARDWARE_ADAPTER,
            deviceLost: { message: 'D3D12 device removed', reason: 'unknown' },
            source: { detail: 'recovery attempts exhausted', kind: 'presentation', reason: 'device-recovery-failed' }
        }));

        expect(diagnosis).toMatchObject({ cause: 'device-lost', confidence: 'likely' });
        expect(getStepCodes(diagnosis.steps)).toEqual([ 'reload-page', 'update-gpu-driver', 'restart-browser', 'report-problem' ]);
    });

    it('names a refused device as a device failure, with the engine\'s detail', () => {
        const diagnosis = diagnoseWebGPUFailure(createFacts({
            adapter: HARDWARE_ADAPTER,
            source: { detail: 'requestDevice: OperationError: limit exceeded', kind: 'presentation', reason: 'device-request-failed' }
        }));

        expect(diagnosis).toMatchObject({ cause: 'device-failed', confidence: 'likely' });
        expect(diagnosis.explanation.args).toEqual([ 'requestDevice: OperationError: limit exceeded' ]);
    });

    it('names a drawing failure on a working adapter as a rendering failure', () => {
        const diagnosis = diagnoseWebGPUFailure(createFacts({
            adapter: HARDWARE_ADAPTER,
            source: { detail: 'executor: shader compilation failed', kind: 'presentation', reason: 'pipeline-creation-failed' }
        }));

        expect(diagnosis).toMatchObject({ cause: 'rendering-failed', confidence: 'possible' });
        expect(getStepCodes(diagnosis.steps)).toEqual([ 'reload-page', 'update-browser-latest', 'update-gpu-driver', 'report-problem' ]);
    });

    it('names an adapter failure whose adapter is back as unknown', () => {
        const diagnosis = diagnoseWebGPUFailure(createFacts({ adapter: HARDWARE_ADAPTER }));

        expect(diagnosis).toMatchObject({ cause: 'unknown', confidence: 'possible' });
        expect(getStepCodes(diagnosis.steps)).toEqual([ 'reload-page', 'restart-browser', 'check-gpu-report', 'report-problem' ]);
    });

    it('lists the engine\'s reason and detail and what the page observed in the details', () => {
        const diagnosis = diagnoseWebGPUFailure(createFacts({ fallbackAdapter: HARDWARE_ADAPTER }));

        expect(diagnosis.facts).toEqual([
            { label: 'failure', value: 'presentation: adapter-unavailable' },
            { label: 'detail', value: 'requestAdapter: null' },
            { label: 'browser', value: 'chrome 141 (chromium, windows)' },
            { label: 'architecture', value: 'x86' },
            { label: 'isSecureContext', value: 'true' },
            { label: 'origin', value: 'https://jellyfin.example' },
            { label: 'navigator.gpu', value: 'present' },
            { label: 'requestAdapter()', value: 'null' },
            { label: 'requestAdapter({ forceFallbackAdapter: true })', value: 'adapter' },
            { label: 'fallback adapter', value: 'nvidia / ampere; isFallbackAdapter: false' },
            { label: 'WebGL renderer', value: `${HARDWARE_RENDERER} (Google Inc. (NVIDIA))` },
            { label: 'userAgent', value: 'Mozilla/5.0 Chrome/141.0.0.0' }
        ]);
    });
});

describe('formatWebGPUFailureReport', () => {
    it('writes the cause, the numbered steps for the picked browser and the details as plain text', () => {
        const facts = createFacts({ webGL: { result: 'unavailable' } });
        const report = { diagnosis: diagnoseWebGPUFailure(facts), facts };

        const text = formatWebGPUFailureReport(report, 'edge');

        expect(text).toContain('(hardware-acceleration-off, likely)');
        expect(text).toContain('\n1. ');
        expect(text).toContain('edge://settings/system');
        expect(text).toContain('"Use graphics acceleration when available"');
        expect(text).not.toContain('chrome://');
        expect(text).toContain('failure: presentation: adapter-unavailable');
        expect(formatWebGPUFailureReport(report)).toContain('chrome://settings/system');
    });

    it('writes a step\'s labels in quotes and its codes as they are', () => {
        const fixStep: WebGPUFixStep = {
            args: [ { kind: 'code', value: 'about:config' }, { kind: 'code', value: 'dom.webgpu.enabled' }, { kind: 'code', value: 'true' }, { kind: 'text', value: 'Zen' } ],
            code: 'firefox-enable-preference'
        };

        const text = formatWebGPUFixStepText(fixStep);

        expect(text).toContain('about:config');
        expect(text).toContain('dom.webgpu.enabled');
        expect(text).toContain('Zen');
        expect(text).not.toContain('\uE000');
    });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as FailureDiagnosis from 'addons/webGPUPlayer/WebGPUFailureDiagnosis';
import type { WebGPUDeviceLostFacts, WebGPUFailureFacts } from 'addons/webGPUPlayer/WebGPUFailureDiagnosis';
import type * as FailureWarning from 'addons/webGPUPlayer/WebGPUFailureWarning';
import type { WebGPUFailureSource } from 'addons/webGPUPlayer/WebGPUFailureWarning';

const mocks = vi.hoisted(() => ({
    collectFacts: vi.fn(),
    loadAddonStrings: vi.fn((): Promise<void> => Promise.resolve()),
    showDialog: vi.fn((): Promise<void> => Promise.resolve()),
    storedSettings: null as string | null
}));

vi.mock('lib/globalize', async () => {
    // The factory runs before the module's imports, so it loads the source strings itself
    const globalizeMock = await import('./host/globalizeMock');
    return { default: { translate: globalizeMock.translateSourceString } };
});

vi.mock('scripts/settings/userSettings', () => ({
    currentSettings: {
        get: vi.fn((): string | null => mocks.storedSettings),
        set: vi.fn()
    }
}));

vi.mock('addons/webGPUPlayer/host/globalize', () => ({
    loadAddonStrings: mocks.loadAddonStrings
}));

vi.mock('addons/webGPUPlayer/ui/WebGPUFailureDialog', () => ({
    showWebGPUFailureDialog: mocks.showDialog
}));

// The facts come from the browser; the diagnosis of them is the real one
vi.mock('addons/webGPUPlayer/WebGPUFailureDiagnosis', async importOriginal => ({
    ...await importOriginal<typeof FailureDiagnosis>(),
    collectWebGPUFailureFacts: mocks.collectFacts
}));

const ADAPTER_FAILURE: WebGPUFailureSource = { detail: 'requestAdapter: null', kind: 'presentation', reason: 'adapter-unavailable' };
const DEVICE_LOST: WebGPUFailureSource = { kind: 'device-lost', message: 'GPU process crashed', reason: 'unknown' };

function createFacts(source: WebGPUFailureSource, deviceLost: WebGPUDeviceLostFacts | null): WebGPUFailureFacts {
    return {
        adapter: { result: 'null' },
        browser: { browser: 'chrome', family: 'chromium', majorVersion: 141, os: 'windows' },
        cpuArchitecture: null,
        deviceLost,
        fallbackAdapter: { result: 'null' },
        gpuPresent: true,
        origin: 'https://jellyfin.example',
        secureContext: true,
        source,
        userAgent: 'Mozilla/5.0 Chrome/141.0.0.0',
        webGL: { renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', result: 'renderer', vendor: 'Google Inc. (Intel)' }
    };
}

// Each test loads the module anew, since it shows the warning once per page load
async function loadWarning(): Promise<typeof FailureWarning> {
    vi.resetModules();
    return import('addons/webGPUPlayer/WebGPUFailureWarning');
}

describe('WebGPU failure warning', () => {
    beforeEach(() => {
        mocks.storedSettings = null;
        mocks.collectFacts.mockImplementation((source: WebGPUFailureSource, deviceLost: WebGPUDeviceLostFacts | null): Promise<WebGPUFailureFacts> => (
            Promise.resolve(createFacts(source, deviceLost))
        ));
        vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
    });

    it('ignores failures that are not WebGPU\'s own', async () => {
        const warning = await loadWarning();

        warning.noteWebGPUFailure({ detail: 'frame import', kind: 'presentation', reason: 'frame-render-failed' });
        warning.noteWebGPUFailure({ detail: 'no metadata', kind: 'presentation', reason: 'hdr-tone-mapping-disabled' });
        warning.noteWebGPUFailure({ kind: 'runtime', reason: 'video-decoder-unavailable' });
        expect(warning.getLastWebGPUFailureReport()).toBeNull();
        warning.noteWebGPUFailure({ kind: 'runtime', reason: 'webgpu-unavailable' });

        // Only WebGPU's own failure was diagnosed, and the page's one warning went to it
        await vi.waitFor(() => expect(mocks.showDialog).toHaveBeenCalledTimes(1));
        expect(mocks.collectFacts).toHaveBeenCalledTimes(1);
        expect(mocks.collectFacts).toHaveBeenCalledWith({ kind: 'runtime', reason: 'webgpu-unavailable' }, null);
    });

    it('shows nothing for a lost device alone, and names it in the next failure\'s diagnosis', async () => {
        const warning = await loadWarning();

        warning.noteWebGPUFailure(DEVICE_LOST);
        expect(warning.getLastWebGPUFailureReport()).toBeNull();

        warning.noteWebGPUFailure({ detail: 'recovery attempts exhausted', kind: 'presentation', reason: 'device-recovery-failed' });

        await vi.waitFor(() => expect(mocks.showDialog).toHaveBeenCalledTimes(1));
        // The lost device was only a fact for the failure after it
        expect(mocks.collectFacts).toHaveBeenCalledTimes(1);
        expect(mocks.collectFacts).toHaveBeenCalledWith(
            { detail: 'recovery attempts exhausted', kind: 'presentation', reason: 'device-recovery-failed' },
            { message: 'GPU process crashed', reason: 'unknown' }
        );
        expect(warning.getLastWebGPUFailureReport()?.diagnosis.cause).toBe('gpu-crashed');
    });

    it('diagnoses each failure, shows the warning once per page load, and logs the diagnosis', async () => {
        const warning = await loadWarning();

        warning.noteWebGPUFailure(ADAPTER_FAILURE);
        // The player meets the same failure on every playback
        warning.noteWebGPUFailure(ADAPTER_FAILURE);

        await vi.waitFor(() => expect(mocks.showDialog).toHaveBeenCalledTimes(1));
        const report = warning.getLastWebGPUFailureReport();
        expect(report?.diagnosis.cause).toBe('gpu-blocked');
        expect(mocks.showDialog).toHaveBeenCalledWith(report);
        expect(mocks.loadAddonStrings).toHaveBeenCalled();
        expect(mocks.collectFacts).toHaveBeenCalledTimes(1);
        expect(vi.mocked(console.warn)).toHaveBeenCalledWith('WebGPU failed (presentation: adapter-unavailable); diagnosis: gpu-blocked (likely)');

        warning.noteWebGPUFailure({ kind: 'runtime', reason: 'webgpu-unavailable' });

        await vi.waitFor(() => expect(warning.getLastWebGPUFailureReport()?.facts.source).toEqual({ kind: 'runtime', reason: 'webgpu-unavailable' }));
        expect(mocks.showDialog).toHaveBeenCalledTimes(1);
    });

    it('still diagnoses with the warning off, keeping the report for the settings, which can show it', async () => {
        mocks.storedSettings = JSON.stringify({ osd: { webGPUFailureWarning: false }, version: 5 });
        const warning = await loadWarning();

        warning.noteWebGPUFailure(ADAPTER_FAILURE);

        await vi.waitFor(() => expect(warning.getLastWebGPUFailureReport()).not.toBeNull());
        expect(mocks.showDialog).not.toHaveBeenCalled();

        const report = warning.getLastWebGPUFailureReport();
        if (!report) {
            throw new Error('No report');
        }
        await warning.showWebGPUFailureReport(report);
        expect(mocks.showDialog).toHaveBeenCalledWith(report);
        expect(mocks.loadAddonStrings).toHaveBeenCalled();
    });

    it('shows the warning at a later failure once the user turned it on', async () => {
        mocks.storedSettings = JSON.stringify({ osd: { webGPUFailureWarning: false }, version: 5 });
        const warning = await loadWarning();
        warning.noteWebGPUFailure(ADAPTER_FAILURE);
        await vi.waitFor(() => expect(warning.getLastWebGPUFailureReport()).not.toBeNull());

        mocks.storedSettings = null;
        warning.noteWebGPUFailure(ADAPTER_FAILURE);

        await vi.waitFor(() => expect(mocks.showDialog).toHaveBeenCalledTimes(1));
        // The same failure keeps its diagnosis
        expect(mocks.collectFacts).toHaveBeenCalledTimes(1);
    });

    it('neither throws nor shows anything when the diagnosis fails, and diagnoses the next failure again', async () => {
        mocks.collectFacts.mockRejectedValueOnce(new Error('probe failed'));
        const warning = await loadWarning();

        expect(() => warning.noteWebGPUFailure(ADAPTER_FAILURE)).not.toThrow();

        await vi.waitFor(() => expect(vi.mocked(console.warn)).toHaveBeenCalledWith('Unable to diagnose the WebGPU failure', expect.any(Error)));
        expect(warning.getLastWebGPUFailureReport()).toBeNull();

        warning.noteWebGPUFailure(ADAPTER_FAILURE);
        await vi.waitFor(() => expect(warning.getLastWebGPUFailureReport()).not.toBeNull());
        expect(mocks.collectFacts).toHaveBeenCalledTimes(2);
        // The page's one warning went to the failure whose diagnosis failed
        expect(mocks.showDialog).not.toHaveBeenCalled();
    });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearTimingTrace, recordTimingEvent } from 'webgpu-player/TimingTrace';

import {
    installTimingTraceControl,
    setTimingTraceMetadataProvider,
    TIMING_TRACE_STORAGE_KEY
} from 'addons/webGPUPlayer/TimingTraceControl';

const ENGINE_ASSET_KEY = 'asset-key';
const BUILD_METADATA = Object.freeze({ engineAssetKey: ENGINE_ASSET_KEY });
const PLAYBACK_METADATA = Object.freeze({ playbackSource: { itemId: 'item-1' } });
const TRACE_OBJECT_URL = 'blob:trace';
const TRACE_FILE_NAME_PATTERN = /^webgpu-player-timing-[\dT-]+Z\.json$/;

function requireInstalledControl(): NonNullable<Window['WebGPUPlayerTimingTrace']> {
    const control = window.WebGPUPlayerTimingTrace;
    if (!control) {
        throw new Error('The timing trace control was not installed');
    }
    return control;
}

describe('TimingTraceControl', () => {
    beforeEach(() => {
        window.localStorage.clear();
    });

    afterEach(() => {
        delete window.WebGPUPlayerTimingTrace;
        setTimingTraceMetadataProvider(null);
        clearTimingTrace();
        window.localStorage.clear();
        vi.restoreAllMocks();
    });

    it('installs an idle control once and starts a trace only on request', async () => {
        installTimingTraceControl(BUILD_METADATA);
        const control = requireInstalledControl();
        installTimingTraceControl({ engineAssetKey: 'another-key' });

        expect(window.WebGPUPlayerTimingTrace).toBe(control);
        expect(control.isRecording()).toBe(false);
        await expect(control.export()).resolves.toBeNull();

        control.start();
        expect(control.isRecording()).toBe(true);
        control.stop();
        expect(control.isRecording()).toBe(false);
        control.clear();
        await expect(control.export()).resolves.toBeNull();
    });

    it('starts recording at install when the storage key asks for a trace', () => {
        window.localStorage.setItem(TIMING_TRACE_STORAGE_KEY, '1');

        installTimingTraceControl(BUILD_METADATA);

        expect(requireInstalledControl().isRecording()).toBe(true);
    });

    it('exports the events with the build, environment, and playback metadata', async () => {
        installTimingTraceControl(BUILD_METADATA);
        setTimingTraceMetadataProvider(() => PLAYBACK_METADATA);
        const control = requireInstalledControl();
        control.start();
        recordTimingEvent('render-tick', { state: 'playing' });

        const trace = await control.export();

        expect(trace?.events.map(event => event.kind)).toEqual([ 'render-tick' ]);
        expect(trace?.metadata).toMatchObject({
            ...BUILD_METADATA,
            ...PLAYBACK_METADATA,
            // jsdom has no WebGPU
            gpuAdapter: null,
            userAgent: navigator.userAgent
        });
    });

    it('exports without playback metadata when the provider fails', async () => {
        installTimingTraceControl(BUILD_METADATA);
        setTimingTraceMetadataProvider(() => {
            throw new Error('The player cannot describe itself');
        });
        const control = requireInstalledControl();
        control.start();

        await expect(control.export()).resolves.toMatchObject({ metadata: BUILD_METADATA });
    });

    it('downloads the trace as a timestamped JSON file', async () => {
        installTimingTraceControl(BUILD_METADATA);
        const control = requireInstalledControl();
        const createObjectURL = vi.fn((): string => TRACE_OBJECT_URL);
        vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
        const clickedLinks: HTMLAnchorElement[] = [];
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement): void {
            clickedLinks.push(this);
        });

        await expect(control.download()).resolves.toBe(false);
        control.start();
        await expect(control.download()).resolves.toBe(true);

        expect(createObjectURL).toHaveBeenCalledOnce();
        expect(clickedLinks).toHaveLength(1);
        expect(clickedLinks[0].href).toBe(TRACE_OBJECT_URL);
        expect(clickedLinks[0].download).toMatch(TRACE_FILE_NAME_PATTERN);
        vi.unstubAllGlobals();
    });
});

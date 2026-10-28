import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM } from 'webgpu-player/audio/processing/CustomAudioDownmixAlgorithm';
import { createHDRToSDRRenderSettings, HDR_RENDER_SETTING_RANGES } from 'webgpu-player/presentation/RenderSettings';
import { CLIENT_DEFAULT_KEYS, getClientDefaults, setClientDefaults } from 'addons/webGPUPlayer/ClientDefaults';
import { saveServerClientDefaults } from 'addons/webGPUPlayer/ServerClientDefaults';
import { renderClientDefaultsEditor } from 'addons/webGPUPlayer/ui/ClientDefaultsEditor';
import { translateSourceString } from '../host/globalizeMock';
import {
    INVERT_PASS_SOURCE,
    SATURATION_PARAMETER_DEFAULT,
    SATURATION_PARAMETER_MAXIMUM,
    SATURATION_PARAMETER_NAME,
    SATURATION_PASS_SOURCE,
    STORED_SATURATION
} from '../presentationPassSources';

const SATURATION_FILE = 'saturation.wgpup';
const INVERT_FILE = 'invert.wgpup';
const WITHDRAWN_FILE = 'withdrawn.wgpup';

// The server's defaults and pass files the editor reads, and what its save answers
const serverMockState = vi.hoisted(() => ({
    catalogFailure: null as string | null,
    defaults: {} as Record<string, unknown>,
    defaultsFailure: null as string | null,
    passes: [] as Array<{ byteLength: number, contentHash: string, fileName: string, passNames: string[] }>,
    passSources: new Map<string, string>(),
    saveFailure: null as string | null
}));

vi.mock('addons/webGPUPlayer/ServerClientDefaults', () => ({
    fetchServerClientDefaults: vi.fn(() => (serverMockState.defaultsFailure === null ?
        Promise.resolve(serverMockState.defaults) :
        Promise.reject(new Error(serverMockState.defaultsFailure)))),
    saveServerClientDefaults: vi.fn((defaults: Record<string, unknown>) => {
        if (serverMockState.saveFailure !== null) {
            return Promise.reject(new Error(serverMockState.saveFailure));
        }
        serverMockState.defaults = defaults;
        return Promise.resolve(defaults);
    })
}));

vi.mock('addons/webGPUPlayer/ServerModules', () => ({
    fetchServerPassSource: vi.fn((fileName: string): Promise<string> => {
        const source = serverMockState.passSources.get(fileName);
        return source === undefined ?
            Promise.reject(new Error(`server-request-failed: WebGPUPlayer/Passes/${fileName} HTTP 404`)) :
            Promise.resolve(source);
    }),
    loadServerModuleCatalog: vi.fn(() => (serverMockState.catalogFailure === null ?
        Promise.resolve({ decoderPackages: [], passes: serverMockState.passes }) :
        Promise.reject(new Error(serverMockState.catalogFailure))))
}));

vi.mock('lib/globalize', async () => {
    const globalizeMock = await import('../host/globalizeMock');
    return { default: { translate: globalizeMock.translateSourceString } };
});

// WebGPUUserSettings reads the host user settings, which the editor never stores into
vi.mock('scripts/settings/userSettings', () => ({
    currentSettings: { get: vi.fn((): null => null), set: vi.fn() }
}));

function createPassEntry(fileName: string, passName: string): { byteLength: number, contentHash: string, fileName: string, passNames: string[] } {
    return { byteLength: 1, contentHash: 'a'.repeat(64), fileName, passNames: [ passName ] };
}

function getValueControl(container: HTMLElement, key: string): HTMLInputElement & HTMLSelectElement {
    const control = container.querySelector<HTMLInputElement & HTMLSelectElement>(`[data-client-default-value="${key}"]`);
    if (!control) {
        throw new Error(`no control for ${key}`);
    }
    return control;
}

function getSetCheckbox(container: HTMLElement, key: string): HTMLInputElement {
    const checkbox = container.querySelector<HTMLInputElement>(`[data-client-default-set="${key}"]`);
    if (!checkbox) {
        throw new Error(`no set checkbox for ${key}`);
    }
    return checkbox;
}

/** Returns the saturation pass file's parameter input, which each change of the list renders anew. */
function getParameterInput(container: HTMLElement): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>(`[data-client-defaults-parameter="${SATURATION_PARAMETER_NAME}"]`);
    if (!input) {
        throw new Error('no saturation parameter input');
    }
    return input;
}

function getStatus(container: HTMLElement): string {
    return container.querySelector('[role="status"]')?.textContent ?? '';
}

function changeValue(control: HTMLInputElement | HTMLSelectElement, value: string): void {
    control.value = value;
    control.dispatchEvent(new Event('change', { bubbles: true }));
}

function setRow(container: HTMLElement, key: string, isSet: boolean): void {
    const checkbox = getSetCheckbox(container, key);
    checkbox.checked = isSet;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
}

function click(container: HTMLElement, selector: string): void {
    const element = container.querySelector<HTMLElement>(selector);
    if (!element) {
        throw new Error(`no element ${selector}`);
    }
    element.click();
}

function getPresetFileTexts(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll('[data-client-defaults-preset-file]'))
        .map((entry: Element): string => entry.textContent?.replace(/\s+/g, ' ').trim() ?? '');
}

async function renderEditor(): Promise<HTMLElement> {
    const container = document.createElement('div');
    document.body.append(container);
    await renderClientDefaultsEditor(container);
    return container;
}

describe('client defaults editor', () => {
    beforeEach(() => {
        serverMockState.catalogFailure = null;
        serverMockState.defaults = {};
        serverMockState.defaultsFailure = null;
        serverMockState.passes = [ createPassEntry(SATURATION_FILE, 'Saturation'), createPassEntry(INVERT_FILE, 'Invert') ];
        serverMockState.passSources = new Map([ [ SATURATION_FILE, SATURATION_PASS_SOURCE ], [ INVERT_FILE, INVERT_PASS_SOURCE ] ]);
        serverMockState.saveFailure = null;
        vi.mocked(saveServerClientDefaults).mockClear();
    });

    afterEach(() => {
        document.body.innerHTML = '';
        setClientDefaults({});
    });

    it('shows each setting the server does not set disabled, with its built-in value', async () => {
        const container = await renderEditor();
        const builtInRender = createHDRToSDRRenderSettings();

        for (const key of CLIENT_DEFAULT_KEYS.filter((defaultKey: string): boolean => defaultKey !== 'presentationFiles')) {
            expect(getSetCheckbox(container, key).checked, key).toBe(false);
            expect(getValueControl(container, key).disabled, key).toBe(true);
        }
        expect(getValueControl(container, 'preferredVideoPlayer').value).toBe('auto');
        expect(getValueControl(container, 'settingsButtonPlacement').value).toBe('before-settings');
        expect(getValueControl(container, 'enableCustomDecode').checked).toBe(true);
        expect(getValueControl(container, 'enableGPUDecodeSlicing').checked).toBe(false);
        expect(getValueControl(container, 'toneMapOperator').value).toBe(builtInRender.toneMapping.operator);
        expect(Number(getValueControl(container, 'brightness').value)).toBe(builtInRender.display.brightness);
        expect(getValueControl(container, 'audioDownmixAlgorithm').value).toBe(DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM);
        expect(getPresetFileTexts(container)).toEqual([]);
        expect(getStatus(container)).toBe('');
    });

    it('checks each setting the server sets and shows its value', async () => {
        serverMockState.defaults = { brightness: 0.1, deinterlaceMode: 'off', hdrOutput: true, preferredVideoPlayer: 'html' };

        const container = await renderEditor();

        for (const key of [ 'brightness', 'deinterlaceMode', 'hdrOutput', 'preferredVideoPlayer' ]) {
            expect(getSetCheckbox(container, key).checked, key).toBe(true);
            expect(getValueControl(container, key).disabled, key).toBe(false);
        }
        expect(Number(getValueControl(container, 'brightness').value)).toBe(0.1);
        expect(getValueControl(container, 'deinterlaceMode').value).toBe('off');
        expect(getValueControl(container, 'hdrOutput').checked).toBe(true);
        expect(getValueControl(container, 'preferredVideoPlayer').value).toBe('html');
        expect(getSetCheckbox(container, 'contrast').checked).toBe(false);
        expect(getStatus(container)).toBe('');
        // The page follows the defaults it just read
        expect(getClientDefaults()).toEqual(serverMockState.defaults);
    });

    it('shows the built-in value for a server value clients refuse, and names it', async () => {
        serverMockState.defaults = { enableCustomDecode: 'yes', toneMapOperator: 'bogus' };

        const container = await renderEditor();

        expect(getSetCheckbox(container, 'toneMapOperator').checked).toBe(true);
        expect(getValueControl(container, 'toneMapOperator').value).toBe(createHDRToSDRRenderSettings().toneMapping.operator);
        expect(getValueControl(container, 'enableCustomDecode').checked).toBe(true);
        expect(getStatus(container)).toBe(translateSourceString(
            'WebGPUClientDefaultsRefused',
            [ translateSourceString('WebGPUEnableCustomDecode'), translateSourceString('WebGPUToneMapOperator') ].join(', ')
        ));
    });

    it('saves exactly the set rows with typed values, numbers kept inside their ranges', async () => {
        const container = await renderEditor();

        setRow(container, 'brightness', true);
        changeValue(getValueControl(container, 'brightness'), '9999');
        setRow(container, 'hdrOutput', true);
        getValueControl(container, 'hdrOutput').checked = true;
        setRow(container, 'deinterlaceMode', true);
        changeValue(getValueControl(container, 'deinterlaceMode'), 'single-rate');
        setRow(container, 'preferredVideoPlayer', true);
        changeValue(getValueControl(container, 'preferredVideoPlayer'), 'webgpu');
        // A row set then unset again is not saved, and shows the built-in value
        setRow(container, 'contrast', true);
        changeValue(getValueControl(container, 'contrast'), '1.5');
        setRow(container, 'contrast', false);
        // An entry that is no number returns to the value shown before
        setRow(container, 'exposure', true);
        changeValue(getValueControl(container, 'exposure'), '');

        click(container, '[data-client-defaults-save]');

        await vi.waitFor(() => expect(getStatus(container)).toBe('SettingsSaved'));
        expect(saveServerClientDefaults).toHaveBeenCalledWith({
            brightness: HDR_RENDER_SETTING_RANGES.brightness.maximum,
            deinterlaceMode: 'single-rate',
            exposure: createHDRToSDRRenderSettings().toneMapping.exposure,
            hdrOutput: true,
            preferredVideoPlayer: 'webgpu'
        });
        expect(Number(getValueControl(container, 'contrast').value)).toBe(createHDRToSDRRenderSettings().display.contrast);
        expect(getValueControl(container, 'contrast').disabled).toBe(true);
        // The form shows what the server stored
        expect(getSetCheckbox(container, 'brightness').checked).toBe(true);
        expect(Number(getValueControl(container, 'brightness').value)).toBe(HDR_RENDER_SETTING_RANGES.brightness.maximum);
    });

    it('shows a refused save in the status and keeps the form', async () => {
        serverMockState.saveFailure = 'client-defaults-invalid: settings';
        const container = await renderEditor();
        setRow(container, 'hdrOutput', true);

        click(container, '[data-client-defaults-save]');

        await vi.waitFor(() => expect(getStatus(container))
            .toBe(translateSourceString('WebGPUClientDefaultsSaveFailed', 'client-defaults-invalid: settings')));
        expect(getSetCheckbox(container, 'hdrOutput').checked).toBe(true);
        expect(container.querySelector<HTMLButtonElement>('[data-client-defaults-save]')?.disabled).toBe(false);
    });

    it('saves nothing when the server defaults cannot be read, since a save would drop the defaults the form never showed', async () => {
        serverMockState.defaultsFailure = 'http-500';

        const container = await renderEditor();

        expect(getStatus(container)).toBe(translateSourceString('WebGPUClientDefaultsReadFailed', 'http-500'));
        const saveButton = container.querySelector<HTMLButtonElement>('[data-client-defaults-save]');
        expect(saveButton?.disabled).toBe(true);
        setRow(container, 'forceStereoDownmix', true);
        // A save calls the server before its first await, so a click that saves would have called it by now
        click(container, '[data-client-defaults-save]');
        expect(saveServerClientDefaults).not.toHaveBeenCalled();
    });

    it('lists the preset with each file\'s parameters, marks a file the server no longer offers, and saves only changed parameters', async () => {
        serverMockState.defaults = {
            presentationFiles: [
                { fileName: SATURATION_FILE, parameters: { [SATURATION_PARAMETER_NAME]: STORED_SATURATION } },
                { fileName: WITHDRAWN_FILE, parameters: { strength: 2 } }
            ]
        };

        const container = await renderEditor();

        const [ saturationText, withdrawnText ] = getPresetFileTexts(container);
        expect(saturationText).toContain(SATURATION_FILE);
        expect(saturationText).toContain(translateSourceString(
            'WebGPUClientDefaultsParameterRange',
            SATURATION_PARAMETER_DEFAULT,
            0,
            SATURATION_PARAMETER_MAXIMUM
        ));
        expect(saturationText).not.toContain(translateSourceString('WebGPUClientDefaultsPassNotOffered'));
        expect(withdrawnText).toContain(WITHDRAWN_FILE);
        expect(withdrawnText).toContain(translateSourceString('WebGPUClientDefaultsPassNotOffered'));
        expect(Number(getParameterInput(container).value)).toBe(STORED_SATURATION);
        // Only the file not listed yet can be added
        const choice = container.querySelector<HTMLSelectElement>('[data-client-defaults-preset-choice]');
        expect(Array.from(choice?.options ?? []).map((option: HTMLOptionElement): string => option.value)).toEqual([ INVERT_FILE ]);

        click(container, '[data-client-defaults-preset-add]');
        await vi.waitFor(() => expect(getPresetFileTexts(container)).toHaveLength(3));
        expect(getPresetFileTexts(container)[2]).toContain(INVERT_FILE);
        expect(choice?.disabled).toBe(true);

        // A value past the range is kept inside it; a value equal to the pass default is not stored
        changeValue(getParameterInput(container), '99');
        expect(Number(getParameterInput(container).value)).toBe(SATURATION_PARAMETER_MAXIMUM);
        click(container, '[data-client-defaults-save]');
        await vi.waitFor(() => expect(saveServerClientDefaults).toHaveBeenCalledTimes(1));
        expect(saveServerClientDefaults).toHaveBeenLastCalledWith({
            presentationFiles: [
                { fileName: SATURATION_FILE, parameters: { [SATURATION_PARAMETER_NAME]: SATURATION_PARAMETER_MAXIMUM } },
                // Its source cannot be read, so it keeps the values the server holds
                { fileName: WITHDRAWN_FILE, parameters: { strength: 2 } },
                { fileName: INVERT_FILE, parameters: {} }
            ]
        });
        await vi.waitFor(() => expect(getStatus(container)).toBe('SettingsSaved'));

        changeValue(getParameterInput(container), String(SATURATION_PARAMETER_DEFAULT));
        click(container, '[data-client-defaults-preset-remove="1"]');
        expect(getPresetFileTexts(container).map((text: string): boolean => text.includes(WITHDRAWN_FILE))).toEqual([ false, false ]);
        click(container, '[data-client-defaults-save]');
        await vi.waitFor(() => expect(saveServerClientDefaults).toHaveBeenCalledTimes(2));
        expect(saveServerClientDefaults).toHaveBeenLastCalledWith({
            presentationFiles: [
                { fileName: SATURATION_FILE, parameters: {} },
                { fileName: INVERT_FILE, parameters: {} }
            ]
        });
    });

    it('leaves the preset out of the save once its last file is removed', async () => {
        serverMockState.defaults = { presentationFiles: [ { fileName: INVERT_FILE, parameters: {} } ] };
        const container = await renderEditor();

        click(container, '[data-client-defaults-preset-remove="0"]');
        click(container, '[data-client-defaults-save]');

        await vi.waitFor(() => expect(saveServerClientDefaults).toHaveBeenCalledWith({}));
        expect(getPresetFileTexts(container)).toEqual([]);
    });

    it('names an unreadable pass catalog and offers nothing to add', async () => {
        serverMockState.catalogFailure = 'server-unavailable: no signed-in server';

        const container = await renderEditor();

        const unavailable = translateSourceString('WebGPUServerPassesUnavailable', 'server-unavailable: no signed-in server');
        expect(getStatus(container)).toBe(unavailable);
        const choice = container.querySelector<HTMLSelectElement>('[data-client-defaults-preset-choice]');
        expect(choice?.disabled).toBe(true);
        expect(choice?.textContent).toBe(unavailable);
    });
});

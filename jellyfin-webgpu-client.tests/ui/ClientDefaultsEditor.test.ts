import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM } from 'webgpu-player/audio/processing/CustomAudioDownmixAlgorithm';
import { createHDRToSDRRenderSettings, HDR_RENDER_SETTING_RANGES } from 'webgpu-player/presentation/RenderSettings';
import { CLIENT_DEFAULT_KEYS, getClientDefaults, setClientDefaults } from 'addons/webGPUPlayer/ClientDefaults';
import { saveServerClientDefaults } from 'addons/webGPUPlayer/ServerClientDefaults';
import { renderClientDefaultsEditor } from 'addons/webGPUPlayer/ui/ClientDefaultsEditor';
import { MAXIMUM_DECODER_TEST_RULE_COUNT, MAXIMUM_DECODER_TEST_RULES_LENGTH } from 'addons/webGPUPlayer/DecoderTestTiming';
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

vi.mock('addons/webGPUPlayer/ServerClientDefaults', async () => {
    const clientDefaults = await import('addons/webGPUPlayer/ClientDefaults');
    return {
        applyClientDefaults: vi.fn((defaults: { settings: Record<string, unknown> }): void => {
            clientDefaults.setClientDefaults(defaults.settings);
        }),
        fetchServerClientDefaults: vi.fn(() => (serverMockState.defaultsFailure === null ?
            Promise.resolve({ applied: {}, settings: serverMockState.defaults }) :
            Promise.reject(new Error(serverMockState.defaultsFailure)))),
        saveServerClientDefaults: vi.fn((defaults: Record<string, unknown>) => {
            if (serverMockState.saveFailure !== null) {
                return Promise.reject(new Error(serverMockState.saveFailure));
            }
            serverMockState.defaults = defaults;
            return Promise.resolve({ applied: {}, settings: defaults });
        })
    };
});

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

// This browser's values the editor shows for rules, which the real module reads from the host's app and browser detection
const decoderTestClient = vi.hoisted(() => ({
    client: 'Jellyfin Web',
    device: 'Firefox',
    deviceType: 'mobile' as const,
    userAgent: 'Mozilla/5.0 <test>',
    version: '10.11.0'
}));

vi.mock('addons/webGPUPlayer/DecoderTestTiming', async importOriginal => ({
    ...await importOriginal<typeof import('addons/webGPUPlayer/DecoderTestTiming')>(),
    describeDecoderTestClient: vi.fn(() => decoderTestClient)
}));

function createPassEntry(fileName: string, passName: string): { byteLength: number, contentHash: string, fileName: string, passNames: string[] } {
    return { byteLength: 1, contentHash: 'a'.repeat(64), fileName, passNames: [ passName ] };
}

function getCheckedDeviceTypes(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll<HTMLInputElement>('[data-client-default-value="decoderTestBackgroundDevices"]'))
        .filter((checkbox: HTMLInputElement): boolean => checkbox.checked)
        .map((checkbox: HTMLInputElement): string => checkbox.value);
}

function setDeviceTypeChecked(container: HTMLElement, deviceType: string, checked: boolean): void {
    const checkbox = container.querySelector<HTMLInputElement>(`[data-client-default-value="decoderTestBackgroundDevices"][value="${deviceType}"]`);
    if (!checkbox) {
        throw new Error(`no checkbox for ${deviceType}`);
    }
    checkbox.checked = checked;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Types rules into the rules box, as an administrator would. */
function enterRules(container: HTMLElement, text: string): void {
    const rulesBox = getValueControl(container, 'decoderTestRules');
    rulesBox.value = text;
    rulesBox.dispatchEvent(new Event('input', { bubbles: true }));
}

function getRuleProblems(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll('[data-client-defaults-rule-problems] > div'))
        .map((problem: Element): string => problem.textContent ?? '');
}

/** Joins sentences as the editor does, each to the ones before. */
function joinSentences(sentences: readonly string[]): string {
    return sentences.reduce((joined: string, sentence: string): string => translateSourceString('WebGPUJoinedSentences', joined, sentence));
}

function getValueControl(container: HTMLElement, key: string): HTMLInputElement & HTMLSelectElement {
    const control = container.querySelector<HTMLInputElement & HTMLSelectElement>(`[data-client-default-value="${key}"]`);
    if (!control) {
        throw new Error(`no control for ${key}`);
    }
    return control;
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

    it('shows each setting the server does not set with its built-in value, every control enabled', async () => {
        const container = await renderEditor();
        const builtInRender = createHDRToSDRRenderSettings();

        for (const key of CLIENT_DEFAULT_KEYS.filter((defaultKey: string): boolean => defaultKey !== 'presentationFiles')) {
            expect(getValueControl(container, key).disabled, key).toBe(false);
        }
        expect(container.querySelector('[data-client-default-set]')).toBeNull();
        expect(getValueControl(container, 'preferredVideoPlayer').value).toBe('auto');
        expect(getValueControl(container, 'settingsButtonPlacement').value).toBe('before-settings');
        expect(getValueControl(container, 'enableCustomDecode').checked).toBe(true);
        expect(getValueControl(container, 'enableGPUDecodeSlicing').checked).toBe(false);
        expect(getValueControl(container, 'webGPUFailureWarning').checked).toBe(true);
        expect(getValueControl(container, 'toneMapOperator').value).toBe(builtInRender.toneMapping.operator);
        expect(Number(getValueControl(container, 'brightness').value)).toBe(builtInRender.display.brightness);
        expect(getValueControl(container, 'audioDownmixAlgorithm').value).toBe(DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM);
        expect(getPresetFileTexts(container)).toEqual([]);
        expect(getStatus(container)).toBe('');
    });

    it('shows the value of each setting the server sets', async () => {
        serverMockState.defaults = {
            blackBarCrop: true,
            brightness: 0.1,
            deinterlaceMode: 'off',
            hdrOutput: true,
            preferredVideoPlayer: 'html',
            webGPUFailureWarning: false
        };

        const container = await renderEditor();

        expect(getValueControl(container, 'blackBarCrop').checked).toBe(true);
        expect(Number(getValueControl(container, 'brightness').value)).toBe(0.1);
        expect(getValueControl(container, 'deinterlaceMode').value).toBe('off');
        expect(getValueControl(container, 'hdrOutput').checked).toBe(true);
        expect(getValueControl(container, 'webGPUFailureWarning').checked).toBe(false);
        expect(getValueControl(container, 'preferredVideoPlayer').value).toBe('html');
        expect(Number(getValueControl(container, 'contrast').value)).toBe(createHDRToSDRRenderSettings().display.contrast);
        expect(getStatus(container)).toBe('');
        // The page follows the defaults it just read
        expect(getClientDefaults()).toEqual(serverMockState.defaults);
    });

    it('shows the built-in value for a server value clients refuse, and names it', async () => {
        serverMockState.defaults = { enableCustomDecode: 'yes', toneMapOperator: 'bogus' };

        const container = await renderEditor();

        expect(getValueControl(container, 'toneMapOperator').value).toBe(createHDRToSDRRenderSettings().toneMapping.operator);
        expect(getValueControl(container, 'enableCustomDecode').checked).toBe(true);
        expect(getStatus(container)).toBe(translateSourceString(
            'WebGPUClientDefaultsRefused',
            [ translateSourceString('WebGPUEnableCustomDecode'), translateSourceString('WebGPUToneMapOperator') ].join(', ')
        ));
    });

    it('saves exactly the values that differ from the built-in ones, numbers kept inside their ranges', async () => {
        serverMockState.defaults = { saturation: 1.5 };
        const container = await renderEditor();

        changeValue(getValueControl(container, 'brightness'), '9999');
        getValueControl(container, 'blackBarCrop').checked = true;
        getValueControl(container, 'hdrOutput').checked = true;
        getValueControl(container, 'webGPUFailureWarning').checked = false;
        changeValue(getValueControl(container, 'deinterlaceMode'), 'single-rate');
        changeValue(getValueControl(container, 'preferredVideoPlayer'), 'webgpu');
        // A value changed back to the built-in one, by hand or by its reset, is not stored
        changeValue(getValueControl(container, 'contrast'), '1.5');
        click(container, '[data-client-default-reset="contrast"]');
        click(container, '[data-client-default-reset="saturation"]');
        // An entry that is no number returns to the value shown before
        changeValue(getValueControl(container, 'exposure'), '');

        click(container, '[data-client-defaults-save]');

        await vi.waitFor(() => expect(getStatus(container)).toBe('SettingsSaved'));
        expect(saveServerClientDefaults).toHaveBeenCalledWith({
            blackBarCrop: true,
            brightness: HDR_RENDER_SETTING_RANGES.brightness.maximum,
            deinterlaceMode: 'single-rate',
            hdrOutput: true,
            preferredVideoPlayer: 'webgpu',
            webGPUFailureWarning: false
        }, []);
        expect(Number(getValueControl(container, 'contrast').value)).toBe(createHDRToSDRRenderSettings().display.contrast);
        expect(Number(getValueControl(container, 'saturation').value)).toBe(createHDRToSDRRenderSettings().display.saturation);
        expect(Number(getValueControl(container, 'exposure').value)).toBe(createHDRToSDRRenderSettings().toneMapping.exposure);
        // The form shows what the server stored
        expect(Number(getValueControl(container, 'brightness').value)).toBe(HDR_RENDER_SETTING_RANGES.brightness.maximum);
    });

    it('applies a setting to every client by saving the form with that setting named', async () => {
        const container = await renderEditor();
        changeValue(getValueControl(container, 'brightness'), '0.5');
        getValueControl(container, 'hdrOutput').checked = true;

        click(container, '[data-client-default-apply="brightness"]');

        await vi.waitFor(() => expect(getStatus(container))
            .toBe(translateSourceString('WebGPUClientDefaultsApplied', translateSourceString('WebGPUBrightness'))));
        expect(saveServerClientDefaults).toHaveBeenCalledWith({ brightness: 0.5, hdrOutput: true }, [ 'brightness' ]);

        click(container, '[data-client-default-apply="presentationFiles"]');
        await vi.waitFor(() => expect(saveServerClientDefaults).toHaveBeenCalledTimes(2));
        expect(saveServerClientDefaults).toHaveBeenLastCalledWith({ brightness: 0.5, hdrOutput: true }, [ 'presentationFiles' ]);
    });

    it('shows a refused save in the status and keeps the form', async () => {
        serverMockState.saveFailure = 'client-defaults-invalid: settings';
        const container = await renderEditor();
        getValueControl(container, 'hdrOutput').checked = true;

        click(container, '[data-client-defaults-save]');

        await vi.waitFor(() => expect(getStatus(container))
            .toBe(translateSourceString('WebGPUClientDefaultsSaveFailed', 'client-defaults-invalid: settings')));
        expect(getValueControl(container, 'hdrOutput').checked).toBe(true);
        expect(container.querySelector<HTMLButtonElement>('[data-client-defaults-save]')?.disabled).toBe(false);
        expect(container.querySelector<HTMLButtonElement>('[data-client-default-apply="hdrOutput"]')?.disabled).toBe(false);
    });

    it('saves nothing when the server defaults cannot be read, since a save would drop the defaults the form never showed', async () => {
        serverMockState.defaultsFailure = 'http-500';

        const container = await renderEditor();

        expect(getStatus(container)).toBe(translateSourceString('WebGPUClientDefaultsReadFailed', 'http-500'));
        const saveButton = container.querySelector<HTMLButtonElement>('[data-client-defaults-save]');
        expect(saveButton?.disabled).toBe(true);
        expect(container.querySelector<HTMLButtonElement>('[data-client-default-apply="brightness"]')?.disabled).toBe(true);
        getValueControl(container, 'forceStereoDownmix').checked = true;
        // A save calls the server before its first await, so a click that saves would have called it by now
        click(container, '[data-client-defaults-save]');
        click(container, '[data-client-default-apply="brightness"]');
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
        }, []);
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
        }, []);
    });

    it('leaves the preset out of the save once its last file is removed, or the preset is reset', async () => {
        serverMockState.defaults = { presentationFiles: [ { fileName: INVERT_FILE, parameters: {} } ] };
        const container = await renderEditor();

        click(container, '[data-client-defaults-preset-remove="0"]');
        click(container, '[data-client-defaults-save]');

        await vi.waitFor(() => expect(saveServerClientDefaults).toHaveBeenCalledWith({}, []));
        expect(getPresetFileTexts(container)).toEqual([]);

        serverMockState.defaults = { presentationFiles: [ { fileName: INVERT_FILE, parameters: {} }, { fileName: SATURATION_FILE, parameters: {} } ] };
        const resetContainer = await renderEditor();
        expect(getPresetFileTexts(resetContainer)).toHaveLength(2);
        click(resetContainer, '[data-client-default-reset="presentationFiles"]');
        expect(getPresetFileTexts(resetContainer)).toEqual([]);
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

    describe('decoder tests', () => {
        it('leads the editor with its three rows, each at its built-in value, and shows this browser\'s values for rules', async () => {
            const container = await renderEditor();

            const firstSection = container.querySelector('.sectionTitle')?.closest('.verticalSection');
            expect(firstSection?.querySelector('.sectionTitle')?.textContent).toBe(translateSourceString('WebGPUDecoderTests'));
            expect(Array.from(firstSection?.querySelectorAll<HTMLElement>('[data-client-default]') ?? [], (row: HTMLElement): string | undefined => row.dataset.clientDefault))
                .toEqual([ 'decoderTestTiming', 'decoderTestBackgroundDevices', 'decoderTestRules' ]);
            expect(Array.from(getValueControl(container, 'decoderTestTiming').options, (option: HTMLOptionElement): string => option.value))
                .toEqual([ 'automatic', 'background', 'playback' ]);
            expect(getValueControl(container, 'decoderTestTiming').value).toBe('automatic');
            expect(getCheckedDeviceTypes(container)).toEqual([ 'desktop' ]);
            expect(getValueControl(container, 'decoderTestRules').value).toBe('');
            expect(getRuleProblems(container)).toEqual([]);
            // Only the timing is a user's choice, which applying drops; each row returns to its built-in value
            expect(container.querySelector('[data-client-default-apply="decoderTestTiming"]')).not.toBeNull();
            expect(container.querySelector('[data-client-default-apply="decoderTestBackgroundDevices"]')).toBeNull();
            expect(container.querySelector('[data-client-default-apply="decoderTestRules"]')).toBeNull();
            for (const key of [ 'decoderTestTiming', 'decoderTestBackgroundDevices', 'decoderTestRules' ]) {
                expect(container.querySelector(`[data-client-default-reset="${key}"]`), key).not.toBeNull();
            }

            const clientValues = container.querySelector('[data-client-defaults-client-values]');
            expect(clientValues?.textContent).toContain(translateSourceString(
                'WebGPUDecoderTestClientDeviceType',
                translateSourceString('WebGPUDecoderTestDeviceTypeMobile')
            ));
            expect(Array.from(clientValues?.querySelectorAll('[data-client-defaults-client-value]') ?? [], (value: Element): string => value.textContent ?? ''))
                .toEqual([ 'client: Jellyfin Web', 'device: Firefox', 'version: 10.11.0', 'ua: Mozilla/5.0 <test>' ]);
        });

        it('shows the values the server sets, and the built-in ones for values clients refuse, which it names', async () => {
            serverMockState.defaults = {
                decoderTestBackgroundDevices: [ 'tv', 'mobile' ],
                decoderTestRules: 'playback device: iPhone*',
                decoderTestTiming: 'playback'
            };
            const container = await renderEditor();

            expect(getValueControl(container, 'decoderTestTiming').value).toBe('playback');
            expect(getCheckedDeviceTypes(container)).toEqual([ 'mobile', 'tv' ]);
            expect(getValueControl(container, 'decoderTestRules').value).toBe('playback device: iPhone*');
            expect(getStatus(container)).toBe('');

            serverMockState.defaults = {
                decoderTestBackgroundDevices: [ 'phone' ],
                decoderTestRules: 'x'.repeat(MAXIMUM_DECODER_TEST_RULES_LENGTH + 1),
                decoderTestTiming: 'sometimes'
            };
            const refusedContainer = await renderEditor();

            expect(getValueControl(refusedContainer, 'decoderTestTiming').value).toBe('automatic');
            expect(getCheckedDeviceTypes(refusedContainer)).toEqual([ 'desktop' ]);
            expect(getValueControl(refusedContainer, 'decoderTestRules').value).toBe('');
            expect(getStatus(refusedContainer)).toBe(translateSourceString(
                'WebGPUClientDefaultsRefused',
                [
                    translateSourceString('WebGPUDecoderTestTiming'),
                    translateSourceString('WebGPUDecoderTestBackgroundDevices'),
                    translateSourceString('WebGPUDecoderTestRules')
                ].join(', ')
            ));
        });

        it('saves the decoder test values that differ from the built-in ones, the device types by content', async () => {
            const container = await renderEditor();

            // Unchecking and checking again leaves the built-in device types, which are not stored
            setDeviceTypeChecked(container, 'desktop', false);
            setDeviceTypeChecked(container, 'desktop', true);
            click(container, '[data-client-defaults-save]');
            await vi.waitFor(() => expect(saveServerClientDefaults).toHaveBeenCalledTimes(1));
            expect(saveServerClientDefaults).toHaveBeenLastCalledWith({}, []);
            await vi.waitFor(() => expect(getStatus(container)).toBe('SettingsSaved'));

            changeValue(getValueControl(container, 'decoderTestTiming'), 'background');
            setDeviceTypeChecked(container, 'tv', true);
            enterRules(container, '# Remotes\nplayback device: iPhone*');
            click(container, '[data-client-defaults-save]');
            await vi.waitFor(() => expect(saveServerClientDefaults).toHaveBeenCalledTimes(2));
            expect(saveServerClientDefaults).toHaveBeenLastCalledWith({
                decoderTestBackgroundDevices: [ 'desktop', 'tv' ],
                decoderTestRules: '# Remotes\nplayback device: iPhone*',
                decoderTestTiming: 'background'
            }, []);
            // The status already reads saved from the first save, so the save button, enabled again, tells this one finished
            await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>('[data-client-defaults-save]')?.disabled).toBe(false));
            expect(getStatus(container)).toBe('SettingsSaved');

            // No device type in the background is a value of its own
            setDeviceTypeChecked(container, 'desktop', false);
            setDeviceTypeChecked(container, 'tv', false);
            click(container, '[data-client-default-apply="decoderTestTiming"]');
            await vi.waitFor(() => expect(saveServerClientDefaults).toHaveBeenCalledTimes(3));
            expect(saveServerClientDefaults).toHaveBeenLastCalledWith({
                decoderTestBackgroundDevices: [],
                decoderTestRules: '# Remotes\nplayback device: iPhone*',
                decoderTestTiming: 'background'
            }, [ 'decoderTestTiming' ]);
            await vi.waitFor(() => expect(getStatus(container))
                .toBe(translateSourceString('WebGPUClientDefaultsApplied', translateSourceString('WebGPUDecoderTestTiming'))));
            expect(getCheckedDeviceTypes(container)).toEqual([]);
        });

        it('names the problems of invalid rules beneath them, and saves nothing while they remain', async () => {
            const container = await renderEditor();

            enterRules(container, 'background client: Jellyfin Web\nsometimes device: x\nplayback colour: y\n\n# note\nplayback ua:');

            const problems = [
                translateSourceString('WebGPUDecoderTestRuleTiming', 2, MAXIMUM_DECODER_TEST_RULE_COUNT),
                translateSourceString('WebGPUDecoderTestRuleField', 3, MAXIMUM_DECODER_TEST_RULE_COUNT),
                translateSourceString('WebGPUDecoderTestRulePattern', 6, MAXIMUM_DECODER_TEST_RULE_COUNT)
            ];
            expect(getRuleProblems(container)).toEqual(problems);
            const blockedStatus = joinSentences([ translateSourceString('WebGPUDecoderTestRulesNotSaved'), joinSentences(problems) ]);
            click(container, '[data-client-defaults-save]');
            expect(getStatus(container)).toBe(blockedStatus);
            // Applying the timing saves the form too, so the rules block it as well
            const statusElement = container.querySelector('[role="status"]');
            if (statusElement) {
                statusElement.textContent = '';
            }
            click(container, '[data-client-default-apply="decoderTestTiming"]');
            expect(getStatus(container)).toBe(blockedStatus);
            expect(saveServerClientDefaults).not.toHaveBeenCalled();

            // A text past the length limit is refused whole, even of comments alone
            enterRules(container, '#'.repeat(MAXIMUM_DECODER_TEST_RULES_LENGTH + 1));
            const tooLong = translateSourceString('WebGPUDecoderTestRulesTooLong', MAXIMUM_DECODER_TEST_RULES_LENGTH + 1, MAXIMUM_DECODER_TEST_RULES_LENGTH);
            expect(getRuleProblems(container)).toEqual([ tooLong ]);
            click(container, '[data-client-defaults-save]');
            expect(getStatus(container)).toBe(joinSentences([ translateSourceString('WebGPUDecoderTestRulesNotSaved'), tooLong ]));
            expect(saveServerClientDefaults).not.toHaveBeenCalled();

            enterRules(container, 'PLAYBACK UA : *iPhone*');
            expect(getRuleProblems(container)).toEqual([]);
            click(container, '[data-client-defaults-save]');
            await vi.waitFor(() => expect(saveServerClientDefaults).toHaveBeenCalledWith({ decoderTestRules: 'PLAYBACK UA : *iPhone*' }, []));
        });

        it('returns each decoder test row to its built-in value', async () => {
            serverMockState.defaults = {
                decoderTestBackgroundDevices: [ 'mobile' ],
                decoderTestRules: 'sometimes device: x',
                decoderTestTiming: 'playback'
            };
            const container = await renderEditor();
            expect(getRuleProblems(container)).toHaveLength(1);

            click(container, '[data-client-default-reset="decoderTestTiming"]');
            click(container, '[data-client-default-reset="decoderTestBackgroundDevices"]');
            click(container, '[data-client-default-reset="decoderTestRules"]');

            expect(getValueControl(container, 'decoderTestTiming').value).toBe('automatic');
            expect(getCheckedDeviceTypes(container)).toEqual([ 'desktop' ]);
            expect(getValueControl(container, 'decoderTestRules').value).toBe('');
            expect(getRuleProblems(container)).toEqual([]);
            click(container, '[data-client-defaults-save]');
            await vi.waitFor(() => expect(saveServerClientDefaults).toHaveBeenCalledWith({}, []));
        });
    });
});

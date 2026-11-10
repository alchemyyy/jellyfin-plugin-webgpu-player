import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import {
    bindControlInfo,
    bindControlKeys,
    bindNumberFields,
    bindNumericControl,
    bindSelectTitles,
    type ControlText,
    createActionControlHTML,
    createButtonHTML,
    createCheckboxControlHTML,
    createNumberFieldHTML,
    createNumericControlHTML,
    createSelectControlHTML,
    type NumericControlBinding,
    refreshSelectTitles,
    setNumberFieldValue
} from 'addons/webGPUPlayer/ui/controls/SettingControls';
import { NUMERIC_CONTROL_CONFIGURATIONS, type NumericControlConfiguration } from 'addons/webGPUPlayer/ui/SettingDefinitions';
import { translateSourceString } from '../../host/globalizeMock';

vi.mock('lib/globalize', async () => {
    const globalizeMock = await import('../../host/globalizeMock');
    return { default: { translate: globalizeMock.translateSourceString } };
});

// Exposure: a hard range of -16 to 16 stops at 0.1, and a slider over -4 to 4
const EXPOSURE = NUMERIC_CONTROL_CONFIGURATIONS.find(configuration => configuration.key === 'exposure') as NumericControlConfiguration;

const DESCRIBED_TEXT: ControlText = { description: 'What the setting does.', label: 'Visible label', name: 'the setting' };

const cleanupCallbacks: Array<() => void> = [];

function createRoot(markup = ''): HTMLElement {
    const root = document.createElement('div');
    root.className = 'webgpuUi';
    root.innerHTML = markup;
    document.body.appendChild(root);
    return root;
}

function requireElement<ElementType extends Element>(root: ParentNode, selector: string): ElementType {
    const element = root.querySelector<ElementType>(selector);
    if (!element) {
        throw new Error(`Missing ${selector}`);
    }
    return element;
}

function pressKey(target: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...init });
    target.dispatchEvent(event);
    return event;
}

function typeText(field: HTMLInputElement, text: string): void {
    field.focus();
    field.value = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
}

function renderExposureControl(initialValue: number): Readonly<{
    binding: NumericControlBinding
    commit: Mock<(value: number) => void>
    control: HTMLElement
    field: HTMLInputElement
    getValue: () => number
    root: HTMLElement
    slider: HTMLInputElement
}> {
    const root = createRoot(createNumericControlHTML(EXPOSURE));
    let value = initialValue;
    const commit = vi.fn((nextValue: number): void => {
        value = nextValue;
    });
    const binding = bindNumericControl(root, EXPOSURE, { commit, getValue: (): number => value }, cleanupCallbacks);
    binding.synchronize();
    return {
        binding,
        commit,
        control: requireElement(root, '[data-control="exposure"]'),
        field: requireElement(root, '[data-setting-number="exposure"]'),
        getValue: (): number => value,
        root,
        slider: requireElement(root, '[data-setting-slider="exposure"]')
    };
}

describe('SettingControls', () => {
    afterEach(() => {
        for (const cleanup of cleanupCallbacks.splice(0)) {
            cleanup();
        }
        document.body.innerHTML = '';
        vi.useRealTimers();
    });

    it('renders a numeric control with a slider over its span and a typed field over its hard range', () => {
        const root = createRoot(createNumericControlHTML(EXPOSURE));
        const control = requireElement<HTMLElement>(root, '.webgpuControl[data-control="exposure"]');
        const slider = requireElement<HTMLInputElement>(control, 'input[type="range"][data-setting-slider="exposure"]');
        const field = requireElement<HTMLInputElement>(control, 'input[type="text"][data-setting-number="exposure"]');
        const description = requireElement<HTMLElement>(control, '#webgpu-exposure-description');
        const name = translateSourceString('WebGPUExposure');

        expect(slider.min).toBe('-4');
        expect(slider.max).toBe('4');
        expect(slider.step).toBe('0.1');
        expect(field.getAttribute('inputmode')).toBe('decimal');
        expect(field.getAttribute('role')).toBe('spinbutton');
        expect(field.getAttribute('autocomplete')).toBe('off');
        expect(field.getAttribute('spellcheck')).toBe('false');
        expect(field.getAttribute('aria-valuemin')).toBe('-16');
        expect(field.getAttribute('aria-valuemax')).toBe('16');
        expect(slider.getAttribute('aria-describedby')).toBe('webgpu-exposure-description');
        expect(field.getAttribute('aria-describedby')).toBe('webgpu-exposure-description');
        expect(description.classList).toContain('webgpuControlDescription');
        expect(description.classList).toContain('hide');
        expect(description.textContent).toBe(translateSourceString('WebGPUExposureHelp'));
        expect(control.querySelector('label')?.textContent?.trim()).toBe(
            translateSourceString('WebGPUSettingWithUnit', name, translateSourceString('WebGPUUnitStops'))
        );

        const resetButton = requireElement<HTMLButtonElement>(control, '[data-default-setting="exposure"]');
        expect(resetButton.getAttribute('aria-label')).toBe(translateSourceString('WebGPURestoreSettingDefault', name));
        expect(resetButton.title).toBe(translateSourceString('WebGPURestoreSettingDefault', name));
        const infoButton = requireElement<HTMLButtonElement>(control, '.webgpuSettingsInfoButton');
        expect(infoButton.getAttribute('aria-controls')).toBe('webgpu-exposure-description');
        expect(infoButton.getAttribute('aria-expanded')).toBe('false');
        expect(infoButton.getAttribute('aria-label')).toBe(translateSourceString('WebGPUSettingInfo', name));

        const steppers = control.querySelectorAll<HTMLButtonElement>('.webgpuStepper');
        expect(steppers).toHaveLength(2);
        expect(steppers[0].nextElementSibling).toBe(field);
        expect(field.nextElementSibling).toBe(steppers[1]);
        expect(steppers[0].tabIndex).toBe(-1);
        expect(steppers[0].getAttribute('aria-label')).toBe(translateSourceString('WebGPUDecreaseValue', name));
        expect(steppers[1].getAttribute('aria-label')).toBe(translateSourceString('WebGPUIncreaseValue', name));
    });

    it('renders checkbox, select, action, and button markup', () => {
        const root = createRoot(
            createCheckboxControlHTML('checkKey', DESCRIBED_TEXT, { reset: true })
            + createSelectControlHTML('selectKey', { ...DESCRIBED_TEXT, description: null }, '<option value="a">A</option>')
            + createSelectControlHTML('audioKey', DESCRIBED_TEXT, '', { selectAttributes: 'data-audio-output-select' })
            + createActionControlHTML('actionKey', DESCRIBED_TEXT, createButtonHTML({ className: 'clearResults', label: 'Clear <all>', variant: 'danger' }))
        );

        const checkbox = requireElement<HTMLInputElement>(root, '[data-control="checkKey"] input[type="checkbox"][data-setting-checkbox="checkKey"]');
        expect(checkbox.getAttribute('aria-describedby')).toBe('webgpu-checkKey-description');
        expect(root.querySelector('[data-control="checkKey"] [data-default-setting="checkKey"]')).not.toBeNull();

        const select = requireElement<HTMLSelectElement>(root, '[data-control="selectKey"] select[data-setting-select="selectKey"]');
        expect(select.hasAttribute('aria-describedby')).toBe(false);
        expect(root.querySelector('[data-control="selectKey"] .webgpuSettingsInfoButton')).toBeNull();
        expect(root.querySelector('[data-control="selectKey"] [data-default-setting]')).toBeNull();

        const audioSelect = requireElement<HTMLSelectElement>(root, '[data-control="audioKey"] select[data-audio-output-select]');
        expect(audioSelect.hasAttribute('data-setting-select')).toBe(false);
        expect(audioSelect.options).toHaveLength(0);

        const action = requireElement<HTMLElement>(root, '[data-control="actionKey"]');
        const button = requireElement<HTMLButtonElement>(action, 'button.webgpuButton.clearResults');
        expect(button.textContent).toBe('Clear <all>');
        expect(button.type).toBe('button');
        expect(action.querySelector('.webgpuSettingsInfoButton')).not.toBeNull();
        expect(action.querySelector('[data-default-setting]')).toBeNull();
    });

    it('applies the slider\'s value while it moves', () => {
        const { commit, field, slider } = renderExposureControl(1);

        slider.value = '2.5';
        slider.dispatchEvent(new Event('input', { bubbles: true }));

        expect(commit).toHaveBeenLastCalledWith(2.5);
        expect(field.value).toBe('2.5');
    });

    it('applies nothing while typing, then the clamped value on Enter', () => {
        const { commit, control, field, slider } = renderExposureControl(1);
        expect(field.value).toBe('1.0');

        typeText(field, '20');
        expect(commit).not.toHaveBeenCalled();
        expect(field.classList).toContain('webgpuUncommitted');
        expect(field.title).toBe(translateSourceString('WebGPUNumberUncommitted'));

        const event = pressKey(field, 'Enter');
        expect(event.defaultPrevented).toBe(true);
        expect(commit).toHaveBeenCalledTimes(1);
        expect(commit).toHaveBeenLastCalledWith(16);
        expect(field.value).toBe('16.0');
        expect(field.classList).not.toContain('webgpuUncommitted');
        expect(field.getAttribute('aria-valuenow')).toBe('16');
        expect(slider.value).toBe('4');
        expect(control.classList).toContain('webgpuBeyondSlider');
    });

    it('accepts a comma decimal on Enter, and reverts text that is no number', () => {
        const { commit, field } = renderExposureControl(1);

        typeText(field, '-2,35');
        pressKey(field, 'Enter');
        expect(commit).toHaveBeenLastCalledWith(-2.4);
        expect(field.value).toBe('-2.4');

        typeText(field, 'abc');
        pressKey(field, 'Enter');
        expect(commit).toHaveBeenCalledTimes(1);
        expect(field.value).toBe('-2.4');
        expect(field.classList).not.toContain('webgpuUncommitted');
    });

    it('reverts typed text on Escape, keeping the key from closing the settings only then', () => {
        const { commit, field } = renderExposureControl(1);
        const documentKeyDown = vi.fn();
        document.addEventListener('keydown', documentKeyDown);
        cleanupCallbacks.push((): void => {
            document.removeEventListener('keydown', documentKeyDown);
        });

        typeText(field, '3');
        const revertingEscape = pressKey(field, 'Escape');
        expect(revertingEscape.defaultPrevented).toBe(true);
        expect(documentKeyDown).not.toHaveBeenCalled();
        expect(field.value).toBe('1.0');
        expect(commit).not.toHaveBeenCalled();

        const closingEscape = pressKey(field, 'Escape');
        expect(closingEscape.defaultPrevented).toBe(false);
        expect(documentKeyDown).toHaveBeenCalledTimes(1);
    });

    it('reverts typed text when the field loses the focus', () => {
        const { commit, field } = renderExposureControl(1);

        typeText(field, '3');
        field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

        expect(field.value).toBe('1.0');
        expect(field.classList).not.toContain('webgpuUncommitted');
        expect(commit).not.toHaveBeenCalled();
    });

    it('steps with the arrow and page keys from the typed value, and applies at once', () => {
        const { commit, field } = renderExposureControl(1);

        pressKey(field, 'ArrowUp');
        expect(commit).toHaveBeenLastCalledWith(1.1);
        expect(field.value).toBe('1.1');

        pressKey(field, 'ArrowUp', { shiftKey: true });
        expect(commit).toHaveBeenLastCalledWith(2.1);

        pressKey(field, 'ArrowDown');
        expect(commit).toHaveBeenLastCalledWith(2);

        pressKey(field, 'PageDown');
        expect(commit).toHaveBeenLastCalledWith(1);

        typeText(field, '5');
        pressKey(field, 'ArrowUp');
        expect(commit).toHaveBeenLastCalledWith(5.1);
        expect(field.value).toBe('5.1');
        expect(field.classList).not.toContain('webgpuUncommitted');
    });

    it('steps with the stepper buttons, repeating while one is held', () => {
        vi.useFakeTimers();
        const { commit, control, getValue } = renderExposureControl(1);
        const [ decrease, increase ] = Array.from(control.querySelectorAll<HTMLButtonElement>('.webgpuStepper'));

        decrease.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
        expect(commit).toHaveBeenLastCalledWith(0.9);

        increase.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
        expect(getValue()).toBe(1);
        vi.advanceTimersByTime(399);
        expect(getValue()).toBe(1);
        vi.advanceTimersByTime(1 + 70);
        expect(getValue()).toBe(1.1);
        vi.advanceTimersByTime(140);
        expect(getValue()).toBe(1.3);

        window.dispatchEvent(new MouseEvent('pointerup'));
        vi.advanceTimersByTime(1000);
        expect(getValue()).toBe(1.3);

        // A mouse click after the press it follows steps no further
        increase.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
        expect(getValue()).toBe(1.3);
    });

    it('marks a value beyond the slider\'s span, with a tooltip', () => {
        const { binding, commit, control, field, slider } = renderExposureControl(6);

        expect(control.classList).toContain('webgpuBeyondSlider');
        expect(slider.value).toBe('4');
        expect(slider.title).not.toBe('');
        expect(field.value).toBe('6.0');

        commit(2);
        binding.synchronize();
        expect(control.classList).not.toContain('webgpuBeyondSlider');
        expect(slider.hasAttribute('title')).toBe(false);
        expect(slider.value).toBe('2');
    });

    it('disables the slider, the field, and its steppers', () => {
        const { binding, control, field, slider } = renderExposureControl(1);

        binding.setDisabled(true);
        expect(slider.disabled).toBe(true);
        expect(field.disabled).toBe(true);
        for (const stepper of Array.from(control.querySelectorAll<HTMLButtonElement>('.webgpuStepper'))) {
            expect(stepper.disabled).toBe(true);
        }

        binding.setDisabled(false);
        expect(field.disabled).toBe(false);
    });

    it('binds number fields rendered after binding, and shows nothing when nothing is applied', () => {
        const root = createRoot();
        const values = new Map<string, number | null>([ [ 'a', null ] ]);
        const commit = vi.fn((field: HTMLInputElement, value: number): void => {
            values.set(field.dataset.parameter ?? '', value);
        });
        bindNumberFields(root, {
            commit,
            getValue: (field: HTMLInputElement): number | null => values.get(field.dataset.parameter ?? '') ?? null
        }, cleanupCallbacks);
        root.innerHTML = createNumberFieldHTML({
            attributes: 'data-parameter="a"',
            bounds: { maximum: 1, minimum: 0, step: 0.01 },
            label: 'Strength',
            value: null
        });
        const field = requireElement<HTMLInputElement>(root, '[data-parameter="a"]');
        expect(field.value).toBe('');

        typeText(field, 'x');
        pressKey(field, 'Escape');
        expect(field.value).toBe('');

        typeText(field, '0.5');
        pressKey(field, 'Enter');
        expect(commit).toHaveBeenLastCalledWith(field, 0.5);
        expect(field.value).toBe('0.50');

        setNumberFieldValue(field, 0.25);
        expect(field.value).toBe('0.25');
        expect(field.getAttribute('aria-valuenow')).toBe('0.25');
    });

    it('shows and hides descriptions through info buttons rendered after binding', () => {
        const root = createRoot();
        bindControlInfo(root, cleanupCallbacks);
        root.innerHTML = createCheckboxControlHTML('checkKey', DESCRIBED_TEXT);
        const infoButton = requireElement<HTMLButtonElement>(root, '.webgpuSettingsInfoButton');
        const description = requireElement<HTMLElement>(root, '#webgpu-checkKey-description');

        infoButton.click();
        expect(description.classList).not.toContain('hide');
        expect(infoButton.getAttribute('aria-expanded')).toBe('true');

        infoButton.querySelector('span')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(description.classList).toContain('hide');
        expect(infoButton.getAttribute('aria-expanded')).toBe('false');
    });

    it('restores a default on Alt+R and shows details on Alt+I in the focused row', () => {
        const root = createRoot(
            createSelectControlHTML('selectKey', DESCRIBED_TEXT, '<option value="a">A</option>', { reset: true })
            + '<button class="outside" type="button">Outside</button>'
        );
        bindControlInfo(root, cleanupCallbacks);
        bindControlKeys(root, cleanupCallbacks);
        const select = requireElement<HTMLSelectElement>(root, 'select');
        const resetClick = vi.fn();
        requireElement(root, '[data-default-setting="selectKey"]').addEventListener('click', resetClick);
        const documentKeyDown = vi.fn();
        document.addEventListener('keydown', documentKeyDown);
        cleanupCallbacks.push((): void => {
            document.removeEventListener('keydown', documentKeyDown);
        });

        const reset = pressKey(select, 'r', { altKey: true, code: 'KeyR' });
        expect(resetClick).toHaveBeenCalledTimes(1);
        expect(reset.defaultPrevented).toBe(true);
        expect(documentKeyDown).not.toHaveBeenCalled();

        pressKey(select, 'i', { altKey: true, code: 'KeyI' });
        expect(requireElement(root, '.webgpuSettingsInfoButton').getAttribute('aria-expanded')).toBe('true');
        expect(requireElement(root, '#webgpu-selectKey-description').classList).not.toContain('hide');

        pressKey(select, 'r', { altKey: true, code: 'KeyR', ctrlKey: true });
        pressKey(select, 'r', { code: 'KeyR' });
        expect(resetClick).toHaveBeenCalledTimes(1);

        const outside = pressKey(requireElement(root, '.outside'), 'r', { altKey: true, code: 'KeyR' });
        expect(outside.defaultPrevented).toBe(false);
        expect(resetClick).toHaveBeenCalledTimes(1);
    });

    it('titles each select with its selected option\'s text', () => {
        const root = createRoot(createSelectControlHTML(
            'selectKey',
            DESCRIBED_TEXT,
            '<option value="a">A very long option name</option><option value="b">Short</option>'
        ));
        const select = requireElement<HTMLSelectElement>(root, 'select');

        refreshSelectTitles(root);
        expect(select.title).toBe('A very long option name');

        bindSelectTitles(root, cleanupCallbacks);
        select.value = 'b';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        expect(select.title).toBe('Short');
    });
});

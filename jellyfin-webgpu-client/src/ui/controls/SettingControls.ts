import escapeHtml from 'escape-html';

import globalize from 'lib/globalize';

import type { NumericControlConfiguration } from '../SettingDefinitions';
import { getSettingDescriptionId, HIDDEN_CLASS, translateToHTML } from '../SettingsPanelHTML';
import {
    clampNumericValue,
    formatNumericValue,
    type NumericBounds,
    parseNumericText,
    stepNumericValue
} from './NumericEntry';
import './SettingControls.scss';

// The controls every settings window builds its rows from: checkboxes, selects, numeric controls with a slider and a typed field,
// action rows, and buttons, each row with its info and reset buttons; and the binders that give them their behaviour;
// Binders delegate events from a root, so rows a window renders again through innerHTML keep working

export type ControlText = Readonly<{
    // Plain-text details the info button expands; null shows no info button
    description: string | null
    label: string
    // The setting's name inside sentences, such as the reset button's label
    name: string
}>;

export type NumberFieldOptions = Readonly<{
    commit: (field: HTMLInputElement, value: number) => void
    getValue: (field: HTMLInputElement) => number | null
}>;

export type NumericControlBinding = Readonly<{
    setDisabled: (disabled: boolean) => void
    synchronize: () => void
}>;

type ButtonVariant = 'danger' | 'primary' | 'secondary';

// The class of a control row's restore-default button, which the windows find by its data-default-setting value
const DEFAULT_BUTTON_CLASS = 'webgpuSettingsDefaultButton';
const DEFAULT_SETTING_ICON = 'settings_backup_restore';
const INFO_BUTTON_CLASS = 'webgpuSettingsInfoButton';
const SETTING_INFO_ICON = 'info_outline';
const BEYOND_SLIDER_CLASS = 'webgpuBeyondSlider';
const CONTROL_DISABLED_CLASS = 'webgpuControlDisabled';
const NUMBER_INPUT_CLASS = 'webgpuNumberInput';
const STEPPER_CLASS = 'webgpuStepper';
const UNCOMMITTED_CLASS = 'webgpuUncommitted';
// The slider's filled share, which its track paints in the accent color
const SLIDER_FILL_PROPERTY = '--webgpu-slider-fill';
const BUTTON_VARIANT_CLASSES: Readonly<Record<ButtonVariant, string>> = Object.freeze({
    danger: 'webgpuButtonDanger',
    primary: 'webgpuButtonPrimary',
    secondary: 'webgpuButtonSecondary'
});
// A held stepper button steps once, waits, then repeats
const STEPPER_REPEAT_DELAY_MS = 400;
const STEPPER_REPEAT_INTERVAL_MS = 70;
// Shift+Arrow and Page keys move a field by this many steps
const LARGE_STEP_COUNT = 10;

// Events a field's own handler already handled, so an outer binder over the same field skips them
const handledEvents = new WeakSet<Event>();

/** Returns the id of a control row's own input, which its visible label names. */
function getControlInputId(key: string): string {
    return `webgpu-${key}-control`;
}

/** Returns the attribute naming a control's description, when it has one. */
function createDescribedByHTML(key: string, text: ControlText): string {
    return text.description === null ? '' : `aria-describedby="${escapeHtml(getSettingDescriptionId(key))}"`;
}

/** Returns the description an info button expands, hidden at first, or nothing for a control without one. */
function createDescriptionHTML(key: string, text: ControlText): string {
    return text.description === null ?
        '' :
        `<div class="webgpuControlDescription ${HIDDEN_CLASS}" id="${escapeHtml(getSettingDescriptionId(key))}">${escapeHtml(text.description)}</div>`;
}

/** Returns a row's info button, when it has a description, then its restore-default button, when asked for. */
function createRowButtonsHTML(key: string, text: ControlText, reset: boolean): string {
    let buttonsHTML = '';
    if (text.description !== null) {
        const label = globalize.translate('WebGPUSettingInfo', text.name);
        buttonsHTML += createIconButtonHTML({
            attributes: `aria-controls="${escapeHtml(getSettingDescriptionId(key))}" aria-expanded="false"`,
            className: INFO_BUTTON_CLASS,
            icon: SETTING_INFO_ICON,
            label
        });
    }
    if (reset) {
        buttonsHTML += createIconButtonHTML({
            attributes: `data-default-setting="${escapeHtml(key)}"`,
            className: DEFAULT_BUTTON_CLASS,
            icon: DEFAULT_SETTING_ICON,
            label: globalize.translate('WebGPURestoreSettingDefault', text.name)
        });
    }
    return buttonsHTML === '' ? '' : `<span class="webgpuControlButtons">${buttonsHTML}</span>`;
}

/** Returns a control row: its line of label, field, and buttons, then its description. */
function createControlRowHTML(key: string, kindClass: string, lineHTML: string, descriptionHTML: string): string {
    return `
        <div class="webgpuControl ${kindClass}" data-control="${escapeHtml(key)}">
            <div class="webgpuControlLine">${lineHTML}</div>
            ${descriptionHTML}
        </div>`;
}

/** Returns a text button in the controls' look; the label is plain text, the class and attributes raw HTML the caller escapes. */
export function createButtonHTML(options: Readonly<{
    attributes?: string
    className?: string
    icon?: string
    label: string
    variant?: ButtonVariant
}>): string {
    const iconHTML = options.icon === undefined ?
        '' :
        `<span class="material-icons ${options.icon}" aria-hidden="true"></span>`;
    const variantClass = BUTTON_VARIANT_CLASSES[options.variant ?? 'secondary'];
    return `<button class="webgpuButton ${variantClass} ${options.className ?? ''}" type="button" ${options.attributes ?? ''}>${iconHTML}<span class="webgpuButtonLabel">${escapeHtml(options.label)}</span></button>`;
}

/** Returns a square icon button named by its label and tooltip; the label is plain text, the class and attributes raw HTML the caller escapes. */
export function createIconButtonHTML(options: Readonly<{
    attributes?: string
    className?: string
    icon: string
    label: string
}>): string {
    const label = escapeHtml(options.label);
    return `<button aria-label="${label}" class="webgpuIconButton ${options.className ?? ''}" title="${label}" type="button" ${options.attributes ?? ''}><span class="material-icons ${options.icon}" aria-hidden="true"></span></button>`;
}

/** Returns a checkbox row: a square box beside its label, then its info and restore-default buttons. */
export function createCheckboxControlHTML(key: string, text: ControlText, options: Readonly<{ reset?: boolean }> = {}): string {
    const lineHTML = `
        <label class="webgpuCheckbox">
            <input
                ${createDescribedByHTML(key, text)}
                class="webgpuCheckboxInput"
                data-setting-checkbox="${escapeHtml(key)}"
                id="${escapeHtml(getControlInputId(key))}"
                type="checkbox"
            />
            <span class="webgpuCheckboxBox" aria-hidden="true"></span>
            <span class="webgpuControlLabel">${escapeHtml(text.label)}</span>
        </label>
        ${createRowButtonsHTML(key, text, options.reset ?? false)}`;
    return createControlRowHTML(key, 'webgpuCheckboxControl', lineHTML, createDescriptionHTML(key, text));
}

/** Returns a select row: its label, its select over the given options, then its info and restore-default buttons, which the row's layout puts beside the label. */
export function createSelectControlHTML(
    key: string,
    text: ControlText,
    optionsHTML: string,
    options: Readonly<{ reset?: boolean, selectAttributes?: string }> = {}
): string {
    const selectAttributes = options.selectAttributes ?? `data-setting-select="${escapeHtml(key)}"`;
    const lineHTML = `
        <label class="webgpuControlLabel" for="${escapeHtml(getControlInputId(key))}">${escapeHtml(text.label)}</label>
        <span class="webgpuControlField">
            <select
                ${createDescribedByHTML(key, text)}
                class="webgpuSelect"
                id="${escapeHtml(getControlInputId(key))}"
                ${selectAttributes}
            >${optionsHTML}</select>
        </span>
        ${createRowButtonsHTML(key, text, options.reset ?? false)}`;
    return createControlRowHTML(key, 'webgpuSelectControl', lineHTML, createDescriptionHTML(key, text));
}

/** Returns a typed number field between its decrease and increase buttons; its data attributes carry the bounds its binder keeps it in. */
export function createNumberFieldHTML(options: Readonly<{
    attributes: string
    bounds: NumericBounds
    label: string
    value: number | null
}>): string {
    const { bounds } = options;
    const label = escapeHtml(options.label);
    const decreaseLabel = translateToHTML('WebGPUDecreaseValue', options.label);
    const increaseLabel = translateToHTML('WebGPUIncreaseValue', options.label);
    const valueText = options.value === null ? '' : formatNumericValue(options.value, bounds.step);
    const valueNowHTML = options.value === null || !Number.isFinite(options.value) ? '' : `aria-valuenow="${options.value}"`;
    return `
        <span class="webgpuNumberField">
            <button
                aria-label="${decreaseLabel}"
                class="${STEPPER_CLASS}"
                data-number-direction="-1"
                tabindex="-1"
                title="${decreaseLabel}"
                type="button"
            ><span class="material-icons remove" aria-hidden="true"></span></button>
            <input
                aria-label="${label}"
                aria-valuemax="${bounds.maximum}"
                aria-valuemin="${bounds.minimum}"
                ${valueNowHTML}
                autocomplete="off"
                class="${NUMBER_INPUT_CLASS}"
                data-number-maximum="${bounds.maximum}"
                data-number-minimum="${bounds.minimum}"
                data-number-step="${bounds.step}"
                inputmode="decimal"
                role="spinbutton"
                spellcheck="false"
                type="text"
                value="${escapeHtml(valueText)}"
                ${options.attributes}
            />
            <button
                aria-label="${increaseLabel}"
                class="${STEPPER_CLASS}"
                data-number-direction="1"
                tabindex="-1"
                title="${increaseLabel}"
                type="button"
            ><span class="material-icons add" aria-hidden="true"></span></button>
        </span>`;
}

/** Returns a numeric setting's row: its label with its unit, a slider over its reasonable span, a typed field over its hard range, then its info and restore-default buttons. */
export function createNumericControlHTML(configuration: NumericControlConfiguration): string {
    const key = configuration.key;
    const name = globalize.translate(configuration.labelKey);
    const label = configuration.unitKey ?
        globalize.translate('WebGPUSettingWithUnit', name, globalize.translate(configuration.unitKey)) :
        name;
    const text: ControlText = { description: globalize.translate(configuration.descriptionKey), label, name };
    const describedByHTML = createDescribedByHTML(key, text);
    const sliderRange = configuration.sliderRange;
    const lineHTML = `
        <label class="webgpuControlLabel" for="${getControlInputId(key)}">${escapeHtml(label)}</label>
        <span class="webgpuControlField webgpuNumericField">
            <input
                ${describedByHTML}
                class="webgpuSlider"
                data-setting-slider="${key}"
                id="${getControlInputId(key)}"
                max="${sliderRange.maximum}"
                min="${sliderRange.minimum}"
                step="${sliderRange.step}"
                type="range"
            />
            ${createNumberFieldHTML({
                attributes: `${describedByHTML} data-setting-number="${key}"`,
                bounds: configuration.range,
                label: name,
                value: null
            })}
        </span>
        ${createRowButtonsHTML(key, text, true)}`;
    return createControlRowHTML(key, 'webgpuNumericControl', lineHTML, createDescriptionHTML(key, text));
}

/** Returns a row holding a caller-built button and the info button of its description; the button names the row, so it shows no label. */
export function createActionControlHTML(key: string, text: ControlText, buttonHTML: string): string {
    const lineHTML = `
        <span class="webgpuControlAction">${buttonHTML}</span>
        ${createRowButtonsHTML(key, text, false)}`;
    return createControlRowHTML(key, 'webgpuActionControl', lineHTML, createDescriptionHTML(key, text));
}

/** Returns the element an event targets, when it is an element below the root. */
function getEventElement(root: HTMLElement, event: Event): Element | null {
    const target = event.target;
    return target instanceof Element && root.contains(target) ? target : null;
}

/** Adds a listener that the cleanup callbacks remove. */
function listen<EventType extends Event>(
    target: EventTarget,
    type: string,
    listener: (event: EventType) => void,
    cleanupCallbacks: Array<() => void>
): void {
    const eventListener = listener as EventListener;
    target.addEventListener(type, eventListener);
    cleanupCallbacks.push((): void => {
        target.removeEventListener(type, eventListener);
    });
}

/** Makes every info button below the root show or hide its description, including buttons rendered later. */
export function bindControlInfo(root: HTMLElement, cleanupCallbacks: Array<() => void>): void {
    listen<MouseEvent>(root, 'click', (event: MouseEvent): void => {
        const button = getEventElement(root, event)?.closest<HTMLButtonElement>(`.${INFO_BUTTON_CLASS}`);
        const descriptionId = button?.getAttribute('aria-controls');
        if (!button || !root.contains(button) || !descriptionId) {
            return;
        }
        const description = root.ownerDocument.getElementById(descriptionId);
        if (!description) {
            return;
        }
        // The toggle reports whether the description is hidden now
        const expanded = !description.classList.toggle(HIDDEN_CLASS);
        button.setAttribute('aria-expanded', String(expanded));
    }, cleanupCallbacks);
}

/** Returns the bounds a number field's data attributes carry. */
function getNumberFieldBounds(field: HTMLInputElement): NumericBounds {
    return {
        maximum: Number(field.dataset.numberMaximum),
        minimum: Number(field.dataset.numberMinimum),
        step: Number(field.dataset.numberStep)
    };
}

/** Shows a number field's applied value, or no text when nothing is applied, and clears its uncommitted state. */
function showNumberFieldValue(field: HTMLInputElement, value: number | null): void {
    if (value === null || !Number.isFinite(value)) {
        field.value = '';
        field.removeAttribute('aria-valuenow');
        clearUncommitted(field);
        return;
    }
    setNumberFieldValue(field, value);
}

/** Clears a number field's uncommitted style and tooltip. */
function clearUncommitted(field: HTMLInputElement): void {
    if (field.classList.contains(UNCOMMITTED_CLASS)) {
        field.classList.remove(UNCOMMITTED_CLASS);
        field.removeAttribute('title');
    }
}

/** Shows an applied value in a number field at its step's precision, and clears its uncommitted state. */
export function setNumberFieldValue(field: HTMLInputElement, value: number): void {
    if (!Number.isFinite(value)) {
        return;
    }
    field.value = formatNumericValue(value, getNumberFieldBounds(field).step);
    field.setAttribute('aria-valuenow', String(value));
    clearUncommitted(field);
}

/** Returns the number field an event targets below the container, or null. */
function getEventNumberField(container: HTMLElement, event: Event): HTMLInputElement | null {
    const element = getEventElement(container, event);
    return element instanceof HTMLInputElement && element.classList.contains(NUMBER_INPUT_CLASS) ? element : null;
}

/** Returns the number field a stepper button event targets below the container, with the button's direction. */
function getEventStepper(container: HTMLElement, event: Event): Readonly<{ direction: number, field: HTMLInputElement }> | null {
    const button = getEventElement(container, event)?.closest<HTMLButtonElement>(`.${STEPPER_CLASS}`);
    const field = button?.parentElement?.querySelector<HTMLInputElement>(`.${NUMBER_INPUT_CLASS}`);
    if (!button || !field || button.disabled || field.disabled || !container.contains(button)) {
        return null;
    }
    return { direction: Number(button.dataset.numberDirection), field };
}

/** Returns how many steps a key moves a number field, or null for a key that steps nothing. */
function getKeyStepCount(event: KeyboardEvent): number | null {
    switch (event.key) {
        case 'ArrowUp':
            return event.shiftKey ? LARGE_STEP_COUNT : 1;
        case 'ArrowDown':
            return event.shiftKey ? -LARGE_STEP_COUNT : -1;
        case 'PageUp':
            return LARGE_STEP_COUNT;
        case 'PageDown':
            return -LARGE_STEP_COUNT;
        default:
            return null;
    }
}

/** Makes every number field below the container apply a value only on Enter, a step key, or a stepper button, and revert typed text otherwise. */
export function bindNumberFields(container: HTMLElement, options: NumberFieldOptions, cleanupCallbacks: Array<() => void>): void {
    const revert = (field: HTMLInputElement): void => {
        showNumberFieldValue(field, options.getValue(field));
    };
    const commit = (field: HTMLInputElement, value: number): void => {
        const bounds = getNumberFieldBounds(field);
        const clampedValue = clampNumericValue(value, bounds);
        if (!Number.isFinite(clampedValue)) {
            revert(field);
            return;
        }
        options.commit(field, clampedValue);
        showNumberFieldValue(field, options.getValue(field) ?? clampedValue);
    };
    const step = (field: HTMLInputElement, count: number): void => {
        const bounds = getNumberFieldBounds(field);
        const base = parseNumericText(field.value) ?? options.getValue(field) ?? clampNumericValue(0, bounds);
        commit(field, stepNumericValue(base, count, bounds));
    };
    let stopRepeat: (() => void) | null = null;
    const onInput = (event: Event): void => {
        const field = getEventNumberField(container, event);
        if (!field || handledEvents.has(event)) {
            return;
        }
        handledEvents.add(event);
        const value = options.getValue(field);
        const appliedText = value === null ? '' : formatNumericValue(value, getNumberFieldBounds(field).step);
        const uncommitted = field.value !== appliedText;
        if (uncommitted && !field.classList.contains(UNCOMMITTED_CLASS)) {
            field.classList.add(UNCOMMITTED_CLASS);
            field.title = globalize.translate('WebGPUNumberUncommitted');
        } else if (!uncommitted) {
            clearUncommitted(field);
        }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
        const field = getEventNumberField(container, event);
        if (!field || handledEvents.has(event) || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) {
            return;
        }
        const stepCount = getKeyStepCount(event);
        if (event.key === 'Enter') {
            const value = parseNumericText(field.value);
            if (value === null) {
                revert(field);
            } else {
                commit(field, value);
            }
        } else if (event.key === 'Escape') {
            // Escape without typed text closes the settings, as it does elsewhere
            if (!field.classList.contains(UNCOMMITTED_CLASS)) {
                return;
            }
            revert(field);
        } else if (stepCount === null) {
            return;
        } else {
            step(field, stepCount);
        }
        handledEvents.add(event);
        event.preventDefault();
        // The player's own keys seek and change the volume with the arrow keys
        event.stopPropagation();
    };
    const onFocusOut = (event: FocusEvent): void => {
        const field = getEventNumberField(container, event);
        if (!field || handledEvents.has(event)) {
            return;
        }
        handledEvents.add(event);
        if (field.classList.contains(UNCOMMITTED_CLASS)) {
            revert(field);
        }
    };
    const onPointerDown = (event: PointerEvent): void => {
        const stepper = getEventStepper(container, event);
        if (!stepper || handledEvents.has(event) || event.button > 0) {
            return;
        }
        handledEvents.add(event);
        stopRepeat?.();
        const button = event.target instanceof Element ? event.target.closest(`.${STEPPER_CLASS}`) : null;
        step(stepper.field, stepper.direction);
        let intervalId: number | undefined;
        const timeoutId = window.setTimeout((): void => {
            intervalId = window.setInterval((): void => {
                if (stepper.field.disabled) {
                    stopRepeat?.();
                    return;
                }
                step(stepper.field, stepper.direction);
            }, STEPPER_REPEAT_INTERVAL_MS);
        }, STEPPER_REPEAT_DELAY_MS);
        const stop = (): void => {
            window.clearTimeout(timeoutId);
            window.clearInterval(intervalId);
            window.removeEventListener('pointerup', stop);
            window.removeEventListener('pointercancel', stop);
            button?.removeEventListener('pointerleave', stop);
            stopRepeat = null;
        };
        window.addEventListener('pointerup', stop);
        window.addEventListener('pointercancel', stop);
        button?.addEventListener('pointerleave', stop);
        stopRepeat = stop;
    };
    const onMouseDown = (event: MouseEvent): void => {
        // A stepper keeps the focus where it was, so pressing it does not blur the field
        if (getEventStepper(container, event)) {
            event.preventDefault();
        }
    };
    const onClick = (event: MouseEvent): void => {
        // A pointer press already stepped; a click without one comes from the keyboard or a script
        const stepper = event.detail === 0 ? getEventStepper(container, event) : null;
        if (!stepper || handledEvents.has(event)) {
            return;
        }
        handledEvents.add(event);
        step(stepper.field, stepper.direction);
    };
    listen(container, 'input', onInput, cleanupCallbacks);
    listen(container, 'keydown', onKeyDown, cleanupCallbacks);
    listen(container, 'focusout', onFocusOut, cleanupCallbacks);
    listen(container, 'pointerdown', onPointerDown, cleanupCallbacks);
    listen(container, 'mousedown', onMouseDown, cleanupCallbacks);
    listen(container, 'click', onClick, cleanupCallbacks);
    cleanupCallbacks.push((): void => {
        stopRepeat?.();
    });
}

/** Returns the element a selector finds below the root, or throws when the markup lacks it. */
function requireControlElement<ElementType extends Element>(root: HTMLElement, selector: string): ElementType {
    const element = root.matches(selector) ? root as Element as ElementType : root.querySelector<ElementType>(selector);
    if (!element) {
        throw new Error(`The settings controls lack ${selector}`);
    }
    return element;
}

/** Binds a numeric setting's row: its slider applies while it moves, its field per bindNumberFields; synchronize shows the applied value in both. */
export function bindNumericControl(
    root: HTMLElement,
    configuration: NumericControlConfiguration,
    options: Readonly<{ commit: (value: number) => void, getValue: () => number }>,
    cleanupCallbacks: Array<() => void>
): NumericControlBinding {
    const key = configuration.key;
    const control = requireControlElement<HTMLElement>(root, `[data-control="${key}"]`);
    const slider = requireControlElement<HTMLInputElement>(control, `[data-setting-slider="${key}"]`);
    const field = requireControlElement<HTMLInputElement>(control, `[data-setting-number="${key}"]`);
    const steppers = Array.from(control.querySelectorAll<HTMLButtonElement>(`.${STEPPER_CLASS}`));
    const sliderRange = configuration.sliderRange;
    const beyondSliderTitle = globalize.translate(
        'WebGPUValueBeyondSlider',
        formatNumericValue(sliderRange.minimum, sliderRange.step),
        formatNumericValue(sliderRange.maximum, sliderRange.step)
    );
    const showSliderValue = (value: number): void => {
        const sliderValue = clampNumericValue(value, sliderRange);
        slider.value = String(sliderValue);
        const span = sliderRange.maximum - sliderRange.minimum;
        const fill = span > 0 ? (sliderValue - sliderRange.minimum) / span * 100 : 0;
        slider.style.setProperty(SLIDER_FILL_PROPERTY, `${fill}%`);
        const beyondSlider = value < sliderRange.minimum || value > sliderRange.maximum;
        control.classList.toggle(BEYOND_SLIDER_CLASS, beyondSlider);
        if (beyondSlider) {
            slider.title = beyondSliderTitle;
        } else {
            slider.removeAttribute('title');
        }
    };
    const synchronize = (): void => {
        const value = options.getValue();
        showSliderValue(value);
        // Text being typed survives a refresh that other settings' changes cause
        if (field.classList.contains(UNCOMMITTED_CLASS) && field.ownerDocument.activeElement === field) {
            if (Number.isFinite(value)) {
                field.setAttribute('aria-valuenow', String(value));
            }
            return;
        }
        showNumberFieldValue(field, value);
    };
    listen(slider, 'input', (): void => {
        const value = Number(slider.value);
        if (Number.isFinite(value)) {
            options.commit(clampNumericValue(value, configuration.range));
        }
        synchronize();
    }, cleanupCallbacks);
    bindNumberFields(control, {
        commit: (_field: HTMLInputElement, value: number): void => {
            options.commit(value);
            showSliderValue(options.getValue());
        },
        getValue: (): number | null => options.getValue()
    }, cleanupCallbacks);
    return {
        setDisabled: (disabled: boolean): void => {
            slider.disabled = disabled;
            field.disabled = disabled;
            for (const stepper of steppers) {
                stepper.disabled = disabled;
            }
            control.classList.toggle(CONTROL_DISABLED_CLASS, disabled);
        },
        synchronize
    };
}

/** Sets a select's tooltip to its selected option's whole text, which the narrow select may cut short. */
function refreshSelectTitle(select: HTMLSelectElement): void {
    const text = select.options.item(select.selectedIndex)?.textContent?.trim() ?? '';
    if (text === '') {
        select.removeAttribute('title');
    } else {
        select.title = text;
    }
}

/** Sets every select's tooltip below the root to its selected option's text. */
export function refreshSelectTitles(root: HTMLElement): void {
    for (const select of Array.from(root.querySelectorAll('select'))) {
        refreshSelectTitle(select);
    }
}

/** Keeps every select's tooltip below the root current as its choice changes. */
export function bindSelectTitles(root: HTMLElement, cleanupCallbacks: Array<() => void>): void {
    listen(root, 'change', (event: Event): void => {
        const element = getEventElement(root, event);
        if (element instanceof HTMLSelectElement) {
            refreshSelectTitle(element);
        }
    }, cleanupCallbacks);
}

/** Makes Alt+R restore the default of the control row holding the focus, and Alt+I show or hide its details. */
export function bindControlKeys(root: HTMLElement, cleanupCallbacks: Array<() => void>): void {
    listen<KeyboardEvent>(root, 'keydown', (event: KeyboardEvent): void => {
        if (!event.altKey || event.ctrlKey || event.metaKey) {
            return;
        }
        let selector: string;
        if (event.code === 'KeyR') {
            selector = `.${DEFAULT_BUTTON_CLASS}`;
        } else if (event.code === 'KeyI') {
            selector = `.${INFO_BUTTON_CLASS}`;
        } else {
            return;
        }
        const row = getEventElement(root, event)?.closest<HTMLElement>('.webgpuControl');
        const button = row && root.contains(row) ? row.querySelector<HTMLButtonElement>(selector) : null;
        if (!button || button.disabled) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        button.click();
    }, cleanupCallbacks);
}

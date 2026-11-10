// The arithmetic of a typed numeric value: its text at a step's precision, the text a person types, and a value kept inside its bounds

export type NumericBounds = Readonly<{
    maximum: number
    minimum: number
    step: number
}>;

// The step precision of a step that names none
const DEFAULT_STEP_DECIMALS = 2;
// The most decimals toFixed renders in every browser the add-on supports
const MAXIMUM_STEP_DECIMALS = 20;
// A sign, digits with one '.' or ',' decimal separator, and an optional exponent
const NUMERIC_TEXT_PATTERN = /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?$/i;

/** Returns how many decimals a step's values carry: 1 has none, 0.1 one, 0.25 two; a step that is not a positive number carries two. */
export function getStepDecimals(step: number): number {
    if (!Number.isFinite(step) || step <= 0) {
        return DEFAULT_STEP_DECIMALS;
    }
    // A small step prints as 1e-7, so its exponent adds to the decimals its mantissa shows
    const [ mantissa, exponent = '0' ] = step.toString().split('e');
    const separatorIndex = mantissa.indexOf('.');
    const fractionLength = separatorIndex < 0 ? 0 : mantissa.length - separatorIndex - 1;
    return Math.min(MAXIMUM_STEP_DECIMALS, Math.max(0, fractionLength - Number(exponent)));
}

/** Returns a value's text with exactly its step's decimals, never a negative zero; a value that is not a number has no text. */
export function formatNumericValue(value: number, step: number): string {
    if (!Number.isFinite(value)) {
        return '';
    }
    const decimals = getStepDecimals(step);
    const text = value.toFixed(decimals);
    // A tiny negative value rounds to -0.00, which reads as a different value than zero
    return Number(text) === 0 ? (0).toFixed(decimals) : text;
}

/** Returns the number a person typed, with a '.' or ',' decimal separator, or null when the text is no number. */
export function parseNumericText(text: string): number | null {
    const trimmedText = text.trim();
    if (!NUMERIC_TEXT_PATTERN.test(trimmedText)) {
        return null;
    }
    const value = Number(trimmedText.replace(',', '.'));
    return Number.isFinite(value) ? value : null;
}

/** Rounds a value to a precision, never to a negative zero. */
function roundToDecimals(value: number, decimals: number): number {
    const rounded = Number(value.toFixed(decimals));
    return rounded === 0 ? 0 : rounded;
}

/** Returns a value kept inside its bounds and rounded to its step's decimals; a value that is not a number becomes the minimum. */
export function clampNumericValue(value: number, bounds: NumericBounds): number {
    if (Number.isNaN(value)) {
        return bounds.minimum;
    }
    const clamped = Math.min(bounds.maximum, Math.max(bounds.minimum, value));
    const rounded = roundToDecimals(clamped, getStepDecimals(bounds.step));
    // Rounding may cross a bound that lies between two decimals of the step
    return Math.min(bounds.maximum, Math.max(bounds.minimum, rounded));
}

/** Returns a value moved by a count of steps and kept inside its bounds, summed in whole decimals so 0.1 + 0.2 stays 0.3. */
export function stepNumericValue(value: number, count: number, bounds: NumericBounds): number {
    const step = Number.isFinite(bounds.step) && bounds.step > 0 ? bounds.step : 0;
    const scale = 10 ** getStepDecimals(bounds.step);
    const scaledValue = Math.round(value * scale) + Math.round(count * step * scale);
    return clampNumericValue(scaledValue / scale, bounds);
}

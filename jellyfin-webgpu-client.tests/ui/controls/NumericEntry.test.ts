import { describe, expect, it } from 'vitest';

import {
    clampNumericValue,
    formatNumericValue,
    getStepDecimals,
    parseNumericText,
    stepNumericValue
} from 'addons/webGPUPlayer/ui/controls/NumericEntry';

describe('NumericEntry', () => {
    it('counts the decimals a step carries', () => {
        expect(getStepDecimals(1)).toBe(0);
        expect(getStepDecimals(10)).toBe(0);
        expect(getStepDecimals(0.1)).toBe(1);
        expect(getStepDecimals(0.01)).toBe(2);
        expect(getStepDecimals(0.25)).toBe(2);
        expect(getStepDecimals(1e-3)).toBe(3);
        expect(getStepDecimals(1e-7)).toBe(7);
        expect(getStepDecimals(0)).toBe(2);
        expect(getStepDecimals(-1)).toBe(2);
        expect(getStepDecimals(Number.NaN)).toBe(2);
        expect(getStepDecimals(Number.POSITIVE_INFINITY)).toBe(2);
    });

    it('formats a value with exactly its step\'s decimals and never a negative zero', () => {
        expect(formatNumericValue(1, 0.01)).toBe('1.00');
        expect(formatNumericValue(1000, 1)).toBe('1000');
        expect(formatNumericValue(-0.5, 0.1)).toBe('-0.5');
        expect(formatNumericValue(0.125, 0.25)).toBe('0.13');
        expect(formatNumericValue(-0.001, 0.01)).toBe('0.00');
        expect(formatNumericValue(-0, 1)).toBe('0');
        expect(formatNumericValue(Number.NaN, 1)).toBe('');
        expect(formatNumericValue(Number.POSITIVE_INFINITY, 1)).toBe('');
    });

    it('parses typed numbers with a point or comma decimal separator', () => {
        expect(parseNumericText('  12 ')).toBe(12);
        expect(parseNumericText('-3.5')).toBe(-3.5);
        expect(parseNumericText('+2')).toBe(2);
        expect(parseNumericText('1,25')).toBe(1.25);
        expect(parseNumericText('.5')).toBe(0.5);
        expect(parseNumericText(',5')).toBe(0.5);
        expect(parseNumericText('4.')).toBe(4);
        expect(parseNumericText('1e3')).toBe(1000);
        expect(parseNumericText('2.5E-1')).toBe(0.25);
    });

    it('rejects text that is no number', () => {
        for (const text of [ '', '   ', '-', '+', '.', 'abc', '1.2.3', '1,2,3', '1.2,3', '1e', 'e3', '12abc', 'Infinity', 'NaN', '0x10', '1 000', '1e400' ]) {
            expect(parseNumericText(text), text).toBeNull();
        }
    });

    it('clamps a value into its bounds at its step\'s precision', () => {
        const bounds = { maximum: 4000, minimum: 100, step: 1 };
        expect(clampNumericValue(5000, bounds)).toBe(4000);
        expect(clampNumericValue(12, bounds)).toBe(100);
        expect(clampNumericValue(250.6, bounds)).toBe(251);
        expect(clampNumericValue(Number.POSITIVE_INFINITY, bounds)).toBe(4000);
        expect(clampNumericValue(Number.NEGATIVE_INFINITY, bounds)).toBe(100);
        expect(clampNumericValue(Number.NaN, bounds)).toBe(100);

        const fineBounds = { maximum: 1, minimum: -1, step: 0.01 };
        expect(clampNumericValue(0.123456, fineBounds)).toBe(0.12);
        expect(Object.is(clampNumericValue(-0.001, fineBounds), 0)).toBe(true);
        // Rounds to the step's decimals, not to multiples of the step
        expect(clampNumericValue(0.3, { maximum: 1, minimum: 0, step: 0.25 })).toBe(0.3);
    });

    it('steps a value without floating-point drift and keeps it inside its bounds', () => {
        const bounds = { maximum: 1, minimum: 0, step: 0.1 };
        expect(stepNumericValue(0.1, 2, bounds)).toBe(0.3);
        expect(stepNumericValue(0.7, 1, bounds)).toBe(0.8);
        expect(stepNumericValue(0.3, -1, bounds)).toBe(0.2);
        expect(stepNumericValue(0.95, 1, bounds)).toBe(1);
        expect(stepNumericValue(0.05, -1, bounds)).toBe(0);

        let value = 0;
        for (let index = 0; index < 10; index += 1) {
            value = stepNumericValue(value, 1, { maximum: 10, minimum: -10, step: 0.01 });
        }
        expect(value).toBe(0.1);

        expect(stepNumericValue(1, -1, { maximum: 10, minimum: 1, step: 1 })).toBe(1);
        expect(stepNumericValue(-0.5, 10, { maximum: 16, minimum: -16, step: 0.1 })).toBe(0.5);
    });
});

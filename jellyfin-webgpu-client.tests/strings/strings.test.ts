import type { ImportGlobFunction } from 'vite/types/importGlob';
import { describe, expect, it } from 'vitest';

import sourceStrings from 'addons/webGPUPlayer/strings/en-us.json';
// The host's own dictionary, resolved from the Jellyfin Web checkout like every host module
import hostStrings from 'strings/en-us.json';

// The add-on's string files are what Weblate reads and writes: en-us.json is the source, every other file one translation

// NOTE: Vite types import.meta.glob in vite/client, which a reference directive cannot reach from this folder
declare global {
    interface ImportMeta {
        readonly glob: ImportGlobFunction
    }
}

const STRING_FILES = import.meta.glob<Record<string, unknown>>(
    'addons/webGPUPlayer/strings/*.json',
    { eager: true, import: 'default' }
);
const ADDON_SOURCE_FILES = import.meta.glob<string>(
    'addons/webGPUPlayer/**/*.{js,ts}',
    { eager: true, import: 'default', query: '?raw' }
);
const SOURCE_FILE_NAME = 'en-us.json';
// The loader requests the host's normalized locale names: lowercase BCP 47 with hyphens, such as de or pt-br
const LOCALE_FILE_NAME_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})*\.json$/;
const PLACEHOLDER_PATTERN = /\{\d+\}/g;
// Keys passed literally to globalize.translate
const TRANSLATE_CALL_PATTERN = /\btranslate\(\s*'([^']+)'/g;

function getFileName(filePath: string): string {
    return filePath.slice(filePath.lastIndexOf('/') + 1);
}

/** Returns a string's placeholders, sorted, so translations can reorder them. */
function getPlaceholders(text: string): string[] {
    return (text.match(PLACEHOLDER_PATTERN) ?? []).sort();
}

describe('add-on strings', () => {
    it('names every string file by a locale the loader can request', () => {
        const fileNames = Object.keys(STRING_FILES).map(getFileName);
        expect(fileNames).toContain(SOURCE_FILE_NAME);
        for (const fileName of fileNames) {
            expect(fileName).toMatch(LOCALE_FILE_NAME_PATTERN);
        }
    });

    it('keeps every string file a flat dictionary of strings', () => {
        for (const [ filePath, dictionary ] of Object.entries(STRING_FILES)) {
            for (const [ key, value ] of Object.entries(dictionary)) {
                expect(typeof value, `${getFileName(filePath)} ${key}`).toBe('string');
            }
        }
        for (const [ key, value ] of Object.entries(sourceStrings)) {
            expect(value.trim(), key).not.toBe('');
        }
    });

    it('translates only source keys and keeps each source placeholder', () => {
        const sourceDictionary: Readonly<Record<string, string>> = sourceStrings;
        for (const [ filePath, dictionary ] of Object.entries(STRING_FILES)) {
            const fileName = getFileName(filePath);
            if (fileName === SOURCE_FILE_NAME) {
                continue;
            }
            for (const [ key, value ] of Object.entries(dictionary)) {
                expect(Object.prototype.hasOwnProperty.call(sourceDictionary, key), `${fileName} ${key}`).toBe(true);
                // Untranslated strings may be empty; they fall back to the source
                if (typeof value === 'string' && value.length > 0) {
                    expect(getPlaceholders(value), `${fileName} ${key}`).toEqual(getPlaceholders(sourceDictionary[key]));
                }
            }
        }
    });

    it('defines every key the add-on translates, in its own strings or the host dictionary', () => {
        const knownKeys = new Set([ ...Object.keys(sourceStrings), ...Object.keys(hostStrings) ]);
        const missingKeys: string[] = [];
        for (const [ filePath, sourceText ] of Object.entries(ADDON_SOURCE_FILES)) {
            for (const match of sourceText.matchAll(TRANSLATE_CALL_PATTERN)) {
                if (!knownKeys.has(match[1])) {
                    missingKeys.push(`${getFileName(filePath)}: ${match[1]}`);
                }
            }
        }
        expect(missingKeys).toEqual([]);
    });

    it('uses every key of the add-on source strings', () => {
        const allSourceText = Object.values(ADDON_SOURCE_FILES).join('\n');
        const unusedKeys = Object.keys(sourceStrings).filter(key => !allSourceText.includes(`'${key}'`));
        expect(unusedKeys).toEqual([]);
    });
});

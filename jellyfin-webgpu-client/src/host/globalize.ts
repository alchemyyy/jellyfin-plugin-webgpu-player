import type HostGlobalize from 'lib/globalize';

import sourceStrings from '../strings/en-us.json';
import { importTranslationFile, type TranslationDictionary } from './translationFiles';

// Bridge for lib/globalize: the host dictionary filled from the plugin bag, plus the add-on's own strings.
// The add-on's keys are those of src/strings/en-us.json, translated in src/strings/<locale>.json files that Weblate writes.
// NOTE: The host loads dictionaries only from inside its own bundle, so the add-on loads its translations itself

type GlobalizeModule = typeof HostGlobalize;

/** A key of the add-on's own strings, for tables that name strings to translate later */
export type AddonStringKey = keyof typeof sourceStrings;

// The host's fallback culture; its file is the source every translation follows
const SOURCE_LOCALE = 'en-us';
const SOURCE_STRINGS: TranslationDictionary = sourceStrings;
const TEMPLATE_KEY_PREFIX = '${';
const TEMPLATE_KEY_SUFFIX = '}';

let globalize: GlobalizeModule;
// Loaded translations by normalized locale; a locale without a file holds an empty dictionary
const translations = new Map<string, TranslationDictionary>();
const pendingTranslations = new Map<string, Promise<void>>();

/** Returns the host's current locale normalized like its own dictionary names, such as pt-br. */
function getLocale(): string {
    // Unbound until construction, so code evaluated earlier sees the source locale
    const locale: unknown = (globalize as GlobalizeModule | undefined)?.getCurrentLocale();
    return typeof locale === 'string' && locale.length > 0 ?
        locale.replace(/_/g, '-').toLowerCase() :
        SOURCE_LOCALE;
}

/** Loads a locale's translation: its own file, else its base language's file, as the host's loader does. */
function loadTranslation(locale: string): Promise<void> {
    const pendingTranslation = pendingTranslations.get(locale);
    if (pendingTranslation) {
        return pendingTranslation;
    }
    const baseLanguage = locale.replace(/-.*/, '');
    const translation = importTranslationFile(locale)
        .then((dictionary: TranslationDictionary | null): Promise<TranslationDictionary | null> | TranslationDictionary | null => (
            dictionary === null && baseLanguage !== locale ? importTranslationFile(baseLanguage) : dictionary
        ))
        .then((dictionary: TranslationDictionary | null): void => {
            translations.set(locale, dictionary ?? {});
        });
    pendingTranslations.set(locale, translation);
    return translation;
}

/** Loads the add-on's strings for the host's current locale; translate uses the source strings until they arrive. */
export function loadAddonStrings(): Promise<void> {
    const locale = getLocale();
    return locale === SOURCE_LOCALE ? Promise.resolve() : loadTranslation(locale);
}

/** Binds the host's globalize module from the plugin bag, and starts loading the current locale's strings. */
export function bindGlobalize(value: GlobalizeModule): void {
    globalize = value;
    void loadAddonStrings();
}

/** Returns an add-on string in the current locale, else its source text; undefined for keys the add-on does not own. */
function getAddonString(key: string): string | undefined {
    if (!Object.prototype.hasOwnProperty.call(SOURCE_STRINGS, key)) {
        return undefined;
    }
    const locale = getLocale();
    if (locale !== SOURCE_LOCALE) {
        const translation = translations.get(locale);
        if (!translation) {
            // A locale seen for the first time, such as after a language change, loads now and applies to later calls
            void loadTranslation(locale);
        } else if (Object.prototype.hasOwnProperty.call(translation, key) && translation[key]) {
            // Untranslated keys are absent or empty and fall back to the source, as in the host
            return translation[key];
        }
    }
    return SOURCE_STRINGS[key];
}

/** Replaces {0}, {1}, ... the same way as the host's translate. */
function formatAddonString(value: string, replacements: readonly unknown[]): string {
    let formatted = value;
    const locale = globalize.getCurrentLocale();
    for (let index = 0; index < replacements.length; index += 1) {
        const replacement = replacements[index] as { toLocaleString: (locales?: string) => string };
        formatted = formatted.split(`{${index}}`).join(replacement.toLocaleString(locale));
    }
    return formatted;
}

/** Translates a key from the add-on strings, falling back to the host dictionary. */
export function translate(key: string, ...replacements: unknown[]): string {
    const addonString = getAddonString(key);
    if (addonString === undefined) {
        return globalize.translate(key, ...replacements);
    }
    return formatAddonString(addonString, replacements);
}

/** Expands add-on keys in a template, then lets the host expand its own keys. */
export function translateHtml(html: string | { default: string }, module?: string): string {
    let expanded = typeof html === 'string' ? html : html.default;
    for (const key of Object.keys(SOURCE_STRINGS)) {
        const placeholder = `${TEMPLATE_KEY_PREFIX}${key}${TEMPLATE_KEY_SUFFIX}`;
        if (expanded.includes(placeholder)) {
            expanded = expanded.split(placeholder).join(getAddonString(key) ?? '');
        }
    }
    return globalize.translateHtml(expanded, module);
}

export function loadStrings(
    ...parameters: Parameters<GlobalizeModule['loadStrings']>
): ReturnType<GlobalizeModule['loadStrings']> {
    return globalize.loadStrings(...parameters);
}

export function defaultModule(
    ...parameters: Parameters<GlobalizeModule['defaultModule']>
): ReturnType<GlobalizeModule['defaultModule']> {
    return globalize.defaultModule(...parameters);
}

export function getCurrentLocale(): ReturnType<GlobalizeModule['getCurrentLocale']> {
    return globalize.getCurrentLocale();
}

export function getCurrentDateTimeLocale(): ReturnType<GlobalizeModule['getCurrentDateTimeLocale']> {
    return globalize.getCurrentDateTimeLocale();
}

export function register(
    ...parameters: Parameters<GlobalizeModule['register']>
): ReturnType<GlobalizeModule['register']> {
    return globalize.register(...parameters);
}

export function updateCurrentCulture(): ReturnType<GlobalizeModule['updateCurrentCulture']> {
    return globalize.updateCurrentCulture();
}

export function getIsRTL(): ReturnType<GlobalizeModule['getIsRTL']> {
    return globalize.getIsRTL();
}

export function getIsElementRTL(
    ...parameters: Parameters<GlobalizeModule['getIsElementRTL']>
): ReturnType<GlobalizeModule['getIsElementRTL']> {
    return globalize.getIsElementRTL(...parameters);
}

export default {
    translate,
    translateHtml,
    loadStrings,
    defaultModule,
    getCurrentLocale,
    getCurrentDateTimeLocale,
    register,
    updateCurrentCulture,
    getIsRTL,
    getIsElementRTL
};

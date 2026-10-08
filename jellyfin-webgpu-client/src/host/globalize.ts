import type HostGlobalize from 'lib/globalize';

import privateStrings from '../strings/en-us.json';

// Bridge for lib/globalize: the host dictionary filled from the plugin bag, plus the add-on's own strings
// NOTE: The host cannot load dictionaries from outside its bundle, so the fork's new keys live here

type GlobalizeModule = typeof HostGlobalize;

const PRIVATE_STRINGS: Readonly<Record<string, string>> = privateStrings;
const TEMPLATE_KEY_PREFIX = '${';
const TEMPLATE_KEY_SUFFIX = '}';

let globalize: GlobalizeModule;

/** Binds the host's globalize module from the plugin bag. */
export function bindGlobalize(value: GlobalizeModule): void {
    globalize = value;
}

function getPrivateString(key: string): string | undefined {
    return Object.prototype.hasOwnProperty.call(PRIVATE_STRINGS, key) ? PRIVATE_STRINGS[key] : undefined;
}

/** Replaces {0}, {1}, ... the same way as the host's translate. */
function formatPrivateString(value: string, replacements: readonly unknown[]): string {
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
    const privateString = getPrivateString(key);
    if (privateString === undefined) {
        return globalize.translate(key, ...replacements);
    }
    return formatPrivateString(privateString, replacements);
}

/** Expands add-on keys in a template, then lets the host expand its own keys. */
export function translateHtml(html: string | { default: string }, module?: string): string {
    let expanded = typeof html === 'string' ? html : html.default;
    for (const key of Object.keys(PRIVATE_STRINGS)) {
        expanded = expanded.split(`${TEMPLATE_KEY_PREFIX}${key}${TEMPLATE_KEY_SUFFIX}`).join(PRIVATE_STRINGS[key]);
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

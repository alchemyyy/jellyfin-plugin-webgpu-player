// The add-on's translation files, src/strings/<locale>.json, each imported as its own lazy chunk.
// NOTE: en-us.json is the source the globalize bridge bundles statically, so this import excludes it

/** One translation file: string keys of en-us.json mapped to translated text */
export type TranslationDictionary = Readonly<Record<string, string>>;

/** Imports the translation file of a normalized locale such as de or pt-br, resolving null when there is none. */
export function importTranslationFile(locale: string): Promise<TranslationDictionary | null> {
    return import(
        /* webpackChunkName: "strings-[request]" */
        /* webpackExclude: /en-us\.json$/ */
        `../strings/${locale}.json`
    ).then(
        (translationModule: { default: TranslationDictionary }): TranslationDictionary => translationModule.default,
        (): null => null
    );
}

import sourceStrings from 'addons/webGPUPlayer/strings/en-us.json';

// A lib/globalize stand-in for suites that render add-on text: the add-on's source strings with {0}-style arguments
// substituted, and every other key returned unchanged, as the host returns a key it cannot find

const SOURCE_STRINGS: Readonly<Record<string, string>> = sourceStrings;

/** Translates a key the way the add-on does in its source locale. */
export function translateSourceString(key: string, ...replacements: unknown[]): string {
    let text = Object.prototype.hasOwnProperty.call(SOURCE_STRINGS, key) ? SOURCE_STRINGS[key] : key;
    for (let index = 0; index < replacements.length; index += 1) {
        text = text.split(`{${index}}`).join(String(replacements[index]));
    }
    return text;
}

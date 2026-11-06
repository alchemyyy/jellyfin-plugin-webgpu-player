import browser from 'scripts/browser';

// The bridge the build substitutes for components/apphost, imported as itself so the settings that read the timing do not load the host's appHost module
import { appHost } from './host/appHost';

// When the engine's capability probes, the decoder tests, run on this client: in the background after the page loads, or only at the start of a playback.
// A user's setting picks one, or `automatic` leaves it to the administrator's rules, then to the administrator's background device types.
// Rules match the values Jellyfin shows under Dashboard > Devices with wildcard patterns, so no text an administrator writes becomes a regular expression

export const DECODER_TEST_TIMINGS = Object.freeze([ 'automatic', 'background', 'playback' ] as const);
export type DecoderTestTiming = typeof DECODER_TEST_TIMINGS[number];
export const DEFAULT_DECODER_TEST_TIMING: DecoderTestTiming = 'automatic';

export const DECODER_TEST_DEVICE_TYPES = Object.freeze([ 'desktop', 'mobile', 'tv' ] as const);
export type DecoderTestDeviceType = typeof DECODER_TEST_DEVICE_TYPES[number];
export const DEFAULT_DECODER_TEST_BACKGROUND_DEVICES: readonly DecoderTestDeviceType[] = Object.freeze([ 'desktop' ] as const);

/** The characters the rules text holds at most. */
export const MAXIMUM_DECODER_TEST_RULES_LENGTH = 4_096;
/** The rules the text holds at most; a valid rule past them is a problem. */
export const MAXIMUM_DECODER_TEST_RULE_COUNT = 64;

export type DecoderTestRuleField = 'client' | 'device' | 'version' | 'ua';

/** A rule as parsed: where the tests run when its pattern matches its field, and its 1-based line in the text. */
export type DecoderTestRule = Readonly<{ field: DecoderTestRuleField, line: number, pattern: string, timing: 'background' | 'playback' }>;

/** A line that is no rule: its 1-based number, and what is wrong with it. */
export type DecoderTestRuleProblem = Readonly<{ line: number, reason: 'syntax' | 'timing' | 'field' | 'pattern' | 'too-many' }>;

/** The values rules match and the device type, for this page. */
export type DecoderTestClient = Readonly<{ client: string, device: string, deviceType: DecoderTestDeviceType, userAgent: string, version: string }>;

/** Why a client runs its tests where it does. */
export type DecoderTestDecision = Readonly<{ reason: 'setting' | 'rule' | 'device-type', ruleLine?: number, timing: 'background' | 'playback' }>;

const RULE_TIMINGS: readonly DecoderTestRule['timing'][] = [ 'background', 'playback' ];
const RULE_FIELDS: readonly DecoderTestRuleField[] = [ 'client', 'device', 'version', 'ua' ];
const COMMENT_PREFIX = '#';
const LINE_BREAK_PATTERN = /\r\n|\r|\n/;
// `<timing> <field>: <pattern>`, the pattern being the rest of the line; applied to the administrator's text, never built from it
const RULE_PATTERN = /^(\S+)\s+([^\s:]+)\s*:(.*)$/;
const ANY_RUN = '*';
const ANY_CHARACTER = '?';

function isRuleTiming(value: string): value is DecoderTestRule['timing'] {
    return RULE_TIMINGS.some((timing: string): boolean => timing === value);
}

function isRuleField(value: string): value is DecoderTestRuleField {
    return RULE_FIELDS.some((field: string): boolean => field === value);
}

/** Parses rules text; text longer than the maximum is the caller's to refuse. */
export function parseDecoderTestRules(text: string): Readonly<{ problems: readonly DecoderTestRuleProblem[], rules: readonly DecoderTestRule[] }> {
    const problems: DecoderTestRuleProblem[] = [];
    const rules: DecoderTestRule[] = [];
    for (const [ index, rawLine ] of text.split(LINE_BREAK_PATTERN).entries()) {
        const line = index + 1;
        const trimmedLine = rawLine.trim();
        if (trimmedLine.length === 0 || trimmedLine.startsWith(COMMENT_PREFIX)) {
            continue;
        }
        const match = RULE_PATTERN.exec(trimmedLine);
        if (match === null) {
            problems.push({ line, reason: 'syntax' });
            continue;
        }
        const timing = match[1].toLowerCase();
        const field = match[2].toLowerCase();
        const pattern = match[3].trim();
        if (!isRuleTiming(timing)) {
            problems.push({ line, reason: 'timing' });
        } else if (!isRuleField(field)) {
            problems.push({ line, reason: 'field' });
        } else if (pattern.length === 0) {
            problems.push({ line, reason: 'pattern' });
        } else if (rules.length >= MAXIMUM_DECODER_TEST_RULE_COUNT) {
            problems.push({ line, reason: 'too-many' });
        } else {
            rules.push(Object.freeze({ field, line, pattern, timing }));
        }
    }
    return Object.freeze({ problems: Object.freeze(problems), rules: Object.freeze(rules) });
}

/**
 * Returns whether a pattern matches a whole value, ignoring case: `*` matches any run of characters, `?` exactly one, and every other character itself.
 * Matches greedily and backtracks only to the last `*`, so the time stays within the product of the lengths.
 */
export function matchesDecoderTestPattern(pattern: string, value: string): boolean {
    const patternText = pattern.toLowerCase();
    const valueText = value.toLowerCase();
    let patternIndex = 0;
    let valueIndex = 0;
    // Where the last `*` stands in the pattern, and where the value resumes when its run takes one more character
    let starIndex = -1;
    let starValueIndex = 0;
    while (valueIndex < valueText.length) {
        const patternCharacter = patternText[patternIndex];
        if (patternCharacter === ANY_RUN) {
            starIndex = patternIndex;
            starValueIndex = valueIndex;
            patternIndex += 1;
        } else if (patternIndex < patternText.length && (patternCharacter === ANY_CHARACTER || patternCharacter === valueText[valueIndex])) {
            patternIndex += 1;
            valueIndex += 1;
        } else if (starIndex >= 0) {
            patternIndex = starIndex + 1;
            starValueIndex += 1;
            valueIndex = starValueIndex;
        } else {
            return false;
        }
    }
    while (patternText[patternIndex] === ANY_RUN) {
        patternIndex += 1;
    }
    return patternIndex === patternText.length;
}

/** Returns a known timing, or null for any other value. */
export function normalizeDecoderTestTiming(value: unknown): DecoderTestTiming | null {
    return DECODER_TEST_TIMINGS.find((timing: DecoderTestTiming): boolean => timing === value) ?? null;
}

/** Returns distinct known device types in their listed order, or null for a value that is no array of them; an empty array names none. */
export function normalizeDecoderTestBackgroundDevices(value: unknown): readonly DecoderTestDeviceType[] | null {
    if (!Array.isArray(value)) {
        return null;
    }
    const entries = value as unknown[];
    const isKnownAndDistinct = entries.every((entry: unknown, index: number): boolean =>
        DECODER_TEST_DEVICE_TYPES.some((deviceType: DecoderTestDeviceType): boolean => deviceType === entry)
        && entries.indexOf(entry) === index);
    if (!isKnownAndDistinct) {
        return null;
    }
    return Object.freeze(DECODER_TEST_DEVICE_TYPES.filter((deviceType: DecoderTestDeviceType): boolean => entries.includes(deviceType)));
}

/** Returns rules text within the length limit, or null for any other value; its lines are not checked. */
export function normalizeDecoderTestRules(value: unknown): string | null {
    return typeof value === 'string' && value.length <= MAXIMUM_DECODER_TEST_RULES_LENGTH ? value : null;
}

/** Reads one of the host's values for this client, or empty text when the host has none. */
function readHostValue(read: () => unknown): string {
    try {
        const value = read();
        return typeof value === 'string' ? value : '';
    } catch {
        return '';
    }
}

/** Classifies this client as Jellyfin Web's browser detection sees it; a TV or console comes before a phone or tablet. */
function getDeviceType(): DecoderTestDeviceType {
    // The detection sets a flag per platform it finds, android among them, though its typings omit that one
    const flags: Readonly<{ android?: boolean, iOS: boolean, ipad: boolean, mobile: boolean, ps4: boolean, tizen: boolean, tv: boolean, web0s: boolean, xboxOne: boolean }> = browser;
    if (flags.tv || flags.xboxOne || flags.ps4 || flags.tizen || flags.web0s) {
        return 'tv';
    }
    if (flags.mobile || flags.iOS || flags.ipad || flags.android === true) {
        return 'mobile';
    }
    return 'desktop';
}

/** Returns the values rules match, as Jellyfin's authorization header sends them, and the device type, for this page. */
export function describeDecoderTestClient(): DecoderTestClient {
    return {
        client: readHostValue((): unknown => appHost.appName()),
        device: readHostValue((): unknown => appHost.deviceName()),
        deviceType: getDeviceType(),
        userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
        version: readHostValue((): unknown => appHost.appVersion())
    };
}

function getRuleFieldValue(client: DecoderTestClient, field: DecoderTestRuleField): string {
    switch (field) {
        case 'client':
            return client.client;
        case 'device':
            return client.device;
        case 'version':
            return client.version;
        case 'ua':
            return client.userAgent;
    }
}

/** Decides where the tests run: the setting unless `automatic`, then the first rule that matches, then whether the device type runs them in the background. */
export function resolveDecoderTestTiming(
    timing: DecoderTestTiming,
    client: DecoderTestClient,
    backgroundDevices: readonly DecoderTestDeviceType[],
    rules: readonly DecoderTestRule[]
): DecoderTestDecision {
    if (timing !== 'automatic') {
        return { reason: 'setting', timing };
    }
    const matchingRule = rules.find((rule: DecoderTestRule): boolean => matchesDecoderTestPattern(rule.pattern, getRuleFieldValue(client, rule.field)));
    if (matchingRule !== undefined) {
        return { reason: 'rule', ruleLine: matchingRule.line, timing: matchingRule.timing };
    }
    return { reason: 'device-type', timing: backgroundDevices.includes(client.deviceType) ? 'background' : 'playback' };
}

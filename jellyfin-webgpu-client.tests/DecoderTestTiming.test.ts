import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
    browser: {} as Record<string, boolean>,
    host: {} as Record<'appName' | 'appVersion' | 'deviceName', () => unknown>
}));

// The device type reads the host's browser detection, and the rules' values the host's appHost through the add-on's bridge
vi.mock('scripts/browser', () => ({
    default: new Proxy({}, { get: (_target: object, flag: string): boolean => testState.browser[flag] === true })
}));
vi.mock('addons/webGPUPlayer/host/appHost', () => ({
    appHost: {
        appName: (): unknown => testState.host.appName(),
        appVersion: (): unknown => testState.host.appVersion(),
        deviceName: (): unknown => testState.host.deviceName()
    }
}));

import {
    DECODER_TEST_DEVICE_TYPES,
    DECODER_TEST_TIMINGS,
    DEFAULT_DECODER_TEST_BACKGROUND_DEVICES,
    DEFAULT_DECODER_TEST_TIMING,
    MAXIMUM_DECODER_TEST_RULE_COUNT,
    MAXIMUM_DECODER_TEST_RULES_LENGTH,
    describeDecoderTestClient,
    matchesDecoderTestPattern,
    normalizeDecoderTestBackgroundDevices,
    normalizeDecoderTestRules,
    normalizeDecoderTestTiming,
    parseDecoderTestRules,
    resolveDecoderTestTiming,
    type DecoderTestClient,
    type DecoderTestRule
} from 'addons/webGPUPlayer/DecoderTestTiming';

const DESKTOP_CLIENT: DecoderTestClient = {
    client: 'Jellyfin Web',
    device: 'Firefox',
    deviceType: 'desktop',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
    version: '10.11.0'
};

function parseRules(text: string): readonly DecoderTestRule[] {
    const { problems, rules } = parseDecoderTestRules(text);
    expect(problems).toEqual([]);
    return rules;
}

describe('decoder test timing values', () => {
    it('lists the timings and device types, with their built-in defaults and limits', () => {
        expect(DECODER_TEST_TIMINGS).toEqual([ 'automatic', 'background', 'playback' ]);
        expect(DEFAULT_DECODER_TEST_TIMING).toBe('automatic');
        expect(DECODER_TEST_DEVICE_TYPES).toEqual([ 'desktop', 'mobile', 'tv' ]);
        expect(DEFAULT_DECODER_TEST_BACKGROUND_DEVICES).toEqual([ 'desktop' ]);
        expect(MAXIMUM_DECODER_TEST_RULES_LENGTH).toBe(4_096);
        expect(MAXIMUM_DECODER_TEST_RULE_COUNT).toBe(64);
    });

    it('keeps only a known timing', () => {
        expect(DECODER_TEST_TIMINGS.map(normalizeDecoderTestTiming)).toEqual(DECODER_TEST_TIMINGS);
        for (const refused of [ 'Background', 'always', '', null, undefined, 1, true, [ 'playback' ] ]) {
            expect(normalizeDecoderTestTiming(refused)).toBeNull();
        }
    });

    it('keeps distinct known device types in their listed order, an empty list among them', () => {
        expect(normalizeDecoderTestBackgroundDevices([ 'tv', 'desktop' ])).toEqual([ 'desktop', 'tv' ]);
        expect(normalizeDecoderTestBackgroundDevices([ 'mobile', 'tv', 'desktop' ])).toEqual([ 'desktop', 'mobile', 'tv' ]);
        expect(normalizeDecoderTestBackgroundDevices([])).toEqual([]);
        for (const refused of [ null, 'desktop', { desktop: true }, [ 'phone' ], [ 'Desktop' ], [ 'desktop', 'desktop' ], [ 'desktop', 1 ] ]) {
            expect(normalizeDecoderTestBackgroundDevices(refused)).toBeNull();
        }
    });

    it('keeps rules text within the length limit, whatever its lines hold', () => {
        const longest = '#'.repeat(MAXIMUM_DECODER_TEST_RULES_LENGTH);
        expect(normalizeDecoderTestRules('')).toBe('');
        expect(normalizeDecoderTestRules('not a rule')).toBe('not a rule');
        expect(normalizeDecoderTestRules(longest)).toBe(longest);
        for (const refused of [ `${longest}#`, null, 1, [ 'playback ua: *' ], { text: '' } ]) {
            expect(normalizeDecoderTestRules(refused)).toBeNull();
        }
    });
});

describe('parseDecoderTestRules', () => {
    it('reads one rule per line, skipping blank lines and comments, with each rule\'s line', () => {
        const { problems, rules } = parseDecoderTestRules([
            '# Phones that only control playback elsewhere',
            '',
            '   ',
            'playback device: *iPhone*',
            '  # an indented comment',
            'background client: Jellyfin Media Player',
            'playback ua: * # literal'
        ].join('\r\n'));

        expect(problems).toEqual([]);
        expect(rules).toEqual([
            { field: 'device', line: 4, pattern: '*iPhone*', timing: 'playback' },
            { field: 'client', line: 6, pattern: 'Jellyfin Media Player', timing: 'background' },
            { field: 'ua', line: 7, pattern: '* # literal', timing: 'playback' }
        ]);
    });

    it('reads keywords in any case and any spacing around the colon, and trims the pattern', () => {
        expect(parseRules([
            'PLAYBACK Device:iPad',
            'Background   VERSION   :   10.*   ',
            'playback\tua :\tMozilla*'
        ].join('\n'))).toEqual([
            { field: 'device', line: 1, pattern: 'iPad', timing: 'playback' },
            { field: 'version', line: 2, pattern: '10.*', timing: 'background' },
            { field: 'ua', line: 3, pattern: 'Mozilla*', timing: 'playback' }
        ]);
        // Line breaks of every kind count lines
        expect(parseRules('playback ua: a\rplayback ua: b\nplayback ua: c').map((rule: DecoderTestRule): number => rule.line)).toEqual([ 1, 2, 3 ]);
    });

    it('names each line that is no rule, by its line and what is wrong with it', () => {
        const { problems, rules } = parseDecoderTestRules([
            'playback',
            'playback client Jellyfin Web',
            'background: *',
            'automatic client: *',
            'never client: *',
            'playback user agent: *',
            'playback platform: *',
            'playback client:',
            'playback client:    ',
            'background client: *'
        ].join('\n'));

        expect(problems).toEqual([
            { line: 1, reason: 'syntax' },
            { line: 2, reason: 'syntax' },
            { line: 3, reason: 'syntax' },
            { line: 4, reason: 'timing' },
            { line: 5, reason: 'timing' },
            { line: 6, reason: 'syntax' },
            { line: 7, reason: 'field' },
            { line: 8, reason: 'pattern' },
            { line: 9, reason: 'pattern' }
        ]);
        expect(rules).toEqual([ { field: 'client', line: 10, pattern: '*', timing: 'background' } ]);
    });

    it('keeps the first rules up to the limit and names each later one', () => {
        const lines = Array.from({ length: MAXIMUM_DECODER_TEST_RULE_COUNT + 2 }, (_value: unknown, index: number): string => `playback device: device ${index}`);
        // An invalid line or a comment does not count against the limit
        lines.splice(1, 0, '# comment', 'not a rule');

        const { problems, rules } = parseDecoderTestRules(lines.join('\n'));

        expect(rules).toHaveLength(MAXIMUM_DECODER_TEST_RULE_COUNT);
        expect(rules[MAXIMUM_DECODER_TEST_RULE_COUNT - 1].line).toBe(MAXIMUM_DECODER_TEST_RULE_COUNT + 2);
        expect(problems).toEqual([
            { line: 3, reason: 'syntax' },
            { line: MAXIMUM_DECODER_TEST_RULE_COUNT + 3, reason: 'too-many' },
            { line: MAXIMUM_DECODER_TEST_RULE_COUNT + 4, reason: 'too-many' }
        ]);
    });
});

describe('matchesDecoderTestPattern', () => {
    it('matches a whole value, ignoring case', () => {
        expect(matchesDecoderTestPattern('Jellyfin Web', 'jellyfin web')).toBe(true);
        expect(matchesDecoderTestPattern('JELLYFIN WEB', 'Jellyfin Web')).toBe(true);
        expect(matchesDecoderTestPattern('Jellyfin', 'Jellyfin Web')).toBe(false);
        expect(matchesDecoderTestPattern('Web', 'Jellyfin Web')).toBe(false);
        expect(matchesDecoderTestPattern('Jellyfin Web', 'Jellyfin Web ')).toBe(false);
    });

    it('matches any run of characters with *, none included', () => {
        expect(matchesDecoderTestPattern('*', '')).toBe(true);
        expect(matchesDecoderTestPattern('*', 'anything')).toBe(true);
        expect(matchesDecoderTestPattern('*iPhone*', 'Firefox iPhone')).toBe(true);
        expect(matchesDecoderTestPattern('*iPhone*', 'iPhone')).toBe(true);
        expect(matchesDecoderTestPattern('Jellyfin*', 'Jellyfin')).toBe(true);
        expect(matchesDecoderTestPattern('*a*b*c', 'xaxbxbxc')).toBe(true);
        expect(matchesDecoderTestPattern('*a*b*c', 'xaxbxbxcx')).toBe(false);
        expect(matchesDecoderTestPattern('a**b', 'ab')).toBe(true);
        expect(matchesDecoderTestPattern('*iPad', 'iPad Safari')).toBe(false);
    });

    it('matches exactly one character with ?', () => {
        expect(matchesDecoderTestPattern('10.1?.0', '10.11.0')).toBe(true);
        expect(matchesDecoderTestPattern('10.1?.0', '10.1.0')).toBe(false);
        expect(matchesDecoderTestPattern('10.1?.0', '10.111.0')).toBe(false);
        expect(matchesDecoderTestPattern('?', '')).toBe(false);
        expect(matchesDecoderTestPattern('?*', 'a')).toBe(true);
    });

    it('takes every other character literally, regular expression syntax included', () => {
        expect(matchesDecoderTestPattern('10.11.0', '10x11y0')).toBe(false);
        expect(matchesDecoderTestPattern('10.11.0', '10.11.0')).toBe(true);
        expect(matchesDecoderTestPattern('Firefox (iPhone)', 'Firefox (iPhone)')).toBe(true);
        expect(matchesDecoderTestPattern('(iPhone', '(iPhone')).toBe(true);
        expect(matchesDecoderTestPattern('a+', 'aa')).toBe(false);
        expect(matchesDecoderTestPattern('a+', 'a+')).toBe(true);
        expect(matchesDecoderTestPattern('[ab]', 'a')).toBe(false);
        expect(matchesDecoderTestPattern('^a$|b', '^a$|b')).toBe(true);
        expect(matchesDecoderTestPattern('.*', 'anything')).toBe(false);
        expect(matchesDecoderTestPattern('\\d', '\\d')).toBe(true);
    });
});

describe('describeDecoderTestClient', () => {
    beforeEach(() => {
        testState.browser = {};
        testState.host = {
            appName: (): string => 'Jellyfin Media Player',
            appVersion: (): string => '1.12.0',
            deviceName: (): string => 'Living room PC'
        };
    });

    it('takes the host\'s app values as Jellyfin sends them, and the user agent', () => {
        expect(describeDecoderTestClient()).toEqual({
            client: 'Jellyfin Media Player',
            device: 'Living room PC',
            deviceType: 'desktop',
            userAgent: navigator.userAgent,
            version: '1.12.0'
        });
    });

    it('reads empty values where the host has none or fails to answer', () => {
        testState.host = {
            appName: (): unknown => undefined,
            appVersion: (): string => {
                throw new TypeError('NativeShell is gone');
            },
            deviceName: (): unknown => 7
        };

        expect(describeDecoderTestClient()).toMatchObject({ client: '', device: '', version: '' });
    });

    it('classifies TVs and consoles first, then phones and tablets, and anything else as a desktop', () => {
        const classify = (flags: Record<string, boolean>): string => {
            testState.browser = flags;
            return describeDecoderTestClient().deviceType;
        };

        for (const flag of [ 'tv', 'xboxOne', 'ps4', 'tizen', 'web0s' ]) {
            expect(classify({ [flag]: true }), flag).toBe('tv');
        }
        // An Android TV reports as a TV and as Android
        expect(classify({ android: true, mobile: true, tv: true })).toBe('tv');
        for (const flag of [ 'mobile', 'iOS', 'ipad', 'android' ]) {
            expect(classify({ [flag]: true }), flag).toBe('mobile');
        }
        // An iPad that asks for the desktop site reports as a Mac with touch, which the detection marks as an iPad
        expect(classify({ ipad: true, osx: true, safari: true })).toBe('mobile');
        expect(classify({ chrome: true, osx: true })).toBe('desktop');
        expect(classify({})).toBe('desktop');
    });
});

describe('resolveDecoderTestTiming', () => {
    const rules = parseRules([
        'playback device: firefox',
        'background client: jellyfin web',
        'background version: 10.*'
    ].join('\n'));

    it('follows a background or playback setting whatever the rules and device types say', () => {
        expect(resolveDecoderTestTiming('background', DESKTOP_CLIENT, [], rules)).toEqual({ reason: 'setting', timing: 'background' });
        expect(resolveDecoderTestTiming('playback', DESKTOP_CLIENT, [ 'desktop' ], [])).toEqual({ reason: 'setting', timing: 'playback' });
    });

    it('lets the first matching rule decide under automatic', () => {
        expect(resolveDecoderTestTiming('automatic', DESKTOP_CLIENT, [ 'desktop' ], rules)).toEqual({ reason: 'rule', ruleLine: 1, timing: 'playback' });
        expect(resolveDecoderTestTiming('automatic', { ...DESKTOP_CLIENT, device: 'Chrome' }, [], rules))
            .toEqual({ reason: 'rule', ruleLine: 2, timing: 'background' });
        expect(resolveDecoderTestTiming('automatic', { ...DESKTOP_CLIENT, device: 'Chrome', client: 'Jellyfin Android' }, [], rules))
            .toEqual({ reason: 'rule', ruleLine: 3, timing: 'background' });
        expect(resolveDecoderTestTiming('automatic', DESKTOP_CLIENT, [], parseRules('playback ua: *Firefox/140.0')))
            .toEqual({ reason: 'rule', ruleLine: 1, timing: 'playback' });
    });

    it('falls to the device types when no rule matches', () => {
        const otherClient: DecoderTestClient = { ...DESKTOP_CLIENT, client: 'Jellyfin Android', device: 'Pixel', deviceType: 'mobile', version: '2.6' };

        expect(resolveDecoderTestTiming('automatic', otherClient, [ 'desktop' ], rules)).toEqual({ reason: 'device-type', timing: 'playback' });
        expect(resolveDecoderTestTiming('automatic', otherClient, [ 'mobile', 'tv' ], rules)).toEqual({ reason: 'device-type', timing: 'background' });
        expect(resolveDecoderTestTiming('automatic', DESKTOP_CLIENT, DEFAULT_DECODER_TEST_BACKGROUND_DEVICES, []))
            .toEqual({ reason: 'device-type', timing: 'background' });
        expect(resolveDecoderTestTiming('automatic', DESKTOP_CLIENT, [], [])).toEqual({ reason: 'device-type', timing: 'playback' });
    });
});

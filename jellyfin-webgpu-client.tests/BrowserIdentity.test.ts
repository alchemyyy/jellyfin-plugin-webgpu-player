import { describe, expect, it } from 'vitest';

import {
    BROWSER_GUIDES,
    detectBrowserIdentity,
    getGuideBrowser,
    GUIDE_BROWSER_IDS,
    type BrowserEnvironment,
    type BrowserIdentity
} from 'addons/webGPUPlayer/BrowserIdentity';

const WINDOWS_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const LINUX_CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const CHROMEOS_CHROME = 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const WINDOWS_FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0';
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const CHROME_BRANDS = [ 'Chromium', 'Google Chrome', 'Not?A_Brand' ];

function createEnvironment(userAgent: string, overrides: Partial<BrowserEnvironment> = {}): BrowserEnvironment {
    return { brands: null, hasBraveApi: false, maxTouchPoints: 0, platform: '', userAgent, ...overrides };
}

describe('detectBrowserIdentity', () => {
    it.each<[ string, BrowserEnvironment, BrowserIdentity ]>([
        [ 'Chrome on Windows', createEnvironment(WINDOWS_CHROME, { brands: CHROME_BRANDS, platform: 'Windows' }), { browser: 'chrome', family: 'chromium', majorVersion: 141, os: 'windows' } ],
        [ 'Chrome on macOS', createEnvironment(MAC_CHROME), { browser: 'chrome', family: 'chromium', majorVersion: 141, os: 'macos' } ],
        [ 'Chrome on Linux', createEnvironment(LINUX_CHROME), { browser: 'chrome', family: 'chromium', majorVersion: 141, os: 'linux' } ],
        [ 'Chrome on Android', createEnvironment(ANDROID_CHROME), { browser: 'chrome', family: 'chromium', majorVersion: 141, os: 'android' } ],
        [ 'Chrome on ChromeOS', createEnvironment(CHROMEOS_CHROME), { browser: 'chrome', family: 'chromium', majorVersion: 141, os: 'chromeos' } ],
        [
            'Edge',
            createEnvironment(`${WINDOWS_CHROME} Edg/141.0.0.0`, { brands: [ 'Microsoft Edge', 'Chromium' ] }),
            { browser: 'edge', family: 'chromium', majorVersion: 141, os: 'windows' }
        ],
        [ 'Edge on Android', createEnvironment(`${ANDROID_CHROME} EdgA/141.0.0.0`), { browser: 'edge', family: 'chromium', majorVersion: 141, os: 'android' } ],
        // Opera's own version differs from its Chromium's, which decides WebGPU
        [
            'Opera',
            createEnvironment(WINDOWS_CHROME.replace('Chrome/141', 'Chrome/140') + ' OPR/124.0.0.0'),
            { browser: 'opera', family: 'chromium', majorVersion: 140, os: 'windows' }
        ],
        [ 'Opera GX by brand', createEnvironment(WINDOWS_CHROME, { brands: [ 'Opera GX', 'Chromium' ] }), { browser: 'opera', family: 'chromium', majorVersion: 141, os: 'windows' } ],
        // Brave's user agent is Chrome's; its own API tells it apart
        [ 'Brave by its API', createEnvironment(WINDOWS_CHROME, { brands: CHROME_BRANDS, hasBraveApi: true }), { browser: 'brave', family: 'chromium', majorVersion: 141, os: 'windows' } ],
        [ 'Brave by brand', createEnvironment(LINUX_CHROME, { brands: [ 'Brave', 'Chromium' ] }), { browser: 'brave', family: 'chromium', majorVersion: 141, os: 'linux' } ],
        [ 'Vivaldi naming itself', createEnvironment(`${WINDOWS_CHROME} Vivaldi/7.6.3797.52`), { browser: 'vivaldi', family: 'chromium', majorVersion: 141, os: 'windows' } ],
        // Vivaldi masks itself as Chrome by default
        [ 'Vivaldi by default', createEnvironment(WINDOWS_CHROME, { brands: CHROME_BRANDS }), { browser: 'chrome', family: 'chromium', majorVersion: 141, os: 'windows' } ],
        [ 'Chromium without a known brand', createEnvironment(LINUX_CHROME, { brands: [ 'Chromium', 'Not?A_Brand' ] }), { browser: 'other', family: 'chromium', majorVersion: 141, os: 'linux' } ],
        [
            'Samsung Internet',
            createEnvironment(ANDROID_CHROME.replace('Chrome/141.0.0.0', 'SamsungBrowser/28.0 Chrome/130.0.0.0')),
            { browser: 'other', family: 'chromium', majorVersion: 130, os: 'android' }
        ],
        [ 'Firefox on Windows', createEnvironment(WINDOWS_FIREFOX), { browser: 'firefox', family: 'firefox', majorVersion: 144, os: 'windows' } ],
        [
            'Firefox on Linux',
            createEnvironment('Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0'),
            { browser: 'firefox', family: 'firefox', majorVersion: 144, os: 'linux' }
        ],
        [
            'Firefox on macOS',
            createEnvironment('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:147.0) Gecko/20100101 Firefox/147.0'),
            { browser: 'firefox', family: 'firefox', majorVersion: 147, os: 'macos' }
        ],
        [
            'Firefox on Android',
            createEnvironment('Mozilla/5.0 (Android 14; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0'),
            { browser: 'firefox', family: 'firefox', majorVersion: 144, os: 'android' }
        ],
        // Zen and LibreWolf read as Firefox unless the user agent names them
        [ 'Zen or LibreWolf by default', createEnvironment(WINDOWS_FIREFOX), { browser: 'firefox', family: 'firefox', majorVersion: 144, os: 'windows' } ],
        [ 'LibreWolf naming itself', createEnvironment(`${WINDOWS_FIREFOX} LibreWolf/144.0-1`), { browser: 'librewolf', family: 'firefox', majorVersion: 144, os: 'windows' } ],
        [ 'Zen naming itself', createEnvironment(`${WINDOWS_FIREFOX} Zen/1.17`), { browser: 'zen', family: 'firefox', majorVersion: 144, os: 'windows' } ],
        [ 'Safari on macOS', createEnvironment(MAC_SAFARI), { browser: 'safari', family: 'safari', majorVersion: 26, os: 'macos' } ],
        [
            'Safari 18 on macOS',
            createEnvironment(MAC_SAFARI.replace('Version/26.0', 'Version/18.6')),
            { browser: 'safari', family: 'safari', majorVersion: 18, os: 'macos' }
        ],
        [ 'Safari on iPhone', createEnvironment(IPHONE_SAFARI), { browser: 'safari', family: 'safari', majorVersion: 26, os: 'ios' } ],
        // An iPad asking for desktop pages names itself a Mac with touch
        [ 'Safari on iPad as a Mac', createEnvironment(MAC_SAFARI, { maxTouchPoints: 5 }), { browser: 'safari', family: 'safari', majorVersion: 26, os: 'ios' } ],
        [
            'Safari on iPad',
            createEnvironment('Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'),
            { browser: 'safari', family: 'safari', majorVersion: 17, os: 'ios' }
        ],
        // Every iOS browser is Safari's engine; its own name is kept, and Safari's version is unknown without Version/
        [
            'Chrome on iPhone',
            createEnvironment('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1'),
            { browser: 'chrome', family: 'safari', majorVersion: null, os: 'ios' }
        ],
        [
            'Firefox on iPhone',
            createEnvironment('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/144.0 Mobile/15E148 Safari/605.1.15'),
            { browser: 'firefox', family: 'safari', majorVersion: null, os: 'ios' }
        ],
        [
            'Edge on iPad',
            createEnvironment('Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 EdgiOS/141.0.3537.71 Mobile/15E148 Safari/605.1.15'),
            { browser: 'edge', family: 'safari', majorVersion: 26, os: 'ios' }
        ],
        [ 'Brave on iPhone', createEnvironment(IPHONE_SAFARI, { hasBraveApi: true }), { browser: 'brave', family: 'safari', majorVersion: 26, os: 'ios' } ],
        [ 'an unknown browser', createEnvironment('Mozilla/5.0 (PlayStation; PlayStation 5/2.26) AppleWebKit/605.1.15 (KHTML, like Gecko)'), { browser: 'other', family: 'other', majorVersion: null, os: 'other' } ]
    ])('detects %s', (_name: string, environment: BrowserEnvironment, identity: BrowserIdentity) => {
        expect(detectBrowserIdentity(environment)).toEqual(identity);
    });

    it('takes the system from user agent data where the user agent leaves it out', () => {
        expect(detectBrowserIdentity(createEnvironment('Mozilla/5.0 Chrome/141.0.0.0', { brands: CHROME_BRANDS, platform: 'Linux' })).os).toBe('linux');
        expect(detectBrowserIdentity(createEnvironment('Mozilla/5.0 Chrome/141.0.0.0', { brands: CHROME_BRANDS, platform: 'Chrome OS' })).os).toBe('chromeos');
    });
});

describe('browser guides', () => {
    it('has a guide for each of the nine browsers, named and of its engine', () => {
        expect(GUIDE_BROWSER_IDS).toHaveLength(9);
        expect(GUIDE_BROWSER_IDS.map((id: keyof typeof BROWSER_GUIDES): string => `${BROWSER_GUIDES[id].name}:${BROWSER_GUIDES[id].family}`)).toEqual([
            'Chrome:chromium',
            'Edge:chromium',
            'Brave:chromium',
            'Opera:chromium',
            'Vivaldi:chromium',
            'Firefox:firefox',
            'Zen:firefox',
            'LibreWolf:firefox',
            'Safari:safari'
        ]);
    });

    it('names each browser\'s GPU report page and hardware acceleration setting', () => {
        const reportPages = Object.fromEntries(GUIDE_BROWSER_IDS.map((id: keyof typeof BROWSER_GUIDES) => {
            const guide = BROWSER_GUIDES[id];
            return [ id, guide.family === 'safari' ? null : guide.gpuReportPage ];
        }));
        expect(reportPages).toEqual({
            brave: 'brave://gpu',
            chrome: 'chrome://gpu',
            edge: 'edge://gpu',
            firefox: 'about:support',
            librewolf: 'about:support',
            opera: 'opera://gpu',
            safari: null,
            vivaldi: 'vivaldi://gpu',
            zen: 'about:support'
        });
        expect(BROWSER_GUIDES.chrome).toMatchObject({
            flagsPage: 'chrome://flags',
            hardwareAcceleration: { label: 'Use graphics acceleration when available', location: { address: 'chrome://settings/system', kind: 'page' } }
        });
        expect(BROWSER_GUIDES.vivaldi).toMatchObject({
            hardwareAcceleration: { label: 'Use Hardware Acceleration When Available', location: { kind: 'menu', path: 'Settings > Performance' } }
        });
        expect(BROWSER_GUIDES.librewolf).toMatchObject({ overridesFile: 'librewolf.overrides.cfg' });
        expect(BROWSER_GUIDES.firefox).toMatchObject({ configPage: 'about:config', overridesFile: null });
    });

    it('picks the guide of a browser without one by its engine', () => {
        expect(getGuideBrowser({ browser: 'zen', family: 'firefox', majorVersion: 144, os: 'linux' })).toBe('zen');
        expect(getGuideBrowser({ browser: 'other', family: 'chromium', majorVersion: 130, os: 'android' })).toBe('chrome');
        expect(getGuideBrowser({ browser: 'other', family: 'firefox', majorVersion: 144, os: 'linux' })).toBe('firefox');
        expect(getGuideBrowser({ browser: 'other', family: 'other', majorVersion: null, os: 'other' })).toBe('chrome');
        // On iOS the detected browser keeps its own guide entry; the diagnosis applies Safari's steps
        expect(getGuideBrowser({ browser: 'chrome', family: 'safari', majorVersion: null, os: 'ios' })).toBe('chrome');
    });
});

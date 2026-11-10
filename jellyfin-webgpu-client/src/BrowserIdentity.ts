// Which browser and system a page runs in, read from what the page can see, and where each browser keeps what decides WebGPU.
// Several browsers present themselves as another: Vivaldi as Chrome, Zen and LibreWolf as Firefox, and on iOS and iPadOS every browser runs Safari's engine.
// Detection names the closest browser it can tell, and the WebGPU failure dialog lets the user pick their own

/** A browser the add-on can tell apart, or other. */
export type BrowserId = 'brave' | 'chrome' | 'edge' | 'firefox' | 'librewolf' | 'opera' | 'safari' | 'vivaldi' | 'zen' | 'other';

/** A browser with a guide to its WebGPU settings. */
export type GuideBrowserId = Exclude<BrowserId, 'other'>;

/** The engine a browser is built on, which decides where WebGPU comes from. */
export type BrowserFamily = 'chromium' | 'firefox' | 'safari' | 'other';

export type OperatingSystem = 'android' | 'chromeos' | 'ios' | 'linux' | 'macos' | 'windows' | 'other';

export type BrowserIdentity = Readonly<{
    browser: BrowserId
    /** The engine; on iOS and iPadOS every browser is Safari's */
    family: BrowserFamily
    /** The major version of the engine, Chromium's for every Chromium browser; on iOS and iPadOS Safari's, null where the page cannot tell it */
    majorVersion: number | null
    os: OperatingSystem
}>;

/** What the page reads its browser from; tests pass their own. */
export type BrowserEnvironment = Readonly<{
    /** The brands of navigator.userAgentData, null where the browser has none */
    brands: readonly string[] | null
    /** Whether navigator.brave exists, which only Brave defines */
    hasBraveApi: boolean
    /** Touch points: an iPad asking for desktop pages names itself a Mac, with touch */
    maxTouchPoints: number
    /** The platform of navigator.userAgentData, empty where the browser has none */
    platform: string
    userAgent: string
}>;

/** Where a setting lives: an internal page, to paste into the address bar, or a path through the browser's menus. */
export type GuideLocation =
    | Readonly<{ address: string, kind: 'page' }>
    | Readonly<{ kind: 'menu', path: string }>;

export type ChromiumBrowserGuide = Readonly<{
    family: 'chromium'
    /** The experiments page, whose flags each have an address of their own: the page, then #, then the flag's id */
    flagsPage: string
    /** The page that reports the GPU, the WebGPU status and the problems the browser detected */
    gpuReportPage: string
    hardwareAcceleration: Readonly<{ label: string, location: GuideLocation }>
    /** The browser's name, untranslated */
    name: string
}>;

export type FirefoxBrowserGuide = Readonly<{
    /** The page of advanced preferences */
    configPage: string
    family: 'firefox'
    /** The troubleshooting page, whose Graphics section reports the GPU and what the browser blocked */
    gpuReportPage: string
    /** The hardware acceleration checkbox on the preferences page, which shows once the recommended performance settings are unchecked */
    hardwareAcceleration: Readonly<{ label: string, page: string, recommendedLabel: string }>
    name: string
    /** The file whose preferences outlast the browser's updates, for a browser that turns WebGPU off itself; null for others */
    overridesFile: string | null
}>;

export type SafariBrowserGuide = Readonly<{
    family: 'safari'
    /** Where WebGPU is turned on before Safari 26, which turns it on by default */
    featureFlags: Readonly<{
        ios: Readonly<{ earlierPath: string, flag: string, path: string }>
        macos: Readonly<{ advancedPath: string, developerFeaturesLabel: string, flag: string, flagsPath: string }>
    }>
    name: string
}>;

export type BrowserGuide = ChromiumBrowserGuide | FirefoxBrowserGuide | SafariBrowserGuide;

/** A Chromium flag: its id, which ends the flag's address, and its name on the flags page. */
export type ChromiumFlag = Readonly<{ id: string, label: string }>;

/** The Chromium flags the WebGPU guide names. */
export const CHROMIUM_FLAGS = Object.freeze({
    unsafeWebGPU: Object.freeze({ id: 'enable-unsafe-webgpu', label: 'Unsafe WebGPU Support' }),
    vulkan: Object.freeze({ id: 'enable-vulkan', label: 'Vulkan' })
}) satisfies Readonly<Record<string, ChromiumFlag>>;

/** The labels of the Chromium GPU report page that the guide points at. */
export const CHROMIUM_GPU_REPORT_LABELS = Object.freeze({
    download: 'Download Report to File',
    problems: 'Problems Detected',
    webGPU: 'WebGPU'
});

/** The command line that turns WebGPU on for a GPU Chromium on Linux does not support yet, from the gpuweb implementation status. */
export const CHROMIUM_LINUX_WEBGPU_COMMAND_LINE = '--enable-unsafe-webgpu --ozone-platform=x11 --use-angle=vulkan --enable-features=Vulkan,VulkanFromANGLE';

/** The Firefox preferences that decide WebGPU. */
export const FIREFOX_WEBGPU_PREFERENCES = Object.freeze({
    enabled: 'dom.webgpu.enabled',
    ignoreBlocklist: 'gfx.webgpu.ignore-blocklist'
});

/** The labels of the Firefox troubleshooting page's Graphics section that the guide points at. */
export const FIREFOX_SUPPORT_LABELS = Object.freeze({
    failureLog: 'Failure Log',
    graphics: 'Graphics'
});

/** The line of librewolf.overrides.cfg that turns WebGPU on for good. */
export const LIBREWOLF_WEBGPU_OVERRIDE = 'defaultPref("dom.webgpu.enabled", true);';

const CHROMIUM_HARDWARE_ACCELERATION_LABEL = 'Use graphics acceleration when available';

function createChromiumGuide(name: string, scheme: string): ChromiumBrowserGuide {
    return Object.freeze({
        family: 'chromium',
        flagsPage: `${scheme}://flags`,
        gpuReportPage: `${scheme}://gpu`,
        hardwareAcceleration: Object.freeze({
            label: CHROMIUM_HARDWARE_ACCELERATION_LABEL,
            location: Object.freeze({ address: `${scheme}://settings/system`, kind: 'page' })
        }),
        name
    });
}

function createFirefoxGuide(name: string, overridesFile: string | null): FirefoxBrowserGuide {
    return Object.freeze({
        configPage: 'about:config',
        family: 'firefox',
        gpuReportPage: 'about:support',
        hardwareAcceleration: Object.freeze({
            label: 'Use hardware acceleration when available',
            page: 'about:preferences#general',
            recommendedLabel: 'Use recommended performance settings'
        }),
        name,
        overridesFile
    });
}

/** Each browser's guide; the names and the paths through menus stay as the browsers show them in English. */
export const BROWSER_GUIDES: Readonly<Record<GuideBrowserId, BrowserGuide>> = Object.freeze({
    brave: createChromiumGuide('Brave', 'brave'),
    chrome: createChromiumGuide('Chrome', 'chrome'),
    edge: createChromiumGuide('Edge', 'edge'),
    firefox: createFirefoxGuide('Firefox', null),
    librewolf: createFirefoxGuide('LibreWolf', 'librewolf.overrides.cfg'),
    opera: createChromiumGuide('Opera', 'opera'),
    safari: Object.freeze({
        family: 'safari',
        featureFlags: Object.freeze({
            ios: Object.freeze({
                earlierPath: 'Settings > Safari > Advanced > Feature Flags',
                flag: 'WebGPU',
                path: 'Settings > Apps > Safari > Advanced > Feature Flags'
            }),
            macos: Object.freeze({
                advancedPath: 'Safari > Settings > Advanced',
                developerFeaturesLabel: 'Show features for web developers',
                flag: 'WebGPU',
                flagsPath: 'Safari > Settings > Feature Flags'
            })
        }),
        name: 'Safari'
    }),
    vivaldi: Object.freeze({
        ...createChromiumGuide('Vivaldi', 'vivaldi'),
        // Vivaldi keeps the setting in its own settings window
        hardwareAcceleration: Object.freeze({
            label: 'Use Hardware Acceleration When Available',
            location: Object.freeze({ kind: 'menu', path: 'Settings > Performance' })
        })
    }),
    zen: createFirefoxGuide('Zen', null)
} satisfies Record<GuideBrowserId, BrowserGuide>);

/** The browsers with a guide, in the order the dialog offers them. */
export const GUIDE_BROWSER_IDS: readonly GuideBrowserId[] = Object.freeze([
    'chrome',
    'edge',
    'brave',
    'opera',
    'vivaldi',
    'firefox',
    'zen',
    'librewolf',
    'safari'
]);

/** The systems' names, untranslated. */
export const OPERATING_SYSTEM_NAMES: Readonly<Record<OperatingSystem, string>> = Object.freeze({
    android: 'Android',
    chromeos: 'ChromeOS',
    ios: 'iOS',
    linux: 'Linux',
    macos: 'macOS',
    other: '',
    windows: 'Windows'
});

type BrowserSignal = Readonly<{ browser: BrowserId, pattern: RegExp }>;

type OperatingSystemSignal = Readonly<{ os: OperatingSystem, platform: string, tokens: readonly string[] }>;

// User agent data and navigator.brave are absent from the DOM types
type BrowserNavigator = Navigator & Readonly<{
    brave?: unknown
    userAgentData?: Readonly<{ brands?: unknown, platform?: unknown }>
}>;

const IOS_DEVICE_PATTERN = /\b(?:iPad|iPhone|iPod)\b/;
// An iPad asking for desktop pages names itself a Mac; a Mac has no touch screen
const IPAD_MINIMUM_TOUCH_POINTS = 2;
// In order: Android before Linux, whose token Android user agents carry too
const OPERATING_SYSTEM_SIGNALS: readonly OperatingSystemSignal[] = [
    { os: 'android', platform: 'Android', tokens: [ 'Android' ] },
    { os: 'chromeos', platform: 'Chrome OS', tokens: [ 'CrOS' ] },
    { os: 'windows', platform: 'Windows', tokens: [ 'Windows' ] },
    { os: 'macos', platform: 'macOS', tokens: [ 'Macintosh', 'Mac OS X' ] },
    { os: 'linux', platform: 'Linux', tokens: [ 'Linux', 'X11' ] }
];
// Each iOS browser's own token; Safari has none
const IOS_BROWSER_SIGNALS: readonly BrowserSignal[] = [
    { browser: 'chrome', pattern: /\bCriOS\// },
    { browser: 'edge', pattern: /\bEdgiOS\// },
    { browser: 'firefox', pattern: /\bFxiOS\// },
    { browser: 'opera', pattern: /\b(?:OPiOS|OPT)\// }
];
// The Chromium browsers that name themselves in the user agent, checked before Brave's own API
const CHROMIUM_USER_AGENT_SIGNALS: readonly BrowserSignal[] = [
    { browser: 'edge', pattern: /\bEdgA?\// },
    { browser: 'opera', pattern: /\bOPR\// }
];
// Vivaldi names itself only on a few partner sites; elsewhere it reads as Chrome
const VIVALDI_PATTERN = /\bVivaldi\//;
// Chromium browsers this add-on has no guide for, which build on Chromium's WebGPU
const OTHER_CHROMIUM_PATTERN = /\b(?:SamsungBrowser|YaBrowser)\//;
const CHROMIUM_BRANDS: ReadonlyArray<Readonly<{ brand: string, browser: BrowserId }>> = [
    { brand: 'Microsoft Edge', browser: 'edge' },
    { brand: 'Opera', browser: 'opera' },
    { brand: 'Opera GX', browser: 'opera' },
    { brand: 'Brave', browser: 'brave' },
    { brand: 'Vivaldi', browser: 'vivaldi' },
    { brand: 'Google Chrome', browser: 'chrome' }
];
const CHROMIUM_BRAND = 'Chromium';
const CHROMIUM_PATTERN = /\b(?:Chrome|Chromium)\/(\d+)/;
// A user agent may name a Firefox-based browser, as a user's override can
const FIREFOX_BASED_SIGNALS: readonly BrowserSignal[] = [
    { browser: 'librewolf', pattern: /\bLibreWolf\// },
    { browser: 'zen', pattern: /\bZen\// }
];
const FIREFOX_PATTERN = /\bFirefox\/(\d+)/;
const SAFARI_TOKEN = 'Safari/';
const SAFARI_VERSION_PATTERN = /\bVersion\/(\d+)/;

const NO_ENVIRONMENT: BrowserEnvironment = Object.freeze({ brands: null, hasBraveApi: false, maxTouchPoints: 0, platform: '', userAgent: '' });

function readBrands(value: unknown): readonly string[] | null {
    if (!Array.isArray(value)) {
        return null;
    }
    return value
        .map((entry: unknown): unknown => (entry && typeof entry === 'object' ? (entry as Readonly<{ brand?: unknown }>).brand : null))
        .filter((brand: unknown): brand is string => typeof brand === 'string');
}

/** Reads this page's browser environment; a page without a navigator reads as an unknown browser. */
export function readBrowserEnvironment(): BrowserEnvironment {
    if (typeof navigator === 'undefined') {
        return NO_ENVIRONMENT;
    }
    const browserNavigator = navigator as BrowserNavigator;
    const userAgentData = browserNavigator.userAgentData;
    // eslint-disable-next-line compat/compat -- A browser without touch points reads as having none
    const maxTouchPoints = navigator.maxTouchPoints;
    return {
        brands: readBrands(userAgentData?.brands),
        hasBraveApi: browserNavigator.brave !== undefined,
        maxTouchPoints: typeof maxTouchPoints === 'number' ? maxTouchPoints : 0,
        platform: typeof userAgentData?.platform === 'string' ? userAgentData.platform : '',
        userAgent: typeof navigator.userAgent === 'string' ? navigator.userAgent : ''
    };
}

function readMajorVersion(pattern: RegExp, userAgent: string): number | null {
    const match = pattern.exec(userAgent);
    return match ? Number.parseInt(match[1], 10) : null;
}

function findSignal(signals: readonly BrowserSignal[], userAgent: string): BrowserId | null {
    return signals.find((signal: BrowserSignal): boolean => signal.pattern.test(userAgent))?.browser ?? null;
}

function detectOperatingSystem(environment: BrowserEnvironment): OperatingSystem {
    const { platform, userAgent } = environment;
    if (IOS_DEVICE_PATTERN.test(userAgent)
        || platform === 'iOS'
        || (userAgent.includes('Macintosh') && environment.maxTouchPoints >= IPAD_MINIMUM_TOUCH_POINTS)) {
        return 'ios';
    }
    const signal = OPERATING_SYSTEM_SIGNALS.find((candidate: OperatingSystemSignal): boolean => (
        candidate.platform === platform || candidate.tokens.some((token: string): boolean => userAgent.includes(token))
    ));
    return signal?.os ?? 'other';
}

function detectIOSBrowser(environment: BrowserEnvironment): BrowserIdentity {
    const browser = environment.hasBraveApi ? 'brave' : findSignal(IOS_BROWSER_SIGNALS, environment.userAgent);
    return {
        browser: browser ?? 'safari',
        family: 'safari',
        majorVersion: readMajorVersion(SAFARI_VERSION_PATTERN, environment.userAgent),
        os: 'ios'
    };
}

function detectChromiumBrowser(environment: BrowserEnvironment): BrowserId {
    const named = findSignal(CHROMIUM_USER_AGENT_SIGNALS, environment.userAgent);
    if (named !== null) {
        return named;
    }
    if (environment.hasBraveApi) {
        return 'brave';
    }
    if (VIVALDI_PATTERN.test(environment.userAgent)) {
        return 'vivaldi';
    }
    const brands = environment.brands ?? [];
    const branded = CHROMIUM_BRANDS.find((candidate: Readonly<{ brand: string }>): boolean => brands.includes(candidate.brand));
    if (branded) {
        return branded.browser;
    }
    // Another browser's own token, or brands that name only Chromium, are a browser without a guide
    return OTHER_CHROMIUM_PATTERN.test(environment.userAgent) || brands.includes(CHROMIUM_BRAND) ? 'other' : 'chrome';
}

/** Detects the page's browser, engine, engine version and system; Vivaldi, Zen and LibreWolf usually read as Chrome and Firefox. */
export function detectBrowserIdentity(environment: BrowserEnvironment = readBrowserEnvironment()): BrowserIdentity {
    const os = detectOperatingSystem(environment);
    if (os === 'ios') {
        return detectIOSBrowser(environment);
    }
    const { userAgent } = environment;
    if (CHROMIUM_PATTERN.test(userAgent) || (environment.brands ?? []).includes(CHROMIUM_BRAND)) {
        return { browser: detectChromiumBrowser(environment), family: 'chromium', majorVersion: readMajorVersion(CHROMIUM_PATTERN, userAgent), os };
    }
    if (FIREFOX_PATTERN.test(userAgent)) {
        const browser = findSignal(FIREFOX_BASED_SIGNALS, userAgent) ?? 'firefox';
        return { browser, family: 'firefox', majorVersion: readMajorVersion(FIREFOX_PATTERN, userAgent), os };
    }
    if (userAgent.includes(SAFARI_TOKEN) && SAFARI_VERSION_PATTERN.test(userAgent)) {
        return { browser: 'safari', family: 'safari', majorVersion: readMajorVersion(SAFARI_VERSION_PATTERN, userAgent), os };
    }
    return { browser: 'other', family: 'other', majorVersion: null, os };
}

/** Returns the guide a browser identity reads best with: its own, else its engine's main browser, else Chrome's. */
export function getGuideBrowser(identity: BrowserIdentity): GuideBrowserId {
    if (identity.browser !== 'other') {
        return identity.browser;
    }
    if (identity.family === 'firefox' || identity.family === 'safari') {
        return identity.family;
    }
    return 'chrome';
}

// The defaults an administrator sets on the server for the add-on's settings, one value per key.
// Each setting's owner reads its key's value as it reads a stored value of its own, so a key that is absent, or holds a value its owner refuses, takes the add-on's built-in default.
// This module only holds the latest defaults; ServerClientDefaults.ts reads them from the server and keeps the last read for the next page

/** The keys a default can be set for, each named after the setting it defaults. */
export const CLIENT_DEFAULT_KEYS = Object.freeze([
    'audioDownmixAlgorithm',
    'automaticInputPeakNits',
    'binauralHeadphones',
    'blackBarCrop',
    'brightness',
    'centerLevel',
    'contrast',
    'deinterlaceMode',
    'desaturationStrength',
    'enableCustomDecode',
    'enableGPUDecodeSlicing',
    'enableHDRToneMapping',
    'exposure',
    'forceStereoDownmix',
    'hdrOutput',
    'inputPeakNits',
    'outputGain',
    'outputPeakNits',
    'paperWhiteNits',
    'preferredVideoPlayer',
    'presentationFiles',
    'saturation',
    'settingsButtonPlacement',
    'speakerLayout',
    'surroundLevel',
    'toneMapOperator'
] as const);

export type ClientDefaultKey = typeof CLIENT_DEFAULT_KEYS[number];

/** The server's defaults as read: each key's value unchecked, for its setting's owner to normalize. */
export type ClientDefaults = Readonly<Partial<Record<ClientDefaultKey, unknown>>>;

/** The revision of each key an administrator last applied to every client; a client drops its user's own choice of a key once per newer revision. */
export type AppliedRevisions = Readonly<Partial<Record<ClientDefaultKey, number>>>;

const WARNING_PREFIX = 'WebGPU client defaults';
const EMPTY_DEFAULTS: ClientDefaults = Object.freeze({});

let currentDefaults: ClientDefaults = EMPTY_DEFAULTS;
let currentDefaultsText = JSON.stringify(EMPTY_DEFAULTS);
const listeners = new Set<() => void>();

function isClientDefaultKey(key: string): key is ClientDefaultKey {
    return CLIENT_DEFAULT_KEYS.some((defaultKey: ClientDefaultKey): boolean => defaultKey === key);
}

/** Keeps the known keys of a defaults object that hold a value; an unknown key, as a newer plugin may send, is named and left out. */
export function parseClientDefaults(value: unknown): ClientDefaults {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return EMPTY_DEFAULTS;
    }
    const defaults: Partial<Record<ClientDefaultKey, unknown>> = {};
    for (const [ key, keyValue ] of Object.entries(value) as Array<[ string, unknown ]>) {
        if (!isClientDefaultKey(key)) {
            console.warn(`${WARNING_PREFIX}: default-unknown: ${key}`);
            continue;
        }
        if (keyValue !== null && keyValue !== undefined) {
            defaults[key] = keyValue;
        }
    }
    return Object.freeze(defaults);
}

/** Keeps the known keys of a revisions object that hold a positive whole number; another key or value is left out. */
export function parseAppliedRevisions(value: unknown): AppliedRevisions {
    const revisions: Partial<Record<ClientDefaultKey, number>> = {};
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return revisions;
    }
    for (const [ key, revision ] of Object.entries(value) as Array<[ string, unknown ]>) {
        if (isClientDefaultKey(key) && typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0) {
            revisions[key] = revision;
        }
    }
    return Object.freeze(revisions);
}

/** Returns the latest defaults, or none before any were read. */
export function getClientDefaults(): ClientDefaults {
    return currentDefaults;
}

/**
 * Replaces the defaults, and tells each subscriber when they changed.
 * choicesChanged tells them even when the defaults did not, since the user's own choices changed with them.
 */
export function setClientDefaults(defaults: ClientDefaults, choicesChanged = false): void {
    const parsedDefaults = parseClientDefaults(defaults);
    const parsedDefaultsText = JSON.stringify(parsedDefaults);
    if (parsedDefaultsText === currentDefaultsText && !choicesChanged) {
        return;
    }
    currentDefaults = parsedDefaults;
    currentDefaultsText = parsedDefaultsText;
    for (const listener of Array.from(listeners)) {
        try {
            listener();
        } catch (error) {
            console.warn(`${WARNING_PREFIX}: listener-failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

/** Calls the listener after each change of the defaults; returns the function that stops it. */
export function subscribeClientDefaults(listener: () => void): () => void {
    listeners.add(listener);
    return (): void => {
        listeners.delete(listener);
    };
}

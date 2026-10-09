import fetchLocal from 'utils/fetchLocal';

// Shim for scripts/settings/webSettings: the host module caches config.json privately, so the add-on keeps its own copy of the CORS credential lookup

type WebConfigCredentials = {
    includeCorsCredentials?: boolean
};

const WEB_CONFIG_URL = 'config.json';
const WEB_CONFIG_CACHE_MODE = 'no-store';
// The host's bundled default config.json disables CORS credentials
const DEFAULT_WEB_CONFIG: WebConfigCredentials = { includeCorsCredentials: false };

let webConfigPromise: Promise<WebConfigCredentials> | null = null;

/** Fetches config.json once, like the host, falling back to the bundled default. */
function getWebConfig(): Promise<WebConfigCredentials> {
    if (!webConfigPromise) {
        webConfigPromise = fetchLocal(WEB_CONFIG_URL, { cache: WEB_CONFIG_CACHE_MODE })
            .then((response: Response): Promise<WebConfigCredentials> => {
                if (!response.ok) {
                    throw new Error('network response was not ok');
                }
                return response.json() as Promise<WebConfigCredentials>;
            })
            .catch((error: unknown): WebConfigCredentials => {
                console.warn('failed to fetch the web config file:', error);
                return DEFAULT_WEB_CONFIG;
            });
    }
    return webConfigPromise;
}

/** Resolves whether media requests include CORS credentials, as the host's webSettings does. */
export function getIncludeCorsCredentials(): Promise<boolean> {
    return getWebConfig()
        .then((config: WebConfigCredentials): boolean => Boolean(config.includeCorsCredentials))
        .catch((error: unknown): boolean => {
            console.log('cannot get web config:', error);
            return false;
        });
}

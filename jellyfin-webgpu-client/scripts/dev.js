const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const {
    ADDON_OUTPUT_DIRECTORY,
    CLIENT_DIRECTORY,
    DEV_DIRECTORY,
    DEV_WEB_DIRECTORY,
    DEV_WEB_OUTPUT_DIRECTORY
} = require('./constants');
const { resolveJellyfinWebDirectory } = require('./jellyfin-web');

const WEB_BASE = '/web/';
const ASSET_BASE = `${WEB_BASE}WebGPUPlayer/assets/`;
const BOOTSTRAP_MARKER = 'data-webgpu-player-bootstrap';
const HELP = `Local Jellyfin Web + WebGPU development tool

Usage: npm run dev [-- --server http://your-server:8096] [options]

Set JELLYFIN_SERVER_URL in .env, or pass --server to override it.

  --server URL    Jellyfin server root, including its BaseUrl if configured
  --port PORT     Local port (default: 5173; binds to 127.0.0.1 only)
  --rebuild-web   Rebuild the cached Jellyfin Web client
  --no-build      Serve existing local web and add-on builds
  --help          Show this help

No server plugin is needed. Log in normally at the printed localhost URL.
Rebuild the add-on with npm run build:development, then refresh the browser.
`;

/** Validates CLI options before any build or network activity. */
function parseOptions(args) {
    const { values } = parseArgs({
        args,
        options: {
            server: { type: 'string', default: process.env.JELLYFIN_SERVER_URL },
            port: { type: 'string', default: process.env.JELLYFIN_DEV_PORT || '5173' },
            'rebuild-web': { type: 'boolean', default: false },
            'no-build': { type: 'boolean', default: false },
            help: { type: 'boolean', default: false }
        }
    });
    if (values.help) {
        return { help: true };
    }
    if (!values.server) {
        throw new Error('Set JELLYFIN_SERVER_URL in .env or pass --server with the Jellyfin server root URL.');
    }
    const serverURL = new URL(values.server);
    if (!['http:', 'https:'].includes(serverURL.protocol)
        || serverURL.username || serverURL.password || serverURL.search || serverURL.hash) {
        throw new Error('The server must be an HTTP(S) URL without credentials, a query, or a fragment.');
    }
    serverURL.pathname = getBasePath(serverURL);
    if (/\/web(?:\/|$)/i.test(serverURL.pathname)) {
        throw new Error('Use the server root URL (with its BaseUrl), not the /web/ client URL.');
    }
    const port = Number(values.port);
    if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('--port must be an integer between 1 and 65535.');
    }
    if (values['no-build'] && values['rebuild-web']) {
        throw new Error('--no-build and --rebuild-web cannot be used together.');
    }
    return { serverURL, port, rebuildWeb: values['rebuild-web'], noBuild: values['no-build'], help: false };
}

/** Returns the upstream BaseUrl without trailing slashes. */
function getBasePath(serverURL) {
    let base = serverURL.pathname;
    while (base.endsWith('/')) {
        base = base.slice(0, -1);
    }
    return base;
}

/** Runs fixed npm commands, removing the parent npm project's configuration. */
function runNpm(command, cwd) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_/i.test(name)));
    // Fixed command lines only; the shell resolves npm.cmd on Windows.
    // eslint-disable-next-line sonarjs/os-command
    const result = spawnSync(command, { cwd, env: { ...env, NODE_ENV: 'development' }, shell: true, stdio: 'inherit' });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`${command} failed (exit ${result.status}, signal ${result.signal || 'none'}).`);
    }
}

/** Builds a private copy of Jellyfin Web, reusing dependencies until its manifests change. */
function buildWeb(rebuildWeb) {
    const sourceDirectory = resolveJellyfinWebDirectory();
    const sourceMarker = path.join(DEV_DIRECTORY, 'web-source.txt');
    if (!rebuildWeb && fs.existsSync(path.join(DEV_WEB_OUTPUT_DIRECTORY, 'index.html'))
        && fs.existsSync(sourceMarker) && fs.readFileSync(sourceMarker, 'utf8') === sourceDirectory) {
        console.log('Using the cached Jellyfin Web build (--rebuild-web to update it).');
        return;
    }
    fs.mkdirSync(DEV_WEB_DIRECTORY, { recursive: true });
    fs.rmSync(sourceMarker, { force: true });
    // Remove deleted source files too, without touching the cached dependencies or the input checkout.
    fs.rmSync(path.join(DEV_WEB_DIRECTORY, 'src'), { recursive: true, force: true });
    fs.cpSync(path.join(sourceDirectory, 'src'), path.join(DEV_WEB_DIRECTORY, 'src'), { recursive: true });
    for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
        if (entry.isFile() && !entry.name.startsWith('.')) {
            fs.copyFileSync(path.join(sourceDirectory, entry.name), path.join(DEV_WEB_DIRECTORY, entry.name));
        }
    }
    const dependencyKey = createHash('sha256')
        .update(fs.readFileSync(path.join(DEV_WEB_DIRECTORY, 'package.json')))
        .update(fs.readFileSync(path.join(DEV_WEB_DIRECTORY, 'package-lock.json')))
        .digest('hex');
    const dependencyMarker = path.join(DEV_DIRECTORY, 'web-dependencies.txt');
    if (!fs.existsSync(path.join(DEV_WEB_DIRECTORY, 'node_modules'))
        || !fs.existsSync(dependencyMarker) || fs.readFileSync(dependencyMarker, 'utf8') !== dependencyKey) {
        // Some host locks omit optional peers; normalize only the disposable build copy.
        runNpm('npm install --package-lock-only --ignore-scripts --no-audit --no-fund', DEV_WEB_DIRECTORY);
        runNpm('npm ci --ignore-scripts --no-audit --no-fund', DEV_WEB_DIRECTORY);
        fs.writeFileSync(dependencyMarker, dependencyKey);
    }
    runNpm('npm run build:development', DEV_WEB_DIRECTORY);
    fs.writeFileSync(sourceMarker, sourceDirectory);
}

/** Reads and validates the current entry so refreshing picks up a rebuilt add-on's hash. */
function readEntry(addonDirectory) {
    const { entry } = JSON.parse(fs.readFileSync(path.join(addonDirectory, 'addon-manifest.json'), 'utf8'));
    if (typeof entry !== 'string' || !/^plugin\.[a-f\d]+\.js$/.test(entry)
        || !fs.existsSync(path.join(addonDirectory, entry))) {
        throw new Error('The local add-on manifest has no valid built entry. Run npm run build:development.');
    }
    return entry;
}

/** Implements the server plugin's window-factory contract for the local web client. */
function injectBootstrap(html, entry) {
    if (!/<\/head>/i.test(html) || html.includes(BOOTSTRAP_MARKER)) {
        throw new Error('Expected an unmodified Jellyfin Web index.html with a closing head tag.');
    }
    const entryURL = JSON.stringify(ASSET_BASE + entry);
    const script = `<script ${BOOTSTRAP_MARKER}>
window.WebGPUPlayerConfig = { assetBaseURL: ${JSON.stringify(ASSET_BASE)} };
window.WebGPUPlayer = function () {
    let timer;
    const timeout = new Promise(function (resolve, reject) {
        timer = setTimeout(function () {
            reject(new Error('WebGPU Player add-on did not load within 20000 ms'));
        }, 20000);
    });
    const load = import(${entryURL}).then(function (module) {
        clearTimeout(timer);
        return module.default;
    }, function (error) {
        clearTimeout(timer);
        throw error;
    });
    return Promise.race([load, timeout]);
};
</script>`;
    return html.replace(/<\/head>/i, `${script}</head>`);
}

/** Keeps upstream redirects on the local origin, removing the upstream BaseUrl. */
function rewriteLocation(location, serverURL) {
    const base = getBasePath(serverURL);
    if (!location.startsWith('/') && !URL.canParse(location)) {
        return location;
    }
    const target = new URL(location, serverURL);
    if (target.origin !== serverURL.origin || (base && target.pathname !== base && !target.pathname.startsWith(`${base}/`))) {
        return location;
    }
    return (target.pathname.slice(base.length) || '/') + target.search + target.hash;
}

/** Serves the built web client and add-on, proxying API, media and WebSocket requests. */
async function startDevServer({
    serverURL,
    port = 5173,
    webDirectory = DEV_WEB_OUTPUT_DIRECTORY,
    addonDirectory = ADDON_OUTPUT_DIRECTORY
}) {
    readEntry(addonDirectory);
    fs.accessSync(path.join(webDirectory, 'index.html'));
    fs.accessSync(path.join(webDirectory, 'config.json'));
    const assetMount = path.join(webDirectory, 'WebGPUPlayer', 'assets');
    fs.mkdirSync(path.dirname(assetMount), { recursive: true });
    if (!fs.existsSync(assetMount)) {
        fs.symlinkSync(addonDirectory, assetMount, 'junction');
    } else if (fs.realpathSync(assetMount) !== fs.realpathSync(addonDirectory)) {
        throw new Error(`The local asset mount at ${assetMount} points at a different build.`);
    }
    const { preview } = await import('vite');
    const base = getBasePath(serverURL);
    return preview({
        configFile: false,
        root: CLIENT_DIRECTORY,
        base: WEB_BASE,
        appType: 'mpa',
        build: { outDir: webDirectory },
        preview: {
            host: '127.0.0.1',
            port,
            strictPort: true,
            proxy: {
                '^/(?!web(?:/|\\?|$))': {
                    target: serverURL.origin,
                    changeOrigin: true,
                    ws: true,
                    rewrite: requestPath => base + requestPath,
                    cookieDomainRewrite: '',
                    cookiePathRewrite: '/',
                    configure(proxy) {
                        proxy.on('proxyRes', proxyResponse => {
                            if (proxyResponse.headers.location) {
                                proxyResponse.headers.location = rewriteLocation(proxyResponse.headers.location, serverURL);
                            }
                        });
                    }
                }
            }
        },
        plugins: [{
            name: 'local-webgpu-player',
            configurePreviewServer(server) {
                server.middlewares.use((request, response, next) => {
                    const requestURL = new URL(request.url, 'http://localhost');
                    const pathname = requestURL.pathname;
                    if (pathname === '/' || pathname === '/web') {
                        response.writeHead(302, { Location: WEB_BASE }).end();
                        return;
                    }
                    if (!pathname.startsWith(WEB_BASE)) {
                        next();
                        return;
                    }
                    // Webpack encodes scoped package names; Vite's static server leaves %40 encoded.
                    request.url = pathname.replace(/%40/gi, '@') + requestURL.search;
                    response.setHeader('Cache-Control', 'no-store');
                    try {
                        let contents;
                        let contentType;
                        if (pathname === WEB_BASE || pathname === `${WEB_BASE}index.html`) {
                            contents = injectBootstrap(fs.readFileSync(path.join(webDirectory, 'index.html'), 'utf8'), readEntry(addonDirectory));
                            contentType = 'text/html';
                        } else if (pathname === `${WEB_BASE}config.json`) {
                            const config = JSON.parse(fs.readFileSync(path.join(webDirectory, 'config.json'), 'utf8'));
                            if (!Array.isArray(config.plugins)) {
                                throw new Error('The local Jellyfin Web config.json has no plugins array.');
                            }
                            config.plugins = [...new Set([...config.plugins, 'WebGPUPlayer'])];
                            config.servers = [];
                            config.multiserver = false;
                            contents = JSON.stringify(config);
                            contentType = 'application/json';
                        } else if (pathname === `${WEB_BASE}serviceworker.js`) {
                            // Development must not cache old bundles through Jellyfin's service worker.
                            contents = "self.addEventListener('install', () => self.skipWaiting());\n"
                                + "self.addEventListener('activate', event => event.waitUntil(self.registration.unregister()));\n";
                            contentType = 'text/javascript';
                        } else {
                            next();
                            return;
                        }
                        response.setHeader('Content-Type', `${contentType}; charset=utf-8`);
                        response.end(request.method === 'HEAD' ? undefined : contents);
                    } catch (error) {
                        server.config.logger.error(`Local WebGPU client: ${error.message}`);
                        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                        response.end(`Local WebGPU client: ${error.message}`);
                    }
                });
            }
        }]
    });
}

/** Builds the two browser clients and starts the loopback-only development server. */
async function main() {
    const envFile = path.join(CLIENT_DIRECTORY, '.env');
    if (fs.existsSync(envFile)) {
        process.loadEnvFile(envFile);
    }
    const options = parseOptions(process.argv.slice(2));
    if (options.help) {
        console.log(HELP);
        return;
    }
    if (!options.noBuild) {
        buildWeb(options.rebuildWeb);
        runNpm('npm run build:development', CLIENT_DIRECTORY);
    }
    const server = await startDevServer(options);
    console.log(`\nJellyfin Web + WebGPU: http://127.0.0.1:${options.port}${WEB_BASE}`);
    console.log(`Jellyfin server: ${options.serverURL.href}`);
    console.log('Rebuild with npm run build:development, then refresh. Ctrl+C stops the dev tool.');
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => {
            server.httpServer.close();
            process.exit(0);
        });
    }
}

module.exports = { parseOptions, rewriteLocation, startDevServer };

if (require.main === module) {
    main().catch(error => {
        console.error(`WebGPU dev tool: ${error.message}`);
        process.exitCode = 1;
    });
}

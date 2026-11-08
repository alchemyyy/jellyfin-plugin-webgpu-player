// Serves a Jellyfin Web build with the live WebGPU Player add-on and the live plugin on 127.0.0.1, and proxies every other request to a Jellyfin server.
// serve_jellyfin_web_client.sh in the plugin root runs it: `configure` stores and checks the settings before the script's long first steps, then `serve`.
// The add-on builds as `npm run build:development` does, and again on every change, into a folder of its own, so the plugin's add-on build in bin/ stays as it is.
// The plugin builds into a host of its own (Jellyfin.Plugin.WebGPUPlayer.DevHost), with that add-on build embedded, and again on every change of its sources
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const readline = require('readline');
const { pipeline } = require('stream');
const { parseArgs } = require('util');
const escapeHTML = require('escape-html');
const { CLIENT_DIRECTORY } = require('./constants');

const MESSAGE_PREFIX = 'serve_jellyfin_web_client';
const LOOPBACK_ADDRESS = '127.0.0.1';
// The host names that reach this machine, for the check that the server is not this one
const LOOPBACK_HOST_NAMES = new Set([ 'localhost', '127.0.0.1', '[::1]' ]);
const WEB_PATH = '/web/';
// The plugin's add-on asset route below the server's base URL; the bootstrap names it to the add-on
const ASSET_PATH = '/WebGPUPlayer/assets/';
// The plugin's other routes (ModuleController.RoutePrefix), which this checkout's plugin serves
const PLUGIN_ROUTE_PATH = '/WebGPUPlayer/';
// The live reload events, served here; Jellyfin has no route below this path
const EVENTS_PATH = '/__webgpu-player-dev/events';
// Jellyfin Web reads a plugin's settings page and its controller from this route, each by the name the plugin gives it in Plugin.GetPages
const CONFIGURATION_PAGE_PATH = `${WEB_PATH}ConfigurationPage`;
const PLUGIN_DIRECTORY = path.join(CLIENT_DIRECTORY, '..', 'Jellyfin.Plugin.WebGPUPlayer');
// The host that serves the plugin's routes; it writes the ready line (Program.cs) once it listens
const PLUGIN_HOST_DIRECTORY = path.join(CLIENT_DIRECTORY, '..', 'Jellyfin.Plugin.WebGPUPlayer.DevHost');
const PLUGIN_HOST_NAME = 'Jellyfin.Plugin.WebGPUPlayer.DevHost';
const PLUGIN_HOST_READY_PREFIX = 'WebGPU Player plugin host listening on ';
// The plugin's sources, whose change builds and starts the host again; bin/ and obj/ are build output
const PLUGIN_SOURCE_PATTERN = /\.(?:cs|csproj)$/i;
const BUILD_OUTPUT_PATTERN = /^(?:bin|obj)\//;
// How long a burst of file changes, as an editor's save writes, settles before it builds or reloads
const CHANGE_DELAY = 300;
// This checkout's settings page, served in place of the installed plugin's, read on every request
const CONFIGURATION_FOLDER_NAME = 'Configuration';
const CONFIGURATION_DIRECTORY = path.join(PLUGIN_DIRECTORY, CONFIGURATION_FOLDER_NAME);
const CONFIGURATION_FILES = new Map([
    [ 'WebGPUPlayer', 'configPage.html' ],
    [ 'WebGPUPlayerConfig.js', 'configPage.js' ]
]);
const ADDON_MANIFEST_FILE_NAME = 'addon-manifest.json';
const ADDON_ENTRY_PATTERN = /^plugin\.[0-9a-f]+\.js$/;
// The name the plugin adds to config.json's plugins; Jellyfin Web's plugin manager loads the window factory of that name
const CLIENT_PLUGIN_NAME = 'WebGPUPlayer';
const WEB_CLIENT_FILE_NAMES = [ 'index.html', 'config.json' ];
const HEAD_END_PATTERN = /<\/head>/i;
// The settings file's settings, with their defaults, in the order the file lists them
const DEFAULT_CONFIG = Object.freeze({
    server: '',
    dev_client_port: 5173,
    liveReload: true
});
const PORT_PATTERN = /^\d+$/;
const MAXIMUM_PORT = 65535;
// The headers of one connection (RFC 9110, section 7.6.1), which a proxy does not forward
const HOP_BY_HOP_HEADERS = [ 'connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'upgrade' ];
// The redirect statuses a browser follows, and how many redirects it follows for one request
const REDIRECT_STATUSES = new Set([ 301, 302, 303, 307, 308 ]);
const MAXIMUM_REDIRECTS = 20;
// The page origin's credentials, which a browser leaves out of a request it follows to another origin:
// the standard ones, and Jellyfin's own token headers (as the DevHost's ServerUserAuthenticationHandler reads them)
const CREDENTIAL_HEADERS = [ 'authorization', 'cookie', 'proxy-authorization', 'x-emby-authorization', 'x-emby-token', 'x-mediabrowser-token' ];
const NO_STORE = 'no-store';
const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const TEXT_CONTENT_TYPE = 'text/plain; charset=utf-8';
const FALLBACK_CONTENT_TYPE = 'application/octet-stream';
// Module scripts need a JavaScript type, and WebAssembly streaming compilation needs application/wasm
const CONTENT_TYPES = new Map([
    [ '.css', 'text/css; charset=utf-8' ],
    [ '.gif', 'image/gif' ],
    [ '.html', HTML_CONTENT_TYPE ],
    [ '.ico', 'image/x-icon' ],
    [ '.jpg', 'image/jpeg' ],
    [ '.js', 'text/javascript; charset=utf-8' ],
    [ '.json', JSON_CONTENT_TYPE ],
    [ '.map', JSON_CONTENT_TYPE ],
    [ '.mjs', 'text/javascript; charset=utf-8' ],
    [ '.png', 'image/png' ],
    [ '.svg', 'image/svg+xml' ],
    [ '.ttf', 'font/ttf' ],
    [ '.txt', TEXT_CONTENT_TYPE ],
    [ '.wasm', 'application/wasm' ],
    [ '.webp', 'image/webp' ],
    [ '.wgsl', TEXT_CONTENT_TYPE ],
    [ '.woff', 'font/woff' ],
    [ '.woff2', 'font/woff2' ]
]);
const HTTP_OK = 200;
const HTTP_FOUND = 302;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_BAD_GATEWAY = 502;
const HTTP_SERVICE_UNAVAILABLE = 503;

/** The latest add-on build, and the build in progress that requests for index.html wait for. */
class AddonBuild {
    // The first build is in progress from the start
    #pending = Promise.withResolvers();
    // The hash of the latest successful build, and the errors of the latest build when it failed
    #latest = Object.freeze({ failure: null, hash: null });

    get latest() {
        return this.#latest;
    }

    /** Marks a build in progress, as a changed source starts one. */
    begin() {
        this.#pending ??= Promise.withResolvers();
    }

    /** Records a finished build, which settles the requests that wait for it. */
    finish(latest) {
        this.#latest = Object.freeze(latest);
        this.#pending?.resolve(this.#latest);
        this.#pending = null;
    }

    /** Resolves with the latest build once no build is in progress. */
    settled() {
        return this.#pending?.promise ?? Promise.resolve(this.#latest);
    }
}

/**
 * The open live reload event streams, which hear of each change a page reloads for: a successful add-on build, a plugin restart, or a settings page edit.
 * Each change has an id of its own (getReloadId), which a page compares with the one it loaded with.
 */
class LiveReloadEvents {
    #streams = new Set();

    /** Opens an event stream; it hears of the latest id at once, so a page that missed a change reloads. */
    open(response, latestId) {
        response.writeHead(HTTP_OK, { 'Cache-Control': NO_STORE, 'Content-Type': 'text/event-stream' });
        if (latestId !== null) {
            response.write(formatEvent('current', latestId));
        }
        this.#streams.add(response);
        response.on('close', () => {
            this.#streams.delete(response);
        });
    }

    /** Tells every open stream of a change. */
    broadcast(id) {
        for (const stream of this.#streams) {
            stream.write(formatEvent('build', id));
        }
    }
}

/**
 * This checkout's plugin, in a host of its own that serves its routes, built and started again on every change of its sources,
 * and of the engine modules the add-on build carries, which the plugin embeds and offers as its bundled decoders and passes.
 * Its data folder, of uploads and client defaults, is its own, so the installed plugin's stays as it is.
 */
class PluginHost {
    #addonDirectory;
    #dataDirectory;
    #outputDirectory;
    #server;
    #onRestart;
    #child = null;
    // Whether a build and start is in progress, and whether another change asked for one meanwhile
    #cycling = false;
    #again = false;
    // The requests that wait for the build and start in progress
    #pending = null;
    // The address of the running host, or the reason none runs
    #latest = Object.freeze({ address: null, failure: 'The plugin starts after the first successful add-on build' });
    // The engine modules of the add-on build the running host embeds
    #addonModules = null;
    #hasStarted = false;

    constructor({ addonDirectory, onRestart, outputDirectory, server }) {
        this.#addonDirectory = addonDirectory;
        this.#outputDirectory = outputDirectory;
        this.#dataDirectory = path.join(outputDirectory, 'data');
        this.#server = server;
        this.#onRestart = onRestart;
    }

    /** Resolves with the running host's address, or the reason none runs, once no build and start is in progress. */
    settled() {
        return this.#pending?.promise ?? Promise.resolve(this.#latest);
    }

    /** Builds and starts the host again when a successful add-on build changed the engine modules the plugin embeds, as the first one does. */
    addonBuilt() {
        const modules = readAddonModules(this.#addonDirectory);
        if (modules !== this.#addonModules) {
            this.#addonModules = modules;
            this.restart();
        }
    }

    /** Builds and starts the host again; the requests for its routes wait meanwhile, and a change during it runs one more after it. */
    restart() {
        if (this.#addonModules === null) {
            return;
        }
        this.#pending ??= Promise.withResolvers();
        if (this.#cycling) {
            this.#again = true;
            return;
        }
        this.#cycling = true;
        void this.#cycle();
    }

    /** Stops the host at once, as this process exits. */
    kill() {
        this.#child?.kill();
    }

    async #cycle() {
        do {
            this.#again = false;
            await this.#stop();
            this.#latest = Object.freeze(await this.#buildAndStart().catch(error => ({ address: null, failure: getErrorMessage(error) })));
        } while (this.#again);
        this.#cycling = false;
        this.#pending.resolve(this.#latest);
        this.#pending = null;
        if (this.#latest.address === null) {
            console.error(`The plugin did not start: ${this.#latest.failure}`);
            console.error('Its routes answer 503 until a change of its sources starts it.');
            return;
        }
        // The first start only completes the page that loaded with the first add-on build
        if (this.#hasStarted) {
            this.#onRestart();
        }
        this.#hasStarted = true;
    }

    // The running host stops first, since it holds its build's files open on Windows
    async #stop() {
        const child = this.#child;
        if (child === null) {
            return;
        }
        this.#child = null;
        if (child.exitCode === null && child.signalCode === null) {
            const exited = new Promise(resolve => {
                child.once('exit', resolve);
            });
            child.kill();
            await exited;
        }
    }

    async #buildAndStart() {
        const startTime = Date.now();
        // Each folder ends in a separator, as the project file and Directory.Build.props join them
        const build = await runProcess('dotnet', [
            'build', path.join(PLUGIN_HOST_DIRECTORY, `${PLUGIN_HOST_NAME}.csproj`),
            '--nologo', '-v:q', '-tl:off', '-clp:NoSummary',
            `-p:WebGPUPlayerDevRoot=${this.#outputDirectory}${path.sep}`,
            `-p:AddonOutputDirectory=${this.#addonDirectory}${path.sep}`
        ]);
        if (build.code !== 0) {
            return { address: null, failure: `Its build failed:\n${build.output}` };
        }
        fs.mkdirSync(this.#dataDirectory, { recursive: true });
        // The build's own executable, which runs on the .NET runtime that built it.
        // Its standard input stays open, unwritten, until this process exits, which stops it even when this process is killed
        const hostFile = path.join(this.#outputDirectory, 'bin', PLUGIN_HOST_NAME, 'Debug', PLUGIN_HOST_NAME + (process.platform === 'win32' ? '.exe' : ''));
        const child = spawn(hostFile, [ '--server', this.#server.url.href, '--data-folder', this.#dataDirectory ], {
            stdio: [ 'pipe', 'pipe', 'inherit' ]
        });
        this.#child = child;
        const { promise, resolve } = Promise.withResolvers();
        let isReady = false;
        readline.createInterface({ input: child.stdout }).on('line', line => {
            if (!isReady && line.startsWith(PLUGIN_HOST_READY_PREFIX)) {
                isReady = true;
                resolve({ address: line.slice(PLUGIN_HOST_READY_PREFIX.length), failure: null });
                return;
            }
            console.log(line);
        });
        child.once('error', error => {
            resolve({ address: null, failure: `It did not start: ${error.message}` });
        });
        child.once('exit', (code, signal) => {
            const failure = signal === null ? `It exited with code ${code}` : `It exited with ${signal}`;
            resolve({ address: null, failure });
            // A host that stops on its own once it listens, not for a restart, leaves its routes unanswered until the next change
            if (isReady && this.#child === child) {
                this.#child = null;
                this.#latest = Object.freeze({ address: null, failure });
                console.error(`The plugin stopped: ${failure}; its routes answer 503 until a change of its sources starts it.`);
            }
        });
        const latest = await promise;
        if (latest.address !== null) {
            console.log(`Plugin built and started in ${Date.now() - startTime} ms.`);
        }
        return latest;
    }
}

function formatEvent(name, data) {
    return `event: ${name}\ndata: ${data}\n\n`;
}

/** Runs a command to its end, and resolves with its exit code and its output, both streams together. */
function runProcess(command, args) {
    const { promise, resolve } = Promise.withResolvers();
    const child = spawn(command, args, { stdio: [ 'ignore', 'pipe', 'pipe' ] });
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => chunks.push(chunk));
    child.once('error', error => {
        resolve({ code: null, output: `${command} did not start: ${error.message}` });
    });
    child.once('close', code => {
        resolve({ code, output: Buffer.concat(chunks).toString('utf8').trim() });
    });
    return promise;
}

/**
 * Returns the engine modules an add-on build carries, as the plugin reads them from its manifest, with each file's content hash,
 * so a build that changed none of them needs no new plugin build; or null before the first build.
 */
function readAddonModules(addonDirectory) {
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(path.join(addonDirectory, ADDON_MANIFEST_FILE_NAME), 'utf8'));
    } catch {
        return null;
    }
    const { decoderPackageSection = null, decoderPackages = [], passes = [] } = manifest;
    // A listed file the build lacks fails the plugin's own check, which its build reports
    const files = [ ...decoderPackages, ...passes ].map(file => {
        try {
            return [ file, crypto.createHash('sha256').update(fs.readFileSync(path.join(addonDirectory, file))).digest('hex') ];
        } catch {
            return [ file, null ];
        }
    });
    return JSON.stringify({ decoderPackageSection, files });
}

function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the server's root address, with its base URL: the origin each request goes to, and the base path in front of each request's path.
 * The address of its /web/ client is refused, since this server serves that.
 */
function parseServer(address) {
    let url;
    try {
        url = new URL(address);
    } catch {
        throw new Error(`"server" is not an address: ${address}`);
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
        throw new Error(`"server" must be an http or https address without credentials, a query, or a fragment: ${address}`);
    }
    let basePath = url.pathname;
    while (basePath.endsWith('/')) {
        basePath = basePath.slice(0, -1);
    }
    if (/\/web(\/|$)/i.test(basePath)) {
        throw new Error(`"server" is the server's address, with its base URL when it has one, not its /web/ client: ${address}`);
    }
    return { basePath, origin: url.origin, url };
}

/** Reads the settings file, or null when there is none; a file that holds no JSON object, or an unknown setting, is refused. */
function readConfigFile(configFile) {
    let text;
    try {
        text = fs.readFileSync(configFile, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
    let config;
    try {
        config = JSON.parse(text);
    } catch (error) {
        throw new Error(`${configFile} is not valid JSON: ${error.message}`);
    }
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
        throw new Error(`${configFile} does not hold a JSON object`);
    }
    const unknownNames = Object.keys(config).filter(name => !Object.hasOwn(DEFAULT_CONFIG, name));
    if (unknownNames.length > 0) {
        throw new Error(`${configFile} holds unknown settings, ${unknownNames.join(', ')}; it takes ${Object.keys(DEFAULT_CONFIG).join(', ')}`);
    }
    return config;
}

/** Checks each setting; an empty server passes, since a new file holds one until it is set. */
function checkConfig(config, configFile) {
    if (typeof config.server !== 'string') {
        throw new Error(`"server" in ${configFile} is not a string`);
    }
    if (config.server !== '') {
        parseServer(config.server);
    }
    if (!Number.isInteger(config.dev_client_port) || config.dev_client_port < 1 || config.dev_client_port > MAXIMUM_PORT) {
        throw new Error(`"dev_client_port" in ${configFile} is not a port number from 1 to ${MAXIMUM_PORT}`);
    }
    if (typeof config.liveReload !== 'boolean') {
        throw new Error(`"liveReload" in ${configFile} is not true or false`);
    }
}

/** Stores the server and the port given on the command line, writes the file with the defaults when there is none, and returns the settings. */
function configure(configFile, options) {
    const stored = readConfigFile(configFile);
    const config = { ...DEFAULT_CONFIG, ...stored };
    if (options.server !== undefined) {
        config.server = options.server;
    }
    if (options.port !== undefined) {
        if (!PORT_PATTERN.test(options.port)) {
            throw new Error(`--port takes a port number, not ${options.port}`);
        }
        config.dev_client_port = Number(options.port);
    }
    checkConfig(config, configFile);
    if (stored === null || Object.keys(DEFAULT_CONFIG).some(name => stored[name] !== config[name])) {
        fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    }
    if (config.server === '') {
        throw new Error(`Set "server" in ${configFile} to your Jellyfin server's address, or pass --server <url>`);
    }
    return config;
}

/** Runs one of this package's build scripts, as the npm scripts run them before webpack. */
function runBuildScript(scriptName) {
    const result = spawnSync(process.execPath, [ path.join(__dirname, scriptName) ], { cwd: CLIENT_DIRECTORY, stdio: 'inherit' });
    if (result.status !== 0) {
        throw new Error(`${scriptName} failed`);
    }
}

/** Creates the add-on's development build into the output folder; loading its configuration runs the engine's asset build. */
function createAddonCompiler(outputDirectory) {
    runBuildScript('build-hls.js');
    runBuildScript('write-host-tsconfig.js');
    // The configuration reads the mode when it loads
    process.env.NODE_ENV = 'development';
    const webpack = require('webpack');
    const configuration = require('../webpack.config');
    configuration.output.path = outputDirectory;
    return webpack(configuration);
}

/**
 * Builds the add-on again on every change of its sources or the engine's, recording each build and telling the live reload events of each success,
 * and the plugin, which embeds the build's engine modules.
 */
function watchAddon(compiler, context) {
    const { build } = context;
    compiler.hooks.invalid.tap(MESSAGE_PREFIX, () => {
        build.begin();
    });
    compiler.watch({}, (error, stats) => {
        if (error || stats.hasErrors()) {
            const failure = error ? error.stack ?? String(error) : stats.toString({ colors: false, preset: 'errors-only' });
            console.error(error ? failure : stats.toString({ colors: true, preset: 'errors-warnings' }));
            console.error('The add-on build failed; index.html shows its errors until a build succeeds.');
            build.finish({ failure, hash: build.latest.hash });
            return;
        }
        if (stats.hasWarnings()) {
            console.warn(stats.toString({ colors: true, preset: 'errors-warnings' }));
        }
        console.log(`Add-on built in ${stats.endTime - stats.startTime} ms.`);
        // Before the build settles, so a page it releases finds the plugin's routes waiting for the plugin's start
        context.pluginHost.addonBuilt();
        build.finish({ failure: null, hash: stats.hash });
        context.events.broadcast(getReloadId(context));
    });
}

/** Returns the id of the latest change a page reloads for, or null before the first successful add-on build. */
function getReloadId(context) {
    const { hash } = context.build.latest;
    return hash === null ? null : `${hash}.${context.revision}`;
}

/** Counts a change other than an add-on build, a plugin restart or a settings page edit, and tells the live reload events of it. */
function reloadPages(context) {
    context.revision += 1;
    const id = getReloadId(context);
    if (id !== null) {
        context.events.broadcast(id);
    }
}

/**
 * Watches the plugin's sources and its host's: a change of the settings page reloads open pages, and any other change of a source builds and starts the plugin again.
 * Each burst of changes, as an editor's save writes, acts once it settles.
 */
function watchPlugin(context) {
    const timers = new Map();
    const later = (name, action) => {
        clearTimeout(timers.get(name));
        timers.set(name, setTimeout(action, CHANGE_DELAY));
    };
    for (const directory of [ PLUGIN_DIRECTORY, PLUGIN_HOST_DIRECTORY ]) {
        fs.watch(directory, { recursive: true }, (eventType, fileName) => {
            const file = fileName?.replaceAll('\\', '/');
            if (file === undefined || BUILD_OUTPUT_PATTERN.test(file)) {
                return;
            }
            if (directory === PLUGIN_DIRECTORY && file.startsWith(`${CONFIGURATION_FOLDER_NAME}/`)) {
                later('configuration', () => {
                    console.log('Settings page changed.');
                    reloadPages(context);
                });
            } else if (PLUGIN_SOURCE_PATTERN.test(file)) {
                later('plugin', () => {
                    console.log('Plugin sources changed; building the plugin again.');
                    context.pluginHost.restart();
                });
            }
        });
    }
}

/**
 * Returns the bootstrap the plugin adds to index.html (Transformations/WebClientFunctions.cs), for this server:
 * the add-on's asset route, and the window factory through which Jellyfin Web's plugin manager imports the add-on's entry.
 * It leaves out the entry the plugin's bootstrap publishes, which turns the add-on's reload of an outdated page off (OutdatedPageReload.ts):
 * the plugin host here embeds the add-on build it started with and starts again only for new engine modules, so its catalog may name an older entry
 * than the page loads, and the live reload events reload pages for each build instead.
 */
function createBootstrapScript(entry) {
    return '<script data-webgpu-player-bootstrap>'
        + `window.WebGPUPlayerConfig = { assetBaseURL: ${JSON.stringify(ASSET_PATH)} };`
        + `window.WebGPUPlayer = () => import(${JSON.stringify(ASSET_PATH + entry)}).then(module => module.default);`
        + '</script>';
}

/**
 * Returns the script that reloads a page once a change other than its own is the latest (getReloadId).
 * A page of a failed build, which has none, reloads at the next change.
 */
function createLiveReloadScript(id) {
    return `<script data-webgpu-player-live-reload>(() => {
    const build = ${JSON.stringify(id)};
    const events = new EventSource(${JSON.stringify(EVENTS_PATH)});
    const reloadForAnotherBuild = event => {
        if (event.data !== build) {
            window.location.reload();
        }
    };
    events.addEventListener('build', reloadForAnotherBuild);
    if (build !== null) {
        events.addEventListener('current', reloadForAnotherBuild);
    }
})();</script>`;
}

function createFailurePage(failure, liveReload) {
    return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>The WebGPU Player add-on build failed</title>'
        + (liveReload ? createLiveReloadScript(null) : '')
        + `</head><body><h1>The WebGPU Player add-on build failed</h1><pre>${escapeHTML(failure)}</pre></body></html>`;
}

/** Reads the entry module the add-on's manifest names. */
function readAddonEntry(addonDirectory) {
    const { entry } = JSON.parse(fs.readFileSync(path.join(addonDirectory, ADDON_MANIFEST_FILE_NAME), 'utf8'));
    if (typeof entry !== 'string' || !ADDON_ENTRY_PATTERN.test(entry)) {
        throw new Error(`${ADDON_MANIFEST_FILE_NAME} in ${addonDirectory} names no add-on entry`);
    }
    return entry;
}

function sendText(request, response, statusCode, contentType, text) {
    const body = Buffer.from(text, 'utf8');
    response.writeHead(statusCode, { 'Cache-Control': NO_STORE, 'Content-Length': body.length, 'Content-Type': contentType });
    response.end(request.method === 'HEAD' ? undefined : body);
}

/**
 * Resolves a request path below a folder to the file there, or null for a path with an empty or hidden segment, or a character Windows reads as a separator or a stream name.
 * Webpack names some chunks after scoped npm packages, so the path is decoded: a browser requests their @ as %40.
 */
function resolveFile(directory, requestPath) {
    let decodedPath;
    try {
        decodedPath = decodeURIComponent(requestPath);
    } catch {
        return null;
    }
    const segments = decodedPath.split('/');
    if (segments.some(segment => segment === '' || segment.startsWith('.') || /[\\:\0]/.test(segment))) {
        return null;
    }
    return path.join(directory, ...segments);
}

/** Sends a file of a folder for a request path; resolves false, having sent nothing, when the folder has no such file. */
async function serveFile(request, response, directory, requestPath) {
    const file = resolveFile(directory, requestPath);
    const stats = file === null ? null : await fs.promises.stat(file).catch(() => null);
    if (stats === null || !stats.isFile()) {
        return false;
    }
    response.writeHead(HTTP_OK, {
        'Cache-Control': NO_STORE,
        'Content-Length': stats.size,
        'Content-Type': CONTENT_TYPES.get(path.extname(file).toLowerCase()) ?? FALLBACK_CONTENT_TYPE
    });
    if (request.method === 'HEAD') {
        response.end();
    } else {
        pipeline(fs.createReadStream(file), response, () => undefined);
    }
    return true;
}

/** Sends Jellyfin Web's index.html with the bootstrap of the latest add-on build, once a build in progress is done; a failed build sends its errors instead. */
async function serveIndex(request, response, context) {
    const build = await context.build.settled();
    if (build.failure !== null) {
        sendText(request, response, HTTP_INTERNAL_SERVER_ERROR, HTML_CONTENT_TYPE, createFailurePage(build.failure, context.config.liveReload));
        return;
    }
    const html = await fs.promises.readFile(path.join(context.webDirectory, 'index.html'), 'utf8');
    if (!HEAD_END_PATTERN.test(html)) {
        throw new Error(`Jellyfin Web's index.html in ${context.webDirectory} has no </head>`);
    }
    const scripts = createBootstrapScript(readAddonEntry(context.addonDirectory))
        + (context.config.liveReload ? createLiveReloadScript(getReloadId(context)) : '');
    sendText(request, response, HTTP_OK, HTML_CONTENT_TYPE, html.replace(HEAD_END_PATTERN, `${scripts}</head>`));
}

/** Sends Jellyfin Web's config.json with the add-on in its plugins, as the plugin's rewrite adds it. */
async function serveWebConfig(request, response, context) {
    const webConfig = JSON.parse(await fs.promises.readFile(path.join(context.webDirectory, 'config.json'), 'utf8'));
    if (!Array.isArray(webConfig.plugins)) {
        throw new Error(`Jellyfin Web's config.json in ${context.webDirectory} has no plugins list`);
    }
    if (!webConfig.plugins.includes(CLIENT_PLUGIN_NAME)) {
        webConfig.plugins.push(CLIENT_PLUGIN_NAME);
    }
    sendText(request, response, HTTP_OK, JSON_CONTENT_TYPE, JSON.stringify(webConfig));
}

/** Returns the server's URL of a request, below its base path. */
function getServerURL(server, requestPath) {
    return new URL(server.origin + server.basePath + requestPath);
}

function getClient(url) {
    return url.protocol === 'https:' ? https : http;
}

/** Returns a request's headers for the server: the server's host, and no headers of this connection. */
function getForwardedHeaders(headers, target) {
    const forwarded = { ...headers, host: target.host };
    for (const name of HOP_BY_HOP_HEADERS) {
        delete forwarded[name];
    }
    return forwarded;
}

/** Whether a URL is the server's: its origin, below its base path. */
function isServerURL(url, server) {
    const { basePath } = server;
    return url.origin === server.origin && (basePath === '' || url.pathname === basePath || url.pathname.startsWith(`${basePath}/`));
}

/**
 * Points a redirect into the server at this server instead, without the server's base path; any other redirect stays as it is.
 * A relative reference stays too, since it resolves the same here.
 */
function rewriteLocation(location, server) {
    if (!location.startsWith('/') && !URL.canParse(location)) {
        return location;
    }
    const target = new URL(location, server.origin);
    if (!isServerURL(target, server)) {
        return location;
    }
    return (target.pathname.slice(server.basePath.length) || '/') + target.search + target.hash;
}

/** Returns an answer's headers for the browser: no headers of the server's connection, and its redirect into the server pointed here. */
function getReturnedHeaders(headers, server) {
    const returned = { ...headers };
    for (const name of HOP_BY_HOP_HEADERS) {
        delete returned[name];
    }
    if (typeof returned.location === 'string') {
        returned.location = rewriteLocation(returned.location, server);
    }
    return returned;
}

/**
 * Returns the target of a read's redirect out of the server, such as to a split tunnel's media host, which this server follows as a browser would.
 * The browser itself could not read that origin's answer from this one, since its CORS allows the server's own web client.
 * Null for an answer that goes to the browser: a redirect into the server, which the browser follows through this one,
 * a navigation's redirect, a write's redirect, whose body is gone, and a redirect past the browser's limit.
 */
function getFollowedRedirect(request, answer, url, redirectCount, server) {
    const { location } = answer.headers;
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    if (!REDIRECT_STATUSES.has(answer.statusCode) || typeof location !== 'string' || !isRead
        || request.headers['sec-fetch-mode'] === 'navigate' || redirectCount === MAXIMUM_REDIRECTS) {
        return null;
    }
    let target;
    try {
        target = new URL(location, url);
    } catch {
        return null;
    }
    if ((target.protocol !== 'http:' && target.protocol !== 'https:') || (redirectCount === 0 && isServerURL(target, server))) {
        return null;
    }
    return target;
}

/** Returns a read's headers for a redirect's target, as a browser sends them once a request leaves its origin: without the page's credentials. */
function getRedirectedHeaders(headers, target) {
    const redirected = getForwardedHeaders(headers, target);
    for (const name of CREDENTIAL_HEADERS) {
        delete redirected[name];
    }
    return redirected;
}

/**
 * Forwards a request to the server, and its answer back; a browser that goes away, as from a video it leaves, ends the server's request too.
 * A read's redirect out of the server is followed here (getFollowedRedirect), so its target's answer comes back instead.
 */
function proxyRequest(request, response, server) {
    // The request in progress: the server's, then each redirect's
    let outgoing = null;
    const send = (url, headers, redirectCount) => {
        outgoing = getClient(url).request(url, { headers, method: request.method }, answer => {
            const redirect = getFollowedRedirect(request, answer, url, redirectCount, server);
            if (redirect !== null) {
                answer.resume();
                send(redirect, getRedirectedHeaders(request.headers, redirect), redirectCount + 1).end();
                return;
            }
            response.writeHead(answer.statusCode, answer.statusMessage, getReturnedHeaders(answer.headers, server));
            pipeline(answer, response, () => undefined);
        });
        outgoing.on('error', error => {
            if (response.headersSent) {
                response.destroy();
                return;
            }
            const host = redirectCount === 0 ? `The Jellyfin server at ${server.origin}` : `${url.origin}, where the Jellyfin server redirected,`;
            sendText(request, response, HTTP_BAD_GATEWAY, TEXT_CONTENT_TYPE, `${host} did not answer: ${error.message}`);
        });
        return outgoing;
    };
    response.on('close', () => {
        if (!response.writableFinished) {
            outgoing.destroy();
        }
    });
    const target = getServerURL(server, request.url);
    pipeline(request, send(target, getForwardedHeaders(request.headers, target), 0), () => undefined);
}

function formatResponseHead(response) {
    const lines = [ `HTTP/1.1 ${response.statusCode} ${response.statusMessage}` ];
    for (let index = 0; index < response.rawHeaders.length; index += 2) {
        lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
    }
    return `${lines.join('\r\n')}\r\n\r\n`;
}

/** Forwards a WebSocket upgrade, such as Jellyfin Web's /socket, and relays both directions once the server accepts it. */
function proxyUpgrade(request, socket, head, server) {
    const target = getServerURL(server, request.url);
    const serverRequest = getClient(target).request(target, { headers: { ...request.headers, host: target.host }, method: request.method });
    serverRequest.on('upgrade', (serverResponse, serverSocket, serverHead) => {
        socket.write(formatResponseHead(serverResponse));
        socket.write(serverHead);
        serverSocket.write(head);
        serverSocket.on('error', () => {
            socket.destroy();
        });
        serverSocket.pipe(socket).pipe(serverSocket);
    });
    // The server refused the upgrade
    serverRequest.on('response', serverResponse => {
        socket.end(`HTTP/1.1 ${serverResponse.statusCode} ${serverResponse.statusMessage}\r\nConnection: close\r\n\r\n`);
        serverResponse.resume();
    });
    serverRequest.on('error', () => {
        socket.destroy();
    });
    socket.on('error', () => {
        serverRequest.destroy();
    });
    serverRequest.end();
}

/** Forwards a request for the plugin's routes to this checkout's plugin, once a build and start in progress is done. */
async function servePluginRoute(request, response, context) {
    const { address, failure } = await context.pluginHost.settled();
    if (address === null) {
        sendText(request, response, HTTP_SERVICE_UNAVAILABLE, TEXT_CONTENT_TYPE, `This checkout's plugin is not running. ${failure}`);
        return;
    }
    const target = new URL(request.url, address);
    const outgoing = http.request(target, { headers: getForwardedHeaders(request.headers, target), method: request.method }, answer => {
        response.writeHead(answer.statusCode, answer.statusMessage, getReturnedHeaders(answer.headers, context.server));
        pipeline(answer, response, () => undefined);
    });
    outgoing.on('error', error => {
        if (response.headersSent) {
            response.destroy();
            return;
        }
        sendText(request, response, HTTP_BAD_GATEWAY, TEXT_CONTENT_TYPE, `This checkout's plugin did not answer: ${error.message}`);
    });
    response.on('close', () => {
        if (!response.writableFinished) {
            outgoing.destroy();
        }
    });
    pipeline(request, outgoing, () => undefined);
}

/** Whether a path is one of the plugin's routes other than the add-on's assets, which this script serves itself. */
function isPluginRoute(pathname) {
    return pathname.startsWith(PLUGIN_ROUTE_PATH) && !pathname.startsWith(ASSET_PATH);
}

/**
 * Whether a request names this server by a loopback host and its own port.
 * Any other Host is a page whose name was rebound to this machine (DNS rebinding), which must not reach the server through it.
 */
function isLoopbackHost(hostHeader, port) {
    if (typeof hostHeader !== 'string') {
        return false;
    }
    let url;
    try {
        url = new URL(`http://${hostHeader}`);
    } catch {
        return false;
    }
    return LOOPBACK_HOST_NAMES.has(url.hostname) && Number(url.port || 80) === port && url.username === '' && url.pathname === '/';
}

/** Serves Jellyfin Web, the add-on, the plugin, and the live reload events, and forwards every other request to the server. */
async function handleRequest(request, response, context) {
    const { pathname, searchParams } = new URL(request.url, 'http://localhost');
    if (isPluginRoute(pathname)) {
        await servePluginRoute(request, response, context);
        return;
    }
    // Only reads are served here otherwise; Jellyfin Web writes only to the server
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        proxyRequest(request, response, context.server);
        return;
    }
    if (pathname === '/' || pathname === '/web') {
        response.writeHead(HTTP_FOUND, { 'Cache-Control': NO_STORE, 'Location': WEB_PATH }).end();
        return;
    }
    if (pathname === EVENTS_PATH) {
        context.events.open(response, getReloadId(context));
        return;
    }
    if (pathname === WEB_PATH || pathname === `${WEB_PATH}index.html`) {
        await serveIndex(request, response, context);
        return;
    }
    if (pathname === `${WEB_PATH}config.json`) {
        await serveWebConfig(request, response, context);
        return;
    }
    const configurationFile = pathname === CONFIGURATION_PAGE_PATH ? CONFIGURATION_FILES.get(searchParams.get('name') ?? '') : undefined;
    if (configurationFile !== undefined && await serveFile(request, response, CONFIGURATION_DIRECTORY, configurationFile)) {
        return;
    }
    // A file the add-on build lacks is never taken from the server, whose add-on is the plugin's own
    if (pathname.startsWith(ASSET_PATH)) {
        if (!await serveFile(request, response, context.addonDirectory, pathname.slice(ASSET_PATH.length))) {
            sendText(request, response, HTTP_NOT_FOUND, TEXT_CONTENT_TYPE, `The add-on build has no ${pathname}`);
        }
        return;
    }
    // The server serves its own pages below /web/ too, such as the dashboard's plugin pages
    if (pathname.startsWith(WEB_PATH) && await serveFile(request, response, context.webDirectory, pathname.slice(WEB_PATH.length))) {
        return;
    }
    proxyRequest(request, response, context.server);
}

function listen(httpServer, port) {
    const { promise, reject, resolve } = Promise.withResolvers();
    httpServer.once('error', error => {
        reject(error.code === 'EADDRINUSE' ? new Error(`Port ${port} is in use on ${LOOPBACK_ADDRESS}; pass --port with another`) : error);
    });
    httpServer.listen(port, LOOPBACK_ADDRESS, resolve);
    return promise;
}

/** Serves the Jellyfin Web build, the live add-on, and the live plugin, against the server the settings name. */
async function serve(options) {
    const config = { ...DEFAULT_CONFIG, ...readConfigFile(options.config) };
    checkConfig(config, options.config);
    if (config.server === '') {
        throw new Error(`"server" in ${options.config} is empty`);
    }
    const server = parseServer(config.server);
    const serverPort = Number(server.url.port) || (server.url.protocol === 'https:' ? 443 : 80);
    if (LOOPBACK_HOST_NAMES.has(server.url.hostname) && serverPort === config.dev_client_port) {
        throw new Error(`"server" names this server itself, port ${config.dev_client_port}`);
    }
    const webDirectory = path.resolve(options['web-client']);
    for (const fileName of WEB_CLIENT_FILE_NAMES) {
        if (!fs.existsSync(path.join(webDirectory, fileName))) {
            throw new Error(`No Jellyfin Web build at ${webDirectory}: ${fileName} is missing`);
        }
    }
    const addonDirectory = path.resolve(options['addon-output']);
    const compiler = createAddonCompiler(addonDirectory);
    const pluginHost = new PluginHost({
        addonDirectory,
        onRestart: () => reloadPages(context),
        outputDirectory: path.resolve(options['plugin-output']),
        server
    });
    // The host is a process of its own, which stops with this one; a signal exits through the exit handlers
    process.on('exit', () => {
        pluginHost.kill();
    });
    for (const signal of [ 'SIGINT', 'SIGTERM' ]) {
        process.once(signal, () => process.exit(1));
    }

    const context = { addonDirectory, build: new AddonBuild(), config, events: new LiveReloadEvents(), pluginHost, revision: 0, server, webDirectory };
    const httpServer = http.createServer((request, response) => {
        if (!isLoopbackHost(request.headers.host, config.dev_client_port)) {
            sendText(request, response, HTTP_FORBIDDEN, TEXT_CONTENT_TYPE, `Open http://${LOOPBACK_ADDRESS}:${config.dev_client_port}${WEB_PATH} instead`);
            return;
        }
        handleRequest(request, response, context).catch(error => {
            console.error(`${MESSAGE_PREFIX}: ${request.method} ${request.url}: ${getErrorMessage(error)}`);
            if (response.headersSent) {
                response.destroy();
            } else {
                sendText(request, response, HTTP_INTERNAL_SERVER_ERROR, TEXT_CONTENT_TYPE, getErrorMessage(error));
            }
        });
    });
    httpServer.on('upgrade', (request, socket, head) => {
        if (!isLoopbackHost(request.headers.host, config.dev_client_port)) {
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            return;
        }
        proxyUpgrade(request, socket, head, server);
    });
    await listen(httpServer, config.dev_client_port);
    console.log(`\nJellyfin Web with the live WebGPU Player add-on and plugin: http://${LOOPBACK_ADDRESS}:${config.dev_client_port}${WEB_PATH}`);
    console.log(`The plugin's routes go to this checkout's plugin, with its data in ${path.join(path.resolve(options['plugin-output']), 'data')}`);
    console.log(`Every other request goes to ${server.url.href}`);
    console.log(config.liveReload ?
        'The add-on and the plugin build again on every change, and open pages reload after each successful build and each settings page edit.' :
        'The add-on and the plugin build again on every change; reload the page to run a new build.');
    watchAddon(compiler, context);
    watchPlugin(context);
}

async function main() {
    const { positionals, values } = parseArgs({
        allowPositionals: true,
        options: {
            'addon-output': { type: 'string' },
            'plugin-output': { type: 'string' },
            'config': { type: 'string' },
            'port': { type: 'string' },
            'server': { type: 'string' },
            'web-client': { type: 'string' }
        }
    });
    const [ command ] = positionals;
    const requiredOptions = command === 'serve' ? [ 'config', 'web-client', 'addon-output', 'plugin-output' ] : [ 'config' ];
    if (positionals.length !== 1 || (command !== 'configure' && command !== 'serve')) {
        throw new Error('Usage: serve-jellyfin-web-client.js configure --config <file> [--server <url>] [--port <port>], '
            + 'or serve --config <file> --web-client <folder> --addon-output <folder> --plugin-output <folder>');
    }
    for (const name of requiredOptions) {
        if (values[name] === undefined) {
            throw new Error(`${command} needs --${name}`);
        }
    }
    if (command === 'configure') {
        configure(values.config, values);
        return;
    }
    await serve(values);
}

main().catch(error => {
    console.error(`${MESSAGE_PREFIX}: ${getErrorMessage(error)}`);
    // The server may be listening already
    process.exit(1);
});

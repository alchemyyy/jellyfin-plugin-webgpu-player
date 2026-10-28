// Serves a Jellyfin Web build with the live WebGPU Player add-on on 127.0.0.1, and proxies every other request to a Jellyfin server.
// serve_jellyfin_web_client.sh in the plugin root runs it: `configure` stores and checks the settings before the script's long first steps, then `serve`.
// The add-on builds as `npm run build:development` does, and again on every change, into a folder of its own, so the plugin's add-on build in bin/ stays as it is
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawnSync } = require('child_process');
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
// The live reload events, served here; Jellyfin has no route below this path
const EVENTS_PATH = '/__webgpu-player-dev/events';
const ADDON_MANIFEST_FILE_NAME = 'addon-manifest.json';
const ADDON_ENTRY_PATTERN = /^plugin\.[0-9a-f]+\.js$/;
// The name the plugin adds to config.json's plugins; Jellyfin Web's plugin manager loads the window factory of that name
const CLIENT_PLUGIN_NAME = 'WebGPUPlayer';
const WEB_CLIENT_FILE_NAMES = [ 'index.html', 'config.json' ];
const HEAD_END_PATTERN = /<\/head>/i;
// The settings file's settings, with their defaults, in the order the file lists them
const DEFAULT_CONFIG = Object.freeze({
    server: '',
    port: 5173,
    liveReload: true
});
const PORT_PATTERN = /^\d+$/;
const MAXIMUM_PORT = 65535;
// The headers of one connection (RFC 9110, section 7.6.1), which a proxy does not forward
const HOP_BY_HOP_HEADERS = [ 'connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'upgrade' ];
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
const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_BAD_GATEWAY = 502;

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

/** The open live reload event streams, which hear of each successful add-on build. */
class LiveReloadEvents {
    #streams = new Set();

    /** Opens an event stream; it hears of the latest successful build at once, so a page that missed a build reloads. */
    open(response, latestHash) {
        response.writeHead(HTTP_OK, { 'Cache-Control': NO_STORE, 'Content-Type': 'text/event-stream' });
        if (latestHash !== null) {
            response.write(formatEvent('current', latestHash));
        }
        this.#streams.add(response);
        response.on('close', () => {
            this.#streams.delete(response);
        });
    }

    /** Tells every open stream of a successful build. */
    broadcast(hash) {
        for (const stream of this.#streams) {
            stream.write(formatEvent('build', hash));
        }
    }
}

function formatEvent(name, data) {
    return `event: ${name}\ndata: ${data}\n\n`;
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
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > MAXIMUM_PORT) {
        throw new Error(`"port" in ${configFile} is not a port number from 1 to ${MAXIMUM_PORT}`);
    }
    if (typeof config.liveReload !== 'boolean') {
        throw new Error(`"liveReload" in ${configFile} is not true or false`);
    }
}

/** Stores the server and port given on the command line, writes the file with the defaults when there is none, and returns the settings. */
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
        config.port = Number(options.port);
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

/** Builds the add-on again on every change of its sources or the engine's, recording each build and telling the live reload events of each success. */
function watchAddon(compiler, build, events) {
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
        build.finish({ failure: null, hash: stats.hash });
        events.broadcast(stats.hash);
    });
}

/**
 * Returns the bootstrap the plugin adds to index.html (Transformations/WebClientFunctions.cs), for this server:
 * the add-on's asset route, and the window factory through which Jellyfin Web's plugin manager imports the add-on's entry.
 */
function createBootstrapScript(entry) {
    return '<script data-webgpu-player-bootstrap>'
        + `window.WebGPUPlayerConfig = { assetBaseURL: ${JSON.stringify(ASSET_PATH)} };`
        + `window.WebGPUPlayer = () => import(${JSON.stringify(ASSET_PATH + entry)}).then(module => module.default);`
        + '</script>';
}

/**
 * Returns the script that reloads a page once a successful add-on build other than its own is the latest.
 * A page of a failed build, which has none, reloads at the next successful build.
 */
function createLiveReloadScript(hash) {
    return `<script data-webgpu-player-live-reload>(() => {
    const build = ${JSON.stringify(hash)};
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
        + (context.config.liveReload ? createLiveReloadScript(build.hash) : '');
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

/**
 * Points a redirect into the server at this server instead, without the server's base path; any other redirect stays as it is.
 * A relative reference stays too, since it resolves the same here.
 */
function rewriteLocation(location, server) {
    if (!location.startsWith('/') && !URL.canParse(location)) {
        return location;
    }
    const target = new URL(location, server.origin);
    const { basePath } = server;
    if (target.origin !== server.origin || (basePath !== '' && target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`))) {
        return location;
    }
    return (target.pathname.slice(basePath.length) || '/') + target.search + target.hash;
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

/** Forwards a request to the server, and its answer back; a browser that goes away, as from a video it leaves, ends the server's request too. */
function proxyRequest(request, response, server) {
    const target = getServerURL(server, request.url);
    const serverRequest = getClient(target).request(target, { headers: getForwardedHeaders(request.headers, target), method: request.method }, serverResponse => {
        response.writeHead(serverResponse.statusCode, serverResponse.statusMessage, getReturnedHeaders(serverResponse.headers, server));
        pipeline(serverResponse, response, () => undefined);
    });
    serverRequest.on('error', error => {
        if (response.headersSent) {
            response.destroy();
            return;
        }
        sendText(request, response, HTTP_BAD_GATEWAY, TEXT_CONTENT_TYPE, `The Jellyfin server at ${server.origin} did not answer: ${error.message}`);
    });
    response.on('close', () => {
        if (!response.writableFinished) {
            serverRequest.destroy();
        }
    });
    pipeline(request, serverRequest, () => undefined);
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

/** Serves Jellyfin Web, the add-on, and the live reload events, and forwards every other request to the server. */
async function handleRequest(request, response, context) {
    const { pathname } = new URL(request.url, 'http://localhost');
    // Only reads are served here; Jellyfin Web writes only to the server
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        proxyRequest(request, response, context.server);
        return;
    }
    if (pathname === '/' || pathname === '/web') {
        response.writeHead(HTTP_FOUND, { 'Cache-Control': NO_STORE, 'Location': WEB_PATH }).end();
        return;
    }
    if (pathname === EVENTS_PATH) {
        context.events.open(response, context.build.latest.hash);
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

/** Serves the Jellyfin Web build and the live add-on, against the server the settings name. */
async function serve(options) {
    const config = { ...DEFAULT_CONFIG, ...readConfigFile(options.config) };
    checkConfig(config, options.config);
    if (config.server === '') {
        throw new Error(`"server" in ${options.config} is empty`);
    }
    const server = parseServer(config.server);
    const serverPort = Number(server.url.port) || (server.url.protocol === 'https:' ? 443 : 80);
    if (LOOPBACK_HOST_NAMES.has(server.url.hostname) && serverPort === config.port) {
        throw new Error(`"server" names this server itself, port ${config.port}`);
    }
    const webDirectory = path.resolve(options['web-client']);
    for (const fileName of WEB_CLIENT_FILE_NAMES) {
        if (!fs.existsSync(path.join(webDirectory, fileName))) {
            throw new Error(`No Jellyfin Web build at ${webDirectory}: ${fileName} is missing`);
        }
    }
    const addonDirectory = path.resolve(options['addon-output']);
    const compiler = createAddonCompiler(addonDirectory);

    const context = { addonDirectory, build: new AddonBuild(), config, events: new LiveReloadEvents(), server, webDirectory };
    const httpServer = http.createServer((request, response) => {
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
        proxyUpgrade(request, socket, head, server);
    });
    await listen(httpServer, config.port);
    console.log(`\nJellyfin Web with the live WebGPU Player add-on: http://${LOOPBACK_ADDRESS}:${config.port}${WEB_PATH}`);
    console.log(`Every other request goes to ${server.url.href}`);
    console.log(config.liveReload ?
        'The add-on builds again on every change, and open pages reload after each successful build.' :
        'The add-on builds again on every change; reload the page to run a new build.');
    watchAddon(compiler, context.build, context.events);
}

async function main() {
    const { positionals, values } = parseArgs({
        allowPositionals: true,
        options: {
            'addon-output': { type: 'string' },
            'config': { type: 'string' },
            'port': { type: 'string' },
            'server': { type: 'string' },
            'web-client': { type: 'string' }
        }
    });
    const [ command ] = positionals;
    const requiredOptions = command === 'serve' ? [ 'config', 'web-client', 'addon-output' ] : [ 'config' ];
    if (positionals.length !== 1 || (command !== 'configure' && command !== 'serve')) {
        throw new Error('Usage: serve-jellyfin-web-client.js configure --config <file> [--server <url>] [--port <port>], '
            + 'or serve --config <file> --web-client <folder> --addon-output <folder>');
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

// Builds the WebGPU player client add-on into ADDON_OUTPUT_DIRECTORY for the server plugin.
// The add-on runs inside an unmodified Jellyfin Web host, loaded through the plugin manager's window path.
// Host modules come from the read-only Jellyfin Web source tree at JELLYFIN_WEB_DIR; npm packages and loaders come only from this package's node_modules.
// Every folder comes from scripts/constants.js
const path = require('path');
const { execFileSync } = require('child_process');
const CopyPlugin = require('copy-webpack-plugin');
const { Compilation, DefinePlugin, sources } = require('webpack');
const {
    ADDON_OUTPUT_DIRECTORY,
    ADDON_SOURCE_DIRECTORY,
    WEBGPU_PLAYER_BUILD_INFO_FILE,
    WEBGPU_PLAYER_BUILD_SCRIPT,
    WEBGPU_PLAYER_HLS_DIRECTORY,
    WEBGPU_PLAYER_LIBRARY_DIRECTORY,
    WEBGPU_PLAYER_SOURCE_DIRECTORY
} = require('./scripts/constants');
const { resolveJellyfinWebDirectory, resolveJellyfinWebSourceDirectory } = require('./scripts/jellyfin-web');

const DEV_MODE = process.env.NODE_ENV !== 'production';

const ROOT_DIRECTORY = __dirname;
const JELLYFIN_WEB_DIRECTORY = resolveJellyfinWebDirectory();
const HOST_SOURCE_DIRECTORY = resolveJellyfinWebSourceDirectory();
const NODE_MODULES_DIRECTORY = path.resolve(ROOT_DIRECTORY, 'node_modules');
// The host's identity, for host modules that read the build-time definitions
const HOST_PACKAGE_JSON = require(path.join(JELLYFIN_WEB_DIRECTORY, 'package.json'));

// The server plugin imports plugin.<hash>.js named by the manifest
const ENTRY_NAME = 'plugin';
const MANIFEST_FILE_NAME = 'addon-manifest.json';
const UNIQUE_NAME = 'webgpuPlayerAddon';
// Never the host's bare webpackChunk global
const CHUNK_LOADING_GLOBAL = 'webpackChunkWebGPUPlayerAddon';

// The engine assembles its served workers, decoders, licenses, and qualification streams first
execFileSync(
    process.execPath,
    [
        WEBGPU_PLAYER_BUILD_SCRIPT,
        ...(DEV_MODE ? [] : [ '--production' ])
    ],
    { stdio: 'inherit' }
);
const WEBGPU_PLAYER_BUILD_INFO = require(WEBGPU_PLAYER_BUILD_INFO_FILE);

let COMMIT_SHA = '';
try {
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    COMMIT_SHA = execFileSync('git', [ 'describe', '--always', '--dirty' ], {
        cwd: ROOT_DIRECTORY,
        stdio: [ 'ignore', 'pipe', 'ignore' ]
    })
        .toString()
        .trim();
} catch (error) {
    console.warn(`Failed to get the add-on commit SHA: ${error.message.split('\n')[0]}`);
}

function sourcePath(relativePath) {
    return path.normalize(path.resolve(HOST_SOURCE_DIRECTORY, relativePath)).toLowerCase();
}

function addonPath(relativePath) {
    return path.resolve(ADDON_SOURCE_DIRECTORY, relativePath);
}

/** Returns the path relative to the host source directory with forward slashes, or null for other files. */
function getHostSourcePath(resourcePath) {
    const relativePath = path.relative(HOST_SOURCE_DIRECTORY, resourcePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return null;
    }
    return relativePath.split(path.sep).join('/');
}

/** Describes a module for build errors: host modules by absolute path, the others relative to this package. */
function describeModulePath(resourcePath) {
    return getHostSourcePath(resourcePath) === null ?
        path.relative(ROOT_DIRECTORY, resourcePath).split(path.sep).join('/') :
        resourcePath;
}

// Host modules that hold page state, keyed by resolved path.
// The plugin bag supplies the first group as live bindings; the second group is reimplemented, because the host does not expose those instances
const HOST_MODULE_REPLACEMENTS = new Map([
    [ sourcePath('components/playback/playbackmanager.js'), addonPath('host/playbackManager.ts') ],
    [ sourcePath('lib/jellyfin-apiclient/ServerConnections.js'), addonPath('host/serverConnections.ts') ],
    [ sourcePath('scripts/settings/appSettings.js'), addonPath('host/appSettings.ts') ],
    [ sourcePath('components/apphost.js'), addonPath('host/appHost.ts') ],
    [ sourcePath('components/loading/loading.ts'), addonPath('host/loading.ts') ],
    [ sourcePath('components/router/appRouter.js'), addonPath('host/appRouter.ts') ],
    [ sourcePath('lib/globalize/index.js'), addonPath('host/globalize.ts') ],
    [ sourcePath('utils/dashboard.js'), addonPath('host/dashboard.ts') ],
    [ sourcePath('scripts/inputManager.js'), addonPath('host/inputManager.ts') ],
    [ sourcePath('components/toast/toast.ts'), addonPath('host/toast.ts') ],
    [ sourcePath('components/confirm/confirm.ts'), addonPath('host/confirm.ts') ],

    [ sourcePath('scripts/settings/userSettings.js'), addonPath('shims/userSettings.ts') ],
    [ sourcePath('components/layoutManager.js'), addonPath('shims/layoutManager.ts') ],
    [ sourcePath('components/backdrop/backdrop.js'), addonPath('shims/backdrop.ts') ],
    [ sourcePath('scripts/browserDeviceProfile.js'), addonPath('shims/browserDeviceProfile.ts') ],
    [ sourcePath('scripts/settings/webSettings.js'), addonPath('shims/webSettings.ts') ]
]);

// Side-effect modules the host already loaded: re-registering a custom element throws
const EMPTY_MODULE = addonPath('shims/emptyModule.ts');
const HOST_LOADED_MODULE_PREFIXES = [
    sourcePath('elements') + path.sep + 'emby-',
    path.normalize(path.join(NODE_MODULES_DIRECTORY, 'material-design-icons-iconfont')).toLowerCase() + path.sep
];

// Host modules that must never reach the bundle, relative to the host source directory.
// They are the host singletons, the host router, and the stock HTML player, whose fork the add-on carries privately
const FORBIDDEN_HOST_MODULE_PATTERNS = [
    /^components\/playback\/playbackmanager\.js$/i,
    /^lib\/jellyfin-apiclient\/(ServerConnections|connectionManager)[^/]*$/i,
    /^components\/router\//i,
    /^RootAppRouter\.tsx$/i,
    /^plugins\/htmlVideoPlayer\//i,
    /^components\/htmlMediaHelper\.js$/i
];
// Packages that must never reach the bundle: React and the host router
const FORBIDDEN_PACKAGE_PATTERN = /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|@remix-run[\\/]router)[\\/]/i;

function getReplacementPath(resolvedPath) {
    const normalizedPath = path.normalize(resolvedPath).toLowerCase();
    const replacement = HOST_MODULE_REPLACEMENTS.get(normalizedPath);
    if (replacement) {
        return replacement;
    }
    return HOST_LOADED_MODULE_PREFIXES.some(prefix => normalizedPath.startsWith(prefix)) ? EMPTY_MODULE : null;
}

/** Redirects resolved host singleton modules to the add-on bridges and shims, whatever the import specifier. */
class HostModuleRedirectPlugin {
    apply(resolver) {
        const resolvedHook = resolver.ensureHook('resolved');
        resolver.getHook('resolved').tapAsync(
            { name: 'HostModuleRedirectPlugin', stage: -10 },
            (resolveRequest, resolveContext, callback) => {
                const resolvedPath = resolveRequest.path;
                const replacementPath = resolvedPath ? getReplacementPath(resolvedPath) : null;
                if (!replacementPath || path.normalize(replacementPath) === path.normalize(resolvedPath)) {
                    callback();
                    return;
                }
                const descriptionFileRoot = resolveRequest.descriptionFileRoot;
                const redirectedRequest = {
                    ...resolveRequest,
                    path: replacementPath,
                    relativePath: descriptionFileRoot ?
                        './' + path.relative(descriptionFileRoot, replacementPath).split(path.sep).join('/') :
                        resolveRequest.relativePath
                };
                resolver.doResolve(
                    resolvedHook,
                    redirectedRequest,
                    `WebGPU player add-on replaces ${resolvedPath}`,
                    resolveContext,
                    callback
                );
            }
        );
    }
}

/** Fails the build if a forbidden host module is bundled, and reports the host modules that are. */
class HostClosureGuardPlugin {
    apply(compiler) {
        compiler.hooks.thisCompilation.tap('HostClosureGuardPlugin', compilation => {
            compilation.hooks.finishModules.tap('HostClosureGuardPlugin', modules => {
                const hostModules = new Set();
                for (const module of modules) {
                    const resource = module.resource;
                    if (!resource) {
                        continue;
                    }
                    const resourcePath = resource.split('?')[0];
                    const hostSourcePath = getHostSourcePath(resourcePath);
                    const isForbidden = FORBIDDEN_PACKAGE_PATTERN.test(resourcePath)
                        || (hostSourcePath !== null && FORBIDDEN_HOST_MODULE_PATTERNS.some(pattern => pattern.test(hostSourcePath)));
                    if (isForbidden) {
                        const issuer = compilation.moduleGraph.getIssuer(module);
                        compilation.errors.push(new Error(
                            `WebGPU player add-on bundles the host module ${describeModulePath(resourcePath)}`
                            + (issuer?.resource ? `, imported by ${describeModulePath(issuer.resource)}` : '')
                        ));
                    }
                    if (hostSourcePath !== null) {
                        hostModules.add(`src/${hostSourcePath}`);
                    }
                }
                compilation.hostModules = Array.from(hostModules).sort();
            });
        });
        compiler.hooks.done.tap('HostClosureGuardPlugin', stats => {
            const hostModules = stats.compilation.hostModules || [];
            console.log(`\nHost modules bundled into the add-on from ${JELLYFIN_WEB_DIRECTORY} (${hostModules.length}):`);
            for (const hostModule of hostModules) {
                console.log(`  ${hostModule}`);
            }
        });
    }
}

/** Writes addon-manifest.json: the hashed entry file and the engine asset key. */
class AddonManifestPlugin {
    apply(compiler) {
        compiler.hooks.thisCompilation.tap('AddonManifestPlugin', compilation => {
            compilation.hooks.processAssets.tap(
                { name: 'AddonManifestPlugin', stage: Compilation.PROCESS_ASSETS_STAGE_REPORT },
                () => {
                    const entrypoint = compilation.entrypoints.get(ENTRY_NAME);
                    const entryFile = Array.from(entrypoint.getEntrypointChunk().files).find(file => file.endsWith('.js'));
                    if (!entryFile) {
                        compilation.errors.push(new Error('WebGPU player add-on entry produced no JavaScript file'));
                        return;
                    }
                    const manifest = {
                        entry: entryFile,
                        assetKey: WEBGPU_PLAYER_BUILD_INFO.assetKey
                    };
                    compilation.emitAsset(MANIFEST_FILE_NAME, new sources.RawSource(JSON.stringify(manifest, null, 2) + '\n'));
                }
            );
        });
    }
}

// Same packages as Jellyfin Web's webpack.common.js, so shared host code is transpiled identically
const BABEL_NODE_MODULES = [
    '@jellyfin/libass-wasm',
    '@jellyfin/sdk',
    '@mui/base',
    '@mui/lab',
    '@mui/material',
    '@mui/private-theming',
    '@mui/styled-engine',
    '@mui/system',
    '@mui/utils',
    '@mui/x-date-pickers',
    '@react-hook/latest',
    '@react-hook/passive-layout-effect',
    '@react-hook/resize-observer',
    '@remix-run/router',
    '@tanstack/match-sorter-utils',
    '@tanstack/query-core',
    '@tanstack/query-persist-client-core',
    '@tanstack/react-query',
    '@tanstack/react-table',
    '@tanstack/react-virtual',
    '@tanstack/table-core',
    '@tanstack/virtual-core',
    '@uupaa/dynamic-import-polyfill',
    'axios',
    'blurhash',
    'compare-versions',
    'date-fns',
    'dom7',
    'epubjs',
    'flv.js',
    'highlight-words',
    'idb-keyval',
    'libarchive.js',
    'libbitsub',
    'linkify-it',
    'markdown-it',
    'material-react-table',
    'mdurl',
    'proxy-polyfill',
    'punycode',
    'react-blurhash',
    'react-lazy-load-image-component',
    'react-router',
    'remove-accents',
    'screenfull',
    'ssr-window',
    'swiper',
    'usehooks-ts'
];

const BABEL_LOADER = {
    loader: 'babel-loader',
    options: {
        cacheCompression: false,
        cacheDirectory: true
    }
};

const TS_LOADER = {
    loader: 'ts-loader',
    options: {
        transpileOnly: true,
        compilerOptions: { sourceMap: DEV_MODE }
    }
};

const STYLE_LOADERS = [
    // Injected by the bundle; the server plugin serves no add-on stylesheets
    'style-loader',
    'css-loader',
    {
        loader: 'postcss-loader',
        options: {
            postcssOptions: {
                config: path.resolve(ROOT_DIRECTORY, 'postcss.config.js')
            }
        }
    },
    'sass-loader'
];

module.exports = {
    mode: DEV_MODE ? 'development' : 'production',
    devtool: DEV_MODE ? 'eval-cheap-module-source-map' : false,
    context: ROOT_DIRECTORY,
    // The add-on is imported as an ES module, so its runtime may use module-era syntax
    target: [ 'web', 'es2020' ],
    entry: {
        [ENTRY_NAME]: path.join(ADDON_SOURCE_DIRECTORY, 'index.ts')
    },
    experiments: {
        outputModule: true
    },
    output: {
        path: ADDON_OUTPUT_DIRECTORY,
        clean: true,
        filename: '[name].[contenthash].js',
        chunkFilename: '[name].[contenthash].chunk.js',
        assetModuleFilename: '[name].[contenthash][ext]',
        publicPath: 'auto',
        uniqueName: UNIQUE_NAME,
        chunkLoadingGlobal: CHUNK_LOADING_GLOBAL,
        library: {
            type: 'module'
        }
    },
    resolve: {
        alias: {
            // The add-on's own absolute specifiers, which its tests use
            'addons/webGPUPlayer': ADDON_SOURCE_DIRECTORY,
            'webgpu-player': WEBGPU_PLAYER_SOURCE_DIRECTORY,
            // The add-on carries the hls.js fork; the host keeps its own hls.js dependency
            'hls.js': WEBGPU_PLAYER_HLS_DIRECTORY
        },
        extensions: [ '.tsx', '.ts', '.js' ],
        // Absolute directories only, so nothing resolves from a node_modules next to the host source: npm packages come from this package, host modules (components/..., utils/...) from the host source
        modules: [
            NODE_MODULES_DIRECTORY,
            HOST_SOURCE_DIRECTORY
        ],
        plugins: [ new HostModuleRedirectPlugin() ]
    },
    resolveLoader: {
        modules: [ NODE_MODULES_DIRECTORY ]
    },
    plugins: [
        new DefinePlugin({
            __COMMIT_SHA__: JSON.stringify(COMMIT_SHA),
            __JF_BUILD_VERSION__: JSON.stringify(process.env.JELLYFIN_VERSION || 'Release'),
            __PACKAGE_JSON_NAME__: JSON.stringify(HOST_PACKAGE_JSON.name),
            __PACKAGE_JSON_VERSION__: JSON.stringify(HOST_PACKAGE_JSON.version),
            __USE_SYSTEM_FONTS__: !!JSON.parse(process.env.USE_SYSTEM_FONTS || '0'),
            __WEBGPU_PLAYER_ASSET_KEY__: JSON.stringify(WEBGPU_PLAYER_BUILD_INFO.assetKey),
            __WEBPACK_SERVE__: false
        }),
        new CopyPlugin({
            patterns: [
                {
                    // Served unmodified from <BaseUrl>/WebGPUPlayer/assets/libraries/
                    from: WEBGPU_PLAYER_LIBRARY_DIRECTORY,
                    info: { minimized: true },
                    to: 'libraries'
                }
            ]
        }),
        new HostClosureGuardPlugin(),
        new AddonManifestPlugin()
    ],
    optimization: {
        // One entry file holds the static graph; dynamic imports become their own chunks
        runtimeChunk: false,
        splitChunks: {
            chunks: 'async'
        }
    },
    performance: {
        hints: false
    },
    module: {
        rules: [
            {
                // The bridges must provide every name the add-on closure imports from a host module
                test: /\.(js|jsx|ts|tsx)$/,
                include: [ HOST_SOURCE_DIRECTORY, ADDON_SOURCE_DIRECTORY ],
                parser: { exportsPresence: 'error' }
            },
            {
                test: /\.(js|jsx|mjs)$/,
                // Emit `new URL()` module assets such as the libbitsub worker glue verbatim.
                // The worker imports that module directly and cannot resolve core-js imports injected by babel
                dependency: { not: [ 'url' ] },
                include: BABEL_NODE_MODULES.map(packageName => path.resolve(NODE_MODULES_DIRECTORY, packageName))
                    .concat(HOST_SOURCE_DIRECTORY, ADDON_SOURCE_DIRECTORY),
                use: [ BABEL_LOADER ]
            },
            {
                test: /\.(ts|tsx)$/,
                exclude: /node_modules/,
                use: [ TS_LOADER ]
            },
            {
                test: /\.(sa|sc|c)ss$/i,
                use: STYLE_LOADERS
            },
            {
                test: /\.(ico|png|jpg|gif|svg)$/i,
                type: 'asset/resource'
            },
            {
                test: /\.(woff|woff2|eot|ttf|otf)$/,
                type: 'asset/resource'
            }
        ]
    }
};

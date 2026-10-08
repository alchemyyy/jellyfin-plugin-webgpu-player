// Writes tsconfig.host.json, the part of tsconfig.json that depends on JELLYFIN_WEB_DIR: the module specifier paths
// and the host's ambient declaration files. The npm scripts run this before every TypeScript-aware tool
const fs = require('fs');
const path = require('path');
const {
    ADDON_SOURCE_DIRECTORY,
    CLIENT_DIRECTORY,
    WEBGPU_PLAYER_DIRECTORY,
    WEBGPU_PLAYER_SOURCE_DIRECTORY
} = require('./constants');
const { resolveJellyfinWebSourceDirectory } = require('./jellyfin-web');

const HOST_TSCONFIG_FILE = path.join(CLIENT_DIRECTORY, 'tsconfig.host.json');
const DECLARATION_FILE_SUFFIX = '.d.ts';
// The engine's package.json imports, such as #wasm/*, which this package's node module resolution does not read
const WEBGPU_PLAYER_PACKAGE_IMPORTS = require(path.join(WEBGPU_PLAYER_DIRECTORY, 'package.json')).imports ?? {};

function toPosixPath(filePath) {
    return filePath.split(path.sep).join('/');
}

/** Returns a path or path pattern in this package as a tsconfig path, such as ./src. */
function toClientPath(filePath) {
    return `./${toPosixPath(path.relative(CLIENT_DIRECTORY, filePath))}`;
}

/** Returns the tsconfig path pattern for every file in a directory of this package, such as ./src/*. */
function toClientPathPattern(directory) {
    return `${toClientPath(directory)}/*`;
}

/** Returns the target TypeScript resolves for an engine package import: its types condition, else its default. */
function getTypeScriptTarget(specifierPattern, target) {
    const typeScriptTarget = typeof target === 'string' ? target : target?.types ?? target?.default;
    if (typeof typeScriptTarget !== 'string') {
        throw new Error(`The engine's package import ${specifierPattern} has no plain types or default target`);
    }
    return typeScriptTarget;
}

/** Maps each engine package import to the engine files TypeScript reads for it, as tsconfig paths. */
function getWebGPUPlayerImportPaths() {
    const importPaths = {};
    for (const [ specifierPattern, target ] of Object.entries(WEBGPU_PLAYER_PACKAGE_IMPORTS)) {
        const typeScriptTarget = getTypeScriptTarget(specifierPattern, target);
        importPaths[specifierPattern] = [ toClientPath(path.join(WEBGPU_PLAYER_DIRECTORY, typeScriptTarget)) ];
    }
    return importPaths;
}

const hostSourceDirectory = resolveJellyfinWebSourceDirectory();
const hostSourcePath = toPosixPath(hostSourceDirectory);

// Host globals and module declarations (window.ApiClient, jellyfin-apiclient, *.scss) that host modules rely on
const ambientDeclarationFiles = fs.readdirSync(hostSourceDirectory)
    .filter(fileName => fileName.endsWith(DECLARATION_FILE_SUFFIX))
    .sort()
    .map(fileName => `${hostSourcePath}/${fileName}`);

const hostTsconfig = {
    compilerOptions: {
        paths: {
            'addons/webGPUPlayer/*': [ toClientPathPattern(ADDON_SOURCE_DIRECTORY) ],
            'webgpu-player/*': [ toClientPathPattern(WEBGPU_PLAYER_SOURCE_DIRECTORY) ],
            ...getWebGPUPlayerImportPaths(),
            // Same order as webpack's resolve.modules: npm packages from the client, then host modules
            '*': [ './node_modules/*', './node_modules/@types/*', `${hostSourcePath}/*` ]
        }
    },
    files: ambientDeclarationFiles
};

const content = `${JSON.stringify(hostTsconfig, null, 2)}\n`;
// An unchanged file keeps its timestamp, so watchers do not rebuild
const currentContent = fs.existsSync(HOST_TSCONFIG_FILE) ? fs.readFileSync(HOST_TSCONFIG_FILE, 'utf8') : null;
if (currentContent !== content) {
    fs.writeFileSync(HOST_TSCONFIG_FILE, content);
    console.log(`Wrote ${path.relative(CLIENT_DIRECTORY, HOST_TSCONFIG_FILE)} for ${hostSourceDirectory}`);
}

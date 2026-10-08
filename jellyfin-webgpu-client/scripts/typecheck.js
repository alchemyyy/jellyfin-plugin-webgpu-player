// Type-checks the add-on and the engine sources with tsconfig.json, like `tsc --noEmit`.
// Host modules are part of the program, so the add-on is checked against the real host types, but files inside
// JELLYFIN_WEB_DIR are not checked: the host is a read-only input whose own dependencies (React, MUI, TanStack
// Query) the add-on neither installs nor bundles
const path = require('path');
const ts = require('typescript');
const { CLIENT_DIRECTORY } = require('./constants');
const { resolveJellyfinWebDirectory } = require('./jellyfin-web');

const TSCONFIG_FILE = path.join(CLIENT_DIRECTORY, 'tsconfig.json');
// The host checkout's own installs, which TypeScript's node_modules fallback would otherwise reach from host files
const HOST_INSTALL_DIRECTORY_NAMES = [ 'node_modules', 'vendor' ];

function normalizeForComparison(filePath) {
    return path.normalize(filePath).toLowerCase();
}

const jellyfinWebDirectory = resolveJellyfinWebDirectory();
const hostDirectoryPrefix = normalizeForComparison(jellyfinWebDirectory) + path.sep;
const hostInstallDirectoryPrefixes = HOST_INSTALL_DIRECTORY_NAMES
    .map(directoryName => normalizeForComparison(path.join(jellyfinWebDirectory, directoryName)) + path.sep);
const formatHost = {
    getCanonicalFileName: fileName => fileName,
    getCurrentDirectory: () => CLIENT_DIRECTORY,
    getNewLine: () => ts.sys.newLine
};

/** Prints the diagnostics the way tsc does, and returns how many are errors. */
function reportDiagnostics(diagnostics) {
    if (diagnostics.length > 0) {
        const format = process.stdout.isTTY ? ts.formatDiagnosticsWithColorAndContext : ts.formatDiagnostics;
        process.stdout.write(format(diagnostics, formatHost));
    }
    return diagnostics.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error).length;
}

function isHostFile(sourceFile) {
    return normalizeForComparison(sourceFile.fileName).startsWith(hostDirectoryPrefix);
}

function isInHostInstall(fileName) {
    const normalizedFileName = normalizeForComparison(fileName);
    return hostInstallDirectoryPrefixes.some(prefix => normalizedFileName.startsWith(prefix));
}

const configFile = ts.readConfigFile(TSCONFIG_FILE, ts.sys.readFile);
if (configFile.error) {
    reportDiagnostics([ configFile.error ]);
    process.exit(1);
}
const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, CLIENT_DIRECTORY, { noEmit: true }, TSCONFIG_FILE);

// Module resolution as configured, except that nothing resolves into the host checkout's node_modules or vendor
const compilerHost = ts.createCompilerHost(parsedConfig.options);
const moduleResolutionCache = ts.createModuleResolutionCache(
    CLIENT_DIRECTORY,
    fileName => compilerHost.getCanonicalFileName(fileName),
    parsedConfig.options
);
compilerHost.resolveModuleNameLiterals = (moduleLiterals, containingFile, redirectedReference, options, containingSourceFile) =>
    moduleLiterals.map(moduleLiteral => {
        const resolution = ts.resolveModuleName(
            moduleLiteral.text,
            containingFile,
            options,
            compilerHost,
            moduleResolutionCache,
            redirectedReference,
            ts.getModeForUsageLocation(containingSourceFile, moduleLiteral, options)
        );
        const resolvedFileName = resolution.resolvedModule?.resolvedFileName;
        return resolvedFileName && isInHostInstall(resolvedFileName) ? { resolvedModule: undefined } : resolution;
    });

const program = ts.createProgram({
    rootNames: parsedConfig.fileNames,
    options: parsedConfig.options,
    host: compilerHost,
    configFileParsingDiagnostics: parsedConfig.errors
});

const diagnostics = [
    ...program.getConfigFileParsingDiagnostics(),
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics()
];
let checkedSourceFileCount = 0;
let hostFileCount = 0;
for (const sourceFile of program.getSourceFiles()) {
    if (isHostFile(sourceFile)) {
        hostFileCount++;
        continue;
    }
    if (!sourceFile.isDeclarationFile) {
        checkedSourceFileCount++;
    }
    diagnostics.push(...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile));
}

const errorCount = reportDiagnostics(diagnostics);
console.log(
    `Checked ${checkedSourceFileCount} add-on and engine source files; `
    + `${hostFileCount} host files were resolved but not checked; ${errorCount} errors`
);
process.exitCode = errorCount > 0 ? 1 : 0;

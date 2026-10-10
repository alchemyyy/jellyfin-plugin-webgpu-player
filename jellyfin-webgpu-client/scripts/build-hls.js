// Builds the vendored hls.js fork when its dist is missing; webpack aliases hls.js to it.
// Only the rollup bundle the add-on imports: the fork's other bundles go unused, and its type build fails inside this package, because TypeScript's ancestor @types lookup finds conflicting declarations in this package's node_modules
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { CLIENT_DIRECTORY, WEBGPU_PLAYER_HLS_DIRECTORY: HLS_DIRECTORY } = require('./constants');

// The bundle the add-on imports
const HLS_BUNDLE_FILE = path.join(HLS_DIRECTORY, 'dist', 'hls.js');
// The fork's rollup configuration that writes HLS_BUNDLE_FILE
const HLS_BUNDLE_CONFIGURATION = 'full';
// npm run passes this package's configuration down as npm_* variables; the fork is a separate npm project
const NPM_VARIABLE_PATTERN = /^npm_/i;

/** Runs a command line in the fork's directory through the shell, which resolves npm.cmd and npx.cmd on Windows. */
function runInHLSDirectory(commandLine) {
    const environment = Object.fromEntries(
        Object.entries(process.env).filter(([ variableName ]) => !NPM_VARIABLE_PATTERN.test(variableName))
    );
    // Fixed command lines only
    // eslint-disable-next-line sonarjs/os-command
    const result = spawnSync(commandLine, { cwd: HLS_DIRECTORY, env: environment, shell: true, stdio: 'inherit' });
    if (result.status !== 0) {
        throw new Error(`${commandLine} failed in ${HLS_DIRECTORY} (exit code ${result.status})`);
    }
}

/** Builds the fork's bundle that the add-on imports, unless it already exists. */
function buildHLSWhenMissing() {
    if (!fs.existsSync(path.join(HLS_DIRECTORY, 'package.json'))) {
        throw new Error(`The hls.js fork is missing at ${HLS_DIRECTORY}. Run: git submodule update --init`);
    }
    if (fs.existsSync(HLS_BUNDLE_FILE)) {
        console.log(`hls.js fork: using the existing ${path.relative(CLIENT_DIRECTORY, HLS_BUNDLE_FILE)}`);
        return;
    }
    if (!fs.existsSync(path.join(HLS_DIRECTORY, 'node_modules'))) {
        // The rollup build needs no install scripts (husky hooks, chromedriver and Sauce Connect downloads)
        runInHLSDirectory('npm ci --ignore-scripts');
    }
    // The separator keeps newer npm versions from parsing --config as their own option
    runInHLSDirectory(`npx --no -- rollup --config --configType ${HLS_BUNDLE_CONFIGURATION}`);
    if (!fs.existsSync(HLS_BUNDLE_FILE)) {
        throw new Error(`The hls.js build did not create ${HLS_BUNDLE_FILE}`);
    }
}

buildHLSWhenMissing();

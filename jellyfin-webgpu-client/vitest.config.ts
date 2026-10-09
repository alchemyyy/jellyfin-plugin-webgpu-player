/// <reference types="vitest" />
import path from 'path';
import { defineConfig, type Plugin } from 'vite';
import constants from './scripts/constants';
import jellyfinWeb from './scripts/jellyfin-web';

// Module specifiers resolve as in webpack.config.js:
// - the add-on's absolute specifiers, the engine, and the hls.js fork, through aliases;
// - npm packages, from this package's node_modules;
// - host modules (components/..., utils/...), from the read-only Jellyfin Web source tree at JELLYFIN_WEB_DIR.
// Every folder comes from scripts/constants.js

const HOST_SOURCE_PATH = jellyfinWeb.resolveJellyfinWebSourceDirectory().split(path.sep).join('/');
// Resolving from a file of this package finds npm packages in this package's node_modules
const CLIENT_IMPORTER = path.join(constants.CLIENT_DIRECTORY, 'package.json');
// Package names and host module paths, but not relative, absolute, virtual, or protocol (node:) specifiers
const BARE_SPECIFIER_PATTERN = /^[\w@][^:]*$/;
// The add-on's tests import the add-on through its absolute specifiers
const { TESTS_DIRECTORY } = constants;
// Coverage patterns are relative to this package
const ADDON_SOURCE_PATTERN = path.relative(constants.CLIENT_DIRECTORY, constants.ADDON_SOURCE_DIRECTORY).split(path.sep).join('/');

/** Resolves bare specifiers like webpack's resolve.modules: npm packages from this package, then host modules. */
function hostModuleResolution(): Plugin {
    return {
        name: 'webgpu-player-addon-host-modules',
        enforce: 'pre',
        async resolveId(source, importer, options) {
            if (!importer || !BARE_SPECIFIER_PATTERN.test(source)) {
                return null;
            }
            // Host modules import npm packages too; those must not resolve next to the host source
            const packageResolution = await this.resolve(source, CLIENT_IMPORTER, { ...options, skipSelf: true });
            if (packageResolution) {
                return packageResolution;
            }
            return this.resolve(`${HOST_SOURCE_PATH}/${source}`, importer, { ...options, skipSelf: true });
        }
    };
}

export default defineConfig({
    plugins: [ hostModuleResolution() ],
    // Vite serves only this package by default.
    // The test files are entry points outside it that no allowed file imports, so they need an allow entry; host modules load because allowed files import them
    server: {
        fs: {
            allow: [ constants.CLIENT_DIRECTORY, TESTS_DIRECTORY ]
        }
    },
    resolve: {
        alias: {
            'addons/webGPUPlayer': constants.ADDON_SOURCE_DIRECTORY,
            'webgpu-player': constants.WEBGPU_PLAYER_SOURCE_DIRECTORY,
            'hls.js': constants.WEBGPU_PLAYER_HLS_DIRECTORY
        }
    },
    test: {
        coverage: {
            include: [ ADDON_SOURCE_PATTERN ]
        },
        // Only the tests directory is scanned; the vendored engine and hls.js run their own suites with their own configuration
        dir: TESTS_DIRECTORY,
        environment: 'jsdom',
        exclude: [ '**/node_modules/**', '**/dist/**' ],
        restoreMocks: true
    }
});

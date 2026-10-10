// Lints the client add-on and its tests in one ESLint run, which the add-on's `npm run lint` starts here so one thread pool covers both.
// Each directory keeps its own config, which editors and a run inside that directory use; here each applies below its own directory
import path from 'path';
import clientConfigs from './jellyfin-webgpu-client/eslint.config.mjs';
import constants from './jellyfin-webgpu-client/scripts/constants.js';
import testConfigs from './jellyfin-webgpu-client.tests/eslint.config.mjs';

const { CLIENT_DIRECTORY, TESTS_DIRECTORY } = constants;

/** Returns a directory as a pattern relative to this config, such as jellyfin-webgpu-client/. */
function toRootDirectoryPattern(directory) {
    return `${path.relative(import.meta.dirname, directory).split(path.sep).join('/')}/`;
}

/** Applies a directory's config objects below that directory, as that directory's own config file does. */
function scopeToDirectory(configs, directory) {
    return configs.map(config => ({ ...config, basePath: directory }));
}

export default [
    // Nothing else here is the add-on's; the add-on's config ignores the engine, which lints itself
    {
        ignores: [ '*', `!${toRootDirectoryPattern(CLIENT_DIRECTORY)}`, `!${toRootDirectoryPattern(TESTS_DIRECTORY)}` ]
    },
    ...scopeToDirectory(clientConfigs, CLIENT_DIRECTORY),
    ...scopeToDirectory(testConfigs, TESTS_DIRECTORY)
];

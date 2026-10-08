// Locates the read-only Jellyfin Web checkout whose src/ provides the host modules the add-on imports.
// Every build tool resolves host modules from that src/ and npm packages from the client's own node_modules
const fs = require('fs');
const path = require('path');
const { CLIENT_DIRECTORY, DEFAULT_JELLYFIN_WEB_DIRECTORY } = require('./constants');

const JELLYFIN_WEB_DIRECTORY_VARIABLE = 'JELLYFIN_WEB_DIR';
const SOURCE_DIRECTORY_NAME = 'src';

/**
 * Resolves JELLYFIN_WEB_DIR, an absolute path or one relative to the client package, and checks that it holds
 * a Jellyfin Web source tree.
 */
function resolveJellyfinWebDirectory() {
    const configuredDirectory = process.env[JELLYFIN_WEB_DIRECTORY_VARIABLE] || DEFAULT_JELLYFIN_WEB_DIRECTORY;
    const jellyfinWebDirectory = path.resolve(CLIENT_DIRECTORY, configuredDirectory);
    if (!fs.statSync(path.join(jellyfinWebDirectory, SOURCE_DIRECTORY_NAME), { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(
            `No Jellyfin Web source tree at ${jellyfinWebDirectory}. `
            + `Set ${JELLYFIN_WEB_DIRECTORY_VARIABLE} to a jellyfin-web checkout (absolute, or relative to ${CLIENT_DIRECTORY}).`
        );
    }
    return jellyfinWebDirectory;
}

/** Returns the host source directory, <JELLYFIN_WEB_DIR>/src. */
function resolveJellyfinWebSourceDirectory() {
    return path.join(resolveJellyfinWebDirectory(), SOURCE_DIRECTORY_NAME);
}

module.exports = {
    resolveJellyfinWebDirectory,
    resolveJellyfinWebSourceDirectory
};

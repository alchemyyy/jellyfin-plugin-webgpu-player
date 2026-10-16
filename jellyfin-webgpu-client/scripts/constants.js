// The client's folders and the vendored engine's, named once for every build script and tool configuration.
// The engine names its own folders in its tools/constants.json, which is read here rather than restated
const path = require('path');

const CLIENT_DIRECTORY = path.resolve(__dirname, '..');
const ADDON_SOURCE_DIRECTORY = path.join(CLIENT_DIRECTORY, 'src');
// The add-on's tests live beside this package, mirroring src
const TESTS_DIRECTORY = path.resolve(CLIENT_DIRECTORY, '..', 'jellyfin-webgpu-client.tests');
// Next to the .NET build outputs in the repository's bin/; the plugin project embeds it from there
const ADDON_OUTPUT_DIRECTORY = path.resolve(CLIENT_DIRECTORY, '..', 'bin', 'jellyfin-webgpu-client');
// Submodules
const WEBGPU_PLAYER_DIRECTORY = path.join(CLIENT_DIRECTORY, 'vendor', 'webgpu-player');
const WEBGPU_PLAYER_HLS_DIRECTORY = path.join(CLIENT_DIRECTORY, 'vendor', 'webgpu-player-hls');
// The pinned Jellyfin Web, used when JELLYFIN_WEB_DIR is not set
const DEFAULT_JELLYFIN_WEB_DIRECTORY = path.join(CLIENT_DIRECTORY, 'vendor', 'jellyfin-web');

// The one engine path spelled out here; the engine's layout file names the rest
const WEBGPU_PLAYER_LAYOUT = require(path.join(WEBGPU_PLAYER_DIRECTORY, 'tools', 'constants.json'));
const WEBGPU_PLAYER_SOURCE_DIRECTORY = path.join(WEBGPU_PLAYER_DIRECTORY, WEBGPU_PLAYER_LAYOUT.sourceDirectory);
// The engine's asset build, and the asset key and served libraries it writes
const WEBGPU_PLAYER_BUILD_SCRIPT = path.join(WEBGPU_PLAYER_DIRECTORY, WEBGPU_PLAYER_LAYOUT.scriptsDirectory, 'build.mjs');
const WEBGPU_PLAYER_BUILD_INFO_FILE = path.join(WEBGPU_PLAYER_DIRECTORY, WEBGPU_PLAYER_LAYOUT.buildInfoFile);
const WEBGPU_PLAYER_LIBRARY_DIRECTORY = path.join(WEBGPU_PLAYER_DIRECTORY, WEBGPU_PLAYER_LAYOUT.libraryOutputDirectory);
// The engine's built decoder packages and pass files, which the add-on carries for the server plugin to offer,
// and the package format file that names the custom section the plugin reads their headers from
const WEBGPU_PLAYER_DECODER_PACKAGE_DIRECTORY = path.join(WEBGPU_PLAYER_DIRECTORY, WEBGPU_PLAYER_LAYOUT.decoderOutputDirectory);
const WEBGPU_PLAYER_PASS_DIRECTORY = path.join(WEBGPU_PLAYER_DIRECTORY, WEBGPU_PLAYER_LAYOUT.passOutputDirectory);
const WEBGPU_PLAYER_DECODER_PACKAGE_FORMAT_FILE = path.join(WEBGPU_PLAYER_SOURCE_DIRECTORY, 'decode', 'packages', 'DecoderPackageFormat.json');
// The engine's vendored Mediabunny fork, which `mediabunny` resolves to, and the engine script that builds it
const WEBGPU_PLAYER_MEDIABUNNY_DIRECTORY = path.join(WEBGPU_PLAYER_DIRECTORY, WEBGPU_PLAYER_LAYOUT.mediabunnySourceDirectory);
const WEBGPU_PLAYER_MEDIABUNNY_BUILD_SCRIPT = path.join(WEBGPU_PLAYER_DIRECTORY, WEBGPU_PLAYER_LAYOUT.scriptsDirectory, 'mediabunny.mjs');

module.exports = {
    CLIENT_DIRECTORY,
    ADDON_SOURCE_DIRECTORY,
    TESTS_DIRECTORY,
    ADDON_OUTPUT_DIRECTORY,
    DEFAULT_JELLYFIN_WEB_DIRECTORY,
    WEBGPU_PLAYER_DIRECTORY,
    WEBGPU_PLAYER_HLS_DIRECTORY,
    WEBGPU_PLAYER_SOURCE_DIRECTORY,
    WEBGPU_PLAYER_BUILD_SCRIPT,
    WEBGPU_PLAYER_BUILD_INFO_FILE,
    WEBGPU_PLAYER_LIBRARY_DIRECTORY,
    WEBGPU_PLAYER_DECODER_PACKAGE_DIRECTORY,
    WEBGPU_PLAYER_DECODER_PACKAGE_FORMAT_FILE,
    WEBGPU_PLAYER_PASS_DIRECTORY,
    WEBGPU_PLAYER_MEDIABUNNY_DIRECTORY,
    WEBGPU_PLAYER_MEDIABUNNY_BUILD_SCRIPT
};

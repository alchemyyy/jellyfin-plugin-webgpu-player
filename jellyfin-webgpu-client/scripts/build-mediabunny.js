// Builds the engine's vendored Mediabunny fork, which `mediabunny` resolves to, through the engine's own script; it does nothing when the build matches the pinned commit.
// The npm scripts run this before every tool that resolves Mediabunny; webpack gets it through the engine's asset build
const { execFileSync } = require('child_process');
const { WEBGPU_PLAYER_MEDIABUNNY_BUILD_SCRIPT } = require('./constants');

execFileSync(process.execPath, [ WEBGPU_PLAYER_MEDIABUNNY_BUILD_SCRIPT ], { stdio: 'inherit' });

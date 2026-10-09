# Module map

One entry per file or family of the add-on, in `jellyfin-webgpu-client/src/`.
Each source file's tests are at the same relative path under `jellyfin-webgpu-client.tests/`.
The plugin's `README.md` maps the server plugin, and the engine's [Module map](../../jellyfin-webgpu-client/vendor/webgpu-player/docs/book/module-map.html) maps the engine.

- `index.ts`: the add-on entry.
  It configures the engine's assets and feature flags, installs the timing trace control, binds the host bridge, installs the host-compatible mode, and returns the player.
- `TimingTraceControl.ts`: `window.WebGPUPlayerTimingTrace`, which starts, stops, exports, and downloads the engine's timing trace with the build, GPU adapter, screen, and playback metadata, and starts it at load when local storage asks.
- `WebGPUPlayer.ts`: the Jellyfin-facing player: profile augmentation, the stream-copy veto, eligibility, the rAF loop, fallback, renegotiation, and generations.
- `HostCompatibleWebGPUPlayer.ts`: adapts `WebGPUPlayer` to the stock PlaybackManager: purpose-less bitrate requests, the player preference, marked profiles, and superseded starts that never settle.
- `HTMLPlayerDelegate.ts`: owns one HTML player and forwards its events for the current generation only.
- `backend/`: the add-on's own copy of the HTML video player and its media helper, usable as an owned backend.
- `custom/CustomDeviceProfile.ts`: `augmentDeviceProfileForCustomDecode` and `createBitrateIndependentDeviceProfile`.
- `custom/NativeDirectPlayCompatibility.ts`: checks the stock profile against the chosen source, the proof for same-session fallback.
- `compat/`: stand-ins for the PlaybackManager seams stock Jellyfin Web lacks: the PlaybackInfo interceptor and its policies, PlaybackManager hooks, and the settings entry points.
- `host/`, `shims/`: host singletons bound late from the plugin bag, and replacements for host modules the add-on cannot import.
- `WebGPUUserSettings.ts`, `WebGPUPlaybackPreferences.ts`, `PreferredVideoPlayer.ts`: local per-user settings (v2), the custom decode and HDR tone mapping preferences, and the Auto, WebGPU, or HTML player preference.
- `ui/WebGPUPlaybackSettingsDialog.ts`: the in-player settings panel, with live render and downmix updates and restart-required options marked.
- `strings/`: the add-on's text; `en-us.json` is the source, and each translation is a `<locale>.json` beside it.

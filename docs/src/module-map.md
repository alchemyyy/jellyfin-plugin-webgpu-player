# Module map

One entry per file or family of the add-on, in `jellyfin-webgpu-client/src/`.
Each source file's tests are at the same relative path under `jellyfin-webgpu-client.tests/`.
The plugin's `README.md` maps the server plugin, and the engine's [Module map](https://alchemyyy.github.io/WebGPU-Player/module-map.html) maps the engine.

- `index.ts`: the add-on entry.
  It configures the engine's assets and feature flags, installs the timing trace control, binds the host bridge, installs the host-compatible mode, and returns the player.
- `TimingTraceControl.ts`: `window.WebGPUPlayerTimingTrace`, which starts, stops, exports, and downloads the engine's timing trace with the build, GPU adapter, screen, and playback metadata, and starts it at load when local storage asks.
- `WebGPUPlayer.ts`: the Jellyfin-facing player: profile augmentation, the stream-copy veto, eligibility, fallback, renegotiation, and generations.
  It runs the engine's presentation setup and frame loop, `PresentationSetup` and `CustomPlaybackFrameLoop`, which every host shares.
- `HostCompatibleWebGPUPlayer.ts`: adapts `WebGPUPlayer` to the stock PlaybackManager: purpose-less bitrate requests, the player preference, marked profiles, and superseded starts that never settle.
- `HTMLPlayerDelegate.ts`: owns one HTML player and forwards its events for the current generation only.
- `backend/`: the add-on's own copy of the HTML video player and its media helper, usable as an owned backend.
- `custom/CustomDeviceProfile.ts`: `augmentDeviceProfileForCustomDecode` and `createBitrateIndependentDeviceProfile`.
- `custom/NativeDirectPlayCompatibility.ts`: checks the stock profile against the chosen source, the proof for same-session fallback.
- `compat/`: stand-ins for the PlaybackManager seams stock Jellyfin Web lacks: the PlaybackInfo interceptor and its policies, PlaybackManager hooks, and the settings entry points.
- `host/`, `shims/`: host singletons bound late from the plugin bag, and replacements for host modules the add-on cannot import.
- `WebGPUUserSettings.ts`, `WebGPUPlaybackPreferences.ts`, `PreferredVideoPlayer.ts`: local per-user settings (v4), the custom decode, HDR tone mapping, and GPU decode slicing preferences, and the Auto, WebGPU, or HTML player preference.
- `PresentationPassStore.ts`: the shader file sources in IndexedDB, which the settings refer to by key, and the presenter's preset built from them.
- `DecoderPackages.ts`: the decoder packages the user adds in this browser, kept in IndexedDB, and what they decode for negotiation.
- `ServerModules.ts`: the server's catalog of decoder packages and pass files, and the packages a playback needs, downloaded then and kept in IndexedDB by id.
- `ServerPresentationPasses.ts`: the server's pass files as the preset holds them: added on demand, and replaced by the server's newer versions.
- `ui/WebGPUPlaybackSettingsDialog.ts`: the in-player settings panel, with live render and downmix updates and restart-required options marked.
- `ui/PresentationSettingsSection.ts`: the panel's presentation and shader pass sections: the HDR output switch, and the shader file list with each pass's plan state and each file's live parameters and constants, the server's passes to add, and the files from this device.
- `ui/DecoderPackageSection.ts`: the panel's decoders section: the user's own packages, and the names of the server's.
- `ui/SettingsPanelHTML.ts`: the HTML helpers the panel's sections share.
- `strings/`: the add-on's text; `en-us.json` is the source, and each translation is a `<locale>.json` beside it.

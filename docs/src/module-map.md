# Module map

One entry per file or family of the add-on, in `jellyfin-webgpu-client/src/`.
Each source file's tests are at the same relative path under `jellyfin-webgpu-client.tests/`.
The plugin's `README.md` maps the server plugin, and the engine's [Module map](https://alchemyyy.github.io/WebGPU-Player/module-map.html) maps the engine.

- `index.ts`: the add-on entry.
  It configures the engine's assets and feature flags, installs the timing trace control, binds the host bridge, starts the probe crash reports, the playback fallback reports, and the capability probe warm-up, installs the outdated page reload and the host-compatible mode, and returns the player.
  Its `renderClientDefaultsEditor` renders the administrator's editor of the client defaults on the plugin's settings page.
- `TimingTraceControl.ts`: `window.WebGPUPlayerTimingTrace`, which starts, stops, exports, and downloads the engine's timing trace with the build, GPU adapter, screen, and playback metadata, and starts it at load when local storage asks.
- `WebGPUPlayer.ts`: the Jellyfin-facing player: profile augmentation, the stream-copy veto, eligibility, fallback, renegotiation, and generations.
  It runs the engine's presentation setup and frame loop, `PresentationSetup` and `CustomPlaybackFrameLoop`, which every host shares.
- `CustomPlaybackMediaElement.ts`: reports a custom playback through its source-less `<video>` to the page's other scripts: the element's playback state and controls, shadowed on the element, and the media events of a playing element; see [Playback in Jellyfin Web](playback.md#the-video-element).
- `HostCompatibleWebGPUPlayer.ts`: adapts `WebGPUPlayer` to the stock PlaybackManager: purpose-less bitrate requests, the player preference, marked profiles, superseded starts that never settle, and the stream head a request's negotiation reads ahead.
- `DirectPlayHeadPrefetch.ts`: the direct-play stream URL a negotiation is predicted to play, the engine's media source for a stream URL, and a player's head reads ahead of their starts, which a start of the same stream claims.
- `HTMLPlayerDelegate.ts`: owns one HTML player and forwards its events for the current generation only.
- `backend/`: the add-on's own copy of the HTML video player and its media helper, usable as an owned backend.
- `custom/CustomDeviceProfile.ts`: `augmentDeviceProfileForCustomDecode` and `createBitrateIndependentDeviceProfile`.
- `custom/PackageRouteSizes.ts`: the picture sizes a decoder package route takes on the device, as steps of Width and Height bounds, by the engine's fit check of each package's header.
- `custom/NativeDirectPlayCompatibility.ts`: checks the stock profile against the chosen source, the proof for same-session fallback.
- `compat/`: stand-ins for the PlaybackManager seams stock Jellyfin Web lacks: the PlaybackInfo interceptor and its policies, PlaybackManager hooks, and the settings entry points.
  `GzipText.ts` gzips the PlaybackInfo bodies the interceptor sends.
  `SettingsEntryPoints.ts` places the OSD's WebGPU Settings button and adds the preferred player control; `PlayerSettingsMenu.ts` adds the WebGPU player toggle and the settings item to the host's player settings menu, and restarts the current video through `playbackManager.play` when the toggle changes its player.
- `host/`, `shims/`: host singletons bound late from the plugin bag, and replacements for host modules the add-on cannot import.
- `WebGPUUserSettings.ts`, `WebGPUPlaybackPreferences.ts`, `PreferredVideoPlayer.ts`: local per-user settings (v5, only the values that differ from the defaults), the custom decode, HDR tone mapping, and GPU decode slicing preferences, the decoder test timing, and the Auto, WebGPU, or HTML player preference.
- `ServerClientDefaults.ts`: the server's defaults for the client settings, read at plugin load and on each sign-in, cached per server, and saved by an administrator.
- `PresentationPassStore.ts`: the shader file sources in IndexedDB, which the settings refer to by key, and the presenter's preset built from them.
- `DecoderPackages.ts`: the decoder packages the user adds in this browser, kept in IndexedDB, and what they decode for negotiation.
- `ServerModules.ts`: the server's catalog of decoder packages and pass files, and the packages a playback needs, downloaded then and kept in IndexedDB by id; it passes each catalog's `addonEntry` to `OutdatedPageReload.ts`.
- `OutdatedPageReload.ts`: reloads a page that loaded an older add-on build than the server's catalog names, once nothing plays, on a library page, at most once per server entry in a tab; see [The client add-on](add-on.md#outdated-pages).
- `ProbeCrashReports.ts`: posts each capability probe crash the engine finds, with its steps, to the server's `WebGPUPlayer/Diagnostics/ProbeCrashes`, at once or with the next sign-in, which logs it; see [The client add-on](add-on.md#probe-crash-reports).
- `PlaybackFallbackReports.ts`: posts each way a playback left the WebGPU route, a presentation fallback, a lost GPU device, a custom playback fallback, or a declined source, once per kind and reason in a page, to the server's `WebGPUPlayer/Diagnostics/PlaybackFallbacks`, which logs it; see [The client add-on](add-on.md#playback-fallback-reports).
- `ServerReportQueue.ts`: the queue both reports post through, with the authorization header Jellyfin Web sends, held until the next sign-in while no user is signed in, and a failed post logged once and not tried again.
- `CapabilityProbeWarmUp.ts`: tells the engine when the host plays, and once the client defaults settle, decides with `DecoderTestTiming.ts` whether the engine's capability probes warm up at load and refresh a stored verdict after use; see [The client add-on](add-on.md#decoder-test-timing).
- `DecoderTestTiming.ts`: the decoder test timing values, the administrator's device types and rules, their parser and wildcard matcher, this client's device type from Jellyfin Web's browser detection and its client, device, and version from the host's appHost, and the decision between them.
- `ServerPresentationPasses.ts`: the server's pass files as the user's own preset holds them: added on demand, and replaced by the server's newer versions at the first play that presents through WebGPU and when the settings panel opens.
- `DefaultPresentationFiles.ts`: the server's default shader preset as a user's default files: resolved against the catalog, downloaded into the pass source store once per preset and file version, and cached per user.
- `ui/WebGPUPlaybackSettingsDialog.ts`: the in-player settings panel, with the settings button placement, live render and downmix updates, restart-required options marked, and the probes that crashed a page of this browser.
- `ui/SettingDefinitions.ts`: what the settings controls show: each numeric setting's label, description, range, and unit, and each select's options.
- `ui/PresentationSettingsSection.ts`: the panel's presentation and shader pass sections: the HDR output and black bar crop switches, the deinterlacing choice, and the shader file list with each pass's plan state and each file's live parameters and constants, the server's passes to add, and the files from this device.
- `ui/DecoderPackageSection.ts`: the panel's decoders section: the user's own packages, and the names of the server's.
- `ui/SettingsPanelHTML.ts`: the HTML helpers the panel's sections share.
- `ui/ClientDefaultsEditor.ts`: the administrator's editor of the server's client defaults, its own chunk: a row per setting, set on the server or showing the built-in value, and the default shader preset with each file's parameters.
- `strings/`: the add-on's text; `en-us.json` is the source, and each translation is a `<locale>.json` beside it.

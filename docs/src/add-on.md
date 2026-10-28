# The client add-on

The add-on is the part of the plugin that runs in Jellyfin Web.
It wraps the engine in a Jellyfin player and supplies the device profile, the settings, and the HTML fallback.

| Path | Holds |
| --- | --- |
| `Jellyfin.Plugin.WebGPUPlayer/` | The server plugin: the web client rewrites, the asset route, and the decoders and passes it offers, with their routes and settings page |
| `jellyfin-webgpu-client/` | The add-on, a private npm package with its sources in `src/` |
| `jellyfin-webgpu-client/vendor/webgpu-player/` | The engine: a submodule, and an npm workspace of the add-on |
| `jellyfin-webgpu-client/vendor/webgpu-player-hls/` | The hls.js fork, a submodule |
| `jellyfin-webgpu-client/vendor/jellyfin-web/` | The Jellyfin Web the add-on builds against: a shallow submodule, read-only |
| `jellyfin-webgpu-client.tests/` | The add-on's Vitest suites, mirroring its `src/` |
| `bin/jellyfin-webgpu-client/` | The add-on build, which the plugin embeds |
| `docs/` | This book |

## How the add-on reaches the page

<div class="diagram">
<a class="diagram-light" href="diagrams/add-on-bootstrap.light.svg"><img src="diagrams/add-on-bootstrap.light.svg" alt="Sequence from the server's rewrites to the player Jellyfin Web constructs"></a>
<a class="diagram-dark" href="diagrams/add-on-bootstrap.dark.svg"><img src="diagrams/add-on-bootstrap.dark.svg" alt="Sequence from the server's rewrites to the player Jellyfin Web constructs"></a>
</div>

1. The server plugin rewrites two Jellyfin Web files, through the File Transformation plugin when it is installed and through its own middleware otherwise.
   `index.html` gets a bootstrap script that sets `window.WebGPUPlayerConfig` (the asset base URL) and defines `window.WebGPUPlayer`, a factory that imports the add-on entry.
   `config.json` gets `WebGPUPlayer` appended to its `plugins` list.
2. Jellyfin Web's plugin manager loads `WebGPUPlayer` through its window plugin path and constructs it with its dependency bag.
3. `jellyfin-webgpu-client/src/index.ts` configures the engine: the asset base is the add-on route plus `libraries/`, the cache key is the engine build's asset key, and `isHDRToneMappingEnabled` reads the user's preference.
   It names the build whose capability probe verdicts the engine stores, the engine's asset key joined with webpack's `__webpack_hash__`, which also changes with the add-on's own probe code and profile rules.
   It then binds the host bridge, starts the capability probe warm-up (`CapabilityProbeWarmUp.ts`), installs the host-compatible mode, and returns a `HostCompatibleWebGPUPlayer`.
   The warm-up runs only with custom decode on and the runtime available, and the engine skips it on a client that asks to save data or has fewer than four threads.
   It tells the engine that PlaybackManager's `isPlaying()` holds background probes, so none runs during a playback; see [Negotiation](negotiation.md).
4. The plugin serves the add-on build at `<BaseUrl>/WebGPUPlayer/assets/<path>`, the engine's served folder included.

## The player

`WebGPUPlayer` (`jellyfin-webgpu-client/src/WebGPUPlayer.ts`) is the player PlaybackManager sees: id `webgpuplayer`, priority 0, and `syncPlayWrapAs = 'htmlvideoplayer'`.
It owns an HTML player, the add-on's own copy in `src/backend/htmlVideoPlayer/`, which is both the HTML backend and the event and UI shell of the custom path.
[Playback in Jellyfin Web](playback.md) and [Negotiation](negotiation.md) follow a session through it.

## Host-compatible mode

The player relies on PlaybackManager seams that stock Jellyfin Web does not have.
The add-on supplies each one itself:

| Missing seam | Stand-in |
| --- | --- |
| Bitrate-free selection, the stream-copy veto, and the second request that sizes a transcode | `compat/PlaybackInfoInterceptor.ts`, an interceptor on the server's axios instance, applying `PlaybackInfoPolicy.ts`, `PlaybackBitratePolicy.ts`, and `PlaybackStreamCopyPolicy.ts`. `MediaSourceSelection.ts` replicates PlaybackManager's choice of source |
| Request generations and superseded starts | `compat/PlaybackManagerHooks.ts` wraps `play`, `nextTrack`, `previousTrack`, `setCurrentPlaylistItem`, and `stop` to cancel a pending WebGPU start. A `play` whose options match the pending request's, comparing items by ID, instead returns that request's promise while its start is pending, so a second click does not restart it. `HostCompatibleWebGPUPlayer.play` never settles a superseded start, and stops the server encodings it requested |
| Player preference ordering | `HostCompatibleWebGPUPlayer.canPlayItem` declines when the user prefers the HTML player, and inside a native app shell |
| The player settings menu and the preference control | `compat/SettingsEntryPoints.ts` adds the "WebGPU Settings" button to the player's OSD, where the user setting `osd.settingsButtonPlacement` places it, and the preferred player control to the Playback settings page, through the DOM. `compat/PlayerSettingsMenu.ts` adds the WebGPU player toggle, and with the `settings-menu` placement the "WebGPU Settings" item, to the OSD's settings menu |
| A listener for source renegotiation | None: the player raises `PlayerEvent.Error`, and PlaybackManager's error retry ladder asks for a transcode |

The OSD button sits before the host's settings button (`before-settings`, the default), after it (`after-settings`), at the end of the control bar (`controls-end`), or not in the bar (`settings-menu`).
`applySettingsButtonPlacement()` places it anew on every OSD page; the settings panel calls it on a change, and a change of the server defaults runs it too.
The button shows only while the WebGPU player is PlaybackManager's current player.

The host's player settings menu has no seam for other items, so a click on the OSD's settings button arms an observer of `document.body`.
The next dialog container that holds an action sheet with the host's `stats` item gets the add-on's items, built with the host's action sheet markup and the classes of the sheet's own items, so the TV and mobile variants match.
The observer stops at that sheet, or after 10 seconds, and a positioned sheet the items grew is moved back inside the viewport by the host's own margins.
"WebGPU player" (On or Off) shows for local video playback outside a native app shell; "WebGPU Settings" shows with the `settings-menu` placement while the WebGPU player is current.
The host closes the sheet on any item click and rejects its menu promise for an id it does not know, as for a cancel; the add-on runs its item once the sheet's `close` event fires.

The toggle stores the video player preference: on is anything but `html`, and a change stores `webgpu` or `html` (`''` when it equals the server's default).
When the WebGPU player's `canPlayItem` now decides the current video differently than the current player, the add-on calls `playbackManager.play` with the queue (`PartCount` cleared, since the queue already holds the parts), the current index, the position (at least one tick, so cinema mode skips the intros), the media source, and the audio and subtitle stream indexes.
PlaybackManager's `onPlaybackChanging` then stops and destroys the current player and reports the stop before the next player starts with a fresh negotiation.
The old player's teardown makes the page's background opaque, and the OSD makes it transparent only as it shows, so once the restart resolves while the OSD still shows, the add-on makes it transparent again; without that, the next player's video stays hidden behind the background.
A live channel tunes again with no position, media source, or stream indexes, and a video without a runtime starts from no position.
Otherwise the toggle only saves, and with SyncPlay, a remote player, an item not on a server, or nothing playing it reports that the change applies from the next playback.

`src/host/` binds the host's singletons from the plugin bag at construction, so evaluating the add-on's modules never touches them.
`src/shims/` replaces host modules the add-on cannot import directly.

## Settings

Every setting is the user's own in the browser profile, else the default an administrator sets on the server, else the add-on's built-in default; the server's decoders and passes are managed on the plugin's settings page (see [Decoders and passes from the server](server-modules.md)).

- `ServerClientDefaults.ts` reads the server's defaults from `GET WebGPUPlayer/ClientDefaults` once a user is signed in, at plugin load and on each `localusersignedin`, and keeps the last read per server in localStorage under `webGPUPlayerClientDefaults-<serverId>`, bound to no user.
  The plugin applies that cached read first, so the page's first settings already follow the server's defaults, and a server with none cached starts from none, so another server's defaults never carry over; a failed read keeps the defaults it has.
  `ClientDefaults.ts` holds them as one flat map, a key per setting, and each setting reads its key's value as it reads a stored value of its own, so a value it refuses leaves the built-in default.
  The settings panel opens, and a new playback negotiates, once a read in progress settles.
- `WebGPUUserSettings.ts` stores render controls, the automatic peak, downmix, the output device, the playback preferences, the presentation settings, and the settings button placement in localStorage under `<userId>-webGPUPlaybackSettings` (version 5).
  A save stores only the values that differ from the defaults at that moment, arrays whole, so every other setting follows the defaults, and a later default the server sets reaches it.
  Restoring a setting's default drops it from storage; a value set equal to its default also follows the default from then on.
- Not defaultable: the audio output device, whose id belongs to the browser, the user's own decoder packages, and the decoder test results, which are a cache.
- The settings button placement says where the video OSD offers the settings panel: before the host's settings button, the default, after it, at the end of the OSD's controls, or as an item of the host's player settings menu.
  A change applies at once through `applySettingsButtonPlacement` of `compat/SettingsEntryPoints.ts`.
- Custom decode and HDR tone mapping (`WebGPUPlaybackPreferences.ts`) default to on.
  They shape the device profile, so a playback keeps the values its negotiation adopted, and a change applies from the next negotiation.
- GPU decode slicing defaults to off, and a playback keeps the value it started with.
  `WebGPUPlayer` hands it to the engine's `createGPUVideoDecodeSessionFactory` with each playback's controller, and with it on, a picture a decoder package decodes on the GPU submits its work in slices, so a presented frame waits behind less decode; the engine book's decisions weigh what it costs.
- The presentation settings are HDR output, off by default, deinterlacing, double rate by default, and the user's WGSL shader files in order, each with its parameter values and its source's key.
  Deinterlacing takes the engine's modes, `double-rate`, `single-rate`, and `off`, and a stored value outside them loads as double rate.
  A file holds one or more passes, as an mpv user shader does, and its passes run in file order and share its parameter values.
  The panel offers a field for each parameter and each constant the file's passes declare, since the engine takes values for both; a constant's change plans the passes again, as a DEFINE's does in mpv.
  A file added from the server's passes also keeps its origin, the server's file name and SHA-256, so a newer version on the server replaces its source.
  A preset holds at most 16 files of at most 16,777,216 characters each; the limit only keeps a mistaken pick, such as a media file, out of storage.
  Stored files of `null` follow the server's [default shader preset](client-defaults.md#the-default-shader-preset-on-clients), which is also the built-in default; any stored list, even an empty one, is the user's own preset.
- The sources live in IndexedDB, in the `passSources` store of the `webGPUPlayerPresentation` database (`PresentationPassStore.ts`), since localStorage holds about 5 MB for everything on the origin.
  Each added file's source gets a key that counts up from 1, and a source goes once neither the panel's settings, the stored settings, nor the default shader files hold its key.
- Version 4 stored every setting; it loads with its values equal to the built-in defaults following the defaults, and the rest as the user's; its empty shader file list was the default then, so it follows the server's default preset.
  Settings of any other version are not read, so they load as the defaults.
- HDR output and deinterlacing apply when `WebGPUPlayer` is constructed, at plugin load, through the presenter's `setHDROutputEnabled` and `setDeinterlaceMode`, so every playback starts with them; the stored files, or the default shader files for a user who follows them, load at the first play that presents through WebGPU, since reading IndexedDB is work that waits for a play request.
  Every change in the settings panel applies live, and the presenter keeps the preset, HDR output, and deinterlacing across sessions; a stored preset that loads after a panel change yields to it.
  When the server's defaults change, the player applies HDR output and deinterlacing again, and loads the default shader files again when the default shader preset changed.
- The settings panel's sections are player controls (the settings button placement), playback, tone mapping and display, presentation (HDR output and deinterlacing), shader passes, audio, and decoders.
  Each setting restores its default, the server's when it sets one, from an icon button beside it, and the audio and full resets restore the defaults the same way.
  The controls render from `ui/SettingDefinitions.ts`, which holds each numeric setting's label, description, range, and unit, and each select's options.
- The playback section's "Clear decoder test results" button calls the engine's `clearStoredCapabilityProbeVerdicts`, so the next negotiation probes this browser again.
  The engine keeps those verdicts in localStorage under its own key, apart from these settings.
- The shader pass section adds files from this device, or from the passes the server offers, which download when added.
  It shows the default shader files while the user follows them; any change stores the list as the user's own, and "Restore default shader passes" follows the default again.
  The panel opens once `ensureDefaultPresentationFiles()` settles, and only the user's own preset takes the server's newer file versions in place.
  The decoder section lists the user's own packages and names the server's.
- The settings panel shows each file with the state of each of its passes from the presenter's plan report: active, waiting for the next playback, or the failed check and its detail.
  A file whose source the store does not hold shows `source-missing` with its key, stays out of the preset, and can be removed.
  A source the store refuses, or a settings save the browser refuses, is reported in the section's status with the browser's error.
- The player preference (Auto, WebGPU, or HTML) is the user setting `preferredVideoPlayer`, stored as `<userId>-preferredVideoPlayer`, and the WebGPU downmix algorithm is `<userId>-webGPUAudioDownmixAlgorithm`.
  Both are read through the `userSettings` shim: the stored value, else the server's default, else Auto and standard Lo/Ro; a value equal to the default is stored empty, so it follows the default.
  Earlier versions stored the built-in value itself on a restore, a reset, or a save of the Playback page, so the shim's first read or write for a user empties a stored Auto or standard Lo/Ro, as version 4 settings migrate, and marks the user with `<userId>-webGPULegacyChoicesMigrated`.

## Build and check

You need Node.js 24 and npm 11, and the engine's decoder toolchain from its [Set up a checkout](https://alchemyyy.github.io/WebGPU-Player/setup.html) chapter.
The server plugin also needs the .NET 10 SDK.
Jellyfin Web is a read-only input, the shallow submodule in `vendor/jellyfin-web/`, pinned to the commit the add-on builds against.

1. In the plugin root, run `git submodule update --init`; the Jellyfin Web submodule is fetched shallow.
   Then run `npm ci` in `jellyfin-webgpu-client/`.
2. To build against another Jellyfin Web checkout, point `JELLYFIN_WEB_DIR` at it, as an absolute path or one relative to `jellyfin-webgpu-client/`.
   The default is the submodule.
3. In `jellyfin-webgpu-client/`, run:

   ```sh
   npm run typecheck
   npm run lint
   npm test
   npm run build
   ```

What they do:

- Every script first writes the ignored `tsconfig.host.json`, which maps the host's module specifiers into `JELLYFIN_WEB_DIR` and the engine's `imports` into `paths`, because the add-on's `node` module resolution does not read them.
- `typecheck` checks the add-on, its tests, and the engine sources against the host's types.
  It reports only the add-on's and the engine's diagnostics, because the host's own dependencies are not installed.
- `lint` runs ESLint once over the add-on and its tests, on worker threads (`--concurrency=auto`), through the plugin root's `eslint.config.mjs`, which applies each directory's own config below it.
  The engine lints itself, with `npm run lint` in `vendor/webgpu-player/`.
  The pinned Jellyfin Web in `vendor/jellyfin-web/` is the host's read-only source, so nothing lints it.
- `test` runs the add-on's suites; `npm test -w webgpu-player` runs the engine's.
- `build` builds the hls.js fork's `dist/hls.js`, the one bundle the add-on imports, when it is missing, runs the engine's asset build, copies `bin/libraries/` (engine) into the add-on's `libraries/`, and writes the add-on to `bin/jellyfin-webgpu-client/`.
  It also copies the engine's decoder packages and pass files, `bin/wgpud/` and `bin/wgpup/` (engine), into the add-on's `wgpud/` and `wgpup/`, which the plugin offers; it stops when the packages are not built.
- `./build.sh` in the plugin root builds the WebAssembly modules (when `bin/wasm/` (engine) is missing), the decoder packages (when `bin/wgpud/` (engine) is missing), the add-on, and the plugin that embeds it.
  Only the add-on build reads them, so they build in the background while `npm ci` and the hls.js fork build run; the packages start once `npm ci` installed the esbuild their check needs.
  Before either starts, without `EMSDK`, a failed Emscripten check installs the pinned Emscripten into `bin/emsdk/` (engine) with `make -C wasm emsdk` (engine).
  Then `cargo --version` in `wasm/libdovi/` (engine) installs the Rust every engine crate pins, since two rustup installs side by side are not safe.

Engine changes must also pass the engine's own checks, from its root.

## Gotchas

- Never write into the Jellyfin Web checkout.
- `node_modules/webgpu-player` is npm's workspace junction to `vendor/webgpu-player`.
  Remove it alone (`cmd /c rmdir`) before deleting `node_modules` with a tool that follows junctions, or the engine checkout is deleted with it.
- After the hls.js submodule moves, delete `vendor/webgpu-player-hls/dist`; the build rebuilds it only when it is missing.
- The external playback tester, which is in neither repository, parses the `getStats()` labels `Playback pipeline`, `Decoded / presented frames`, and `Dropped / queued frames`.
  They come from the `WebGPUStats*` strings in `jellyfin-webgpu-client/src/strings/en-us.json`, so renaming them, or running a translated UI, breaks its playback proof.
  `Dropped / queued frames` counts the frames the session skipped and the stale frames the controller discarded; late frames, the worst lag, and clock resets have rows of their own.
- File Transformation passes Jellyfin's 304 responses through untransformed, so a browser that cached the stock files before the install needs one hard refresh.

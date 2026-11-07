# Decisions

This chapter records settled decisions about the plugin and its add-on.
The engine's [Decisions](https://alchemyyy.github.io/WebGPU-Player/decisions.html) chapter records the engine's.
Dates are month-day in 2026, UTC.
Commit hashes refer to the Jellyfin Web fork's `webgpu-player` branch, where the player was developed until the plugin replaced the fork.

## Integration

- The Jellyfin integration is a server plugin with a client add-on (10-04; the fork was abandoned 10-05).
  Stock Jellyfin Web stays unmodified.
  The add-on loads through Jellyfin Web's window plugin path, and stand-ins replace the PlaybackManager seams the fork had added (see [The client add-on](add-on.md#host-compatible-mode)).
- `WebGPUPlayer.ts` stays in the add-on (10-02).
  It implements Jellyfin Web's player contract: events, superseded starts, device profiles, the HTML delegate, and user settings.
  Moving it into the engine would make the engine Jellyfin-aware, or need a wide host-injection layer.
  A later refactor may move its host-neutral orchestration into an engine session class.
- libbitsub replaces libpgs (10-02).
  This follows upstream and adds VobSub support.
  The custom path drives it through `timeOffset`, measured against the time the source-less video reports, which is the custom clock since 11-06 (see [Playback in Jellyfin Web](playback.md#the-video-element)).
  VobSub reaches it as the Matroska subtitle file the server extracts, requested as `Stream.mks`, the one name every server from 12.1 serves unchanged (10-27); [Direct play support](direct-play-support.md#vobsub-delivery) has the server's rules.
- The server offers the engine's decoder packages and passes, and a client fetches each when it needs it (10-16).
  The add-on build carries every package `bin/wgpud/` (engine) holds and every pass file of `bin/wgpup/` (engine), and an administrator uploads, deletes, enables, and disables them on the plugin's settings page.
  Since 11-02 those are the engine's pinned releases of its decoder and pass repositories, which `./build.sh` installs, rather than packages the build compiles, so a plugin build needs no decoder toolchain.
  A client downloads a package only for a playback that needs its codec and keeps it in IndexedDB by id, so a page loads a stored version again until the server offers another; a pass file downloads when the user adds it.
  An upload replaces the bundled file of its package id or file name, as a package's new version replaces its old one, so an administrator can ship a newer decoder without a plugin release.
- The settings page's state lives in the plugin's data folder, not in the plugin configuration (10-16).
  The uploads are files there already, and the disabled keys beside them in `state.json` make the store one folder, which the tests open without a server.
  The plugin still configures nothing else, so `BasePluginConfiguration` stays empty.
- The client defaults live in the plugin's data folder too, in `client-defaults.json` beside `state.json` (10-27).
  The server checks only the document's shape and stores each value verbatim, and the add-on normalizes every value as it normalizes a user's stored choice.
  So the add-on stays the one owner of each setting's range and options, and a setting the add-on adds or widens needs no plugin change.
- A user's settings store only what differs from the defaults (10-27).
  A full snapshot, as version 4 stored, would pin every value at the defaults of its save, so a default the server sets later would never reach a user who once opened the panel.
  So a value equal to its default follows the default, and restoring a default drops the value; version 4 snapshots load with their built-in values as following the defaults, since the user could not tell them apart from choices.
  The page applies the server's defaults cached by the last read before it reads them again, and waits for a read in progress only where it reads the settings for a decision: opening the panel and a new negotiation.
- The default shader preset is `null` in a user's settings, not a copy of the server's files (10-27).
  A copied list would carry source keys the user's settings own, so a later default preset could never replace it, and an empty list could not tell "no passes" from "follow the server".
  So a user who follows it plays the files `DefaultPresentationFiles.ts` downloads once per preset and file version into its own cache, and an edit in the panel makes a list of the user's own.
  A new version of a default file downloads under a new key rather than replacing the source in place, since the user's own preset may share the old key after an edit.
- The WebGPU player toggle restarts the current video through PlaybackManager rather than swapping players (10-27).
  A player swapped in place would leave PlaybackManager's stream state, progress reports, and the OSD bound to the old one, and a page reload would lose the queue.
  `playbackManager.play` with the queue, index, position, media source, and streams takes the host's own path for a playback that starts while another plays: it stops and destroys the old player, reports the stop, and negotiates afresh for the next.
  With SyncPlay, a remote player, or an item not on a server, a restart could break the session, so the toggle only saves there and applies from the next playback.
  The host's player settings menu has no seam, so the toggle is an item the add-on appends to the action sheet the OSD's settings button opens, and it runs once that sheet has closed.
- An open tab that loaded an older add-on build reloads itself between plays (11-05); [The client add-on](add-on.md#outdated-pages) has the rules.
  `index.html` is `no-cache` and every other add-on file is content-addressed, so a reload always gets the current build, and only a tab that stays open keeps old code, its persistent decode worker included, until someone reloads it.
  The identity is the entry module path, which webpack names by content: the bootstrap publishes the entry it imports in `window.WebGPUPlayerConfig.entry`, rather than the add-on reading its own module URL, which webpack's `publicPath: 'auto'` and the development server would make less direct.
  The server's entry rides on the catalog negotiations read already, so detection costs no request and no timer, and nothing on the playback path; a page learns of a deploy at its next play, and reloads after that play.
  The reload waits for a stop, then 10 seconds without a start or a request, so a queue's next item and a second click keep it off, and it reloads only a library page with no dialog open and no field focused: an allowlist rather than a list of pages to avoid, since a page it does not know only waits longer, while a missed form would lose input.
  A `sessionStorage` guard allows one reload per server entry in a tab, so a stale `index.html` from a cache in between cannot loop; the development server publishes no entry, since its plugin host may embed an older build than the page loads.
- Custom playback reports itself through its source-less `<video>` (11-06); [Playback in Jellyfin Web](playback.md#the-video-element) has the rules.
  Page scripts follow the player through its element, as Jellyfin Enhanced's pause screen, tab-switch pause and resume, and playback rating badge do, and before this they saw an element paused at zero that never played: a pause screen never came on a pause, but could come during playback after any input and a few idle seconds.
  Shadowing the element's members keeps the one element the HTML player owns, with no second element and no captured stream, and marking the reports lets the HTML player's handlers tell them from the element's own events.
  Picture-in-picture shows custom playback through a `<video>` of its own (11-06), as the next entry has it, rather than through this element, where the stream's own media events would mix with the reports.
  The element carries `disablepictureinpicture`, so scripts that ask the element itself for a window skip it.
  Other playback rates stay unsupported on the element, as the rate menu offers none for custom playback, so the element refuses one as a browser refuses a rate it does not support.
  Jellyfin Enhanced's rating in the OSD can show another item's rating with any player: it reads the first `.videoOsdBottom` in the document, which can be a cached, hidden video page of an earlier playback.
- Custom playback's picture-in-picture window plays a copy of each picture the presenter draws, and the frame loop keeps presenting while Chromium paints the hidden page for the window (11-06); [Playback in Jellyfin Web](playback.md#picture-in-picture) has the rules.
  A WebGPU canvas has no picture to read after the task that drew it: in Chrome 156 a copy made in a later task, or in an earlier animation frame callback of the same frame, reads black.
  So the presenter hands each picture to an observer in that task, which copies the picture's region into a 2D canvas whose captured stream the window plays.
  Capturing the presenter's canvas itself would carry the bars around the picture into a window shaped like the page's video box, and would end with any canvas the presenter replaces, as a new color pipeline or a lost device does.
  Before this the frame loop presented nothing while the page was hidden, the usual time to want the window, so a window would have shown a still frame.
  Chromium paints a hidden page while one of its videos is in picture-in-picture (its `kHiddenButPainting` page state), and animation frames keep running there: in Chrome 156 a hidden page ran about 125 a second with a window open and none without one.
  So an animation frame that runs while the page is hidden keeps presentation visible, and a browser that stops painting keeps the hidden page's drain rather than a playback whose frames nobody takes.
  An HTML playback keeps its element's own window even while WebGPU presents it: Chromium disables the video track of a hidden page's video with audio 10 s after the page hides, unless that video is in picture-in-picture, so a copy of WebGPU's picture of it would freeze.

## Negotiation

- Bitrate is telemetry only.
  The first PlaybackInfo request omits bitrate.
  Only a bounded second request may carry it, to size a transcode that was already decided.
- Live performance adaptation must never change the device profile during a session.
- Retries use the stock HTML profile, with no custom widening.
  A custom failure that asks for renegotiation can therefore get `AudioCodecNotSupported` (for example E-AC-3) on the retry.
  Fix the trigger, not the retry profile.
- Dolby Vision is never stream-copied into HLS (08-05).
  Without a veto, the augmented profile lets Jellyfin copy Dolby Vision HEVC into HLS, which Chromium MSE rejects.
  `WebGPUPlayer.supportsVideoStreamCopy()` returns false for Dolby Vision sources, and the add-on sends `AllowVideoStreamCopy=false`.
- A Dolby Vision item advertises its own exact route (10-06).
  Jellyfin labels P4 and P20 by transfer, and labels Dolby Vision over Rext, Main 12, or 8-bit Main in ranges the generic routes do not pair with that profile and depth.
  Widening the generic ranges would advertise those pairs for every item, so the profile asks the engine whether this item has a runtime route and adds exactly its VideoProfile, VideoBitDepth, and VideoRangeType.
- A declared HDR base also waits for the static HDR probes (10-06).
  A Dolby Vision item whose declared PQ or HLG base is not an exact native P7 or P8 base probes Dolby Vision in parallel with the static HDR routes (external first, raw only when no external key is authorized), so its base fallback can be advertised.
  Any other Dolby Vision item waits only for Dolby Vision.
- An identical play request joins the pending start (10-08).
  A second click on the same item while its start is pending used to supersede a healthy session and repeat the item fetch, PlaybackInfo, and worker setup.
  The PlaybackManager hook returns the pending request's promise for a request with the same items and options, and any other request still supersedes it.
- The device profile advertises what decoder packages decode before any is downloaded (10-16).
  Before, only native routes were advertised, so Jellyfin transcoded every codec and variant a package alone decodes, such as MPEG-2, VC-1, AV1 High, and E-AC-3 without a native decoder, before the package fallback ever saw it.
  The user's packages and the server's catalog give each package's codecs, output formats, and header, from which the profile builds per-profile routes and widens the stock AV1 and HEVC ceilings; downloading a package for negotiation alone would cost every negotiation a download.
  Since 10-27 the catalog carries each video package's header, so the routes also bound Width and Height by the sizes the package's `accepts` conditions and the device's buffer limit take, and need `monochrome` where a label holds 4:0:0 streams.
  Jellyfin has no pixel format condition, and its size conditions take no product, so the bound is a staircase of steps at common widths, which refuses a little of what a package takes between two steps rather than offer what it cannot take.
  A 4:0:0 stream under a label Jellyfin gives 4:2:0 too, such as AV1 `main`, still negotiates for a package without `monochrome` and renegotiates after a failed start.
- Interlaced video direct-plays to the custom path wherever the engine deinterlaces it (10-16).
  Every route but Dolby Vision's has deinterlaced since engine 10-15, yet every route profile still required `IsInterlaced=false`, so Jellyfin transcoded the interlaced MPEG-2, VC-1, and H.264 the engine plays.
  A route now requires a progressive scan only for HEVC and JPEG 2000, which code the fields apart, and on the Dolby Vision labels, and the stock scan limit leaves the custom containers as the runtime ceilings do.
  Jellyfin matches an HLS transcode's `ts` and `mp4` against the same codec profiles as a direct play, so the profile cannot keep the limit for transcodes alone; the stream copy veto keeps a transcode deinterlacing instead.
- Every raw HDR route that advertises HDR10 also advertises HDR10Plus (10-09).
  HDR10+ always carries a static HDR10 base, which raw PQ presents, so AV1 and VP9 advertise the label as HEVC does.
  Jellyfin labels a stream HDR10Plus whenever it carries HDR10+ metadata, so a route without the label never direct-plays such a stream.
- Deinterlacing is a presentation setting, not a negotiation one (10-27).
  The engine deinterlaces in the presenter, so every mode plays the same direct-play source and the choice applies live, as HDR output does; the profile never depends on it.
  Double rate stays the default, the engine's own, so a user who never opens the settings keeps the motion of broadcast video.
- The capability probes warm at add-on load, on clients whose decoder test timing runs them in the background, and their stored verdicts are keyed by the add-on build (10-27, amended 11-05).
  The first `getDeviceProfile` of a page ran every probe it selected, about 2.6 s cold on some clients, and held PlaybackInfo until they settled.
  The add-on starts the engine's warm-up when Jellyfin Web constructs the player, which is when the host's PlaybackManager is bound, so the engine can hold its background probes while `isPlaying()` reports a playback, paused ones included.
  The store's build key is the engine's asset key with webpack's `__webpack_hash__`, because the add-on's profile rules and its copy of the probe code change without the engine's assets; a commit hash would not do, since every uncommitted build of a commit reads the same `<sha>-dirty`.
  The settings dialog offers the engine's clear, for a change no fingerprint shows that has not yet failed a start.
- A browser call of a capability probe that stopped the page is blocked for that browser, while the other calls and the background tests go on (11-05).
  On iOS, from version 2.0.0.0, every page load reloaded about 8 s in, in Safari and in the Jellyfin app, until Safari reported that a problem repeatedly occurred, as it does when a page's web content process keeps ending.
  Version 2.0.0.0 started the engine's warm-up at load, which on WebKit runs a probe's first browser call after two 2 s idle bounds; a probe whose call ends the web content process reaches no verdict, so every reload runs it again.
  Version 1.1.0.1 probed only in `getDeviceProfile`, so a page that only browsed never ran one.
  The engine now records each probe's browser calls under a Web Lock of the page, and the next page blocks the call that was in flight when its page stopped, for that build and browser, or retries several such calls one at a time: see [Probes that stop the page](https://alchemyyy.github.io/WebGPU-Player/routes.html#probes-that-stop-the-page).
  The add-on keeps starting the warm-up at load where its decoder test timing allows, since most browsers gain from it, and an affected browser stops once per crashing call, on the first load of a build, rather than on every load; an administrator can keep such clients from running any test until they play, below.
- When the decoder tests run is a client setting under the administrator's device types and rules (11-05); [The client add-on](add-on.md#decoder-test-timing) has the values and the rules syntax.
  A phone used only as a remote control never plays through this player, yet the warm-up ran every test on it at each page load, and on iOS WebKit one of them can stop the page.
  The setting has three values: `background` keeps the warm-up and the engine's refresh of a stored verdict after use, `playback` turns both off so a playback runs the tests it needs, as version 1.1.0.1 did, and `automatic`, the default, leaves it to the administrator.
  It is an ordinary client setting, so an administrator sets the default for every browser on the plugin page and a user who knows better can choose otherwise in the WebGPU settings dialog, while the device types and rules stay the administrator's alone.
  Device types say what most clients need, desktops in the background and phones, tablets, and TVs at playback, and rules handle the exceptions an administrator can name, such as one app or one device.
  The client classifies itself and matches the rules, because Jellyfin Web's browser detection and the values its authorization header sends exist on the page; the server would have to parse the same User-Agent again, and its view of a client is only that header.
  Patterns are wildcards with `*` and `?` over the whole value, not regular expressions, since the values are names and version strings an administrator copies from Dashboard > Devices, a literal `.` or `(` in them must match itself, and no administrator's text should run as a regular expression on every client, where a slow one would cost each page load.
  The decision waits for the client defaults to settle, so it follows the server's latest values, and it applies from the next page load, since the warm-up it gates starts at load.
- A probe crash the engine finds is reported to the server, which writes it to its log (11-05); [The client add-on](add-on.md#probe-crash-reports) has the route and its limits.
  A crash takes its page, and the page's console with it, so nothing the crashed page logged survives for a user to copy into a report.
  The next page knows the crash, but on iOS its storage and console are readable only through a Mac's Web Inspector, which few users who meet the crash have.
  The server's log is the one place an administrator reads with what they already have, under Dashboard > Logs, so the add-on posts each crash there, with the browser calls the probe had in flight, and the settings panel shows the same blocked and suspect calls, grouped by test, to the user.
  The report runs once per crash, on the page that finds it, so it costs nothing on a browser that never crashes, and a failed post is only logged, since the crash stays in the browser's stored verdicts.
- Why a playback left the WebGPU route is reported to the server's log too, once per kind and reason in a page (11-06); [The client add-on](add-on.md#playback-fallback-reports) has the kinds and the route.
  A laptop whose browser had been set to render on Microsoft's software rasterizer, WARP, had no WebGPU adapter, so its presenter fell back and its HEVC sources transcoded, and only its console said why.
  Unlike a crash, a fallback can repeat on every play, so the add-on sends each kind and reason once per page load, and a declined source logs as information, since a transcoded source declines by design.
  A device loss is reported whether or not the presenter recovers, since a recovered loss still names a GPU or driver reset.
- PlaybackInfo bodies are gzipped on the wire rather than the device profile compacted (11-05).
  Every PlaybackInfo POST carries the whole device profile, about 167 KB of JSON with 279 codec profiles, and behind a slow upstream its upload cost about 110 ms of each play while Jellyfin answered in about 20 ms.
  Compacting the profile would change Jellyfin's decisions: StreamBuilder applies the conditions of every applicable codec profile to a transcode target in reverse order, and does not seed `rangetype` from the source, so merging or dropping the repeated VideoRangeType and VideoProfile conditions changes the `rangetype` and `profile` options of HEVC copy and encode targets.
  The add-on therefore sends the same JSON gzipped with `Content-Encoding: gzip`, and the plugin's `PlaybackInfoDecompressionMiddleware` restores it before Jellyfin reads it, so every negotiation decision stays as it was.
- A direct play's stream head is read during the negotiation, and kept only for the exact URL PlaybackManager then plays (11-05).
  The head read went out only after PlaybackInfo, the custom setup, and the decode worker's startup, about 70 to 140 ms of each start behind a redirecting front end, all on the critical path.
  The read starts at the request's first `getDeviceProfile`, the earliest point that knows the item, before the device profile's probes and catalog wait and PlaybackInfo; the PlaybackInfo interceptor would be later by the whole device profile.
  A request is noted through the PlaybackManager hooks, because `getDeviceProfile` without options also serves the item page's version lists, which play nothing.
  The add-on predicts the URL with PlaybackManager's own ApiClient and parameters and keeps the read only when the start's URL, play method, item, source, and `ETag` all match, rather than matching on the item alone, so a transcode, a DirectStream, another version, or a changed file never reads its bytes; the engine matches the URL and pattern again before its run reads the source.
  An item with several versions and none requested is not predicted, since PlaybackInfo's order and PlaybackManager's selection pick among them.
  The URL's parameters follow the Jellyfin Web the add-on is built against; a host that builds them otherwise only loses the read, which the first start cancels.

## Playback robustness

- No asynchronous work before an ordinary HTML start (08-05).
  With custom decode off, `HtmlVideoPlayer.play()` starts synchronously.
  Normalization gain moves only on a fallback from the custom path to HTML.
  Seek completions are revision-guarded, and retired native audio is muted before its asynchronous cleanup.
- Parallel probe sessions cause false failures.
  Three concurrent sessions produced spurious `DirectPlayError`s.
  Diagnose one session at a time.

## Transport

- hls.js is a local fork (08-09).
  The fork streams a partial `mdat` after a complete `moof` and `mdat` header, to stay under the MSE quota on very high bitrate fMP4.
- hls.js is vendored as a submodule (10-02): `alchemyyy/hls.js`, branch `fix/cals2`, at `jellyfin-webgpu-client/vendor/webgpu-player-hls/`.
  The add-on aliases `hls.js` to it, and builds its `dist` when it is missing.
  It replaced a sibling checkout whose `dist` had silently gone stale.

## Repository

- The plugin's documentation is this book (10-09): one mdBook in `docs/`, beside the engine's own book.
  Jellyfin and add-on material lives here; the engine's book covers only the engine.
- Jellyfin Web is vendored as a shallow submodule (10-09): `jellyfin/jellyfin-web` at `jellyfin-webgpu-client/vendor/jellyfin-web/`, read-only.
  Local and release builds read the same pinned commit, which had been pinned only in the release workflow while local builds read a sibling checkout.
  `build.sh --jellyfin-web-path` and `JELLYFIN_WEB_DIR` still name another checkout.
- Live development proxies the developer's server under one origin (10-28).
  `serve_jellyfin_web_client.sh` serves the pinned Jellyfin Web, built in its submodule, and the add-on's watch build on `127.0.0.1`, and forwards every other request, the WebSocket included, to the server.
  The API, media, and the plugin's routes then stay on the page's origin, as when the server serves Jellyfin Web, rather than depending on the server's CORS policy.
  Jellyfin Web served this way never goes past the proxy: the API client it creates from the page's own address takes only that address, not the server's LocalAddress.
  A read the server redirects to another origin, such as a split tunnel's media host, is followed by the proxy, not the browser, without the page's credentials, as a browser follows it.
  Such a host's CORS allows the server's own web client, so the browser could not read its answer from `127.0.0.1`; navigations and writes keep their redirects.
- Live development carries its own plugin (11-02).
  The plugin's routes, `/WebGPUPlayer/...`, go to `Jellyfin.Plugin.WebGPUPlayer.DevHost`, a host of this checkout's plugin that the script builds with the add-on's watch build embedded, and builds and starts again on every change of the plugin's sources.
  The host signs each request in as the server's user its credentials name, from the server's `Users/Me`, so the plugin's administrator routes stay closed to other users; its data folder is the script's own.
  Plugin edits then take effect without deploying the plugin, and the installed plugin and its data stay as they are.
- Live development builds Jellyfin Web in its submodule (11-05), into the gitignored `node_modules/` and `dist/` there, rather than in a second clone of the same commit in the folder to work in.
  The add-on's webpack, Vitest, ESLint, and type check resolve npm packages only from the add-on's `node_modules`, so the host's installs never reach them.
- Unstable builds are GitHub pre-releases of the same plugin, which a second repository manifest, `manifest.json` on the `unstable` branch, lists (11-05).
  Jellyfin merges the versions of every enabled repository that lists a plugin's GUID, and its plugin update task installs the newest version above the installed one, so a server that adds the unstable manifest beside main's follows both, and any other server never sees an unstable build.
  A second GUID would make a second plugin: both would serve the same `/WebGPUPlayer/...` routes, register the same File Transformation ids and client plugin name, and share one data folder and configuration, which Jellyfin names by the assembly, not the GUID.
  A release ends in `.0`, and an unstable build takes the latest release's first three parts and numbers the fourth, so every build sorts above the release it follows and below the next one: a tester's server moves through the builds onto each release, and one that drops the unstable repository keeps its build until the next release passes it, since Jellyfin never downgrades a plugin.
  Each build keeps its pre-release and its manifest entry, so a server can install any earlier build again, and the unstable manifest never lists a release, since Jellyfin lists a version twice when two repositories carry it.
  The version is set in the build alone and the manifest lives on its own branch, so an unstable build commits nothing to `main`.

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
  The custom path drives it through `timeOffset`, measured against the source-less video.
  VobSub reaches it as the Matroska subtitle file the server extracts, requested as `Stream.mks`, the one name every server from 12.1 serves unchanged (10-27); [Direct play support](direct-play-support.md#vobsub-delivery) has the server's rules.
- The server offers the engine's decoder packages and passes, and a client fetches each when it needs it (10-16).
  The add-on build carries every package `bin/wgpud/` (engine) holds and every pass file of `bin/wgpup/` (engine), and an administrator uploads, deletes, enables, and disables them on the plugin's settings page.
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
- The capability probes warm at add-on load, and their stored verdicts are keyed by the add-on build (10-27).
  The first `getDeviceProfile` of a page ran every probe it selected, about 2.6 s cold on some clients, and held PlaybackInfo until they settled.
  The add-on starts the engine's warm-up when Jellyfin Web constructs the player, which is when the host's PlaybackManager is bound, so the engine can hold its background probes while `isPlaying()` reports a playback, paused ones included.
  The store's build key is the engine's asset key with webpack's `__webpack_hash__`, because the add-on's profile rules and its copy of the probe code change without the engine's assets; a commit hash would not do, since every uncommitted build of a commit reads the same `<sha>-dirty`.
  The settings dialog offers the engine's clear, for a change no fingerprint shows that has not yet failed a start.

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
  `serve_jellyfin_web_client.sh` serves a clone of the pinned Jellyfin Web and the add-on's watch build on `127.0.0.1`, and forwards every other request, the WebSocket included, to the server.
  The API, media, and the plugin's routes then stay on the page's origin, as when the server serves Jellyfin Web, rather than depending on the server's CORS policy.
  Jellyfin Web served this way never goes past the proxy: the API client it creates from the page's own address takes only that address, not the server's LocalAddress.
  A read the server redirects to another origin, such as a split tunnel's media host, is followed by the proxy, not the browser, without the page's credentials, as a browser follows it.
  Such a host's CORS allows the server's own web client, so the browser could not read its answer from `127.0.0.1`; navigations and writes keep their redirects.

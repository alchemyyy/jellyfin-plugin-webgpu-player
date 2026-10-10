# Decisions

This chapter records settled decisions about the plugin and its add-on.
The engine's [Decisions](../../jellyfin-webgpu-client/vendor/webgpu-player/docs/book/decisions.html) chapter records the engine's.
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
- Every raw HDR route that advertises HDR10 also advertises HDR10Plus (10-09).
  HDR10+ always carries a static HDR10 base, which raw PQ presents, so AV1 and VP9 advertise the label as HEVC does.
  Jellyfin labels a stream HDR10Plus whenever it carries HDR10+ metadata, so a route without the label never direct-plays such a stream.

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

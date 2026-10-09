# TODO

Open items left after the Dolby Vision and playback-limit work, each with what closing it takes.

## Playback gaps

- 10-bit SDR AV1 and VP9 in BT.601 or BT.2020 color.
  These negotiate, because a profile condition cannot express primaries, and then fail eligibility, because the raw SDR keys are BT.709 only.
  Closing it needs BT.601 and BT.2020 raw SDR keys: an SDR gamut conversion in the raw shader, a CPU reference for each, and first-use authorization vectors.
  8-bit range-extension SDR needs the same keys.
- MP4 Dolby Vision Profile 10.0, the `dav1` sample entry.
  FFmpeg, and so Jellyfin's probe, maps `dav1` to no codec, so the server never offers such a file for direct play.
  A one-line mapping in FFmpeg or jellyfin-ffmpeg fixes it.
  Submitting that patch upstream is a public action and needs the project owner's decision.
  Matroska Profile 10.0 already plays.
- MPEG-2 and VC-1 streams whose picture grows mid-stream.
  The decoder opens at the container's coded size and refuses a later, larger picture, so the item falls back.
  A broadcast transport stream that switches resolution produces such a picture.
  Reopening the decoder at the new size when a sequence header changes it would play them.
- The prebuilt HEVC (`@hevcjs/core`) and OpenJPEG decoders keep Emscripten's default 2 GiB heap.
  A frame whose decoder state does not fit fails in the decoder.
  Rebuilding either package with a 4 GiB heap and reading its returned pointers unsigned would lift the limit.
  The MPEG-2/VC-1 kit already has a 4 GiB heap.
- AVI, and the legacy codecs it usually carries.
  The engine's prefilter declines AVI, FLV, ASF, and MPEG program streams, because no route's container carries them and Mediabunny 1.52.2 demuxes none of them.
  It also declines MPEG-4 Part 2 (DivX, Xvid), H.263, MS-MPEG4, MPEG-1, and Theora in any container, because no route decodes them.
  Jellyfin's HTML player then plays them through a server transcode.
  Closing it takes two halves:
  - Decode: FFmpeg's `mpeg4`, `h263`, and `msmpeg4v3` decoders in a WebAssembly kit (the MPEG-2/VC-1 kit is the nearest), with a qualification vector, a probe, eligibility, and profile rules.
    That alone plays MPEG-4 Part 2 in Matroska and MP4.
  - Demux: an AVI demuxer that feeds the worker's packet sinks, covering RIFF chunks with `idx1` or OpenDML indexes, timestamps from each stream's rate and scale, DivX packed B-frames, and VBR MP3 or AC-3 audio chunks.
- Interlaced video.
  The prefilter, eligibility, and the measured route profiles all require `IsInterlaced` false, so interlaced MPEG-2, H.264, HEVC, and VC-1 go to the HTML player and the server transcodes them.
  Closing it needs a deinterlacer on the custom path before those conditions can drop, such as a field-adaptive WebGPU pass over decoded frames that follows the stream's field order, or FFmpeg's filter in the MPEG-2/VC-1 kit.
- VobSub (`dvdsub`) subtitles.
  The augmented profile lists vtt, ass, ssa, and pgssub only, so the server burns a selected VobSub track in, the play method becomes Transcode, and the custom path is ineligible.
  A 4K source is then re-encoded just to burn in a bitmap.
  The host's libbitsub already renders VobSub.
  Closing it needs a `dvdsub` subtitle profile and a delivery the server supports for an external `.idx`/`.sub` pair (not yet checked), then libbitsub's VobSub path on both backends.

## Startup performance

- Warm the capability probes before the first play.
  Today the first `getDeviceProfile` on a page runs every probe, about 2.6 s cold, and blocks PlaybackInfo.
  Starting them at add-on load hides that, but it competes with library browsing: worker CPU on low-core clients, about 3 MB of vector and wasm fetches against poster loads, and main-thread WebCodecs and `copyTo` readback work.
  Doing it safely needs:
  - An idle gate before each heavy probe is enqueued, `requestIdleCallback` with a timeout, so browsing pauses the queue between probes.
  - Low-priority asset fetches, `fetch(..., { priority: 'low' })`.
  - Promotion to full speed when `getDeviceProfile` asks, so a play is never slower than today.
  - No start while media is playing, and optionally none on weak or constrained clients (`navigator.hardwareConcurrency`, `navigator.connection.saveData`).
  - The idle wait outside `runTimed`, and a background timeout that neither sets the scheduler's `timedOut` poison nor lands in the page-lifetime probe promise; the on-demand path reruns timed-out probes.
- Persist probe verdicts across page loads.
  Every page load reprobes, so each session's first play pays the full probe cost.
  Store the capability result in localStorage, keyed by `__COMMIT_SHA__`, `navigator.userAgent`, and `GPUAdapter.info`.
  The engine asset key alone is not enough: it hashes only the libraries output, not the main-thread probe code or expected fingerprints.
  Persist only definitive `supported` and `unsupported` verdicts, never `timeout` or `error`, using the versioned storage pattern of `WebGPUUserSettings.ts`.
  A cache hit resolves `getDeviceProfile` at once; a background reprobe then refreshes the entry.
  DTS and TrueHD verdicts carry a measured real-time factor that depends on machine load, so their revalidation runs only with no playback active.
  Revalidation is background work with the same contention as warming, so it belongs on the gated scheduler above, or after a playback session ends until that scheduler exists.
  The engine book's `negotiation.md` "Probes and caching" and `decisions.md` change with it.

## Robustness

- Single-layer RPUs that reuse a dual-layer RPU's mapping.
  The bridge does not carry the reused mapping's layer and NLQ flags over.
  Only a malformed stream mixes them, so this is robustness work, not a playback gap.
- Anamorphic AV1.
  Playback is already correct; stripping Jellyfin's `IsAnamorphic` flag is worth doing only if it ever blocks a route.
- Report the Mediabunny defects the engine contains upstream.
  Header-stripped laced Matroska blocks (`CustomDecodeInputFormats.ts`) and the unhandled `close()` after a custom decoder fails (`HandledDecodeFailures.ts`) both remain in Mediabunny 1.61.3; the engine book's `decisions.md` describes them.
  Reporting them is a public action and needs the project owner's decision.

## Settled decisions

- Raw-only HDR items still wait for the external HDR probe.
  The external route's keys shape the HEVC transcode ranges, so the wait stays even for an item that plays only through raw planes.

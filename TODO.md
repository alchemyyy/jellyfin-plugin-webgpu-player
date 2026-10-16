# TODO

Open items left after the Dolby Vision and playback-limit work, each with what closing it takes.

## Playback gaps

5. MPEG-2 streams whose picture grows mid-stream.
   The decoder opens at the container's coded size and refuses a later, larger picture, so the item falls back.
   A broadcast transport stream that switches resolution produces such a picture.
   Reopening the decoder at the new size when a sequence header changes it would play them.
*6. The legacy codecs AVI usually carries, and what the fork's AVI demuxer leaves out.
   Since 10-15 the engine demuxes AVI through the Mediabunny fork (PR #155) and plays H.264, VP8, VP9, and AV1 with AAC, MP3, AC-3, and PCM from it, and the add-on advertises that.
   Eligibility still declines MPEG-4 Part 2 (DivX, Xvid), H.263, MS-MPEG4, and Theora in any container as `video-codec-without-route`, and the worker refuses an `mpeg4` track, so Jellyfin transcodes them.
   FLV, ASF, and MPEG program streams stay undemuxed.
   What remains:
   - Decode: a decoder package for `mpeg4`, `h263`, and `msmpeg4v3` (the MPEG-2 package is the nearest), with self-test vectors, then the worker's `mpeg4` refusal dropped and the add-on's profile rules added.
     The fork identifies MPEG-4 Part 2 in Matroska, MP4, and AVI (PR #156), so a package alone would play it there.
   - DivX packed B-frames: the fork's AVI demuxer does not unpack them, so a packed DivX stream needs that before it plays.
   - OpenDML: the fork reads only `idx1`, so the worker refuses an AVI video track that outruns it (`opendml-index-unread`); an AVI past about 1 GiB needs the `indx` and `ix##` indexes read.
   - Presentation times: AVI stamps packets in decode order, so HEVC in AVI is refused, and H.264 with B-frames relies on Mediabunny's sample sink to reorder, which it does not on WebKit, so WebKit plays only Baseline H.264 from AVI (10-16).
     FFmpeg also writes HEVC in AVI with a zero codec tag unless told otherwise.
   - Audio: WAVE_FORMAT_EXTENSIBLE is unmapped, and FLAC and Vorbis in AVI carry no decoder description the fork reads, so the AVI rule leaves them out.
7. A deinterlacing choice in the add-on's settings.
   Since 10-16 interlaced video direct-plays to the custom path wherever the engine deinterlaces it, always at double rate.
   Jellyfin's MediaStream reports `IsInterlaced` but no field order, so each frame's order comes from its decoder, parser, or container, else top field first.
   A choice in the settings would call `WebGPUPresenter.setDeinterlaceMode` (double rate, single rate, or off).
8. VobSub (`dvdsub`) subtitles.
   The augmented profile lists vtt, ass, ssa, and pgssub only, so the server burns a selected VobSub track in, the play method becomes Transcode, and the custom path is ineligible.
   A 4K source is then re-encoded just to burn in a bitmap.
   The host's libbitsub already renders VobSub.
   Closing it needs a `dvdsub` subtitle profile and a delivery the server supports for an external `.idx`/`.sub` pair (not yet checked), then libbitsub's VobSub path on both backends.
*10. MPEG-2 and VC-1 in MPEG-TS and M2TS: nothing remains.
    Since 10-15 the Mediabunny fork (89a1dae) demuxes MPEG-1, MPEG-2, and VC-1 from MPEG-TS and M2TS, the engine plays them through its GPU decoder packages, and the add-on advertises them; 16 of 17 streams decode bit-exact against Matroska, and the 17th differs only by bytes its source put ahead of its first start code.
    A stream that grows its picture mid-stream is item 5; delete this item once that is read.

## AV1

1. 10-bit SDR AV1 and VP9 in BT.601 or BT.2020 color.
   These negotiate, because a profile condition cannot express primaries, and then fail eligibility, because the raw SDR keys are BT.709 only.
   Closing it needs BT.601 and BT.2020 raw SDR keys: an SDR gamut conversion in the raw shader, a CPU reference for each, and first-use authorization vectors.
   8-bit range-extension SDR needs the same keys.
2. MP4 Dolby Vision Profile 10.0, the `dav1` sample entry.
   FFmpeg, and so Jellyfin's probe, maps `dav1` to no codec, so the server never offers such a file for direct play.
   A one-line mapping in FFmpeg or jellyfin-ffmpeg fixes it; no jellyfin-ffmpeg patch maps it yet.
   Submitting that patch upstream is a public action and needs the project owner's decision.
   The engine maps `dav1` itself, and Matroska Profile 10.0 already plays.
3. Dolby Vision Profile 10 at 8 bits or outside the Main profile.
   It has no RPU route, because raw AV1 is qualified at 10 bits only; a declared SDR base still plays.
   Closing it needs raw AV1 qualification, raw keys, and authorization vectors for those formats.
4. AV1 HDR and Dolby Vision have no native route.
   Nothing neutralizes an AV1 sequence header's color, so HDR AV1 and Profile 10 always reconstruct from software-decoded raw I420P10, which costs CPU at 4K.
   Closing it needs AV1 color neutralization like the HEVC one, with its own external authorization, so hardware VideoFrames can present.
9. AV1 above level 5.x, 8K included.
   The AV1 decoder package accepts pictures up to 8192x4352 and 8,912,896 samples, so level 6 streams have no route; 239 of AOM's Argon conformance streams are past that limit.
   Closing it needs a frame store above 1 GB at 8K (ten frame buffers of 16-bit samples; one byte per sample for 8-bit content would halve it), records past the 64 MiB packet bound in the worst case (the engine now takes `packet:` up to 512 MiB where the device holds the ring), the package's `accepts` raised to level 6, and a conformance run over those Argon streams.
22. Anamorphic AV1.
    Playback is already correct; stripping Jellyfin's `IsAnamorphic` flag is worth doing only if it ever blocks a route.

## Startup performance

11. Warm the capability probes before the first play.
    Today the first `getDeviceProfile` on a page runs every probe, about 2.6 s cold, and blocks PlaybackInfo.
    Starting them at add-on load hides that, but it competes with library browsing: worker CPU on low-core clients, about 3 MB of vector and wasm fetches against poster loads, and main-thread WebCodecs and `copyTo` readback work.
    Doing it safely needs:
    - An idle gate before each heavy probe is enqueued, `requestIdleCallback` with a timeout, so browsing pauses the queue between probes.
    - Low-priority asset fetches, `fetch(..., { priority: 'low' })`.
    - Promotion to full speed when `getDeviceProfile` asks, so a play is never slower than today.
    - No start while media is playing, and optionally none on weak or constrained clients (`navigator.hardwareConcurrency`, `navigator.connection.saveData`).
    - The idle wait outside `runTimed`, and a background timeout that neither sets the scheduler's `timedOut` poison nor lands in the page-lifetime probe promise; the on-demand path reruns timed-out probes.
12. Persist probe verdicts across page loads and browser restarts.
    Every page load reprobes, so each session's first play pays the full probe cost; `localStorage` survives restarts, so one store covers both.
    Rough plan:
    - The engine owns the store in `src/capability/`: `CustomDecodeCapabilityProbe` reads it before running a probe and writes each definitive result.
    - One fixed storage key holds a schema version, the fingerprint, the write time, and each probe's verdict by its `CustomDecodeProbe` name; another schema or fingerprint is a miss that overwrites it, so updates leave no orphaned entries.
    - Only `supported` and `unsupported` are stored, never `unknown` (timeout, exception) or `not-probed`; video probes run per item, so verdicts merge into the store as items play.
    - The fingerprint is the host's build key, the adapter's `info` with its sorted `features` and its `limits`, and `navigator.userAgent` with Chromium's `getHighEntropyValues(['fullVersionList', 'platformVersion'])`, since the UA alone carries only the major version and a frozen OS.
    - The host passes its build key as it passes `configureEngineAssets({ cacheKey })`: the add-on the engine `assetKey` plus webpack's `__webpack_hash__`, which covers the main-thread probe code and expected fingerprints the `assetKey` misses; the sandbox the `assetKey` plus a value set at each Vite server start.
      `__COMMIT_SHA__` does not do, because every uncommitted build of a commit reads `<sha>-dirty`.
    - A hit resolves `getDeviceProfile` at once, and the hit probes rerun in the background and overwrite their verdicts, on the gated scheduler above, or after the playback session ends until it exists.
    - A route a stored verdict admitted that fails to configure or to output its first frame clears the store, so the next negotiation reprobes: driver updates, OS codec packs, the hardware-acceleration setting, and Chrome's software fallback after GPU process crashes change no fingerprint.
    - The engine exports a clear function and a read of the stored fingerprint and age; the sandbox shows both beside a "Clear probe cache" button, and the add-on's settings dialog may offer the same clear.
    - Tests cover fingerprint and schema misses, merging across items, `unknown` never stored, and the clear after a runtime failure.
    The engine book's `routes.md` "Probes and caching" and `decisions.md` change with it.

## Playback performance

29. Annex B HEVC reaches the native decoder with its own start codes.
    Since engine 8b5883c the Dolby Vision split passes the demuxed packet itself when it removes nothing, and a view of its leading bytes when it removes only trailing NAL units, where it used to rebuild every access unit with four-byte start codes.
    MKV and MP4 packets are length-prefixed, so their bytes are unchanged; MPEG-TS and M2TS packets now keep their three-byte start codes and any leading zero bytes.
    That is valid Annex B, but no real playback has confirmed that Chromium's hardware decoders take it.
    Closing it needs a native-route playback of HEVC in MPEG-TS or M2TS, a Dolby Vision Profile 8 stream among them, so both the unchanged packet and the leading-bytes view reach the decoder.

## Playback smoothness

17. The first frames after a start or seek take 130 to 270 ms of GPU work.
    On an Intel Arc laptop, resuming 4K HDR10+ HEVC mid-GOP, the first two presented frames' GPU work took 266 and 129 ms, Chrome held back two animation frames (127 and 103 ms) without a long task, and one frame dropped.
    Two causes are suspected, and neither is confirmed:
    - The seek preroll decodes from the preceding keyframe to the start position as fast as the decoder returns frames, so it reaches the hardware decoder as one burst, the same contention the owned decode's packet pacing removed from steady playback.
    - The presenter's first draw may compile its HDR pipeline in the GPU process, and the first import of decoder textures may add to it.
    Telling them apart takes a timed run that starts at 0, with no preroll, beside one that resumes mid-GOP, or a second seek in the same session, when the pipeline is already built.
    Closing it needs, for the preroll, smaller batches into the decoder rather than a slower preroll; for the pipeline, compiling the presentation plan's pipeline variants with `createRenderPipelineAsync` during startup, inside the play request, before the first frame is due, possibly with an LRU cache of built pipelines that bounds their memory.

## Robustness

19. RPUs the parser still rejects.
    A linear interpolation piece next to an MMR piece is rejected by necessity: an MMR piece maps all three components, so the linear piece has no scalar value to rise from or end on.
    The RPU format extension, missing sequence information, and display metadata compression above method 1 are rejected as FFmpeg rejects them.
21. RPU parser choices more permissive than FFmpeg, each a small change to reverse:
    - A truncated L1 block is skipped rather than rejecting the RPU.
    - An L1 block in the wrong section is skipped rather than kept as all zeros.
    - There is no limit on block count; input size bounds it.
23. Fix in the fork the Mediabunny gaps the engine works around through Mediabunny's internals.
    BlockAdditions beyond BlockAddID 1, Matroska FlagInterlaced and FieldOrder, `dvc1`, the Dolby Vision sample entries, the MJ2 signature box, and a Matroska `V_AV1` CodecPrivate remain in Mediabunny 1.61.5 and in the fork; the engine book's `decisions.md` describes them.
    Fixing one in the fork, on its own branch cut from upstream's `main`, would let the engine drop its workaround.
    The two defects are fixed in the fork (10-16) and their workarounds are gone: laced header stripping on branch `fix-matroska-laced-header-stripping`, and the unclosed custom decoder, with the custom encoder's same defect, on `fix-custom-decoder-close-after-failure`.
    Upstream pull requests from those branches are the project owner's to open.

## Jellyfin integration

24. The device profile advertises a decoder package's codecs, profiles, and depths, but not the rest of its header or what the device holds.
    Since 10-16 the profile is built from the user's packages and the server's catalog as well, so Jellyfin direct-plays MPEG-2, VC-1, JPEG 2000, AV1 High and Professional, HEVC range extensions, and package-decoded audio.
    A package's `accepts` size conditions and its `monochrome` support are not advertised, so a stream past them, or a 4:0:0 stream for a package without `monochrome`, negotiates and then renegotiates after a failed start.
    Nor is the device's buffer limit: a video package is listed whenever the presenter can create a device, but eligibility needs the stream's frame pool, `state`, `buffer:`s, and packet ring each within the smaller of the device's largest buffer and largest storage binding.
    The HEVC decoder project's pool of 29 I420P10 slots is about 186 MB at 1080p and 727 MB at 2160p, so an adapter at WebGPU's default 128 MiB storage binding refuses even 1080p Main 10.
    The engine's item route check takes the same summaries, codecs and output formats only (engine dfe694a), so a Dolby Vision item's declared base has the same gaps: an 8K HEVC Profile 8.1 item, past the HEVC project's bound of 8912896 pixels (4096x2176), is advertised through its item route.
    Such a stream fails at start, after the add-on has loaded the package, from its store or by download, and compiled it: the offers' fit check refuses the stream.
    The add-on then falls back to the HTML player when the stock profile covers the source, and otherwise asks for one renegotiation, whose profile is never widened, so the server transcodes.
    Closing it needs the server's catalog to carry the `accepts` conditions, and Width, Height, and pixel format conditions in the package routes.
    For the device's limit, the catalog would need each package's header, which would let the item route check run the offers' exact fit check on the item's stream.

## Settled decisions

27. Raw-only HDR items still wait for the external HDR probe.
    The external route's keys shape the HEVC transcode ranges, so the wait stays even for an item that plays only through raw planes.
28. A Profile 10 Matroska stream without a CCID plays only through its RPU route.
    Jellyfin labels it by transfer, so it negotiates through the static HDR ranges, but it declares no base layer to fall back to.

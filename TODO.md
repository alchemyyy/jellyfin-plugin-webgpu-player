# TODO

Open items left after the Dolby Vision and playback-limit work, each with what closing it takes.

## Playback gaps

5. MPEG-2 streams whose picture grows mid-stream.
   The decoder opens at the container's coded size and refuses a later, larger picture, so the item falls back.
   A broadcast transport stream that switches resolution produces such a picture.
   Reopening the decoder at the new size when a sequence header changes it would play them.
*6. AVI, and the legacy codecs it usually carries.
   The engine's prefilter declines AVI, FLV, ASF, and MPEG program streams, because no route's container carries them and Mediabunny 1.52.2 demuxes none of them.
   It also declines MPEG-4 Part 2 (DivX, Xvid), H.263, MS-MPEG4, and Theora in any container, because no route decodes them.
   Jellyfin's HTML player then plays them through a server transcode.
   Closing it takes two halves:
   - Decode: a decoder package for `mpeg4`, `h263`, and `msmpeg4v3` (the MPEG-2 package is the nearest), with self-test vectors and the add-on's profile rules.
     That alone plays MPEG-4 Part 2 in Matroska and MP4.
   - Demux: an AVI demuxer that feeds the worker's packet sinks, covering RIFF chunks with `idx1` or OpenDML indexes, timestamps from each stream's rate and scale, DivX packed B-frames, and VBR MP3 or AC-3 audio chunks.
7. Interlaced video.
   Since 10-15 the engine deinterlaces in presentation (yadif, double rate by default), and its prefilter and eligibility accept interlaced H.264, MPEG-2, VC-1, and WMV3; only interlaced HEVC, interlaced JPEG 2000, and the Dolby Vision routes stay refused.
   The add-on still adds `IsInterlaced` equals false to its widened codec conditions and to its measured route profiles (`CustomDeviceProfile.ts`), so the server still transcodes interlaced sources instead of direct-playing them to the custom path.
   Closing it: drop that condition for the codecs the engine now presents interlaced, keep it for HEVC, JPEG 2000, and the Dolby Vision profiles, and test the negotiation with interlaced MPEG-2 and H.264 items.
   Jellyfin's MediaStream reports `IsInterlaced` but no field order, so each frame's order comes from its decoder, parser, or container, else top field first; a deinterlacing choice in the add-on's settings would call `WebGPUPresenter.setDeinterlaceMode` (double rate, single rate, or off).
8. VobSub (`dvdsub`) subtitles.
   The augmented profile lists vtt, ass, ssa, and pgssub only, so the server burns a selected VobSub track in, the play method becomes Transcode, and the custom path is ineligible.
   A 4K source is then re-encoded just to burn in a bitmap.
   The host's libbitsub already renders VobSub.
   Closing it needs a `dvdsub` subtitle profile and a delivery the server supports for an external `.idx`/`.sub` pair (not yet checked), then libbitsub's VobSub path on both backends.
*10. MPEG-2 and VC-1 in MPEG-TS and M2TS.
    Mediabunny 1.52.2 drops VC-1's stream type 0xEA, and its video setup and packet splitter handle only AVC and HEVC, in private methods the engine cannot wrap, so neither codec is reachable in a transport stream.
    Closing it needs Mediabunny to surface those streams, through an upstream change (a public action that needs the project owner's decision) or an engine input format of its own like the Matroska and Motion JPEG 2000 fixes; the engine then needs only the codec ID, extradata from the first key packet, and both codecs in the transport stream rule.

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
12. Persist probe verdicts across page loads.
    Every page load reprobes, so each session's first play pays the full probe cost.
    Store the capability result in localStorage, keyed by `__COMMIT_SHA__`, `navigator.userAgent`, and `GPUAdapter.info`.
    The engine asset key alone is not enough: it hashes only the libraries output, not the main-thread probe code or expected fingerprints.
    Persist only definitive `supported` and `unsupported` verdicts, never `timeout` or `error`, using the versioned storage pattern of `WebGPUUserSettings.ts`.
    A cache hit resolves `getDeviceProfile` at once; a background reprobe then refreshes the entry.
    Revalidation is background work with the same contention as warming, so it belongs on the gated scheduler above, or after a playback session ends until that scheduler exists.
    The engine book's `routes.md` "Probes and caching" and `decisions.md` change with it.

## Playback performance

14. E-AC-3 and TrueHD build for size.
    Their FFmpeg packages build with `-Oz`, SIMD, and LTO (`decoders/rules.mk`); the DTS package has built with `-O3`, SIMD, and LTO since 10-15.
    At `-O3` the E-AC-3 module grows from 520,036 to 538,985 bytes and the TrueHD module from 314,641 to 325,929, 3.6% each, which a first play downloads.
    Closing it is a choice between that size and a decode speedup that is not measured.
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
23. Report the Mediabunny defects the engine contains upstream.
    Header-stripped laced Matroska blocks (`CustomDecodeInputFormats.ts`) and the unhandled `close()` after a custom decoder fails (`HandledDecodeFailures.ts`) both remain in Mediabunny 1.61.3; the engine book's `decisions.md` describes them.
    Reporting them is a public action and needs the project owner's decision.

## Jellyfin integration

24. The device profile advertises only what native routes decode.
    The add-on stores the decoder packages a user adds in its settings and offers them to each playback, but `CustomDeviceProfile.ts` still lists AV1's Main profile alone and no 4:0:0 HEVC.
    Jellyfin therefore transcodes High and Professional AV1 (4:2:2, 4:4:4, 12-bit) and monochrome HEVC before the engine's package fallback ever sees them.
    Closing it needs the profile built from the stored packages as well: the codecs, profiles, pixel formats, and bit depths their `accepts`, `output`, and `monochrome` lines take.
25. The add-on's tests do not build.
    `jellyfin-webgpu-client.tests` has 54 typecheck errors from the engine's removals and moves, and `WebGPUPlayer.test.ts` fails 14 tests: its mock of `src/DecoderPackages.ts` lacks `getVideoDecoderPackages`, and some tests still expect the removed `bundled-hevc` backend.
    Closing it needs the tests rewritten against the package-based engine.
26. The plugin's last build predates the decoder packages.
    The add-on output in `bin/` still embeds the removed CPU decoders, so deploying it without `./build.sh` ships the old player.

## Settled decisions

27. Raw-only HDR items still wait for the external HDR probe.
    The external route's keys shape the HEVC transcode ranges, so the wait stays even for an item that plays only through raw planes.
28. A Profile 10 Matroska stream without a CCID plays only through its RPU route.
    Jellyfin labels it by transfer, so it negotiates through the static HDR ranges, but it declares no base layer to fall back to.

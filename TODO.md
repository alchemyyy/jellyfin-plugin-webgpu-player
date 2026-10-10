# TODO

Open items left after the Dolby Vision and playback-limit work, each with what closing it takes.

## Playback gaps

- 10-bit SDR AV1 and VP9 in BT.601 or BT.2020 color.
  These negotiate, because a profile condition cannot express primaries, and then fail eligibility, because the raw SDR keys are BT.709 only.
  Closing it needs BT.601 and BT.2020 raw SDR keys: an SDR gamut conversion in the raw shader, a CPU reference for each, and first-use authorization vectors.
  8-bit range-extension SDR needs the same keys.
- MP4 Dolby Vision Profile 10.0, the `dav1` sample entry.
  FFmpeg, and so Jellyfin's probe, maps `dav1` to no codec, so the server never offers such a file for direct play.
  A one-line mapping in FFmpeg or jellyfin-ffmpeg fixes it; no jellyfin-ffmpeg patch maps it yet.
  Submitting that patch upstream is a public action and needs the project owner's decision.
  The engine maps `dav1` itself, and Matroska Profile 10.0 already plays.
- Dolby Vision Profile 10 at 8 bits or outside the Main profile.
  It has no RPU route, because raw AV1 is qualified at 10 bits only; a declared SDR base still plays.
  Closing it needs raw AV1 qualification, raw keys, and authorization vectors for those formats.
- AV1 HDR and Dolby Vision have no native route.
  Nothing neutralizes an AV1 sequence header's color, so HDR AV1 and Profile 10 always reconstruct from software-decoded raw I420P10, which costs CPU at 4K.
  Closing it needs AV1 color neutralization like the HEVC one, with its own external authorization, so hardware VideoFrames can present.
- MPEG-2 and VC-1 streams whose picture grows mid-stream.
  The decoder opens at the container's coded size and refuses a later, larger picture, so the item falls back.
  A broadcast transport stream that switches resolution produces such a picture.
  Reopening the decoder at the new size when a sequence header changes it would play them.
- The prebuilt OpenJPEG decoder (`@cornerstonejs/codec-openjpeg`) keeps Emscripten's default 2 GiB heap.
  A frame whose decoder state does not fit fails in the decoder.
  Rebuilding the package with a 4 GiB heap and reading its returned pointers unsigned would lift the limit.
  The MPEG-2/VC-1 and HEVC kits already have a 4 GiB heap.
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
  The engine book's `routes.md` "Probes and caching" and `decisions.md` change with it.

## Playback performance

- Threaded WebAssembly decoding, through cross-origin isolation.
  Every bundled video decoder runs on one thread, so 4K software HEVC plays at 15 to 20 fps against a 23.976 fps source, and only threads close that gap.
  Threads need SharedArrayBuffer, which needs COOP and COEP headers on Jellyfin Web's top-level document; the plugin would add them as server middleware.
  Under `require-corp`, Jellyfin Web's YouTube trailer iframe is blocked, and the Cast sender script from gstatic needs a CORP header that Google controls.
  `credentialless` relaxes subresources but not cross-origin iframes, and Safari lacks it, so isolation can only be an opt-in beside the non-isolated path.
  The software HEVC decoder is FFmpeg's, which supports frame and slice threads, but the `ffmpeg-hevc` kit builds with `--disable-pthreads`, because threads need the isolation above.
  It also needs a threaded build of that kit beside the single-threaded one, with its own qualification.
  With isolation, a SharedArrayBuffer ring would also replace the PCM messages to the AudioWorklet.
- One copy for Dolby Vision base and enhancement-layer pairs.
  The pair path copies each layer into one compound buffer after the bundled decoder's drain-time copy, so a dual-layer frame is copied twice.
  Closing it needs either the base layer's drain to reserve the enhancement layer's region, so the enhancement layer is copied straight into its paired buffer, or a frame protocol that transfers two buffers per pair, which the presenter's one-buffer check would then accept.
- MPEG-2 and VC-1 frames are copied three times before their upload.
  `MPEG2VC1SoftwareVideoDecoder.copyCurrentFrame` packs the planes into a new buffer, `VideoSample` copies it again, and `toVideoFrame` copies it a third time.
  Building the VideoFrame in `emitCurrentFrame` from a view over FFmpeg's three planes, with their offsets and strides as its `layout`, leaves one copy, because the AVFrame stays valid until the next `receive_frame`.
  The kit also builds without `-msimd128`, so FFmpeg's C fallbacks are not vectorized.
- JPEG 2000 frames expand from RGB to RGBA in JavaScript.
  `copyRGBToRGBA` takes about 4 ms per 2K frame and 16 ms per 4K frame, and the VideoFrame constructor then copies the RGBA again.
  Closing it needs the engine's own OpenJPEG build, with SIMD for its wavelet transform, writing RGBA from the component planes in WebAssembly; the prebuilt `@cornerstonejs/codec-openjpeg` has no SIMD.
  An interim fix writes one 32-bit word per pixel, about 27 percent faster, and passes `transfer` to the VideoFrame constructor.
- Every HEVC packet is walked two to four times and its base layer rebuilt.
  The HDR10+ queue walks the NAL units twice, and `splitDolbyVisionHEVCAccessUnit` walks them again and re-encodes the base layer into a new buffer even when it removes nothing; the AV1 splitter already returns an unchanged unit uncopied.
  The bundled decoder walks each packet once more for its SPS units and leading pictures, and copies it into WebAssembly memory it allocates and frees per packet.
  At 60 Mbps, one walk of an Annex B packet, as MPEG-TS and M2TS carry, costs about 7 ms per second.
  Closing it needs one walk per packet shared by every consumer, the bundled decoder's SPS and leading-picture checks included, the input returned unchanged when nothing is removed (or a `subarray` when only trailing RPU units are), a persistent WebAssembly input buffer, and `transfer` to `EncodedVideoChunk` when the engine owns the buffer.
- The DTS decoder builds without SIMD.
  `libdcadec-dts` builds with `-O3` but without `-msimd128` or LTO.
  Adding `-msimd128` is low risk; moving the E-AC-3 and TrueHD kits from `-Oz` to `-O3` would grow the served binaries, which costs first-load time.
- The bundled audio decoders convert PCM in JavaScript.
  TrueHD deinterleaves and converts its integer samples one at a time in JavaScript, and DTS converts each plane the same way.
  Converting to planar float in the C bridges removes those loops.
- Decoded AC-3 still decodes in the decode worker.
  `@mediabunny/ac3` decodes inside Mediabunny's sample sink, so AC-3 on the decoded PCM route shares the decode worker's thread with video, while E-AC-3, DTS, and TrueHD decode in the audio decode worker.
  The package exposes only its Mediabunny registration, so closing it needs the FFmpeg E-AC-3 kit built with FFmpeg's AC-3 decoder too and a codec choice in its bridge; AC-3 would then send packets as E-AC-3 does, and its qualification would move to the same kit.
- Small per-frame and per-sample overheads.
  The AudioWorklet scans every output sample for telemetry on its render thread (`analyzeOutput`).
  The presenter decodes each frame's 3232-byte RPU snapshot on the main thread to check header fields the worker already validated.
  Raw-plane frames create a bind group per frame although their texture views are stable.

## Playback smoothness

- The video clock jumps back 70 to 80 ms when playback starts.
  Until `getOutputTimestamp()` returns a usable timestamp, `BrowserCustomAudioOutput.mapOutputTelemetry` falls back to the worklet's rendered position, which runs ahead of the audible one by the output latency and buffering.
  The first correlated audio report then pulls the clock back by that amount, so the first frames hold for about two frame durations.
  A timing trace on an Intel Arc laptop showed jumps of 72 to 81 ms against a reported output latency of 64 to 72 ms.
  Closing it needs the uncorrelated fallback to subtract the context's `outputLatency` plus `baseLatency` when the browser reports them, so the first correlated report corrects by a few milliseconds; without them, today's behavior stays.
- The first frames after a start or seek take 130 to 270 ms of GPU work.
  On the same laptop, resuming 4K HDR10+ HEVC mid-GOP, the first two presented frames' GPU work took 266 and 129 ms, Chrome held back two animation frames (127 and 103 ms) without a long task, and one frame dropped.
  Two causes are suspected, and neither is confirmed:
  - The seek preroll decodes from the preceding keyframe to the start position as fast as the decoder returns frames, so it reaches the hardware decoder as one burst, the same contention the owned decode's packet pacing removed from steady playback.
  - The presenter's first draw may compile its HDR pipeline in the GPU process, and the first import of decoder textures may add to it.
  Telling them apart takes a timed run that starts at 0, with no preroll, beside one that resumes mid-GOP, or a second seek in the same session, when the pipeline is already built.
  Closing it needs, for the preroll, a deliberately slower preroll, which trades seek time for a smoother first frame; for the pipeline, creating it with `createRenderPipelineAsync` during startup, inside the play request, before the first frame is due.

## Robustness

- Single-layer RPUs that reuse a dual-layer RPU's mapping.
  The bridge does not carry the reused mapping's layer and NLQ flags over.
  Only a malformed stream mixes them, so this is robustness work, not a playback gap.
- RPUs the parser still rejects.
  A header from which no profile is inferred is rejected; FFmpeg uses the container's profile instead, which would close it.
  A linear interpolation piece next to an MMR piece is rejected by necessity: an MMR piece maps all three components, so the linear piece has no scalar value to rise from or end on.
  The RPU format extension, missing sequence information, and display metadata compression above method 1 are rejected as FFmpeg rejects them.
- Linear interpolation next to a polynomial piece is a guess.
  Each linear piece codes its rise from the previous pivot's value (annex A.2.4.2 of US 10,701,399 B2), but the annex never defines that value for a polynomial piece.
  The bridge uses the polynomial's value at its start pivot, and ends a linear piece before a polynomial continuously with it.
  No sample with such a mix is known; FFmpeg rejects linear interpolation outright.
  A real sample would confirm or correct it.
- RPU parser choices more permissive than FFmpeg, each a small change to reverse:
  - A truncated L1 block is skipped rather than rejecting the RPU.
  - An L1 block in the wrong section is skipped rather than kept as all zeros.
  - There is no limit on block count; input size bounds it.
- Anamorphic AV1.
  Playback is already correct; stripping Jellyfin's `IsAnamorphic` flag is worth doing only if it ever blocks a route.
- Report the Mediabunny defects the engine contains upstream.
  Header-stripped laced Matroska blocks (`CustomDecodeInputFormats.ts`) and the unhandled `close()` after a custom decoder fails (`HandledDecodeFailures.ts`) both remain in Mediabunny 1.61.3; the engine book's `decisions.md` describes them.
  Reporting them is a public action and needs the project owner's decision.

## Settled decisions

- Raw-only HDR items still wait for the external HDR probe.
  The external route's keys shape the HEVC transcode ranges, so the wait stays even for an item that plays only through raw planes.
- A Profile 10 Matroska stream without a CCID plays only through its RPU route.
  Jellyfin labels it by transfer, so it negotiates through the static HDR ranges, but it declares no base layer to fall back to.

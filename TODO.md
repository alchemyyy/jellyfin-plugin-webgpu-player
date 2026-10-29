# TODO

Open items, each with what closing it takes.
An item keeps its number for good, so references to it stay valid; a closed item's number is not reused.
Each number is escaped, as in `5\.`, so Markdown shows it rather than renumbering the items.

## Playback gaps

6\. The legacy formats the custom path still leaves to the server.
   Since 10-27 the engine plays the codecs AVI usually carries: H.264 and HEVC, with the presentation times the fork reads from their pictures' order counts, VP8, VP9, AV1, and MPEG-4 Part 2, H.263, and MS-MPEG4 through the `mpeg4` decoder package, with AAC, MP3, AC-3, FLAC, Vorbis, and PCM, WAVE_FORMAT_EXTENSIBLE and its channel mask included.
   The fork reads OpenDML indexes, so an AVI past 1 GiB plays to its end, and unpacks DivX packed B-frames, as FFmpeg does.
   Theora still has no route in any container, and FLV and ASF stay undemuxed, so Jellyfin transcodes them; MPEG program streams (MPG, VOB) play their MPEG-1 and MPEG-2 video with MP3, AC-3, or DTS since 10-29, but MP2 and DVD-Video LPCM (`pcm_dvd`) audio still transcode.
   The `mpeg4` package implements one-point GMC, reversible VLC, and H.263 B and PB pictures untested, since no encoder at hand writes them; it refuses quarter-pel streams of libavcodec builds before 4653 and lacks FFmpeg's chroma edge workaround for interlaced MPEG-4 from libavcodec 55.66 to 57.66, and a DivX packed stream in Matroska presents one frame off.
   E-AC-3 in AVI stays out of the AVI rule until a vector checks it, and HEVC that FFmpeg's AVI muxer wrote under a zero tag reaches Jellyfin as `rawvideo`, so only hosts that skip Jellyfin's metadata play it.
   Closing it needs a Theora decoder package, demuxers for those containers in the fork, streams that exercise the untested modes, and an E-AC-3 AVI vector.

8\. External VobSub `.idx`/`.sub` pairs are burned in.
   Since 10-27 the custom profile advertises VobSub as the server delivers it, a Matroska subtitle file (`mks`) that the server extracts from a track embedded in MKV, MP4, or VOB or serves from an external `.mks`, and both backends render it through libbitsub's VobSub renderer.
   An external `.idx`/`.sub` pair is still burned in, so the play method becomes Transcode and the custom path is ineligible: Jellyfin offers no delivery for one, since FFmpeg has no `.idx`/`.sub` muxer and the server serves neither file (the server source from 12.1 to master).
   Closing it needs a Jellyfin server change that delivers the pair, an upstream contribution and so a public action for the project owner; remuxing the pair into an `.mks` beside the video avoids the burn-in meanwhile.

## AV1

2\. MP4 Dolby Vision Profile 10.0, the `dav1` sample entry.
   jellyfin-ffmpeg, and so Jellyfin's probe, maps `dav1` to no codec, so the server never offers such a file for direct play.
   FFmpeg master maps it since its commit 4c6d67fe0, but FFmpeg's release/8.1 and jellyfin-ffmpeg 8.1.3 do not.
   A jellyfin-ffmpeg patch that backports that mapping is prepared and checked with ffprobe: a `dav1` file with a Profile 10 `dvvC` probes as AV1 only with the patch.
   Closing it needs the project owner to open that jellyfin-ffmpeg pull request, a public action, and a jellyfin-ffmpeg release carrying it.
   The engine maps `dav1` itself, and Matroska Profile 10.0 already plays.

32\. The sandbox reads no bit depth for AV1.
   The sandbox describes a file with ffmpeg.wasm's ffprobe, which reports no pixel format for an AV1 stream, so the sandbox offers AV1 no HDR, Dolby Vision, raw SDR, or raw format route and plays 10-bit HDR10 AV1 through a decoder package.
   Jellyfin's metadata names the pixel format, so playback in Jellyfin is unaffected.
   Closing it needs the sandbox to take an AV1 stream's bit depth, chroma, and color from its sequence header when ffprobe gives none.

## Robustness

23\. Upstream pull requests for the fork's Mediabunny fixes.
   Since 10-27 the fork fixes every Mediabunny gap the engine worked around through Mediabunny's internals, each on its own branch merged into the fork's `v2`, with the engine's workaround gone (the engine book's `decisions.md`).
   Cut from upstream's `v2`: Matroska FlagInterlaced and FieldOrder (`v2-matroska-field-order`), the MJ2 signature box (`v2-isobmff-mj2-signature`), the Dolby Vision sample entries (`v2-isobmff-dolby-vision-sample-entries`), a Matroska `V_AV1` CodecPrivate and an `av1C` record handed on as the decoder description (`v2-av1-codec-configuration-record`), and the AV1 codec string (`v2-av1-codec-string`).
   Also cut from it: the open H.264 group's leading pictures dropped after a seek, which upstream's sample path otherwise stamps a frame early (`v2-drop-avc-leading-pictures`), and the 10-16 fixes `v2-fix-matroska-laced-header-stripping`, `v2-fix-custom-decoder-close-after-failure`, the first two also with v1 branches, and `v2-matroska-block-additions`; `v2-url-source-read-ahead` adds the URL source read-ahead the engine's retained source uses.
   `dvc1` is fixed on `v2-isobmff-vc1-dvc1`, cut from the fork's `v2`, since upstream has no VC-1 codec.
   Closing it needs the project owner to open upstream pull requests from the branches cut from upstream's `v2`, a public action.

## Jellyfin integration

24\. A 4:0:0 stream that Jellyfin labels like a 4:2:0 one negotiates for a decoder package without `monochrome`.
   Since 10-27 the server's catalog carries each video package's header, so the profile bounds each package route's Width and Height by the sizes the package's `accepts` conditions and the device's buffer limit take, advertises a profile and depth only where the packages write every chroma format its streams may carry, and needs `monochrome` for generic HEVC `Rext`, and the item route check runs the offers' fit check (the book's `negotiation.md`, Sizes).
   Jellyfin has no pixel format or chroma condition, so a 4:0:0 AV1 Main or JPEG 2000 stream still negotiates for a package without `monochrome` and renegotiates after a failed start; the bundled AV1 package declares `monochrome`, and the bundled JPEG 2000 package does not.
   Closing it needs a JPEG 2000 package that decodes 4:0:0, or a refusal scoped to the negotiated item, as the Dolby Vision item route is, which needs every negotiation to pass its item's media source.

## Settled decisions

19\. RPUs the parser rejects.
   A linear interpolation piece next to an MMR piece is rejected by necessity: an MMR piece maps all three components, so the linear piece has no scalar value to rise from or end on.
   FFmpeg rejects every linear interpolation piece, so this rejection is narrower than FFmpeg's.
   The RPU format extension, missing sequence information, and display metadata compression above method 1 are rejected as FFmpeg rejects them, with `AVERROR_PATCHWELCOME` (checked 10-27).

22\. Anamorphic AV1 keeps Jellyfin's `IsAnamorphic` flag.
   Playback is already correct; stripping the flag is worth doing only if it ever blocks a route.

27\. Raw-only HDR items still wait for the external HDR probe.
   The external route's keys shape the HEVC transcode ranges, so the wait stays even for an item that plays only through raw planes.

28\. A Profile 10 Matroska stream without a CCID plays only through its RPU route.
   Jellyfin labels it by transfer, so it negotiates through the static HDR ranges, but it declares no base layer to fall back to.

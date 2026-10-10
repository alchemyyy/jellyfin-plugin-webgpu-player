# Direct play support

Two matrices decide whether Jellyfin direct-plays an HEVC or Dolby Vision source, AV1 Profile 10 included, through the custom pipeline:

1. The engine's support matrix, in its [HEVC and Dolby Vision support](https://alchemyyy.github.io/WebGPU-Player/codec-support.html) chapter: whether the engine plays the source (Eligible), by which route, and on what evidence.
2. This chapter: whether Jellyfin negotiates DirectPlay for the source (Negotiated), given the label Jellyfin gives it and what the add-on's device profile can express.

A source direct-plays through the custom pipeline only when both say yes.
Each table below lists the engine's variants in the engine's order and links to the engine's table for the route and the evidence.
The engine's [Supported formats](https://alchemyyy.github.io/WebGPU-Player/formats.html) chapter lists every container, codec, and HDR format it plays, and [Subtitles](#subtitles) below covers what the add-on renders.

`jellyfin-webgpu-client.tests/custom/HEVCDirectPlaySupportMatrix.test.ts` and `jellyfin-webgpu-client.tests/custom/AV1DirectPlaySupportMatrix.test.ts` assert both matrices, row by row, except the `metadata-unsupported` and `video-track-unavailable` rejections:

- negotiation: `isSameSessionNativePlaybackCompatible`, a conservative model of Jellyfin's codec profile evaluation, against the profile from `augmentDeviceProfileForCustomDecode`, scoped to the item as the add-on scopes it;
- runtime eligibility: the engine's `getCustomPlaybackEligibility`;
- DirectPlay, which is both together;
- the exact route selected when every probe and authorization passes.

For representative rows they also assert the fallback routes, once with native VideoFrame HDR and Dolby Vision presentation withheld and once without native HEVC decode.

Read every "Yes" as conditional:

- the engine's evidence for at least one of the row's routes must pass on the running browser and GPU;
- the user's Custom decode setting must be on;
- HDR and Dolby Vision rows also need the HDR tone mapping setting.

## Jellyfin restrictions

What Jellyfin adds to the engine's matrix:

- Jellyfin names each stream's range with a VideoRangeType label, and the profile can only advertise labels.
  The engine ignores the label for Dolby Vision and reads the configuration instead, so a label and an engine variant do not map one to one.
- A profile condition cannot express chroma format, color range, color primaries, or ChannelLayout.
  The profile therefore advertises only what holds for every value it cannot tell apart, or advertises more and leaves the rest to eligibility; see [Negotiation](negotiation.md#gotchas).
- A label the generic routes do not pair with a profile and depth is advertised only for the item whose exact route exists ("Item route" below; see [Negotiation](negotiation.md#what-the-profile-advertises)).
- A retry is never widened.
- When Jellyfin direct-plays a row that is negotiated but not eligible, the add-on rejects it at runtime.
  It falls back to the HTML player in the same session when the stock profile covers the source, and otherwise asks for one renegotiation.

## Plain HEVC

Engine rows: [Plain HEVC](https://alchemyyy.github.io/WebGPU-Player/codec-support.html#plain-hevc).

| Engine variant | Jellyfin label | Negotiated | Notes |
| --- | --- | --- | --- |
| SDR, Main, 8-bit | SDR | Yes | |
| SDR, Main 10, 10-bit | SDR | Yes | The raw fallback is advertised only when both I420P10 BT.709 SDR keys, limited and full, are authorized, because a profile condition cannot express color range |
| PQ, Main 10, 10-bit | HDR10, or HDR10Plus with HDR10+ metadata | Yes | |
| HLG, Main 10, 10-bit | HLG | Yes | |
| No color metadata | Unknown | No | The engine rejects it too, as `metadata-unsupported` |

## Range extensions

Engine rows: [Range extensions](https://alchemyyy.github.io/WebGPU-Player/codec-support.html#range-extensions).

| Engine variant | Jellyfin label | Negotiated | Notes |
| --- | --- | --- | --- |
| SDR, any of the 9 variants | SDR; Rext or a named alias | Yes | Negotiation needs both the limited and the full SDR key |
| PQ or HLG, the 6 variants of 10 or 12 bits | HDR10, HDR10Plus, or HLG; Rext or a named alias | Yes | |
| BitDepth omitted but PixelFormat present | Any | No: the required VideoBitDepth condition cannot match | Eligible, but never offered |
| Monochrome, or a PixelFormat that contradicts BitDepth | Rext | Yes, when the generic Rext depth is advertised | Not eligible, so it falls back at runtime |

Jellyfin reports the generic `Rext` profile, and a profile condition cannot express chroma format.
Generic `Rext` is therefore advertised for a bit depth and range only when all three chroma formats at that depth pass.
Named aliases are exact per variant.

## Dolby Vision

Engine rows: [Dolby Vision](https://alchemyyy.github.io/WebGPU-Player/codec-support.html#dolby-vision).

| Engine variant | Jellyfin label | Negotiated |
| --- | --- | --- |
| P5, any CCID or none | DOVI, or HDR10 for a CCID outside Jellyfin's set | Yes |
| P7, CCID 1 or 6 | DOVIWithEL or DOVIWithELHDR10Plus | Yes |
| P7, any other CCID or none | DOVIWithEL, or HDR10 for a CCID outside Jellyfin's set | Yes |
| P8, CCID 1 | DOVIWithHDR10 or DOVIWithHDR10Plus | Yes |
| P8, CCID 6 (an Ultra HD Blu-ray HDR10 base) | DOVIInvalid | Yes; DOVIInvalid comes with the raw Dolby Vision route |
| P8, CCID 2 | DOVIWithSDR | Yes |
| P8, CCID 4 | DOVIWithHLG | Yes |
| P8, CCID 0, reserved, or none, or a base whose color contradicts its CCID | DOVIInvalid (Jellyfin 12 for the contradicting base), or a label by transfer | Yes |
| P4, CCID 2 | SDR, or HDR10 or HLG by transfer (SDR under a `dvhe` sample entry) | Yes |
| P20, any CCID or none | HDR10, HLG, or SDR by transfer (SDR under a `dvh1` sample entry) | Yes |
| P4, P5, P7, P8, or P20 over Rext or a named alias | Any | Item route |
| P4, P5, P7, P8, or P20 over 8-bit Main | Any | Item route |

## Dolby Vision over AV1

Engine rows: [Dolby Vision over AV1](https://alchemyyy.github.io/WebGPU-Player/codec-support.html#dolby-vision-over-av1).

| Engine variant | Jellyfin label | Negotiated |
| --- | --- | --- |
| P10, CCID 0 | DOVI | Yes |
| P10, CCID 1 | DOVIWithHDR10 or DOVIWithHDR10Plus | Yes |
| P10, CCID 2 | DOVIWithSDR | Yes |
| P10, CCID 4 | DOVIWithHLG | Yes |
| P10, CCID 6, a reserved CCID, or a base whose color contradicts its CCID | DOVIInvalid | Yes |
| P10 without a CCID (Matroska) | HDR10, HLG, or SDR by transfer | Yes, through the static HDR ranges |
| P10 at 8 bits, or outside the Main profile | Any | Item route, with a declared SDR base |

The MP4 `dav1` sample entry of a 10.0 stream maps to no codec in FFmpeg, and so in Jellyfin's probe, so the server never offers such a file for direct play, although the engine plays it; Matroska 10.0 plays.

Profile 9 (AVC) has no RPU route in the engine; Jellyfin labels it by transfer, or SDR under a `dvav` or `dva1` sample entry, and its declared SDR base plays through the H.264 routes.

## Rejected

Engine rows: [Rejected](https://alchemyyy.github.io/WebGPU-Player/codec-support.html#rejected).

| Engine variant | Negotiated |
| --- | --- |
| A Dolby Vision descriptor without Dolby Vision configuration fields | Yes, under any DOVI label, DOVIInvalid included |
| Dolby Vision over 8-bit Main without a declared SDR base, when the bundled decoder's Main qualification failed | No |
| An invalid Dolby Vision configuration, or several video tracks other than a separate P7 pair | Yes, as the reported label |

A separate-track P7 (a base track and an EL track) selects the same routes, but these tests do not cover it, because their negotiation model reads a single video stream.
The engine's eligibility tests cover it.

## Subtitles

The engine renders no subtitles; the add-on draws them in its HTML layers above the WebGPU canvas.
`augmentDeviceProfileForCustomDecode` replaces the stock profile's External subtitle profiles with the formats those layers render, and keeps every other stock subtitle profile.
A selected track in any other format is burned in by the server, so the play method becomes Transcode and the custom pipeline is not eligible.

| Format | Custom pipeline | Delivery | Renderer |
| --- | --- | --- | --- |
| WebVTT, and the text formats the server converts to it, such as SubRip | Yes | External, as WebVTT | The add-on's subtitle element |
| ASS, SSA | Yes, with Worker, WebAssembly, and a 2D canvas | External | `@jellyfin/libass-wasm` |
| PGS | Yes, with Worker, WebAssembly, and a 2D canvas | External | libbitsub's `PgsRenderer` |
| VobSub (`dvdsub`) | No: not advertised, so it is burned in | Encode | None on the custom path, although the HTML backend holds libbitsub's `VobSubRenderer` |
| Any other bitmap format, such as DVB subtitles | No: burned in | Encode | None |

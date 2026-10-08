# Dolby Vision Profile 10 (AV1)

Status: deferred. Profile 10 does not play through the WebGPU player. Every other
Dolby Vision gate was widened on 2026-10-06; this one was set aside to be handled
on its own.

Profile 10 is Dolby Vision over AV1. The RPU travels in an ITU-T T.35 metadata OBU
(OBU type 5, `metadata_type` 4, country code 0xB5, provider code 0x003B, oriented
code 0x00000800) instead of HEVC NAL unit 62. The compatibility ID picks the
sub-profile: 10.0 (none), 10.1 (HDR10), 10.2 (SDR), 10.4 (HLG).

`ENGINE` below means `jellyfin-webgpu-client/vendor/webgpu-player`.

## Why it does not play

Each layer blocks it independently.

### Server probe

- FFmpeg maps only the `av01` sample entry to AV1 (`libavformat/isom_tags.c`).
  `dav1`, the MP4 sample entry for 10.0, maps to no codec, so ffprobe reports
  codec `unknown` and no `av1` codec profile can ever match it. Matroska is fine.
- This was read from `ENGINE/vendor/ffmpeg` (FFmpeg 8.0). jellyfin-ffmpeg was not
  checked.

### Server labels

From `MediaBrowser.Model/Entities/MediaStream.cs` in the Jellyfin server:

| Stream | Range type |
|---|---|
| 10.0 | `DOVI` (MP4 `dav1` tag or Matroska) |
| 10.1 | `DOVIWithHDR10`, or `DOVIInvalid` when the base is not BT.2020 / PQ |
| 10.2 | `DOVIWithSDR` (no color check) |
| 10.4 | `DOVIWithHLG`, or `DOVIInvalid` when the base is not BT.2020 / HLG |
| CCID 6 or reserved | `DOVIInvalid` |
| No CCID | labeled by transfer (`dav1` tag gives `DOVIInvalid`) |

### Mediabunny

- Mediabunny 1.52.2 assigns the `dav1` sample entry no codec. The engine now
  maps it to AV1 (`ENGINE/src/video/dolby-vision/ISOBaseMediaDolbyVisionSampleEntry.ts`),
  so MP4 `dav1` tracks demux.
- AV1 frames reach the engine only through Mediabunny's `VideoSampleSink`, which
  hides the packet bytes. The T.35 OBUs are still in the packets returned by
  `EncodedPacketSink`.
- `av1C` is reduced to profile, level, tier and bit depth. Matroska AV1 ignores
  CodecPrivate and reads the first packet instead.

### Engine

- `CustomDecode.worker.ts` `streamVideoFrames` sends only HEVC to the engine's own
  decoder. AV1 goes through `VideoSampleSink`, and frames are posted with
  `encodedDolbyVisionMetadata: null`.
- `PresentationInput.ts` accepts profile 10 as a descriptor with no RPU route
  (`reconstructionProfile` null).
- `CustomPlaybackEligibility.ts` therefore presents only a declared base layer,
  never the Dolby Vision picture:
  - 10.1 (PQ) and 10.4 (HLG) through the raw I420P10 AV1 route;
  - 10.2 (SDR) through the native AV1 route at 8 bits only, because no 10-bit
    AV1 SDR route exists;
  - 10.0 and a stream without a CCID have no base, so they are ineligible.
- The RPU route requires HEVC (`getDolbyVisionReconstructionSource`).
- The libdovi bridge (`ENGINE/wasm/libdovi/src/lib.rs`) parses only HEVC NAL 62.
- AV1 static HDR metadata and HDR10+ are not read either; both scans are HEVC-only.

### Host

- In `jellyfin-webgpu-client/src/custom/CustomDeviceProfile.ts`, every Dolby
  Vision route is HEVC-only: `getDolbyVisionVideoRangeTypes`, the Dolby Vision
  route, `allowRawDolbyVision`, and the item-scoped route
  (`getDolbyVisionItemVideoRoute`).
- Original av1 codec profiles are widened only to `SDR|HDR10|HLG`. The server
  ANDs every matching codec profile, so any `DOVI*` label fails, and the
  base-layer routes above are never negotiated.
- A Matroska Profile 10 stream without a CCID is labeled by transfer, for
  example `HDR10`, so it can negotiate and then be rejected at runtime, because
  it declares no base.

## Work list

1. libdovi bridge: export a T.35 entry point that calls
   `DoviRpu::parse_itu_t35_dovi_metadata_obu`. The function already exists in the
   pinned crate. Then rebuild with `make -C wasm libdovi`.
2. Profile: take it from the container descriptor. The crate infers a profile from
   the RPU header, so 10.0 reads as 5 and 10.1, 10.2 and 10.4 read as 8.
3. AV1 OBU splitter: pick metadata OBUs with the T.35 Dolby Vision header, and
   tolerate a leading temporal delimiter (the engine's AV1 vectors start with
   `12 00`).
4. Generalize `DolbyVisionEncodedMetadataQueue` beyond the HEVC splitter. Its PTS
   keying fits AV1, because each temporal unit has exactly one shown frame.
5. An AV1 decode path owned by the engine, like `streamOwnedHEVCFrames`: its own
   `VideoDecoder`, fed from `EncodedPacketSink`.
6. Eligibility:
   - Give profile 10 an RPU route (`reconstructionProfile` 5 for 10.0, and 8
     otherwise, as Profile 20 does) and an AV1 raw Dolby Vision route.
   - The declared-base routes for 10.1 and 10.4 already exist. 10.2 also needs
     a 10-bit AV1 SDR route; the native AV1 route is 8-bit only.
7. Host negotiation:
   - Add an AV1 Dolby Vision range list: `DOVI`, `DOVIWithHDR10`, `DOVIWithSDR`,
     `DOVIWithHLG`, `DOVIInvalid`, and optionally `DOVIWithHDR10Plus`.
   - Gate it on `rawHDRVideo.av1` plus a new engine AV1 Dolby Vision capability.
   - Feed the list into the av1 raw route.
   - Let Dolby Vision widen av1 in `getSupportedVideoCodecs`.
   - Widen the original av1 codec profiles.
   - Extend the item-scoped route to av1, which also covers labels by transfer.
   - The `<format>:dovi-rpu-v1` authorization keys are keyed on frame format and
     may be reusable.
8. Vectors: an AV1 Dolby Vision known-answer vector for each route.

## Open questions

- Does jellyfin-ffmpeg map `dav1` to AV1? If not, 10.0 in MP4 can never be offered
  by the server, and only Matroska 10.0 is reachable.
- Do Chromium's AV1 decoders ignore T.35 metadata OBUs, as the AV1 specification
  requires? This matters only if the T.35 OBUs are left in the packets fed to the
  decoder.
- How to generate the AV1 Dolby Vision vectors: check FFmpeg's RPU encoder
  (`libavcodec/dovi_rpuenc.c`) with the libaom and SVT-AV1 wrappers, and dovi_tool.

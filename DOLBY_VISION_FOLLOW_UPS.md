# Dolby Vision Follow-Ups

Open items left after Profile 10 (AV1) support and the remaining Dolby Vision gaps were closed on 2026-10-08.
The engine book's "HEVC and Dolby Vision support" chapter (`jellyfin-webgpu-client/vendor/webgpu-player/docs/src/codec-support.md`) lists every supported variant and route.

## Behaviour changes to be aware of

- Raw AV1 and VP9 decode in software: raw-plane AV1 and VP9 request `prefer-software`, in the probes and at runtime, because Chromium's hardware decoders return opaque 10-bit frames.
  Raw HDR AV1 and VP9 also qualify on GPUs with AV1 or VP9 hardware decode, at the cost of CPU decode (dav1d, libvpx).
- AV1 codec strings: every AV1 track's decoder configuration takes its codec string from the first packet's sequence header.
  Mediabunny 1.52.2 misreads it for every Matroska AV1 track: 10-bit streams read as 8-bit or monochrome.
- Dual-layer EL decode: the bundled HEVC decoder's Main 10 qualification, which decodes the EL, decides whether P4 and P7 decode their EL, not whether they reconstruct.
  Without it the route discards the EL: MEL reconstructs exactly and FEL presents its base.
  The route used to start the unqualified decoder and drop the EL only when it failed.
- Out-of-spec ELs: an EL that decodes in another format or size than its configuration leaves the stream to its BL instead of failing the attempt.
  A frame whose RPU names an EL depth other than 10 bits presents without its EL instead of misscaling the residual.
- Raw HDR waits: AV1, VP9, and HEVC range-extension HDR items, and AV1 Profile 10 items with a PQ or HLG base, wait for the raw HDR authorization at negotiation and before eligibility, whatever the external HDR result.
  Before eligibility, an item whose single-layer RPU route is already authorized skips that wait, because that route is selected before the declared base.
- Presenter fix: a raw SDR session that followed an HDR or Dolby Vision session bound the render-settings buffer its shader does not declare, so its first frame failed.
  Identity SDR does not bind it.

## Still not supported

- MP4 Profile 10.0 (`dav1`): FFmpeg, and so Jellyfin's probe, maps the `dav1` sample entry to no codec, so the server never offers such a file for direct play.
  No jellyfin-ffmpeg patch maps it.
  The engine maps `dav1` itself, and Matroska 10.0 plays.
- Profile 10 at 8 bits or outside the Main profile: no RPU route, because raw AV1 is qualified at 10 bits only.
  A declared SDR base still plays.
- No native AV1 HDR or Dolby Vision route: nothing neutralizes an AV1 sequence header's color, so Profile 10 always reconstructs from software-decoded raw I420P10, which costs CPU at 4K.
- 10-bit SDR AV1 and VP9 in BT.601 or BT.2020 color: negotiated, because a profile condition cannot express primaries, then ineligible, because the raw SDR keys are BT.709 only.
  Adding BT.601 and BT.2020 raw SDR keys with their authorization vectors would close it.
- A Profile 10 Matroska stream without a CCID: labeled by transfer, so it negotiates through the static HDR ranges, but it declares no base and plays only through its RPU route.
- RPUs the parser still rejects: a linear interpolation piece next to an MMR piece, and a header from which no profile is inferred.
  An MMR piece maps all three components, so a linear piece next to it has no scalar value to rise from or end on.
  For such a header FFmpeg uses the container's profile.
  The RPU format extension, missing sequence information, and display metadata compression above method 1 are rejected as FFmpeg rejects them.
- Linear interpolation next to a polynomial piece is a guess: each linear piece codes its rise from the previous pivot's value (annex A.2.4.2 of US 10,701,399 B2), but the annex never defines that value for a polynomial piece.
  The bridge uses the polynomial's value at its start pivot, and ends a linear piece before a polynomial continuously with it.
  No sample with such a mix is known; FFmpeg rejects linear interpolation outright.
- Parser choices more permissive than FFmpeg, each a small change to reverse:
  - A truncated L1 block is skipped rather than rejecting the RPU.
  - An L1 block in the wrong section is skipped rather than kept as all zeros.
  - There is no limit on block count.
    Input size bounds it.

# Dolby Vision Follow-Ups

Open items left after the Dolby Vision gates were widened on 2026-10-06.
Profile 10 (AV1) is tracked separately in `DOLBY_VISION_PROFILE_10_AV1.md`.

## Behaviour changes to be aware of

- **Probe timing:** a DV item whose HDR10/HLG base isn't an exact native P7/P8
  base now also waits for the ordinary HDR probes (native first, raw only if
  native isn't authorized). That lets its base be offered as a fallback. The
  test that checked DV items skip those probes now uses a P5 item, which has no
  such base.
- **Lint refactor:** to stay under the lint complexity limit, the Dolby Vision
  flag logic moved into helpers in
  `jellyfin-webgpu-client/src/WebGPUPlayer.ts`, and the retry check moved into
  the per-item route in `jellyfin-webgpu-client/src/custom/CustomDeviceProfile.ts`.

## Still not supported

- **Profile 10:** deferred, per `DOLBY_VISION_PROFILE_10_AV1.md`.
- **P4/P7 over Rext:** reconstruction runs only in 10-bit 4:2:0. Over Rext only
  the declared base plays.
- **8-bit Main with no declared SDR base:** rejected, because no route can read
  8-bit Main.
- **RPUs the parser still rejects:** pieces mixing polynomial and MMR within one
  component, linear interpolation, or a non-YCbCr mapping. Playback then falls
  back to the regular HTML player. Supporting mixed pieces would need changes
  to the crate, the shared data layout and the shader.
- **Parser choices you may want to reverse** (each is a small change):
  - A truncated L1 block is skipped rather than rejecting the RPU, as FFmpeg
    would.
  - An L1 block in the wrong section is skipped rather than kept as all zeros.
  - There is no limit on block count. Input size bounds it; the worst case
    measured was 8.7 of 16 MiB.
- **Existing gap, now also affecting P4:** eligibility never checks the bundled
  decoder that decodes the P4/P7 EL. If that decoder fails, playback silently
  drops to the base layer.

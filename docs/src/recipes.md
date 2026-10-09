# Recipes

Short procedures for the changes that come up most.
Each assumes a checkout built as in [The client add-on](add-on.md#build-and-check).

## Advertise a new engine route

1. Add the route in the engine, following its "Add or change a codec route" recipe in [Recipes](../../jellyfin-webgpu-client/vendor/webgpu-player/docs/book/recipes.html#add-or-change-a-codec-route).
2. Negotiation.
   `jellyfin-webgpu-client/src/custom/CustomDeviceProfile.ts` turns the evidence into CodecProfile conditions, and `jellyfin-webgpu-client/src/WebGPUPlayer.ts` derives the option flags and configures the color pipeline.
   Container pairing stays only in `src/capability/CustomContainerCodecSupport.ts` (engine).
   Add no resolution, level, frame rate, or bitrate gate, and no decoder pair blacklist.
3. Tests.
   Add the row, its expected route, and its fallbacks to `jellyfin-webgpu-client.tests/custom/HEVCDirectPlaySupportMatrix.test.ts` or `AV1DirectPlaySupportMatrix.test.ts` beside it.
4. Update [Direct play support](direct-play-support.md), and [Negotiation](negotiation.md) if what the profile advertises changed.

Check: the engine's checks from its root, and the add-on checks from [The client add-on](add-on.md#build-and-check).

## Take an engine change

1. Commit the change in the engine repository and push it.
2. In the plugin repository, commit the new submodule pointer of `jellyfin-webgpu-client/vendor/webgpu-player`.

Push the engine first, so the plugin never pins a commit nobody can fetch.

## Update this book

See [Maintaining this book](maintaining.md).

# Recipes

Short procedures for the changes that come up most.
Each assumes a checkout built as in [The client add-on](add-on.md#build-and-check).

## Advertise a new engine route

1. Add the route in the engine, following its "Add or change a codec route" recipe in [Recipes](https://alchemyyy.github.io/WebGPU-Player/recipes.html#add-or-change-a-codec-route).
2. Negotiation.
   `jellyfin-webgpu-client/src/custom/CustomDeviceProfile.ts` turns the evidence into CodecProfile conditions, and `jellyfin-webgpu-client/src/WebGPUPlayer.ts` derives the option flags and configures the color pipeline.
   Container pairing stays only in `src/capability/CustomContainerCodecSupport.ts` (engine).
   Add no resolution, level, frame rate, or bitrate gate, and no decoder pair blacklist.
3. Tests.
   Add the row, its expected route, and its fallbacks to `jellyfin-webgpu-client.tests/custom/HEVCDirectPlaySupportMatrix.test.ts` or `AV1DirectPlaySupportMatrix.test.ts` beside it.
4. Update [Direct play support](direct-play-support.md), and [Negotiation](negotiation.md) if what the profile advertises changed.

Check: the engine's checks from its root, and the add-on checks from [The client add-on](add-on.md#build-and-check).

## Capture a timing trace

1. In the browser console, run `localStorage.setItem('webgpuPlayerTimingTrace', '1')` and reload, so the trace runs from the first play.
   `window.WebGPUPlayerTimingTrace.start()` also works, but a decode run started before it sends no events until the next seek.
2. Play the passage that misbehaves.
3. Run `await window.WebGPUPlayerTimingTrace.download()`, which saves `webgpu-player-timing-<start time>.json`.
   `export()` returns the same object to automation instead.
4. Run `localStorage.removeItem('webgpuPlayerTimingTrace')` when done, because a running trace keeps up to 200,000 events in memory.

The engine's "Capture a timing trace" recipe in [Recipes](https://alchemyyy.github.io/WebGPU-Player/recipes.html#capture-a-timing-trace) describes the events.

## Take an engine change

1. Commit the change in the engine repository and push it.
2. In the plugin repository, commit the new submodule pointer of `jellyfin-webgpu-client/vendor/webgpu-player`.

Push the engine first, so the plugin never pins a commit nobody can fetch.

## Update this book

See [Maintaining this book](maintaining.md).

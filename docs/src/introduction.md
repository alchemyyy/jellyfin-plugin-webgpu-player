# WebGPU Player for Jellyfin

This book documents the Jellyfin side of the WebGPU Player: the server plugin `jellyfin-plugin-webgpu-player` and its web client add-on.
Together they add the player to an unmodified Jellyfin Web.

The playback engine is a separate repository, [WebGPU Player](https://github.com/alchemyyy/WebGPU-Player), checked out as a submodule at `jellyfin-webgpu-client/vendor/webgpu-player/`.
The engine knows nothing about Jellyfin, and its own book covers the engine: its [architecture](../../jellyfin-webgpu-client/vendor/webgpu-player/docs/book/architecture.html), [eligibility and routes](../../jellyfin-webgpu-client/vendor/webgpu-player/docs/book/routes.html), [codec support](../../jellyfin-webgpu-client/vendor/webgpu-player/docs/book/codec-support.html), its decoders, and its build.
This book covers what the plugin decides: how the add-on reaches the page, player selection, the device profile, the PlaybackInfo requests, settings, and the host's half of a playback session.
The plugin's `README.md` covers the server plugin, its rewrites, and its asset route.

## Invariants

- The device profile advertises only what the selected engine route implements and has exact-output evidence for.
  A route is never gated on resolution, level, frame rate, bitrate, or a throughput benchmark.
- A retry negotiates with the stock profile and is never widened.
- A failure in the custom pipeline falls back to the add-on's HTML player in the same session, or asks for one renegotiation.
  A player is never selected recursively.
- The Jellyfin Web checkout is a read-only input.
- WebGPU needs a secure context.
  Validate over HTTPS against a local server.
  A successful negotiation is not a successful playback.

## Conventions

- Paths are relative to the plugin repository root.
- Engine paths are relative to the engine root, `jellyfin-webgpu-client/vendor/webgpu-player/`, and marked (engine), for example `src/capability/CustomPlaybackEligibility.ts` (engine).
- Symbols are written `file:symbol` or `Class.method`.

## Where to look

| To | Read |
| --- | --- |
| Build and check the add-on | [The client add-on](add-on.md#build-and-check) |
| Follow a playback session through Jellyfin Web | [Playback in Jellyfin Web](playback.md) |
| Learn why the server direct-plays a source or not | [Negotiation](negotiation.md), [Direct play support](direct-play-support.md), and the engine's [support matrix](../../jellyfin-webgpu-client/vendor/webgpu-player/docs/book/codec-support.html) |
| Find an add-on file | [Module map](module-map.md) |
| Avoid repeating an investigation | [Decisions](decisions.md) |

# Maintaining this book

This book documents the plugin and its add-on.
The engine has its own book, in `docs/` (engine); a change to the engine updates that one.
Both are built with [mdBook](https://github.com/rust-lang/mdBook) 0.5.

## Build and read it

1. Install mdBook once: `cargo install mdbook --version 0.5.4 --locked`.
2. From the plugin root, run `mdbook serve docs --open` while editing; it rebuilds on every save.
3. Before committing, run `mdbook build docs`; it fails on a broken `SUMMARY.md`.
   It writes the book to `docs/book/`, which is not tracked.

A push to `main` that changes `docs/` or the engine submodule publishes the book to <https://alchemyyy.github.io/jellyfin-plugin-webgpu-player/>, through `.github/workflows/docs.yml`; its `MDBOOK_VERSION` is the version in step 1.
Links into the engine's book point at the engine's site, <https://alchemyyy.github.io/WebGPU-Player/>, since a relative link out of `docs/` does not resolve on the published site.

`docs/book.toml` holds the configuration, and `docs/src/SUMMARY.md` the table of contents.

Diagrams are PlantUML sources in `docs/diagrams/`, rendered to light and dark SVGs in `docs/src/diagrams/`, both tracked.
They include the engine's `docs/diagrams/diagram-theme.puml` (engine), and the engine's [Maintaining this book](https://alchemyyy.github.io/WebGPU-Player/maintaining.html#diagrams) chapter describes how to write and embed one.
Render them from the plugin root with `node jellyfin-webgpu-client/vendor/webgpu-player/tools/render-diagrams.mjs docs`, and check them with `--check` before committing.
A chapter that is not listed in `SUMMARY.md` is not built.
The book's only theme file of its own is `docs/theme/favicon.svg`, a plain-SVG export of the plugin logo; after changing `images/jellyfin-plugin-webgpu-player.svg`, export it again from the plugin root:

```sh
inkscape images/jellyfin-plugin-webgpu-player.svg --export-plain-svg --export-filename=docs/theme/favicon.svg
```

`docs/theme/engine-theme.css` imports the engine book's stylesheets from `docs/theme/` (engine), so both books look the same.
`docs/theme/engine-theme.js` loads the engine book's scripts the same way, such as its diagram viewer.
Their URLs are relative to the built files in `docs/book/theme/`, and they need the engine submodule checked out.
The published site has no submodule, so `.github/workflows/docs.yml` copies the engine's theme into the built book and points both files at the copy.

## When to update it

Update the chapter in the same change that alters what it describes:

- player selection, the device profile, the PlaybackInfo requests, or the probe scopes: [Negotiation](negotiation.md), and [Direct play support](direct-play-support.md) when a row changes;
- the host-compatible mode, the settings, or the build: [The client add-on](add-on.md);
- an add-on file added, moved, or removed: [Module map](module-map.md);
- a settled investigation: [Decisions](decisions.md).
  Never delete an entry; revise it when its facts change, rather than adding one that contradicts it.

## How to write it

- Record durable facts: architecture, negotiation, layout, procedures, and decisions.
  Git already records history and working-tree state, so there are no changelogs, status snapshots, or "uncommitted" notes.
- Write procedures as recipes: what you need, numbered steps, then how to check the result.
- Prefer plain sentences and short lists.
  Use a table only for data that has columns.
  Keep bold, callouts, and decoration out.
- Put each sentence on its own line; never wrap a line at a fixed column.
- Use ASCII only.
- Follow the path conventions in the [Introduction](introduction.md): plugin paths from the plugin root, engine paths from the engine root marked (engine).
- Never include credentials, server addresses, item IDs, media titles or paths, or absolute machine paths.

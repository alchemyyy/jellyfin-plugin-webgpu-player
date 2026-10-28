# Decoders and passes from the server

The plugin offers the engine's decoder packages and pass files to every client, and an administrator manages them on the plugin's settings page.
A client downloads a decoder package only when a playback needs it, and a pass file only when its user adds it to the presentation.

## What the server offers

- The add-on build carries the engine's packages and passes.
  `webpack.config.js` copies `bin/wgpud/` and `bin/wgpup/` (engine) into the add-on's `wgpud/` and `wgpup/`, and `addon-manifest.json` lists them under `decoderPackages` and `passes`.
  The manifest also relays `decoderPackageSection`, the custom section that carries a package's header, from the engine's `src/decode/packages/DecoderPackageFormat.json` (engine).
- The add-on build stops when the engine's packages are missing.
  `./build.sh` builds them first when they are: `make -C wgpud sources`, then `scripts/decoder-packages.mjs` (engine), in the background with the engine's WebAssembly build.
- `Modules/ModuleStore.cs` holds the bundled files, the uploads, and the disabled keys.
  A package's key is the id its header declares, and a pass file's key is its file name, whatever its case.
  An upload replaces the bundled file of its key, as a new version of a package replaces the old one, and deleting the upload restores the bundled file.
  A disabled key is offered in neither version.
- Uploads and the disabled keys live in the plugin's data folder, `Jellyfin.Plugin.WebGPUPlayer/` in the server's plugins folder, so they survive plugin updates: `wgpud/<id>.wasm`, `wgpup/<file name>`, and `state.json`.
  A state file of another version loads as every module enabled.
- The plugin reads only what it shows and offers.
  `Modules/DecoderPackageFunctions.cs` reads a package's id, name, kind, codecs, output formats, and monochrome support from its header, and `Modules/PassFileFunctions.cs` reads a pass file's pass names.
  The catalog also carries a video package's `header`, its `//!` lines without the WGSL body, which the client's engine reads to judge a stream before it downloads the package; an audio package's is null.
  A client's engine runs every check of its own when it loads a file.

## Routes

`Modules/ModuleController.cs` answers below the server base URL.

| Route | Caller | Answer |
| --- | --- | --- |
| `GET WebGPUPlayer/Catalog` | A signed-in user | The offered packages and pass files, each with its SHA-256 and size, and each video package with its header |
| `GET WebGPUPlayer/DecoderPackages/{id}` | A signed-in user | The offered package, with its SHA-256 as its entity tag |
| `GET WebGPUPlayer/Passes/{fileName}` | A signed-in user | The offered pass file, with its SHA-256 as its entity tag |
| `GET WebGPUPlayer/Catalog/All` | An administrator | Every file the store holds, with its source, state, and problem |
| `POST WebGPUPlayer/DecoderPackages` | An administrator | Stores the request body under its header's id |
| `POST WebGPUPlayer/Passes?fileName=` | An administrator | Stores the request body under the file name |
| `DELETE WebGPUPlayer/DecoderPackages/{id}`, `DELETE WebGPUPlayer/Passes/{fileName}` | An administrator | Deletes the upload of the key |
| `PUT` or `DELETE` on `.../{key}/Enabled` | An administrator | Enables or disables the key |

- Every answer is camelCase JSON, whatever the server's default naming.
- An administrator's change answers with the new listing.
  A refused one answers with `{ code, detail }`: 400 for a file that does not read, 404 for an unknown key, 413 past the size limit (64 MiB for a package, 16 MiB for a pass file), and 500 for a write the data folder refused.
- The add-on's anonymous asset route serves the bundled files too, since it serves the whole add-on build; only the routes above know uploads and the disabled keys.

## The settings page

- `Plugin.GetPages` serves `Configuration/configPage.html`, then its controller `Configuration/configPage.js`.
  Jellyfin Web loads the controller through `/web/ConfigurationPage?name=WebGPUPlayerConfig.js`, the page's `data-controller`, and constructs its default export with the page's view.
- The page lists the decoders and the passes with their source and state, uploads files, deletes uploads, and enables or disables keys.
  It reads and changes them through the administrator's routes, signed in with the dashboard's token.
- Above the decoders, the add-on's editor sets the client defaults (see [Client defaults from the server](client-defaults.md#the-settings-page)).

## In the client

- `ServerModules.ts` reads the catalog of the item's server, signed in with the page's token (`Authorization: MediaBrowser Token="..."`).
  A negotiation and its playback's eligibility share one read: a catalog read in the last 60 seconds is reused, and the settings panel reads it again when it opens.
- Negotiation advertises what the user's packages and the server's decode before any of them is downloaded (see [Negotiation](negotiation.md#decoder-packages)).
  The engine's `parseGPUDecoderHeader` reads each video package's catalog header, whose `accepts` conditions, `monochrome`, and buffer sizes bound the sizes the routes advertise on the presenter's device; a package whose header the engine refuses is logged and left out, since its load would fail too.
- Eligibility downloads only what the playback needs:
  - the video packages that decode the stream's codec into its frame pool format, when no native route plays the video;
  - the audio packages of the selected track's codec, when the eligibility refused the track because neither an engine decoder, a native route, nor one of the user's packages takes it.
- A downloaded package stays in IndexedDB, in the `webGPUPlayerServerDecoders` database, under its id.
  A later playback loads the stored version when its SHA-256 is the catalog's, and downloads the newer version in its place otherwise.
- The user's own packages, in the `webGPUPlayerDecoders` database, come first, and the server's package of an id the user stores is left out.
- The settings panel's shader pass section lists the server's pass files the preset does not hold.
  Adding one downloads it and stores its source like a file of the user's own, with its origin, the file name and SHA-256, in the settings.
- When the server offers a newer version of a file the user's own preset holds, the settings panel, or the first play of a page that presents through WebGPU, replaces its source under its key, so the file keeps its place and its parameter values.
  A file the server no longer offers stays in the preset, and its entry says so.
- A user who follows the server's [default shader preset](client-defaults.md#the-default-shader-preset-on-clients) plays its files, which `DefaultPresentationFiles.ts` downloads with `addServerPassFile` and downloads again for a new version under new keys.

## Gotchas

- The data folder's name comes from the plugin assembly's file name, so renaming the assembly leaves the uploads behind.
- The server's plugin discovery lists the data folder as a plugin folder without assemblies and leaves it alone; never put a DLL in it.
- A server reached under another server id is another catalog: the client keys its catalog reads by server id, but its package cache by package id alone, so two servers' versions of one id replace each other.
- Kestrel enforces a route's `RequestSizeLimit` by throwing on the read past it, which the server answers with a 500; `RequestBodyFunctions.ReadBodyAsync` turns that refusal into the routes' own 413.
  The test host enforces no limit, so `RoleHeaderTestServer` applies a route's limit as Kestrel does.

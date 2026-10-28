# Client defaults from the server

An administrator sets a default for each WebGPU Player client setting on the plugin's settings page.
A user's own choice wins over the default, and the add-on's built-in default applies where the administrator set none.
The audio output device and a user's own decoders stay per browser, since a device id and IndexedDB content mean nothing in another browser.

## What the server stores

- `ClientDefaults/ClientDefaultsStore.cs` keeps the defaults in the plugin's data folder, beside `state.json`: `client-defaults.json`, `{ "version": 1, "settings": { ... } }`.
  It writes the file through a temporary sibling, so a reader or a restart never sees part of it.
- A missing file loads as no defaults; so does an unreadable or other-version one, and the server logs why.
- `settings` maps a flat key, such as `brightness` or `presentationFiles`, to its default.
  The server checks only the document's shape and keeps each value verbatim; the add-on normalizes every value as it normalizes a user's stored choice, so an out-of-range default falls back to the built-in one.
- `ClientDefaults/ClientDefaultsFunctions.cs` checks the shape:
  - the body is at most 64 KiB of strict JSON: no comments, trailing commas, or duplicate properties, and objects and arrays nested at most 16 deep, the root included;
  - the root is an object whose `settings` is an object;
  - `settings` holds at most 64 properties, each key an ASCII letter followed by up to 63 ASCII letters and digits, and no value is `null`.

## Routes

`ClientDefaults/ClientDefaultsController.cs` answers below the server base URL, beside the [module routes](server-modules.md#routes).

| Route | Caller | Answer |
| --- | --- | --- |
| `GET WebGPUPlayer/ClientDefaults` | A signed-in user | `{ "settings": { ... } }`, with `Cache-Control: private, no-cache` |
| `PUT WebGPUPlayer/ClientDefaults` | An administrator | Stores the `application/json` body, `{ "settings": { ... } }`, and answers with the stored `{ "settings": { ... } }` |

- Every answer is camelCase JSON; the setting keys stay as stored.
- A refused `PUT` answers with `{ code, detail }`: 400 `client-defaults-invalid` for a shape the store refuses, 413 `client-defaults-size` past 64 KiB, and 500 `client-defaults-write-failed` for a write the data folder refused.
  The stored defaults stay as they were.

## The settings page

- The "Client defaults" section, above the decoders, holds `<div data-client-defaults></div>`.
- On every `viewshow`, `Configuration/configPage.js` calls `window.WebGPUPlayer`, the factory the plugin's bootstrap script defines, and awaits `renderClientDefaultsEditor(container)` of the add-on it resolves to; the editor replaces the container's content.
- Without the factory or the method, or when either rejects, the container shows a plain English message that the add-on is not loaded in this page and the page needs a reload.
- The editor is the add-on's, so it speaks the user's language; the rest of the page stays English.

## The editor

- `index.ts` attaches `renderClientDefaultsEditor(element)` to the add-on entry; it loads the add-on's strings and `ui/ClientDefaultsEditor.ts`, which webpack emits as its own chunk, `webgpu-client-defaults-editor`.
- The editor reads the server's defaults and its pass catalog; a failed read shows in the status line, and the rest of the form stays usable.
- Reading the defaults applies them to the page, as the sync's read does, but only the sync's read caches them for the next page.
- Save stays disabled when the defaults could not be read: a save replaces every default, so a form that never showed them would drop them.
- It has one row per flat key, grouped and labelled like the playback settings panel, with the panel's ranges, units, and options from `ui/SettingDefinitions.ts`.
- Each row has a "Set on the server" checkbox.
  Unchecked, the control is disabled and shows the add-on's built-in value, which users then follow.
  Checked, it shows the server's value read through the client's own normalization.
- A server value that reads otherwise, such as a refused type or an out-of-range number, shows what clients take instead, and the status line names it.
- The default shader preset lists the server's pass files in order, at most 16.
  Each file shows the parameters and constants its passes declare, from the source the editor downloads and parses with the engine's `parsePassFile`, with each one's default and range.
  A file the catalog no longer offers stays listed, marked, and removable.
  A file whose source cannot be read keeps the parameter values the server holds for it.
- Save stores each checked row's value and, when the list holds a file, `presentationFiles` with only the parameter values that differ from the pass defaults.
  The form then shows what the server stored; a refusal shows its `<code>: <detail>` in the status line.

## The default shader preset on clients

- A user's stored shader files are `null` while the user follows the server's default preset; any stored list, even an empty one, is the user's own preset.
- `DefaultPresentationFiles.ts` reads `presentationFiles` as stored files are read: each entry needs a nonblank `fileName` of at most 128 characters, its parameters keep finite numbers under valid names, and at most 16 entries count.
  An entry it cannot read is logged and left out.
- It matches each file by name, whatever its case, to a pass file the server's catalog offers, in order; a file the server does not offer is logged and left out.
- It downloads the matched files into the pass source store, each with the preset's parameter values, and keeps them per user under the local setting `webGPUDefaultPresentationFiles`, with a signature of each file's name, content hash, and parameters.
- `ensureDefaultPresentationFiles()` runs one update at a time.
  A user with a preset of their own needs none, a matching signature reuses the stored files without a download, and any other signature downloads every file again.
  The update is all or nothing: a failed download, source write, or settings write deletes the sources it stored and keeps the files from before.
  The replaced files' sources then go, unless the user's own preset holds them.
- A server without a default preset reads no catalog, and stores nothing while nothing was stored before.
- The first WebGPU play and the settings panel resolve `null` to these files; a failure never stops either, it only keeps the files from before.

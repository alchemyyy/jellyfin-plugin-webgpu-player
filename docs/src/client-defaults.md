# Client defaults from the server

An administrator sets a default for each WebGPU Player client setting on the plugin's settings page.
A user's own choice wins over the default, and the add-on's built-in default applies where the administrator set none.
An administrator can also apply a setting to all clients, which drops every user's own choice of it once.
The audio output device and a user's own decoders stay per browser, since a device id and IndexedDB content mean nothing in another browser.

## What the server stores

- `ClientDefaults/ClientDefaultsStore.cs` keeps the defaults in the plugin's data folder, beside `state.json`: `client-defaults.json`, `{ "version": 2, "settings": { ... }, "applied": { ... } }`.
  It writes the file through a temporary sibling, so a reader or a restart never sees part of it.
- A missing file loads as no defaults; so does an unreadable or other-version one, and the server logs why.
  A version 1 file, `{ "version": 1, "settings": { ... } }`, loads with no applied revisions; the next save writes version 2.
- `settings` maps a flat key, such as `brightness` or `presentationFiles`, to its default.
  The server checks only the document's shape and keeps each value verbatim; the add-on normalizes every value as it normalizes a user's stored choice, so an out-of-range default falls back to the built-in one.
- `applied` maps a flat key to the revision an administrator last applied it to all clients at, a positive integer.
  A client that has not yet honored a key's revision drops its user's own choice for that key, so the user follows the server's default, or the built-in one where the server sets none.
  Applying a key sets its revision to the larger of its previous revision plus one and the current Unix time in milliseconds, so revisions keep growing even after the file is deleted or reset.
  The bump happens under the store's lock, so concurrent saves never lose one.
  A save never removes a revision, and the file holds at most 64.
- `ClientDefaults/ClientDefaultsFunctions.cs` checks the shape:
  - the body is at most 64 KiB of strict JSON: no comments, trailing commas, or duplicate properties, and objects and arrays nested at most 16 deep, the root included;
  - the root is an object whose `settings` is an object;
  - `settings` holds at most 64 properties, each key an ASCII letter followed by up to 63 ASCII letters and digits, and no value is `null`;
  - `apply`, when present, is an array of at most 64 distinct keys of the same form; a key need not be in `settings`;
  - in the stored file, `applied` is an object of at most 64 such keys, each to a positive integer.

## Routes

`ClientDefaults/ClientDefaultsController.cs` answers below the server base URL, beside the [module routes](server-modules.md#routes).

| Route | Caller | Answer |
| --- | --- | --- |
| `GET WebGPUPlayer/ClientDefaults` | A signed-in user | `{ "settings": { ... }, "applied": { ... } }`, with `Cache-Control: private, no-cache` |
| `PUT WebGPUPlayer/ClientDefaults` | An administrator | Stores the `application/json` body, `{ "settings": { ... }, "apply": [ ... ] }`, bumps the revision of each key in `apply`, and answers with the stored `{ "settings": { ... }, "applied": { ... } }` |

- Every answer is camelCase JSON; the setting keys stay as stored, in `applied` too, which is `{}` when no setting was applied.
- A refused `PUT` answers with `{ code, detail }`: 400 `client-defaults-invalid` for a shape the store refuses or an `apply` that would take `applied` past 64 keys, 413 `client-defaults-size` past 64 KiB, and 500 `client-defaults-write-failed` for a write the data folder refused.
  The stored defaults and applied revisions stay as they were.

## The settings page

- The "Client defaults" section, above the decoders, holds `<div data-client-defaults></div>`.
- On every `viewshow`, `Configuration/configPage.js` calls `window.WebGPUPlayer`, the factory the plugin's bootstrap script defines, and awaits `renderClientDefaultsEditor(container)` of the add-on it resolves to; the editor replaces the container's content.
- Without the factory or the method, or when either rejects, the container shows a plain English message that the add-on is not loaded in this page and the page needs a reload.
- The editor is the add-on's, so it speaks the user's language; the rest of the page stays English.

## The editor

- `index.ts` attaches `renderClientDefaultsEditor(element)` to the add-on entry; it loads the add-on's strings and `ui/ClientDefaultsEditor.ts`, which webpack emits as its own chunk, `webgpu-client-defaults-editor`.
- The editor reads the server's defaults and its pass catalog; a failed read shows in the status line, and the rest of the form stays usable.
- Reading the defaults applies them to the page, as the sync's read does, but only the sync's read caches them for the next page.
- Save and every "Retroactively apply to clients" button stay disabled when the defaults could not be read: a save replaces every default, so a form that never showed them would drop them.
- The editor takes half the page's width, but no less than 30em or the page's width.
- It has one row per flat key, grouped and labelled like the in-player settings windows, with their ranges, units, and options from `ui/SettingDefinitions.ts`.
- The "Decoder tests" section leads the editor, so it sits at the top of the plugin's settings (11-05).
  It says what decoder tests are, and that a device which only controls others needs none; [The client add-on](add-on.md#decoder-test-timing) has the values and the rules syntax.
  - `decoderTestTiming` is a select of the three timings, like any user setting.
  - `decoderTestBackgroundDevices` is a checkbox per device type, desktop browsers, phones and tablets, and TVs and consoles; its value is the checked types, in that order, and none checked is a value of its own.
  - `decoderTestRules` is a text box that wraps no line, with the syntax beneath it, the problems of its rules, live, as it is edited, each naming its line, and this browser's device type and its `client`, `device`, `version`, and `ua` values from `describeDecoderTestClient()`, for copying into a rule.
- Each row shows the server's value read through the client's own normalization, or the add-on's built-in value where the server sets none.
- A server value that reads otherwise, such as a refused type or an out-of-range number, shows what clients take instead, and the status line names it.
  Device types in another order read as the same value.
- Each row, and the default shader preset beside its Add button, has buttons at the end of the row, which wrap below a control too narrow to share it:
  - "Reset to default" shows the add-on's built-in value, or empties the preset, in the form; Save stores it.
  - "Retroactively apply to clients" saves the form, as Save does, with the row's key in `apply`; the status line then names the setting.
    The decoder test device types and rules have none, since no user chooses them.
- The default shader preset lists the server's pass files in order, at most 16.
  Each file shows the parameters and constants its passes declare, from the source the editor downloads and parses with the engine's `parsePassFile`, with each one's default and range.
  A file the catalog no longer offers stays listed, marked, and removable.
  A file whose source cannot be read keeps the parameter values the server holds for it.
- Save stores each row's value that differs from the built-in one, so a row equal to it follows the built-in default, and, when the list holds a file, `presentationFiles` with only the parameter values that differ from the pass defaults.
  The device types differ when they hold other types, whatever their order.
  The form then shows what the server stored; a refusal shows its `<code>: <detail>` in the status line.
- Save, and every "Retroactively apply to clients" button, store nothing while the rules have a problem: a line `parseDecoderTestRules` refuses, or a text past 4096 characters.
  The status line then names each problem, by its line, as the text box does; clients would ignore the invalid lines, so the editor keeps an administrator from storing rules that do less than they read.

## Applied settings on clients

- `ServerClientDefaults.ts` reads the server's `applied` with its `settings`, and caches both per server; a cache of an earlier version, the settings alone, reads with no applied revisions.
- Each read, cached or fresh, and the editor's, first runs `honorAppliedClientDefaults()` from `AppliedClientDefaults.ts` while a user is signed in, then applies the defaults.
- It compares each key's revision with the one the user last honored, kept per user under the local setting `webGPUHonoredClientDefaults`.
  For each newer key it drops the user's own choice:
  - the stored `webGPUPlaybackSettings` leaf, through `clearWebGPUUserSettingChoices()`, which first stores settings of an earlier version in the current one;
  - the stored `preferredVideoPlayer` or `webGPUAudioDownmixAlgorithm`, emptied;
  - for `presentationFiles`, the user's own preset, whose sources go unless the default files hold them.
- It then records the revisions it honored, so a choice the user makes afterwards stays theirs until the next apply.
- A dropped choice tells the defaults' subscribers, even when the defaults themselves did not change, so the page's settings follow at once.

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
- The first WebGPU play and the settings windows resolve `null` to these files; a failure never stops either, it only keeps the files from before.

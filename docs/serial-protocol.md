# MKYADA serial protocol (v4)

v4 (firmware 0.5.0) is a **capability signal only** — no new messages. A
device announcing `proto >= 4` in `hello` understands the v4 **stream macro
layout** (JSONL, see macro-format.md): the app then writes full-fidelity
recordings instead of thinned ones. Classic whole-file macros keep playing.

Firmware 0.7.0 adds **additive** messages/fields (still proto 4 — old hosts
ignore them, old firmware never receives them): `hello.model` + `hello.pins`,
the `macro_changed` / `enc` / `pin` announcements, the `pin_detect` command,
and the `btn.slot` variant for the Vision 6 module buttons. See
[Two models](#two-models-firmware-070) below.

v3 adds the `fs_*` file management commands (hidden-drive mode).
v2 (firmware 0.3.0) adds: `btn` streaming in standalone mode, the `key_action`
announcement for key-logic variants, and the `led` feedback override. v1 hosts
keep working — all v1 messages are unchanged.

Transport: **JSON-lines over the second USB CDC channel** (`usb_cdc.data`).
One JSON object per `\n`-terminated line, both directions. The `t` field is the
message type. Commands are tiny by design — **bulk data (configs, macros) never
travels over serial**; the host writes files to the CIRCUITPY drive, flushes,
then sends `reload` or `play`.

Device discovery: scan serial ports for USB product string **"MKYADA Keypad"**,
open the *data* interface, send `identify`, expect `hello`. Match the serial
port to its CIRCUITPY volume via the `UID:` line in `boot_out.txt` vs `hello.uid`.

## Layer announcements

Whenever the active layer changes (layer key pressed, `set_layer`, `reload`)
the device emits:

```json
{ "t": "layer", "layer": "b" }
```

The app uses it for the live layer indicator in the sidebar.

## Modes

```
STANDALONE ──(host_enter)──► HOST ──(host_leave | CDC disconnect | 5 s without any message)──► STANDALONE
```

- **Standalone:** keys play their macro files locally; serial commands still
  work. Since proto v2, key edges are **also streamed as `btn`** while an app
  is connected (the device still acts on them itself) — this powers
  computer-side key actions and the live keypad view without host mode.
- **Host:** keys do **not** act locally; every edge is streamed as `btn` and the
  device only acts on host commands. The app must send `ping` every ~2 s.

## Host → Device

| Message | Effect |
|---|---|
| `{"t":"identify"}` | Reply with `hello` |
| `{"t":"ping"}` | Reply `pong`; refreshes the host-mode watchdog |
| `{"t":"host_enter"}` / `{"t":"host_leave"}` | Switch mode; reply `ok` |
| `{"t":"play","file":"macros/key1.json","speed":1.5,"repeat":2}` | Play a file from the drive. `speed`/`repeat` optional (default: the macro's own `settings`; `repeat: 0` = loop) |
| `{"t":"stop"}` | Abort current playback |
| `{"t":"keys","mods":["CTRL","SHIFT"],"key":"s"}` | Tap a combo directly (no file) |
| `{"t":"get_config"}` | Reply with `config` |
| `{"t":"reload"}` | Re-read `config.json` (send after writing files); resets layer to A; replies `ok` + fresh `hello` |
| `{"t":"set_layer","layer":"b"}` | Force the active layer |
| `{"t":"led","mode":"solid","rgb":[255,0,0]}` | v2. Override the status LED with a feedback color (`mode`: `solid` \| `blink` \| `off`). Playback blinks still win; the override auto-clears when the app disconnects, so the standalone LED grammar is untouched. |
| `{"t":"fs_list","path":"macros"}` | v3. Reply with `fs_list` (directory entries) |
| `{"t":"fs_read","path":"macros/key1.json"}` | v3. Stream the file back as `fs_chunk` messages; the host must answer each non-final chunk with `{"t":"fs_ack"}` (one chunk in flight) |
| `{"t":"fs_write","path":"macros/key1.json","seq":0,"data":"<base64>","eof":false}` | v3. Chunked upload (≤3 KB raw per chunk); every chunk is acknowledged with `ok`. Written to `<path>.part`, renamed into place on `eof` — a dropped transfer never corrupts the target. Needs a writable filesystem, i.e. `usb_drive: false` (otherwise `err readonly`) |
| `{"t":"fs_delete","path":"macros/key1.json"}` | v3. Delete a file; replies `ok` |
| `{"t":"pin_detect","on":true}` | fw 0.7.0. Key-wiring wizard: normal key handling is suspended, every non-reserved edge GPIO is watched and edges stream back as `pin` messages. Auto-disarms after 120 s, on app disconnect, or on `reload`. `{"on":false}` restores the keys |

## Device → Host

| Message | When |
|---|---|
| `{"t":"hello","fw":"0.1.4","proto":1,"format":"mkyada","uid":"e66...","key_count":6,"layer_key":null,"layer_count":2,"layer_mode":"toggle","key_map":[1,2,3,4,5,6],"layer":"a","mode":"standalone"}` | Reply to `identify`, and after `reload`. Since fw 0.7.0 also `"model":"core6"\|"vision6"` (absent = core6) and `"pins":["GP0",...]` (the GPIO names actually driving keys 1..n) |
| `{"t":"macro_changed","file":"/macros/key3-b.json","reason":"speed"}` | fw 0.7.0, Vision 6. The user edited that macro's `settings.speed` on the device (persisted into the file). The app should re-read the file / refresh its cache |
| `{"t":"enc","d":1,"n":3}` | fw 0.7.0, Vision 6, host mode. Encoder detents (`d` = direction, `n` = count batched per poll) — lets the app run computer-side wheel actions |
| `{"t":"btn","slot":"back","down":true}` | fw 0.7.0, Vision 6, host mode. Module buttons (`psh` \| `back` \| `confirm`) — the slot variant of `btn`, distinct from key events |
| `{"t":"pin","pin":"GP13","down":true}` | fw 0.7.0. While `pin_detect` is armed: a watched GPIO changed — the wiring wizard assigns it to the key being probed |
| `{"t":"btn","key":2,"phys":4,"layer":"a","edge":"down"}` | Every press/release. `key` = logical (after `key_map`), `phys` = GPIO number. Host mode: always; standalone: since v2, while an app is connected |
| `{"t":"key_action","file":"/macros/key2.json","key":2,"layer":"a","variant":"double"}` | v2. A key with key-logic `variants` resolved its gesture (`tap` \| `double` \| `hold`) in standalone mode. The app uses it to run host-side variants (launch/command/sound) |
| `{"t":"play_start","file":"/macros/key1.json"}` | Playback began |
| `{"t":"play_done","file":"/macros/key1.json","stopped":false}` | Playback ended (`stopped: true` = aborted) |
| `{"t":"config", ...config.json fields...}` | Reply to `get_config` |
| `{"t":"ok","re":"reload"}` | Command acknowledged |
| `{"t":"err","re":"play","code":"not_found","msg":"/macros/key9.json"}` | Codes: `not_found`, `bad_json`, `bad_format`, `oom` |
| `{"t":"pong"}` | Reply to `ping` |
| `{"t":"fs_list","path":"/macros","entries":[{"name":"key1.json","size":123,"dir":false}]}` | v3. Reply to `fs_list` |
| `{"t":"fs_chunk","path":"/macros/key1.json","seq":0,"data":"<base64>","eof":true}` | v3. `fs_read` stream; the last chunk carries `eof: true` |
| `{"t":"ok","re":"fs_write","seq":3,"eof":true}` | v3. Chunk acknowledged (final ack carries `eof`) |
| `{"t":"err","re":"fs_write","code":"readonly"}` | v3. fs codes: `bad_path`, `bad_seq`, `not_found`, `readonly` (drive visible → host owns the filesystem), `io`, `busy` (mid-playback) |

## Playback interaction rules

- During playback the device still answers `ping`/`identify` and honors `stop`.
- **Panic stop:** pressing the key that started the macro (standalone), or any
  key (host-commanded playback), aborts it and releases all pressed inputs.
- `fs_*` commands during playback are answered with `err busy` (so the app
  never waits on a reply that will not come); everything else is ignored.

## Hidden-drive mode (v3)

`config.json` may set `"usb_drive": false`: boot.py then hides the CIRCUITPY
drive from the host (finished-product mode) and remounts the filesystem
writable for the firmware, which is what makes `fs_write`/`fs_delete`
possible. The app manages every file over the `fs_*` commands and passes a
`serial:<uid>` sentinel instead of a mount path internally. `hello` reports
the state as `usb_drive` (absent on firmware < 0.4.0). Recovery without the
app: hold key 1 while plugging the keypad in — GP0 on Core 6, GP29 (macro
key 1) on Vision 6, whose GP0 belongs to the OLED. The drive comes back for
that session.

## Two models (firmware 0.7.0)

One firmware serves both devices; `config.json "model"` picks the variant
(`"core6"` default; a config-less board auto-probes I2C 0x3C once):

- **core6** — unchanged behavior, plus the additive hello fields.
- **vision6** — SH1106 OLED + EC11 encoder + BACK/CONFIRM buttons.
  `layer_key` is always `null` (all six keys are macro keys); the layer is
  chosen on the device screen, `layer_count` may be 1..8 (a single layer
  shows just A + SETTINGS on the home screen). USB product string is
  "MKYADA Vision 6". Discovery matches the "MKYADA" prefix either way.

`config.json` additions (both models): `"model"`, and `"pins"` — an explicit
per-key GPIO-name list (e.g. `["GP29","GP28","GP27","GP26","GP15","GP13"]`)
for keys soldered off the model's default order; `null` = default. Reserved
pins are refused (core6: GP16; vision6: GP0-GP6 + GP16).

### Encoder / module-button custom slots (vision6)

The app may assign macros to four virtual slots, stored exactly like key
macros: `macros/enc-cw.json`, `macros/enc-ccw.json`, `macros/btn-back.json`,
`macros/btn-confirm.json` (+ `-<layer>` suffix; a layer without its own file
falls back to the unsuffixed one). When any slot is assigned on the active
layer, the resting grid plays those macros on rotate/press instead of menu
navigation; the encoder push (PSH) always stays a menu key (it toggles a
temporary select mode with default navigation). Empty slots = built-in menu
behavior. On-device speed edits rewrite the target file's `settings.speed`
and announce `macro_changed`; a visible (read-only) drive degrades the edit
to an explanatory screen.

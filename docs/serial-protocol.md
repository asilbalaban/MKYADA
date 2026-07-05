# MKYADA serial protocol (v2)

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

## Device → Host

| Message | When |
|---|---|
| `{"t":"hello","fw":"0.1.4","proto":1,"format":"mkyada","uid":"e66...","key_count":6,"layer_key":null,"layer_count":2,"layer_mode":"toggle","key_map":[1,2,3,4,5,6],"layer":"a","mode":"standalone"}` | Reply to `identify`, and after `reload` |
| `{"t":"btn","key":2,"phys":4,"layer":"a","edge":"down"}` | Every press/release. `key` = logical (after `key_map`), `phys` = GPIO number. Host mode: always; standalone: since v2, while an app is connected |
| `{"t":"key_action","file":"/macros/key2.json","key":2,"layer":"a","variant":"double"}` | v2. A key with key-logic `variants` resolved its gesture (`tap` \| `double` \| `hold`) in standalone mode. The app uses it to run host-side variants (launch/command/sound) |
| `{"t":"play_start","file":"/macros/key1.json"}` | Playback began |
| `{"t":"play_done","file":"/macros/key1.json","stopped":false}` | Playback ended (`stopped: true` = aborted) |
| `{"t":"config", ...config.json fields...}` | Reply to `get_config` |
| `{"t":"ok","re":"reload"}` | Command acknowledged |
| `{"t":"err","re":"play","code":"not_found","msg":"/macros/key9.json"}` | Codes: `not_found`, `bad_json`, `bad_format`, `oom` |
| `{"t":"pong"}` | Reply to `ping` |

## Playback interaction rules

- During playback the device still answers `ping`/`identify` and honors `stop`.
- **Panic stop:** pressing the key that started the macro (standalone), or any
  key (host-commanded playback), aborts it and releases all pressed inputs.
- All other commands received during playback are ignored.

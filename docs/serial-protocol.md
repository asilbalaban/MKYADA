# MKYADA serial protocol (v16)

v16 (firmware 0.29.0) is the **USB MIDI** release. No new message types; one
config key, one `hello` field, one macro event type and one Dial slot type:

- **`midi` config key** — when true the board presents a USB MIDI port named
  after the product ("MKYADA Vision 6" / "MKYADA Keypad"). It is **boot-time,
  like `usb_drive`**: `set_cfg` refuses it, so the app writes config.json and
  sends `{"t":"reset"}` (a `reload` does not re-run boot.py). Default false —
  an idle port clutters every DAW's device list and costs a USB endpoint.
- **It yields to a visible CIRCUITPY drive.** The RP2040 has 7 endpoint pairs
  and the firmware already spends 5 (HID 1 + CDC console 2 + CDC data 2), 6
  with the drive. Rather than sit on the ceiling, boot.py skips MIDI whenever
  the drive is visible, and the whole enable is wrapped: if it fails anyway
  the board still comes up with its keyboard and its serial link, which is
  what the app needs to talk it back out of a bad config.
- **`hello.midi`** mirrors the switch, so the app can gate both the Settings
  toggle and the `midi` action kind on a board that actually has the port.
- **New macro event `{"type":"midi", "m":…, "ch":…, "d1":…, "d2":…}`** and the
  Dial slot type `"midi_cc"` — both in
  [macro-format.md](macro-format.md). All additive: old apps never send
  either, old firmware skips unknown event types and treats an unknown slot
  type as a dead slot.

v15 (firmware 0.28.0) is the **Dial** release (kind `enc_module`) — a
device-native encoder toolset. No new message types; two existing ones gain a
meaning, and the HID mouse grows a report:

- **`ctx` can announce a device-local view.** Opening a Dial sends the usual
  `{"t":"ctx","key":…,"layer":…,"kind":"enc_module","file":…}` — but as an
  **announcement, not a menu request**. The app must NOT answer with a `menu`
  (new firmware ignores the reply while the module is open; the announce
  exists so the app can suppress its own handling of the `btn` edges streamed
  while the six keys are the module's slot selectors — same double-execution
  rule as the OBS Center). Everything the module does is plain HID performed
  by the device itself; it works identically with no app attached.
- **A device-local view now emits `menu_ev ev:"close"`** when it closes
  (BACK, or a transfer taking the screen), so the app can drop its edge
  suppression.
- **HID: relative pointer report (id 5)** on the mouse interface — buttons +
  dX/dY (int8), used by the Dial's mouse-drag slots to nudge the cursor from
  wherever the user has it (the id-2 pointer is absolute and would teleport).
  Report id 2 (absolute pointer) and id 4 (wheel/pan) are unchanged.

The Dial's on-device payload (`enc_module.slots`) is documented in
[macro-format.md](macro-format.md).

v14 (firmware 0.27.0) is the **meta sidecar** release. One new on-device
file, `/macros/meta.json`, managed by `mkyada/meta.py` — no new commands,
everything rides the existing `fs_*` ops:

```json
{"format": "mkyada-meta", "version": 1,
 "entries": {"key3": {"s": 25, "c": 3735928559, "z": 812340}}}
```

- **Per-stem override fields** — `s` (speed, integer tenths: 25 = 2.5×),
  `i` (icon name or `px:` picture), `n` (name). They shadow the macro
  header's `settings.speed` / `icon` / `name`. A device-side speed edit now
  writes this small file and never rewrites the macro body — the old
  whole-file rewrite could out-run the 8 s hardware watchdog on a long
  recording and corrupt the FAT mid-write (the field incident that
  reformatted a board). The app applies the same overlay when it reads
  macros, and uses the sidecar itself for header-only edits on big files
  (a recorded macro's speed/icon/name), so a 300 KB body never re-uploads
  for a one-field change. Per-profile speed keys on the profile's stem
  (`p_<id>_key3`) — the copy-on-write of the whole macro file is gone.
- **CRC manifest** — `c` (CRC32/IEEE of the macro file's bytes) and `z`
  (size), maintained by the firmware on every `fs_write` eof (it already
  accumulates the CRC for transfer verification), every `fs_delete`, and
  every wheel-menu reassign. This is what lets the app skip re-reading
  unchanged files at connect (per-UID cache diff). A file written by the
  rescue console has a stale/absent entry and is simply re-read — the
  manifest is advisory, never trusted over a mismatch.
- **Clear-on-write** — a serial write of a macro body drops that stem's
  override fields: the writer baked current values into the header, so a
  stale override must never shadow them. This single rule is also the
  old-app compatibility story: an old app's whole-file speed edit lands in
  the header and works, because the override it doesn't know about is
  cleared by its own write.
- `macro_changed reason:"speed"` is unchanged on the wire, but on proto ≥ 14
  the app answers it by re-reading the small sidecar, not the macro body.
- **`set_cfg`** — the one new command: live patches for display-level config
  fields (layer names, band toggles, timeout, lang) with no reload — see the
  Host → Device table.

Old firmware never creates the sidecar (the app then uses full writes, as
before); old apps never read it (clear-on-write keeps them correct).

v13 (firmware 0.26.0) is the **OBS Center** release. Three additions, all on
the existing `mtype:"obs"` shape and all additive:

- **`obsview:"center"`** — a third OBS view: the live dashboard a key of kind
  `obs_center` opens. Optional new fields on the same `menu` message: `mute`
  (bool — inverts the MIC label), `cpu` / `fps` / `drop` (ints — the health
  row), `klabels` (list of ≤6 short strings — the quick-key row along the
  bottom), and `focus` (`"mic"`|`"scene"` — which control row the wheel
  drives, drawn as a frame around that row's label). **A field the app never
  sends is a widget the device never draws**, and the enabled ones reflow
  vertically — that is how the app's per-key widget toggles reach the glass
  without a schema. On the center view a **held** CONFIRM sends
  `menu_ev ev:"mode"` (a tap still sends `fire`); the app answers by cycling
  `focus` — the device never owns the cycle.
- **Sticky re-renders** — while an `mtype:"obs"` menu is open, a re-send
  merges only the fields present in the message into the open menu (old
  behavior rebuilt the whole state). The app can push a 40-byte delta
  (`{"t":"menu","mtype":"obs","mic":42}`) between full re-asserts; the
  device's copy keeps everything else. Full pushes every ~5 s heal any delta
  lost during a repaint.
- **Key swallowing** — while the center view is open the six keys do NOT play
  their local macros. Their edges still stream as `btn` (as always), and the
  app runs them as the dashboard's quick actions. BACK closes the view (the
  usual `menu_ev ev:"close"`), and a transfer starting mid-session sends the
  same `close` so the app tears the session down.

Old apps never send `obsview:"center"` so old-vs-new pairings keep the exact
v12 behavior.

v12 (firmware 0.25.0) adds two things, both additive:

- **Hand-drawn icons** — the macro `icon` field may be the picture instead of a
  name: `"icon":"px:183c7effc3c30000"` is 16 hex digits, one byte per row,
  bit 7 = leftmost pixel — the same packing `icons/src/icons.txt` compiles to.
  `icons.get()` decodes it rather than looking it up, so a drawing needs no
  second file, no index, and travels inside the macro it belongs to (a backup
  carries it; a delete takes it with them). A malformed one reads as "no icon"
  and falls back to the kind's default. Firmware < 0.25.0 simply doesn't
  recognise the name and draws that default, so the app only offers the
  drawing grid above it.
- **`wheel_layers` in `hello`** — the Vision 6 wheel-paging mode (config.json
  `"wheel_layers"`, already editable in the device's own SETTINGS menu) is now
  reported, so the app can render the switch for it. Absent = firmware that
  predates the field, which is how the app knows to say so.

v11 (firmware 0.23.0) is the **new menu** release. Two additions:

- **Macro `icon`** — a macro file may carry a top-level `"icon":"<name>"` naming
  one of the 270 icons in `icons/src/icons.txt`. The Vision 6 grid draws it
  above the key's name. Absent means "the action kind's default"
  (`KIND_ICON` in `firmware/mkyada/ui.py`), which is what every existing file
  gets. Icons are addressed **by name, never by index**, so extending or
  reordering the family cannot repoint an existing macro at a different
  picture; an unknown name falls back to the default rather than blanking the
  cell. Old firmware ignores the field entirely. Since v12 the field may also
  carry the eight rows inline (`px:` above) instead of a name, and the reserved
  name `"none"` means *draw nothing* — distinct from an absent field, which
  means "use the kind's default".
- **`mtype:"obs"`** — a fourth wheel-menu shape (see `menu` below): a live OBS
  status screen rather than a chooser.

Both are **additive**. An old app never sends either and a new device behaves
exactly as v10; a new app talking to old firmware gets the unknown `mtype`
drawn as a card and the unknown `icon` field skipped.

v10 (firmware 0.20.0) removed `font` from `hello` and from `config.json`: one
font ships with the firmware and the device no longer takes a choice.

v9 (firmware 0.18.0) adds the **context-aware wheel menu** on the Vision 6.
Pressing the wheel (CONFIRM) on a selected key no longer always opens the speed
editor — it opens a menu that fits the key's action. Local kinds (keystroke
turbo, media, scroll, the speed editor) run entirely on the device. Host kinds
(OBS, webhook, command, launch, sound, mic, system volume) ask the app for a
menu over new messages:
- `{"t":"hostinfo","menus":1}` (host→device) — the app advertises wheel-menu
  support. Sent on every `hello`. Without it (an old app), host-kind keys keep
  showing the "app required" toast; the flag clears on disconnect.
- `{"t":"ctx",...}` (device→host) — a host-kind key was pressed; the app should
  answer with a `menu`.
- `{"t":"menu",...}` (host→device) — render/update the on-screen menu (a
  scrollable `list`, a `slider`, or a status `card`). Re-send to live-update
  (REC timer, external volume). 
- `{"t":"menu_ev",...}` (device→host) — the user turned/pressed/closed the menu.
- `{"t":"menu_result",...}` (host→device) — close the menu, optionally toast and
  invalidate a rewritten macro's cached label.

All are **additive**: old firmware ignores the unknown `menu`/`hostinfo`/
`menu_result` types and never sends `ctx`/`menu_ev`; a new device paired with an
old app simply never sees `hostinfo` and keeps the local behavior.

v8 (firmware 0.15.0) added `{"t":"profile","id":"p_<id>"}` (host→device): the
app activates a per-app profile natively — macro paths redirect to the
profile's files so the on-device grid, wheel and speed editor run it without
host mode. `{"id":null}` clears it. Replies `ok`.

v7 (firmware 0.11.0) is the update-safety release:
- **Locked update mode** — `{"t":"update_begin","bytes":N}` suspends keys,
  menus and playback, shows a progress screen on the Vision 6, and accepts
  only transfer traffic (`fs_*`, `update_*`, `get_config`, `reset`,
  `bootloader`) until `{"t":"update_end"}` (ok + hard reset) or
  `{"t":"update_abort"}` (unlock, back to normal). Anything else is refused
  with `{"t":"err","code":"updating"}`. If the app goes silent for 30 s
  mid-update (or disconnects), the device unlocks itself.
- **CRC-verified transfers** — the final `fs_write` chunk may carry
  `"crc": <CRC32 of the whole file>`; the device verifies before the atomic
  rename and answers `{"t":"err","code":"crc"}` on mismatch (the `.part` is
  discarded — a corrupted transfer can never replace a good file). The eof
  `ok` and the final `fs_chunk` of `fs_read` always carry the device-computed
  `"crc"` so either side can verify.
- **`{"t":"bootloader"}`** — reboots into the UF2 bootloader
  (`microcontroller.RunMode.UF2`), so CircuitPython itself can be reflashed
  on a sealed unit without the physical BOOT button.
- **Rescue console** — if the main firmware fails to import or construct,
  `code.py` answers `identify` itself with
  `{"t":"hello","mode":"rescue","err":"<repr of the failure>",...}` and
  serves `fs_*` / `reset` / `bootloader` using builtins only, so the app can
  always rewrite the firmware and reboot the board. LED blinks red.
- Firmware-side hardening (no wire changes): auto-reload is disabled (file
  copies onto the visible drive no longer reboot the board per file — the
  app ends updates with an explicit `reset`), a hardware watchdog hard-resets
  a hung firmware (config `"watchdog": false` opts out for bench debugging),
  serial keeps draining during tap/double/hold gesture resolution, and
  `usb_cdc` writes carry a timeout so a stalled host can never wedge the
  keypad.

v6 (firmware 0.10.0) adds:
- `{"t":"scroll"}` — direct wheel ticks with optional modifiers. The app
  drives profile wheel slots through this instead of per-detent `play`
  round-trips, and applies its own acceleration (Settings → Keypad → Wheel
  acceleration), so a spin feels like a real mouse wheel.
- `label.keys` — the profile's six key names; the Vision 6 host-mode screen
  shows them as a grid instead of the bare "Connected to app" text.
- The mouse HID interface is split into two reports (pointer id 2: buttons +
  absolute X/Y; scroll id 4: wheel + pan). Scrolling no longer re-asserts
  the last absolute position, which used to teleport the cursor to screen
  center. Needs a power-cycle after a firmware update (boot.py re-runs).

v5 adds `hold: true` on `play`: for a plain single-key macro the device
presses the HID key and **keeps it down until `stop`** (or until the app goes
silent) — the host OS's typematic repeat then types like a held letter key.
This is how host mode gives profile single keys the real-keyboard hold that
standalone keys get natively (see macro-format.md `settings.hold_repeat`).

v4 (firmware 0.5.0) is a **capability signal only** — no new messages. A
device announcing `proto >= 4` in `hello` understands the v4 **stream macro
layout** (JSONL, see macro-format.md): the app then writes full-fidelity
recordings instead of thinned ones. Classic whole-file macros keep playing.

Firmware 0.7.0 adds **additive** messages/fields (still proto 4 — old hosts
ignore them, old firmware never receives them): `hello.model` + `hello.pins`,
the `macro_changed` / `enc` / `pin` announcements, the `pin_detect` command,
and the `btn.slot` variant for the Vision 6 module buttons. See
[Two models](#two-models-firmware-070) below.

Firmware 0.9.0 adds the additive `label` command (the app pushes its active
profile name for the Vision 6 grid band) plus the config fields
`show_layer` / `show_profile` and their mirrors in `hello` — the band over
the macro grid that names the active layer and/or the app's active profile
(issue #18). Old firmware ignores `label`; old hosts never see the fields.

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
| `{"t":"play","file":"macros/key1.json","speed":1.5,"repeat":2}` | Play a file from the drive. `speed`/`repeat` optional (default: the macro's own `settings`; `repeat: 0` = loop). v5: optional `"hold": true` — a plain single-key macro is pressed and **held until `stop`** (real-keyboard hold; the sender must send `stop` on the key's up edge) |
| `{"t":"stop"}` | Abort current playback |
| `{"t":"keys","mods":["CTRL","SHIFT"],"key":"s"}` | Tap a combo directly (no file) |
| `{"t":"get_config"}` | Reply with `config` |
| `{"t":"set_cfg","patch":{"layer_names":["Oyun"],"show_layer":true}}` | v14. Patch display-level config fields LIVE — applied, persisted into config.json and repainted with **no reload** (issue: a layer rename used to cold-restart the board and re-read every macro). Whitelist: `layer_names`, `show_layer`, `show_profile`, `wheel_layers`, `timeout`, `lang`. Values are validated/normalized like `load_config` does. Replies `ok` + a fresh `config` announcement; unknown fields → `err bad_field`, bad values → `err bad_value`. Structural fields (key_count, layers, pins, model, usb_drive, enc_swap) stay on the config-write + `reload` path on purpose |
| `{"t":"reload"}` | Re-read `config.json` (send after writing files); resets layer to A; replies `ok` + fresh `hello` |
| `{"t":"set_layer","layer":"b"}` | Force the active layer |
| `{"t":"led","mode":"solid","rgb":[255,0,0]}` | v2. Override the status LED with a feedback color (`mode`: `solid` \| `blink` \| `off`). Playback blinks still win; the override auto-clears when the app disconnects, so the standalone LED grammar is untouched. |
| `{"t":"fs_list","path":"macros"}` | v3. Reply with `fs_list` (directory entries) |
| `{"t":"fs_read","path":"macros/key1.json"}` | v3. Stream the file back as `fs_chunk` messages; the host must answer each non-final chunk with `{"t":"fs_ack"}` (one chunk in flight) |
| `{"t":"fs_write","path":"macros/key1.json","seq":0,"data":"<base64>","eof":false}` | v3. Chunked upload (≤3 KB raw per chunk); every chunk is acknowledged with `ok`. Written to `<path>.part`, renamed into place on `eof` — a dropped transfer never corrupts the target. Needs a writable filesystem, i.e. `usb_drive: false` (otherwise `err readonly`) |
| `{"t":"fs_delete","path":"macros/key1.json"}` | v3. Delete a file; replies `ok` |
| `{"t":"label","text":"Photoshop","keys":["Zoom in","Zoom out","Undo","","",""]}` | fw 0.9.0, Vision 6. Name of the app's active profile (≤24 chars) for the grid band shown when config `show_profile` is on. Since v6 the optional `keys` (6 strings, ≤24 chars each) are the profile's key names — the host-mode screen draws them as a grid. Empty text / absent keys clear; the device also drops both on app disconnect. Replies `ok` |
| `{"t":"scroll","dy":4,"dx":0,"mods":["ctrl_l"]}` | v6. Direct wheel ticks: `dy` vertical, `dx` horizontal (sign = direction, ≤20 per burst), optional `mods` held around the burst (Ctrl+wheel = zoom). No file, no `play_start`/`play_done` — the profile-wheel fast path. Replies `ok`, or `err hid` if the USB stack rejects the report |
| `{"t":"pin_detect","on":true}` | fw 0.7.0. Key-wiring wizard: normal key handling is suspended, every non-reserved edge GPIO is watched and edges stream back as `pin` messages. Auto-disarms after 120 s, on app disconnect, or on `reload`. `{"on":false}` restores the keys |
| `{"t":"hostinfo","menus":1}` | v9, Vision 6. The app advertises wheel-menu support. Send once per `hello`. Enables the context-aware wheel menu for host-kind keys; without it they show the "app required" toast. No reply. Cleared on disconnect |
| `{"t":"sysvol","percent":40}` | v9, Vision 6. The live system output volume (0–100); the device can't read it, so the app pushes it (on change) while connected. Volume-kind grid cells show the `%`. No reply. Cleared on disconnect |
| `{"t":"menu","mtype":"list","key":3,"layer":"a","title":"SCENE","items":[["Intro","Intro",1],["Game","Game",0]],"sel":0,"action":"Pick"}` | v9, Vision 6. Render/update the open wheel menu. `mtype`: `card` (title + `big` hero line + optional `l1`/`l2` status + `hint` action), `slider` (`value`/`min`/`max`/`step`/`unit` + `action`), `list` (`items` = `[id,label,mark]`, `sel` cursor, `action`). Re-send to live-update; the device keeps the cursor and idle timer. Ignored unless a menu is open for `key` |
| `{"t":"menu","mtype":"obs","key":2,"obsview":"rec","rec":true,"live":false,"mic":60,"time":"00:12","scene":"Intro","hint":"stop"}` | v11, Vision 6. A live OBS status screen instead of a chooser. `obsview`: `rec` (recorder card — one large timer) or `main` (full status: state chip, timer, scene pill, mic segments). `rec`/`live` drive the state chip, `mic` is 0–100, `time` is the elapsed string, `scene` the active scene. Push it as often as you like — there is no cursor to lose, so a re-render is pure data. The **blinking record dot is the device's own**, on a 0.6 s clock, so it keeps its rhythm when a push is late. CONFIRM sends `menu_ev ev:"fire"`, a wheel step sends `ev:"value"` with `v: ±1` |
| `{"t":"menu","mtype":"obs","key":4,"layer":"a","obsview":"center","rec":true,"live":false,"time":"00:42:10","scene":"Gameplay","mic":64,"mute":false,"cpu":8,"fps":60,"drop":0,"focus":"mic","klabels":["MUTE","CAM","CLIP","","","REC"]}` | v13, Vision 6. The OBS Center dashboard (kind `obs_center`). Every field beyond `obsview` is optional: **an absent field is a widget the device never draws**, and the enabled ones reflow (the timer renders 2× unless everything is on at once). `mute` inverts the MIC label; `cpu`/`fps`/`drop` fill the health row; `klabels` (≤6 strings, ≤6 chars, drawn fitted to ~5) is the quick-key row; `focus` frames the control row the wheel drives (`mic`\|`scene`). **Re-sends merge**: only the fields present in the message change, so `{"t":"menu","mtype":"obs","mic":42}` is a legal 40-byte delta — push a full state every ~5 s to heal lost deltas. While this view is open the six keys don't play their macros (their `btn` edges are the app's quick actions), there is no idle timeout, a **held** CONFIRM sends `menu_ev ev:"mode"` (focus cycle), and BACK closes it |
| `{"t":"menu_result","ok":true,"toast":["SCENE","Saved"],"changed":"/macros/key3-a.json"}` | v9, Vision 6. Close the open menu. `toast` (optional `[title,line]`) shows briefly; `changed` (optional path) invalidates that macro's cached label so the grid updates without a `reload`. `ok:false` shows the toast as an error |

## Device → Host

| Message | When |
|---|---|
| `{"t":"hello","fw":"0.1.4","proto":1,"format":"mkyada","uid":"e66...","key_count":6,"layer_key":null,"layer_count":2,"layer_mode":"toggle","key_map":[1,2,3,4,5,6],"layer":"a","mode":"standalone"}` | Reply to `identify`, and after `reload`. Since fw 0.7.0 also `"model":"core6"\|"vision6"` (absent = core6) and `"pins":["GP0",...]` (the GPIO names actually driving keys 1..n) |
| `{"t":"macro_changed","file":"/macros/key3-b.json","reason":"speed"}` | fw 0.7.0, Vision 6. The user edited that macro's `settings.speed` on the device (persisted into the file). The app should re-read the file / refresh its cache |
| `{"t":"enc","d":1,"n":3}` | fw 0.7.0, Vision 6, host mode. Encoder detents (`d` = direction, `n` = count batched per poll) — lets the app run computer-side wheel actions |
| `{"t":"btn","slot":"back","down":true}` | fw 0.7.0, Vision 6, host mode. Module buttons (`psh` \| `back` \| `confirm`) — the slot variant of `btn`, distinct from key events |
| `{"t":"ctx","key":3,"layer":"a","kind":"obs","sub":"setScene","file":"/macros/key3-a.json"}` | v9, Vision 6. The wheel was pressed on a host-kind key (`kind` = `obs`/`obs_center` (v13)/`webhook`/`command`/`launch`/`sound`/`mic`/`volume`; `sub` = the action detail, e.g. the OBS action or media usage; `file` = the exact macro path, profile-aware). The app answers with a `menu`. Only sent after `hostinfo`. For `obs_center` a bare key press opens the menu too (like `volume`/`mic_level`). v15: `kind:"enc_module"` is an **announcement only** — the Dial is device-local, the app must not answer with a `menu` (it only mutes its own `btn` handling until `menu_ev ev:"close"`) |
| `{"t":"menu_ev","ev":"pick","id":"Intro"}` | v9, Vision 6. The user acted on the open menu: `pick` (a **tap** on a list item — use it live), `assign` (a **hold** on a list item — reassign the key to it), `fire` (a card's CONFIRM), `value` (`v` = a slider's new value, or ±1 on a card), `close` (BACK / idle / disconnect). The app performs it and usually replies `menu`/`menu_result` |
| `{"t":"pin","pin":"GP13","down":true}` | fw 0.7.0. While `pin_detect` is armed: a watched GPIO changed — the wiring wizard assigns it to the key being probed |
| `{"t":"btn","key":2,"phys":4,"layer":"a","edge":"down"}` | Every press/release. `key` = logical (after `key_map`), `phys` = GPIO number. Host mode: always; standalone: since v2, while an app is connected |
| `{"t":"key_action","file":"/macros/key2.json","key":2,"layer":"a","variant":"double"}` | v2. A key with key-logic `variants` resolved its gesture (`tap` \| `double` \| `hold`) in standalone mode. The app uses it to run host-side variants (launch/command/sound). Since fw 0.9.0 a Vision 6 module slot resolving its own gesture announces the same message with `"key": null` and the slot's file path |
| `{"t":"play_start","file":"/macros/key1.json"}` | Playback began |
| `{"t":"play_done","file":"/macros/key1.json","stopped":false}` | Playback ended (`stopped: true` = aborted) |
| `{"t":"config", ...config.json fields...}` | Reply to `get_config` |
| `{"t":"ok","re":"reload"}` | Command acknowledged |
| `{"t":"err","re":"play","code":"not_found","msg":"/macros/key9.json"}` | Codes: `not_found`, `bad_json`, `bad_format`, `oom`, `io`, `hid` (USB stack rejected a report — boot.py descriptor older than engine.py after a partial update; power-cycle to heal) |
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

The CIRCUITPY drive is **hidden by default** (finished-product mode) — it is
shown to the host only when `config.json` sets `"usb_drive": true`. When
hidden, boot.py remounts the filesystem writable for the firmware, which is
what makes `fs_write`/`fs_delete` possible. The app manages every file over
the `fs_*` commands and passes a `serial:<uid>` sentinel instead of a mount
path internally. `hello` reports the state as `usb_drive` (absent on firmware
< 0.4.0). An absent/unreadable config keeps the drive hidden — the same
default a fresh firmware install gets. Recovery without the
app: hold key 1 while plugging the keypad in — GP0 on Core 6, GP29 (macro
key 1) on Vision 6, whose GP0 belongs to the OLED. The drive comes back for
that session.

## USB MIDI (v16)

`config.json "midi": true` makes the board present a USB MIDI port alongside
the keyboard, so a `midi` key can drive a DAW with nothing running on the
computer. Off by default. Like `usb_drive` this is decided in boot.py, so
`set_cfg` refuses the field — write config.json and `{"t":"reset"}`; a
`reload` will not re-run boot.py. `hello` reports it as `midi` (absent on
firmware < 0.29.0).

The port is named after the product string. Two host quirks worth knowing:
Windows will not enumerate a device whose audio-control interface name is over
31 characters (both product strings are well under), and macOS caches MIDI
port names in Audio MIDI Setup, so a renamed port needs that cache cleared
before the new name shows up.

MIDI is skipped while the CIRCUITPY drive is visible. The RP2040 has 7 USB
endpoint pairs; the firmware already spends 5, or 6 with the drive, and MIDI
wants one more — rather than sit exactly on the ceiling, the drive wins,
because the drive is the recovery path.

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

### Grid band (firmware 0.9.0, vision6)

`config.json` `"show_layer"` / `"show_profile"` (booleans, default false)
draw an inverted strip over the macro grid; the six cells squeeze under it.
`show_layer` names the active layer ("Layer A") — fully device-side.
`show_profile` shows the last `label` text the app pushed (its active
per-app profile); with both on the band reads "A: Photoshop". Both toggles
are editable in the app (Settings → Keypad, config write + `reload`) and on
the device (SETTINGS menu, which rewrites config.json like the language
setting — needs the hidden-drive mode, else the filesystem is host-owned
and the device shows the read-only notice). `hello` mirrors both fields so
the app can render the switches without reading the file.

`config.json` `"wheel_layers"` (boolean, default false) is the third screen
toggle and rides the same path: past the sixth tile the wheel wraps into the
next layer's first key instead of stopping, and the grid grows a page
counter. Off by default — it changes what the wheel does, and an existing
keypad must not have that move under it on an update. `hello` reports it
since v12 (firmware 0.25.0); before that the app can't read the state and
says so instead of guessing.

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

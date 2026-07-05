# mkyada-macro JSON format (v2 / v3)

A macro is a single JSON file. **Everything a key can do is a macro file** — a
plain Ctrl+A binding, a typed text snippet, a media key, or a full recorded
mouse+keyboard sequence. Copy the file to another board and it behaves
identically.

## Top level

```json
{
  "format": "mkyada-macro",
  "version": 2,
  "name": "Select All",
  "created": "2026-07-04T12:00:00Z",
  "kind": "combo",
  "combo": { "mods": ["CTRL"], "key": "A" },
  "screen": { "width": 1920, "height": 1080 },
  "settings": { "speed": 1.0, "repeat": 1 },
  "events": [ ... ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `format` | yes | `"mkyada-macro"`. Legacy `"asil-macro"` (v1) files are also accepted. |
| `version` | yes | `2`, or `3` when the file carries key-logic `variants` |
| `name` | no | Display name |
| `created` | no | ISO 8601 timestamp |
| `kind` | no | UI metadata: `"combo"` \| `"keystroke"` \| `"text"` \| `"media"` \| `"recorded"` \| `"launch"` \| `"command"` \| `"sound"` \| `"sequence"`. The firmware ignores it; the app uses it to show and re-edit the assignment. |
| `combo` / `text` / `seq` … | no | UI metadata matching `kind` |
| `screen` | for mouse macros | Capture resolution; absolute coordinates are rescaled from it (`x * 32767 / (width-1)`). |
| `settings.speed` | no | Playback speed multiplier (default `1.0`) |
| `settings.repeat` | no | Repeat count. **`0` = loop until the key is pressed again.** Default `1`. |
| `settings.on_repress` | no | What pressing the macro's own key does while it plays: `"stop"` (default) or `"restart"` (play again from the top). |
| `settings.hold_repeat` | no | `true` = replay while the physical key is held down, like holding a letter key. Default `false`. Ignored when `variants` exist. |
| `settings.hold_ms` | no | Key logic: press-and-hold threshold in ms (default `400`). |
| `settings.double_ms` | no | Key logic: double-press window in ms (default `250`). |
| `events` | yes | Ordered event list (the **tap** action when `variants` exist) |
| `variants` | no | Key logic (v3), see below |

## Key logic — `variants` (v3, firmware ≥ 0.3.0)

One key can do three things: tap, double press, and long press. The top-level
`events` are the **tap**; `variants.double` / `variants.hold` each carry their
own `events` (and optional `settings`):

```json
{
  "format": "mkyada-macro",
  "version": 3,
  "events": [ ...tap events... ],
  "settings": { "hold_ms": 400, "double_ms": 250 },
  "variants": {
    "double": { "kind": "combo", "combo": {...}, "events": [ ... ] },
    "hold":   { "kind": "launch", "target": "https://…", "events": [] }
  }
}
```

- The firmware resolves the gesture itself in standalone mode and announces
  the choice to a connected app as `{"t":"key_action", ...}` (see
  serial-protocol.md) so host-side variants (launch/command/sound) still work.
- A `double` variant necessarily delays the tap by up to `double_ms`; without
  one the tap fires with **zero added latency**.
- **Graceful degradation:** firmware older than 0.3.0 ignores `variants` and
  simply plays the tap.

## Multi actions — `kind: "sequence"`

A sequence chains several actions on one press. If every step is HID-expressible
(keystroke/combo/text/media/recorded), the steps are compiled **into the single
`events` list** (with `wait` events in between) — fully standalone. If a step
needs the computer (launch/command/sound), `events` stays empty, the editable
step list lives in `seq`, and the desktop app orchestrates: HID steps are
pre-compiled into sibling part files (`key3.s0.json`, `key3.s2.json`, …) it
plays over serial — still hardware HID — while host steps run on the computer.
Part files are inert on the device (the firmware only plays exact key-file names).

## Events

Every event has `delay` — milliseconds to wait **before** executing it.

```json
{ "delay": 0,   "type": "key",      "action": "down", "key": "a", "vk": 65 }
{ "delay": 30,  "type": "key",      "action": "up",   "key": "a", "vk": 65 }
{ "delay": 120, "type": "move",     "x": 960, "y": 540 }
{ "delay": 8,   "type": "button",   "action": "down", "button": "left", "x": 960, "y": 540 }
{ "delay": 60,  "type": "button",   "action": "up",   "button": "left", "x": 960, "y": 540 }
{ "delay": 10,  "type": "scroll",   "dy": -1 }
{ "delay": 15,  "type": "consumer", "usage": "volume_up" }
{ "delay": 500, "type": "wait" }
```

- `key`: `key` is a pynput-style label (`"a"`, `"ctrl_l"`, `"f5"`, `"enter"`, …); `vk` is the optional Windows virtual-key code. Resolution order: modifier tables → `vk` → name → character (see `firmware/mkyada/hidmap.py`).
- **Labels are positional (US physical keys)**, because HID keycodes are positional too — the OS renders them through the active keyboard layout. Recording the "." key on a Turkish-Q keyboard stores `"/"` (its US position) and still types "." on playback. The app *displays* labels through your real layout, so you never see the raw US name.
- `button`: `left` | `right` | `middle`. Optional `x`/`y` moves the pointer first.
- `consumer` usages: `play_pause`, `next_track`, `prev_track`, `stop`, `mute`, `volume_up`, `volume_down`, `brightness_up`, `brightness_down`.
- `wait`: pure delay, no action.

## File naming on the device

```
CIRCUITPY/
├── config.json          key count, layers, busy_other policy (see firmware/config.example.json)
└── macros/
    ├── key1.json        key 1, layer A
    ├── key1-b.json      key 1, layer B
    ├── key1-c.json      key 1, layer C
    └── key2.json ...
```

No app needed: drop a file with the right name onto the drive and press the key.

## Size guidance

The RP2040 has 264 KB of RAM; keep macros under roughly **2,000 events / 120 KB**.
The desktop app's "optimize for device" export thins dense mouse-move streams
automatically. If a file is too big the firmware blinks red and reports
`{"code": "oom"}` over serial instead of crashing.

## v1 (`asil-macro`) compatibility

v1 files have `format: "asil-macro", version: 1` and the same event fields.
Firmware and app both play them as-is; the app rewrites them as v2 on save.

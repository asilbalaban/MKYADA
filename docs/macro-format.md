# mkyada-macro JSON format (v2)

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
| `version` | yes | `2` |
| `name` | no | Display name |
| `created` | no | ISO 8601 timestamp |
| `kind` | no | UI metadata: `"combo"` \| `"keystroke"` \| `"text"` \| `"media"` \| `"recorded"`. The firmware ignores it; the app uses it to show and re-edit the assignment. |
| `combo` / `text` | no | UI metadata matching `kind` |
| `screen` | for mouse macros | Capture resolution; absolute coordinates are rescaled from it (`x * 32767 / (width-1)`). |
| `settings.speed` | no | Playback speed multiplier (default `1.0`) |
| `settings.repeat` | no | Repeat count. **`0` = loop until the key is pressed again.** Default `1`. |
| `settings.on_repress` | no | What pressing the macro's own key does while it plays: `"stop"` (default) or `"restart"` (play again from the top). |
| `settings.hold_repeat` | no | `true` = replay while the physical key is held down, like holding a letter key. Default `false`. |
| `events` | yes | Ordered event list |

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

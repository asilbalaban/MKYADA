# MKYADA Vision 6 (OLED + encoder model)

The Vision 6 is the screen model: an SH1106 128×64 OLED, an EC11 rotary
encoder with push, BACK/CONFIRM buttons, six macro keys and the on-board
RGB LED, all on a Waveshare RP2040-Zero. It runs the same firmware as the
Core 6 — `config.json "model": "vision6"` selects the variant (a blank,
config-less board auto-detects the display once at boot).

## Wiring

Bring-up-verified pinout (mirrors `hardware/oled-bringup/SCHEMATIC.md`):

| Function | Pin | Notes |
|---|---|---|
| OLED SDA | GP0 | I2C 0x3C @ 400 kHz — **3V3 only**, never 5 V |
| OLED SCL | GP1 | |
| Encoder A (TRA) | GP2 | EC11, common to GND |
| Encoder B (TRB) | GP3 | |
| Encoder push (PSH) | GP4 | active low, internal pull-up |
| BACK button | GP5 | active low |
| CONFIRM button | GP6 | active low |
| Macro key 1 | GP29 | also the **recovery key** (hold while plugging in to un-hide the USB drive) |
| Macro key 2 | GP28 | |
| Macro key 3 | GP27 | |
| Macro key 4 | GP26 | |
| Macro key 5 | GP15 | |
| Macro key 6 | GP14 | |
| RGB LED | GP16 | on-board WS2812 |

A key soldered to a different GPIO is fine — assign it in the app under
**Setup → Key wiring** (writes `config.json "pins"`).

Runtime: CircuitPython **10.2.x** (the tier the display stack is validated
on). The firmware zip / app installer ships every needed library (`lib/`)
and the OLED fonts (`fonts/`).

## Screens & controls

- **Boot** — branded "MKYADA loading" screen from the first frame; no
  CircuitPython console text.
- **Home** — turn the wheel to scroll layer letters (A…H, as many as
  `layer_count`; a single-layer setup shows just A) plus **SETTINGS**;
  press the wheel or CONFIRM to enter.
- **Grid** (the resting screen) — the active layer's six macro names, read
  from the macro files the app uploads. Turn to select a cell, CONFIRM/push
  to open that key's **speed editor**, BACK for home. Pressing a macro key
  plays it over USB HID and inverts its cell until playback ends.
  With **Layer band** / **Profile band** on (SETTINGS, or the app's
  Settings → Keypad), an inverted strip across the top names the active
  layer and/or the desktop app's active per-app profile — the macro names
  squeeze a little to make room. The profile half needs the app running;
  its label disappears the moment the app disconnects.
- **Speed editor** — 0.1×–10.0× with encoder acceleration; CONFIRM writes
  the value into the macro file itself (`settings.speed`), so the app and
  the device always agree. 2× plays in half the time, 10× in a tenth.
  If the USB drive is visible (recovery boot) the filesystem is host-owned
  and the editor explains instead of saving.
- **SETTINGS** — grid font size (Small 4×6 / Medium 5×8 / Large 6 px),
  auto-return timeout (3–60 s), language, the Layer/Profile band toggles,
  restart. Font and timeout are stored on the board (NVM); language and the
  band toggles live in `config.json` (rewritten on-device, like the app
  does) so the app always shows the same values. All survive power cycles
  and firmware updates.
- **Host mode** (a per-app profile is active) — key, encoder and button
  events stream to the app. Since fw 0.10.0 the screen shows the active
  profile's six key names as a grid (the app pushes them over serial), with
  the band on top if enabled — so you can see what the keys do, not just
  that an app owns them. Falls back to a plain "Connected to app" note on
  older apps.

## Custom wheel / button assignments

By default the wheel navigates the menu. In the app (Keys → Module
controls) any layer can instead assign macros to five virtual slots:

| Slot | File | Fires when |
|---|---|---|
| Encoder → | `macros/enc-cw[-<layer>].json` | one play per clockwise detent |
| Encoder ← | `macros/enc-ccw[-<layer>].json` | one play per counter-clockwise detent |
| BACK | `macros/btn-back[-<layer>].json` | BACK pressed on the resting grid |
| CONFIRM | `macros/btn-confirm[-<layer>].json` | CONFIRM pressed on the resting grid |
| Encoder press | `macros/btn-psh[-<layer>].json` | the wheel pushed on the resting grid (fw ≥ 0.9.0) |

Typical uses: volume up/down on the wheel, mouse scroll, zoom (Ctrl +/−),
OBS hotkeys, a soundboard clip on CONFIRM. Anything the app can assign to a
key can go on a slot; HID-compilable kinds (keystrokes, media, mouse) work
standalone, host-performed kinds (sound, launch, command, webhook) run while
the app is connected. A layer without its own slot file inherits the layer-A
one; deleting the files restores the default menu navigation.

### Per-context overrides (fw ≥ 0.9.0, issue #19)

The files above apply on the **resting grid**. Each menu context can be
overridden separately with a global (unlayered) file:

| Context | File | Where it applies |
|---|---|---|
| Layer screen | `macros/<slot>@home.json` | the layer picker |
| Settings menu | `macros/<slot>@menu.json` | settings and its sub-menus |

So "wheel scrolls the page even while the layer picker is open" is
`enc-cw@home.json` + `enc-ccw@home.json`; navigation then happens via
select mode or keys mapped to menu actions. An absent file keeps that
context's built-in behavior.

### Key logic on slots (fw ≥ 0.9.0)

The button slots (BACK / CONFIRM / encoder press) may carry the same
`variants` as keys: tap, **double press** and **long press** each doing
something different. Two extras specific to slots:

- The tap can stay **built-in** (`kind:"menu"`, `menu:"default"`) while
  only the gestures are customized — e.g. *wheel long-press = Back* with
  the push otherwise behaving stock.
- A `menu`-kind action assigned to a slot drives the **built-in**
  navigation, never other custom slots — so "hold = Back" always
  navigates, whatever else is remapped. (A menu action on a normal
  *key* emulates the control fully, custom assignments included — the
  broken-wheel scenario.)

### Escape hatch

On a customized grid the wheel push toggles a temporary **select mode**
with the default navigation everywhere (it survives into the layer picker
and settings until you land back on the grid or the idle timeout fires).
If the push itself is assigned, **holding it ~1.2 s** toggles select mode
instead — unless you deliberately gave the push its own hold action, in
which case the menus stay reachable via keys mapped to menu actions or
the app.

## Recovery

Finished-product devices ship with the CIRCUITPY drive hidden
(`usb_drive: false`); the app manages all files over serial. To force the
drive back for one session (app unavailable, broken config…): unplug, hold
**macro key 1 (GP29)**, plug in.

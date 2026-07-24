# Firmware installation (RP2040-Zero)

> **Easiest path:** the desktop app can do all of this. Plug a blank board in
> with **BOOT** held and use **Set up a new board** — the app flashes
> CircuitPython, installs the firmware and writes the config for either
> model (Core 6 or Vision 6).

## 1. Flash CircuitPython

1. Download the CircuitPython UF2 for the *Waveshare RP2040-Zero*:
   https://circuitpython.org/board/waveshare_rp2040_zero/
   — **10.2.x recommended** for new installs (required tier for the Vision 6
   display stack; Core 6 also keeps working on 9.x).
2. Hold the **BOOT** button while plugging the board in (or hold BOOT and tap
   RESET). A drive named `RPI-RP2` appears.
3. Copy the `.uf2` file onto `RPI-RP2`. The board reboots and a `CIRCUITPY`
   drive appears.

## 2. Install MKYADA firmware

Download `mkyada-firmware-<version>.zip` from the
[latest release](https://github.com/asilbalaban/MKYADA/releases/latest) and copy
its contents to the root of `CIRCUITPY`:

```
CIRCUITPY/
├── boot.py
├── code.py
├── VERSION
├── config.json          # copy config.example.json and adjust
├── mkyada/              # firmware modules (precompiled .mpy in release zips)
├── lib/                 # neopixel + display libs (in the zip, .mpy)
├── fonts/               # OLED grid fonts (Vision 6; harmless on Core 6)
└── macros/              # your macro JSON files
```

Release zips ship the modules **precompiled to `.mpy`** — the RP2040 then
imports them with a fraction of the RAM an on-device compile needs (compiling
the big modules from source can `MemoryError` on the Vision 6). If you are
installing from the repo instead of a release zip, build the same tree with
`node scripts/build-firmware-dist.mjs` and copy `firmware-dist/` over — or
copy the plain `.py` sources, which work but are less robust. When replacing
`.py` files with `.mpy` (or the other way around) delete the old twin — two
copies of the same module confuse the import path.

**Unplug and replug the board** after the first copy — `boot.py` (USB device
setup) only runs at power-on.

## 3. Configure

Edit `config.json` (see `config.example.json`):

| Field | Meaning |
|---|---|
| `model` | `"core6"` (screenless, default) or `"vision6"` (OLED + encoder). A config-less board auto-detects the OLED once at boot |
| `key_count` | How many keys you soldered (1–6, GP0…GP5) |
| `pins` | Explicit per-key GPIO names when a key is soldered off the default order, e.g. `["GP29","GP28","GP27","GP26","GP15","GP13"]`. `null` = model default. Easiest set via the app: **Setup → Key wiring** |
| `layer_key` | Key number that switches layers, or `null`. Always `null` on Vision 6 (layers are picked with the wheel) |
| `layer_count` | Number of layers — Core 6: 2–8 when `layer_key` is set; Vision 6: 1–8 |
| `layer_mode` | `"toggle"` (press cycles A→B→…) or `"hold"` (hold = layer B) |
| `key_map` | Fixes a mismatched solder order: logical key number per GPIO, e.g. `[3, 1, 2]` = GP0 acts as key 3. `null` = GP0 is key 1. Easiest set via the app: **Setup → Key order (remap)** |
| `screen` | Default target resolution for mouse macros |

Then drop macro files into `macros/` (`key1.json`, `key1-b.json`, …) — see
[macro-format.md](macro-format.md) — or let the desktop app do all of this.

## 4. LED states

| Color | Meaning |
|---|---|
| Green / blue / purple (dim) | Idle, layer A / B / C |
| Amber solid | Macro playing |
| Amber blinking | Looping macro (press the key again to stop) |
| Breathing tint | Host mode (desktop app connected) |
| Red triple-blink | Config or macro file error |

## Wiring

Core 6: six switches between **GP0…GP5** and **GND** (common ground). Internal
pull-ups are used; no resistors needed. See
[hardware/wiring.md](../hardware/wiring.md).

Vision 6 (OLED + encoder): see [vision6.md](vision6.md).

## If something goes wrong (recovery)

The firmware is layered so that no software failure leaves a dead keypad —
important for sealed/soldered builds where the BOOT button is unreachable:

1. **A hung firmware** trips the hardware **watchdog** (8 s) and the board
   hard-resets itself clean (`config.json "watchdog": false` disables it for
   bench debugging).
2. **A crashed firmware** (broken file after an interrupted update, missing
   library) drops into the **rescue console**: the LED blinks red, the board
   still answers `identify` over serial (`mode:"rescue"`), and the desktop
   app shows a one-click **Repair firmware** that rewrites every firmware
   file and reboots. Macros and config are untouched.
3. **Hidden drive, no app?** Hold **key 1** while plugging in — the CIRCUITPY
   drive comes back for that session and you can copy files by hand (**GP0**
   on Core 6, **GP29** — macro key 1 — on Vision 6).
4. **Reflashing CircuitPython itself** no longer needs the BOOT button: the
   app (or any serial terminal) can send `{"t":"bootloader"}` and the board
   reboots as the `RPI-RP2` UF2 drive.

During app-driven updates the keypad locks itself (keys and menus off, a
progress bar on the Vision 6 screen), every file is CRC-verified after
landing, and `VERSION` is written last — an interrupted update simply shows
the update banner again and can be re-run.

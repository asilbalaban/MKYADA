# Firmware installation (RP2040-Zero)

## 1. Flash CircuitPython

1. Download CircuitPython **9.x** UF2 for the *Waveshare RP2040-Zero*:
   https://circuitpython.org/board/waveshare_rp2040_zero/
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
├── mkyada/              # firmware modules
├── lib/                 # adafruit_hid, neopixel (bundled in the release zip)
└── macros/              # your macro JSON files
```

If you are installing from the repo instead of a release zip, also copy
`adafruit_hid` and `neopixel.mpy` from the
[Adafruit CircuitPython bundle](https://circuitpython.org/libraries) into
`CIRCUITPY/lib/`.

**Unplug and replug the board** after the first copy — `boot.py` (USB device
setup) only runs at power-on.

## 3. Configure

Edit `config.json` (see `config.example.json`):

| Field | Meaning |
|---|---|
| `key_count` | How many keys you soldered (1–6, GP0…GP5) |
| `layer_key` | Key number that switches layers, or `null` |
| `layer_count` | Number of layers (2+) when `layer_key` is set |
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

Six switches between **GP0…GP5** and **GND** (common ground). Internal pull-ups
are used; no resistors needed. See [hardware/wiring.md](../hardware/wiring.md).

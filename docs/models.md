# Two models: Core 6 and Vision 6

MKYADA ships in two hardware variants that run the **same firmware** and the
**same desktop app**. `config.json "model"` selects the variant; a blank board
auto-detects at first boot (a Vision 6 finds its OLED, everything else is a
Core 6).

| | ![Core 6](images/devices/core6.png) **Core 6** | ![Vision 6](images/devices/vision6.png) **Vision 6** |
|---|---|---|
| Display | On-board RGB LED (status) | **SH1106 128×64 OLED** + RGB LED |
| Input | 6 macro keys | 6 macro keys + **EC11 rotary encoder** (push) + **BACK/CONFIRM** buttons |
| Layer switching | A dedicated **layer key** cycles layers | Turn the wheel on the **Home** screen — no key spent |
| On-device feedback | LED colour / blink | Live macro names, layer & profile bands, speed editor, settings menu |
| Board | Waveshare RP2040-Zero | Waveshare RP2040-Zero |
| Standalone | Yes — macros play over USB HID with no app | Yes — plus you can *see* and tune everything on the screen |

Everything else is identical: recorded macros, per-app profiles, the full set of
[key actions](actions.md), finished-product mode, one-click firmware updates.

## What differs in the app

The desktop app adapts to whichever model is connected:

- **Keys** — the Vision 6 adds a **Module controls** grid (encoder →/←, BACK,
  CONFIRM, wheel-push) that you assign just like keys, plus a per-layer
  on-screen name. The Core 6 shows the six keys and its layer key.
- **Setup** — the Vision 6 wires the encoder and nav buttons and tests them;
  the Core 6 picks a layer key.
- **Settings → Keypad** — the Vision 6 exposes screen options (layer band,
  profile band, auto-return timeout, wheel acceleration); the Core 6
  shows only the drive-hide (finished-product) toggle.

| Core 6 · Keys | Vision 6 · Keys |
|---|---|
| ![Core 6 Keys](images/screens/core6-keys.png) | ![Vision 6 Keys](images/screens/vision6-keys.png) |

The assignable **"Go to layer X"** action and layer next/prev work on **both**
models — a Core 6 key can jump straight to a layer too.

See [vision6.md](vision6.md) for the Vision 6 wiring, on-device screens and
recovery details.

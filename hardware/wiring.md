# Wiring & soldering guide

## Parts

- 1 × Waveshare **RP2040-Zero**
- Up to 6 × mechanical switches (Cherry MX or compatible)
- Wire, solder, USB-C cable
- 3D-printed case — files in [case/](case/) *(coming soon)*

## Wiring

Each switch has two legs: one goes to a GPIO, the other to **GND**. All switches
share the same ground — daisy-chain one leg of every switch to a single GND pad.

```
 Key 1 ──── GP0 ┐
 Key 2 ──── GP1 │
 Key 3 ──── GP2 │        RP2040-Zero
 Key 4 ──── GP3 │
 Key 5 ──── GP4 │
 Key 6 ──── GP5 ┘
 All keys ─ GND (common)
```

- Key numbering follows the GPIO order: **GP0 = key 1 … GP5 = key 6.**
- No pull-up resistors or diodes needed — the firmware enables internal
  pull-ups (a pressed key reads LOW).
- Soldering fewer keys is fine: solder GP0…GP(n-1) and set `key_count` in
  `config.json`.
- The onboard WS2812 RGB LED (GP16) is used as the status light; nothing to
  wire.

## Verifying your solder joints

Fastest check: the desktop app's onboarding wizard has a **live key test** —
every physical press lights up on screen. Without the app: flash the firmware,
copy the demo `macros/key1.json`, open a text editor, press key 1 — it should
type `mkyada`.

*(Photos of the reference build coming soon.)*

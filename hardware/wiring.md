# Wiring & soldering guide

How to solder a MKYADA keypad: **every switch shares one common GND**, and the
switches connect to **GP0, GP1, GP2… in key order**. That's the whole circuit —
no diodes, no resistors, no matrix. The reference build is 6 keys, but the
firmware supports **any count up to 20** — one key per castellated GPIO on the
board's edge.

> This walkthrough is for the **Core 6** (screenless). Building the **Vision 6**
> (OLED + encoder)? The screen and wheel take GP0–GP6, so the macro keys move to
> the left edge — jump to [Vision 6 (screen model)](#vision-6-screen-model) below.

## Parts

- 1 × Waveshare **RP2040-Zero** (USB-C)
- 1–20 × mechanical switches (Cherry MX or compatible) — 6 is the reference build
- Thin stranded wire (~24–28 AWG), solder, flux
- USB-C **data** cable (some charge-only cables won't enumerate)
- 3D-printed case — STLs and print notes in [case/](case/) (a Stream Cheap
  remix; credits in [case/README.md](case/README.md))

## Know your board

<p align="center">
  <img src="../docs/raspberry-2040-zero.jpg" alt="Waveshare RP2040-Zero pinout — GP0–GP8 down the right edge, GND on the upper left" width="420">
</p>

Hold the board **USB-C connector up, component side facing you**:

```
              ┌───[ USB-C ]───┐
        5V ──│●              ●│── GP0   ← Key 1
       GND ──│●              ●│── GP1   ← Key 2   ★ common ground
       3V3 ──│●              ●│── GP2   ← Key 3
      GP29 ──│●              ●│── GP3   ← Key 4
      GP28 ──│●   RP2040-    ●│── GP4   ← Key 5
      GP27 ──│●     Zero     ●│── GP5   ← Key 6
      GP26 ──│●              ●│── GP6
      GP15 ──│●              ●│── GP7
             │●● ● ● ● ● ● ●●│
              GP14 … GP9   GP8
```

- Key pins follow the board's perimeter: **GP0…GP8 down the right edge**,
  GP9…GP14 along the bottom, then GP15 and GP26…GP29 up the left — 20 usable
  key pins in total. A 6-key build uses just the top six on the right
  (GP0…GP5).
- **GND is the second pad from the top on the left edge** (between 5V and 3V3).
- The onboard WS2812 RGB LED (GP16) is the status light — nothing to wire.
- BOOT/RESET buttons are on the face; you'll use BOOT once when flashing
  CircuitPython ([docs/firmware-install.md](../docs/firmware-install.md)).

## Wiring plan

Each switch has two legs. Which leg goes where doesn't matter — a switch is
just a contact:

```
 Key 1 ──── GP0 ┐
 Key 2 ──── GP1 │
 Key 3 ──── GP2 │        RP2040-Zero
 Key 4 ──── GP3 │
 Key 5 ──── GP4 │
 Key 6 ──── GP5 ┘
 All keys ─ GND (one shared wire)
```

- Key numbering follows the GPIO order: **GP0 = key 1, GP1 = key 2, …**
  Decide now which physical position is "key 1" (top-left is the convention).
- No pull-ups or diodes: the firmware enables internal pull-ups, so a pressed
  key simply shorts its GPIO to GND.
- Any key count from 1 to 20 works: solder GP0…GP(n-1) — keys 7+ continue past
  GP5 onto GP6, GP7, GP8 and around the board — then set the count in the
  setup wizard. (GP16 is skipped: it drives the onboard LED.)

## Soldering, step by step

1. **Plan the layout.** Seat the switches in the case/plate first and decide
   the key order. Cut wires to length with a little slack.
2. **Daisy-chain the ground.** Take one leg of every switch and connect them
   all in a chain with a single wire (strip small gaps in one wire, or bridge
   leg-to-leg). Run the end of the chain to the board's **GND** pad
   (left edge, 2nd from top).
3. **Wire the signals.** The remaining leg of each switch gets its own wire to
   its GPIO: key 1 → GP0, key 2 → GP1, … key 6 → GP5. Tin the pad and the wire
   first; the pads are small, so a fine tip and flux help.
4. **Check for bridges.** The right-edge pads sit close together — inspect
   GP0…GP5 for solder bridges between neighbours. A multimeter in continuity
   mode: every switch should beep between its GPIO and GND **only while
   pressed**, and never beep between two GPIOs.
5. **Strain relief.** A dab of hot glue over the pads saves the joints when a
   wire gets tugged.

## Verify — no multimeter needed

Flash the firmware ([docs/firmware-install.md](../docs/firmware-install.md)),
open the MKYADA app and go to **Setup**: the **live key test** lights up every
key as you press it. If a key doesn't react, reflow its GPIO joint and the
ground chain.

**Soldered the keys in the wrong order?** Don't reach for the iron — the app
fixes it in software: **Setup → Key order (remap)**, press the keys in the
order they *should* be numbered, done. The remap is stored on the keypad, so
standalone mode uses it too.

---

## Vision 6 (screen model)

The Vision 6 adds an **SH1106 128×64 OLED** and an **EC11 rotary encoder** with
**BACK/CONFIRM** buttons. Same board, same "everything shares one GND, internal
pull-ups, no diodes/resistors" rule as the Core 6 — but the screen and wheel
occupy **GP0–GP6**, so the six macro keys move to **GP29, GP28, GP27, GP26,
GP15, GP14** (down the left edge, then the bottom-left).

> ⚠️ The OLED is **3.3 V only** — wire its VCC to **3V3**, never 5V.

```
              ┌───[ USB-C ]───┐
        5V ──│●              ●│── GP0   ← OLED SDA
       GND ──│●              ●│── GP1   ← OLED SCL     ★ common ground
       3V3 ──│●              ●│── GP2   ← Encoder A (TRA)
      GP29 ──│●              ●│── GP3   ← Encoder B (TRB)
   Key 1    │●   RP2040-    ●│── GP4   ← Encoder push (PSH)
      GP28 ──│●     Zero     ●│── GP5   ← BACK
   Key 2    │●              ●│── GP6   ← CONFIRM
      GP27 ──│●              ●│── GP7
   Key 3    │●● ● ● ● ● ● ●●│
              GP14 … GP9   GP8
      (GP16 = onboard RGB LED)
```

| RP2040-Zero pin | Connects to | Notes |
|---|---|---|
| **GP0** | OLED **SDA** | I²C 0x3C @ 400 kHz |
| **GP1** | OLED **SCL** | |
| OLED **VCC** | **3V3** | ⚠️ 3.3 V only, never 5V |
| OLED **GND** | **GND** | shared ground |
| **GP2** | Encoder **A** (TRA) | |
| **GP3** | Encoder **B** (TRB) | encoder common leg → GND |
| **GP4** | Encoder **push** (PSH) | switch → GND |
| **GP5** | **BACK** button | switch → GND |
| **GP6** | **CONFIRM** button | switch → GND |
| **GP29** | Macro **key 1** | also the **recovery key** — hold while plugging in to un-hide the USB drive |
| **GP28** | Macro **key 2** | |
| **GP27** | Macro **key 3** | |
| **GP26** | Macro **key 4** | |
| **GP15** | Macro **key 5** | |
| **GP14** | Macro **key 6** | |
| GP16 | onboard WS2812 RGB LED | nothing to wire |

Everything with a `→ GND` leg (the six keys, the encoder push, BACK, CONFIRM
and the encoder's common pin) joins the **same daisy-chained ground** as on the
Core 6. Solder order: ground chain first, then the OLED (VCC→3V3, SDA→GP0,
SCL→GP1), then the encoder/buttons, then the six keys. A key soldered to a
different GPIO is fine — remap it in **Setup → Key wiring**.

Full pinout, the on-device screens, and the bring-up reference:
[docs/vision6.md](../docs/vision6.md) ·
[oled-bringup/SCHEMATIC.md](oled-bringup/SCHEMATIC.md).

---

## Türkçe özet

Devre çok basit: **her tuşun bir bacağı ortak GND'ye** (tek zincir hâlinde),
**diğer bacağı sırasıyla GP0, GP1, GP2…'ye** lehimlenir. 6 tuş referans tasarım;
firmware kartın kenarındaki 20 GPIO'ya kadar her sayıyı destekler (GP16 hariç —
o LED'in). GND pad'i USB üstteyken sol
kenarda üstten ikinci; GP0–GP5 sağ kenarda üstten ilk altı pad. Direnç/diyot
gerekmez (firmware dahili pull-up kullanır). Lehim sonrası uygulamadaki
**Setup → canlı tuş testi** ile her tuşu doğrula; tuşları yanlış sırayla
lehimlediysen **Setup → Key order (remap)** ile yazılımdan düzelt — yeniden
lehim gerekmez.

**Ekranlı model (Vision 6):** OLED (SH1106) + EC11 encoder + BACK/CONFIRM
eklenir; ekran ve tekerlek **GP0–GP6**'yı kullandığından altı makro tuşu
**GP29, GP28, GP27, GP26, GP15, GP14**'e kayar. ⚠️ OLED **yalnızca 3.3V** — VCC'yi
`3V3`'e bağla, `5V`'a asla. Ortak GND, dahili pull-up, diyot/direnç yok kuralı
aynı. Ayrıntılı pinout ve şema: yukarıdaki
[Vision 6 (screen model)](#vision-6-screen-model) bölümü ·
[docs/vision6.md](../docs/vision6.md) ·
[oled-bringup/SCHEMATIC.md](oled-bringup/SCHEMATIC.md).

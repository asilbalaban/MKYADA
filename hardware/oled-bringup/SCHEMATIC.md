# MKYADA ekranlı model — bağlantı şeması

SH1106 OLED + EC11 encoder + 6 makro tuş, Waveshare RP2040-Zero üzerinde.
Tüm eşleşmeler [device/demo_h.py](device/demo_h.py) ile birebirdir.

> ⚠️ OLED modülü **SADECE 3.3V**. `3V3` pinini kullan, `5V`'a bağlama.
> Butonların/tuşların diğer bacağı **ortak GND**'ye gider — dahili pull-up var,
> harici direnç/diyot yok.

## Kartı tanı (USB-C üstte, komponent yüzü sana dönük)

```
              ┌───[ USB-C ]───┐
        5V ──│●              ●│── GP0   ← OLED SDA
       GND ──│●              ●│── GP1   ← OLED SCL      ★ ortak toprak
       3V3 ──│●              ●│── GP2   ← Encoder A (TRA)
      GP29 ──│●              ●│── GP3   ← Encoder B (TRB)
   Makro 1  │●   RP2040-    ●│── GP4   ← Encoder PSH
      GP28 ──│●     Zero     ●│── GP5   ← BACK
   Makro 2  │●              ●│── GP6   ← CONFIRM
      GP27 ──│●              ●│── GP7
   Makro 3  │●● ● ● ● ● ● ●●│
              GP14 … GP9   GP8
      (GP16 = onboard RGB LED)
```

## Bağlantı diyagramı

```
  SH1106 OLED (I2C 0x3C @ 400kHz)          RP2040-Zero
  ┌─────────────┐
  │ VCC ────────┼──────────────────────────► 3V3   (⚠ 3.3V)
  │ GND ────────┼──────────────────────────► GND ──┐
  │ SDA ────────┼──────────────────────────► GP0   │
  │ SCL ────────┼──────────────────────────► GP1   │
  └─────────────┘                                   │
                                                    │
  EC11 encoder                                      │  ortak GND
  ┌─────────────┐                                   │
  │ TRA ────────┼──────────────────────────► GP2    │
  │ TRB ────────┼──────────────────────────► GP3    │
  │ PSH ───[sw]─┼───────────────────────────┼───────┤
  │             └───────────────────────────► GP4    │
  │ BACK ──[sw]─┼───────────────────────────┼───────┤
  │             └───────────────────────────► GP5    │
  │ CONF ──[sw]─┼───────────────────────────┼───────┤
  │             └───────────────────────────► GP6    │
  └─────────────┘                                   │
                                                    │
  Makro tuşları (grid gözesi = pin sırası)          │
  ┌─────────────┐                                   │
  │ Tuş 1 ─[sw]─┼───────────────────────────┼───────┤
  │             └───────────────────────────► GP29   │
  │ Tuş 2 ─[sw]─┼───────────────────────────┼───────┤
  │             └───────────────────────────► GP28   │
  │ Tuş 3 ─[sw]─┼───────────────────────────┼───────┤
  │             └───────────────────────────► GP27   │
  │ Tuş 4 ─[sw]─┼───────────────────────────┼───────┤
  │             └───────────────────────────► GP26   │
  │ Tuş 5 ─[sw]─┼───────────────────────────┼───────┤
  │             └───────────────────────────► GP15   │
  │ Tuş 6 ─[sw]─┼───────────────────────────┼───────┤
  │             └───────────────────────────► GP14   │
  └─────────────┘                                   │
                                                    │
  RGB LED: onboard WS2812 (board.NEOPIXEL / GP16) ──┘  kablo gerekmez
```

## Özet tablo

| RP2040-Zero | İşlev | Bağlanan | Kod |
|-------------|-------|----------|-----|
| GP0  | I2C SDA | OLED SDA | `sda=board.GP0` |
| GP1  | I2C SCL | OLED SCL | `scl=board.GP1` |
| GP2  | Encoder A | EC11 TRA | `IncrementalEncoder(GP2, GP3)` |
| GP3  | Encoder B | EC11 TRB | `IncrementalEncoder(GP2, GP3)` |
| GP4  | Encoder push | EC11 PSH → GND | `K_PSH = 0` |
| GP5  | BACK | Buton → GND | `K_BACK = 1` |
| GP6  | CONFIRM | Buton → GND | `K_CONFIRM = 2` |
| GP29 | Makro tuş 1 | Buton → GND | `MACRO_PINS[0]` |
| GP28 | Makro tuş 2 | Buton → GND | `MACRO_PINS[1]` |
| GP27 | Makro tuş 3 | Buton → GND | `MACRO_PINS[2]` |
| GP26 | Makro tuş 4 | Buton → GND | `MACRO_PINS[3]` |
| GP15 | Makro tuş 5 | Buton → GND | `MACRO_PINS[4]` |
| GP14 | Makro tuş 6 | Buton → GND | `MACRO_PINS[5]` |
| GP16 | RGB LED | Onboard WS2812 | `board.NEOPIXEL` |

`[sw]` = anahtar teması; basılınca GP pinini GND'ye kısa devre yapar.

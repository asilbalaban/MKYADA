# OLED + Encoder bring-up (RP2040-Zero)

MKYADA'ya menü arayüzü modülü (SH1106 OLED + EC11 encoder + 2 buton) eklemeden önce
donanımı breadboard'da doğrulamak için test araçları.

## Donanım

- **Kart:** Waveshare RP2040-Zero, CircuitPython 10.2.x
- **Modül:** SH1106 1.3" OLED (128x64, I2C 0x3C), EC11 encoder, BACK/CONFIRM butonlar
- **Güç:** modül SADECE 3.3V. RP2040'ın `3V3` pini kullanılır, `5V` **kullanılmaz**.

### Bağlantı (I2C)

| Modül | RP2040-Zero |
|-------|-------------|
| VCC   | 3V3         |
| GND   | GND         |
| SDA   | GP0         |
| SCL   | GP1         |

## Kullanım

Kart normal modda (CIRCUITPY diski görünür) takılıyken host'tan:

```bash
python3 hardware/oled-bringup/bringup.py diag     # canli hat teshisi (SDA/SCL OK mu)
python3 hardware/oled-bringup/bringup.py scan     # I2C tarama -> 0x3c bekleniyor
python3 hardware/oled-bringup/bringup.py oled     # ekrana MKYADA + cerceve
python3 hardware/oled-bringup/bringup.py inputs   # encoder + buton + nvm testi
python3 hardware/oled-bringup/bringup.py demo     # tam OLED menu demosu
python3 hardware/oled-bringup/bringup.py monitor  # sadece seri ciktiyi izle
```

### Aşama 4 kablolama (encoder + butonlar)

| Modül | İşlev | RP2040-Zero |
|-------|-------|-------------|
| TRA   | Encoder faz A | GP2 |
| TRB   | Encoder faz B | GP3 |
| PSH   | Encoder butonu | GP4 |
| BAK   | BACK | GP5 |
| CON   | CONFIRM | GP6 |

Encoder/PSH iç pull-up ile okunur; BACK/CONFIRM modülde 4.7K pull-up'lı (kodda iç
pull-up da açık, paralel — sorun değil). Ayarlar `microcontroller.nvm`'e yazılır,
karta güç gitmese de kalır.

Runner seçtiğin testi `device/*.py` içinden `CIRCUITPY/code.py`'ye kopyalar ve seri
çıktıyı canlı akıtır. Çıkmak için `Ctrl-C`. Ekstra pip paketi gerektirmez (stdlib).

## Kart tarafı kütüphaneler (`oled` testi için)

`CIRCUITPY/lib/` içine (Adafruit CircuitPython Bundle 10.x'ten):

- `adafruit_displayio_sh1106.mpy`
- `adafruit_display_text/`

(`i2cdisplaybus`, `displayio`, `terminalio` CircuitPython 10 çekirdeğinde, ayrı dosya gerekmez.)

`demoh` (yatay demo) grid yazıları için ek olarak küçük (dar) bir bitmap font kullanır:

- `CIRCUITPY/lib/adafruit_bitmap_font/` → repo'daki `lib/adafruit_bitmap_font/` (tüm `.py`'ler; `lvfontbin.py` dahil şart)
- `CIRCUITPY/fonts/spleen-5x8.bdf` → repo'daki `fonts/spleen-5x8.bdf`

Font/lib yoksa demo hata vermez, terminalio (6px) fontuna düşer. `fonts/4x6.bdf` daha da dar bir alternatiftir.

## Sık karşılaşılan hata

`RuntimeError: No pull up found on SDA or SCL` → I2C hattı fiziksel sorun. Önce `diag`
çalıştır: SDA ve SCL ikisi de sabit `OK` olmalı. Bir tanesi `YOK` ya da titriyorsa o
telin teması kötü (jumper'ı değiştir / pad'e tam otur / lehimi kontrol et).

## Aşamalar

1. ✅ CircuitPython kurulumu
2. ✅ I2C tarama (0x3c)
3. ✅ OLED'e görüntü (colstart=2)
4. ✅ Encoder + buton + NVM menü demosu (`demo`)

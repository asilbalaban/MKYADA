# MKYADA OLED bring-up - karta gidecek test: I2C tarama
# Modul: SDA -> GP0, SCL -> GP1, VCC -> 3V3, GND -> GND
# Beklenen: taramada 0x3c gorunmeli (SH1106 OLED)

import time
import board
import busio

i2c = busio.I2C(scl=board.GP1, sda=board.GP0)
while not i2c.try_lock():
    pass

print("=== MKYADA I2C tarama ===")
try:
    while True:
        adresler = i2c.scan()
        print("I2C adresleri:", [hex(a) for a in adresler])
        if 0x3C in adresler:
            print(">>> OK: 0x3c bulundu, OLED goruluyor.")
        elif not adresler:
            print(">>> UYARI: cihaz yok. Kablo/guc kontrol et.")
        else:
            print(">>> DIKKAT: 0x3c yok. Adres 0x3d olabilir mi?")
        time.sleep(1)
finally:
    i2c.unlock()

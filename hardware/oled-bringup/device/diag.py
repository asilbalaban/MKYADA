# MKYADA OLED bring-up - karta gidecek test: CANLI hat teshisi
# busio KULLANMAZ (patlamaz, LED yanip sonmez). GP0/GP1 hatlarinin
# elektriksel durumunu 0.3sn'de bir okur. Kablo oynatirken izle.

import time
import board
import digitalio

def harici_pullup(pin):
    # Disaridaki (modul) pull-up gorunuyor mu? (ic pull-up KAPALI)
    d = digitalio.DigitalInOut(pin)
    d.direction = digitalio.Direction.INPUT
    d.pull = None
    v = d.value
    d.deinit()
    return v

print("=== CANLI I2C hat teshisi (kabloyu oynat) ===")
onceki = None
while True:
    sda = harici_pullup(board.GP0)
    scl = harici_pullup(board.GP1)
    durum = (sda, scl)
    if durum != onceki:
        print("SDA:", "OK " if sda else "YOK", "| SCL:", "OK " if scl else "YOK",
              "  <-- ikisi de OK olmali")
        onceki = durum
    time.sleep(0.3)

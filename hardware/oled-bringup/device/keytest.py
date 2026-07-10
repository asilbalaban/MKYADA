# MKYADA bring-up - 6 makro tusu testi
# Basilan tusu OLED'de buyuk gosterir (K1..K6) ve seri porta yazar.
# Tus pinleri (dedektorle bulundu, 3V3 altinda sirali):
#   K1=GP29 K2=GP28 K3=GP27 K4=GP26 K5=GP15 K6=GP14
# Her tus: bir bacak GPIO'ya, diger bacak ortak GND'ye; ic pull-up ile okunur.

import time
import board
import busio
import displayio
import i2cdisplaybus
import terminalio
from adafruit_display_text import label
import adafruit_displayio_sh1106

# OLED (dikey)
displayio.release_displays()
i2c = busio.I2C(scl=board.GP1, sda=board.GP0, frequency=400000)
bus = i2cdisplaybus.I2CDisplayBus(i2c, device_address=0x3C)
disp = adafruit_displayio_sh1106.SH1106(bus, width=128, height=64, colstart=2)
disp.rotation = 90
W = disp.width
H = disp.height
CX = W // 2

import keypad
KEY_PINS = (board.GP29, board.GP28, board.GP27, board.GP26, board.GP15, board.GP14)
keys = keypad.Keys(KEY_PINS, value_when_pressed=False, pull=True)


def show(big, small=""):
    g = displayio.Group()
    t = label.Label(terminalio.FONT, text=big, scale=3, color=0xFFFFFF)
    t.anchor_point = (0.5, 0.5)
    t.anchored_position = (CX, H // 2 - 8)
    g.append(t)
    if small:
        s = label.Label(terminalio.FONT, text=small, scale=1, color=0xFFFFFF)
        s.anchor_point = (0.5, 0.5)
        s.anchored_position = (CX, H // 2 + 20)
        g.append(s)
    disp.root_group = g


show("--", "bir tusa bas")
print("=== 6 tus testi: bir tusa bas ===")
while True:
    ev = keys.events.get()
    if ev:
        n = ev.key_number + 1
        if ev.pressed:
            show("K%d" % n, "basildi")
            print("K%d BASILDI" % n)
        else:
            show("K%d" % n, "birakildi")
    time.sleep(0.005)

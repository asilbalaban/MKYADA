# MKYADA bring-up - tus pini DEDEKTORU
# Hangi GPIO'ya bagli oldugunu bilmiyoruz: bos pinlerin hepsini tarar,
# basilan tusun pinini (GPxx) OLED'de ve seri portta gosterir.
# (Tuslar ortak GND'ye bagli varsayilir; ic pull-up ile okunur.)

import time
import board
import busio
import displayio
import i2cdisplaybus
import terminalio
import keypad
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

# Bos aday pinler (modul GP0-6 ve LED GP16 haric)
CAND = [7, 8, 9, 10, 11, 12, 13, 14, 15, 26, 27, 28, 29]
pins = tuple(getattr(board, "GP%d" % n) for n in CAND)
NAMES = ["GP%d" % n for n in CAND]
keys = keypad.Keys(pins, value_when_pressed=False, pull=True)


def show(big, small=""):
    g = displayio.Group()
    t = label.Label(terminalio.FONT, text=big, scale=2, color=0xFFFFFF)
    t.anchor_point = (0.5, 0.5)
    t.anchored_position = (CX, H // 2 - 8)
    g.append(t)
    if small:
        s = label.Label(terminalio.FONT, text=small, scale=1, color=0xFFFFFF)
        s.anchor_point = (0.5, 0.5)
        s.anchored_position = (CX, H // 2 + 16)
        g.append(s)
    disp.root_group = g


show("bas", "tus pini bul")
print("=== tus dedektoru: her tusa sirayla bas ===")
while True:
    ev = keys.events.get()
    if ev:
        name = NAMES[ev.key_number]
        if ev.pressed:
            show(name, "basildi")
            print("BASILDI:", name)
        else:
            print("birakildi:", name)
    time.sleep(0.005)

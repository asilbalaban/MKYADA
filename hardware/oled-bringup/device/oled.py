# MKYADA OLED bring-up - karta gidecek test: ekrana metin + cerceve
# SH1106 128x64, I2C 0x3c, SDA=GP0, SCL=GP1
# Gereken lib: adafruit_displayio_sh1106.mpy + adafruit_display_text/
# (i2cdisplaybus / displayio / terminalio CircuitPython 10 cekirdeginde)

import time
import board
import busio
import displayio
import i2cdisplaybus
import terminalio
from adafruit_display_text import label
import adafruit_displayio_sh1106

WIDTH = 128
HEIGHT = 64

displayio.release_displays()

i2c = busio.I2C(scl=board.GP1, sda=board.GP0)
display_bus = i2cdisplaybus.I2CDisplayBus(i2c, device_address=0x3C)
# colstart=2: SH1106 132 kolonluk RAM'inde 128'lik paneli ortala
# (yoksa en sag 2 kolon yanmaz)
display = adafruit_displayio_sh1106.SH1106(
    display_bus, width=WIDTH, height=HEIGHT, colstart=2
)

splash = displayio.Group()
display.root_group = splash

# Cerceve (2 px beyaz kenarlik)
palette = displayio.Palette(2)
palette[0] = 0x000000
palette[1] = 0xFFFFFF
frame = displayio.Bitmap(WIDTH, HEIGHT, 2)
for x in range(WIDTH):
    for t in range(2):
        frame[x, t] = 1
        frame[x, HEIGHT - 1 - t] = 1
for y in range(HEIGHT):
    for t in range(2):
        frame[t, y] = 1
        frame[WIDTH - 1 - t, y] = 1
splash.append(displayio.TileGrid(frame, pixel_shader=palette))

# Buyuk baslik + alt satir
baslik = label.Label(terminalio.FONT, text="MKYADA", color=0xFFFFFF, scale=2)
baslik.anchor_point = (0.5, 0.5)
baslik.anchored_position = (WIDTH // 2, HEIGHT // 2 - 6)
splash.append(baslik)

alt = label.Label(terminalio.FONT, text="OLED bring-up OK", color=0xFFFFFF)
alt.anchor_point = (0.5, 0.5)
alt.anchored_position = (WIDTH // 2, HEIGHT // 2 + 16)
splash.append(alt)

print("=== OLED cizildi: MKYADA + cerceve. Ekrana bak. ===")
while True:
    time.sleep(1)

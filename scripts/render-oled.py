#!/usr/bin/env python3
"""Render the OLED screens the docs publish, using the firmware's own code.

Until now those pictures were a hand-written canvas mockup (Courier text at
guessed coordinates). That was defensible while the device drew with a BDF font
nobody could load in a browser; it stopped being defensible the day the firmware
got its own 5x8 proportional font, because from then on the published pictures
were of a keypad that does not exist — wrong glyphs, wrong widths, no Turkish.

This runs firmware/mkyada/oled.py against firmware/fonts/mkyada.fnt through the
software displayio in tests/, so every pixel here is a pixel the SH1106 gets.
Output is app/screenshots/oled-frames.js, which oled.html paints 1:1 inside its
bezel and the screenshot harness photographs.

The keypad shown is the same fictional one the app screenshots use
(app/screenshots/fixtures.ts) — one product, one story.

Run: python3 scripts/render-oled.py
"""
import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "tests"))
sys.path.insert(0, os.path.join(REPO, "firmware"))

import fakedisplayio  # noqa: E402

fakedisplayio.install()

from mkyada import i18n, oled as oledmod  # noqa: E402

OUT = os.path.join(REPO, "app", "screenshots", "oled-frames.js")


class FakeDisplay:
    width, height = 128, 64
    auto_refresh = False

    def __init__(self):
        self.root_group = None

    def refresh(self):
        pass


def make_oled():
    o = oledmod.Oled.__new__(oledmod.Oled)
    o.display = FakeDisplay()
    o._bar = None
    o._last = None
    o._cells = None
    o._menu = None
    o._val = None
    o._band_txt = None
    o.W, o.H, o.CX = 128, 64, 64
    o.font = oledmod.Font(os.path.join(REPO, "firmware", "fonts", "mkyada.fnt"))
    o.fb = oledmod.Fb(128, 64, o.font)
    o.display.root_group = o.fb.group
    return o


# The Vision 6 half of app/screenshots/fixtures.ts, layer A ("Stream").
GRID = [("Go Live", ""), ("Record", ""), ("Push-to", "talk"),
        ("Discord", ""), ("Mute", ""), ("Post the", "clip")]

SCREENS = [
    # ui.py always hands show_home/show_speed a LAYER LETTER, never the layer's
    # nickname — the nickname only appears in the grid's band. Passing "Stream"
    # here published a screen the device cannot draw.
    ("home", "Home — the layer carousel",
     lambda d: d.show_home(0, 4, ["A", "B", "C", "D"])),
    ("grid", "Grid — the active layer's six macros",
     lambda d: d.show_grid(GRID, 1, band="STREAM")),
    ("speed", "Speed editor — 0.1x-10.0x per macro",
     lambda d: d.show_speed("A", 6, 15)),
    # show_settings, not show_menu: the settings list has a value column of its
    # own (a toggle draws as a switch, Language names the language), and the
    # plain list this used to render was a screen the device never draws.
    # Items mirror Ui._set_items in firmware/mkyada/ui.py.
    ("settings", "Settings menu",
     lambda d: d.show_settings("SETTINGS",
                               [("Auto return", "text", "10s"),
                                ("Language", "text", "English"),
                                ("Layer band", "toggle", True),
                                ("Profile band", "toggle", False),
                                ("Wheel layers", "toggle", False),
                                ("Key test", "none", None),
                                ("Pixel test", "none", None),
                                ("About", "none", None),
                                ("Restart", "none", None)], 1)),
    ("transfer", "Data transfer — the app is writing files",
     lambda d: d.show_transfer()),
    ("about", "About — model, firmware, device id",
     lambda d: d.show_about((("Model", "vision6"), ("Firmware", "0.21.1"),
                             ("Device ID", "5035586072b9")))),
    ("wheel-scene", "Wheel menu — OBS scene picker",
     lambda d: d.show_menu("SCENE", ["Camera", "Desktop", "Cam + Desk",
                                     "Starting soon"], 1, marked=1,
                           action="Pick", hold="hold: assign")),
    ("wheel-status", "Wheel menu — OBS record status",
     lambda d: d.show_card("RECORD", "Recording", "12:04 elapsed", "toggle")),
    ("wheel-volume", "Wheel menu — system volume",
     lambda d: d.show_adjust("VOLUME", "40%", 0.4, "OK")),
    # The one Turkish screen: proof the device draws Ç Ğ İ Ö Ş Ü rather than
    # folding them, which is the whole reason the font was drawn by hand.
    ("menu-tr", "Turkish is drawn, not folded",
     lambda d: (i18n.set_lang("tr"),
                d.show_settings("AYARLAR",
                                [("Otomatik Dönüş", "text", "10sn"),
                                 ("Dil", "text", "Türkçe"),
                                 ("Katman bandı", "toggle", True),
                                 ("Profil bandı", "toggle", False),
                                 ("Tekerle katman", "toggle", False),
                                 ("Tuş testi", "none", None),
                                 ("Piksel testi", "none", None),
                                 ("Hakkında", "none", None),
                                 ("Yeniden Başlat", "none", None)], 1),
                i18n.set_lang("en"))),
]


def packed(o):
    """Rows as hex nibbles is 8x smaller than '#'/'.' art and just as exact:
    one bit per pixel, MSB leftmost, 32 hex characters per 128px row."""
    out = []
    for row in o.fb.bmp.rows():
        bits = 0
        for x, c in enumerate(row):
            if c == "#":
                bits |= 1 << (127 - x)
        out.append("%032x" % bits)
    return out


def main():
    i18n.set_lang("en")
    frames = []
    for name, caption, fn in SCREENS:
        d = make_oled()
        fn(d)
        frames.append({"id": name, "caption": caption, "rows": packed(d)})
    # Explicit UTF-8: the captions carry em dashes, and Python on a Turkish
    # Windows defaults to cp1254 — which silently wrote mojibake into a
    # generated file the CI then diffs.
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("// GENERATED by scripts/render-oled.py — do not edit.\n"
                "// Real firmware renders: firmware/mkyada/oled.py drawing with\n"
                "// firmware/fonts/mkyada.fnt. Each row is 128 bits as 32 hex\n"
                "// characters, MSB = leftmost pixel.\n"
                "export const FRAMES = ")
        json.dump(frames, f, indent=0, ensure_ascii=False)
        f.write(";\n")
    print("wrote %s (%d screens)" % (os.path.relpath(OUT, REPO), len(frames)))


main()

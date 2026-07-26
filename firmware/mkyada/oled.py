# Vision 6 display layer: every screen the SH1106 can show, and nothing else.
# Pure presentation — state lives in mkyada/ui.py, which calls these with
# plain data. Ported from hardware/oled-bringup/device/demo_h.py.
#
# A broken or absent display must never brick the keypad: init retries a few
# times, then the instance goes "headless" and every show_* is a no-op.

import gc
import time

import displayio
import terminalio
import vectorio
from adafruit_display_text import label

from mkyada.i18n import tr

try:
    from adafruit_bitmap_font import bitmap_font
except ImportError:
    bitmap_font = None

# Grid font sizes, picked in Settings > Font. char width decides how many
# characters fit per grid cell: (cell_w - 2) // cpx -> 10 / 8 / 6.
FONTS = (("Small", "/fonts/4x6.bdf"),
         ("Medium", "/fonts/spleen-5x8.bdf"),
         ("Large", None))  # None -> built-in terminalio
FONT_DESC = ("Small  4x6", "Medium 5x8", "Large  6px")
DEFAULT_FONT_IDX = 0

SPLEEN = "/fonts/spleen-5x8.bdf"
UI_GLYPHS = "Mgpy0123456789.xds<> abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ%"

# Grid fonts that actually render Turkish glyphs (real, non-blank bitmaps). Only
# the 4x6 font qualifies today; text on any other font is folded to ASCII.
FULL_TURKISH_FONTS = ("/fonts/4x6.bdf",)

INIT_TRIES = 3

WHITE = displayio.Palette(1)
WHITE[0] = 0xFFFFFF
BLACK = displayio.Palette(1)
BLACK[0] = 0x000000

# Turkish letters and their ASCII fallback. Only the 4x6 font ships real
# Turkish glyphs; spleen's Turkish glyphs are blank bitmaps (ç ö ü) or absent
# (ğ ı İ ş), and the built-in Large font is ASCII. So Turkish is kept as-is on
# the 4x6 font and folded to ASCII on every other font (see FULL_TURKISH_FONTS).
_TR_FOLD = {
    "ç": "c", "Ç": "C",  # ç Ç
    "ğ": "g", "Ğ": "G",  # ğ Ğ
    "ı": "i", "İ": "I",  # ı İ
    "ö": "o", "Ö": "O",  # ö Ö
    "ş": "s", "Ş": "S",  # ş Ş
    "ü": "u", "Ü": "U",  # ü Ü
}


def fold_ascii(s, keep_turkish=False):
    """Transliterate Turkish letters to ASCII. keep_turkish=True leaves them
    as-is — used only for the one font that ships real Turkish glyphs. Every
    other font either has blank glyphs for them (spleen) or is ASCII (the
    built-in Large font), where an un-folded Turkish letter renders as a
    missing/dropped character, so it must be folded."""
    if not s or keep_turkish:
        return s
    out = None  # copy lazily, only if something actually needs folding
    for i, ch in enumerate(s):
        if ch in _TR_FOLD:
            if out is None:
                out = list(s)
            out[i] = _TR_FOLD[ch]
    return "".join(out) if out is not None else s


def fmt_speed(t):
    return "%.1fx" % (t / 10)


def fmt_hero(t):
    v = t / 10
    return ("%d" % v) if v >= 10 else ("%.1f" % v)


def _rect(x, y, w, h, pal=WHITE):
    return vectorio.Rectangle(pixel_shader=pal, width=max(1, w),
                              height=max(1, h), x=x, y=y)


def _circ(x, y, r, pal=WHITE):
    return vectorio.Circle(pixel_shader=pal, radius=r, x=x, y=y)


class Oled:
    def __init__(self, cfg):
        self.display = None
        self._bar = None  # boot progress bar bitmap
        self._auto_off = False
        for _ in range(INIT_TRIES):
            try:
                import board
                import busio
                import i2cdisplaybus
                import adafruit_displayio_sh1106
                displayio.release_displays()
                i2c = busio.I2C(scl=getattr(board, cfg["scl"]),
                                sda=getattr(board, cfg["sda"]),
                                frequency=400000)
                bus = i2cdisplaybus.I2CDisplayBus(i2c, device_address=cfg["addr"])
                d = adafruit_displayio_sh1106.SH1106(
                    bus, width=cfg["width"], height=cfg["height"],
                    colstart=cfg.get("colstart", 2))
                d.root_group = displayio.Group()  # console never shows
                self.display = d
                break
            except Exception as e:
                print("oled init:", e)
                time.sleep(0.3)
        self.W = self.display.width if self.display else 128
        self.H = self.display.height if self.display else 64
        self.CX = self.W // 2
        self._font_cache = {}
        self._grid = None  # persistent grid group, built on first show_grid
        # last grid paint dropped a cell label (or failed whole) under memory
        # pressure — the UI repaints it once the heap has recovered
        self.grid_degraded = False
        self.grid_font = terminalio.FONT
        self.grid_cpx = 6
        self.grid_tr_ok = False  # grid font renders real Turkish glyphs?
        self.font_idx = 2
        self.hero_font = terminalio.FONT
        self.hero_scale = 3
        self.ui_font = terminalio.FONT
        if self.display:
            self._load_ui_fonts()

    @property
    def ok(self):
        return self.display is not None

    # --- fonts ---
    def _bdf(self, path, glyphs):
        f = self._font_cache.get(path)
        if f is None:
            f = bitmap_font.load_font(path)
            f.load_glyphs(set(glyphs) | set("Mgpy"))
            label.Label(f, text="Mg")  # warm the ascent/descent math
            self._font_cache[path] = f
        else:
            f.load_glyphs(set(glyphs))
        gc.collect()  # font rasterization litters the heap
        return f

    def _load_ui_fonts(self):
        if not bitmap_font:
            return
        try:
            f = self._bdf(SPLEEN, UI_GLYPHS)
            self.hero_font, self.hero_scale = f, 2
            self.ui_font = f
        except Exception as e:
            print("ui font missing:", e)

    def release_fonts(self):
        """Close every loaded BDF font's file handle and fall back to the
        built-in font. adafruit_bitmap_font keeps a BDF's file OPEN for the
        whole runtime (glyphs rasterize lazily from disk), so /fonts/*.bdf are
        live handles. A firmware update overwrites those exact files, and FAT
        can't os.remove/rename a file that's still open — the transfer died at
        the open font (spleen, the ui font). Dropping the handles here lets the
        fonts be replaced; the update screen just renders in terminalio, and
        the board reboots into the new fonts when the update ends."""
        for f in self._font_cache.values():
            try:
                f.file.close()
            except Exception:
                pass
        self._font_cache = {}
        self._grid = None  # its Labels reference the dropped fonts
        self.grid_font, self.grid_cpx, self.grid_tr_ok = terminalio.FONT, 6, False
        self.hero_font, self.hero_scale = terminalio.FONT, 3
        self.ui_font = terminalio.FONT

    def load_grid_font(self, idx, glyphs=""):
        """Apply grid font #idx; glyphs = every character the labels use
        (BDF fonts rasterize lazily, so preload exactly what's needed)."""
        self.font_idx = idx
        _name, path = FONTS[idx]
        if path is None or not bitmap_font:
            self.grid_font, self.grid_cpx = terminalio.FONT, 6
            self.grid_tr_ok = False
            return
        try:
            f = self._bdf(path, glyphs)
            self.grid_font = f
            self.grid_cpx = f.get_bounding_box()[0]
            self.grid_tr_ok = path in FULL_TURKISH_FONTS
        except Exception as e:
            print("grid font missing:", path, e)
            self.grid_font, self.grid_cpx = terminalio.FONT, 6
            self.grid_tr_ok = False

    def ensure_glyphs(self, text):
        """Preload label characters after labels change on the fly."""
        f = self.grid_font
        text = fold_ascii(text, self.grid_tr_ok)
        if f is not terminalio.FONT and text:
            try:
                f.load_glyphs(set(text))
            except Exception:
                pass

    # --- draw helpers ---
    def _txt(self, s, x, y, scale=1, color=0xFFFFFF, anchor=(0.5, 0.5), font=None):
        # _txt always draws with the UI/built-in fonts, which don't render
        # Turkish — so it always folds.
        l = label.Label(font or terminalio.FONT, text=fold_ascii(s), scale=scale, color=color)
        l.anchor_point = anchor
        l.anchored_position = (x, y)
        return l

    def _gtxt(self, s, x, y, color=0xFFFFFF):
        # the grid font may render Turkish (4x6); fold only when it can't
        l = label.Label(self.grid_font, text=fold_ascii(s, self.grid_tr_ok), color=color)
        l.anchor_point = (0.5, 0.5)
        l.anchored_position = (x, y)
        return l

    def _bold(self, g, s, x, y, scale=1, font=None):
        cx = x + scale // 2
        for dx in (-1, 0, 1):
            g.append(self._txt(s, cx + dx, y, scale=scale, font=font))

    def _top_bar(self, g, title, hint=None):
        """Inverted title strip. `hint` rides at its right edge — that's where
        the third gesture ("hold: assign") lives, because three labels in the
        13px bottom bar ran together into one unreadable smear (issue #36).
        Up here the title is left-aligned instead of centred, so the two never
        collide."""
        g.append(_rect(0, 0, self.W, 13))
        if hint:
            g.append(self._txt(title, 2, 6, color=0x000000, anchor=(0.0, 0.5)))
            g.append(self._txt(hint, self.W - 2, 6, color=0x000000,
                               anchor=(1.0, 0.5), font=self.ui_font))
        else:
            g.append(self._txt(title, self.CX, 6, color=0x000000))

    def _bottom_bar(self, g, action=None, back=True):
        """Two slots only: BACK on the left, the confirming action on the
        right. Anything else belongs in the top bar's hint (issue #36)."""
        y = self.H - 13
        g.append(_rect(0, y, self.W, 1))
        if back:
            g.append(self._txt(tr("back"), 2, self.H - 6, anchor=(0.0, 0.5),
                               font=self.ui_font))
        if action:
            g.append(self._txt(action, self.W - 2, self.H - 6, anchor=(1.0, 0.5),
                               font=self.ui_font))

    def _hbar(self, g, frac):
        bx, by, bw, bh = 8, 39, self.W - 16, 4
        g.append(_rect(bx, by + bh // 2, bw, 1))  # thin track
        g.append(_rect(bx, by, int(frac * bw), bh))

    def _check(self, g, cx, cy, s):
        bmp = displayio.Bitmap(s, s, 2)
        pal = displayio.Palette(2)
        pal[0] = 0x000000
        pal[1] = 0xFFFFFF

        def line(x0, y0, x1, y1, th):
            steps = max(abs(x1 - x0), abs(y1 - y0), 1)
            for i in range(steps + 1):
                x = x0 + (x1 - x0) * i // steps
                y = y0 + (y1 - y0) * i // steps
                for ox in range(th):
                    for oy in range(th):
                        px, py = x + ox, y + oy
                        if 0 <= px < s and 0 <= py < s:
                            bmp[px, py] = 1

        line(int(s * 0.12), int(s * 0.52), int(s * 0.40), int(s * 0.78), 2)
        line(int(s * 0.40), int(s * 0.78), int(s * 0.86), int(s * 0.22), 2)
        g.append(displayio.TileGrid(bmp, pixel_shader=pal,
                                    x=cx - s // 2, y=cy - s // 2))

    def paint(self, g):
        if not self.display:
            return
        # Painting anything that ISN'T the grid means we've left the grid, so
        # let its persistent group go. Keeping 13 Labels + their glyph tiles
        # alive behind an unrelated screen is pure fragmentation: with the
        # Keys-tab test screen up, a 767-byte serial line could not be
        # allocated even with 10.6KB free — every macro save from that screen
        # failed. Grid repaints pass the same group, so they still cost nothing.
        if self._grid is not None and g is not self._grid["g"]:
            self._grid = None
            gc.collect()
        if not self._auto_off:
            # first real screen: from here on refreshes are manual, which
            # kills the lazy-refresh lag the demo suffered on first draw
            self.display.auto_refresh = False
            self._auto_off = True
        self.display.root_group = g
        try:
            self.display.refresh()
        except Exception:
            pass
        gc.collect()  # drop the previous screen's group right away —
        # displayio churn is the main fragmentation source on the RP2040

    # --- screens ---
    def show_boot(self):
        """Branded loading screen; up before the heavy imports run."""
        if not self.display:
            return
        g = displayio.Group()
        g.append(self._txt("MKYADA", self.CX, 24, scale=2))
        g.append(self._txt(tr("loading"), self.CX, 56, font=self.ui_font))
        bw = self.W - 24
        bmp = displayio.Bitmap(bw, 5, 2)
        pal = displayio.Palette(2)
        pal[0] = 0x000000
        pal[1] = 0xFFFFFF
        g.append(displayio.TileGrid(bmp, pixel_shader=pal,
                                    x=(self.W - bw) // 2, y=42))
        self._bar = bmp
        self.display.root_group = g
        try:
            self.display.refresh()
        except Exception:
            pass

    def boot_progress(self, frac):
        if not self.display or self._bar is None:
            return
        w = int(min(1.0, max(0.0, frac)) * self._bar.width)
        for x in range(w):
            for y in range(5):
                self._bar[x, y] = 1
        try:
            self.display.refresh()
        except Exception:
            pass

    def show_update(self, frac, restarting=False):
        """Locked firmware-update screen: brand, progress bar, percentage.
        Deliberately styled like the boot screen — same visual language for
        'the keypad is busy with itself, hands off'."""
        if not self.display:
            return
        g = displayio.Group()
        g.append(self._txt("MKYADA", self.CX, 14, scale=2))
        # "updating - do not unplug" on one line ran off both edges (issue
        # #35): the warning gets its own second line, and the whole stack
        # moves up to keep the bar and percentage on screen.
        if restarting:
            g.append(self._txt(tr("restarting"), self.CX, 34, font=self.ui_font))
        else:
            g.append(self._txt(tr("updating"), self.CX, 30, font=self.ui_font))
            g.append(self._txt(tr("updating2"), self.CX, 41, font=self.ui_font))
        bw = self.W - 24
        bmp = displayio.Bitmap(bw, 5, 2)
        pal = displayio.Palette(2)
        pal[0] = 0x000000
        pal[1] = 0xFFFFFF
        w = int(min(1.0, max(0.0, frac)) * bw)
        for x in range(w):
            for y in range(5):
                bmp[x, y] = 1
        g.append(displayio.TileGrid(bmp, pixel_shader=pal,
                                    x=(self.W - bw) // 2, y=50))
        g.append(self._txt("%d%%" % int(frac * 100), self.CX, 60,
                           font=self.ui_font))
        self.paint(g)

    def show_home(self, pos, layer_count, layer_names):
        """Layer letters + SETTINGS. pos == layer_count means SETTINGS."""
        if not self.display:
            return
        g = displayio.Group()
        n = layer_count + 1
        if pos < layer_count:
            # spleen caps at scale 6 are ~10% smaller than the old terminalio
            # scale-5 letter, and y=26 leaves about the same air above the
            # letter as between it and the position dots below
            if self.ui_font is not terminalio.FONT:
                self._bold(g, layer_names[pos].upper(), self.CX, 26, scale=6,
                           font=self.ui_font)
            else:
                self._bold(g, layer_names[pos].upper(), self.CX, 25, scale=5)
        else:
            g.append(self._txt(tr("settings"), self.CX, 24, scale=2))
        gap = 14 if n <= 8 else 12
        x0 = self.CX - (n - 1) * gap // 2
        for i in range(n):
            g.append(_circ(x0 + i * gap, 54, 3 if i == pos else 1))
        self.paint(g)

    BAND_H = 10  # inverted status strip over the grid (show_layer/show_profile)

    def show_grid(self, labels, active, invert=True, band=None):
        """3x2 macro grid; labels = [(line1, line2)] * 6. The active cell
        renders inverted while invert is True (selection / playing).
        band = optional status text (active layer / profile label) drawn as
        an inverted strip across the top; the six cells and their macro
        names squeeze into the remaining height.

        The grid is PERSISTENT: the group (band strip, dividers, 6 highlight
        rects, 13 Labels) is built once and every later paint only mutates
        Label.text / .color and shifts the highlight rect. Rebuilding it per
        paint transiently ate nearly all free heap, and under pressure a cell
        Label (or the whole paint) died — the "blinking labels" bug. Now a
        repaint allocates only for the cells whose text actually changed."""
        if not self.display:
            return
        self.grid_degraded = False
        banded = bool(band)
        st = self._grid
        if (st is None or st["banded"] != banded
                or st["font"] is not self.grid_font):
            st = None
            self._grid = None  # the old group is garbage — free it first
            for _ in range(2):
                gc.collect()
                try:
                    st = self._grid_build(banded)
                    break
                except MemoryError:
                    continue
            if st is None:
                self.grid_degraded = True  # retry once the heap recovers
                return
            self._grid = st
        if banded:
            # band uses the UI font (no Turkish); 21 chars is what fits in
            # 128px — a longer text would center itself off both edges.
            b = fold_ascii(band)[:21]
            if st["band"].text != b:
                if self.ui_font is not terminalio.FONT:
                    try:  # profile names carry chars outside UI_GLYPHS
                        self.ui_font.load_glyphs(set(b))
                    except Exception:
                        pass
                try:
                    st["band"].text = b
                except MemoryError:
                    gc.collect()
                    self.grid_degraded = True
        cw, ch, top = st["cw"], st["ch"], st["top"]
        y1 = st["y1"]
        maxc = (cw - 2) // self.grid_cpx
        for k in range(6):
            cell = st["cells"][k]
            bg, l1, l2, x, y = cell[0], cell[1], cell[2], cell[3], cell[4]
            t1, t2 = labels[k] if k < len(labels) else ("", "")
            t1 = fold_ascii((t1 or "")[:maxc], self.grid_tr_ok)
            t2 = fold_ascii((t2 or "")[:maxc], self.grid_tr_ok)
            on = k == active and invert
            want = (t1, t2, on)
            if cell[5] == want:
                continue
            # Per-cell resilience: even a text mutation allocates its glyph
            # tiles, and on a shredded heap that can still fail. Skip just
            # that cell, keep its cache dirty so the degraded repaint fixes
            # it once the heap recovers.
            try:
                bg.x = x if on else -cw - 2  # off-screen == hidden
                col = 0x000000 if on else 0xFFFFFF
                # one-line cells center vertically; two-line cells stack
                l1.anchored_position = (x + cw // 2,
                                        y + (y1 if t2 else ch // 2))
                if l1.text != t1:
                    l1.text = t1
                if l2.text != t2:
                    l2.text = t2
                l1.color = col
                l2.color = col
                cell[5] = want
            except MemoryError:
                gc.collect()
                cell[5] = None
                self.grid_degraded = True
        self.paint(st["g"])

    def update_band(self, band):
        """Repaint ONLY the band strip's text on the live grid group, leaving
        the six cells untouched. The blink markers change twice a second and
        the OBS scene changes on every switch; driving those through a full
        show_grid() allocated a whole label set each time — in the same size
        class as an incoming serial chunk. Returns False if the caller must
        fall back to a full paint (no persistent group yet / band-less grid)."""
        st = self._grid
        if not self.display or not st or not st["banded"] or st["band"] is None:
            return False
        b = fold_ascii(band or "")[:21]
        if st["band"].text == b:
            return True
        try:
            if self.ui_font is not terminalio.FONT:
                try:  # scene names carry chars outside UI_GLYPHS
                    self.ui_font.load_glyphs(set(b))
                except Exception:
                    pass
            st["band"].text = b
            self.display.refresh()
        except MemoryError:
            gc.collect()
            self.grid_degraded = True
            return False
        except Exception:
            return False
        return True

    def _grid_build(self, banded):
        cols, rows = 3, 2
        top = self.BAND_H if banded else 0
        cw = self.W // cols          # 42
        ch = (self.H - top) // rows  # 32 full-height, 27 under the band
        g = displayio.Group()
        st = {"g": g, "banded": banded, "font": self.grid_font,
              "cw": cw, "ch": ch, "top": top,
              "y1": 9 if banded else 11, "band": None, "cells": []}
        if banded:
            g.append(_rect(0, 0, self.W, top))
            st["band"] = self._txt("", self.CX, top // 2 - 1, color=0x000000,
                                   font=self.ui_font)
            g.append(st["band"])
        g.append(_rect(cw, top, 1, self.H - top))
        g.append(_rect(2 * cw, top, 1, self.H - top))
        g.append(_rect(0, top + ch, self.W, 1))
        y2 = 18 if banded else 22
        for k in range(6):
            x = (k % cols) * cw
            y = top + (k // cols) * ch
            bg = _rect(-cw - 2, y, cw, ch)  # starts hidden (off-screen)
            g.append(bg)
            l1 = self._gtxt("", x + cw // 2, y + ch // 2)
            l2 = self._gtxt("", x + cw // 2, y + y2)
            g.append(l1)
            g.append(l2)
            # [5] caches (line1, line2, inverted) so unchanged cells cost 0
            st["cells"].append([bg, l1, l2, x, y, None])
        return st

    def show_speed(self, layer_name, key_no, t):
        if not self.display:
            return
        g = displayio.Group()
        self._top_bar(g, "%s > K%d  %s" % (layer_name.upper(), key_no, tr("speed")))
        g.append(self._txt(fmt_hero(t), self.CX, 28, scale=self.hero_scale,
                           font=self.hero_font))
        self._hbar(g, (t - 1) / 99.0)
        self._bottom_bar(g, action=tr("save"))
        self.paint(g)

    def show_card(self, title, big, line=None, hint=None):
        """Generic action card for the context-aware wheel menu: a title bar,
        a bold hero line (the key's action), an optional status line, and a
        bottom bar whose right-hand label is `hint` (what CONFIRM does)."""
        if not self.display:
            return
        g = displayio.Group()
        self._top_bar(g, title)
        g.append(self._txt(big, self.CX, 28, scale=2, font=self.ui_font))
        if line:
            g.append(self._txt(line, self.CX, 44, font=self.ui_font))
        self._bottom_bar(g, action=hint)
        self.paint(g)

    def show_adjust(self, title, hero, frac, action=None):
        """Generic value slider (host-backed volume, brightness): title bar,
        big value, progress bar, bottom action. Generalizes show_speed /
        show_timeout for the context-aware wheel menu."""
        if not self.display:
            return
        g = displayio.Group()
        self._top_bar(g, title)
        g.append(self._txt(hero, self.CX, 28, scale=self.hero_scale,
                           font=self.hero_font))
        self._hbar(g, max(0.0, min(1.0, frac)))
        self._bottom_bar(g, action=action)
        self.paint(g)

    def show_saved(self, layer_name, key_no, t):
        if not self.display:
            return
        g = displayio.Group()
        self._top_bar(g, "%s > K%d" % (layer_name.upper(), key_no))
        self._check(g, self.CX, 32, 22)
        g.append(self._txt(fmt_speed(t), self.CX, 54, scale=2))
        self.paint(g)

    def show_toast(self, title, line1, line2=""):
        """Short informational screen (read-only drive, missing macro...)."""
        if not self.display:
            return
        g = displayio.Group()
        self._top_bar(g, title)
        g.append(self._txt(line1, self.CX, 30, font=self.ui_font))
        if line2:
            g.append(self._txt(line2, self.CX, 42, font=self.ui_font))
        self.paint(g)

    def show_about(self, rows):
        """Device info screen: a title bar over left-aligned label: value
        rows (model, firmware, device id). `rows` is a sequence of
        (label, value) pairs."""
        if not self.display:
            return
        g = displayio.Group()
        self._top_bar(g, tr("about_title"))
        y = 22
        for label_s, value_s in rows:
            g.append(self._txt("%s:" % label_s, 4, y, anchor=(0.0, 0.5),
                               font=self.ui_font))
            g.append(self._txt(value_s, self.W - 4, y, anchor=(1.0, 0.5),
                               font=self.ui_font))
            y += 12
        self._bottom_bar(g, action=None)
        self.paint(g)

    MENU_VIS = 3  # rows that fit between the top and bottom bars

    def show_menu(self, title, items, sel, marked=None, action=None, hold=None):
        """Generic list menu (Settings, Font). marked = index tagged with >.
        Longer lists scroll: the selection stays visible and small arrows on
        the right show there are items above/below. `hold`, when set, names
        the hold-to-reassign gesture in the top bar's right corner."""
        if not self.display:
            return
        # Every detent rebuilds this group — five Labels plus rects — and a
        # failed build leaves the PREVIOUS screen on the glass, so the wheel
        # looks stuck at the row it opened on while the selection moves
        # invisibly underneath (issue #39). Compact first, and if the build
        # still can't fit, fall back to the one row that matters.
        gc.collect()
        try:
            g = self._menu_group(title, items, sel, marked, action, hold)
        except MemoryError:
            gc.collect()
            try:
                g = self._menu_group(title, items, sel, marked, action, hold)
            except MemoryError:
                gc.collect()
                g = displayio.Group()
                self._top_bar(g, title)
                g.append(self._txt(str(items[sel])[:20], self.CX, 32))
                self._bottom_bar(g, action=action or tr("select"))
        self.paint(g)

    def _menu_group(self, title, items, sel, marked, action, hold):
        g = displayio.Group()
        self._top_bar(g, title, hint=hold)
        n = len(items)
        top = sel - self.MENU_VIS + 1 if sel >= self.MENU_VIS else 0
        # keep the arrow strip clear of the selection rectangle
        rw = self.W - 8 if n > self.MENU_VIS else self.W
        for row in range(min(self.MENU_VIS, n)):
            i = top + row
            y = 20 + row * 12
            if i == sel:
                g.append(_rect(0, y - 6, rw, 12))
                c = 0x000000
            else:
                c = 0xFFFFFF
            text = items[i] if marked is None else (
                "%s %s" % (">" if i == marked else " ", items[i]))
            g.append(self._txt(text, self.CX, y, color=c))
        if top > 0:
            g.append(vectorio.Polygon(pixel_shader=WHITE,
                                      points=[(3, 0), (6, 4), (0, 4)],
                                      x=self.W - 7, y=15))
        if top + self.MENU_VIS < n:
            g.append(vectorio.Polygon(pixel_shader=WHITE,
                                      points=[(0, 0), (6, 0), (3, 4)],
                                      x=self.W - 7, y=45))
        self._bottom_bar(g, action=action or tr("select"))
        return g

    def show_timeout(self, sec, lo, hi):
        if not self.display:
            return
        g = displayio.Group()
        self._top_bar(g, tr("auto_return_title"))
        g.append(self._txt("%ds" % sec, self.CX, 28, scale=self.hero_scale,
                           font=self.hero_font))
        self._hbar(g, (sec - lo) / float(hi - lo))
        self._bottom_bar(g, action=tr("save"))
        self.paint(g)

    def show_host(self):
        if not self.display:
            return
        g = displayio.Group()
        self._top_bar(g, "MKYADA")
        g.append(self._txt(tr("host"), self.CX, 34, font=self.ui_font))
        self.paint(g)

    def show_headless(self):
        """The menu module could not load (import/compile/MemoryError — e.g.
        ui.py shipped as source and the display-fragmented heap couldn't
        compile it). Keys and serial still work; show why instead of leaving
        the boot 'loading' splash frozen, which reads as a brick."""
        if not self.display:
            return
        g = displayio.Group()
        self._top_bar(g, "MKYADA")
        g.append(self._txt(tr("menu_fail"), self.CX, 30, font=self.ui_font))
        g.append(self._txt(tr("menu_fail_hint"), self.CX, 44, font=self.ui_font))
        self.paint(g)

    def show_error(self, msg):
        if not self.display:
            return
        g = displayio.Group()
        self._top_bar(g, "MKYADA")
        g.append(self._txt(tr("err_title"), self.CX, 26, font=self.ui_font))
        msg = str(msg)
        g.append(self._txt(msg[:25], self.CX, 40, font=self.ui_font))
        if len(msg) > 25:
            g.append(self._txt(msg[25:50], self.CX, 50, font=self.ui_font))
        self.paint(g)

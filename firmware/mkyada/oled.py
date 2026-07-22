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

INIT_TRIES = 3

WHITE = displayio.Palette(1)
WHITE[0] = 0xFFFFFF
BLACK = displayio.Palette(1)
BLACK[0] = 0x000000


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
        self.grid_font = terminalio.FONT
        self.grid_cpx = 6
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

    def load_grid_font(self, idx, glyphs=""):
        """Apply grid font #idx; glyphs = every character the labels use
        (BDF fonts rasterize lazily, so preload exactly what's needed)."""
        self.font_idx = idx
        _name, path = FONTS[idx]
        if path is None or not bitmap_font:
            self.grid_font, self.grid_cpx = terminalio.FONT, 6
            return
        try:
            f = self._bdf(path, glyphs)
            self.grid_font = f
            self.grid_cpx = f.get_bounding_box()[0]
        except Exception as e:
            print("grid font missing:", path, e)
            self.grid_font, self.grid_cpx = terminalio.FONT, 6

    def ensure_glyphs(self, text):
        """Preload label characters after labels change on the fly."""
        f = self.grid_font
        if f is not terminalio.FONT and text:
            try:
                f.load_glyphs(set(text))
            except Exception:
                pass

    # --- draw helpers ---
    def _txt(self, s, x, y, scale=1, color=0xFFFFFF, anchor=(0.5, 0.5), font=None):
        l = label.Label(font or terminalio.FONT, text=s, scale=scale, color=color)
        l.anchor_point = anchor
        l.anchored_position = (x, y)
        return l

    def _gtxt(self, s, x, y, color=0xFFFFFF):
        l = label.Label(self.grid_font, text=s, color=color)
        l.anchor_point = (0.5, 0.5)
        l.anchored_position = (x, y)
        return l

    def _bold(self, g, s, x, y, scale=1):
        cx = x + scale // 2
        for dx in (-1, 0, 1):
            g.append(self._txt(s, cx + dx, y, scale=scale))

    def _top_bar(self, g, title):
        g.append(_rect(0, 0, self.W, 13))
        g.append(self._txt(title, self.CX, 6, color=0x000000))

    def _bottom_bar(self, g, action=None, back=True):
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

    def show_home(self, pos, layer_count, layer_names):
        """Layer letters + SETTINGS. pos == layer_count means SETTINGS."""
        if not self.display:
            return
        g = displayio.Group()
        n = layer_count + 1
        if pos < layer_count:
            self._bold(g, layer_names[pos].upper(), self.CX, 22, scale=5)
        else:
            g.append(self._txt("SETTINGS", self.CX, 24, scale=2))
        gap = 14 if n <= 8 else 12
        x0 = self.CX - (n - 1) * gap // 2
        for i in range(n):
            g.append(_circ(x0 + i * gap, 54, 3 if i == pos else 1))
        self.paint(g)

    def show_grid(self, labels, active, invert=True):
        """3x2 macro grid; labels = [(line1, line2)] * 6. The active cell
        renders inverted while invert is True (selection / playing)."""
        if not self.display:
            return
        g = displayio.Group()
        cols, rows = 3, 2
        cw = self.W // cols   # 42
        ch = self.H // rows   # 32
        maxc = (cw - 2) // self.grid_cpx
        g.append(_rect(cw, 0, 1, self.H))
        g.append(_rect(2 * cw, 0, 1, self.H))
        g.append(_rect(0, ch, self.W, 1))
        for k in range(6):
            x = (k % cols) * cw
            y = (k // cols) * ch
            if k == active and invert:
                g.append(_rect(x, y, cw, ch))
                col = 0x000000
            else:
                col = 0xFFFFFF
            l1, l2 = labels[k] if k < len(labels) else ("", "")
            if l2:
                g.append(self._gtxt(l1[:maxc], x + cw // 2, y + 11, color=col))
                g.append(self._gtxt(l2[:maxc], x + cw // 2, y + 22, color=col))
            elif l1:
                g.append(self._gtxt(l1[:maxc], x + cw // 2, y + ch // 2, color=col))
        self.paint(g)

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

    def show_menu(self, title, items, sel, marked=None, action=None):
        """Generic list menu (Settings, Font). marked = index tagged with >."""
        if not self.display:
            return
        g = displayio.Group()
        self._top_bar(g, title)
        for i, name in enumerate(items):
            y = 22 + i * 12
            if i == sel:
                g.append(_rect(0, y - 6, self.W, 12))
                c = 0x000000
            else:
                c = 0xFFFFFF
            text = name if marked is None else (
                "%s %s" % (">" if i == marked else " ", name))
            g.append(self._txt(text, self.CX, y, color=c))
        self._bottom_bar(g, action=action or tr("select"))
        self.paint(g)

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

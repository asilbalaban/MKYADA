# Vision 6 display layer: every screen the SH1106 can show, and nothing else.
# Pure presentation — state lives in mkyada/ui.py, which calls these with
# plain data.
#
# Everything is drawn into ONE resident framebuffer (mkyada/font.py) that is
# allocated at boot and never rebuilt. There are no Groups, no Labels and no
# BDF fonts: the previous design built a fresh displayio object tree per
# screen, and because CircuitPython's GC never compacts, that churn was the
# fragmentation source behind failed macro saves, the wedged menu wheel and
# the blinking grid labels. Measured on the board: ten full repaints now
# allocate 48 bytes total.
#
# A broken or absent display must never brick the keypad: init retries a few
# times, then the instance goes "headless" and every show_* is a no-op. A
# missing/corrupt font file takes the same path — keys keep working.

import time

import displayio

from mkyada.font import Fb, Font
from mkyada.i18n import tr

FONT_PATH = "/fonts/mkyada.fnt"
INIT_TRIES = 3

# Layout, re-derived for the 5x8 font. The old numbers were sized around a 6px
# built-in font plus Label padding; the glyph box is 8px tall with the caps in
# rows 0..6, so the bars lost 2px each and the menu rows 2px — which is exactly
# what buys the fourth visible menu row.
BAR_H = 11        # inverted title strip
BAR_Y = 5         # cap-centre of the title text
BOT_SEP = 53      # hairline above the bottom bar
BOT_Y = 58        # cap-centre of the bottom bar text
HBAR_Y = 41      # value slider (same y the design viewer shows)
HBAR_H = 5
ROW_H = 10        # menu row pitch
# Cap-centre of the first menu row. Four rows of 10px start at y=11 (just under
# the bar) and the last one ends at 50, two rows clear of the hairline — the
# whole reason MENU_VIS could go from three rows to four.
MENU_TOP = 15


def fmt_speed(t):
    return "%.1fx" % (t / 10)


def fmt_hero(t):
    v = t / 10
    return ("%d" % v) if v >= 10 else ("%.1f" % v)


class Oled:
    BAND_H = 10   # inverted status strip over the grid (show_layer/show_profile)
    MENU_VIS = 4  # rows that fit between the top and bottom bars

    def __init__(self, cfg):
        self.display = None
        self.fb = None
        self.font = None
        self._bar = None   # (x, y, w, h) of the boot/update progress bar
        self._last = None  # key of the screen currently on the glass
        self._cells = None # per-cell (line1, line2, inverted) cache
        self._band_txt = None
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
                # Refreshes are manual from the very first frame. The old code
                # switched auto_refresh off on the first real screen, which
                # left the boot splash refreshing on displayio's own schedule.
                d.auto_refresh = False
                self.display = d
                break
            except Exception as e:
                print("oled init:", e)
                time.sleep(0.3)
        self.W = self.display.width if self.display else 128
        self.H = self.display.height if self.display else 64
        self.CX = self.W // 2
        if self.display:
            try:
                self.font = Font(FONT_PATH)
                self.fb = Fb(self.W, self.H, self.font)
                self.display.root_group = self.fb.group
            except Exception as e:
                # No font means no text, and a screen that can only draw
                # rectangles is worse than none: fall back to headless so the
                # keypad still plays macros and the app can reflash the font.
                print("font load failed:", e)
                self.display = None
                self.fb = None

    @property
    def ok(self):
        return self.display is not None

    def split_name(self, name, cols=3):
        """Break a macro name into the (line1, line2) a grid cell shows.

        Splitting is by PIXELS, not characters. The old code cut every name at
        a fixed count — 10 for the 4x6 font — which was wrong in both
        directions: 'IIIIIIIIII' left half the cell empty and 'WWWWWWWWWW'
        ran over its divider."""
        name = name.strip()
        f = self.font
        if f is None:
            # Headless (no display, so no font was loaded). ui.py still splits
            # names for its label cache, so answer with the old fixed cut
            # rather than raising into the key-handling path.
            return (name[:10], name[10:20]) if len(name) > 10 else (name, "")
        cell = self.W // cols - 2
        if f.measure(name) <= cell:
            return (name, "")
        # Prefer breaking on a space, so "Stop recording" stacks as two words
        # rather than mid-word.
        head = f.fit(name, cell)
        cut = head.rfind(" ")
        if cut > 0:
            return (name[:cut], f.fit(name[cut + 1:], cell))
        return (head, f.fit(name[len(head):], cell))

    # --- chrome ---
    def _top_bar(self, title, hint=None):
        """Inverted title strip. `hint` rides at its right edge — that's where
        the third gesture ("hold: assign") lives, because three labels in the
        bottom bar ran together into one unreadable smear (issue #36). Up here
        the title is left-aligned instead of centred, so the two never
        collide."""
        fb = self.fb
        fb.rect(0, 0, self.W, BAR_H)
        if hint:
            fb.text(title, 2, BAR_Y, anchor=0.0, invert=True)
            fb.text(hint, self.W - 2, BAR_Y, anchor=1.0, invert=True)
        else:
            fb.text(title, self.CX, BAR_Y, invert=True)

    def _bottom_bar(self, action=None, back=True):
        """Two slots only: BACK on the left, the confirming action on the
        right. Anything else belongs in the top bar's hint (issue #36)."""
        self.fb.hline(0, BOT_SEP, self.W)
        if back:
            self.fb.text(tr("back"), 2, BOT_Y, anchor=0.0)
        if action:
            self.fb.text(action, self.W - 2, BOT_Y, anchor=1.0)

    def _hbar(self, frac):
        bx, bw = 8, self.W - 16
        self.fb.hline(bx, HBAR_Y + HBAR_H // 2, bw)          # thin track
        self.fb.rect(bx, HBAR_Y, int(frac * bw), HBAR_H)

    def _dot(self, cx, cy, big):
        """Position dot on the layer picker. The 5x5 'big' form is three rects
        rather than a circle primitive — vectorio.Circle cost an object per
        paint and there are up to nine of them."""
        if big:
            self.fb.rect(cx - 1, cy - 2, 3, 5)
            self.fb.rect(cx - 2, cy - 1, 5, 3)
        else:
            self.fb.rect(cx, cy, 1, 1)

    def paint(self, key=None):
        """Push the framebuffer. `key` names the screen so the next call knows
        whether it may repaint incrementally."""
        if not self.display:
            return
        self._last = key
        try:
            self.display.refresh()
        except Exception:
            pass

    def _begin(self, key):
        """Start a fresh screen. Returns False when the caller should skip
        drawing entirely (headless)."""
        if not self.display:
            return False
        if key != "grid":
            self._cells = None
            self._band_txt = None
        self.fb.clear()
        return True

    # --- screens ---
    def show_boot(self):
        """Branded loading screen; up before the heavy imports run."""
        if not self._begin("boot"):
            return
        self.fb.big("MKYADA", self.CX, 24, scale=2)
        self.fb.text(tr("loading"), self.CX, 56)
        bw = self.W - 24
        self._bar = ((self.W - bw) // 2, 42, bw, 5)
        self.fb.rect(self._bar[0], self._bar[1], bw, 5, 0)
        self.paint("boot")

    def boot_progress(self, frac):
        if not self.display or self._bar is None:
            return
        x, y, w, h = self._bar
        self.fb.rect(x, y, int(min(1.0, max(0.0, frac)) * w), h)
        self.paint(self._last)

    def show_update(self, frac, restarting=False):
        """Locked firmware-update screen: brand, progress bar, percentage.
        Deliberately styled like the boot screen — same visual language for
        'the keypad is busy with itself, hands off'."""
        if not self._begin("update"):
            return
        self.fb.big("MKYADA", self.CX, 13, scale=2)
        # "updating - do not unplug" on one line ran off both edges (issue
        # #35), so the warning gets its own second line.
        if restarting:
            self.fb.text(tr("restarting"), self.CX, 33)
        else:
            self.fb.text(tr("updating"), self.CX, 29)
            self.fb.text(tr("updating2"), self.CX, 40)
        bw = self.W - 24
        x0 = (self.W - bw) // 2
        self.fb.rect(x0, 50, int(min(1.0, max(0.0, frac)) * bw), 5)
        self.fb.text("%d%%" % int(frac * 100), self.CX, 59)
        self.paint("update")

    def show_home(self, pos, layer_count, layer_names):
        """Layer letters + SETTINGS. pos == layer_count means SETTINGS."""
        if not self._begin("home"):
            return
        n = layer_count + 1
        if pos < layer_count:
            self.fb.big(layer_names[pos].upper(), self.CX, 26, scale=5)
        else:
            self.fb.big(tr("settings"), self.CX, 26, scale=2)
        gap = 14 if n <= 8 else 12
        x0 = self.CX - (n - 1) * gap // 2
        for i in range(n):
            self._dot(x0 + i * gap, 54, i == pos)
        self.paint("home")

    def show_grid(self, labels, active, invert=True, band=None):
        """3x2 macro grid; labels = [(line1, line2)] * 6. The active cell
        renders inverted while invert is True (selection / playing).
        band = optional status text (active layer / profile label) drawn as an
        inverted strip across the top.

        Only the cells whose content actually changed are redrawn, and only
        their rectangles are cleared — so moving the selection one cell to the
        right touches two cells and displayio pushes just those rows (3ms on
        the board, against 79ms for a full screen)."""
        if not self.display:
            return
        banded = bool(band)
        top = self.BAND_H if banded else 0
        cw = self.W // 3
        ch = (self.H - top) // 2
        fresh = self._last != "grid" or self._cells is None or \
            self._cells[6] != banded
        if fresh:
            self.fb.clear()
            self._cells = [None] * 6 + [banded]
            self._band_txt = None
            self.fb.vline(cw, top, self.H - top)
            self.fb.vline(2 * cw, top, self.H - top)
            self.fb.hline(0, top + ch, self.W)
        if banded:
            self._paint_band(band)
        for k in range(6):
            t1, t2 = labels[k] if k < len(labels) else ("", "")
            on = k == active and invert
            want = (t1 or "", t2 or "", on)
            if self._cells[k] == want:
                continue
            self._cells[k] = want
            col = k % 3
            row = k // 3
            # The cell's INTERIOR — the dividers sit at x=cw, x=2*cw and
            # y=top+ch, and a cell that cleared its own bounding box erased
            # them. Chrome is drawn once; cells must stay inside it.
            x0 = col * cw + (1 if col else 0)
            x1 = self.W if col == 2 else (col + 1) * cw
            y0 = top + (row * ch) + (1 if row else 0)
            y1 = self.H if row else top + ch
            self.fb.rect(x0, y0, x1 - x0, y1 - y0, 1 if on else 0)
            cx = (x0 + x1) // 2
            cy = (y0 + y1) // 2
            if want[1]:
                self.fb.text(want[0], cx, cy - 4, invert=on)
                self.fb.text(want[1], cx, cy + 4, invert=on)
            else:
                self.fb.text(want[0], cx, cy, invert=on)
        self.paint("grid")

    def _paint_band(self, band):
        b = (band or "")[:24]
        if b == self._band_txt:
            return
        self._band_txt = b
        self.fb.rect(0, 0, self.W, self.BAND_H)
        self.fb.text(b, self.CX, self.BAND_H // 2, invert=True)

    def update_band(self, band):
        """Repaint ONLY the band strip on the live grid, leaving the six cells
        untouched. The blink markers change twice a second and the OBS scene
        changes on every switch; driving those through a full show_grid()
        used to allocate a whole label set each time — in the same size class
        as an incoming serial chunk. Returns False if the caller must fall
        back to a full paint."""
        if not self.display or self._last != "grid" or self._cells is None:
            return False
        if not self._cells[6]:
            return False
        self._paint_band(band)
        self.paint("grid")
        return True

    def show_speed(self, layer_name, key_no, t):
        if not self._begin("speed"):
            return
        self._top_bar("%s > K%d  %s" % (layer_name.upper(), key_no, tr("speed")))
        self.fb.big(fmt_hero(t), self.CX, 27, scale=3)
        self._hbar((t - 1) / 99.0)
        self._bottom_bar(action=tr("save"))
        self.paint("speed")

    def show_card(self, title, big, line=None, hint=None):
        """Generic action card for the context-aware wheel menu: a title bar,
        a bold hero line (the key's action), an optional status line, and a
        bottom bar whose right-hand label is `hint` (what CONFIRM does)."""
        if not self._begin("card"):
            return
        self._top_bar(title)
        # ui.py caps the hero at 12 characters, but 12 WIDE ones are 168px at
        # scale 2 and a centred overflow gets cut off at BOTH ends. Fit to the
        # glass instead, so what survives is the start of the name.
        self.fb.big(self.font.fit(big, self.W // 2), self.CX, 27, scale=2)
        if line:
            self.fb.text(line, self.CX, 44)
        self._bottom_bar(action=hint)
        self.paint("card")

    def show_adjust(self, title, hero, frac, action=None):
        """Generic value slider (host-backed volume, brightness): title bar,
        big value, progress bar, bottom action."""
        if not self._begin("adjust"):
            return
        self._top_bar(title)
        self.fb.big(hero, self.CX, 27, scale=3)
        self._hbar(max(0.0, min(1.0, frac)))
        self._bottom_bar(action=action)
        self.paint("adjust")

    def show_saved(self, layer_name, key_no, t):
        if not self._begin("saved"):
            return
        self._top_bar("%s > K%d" % (layer_name.upper(), key_no))
        # The tick used to be two hand-plotted lines in a throwaway Bitmap.
        # It is a font glyph now (U+2713), so it costs one blit.
        self.fb.big("✓", self.CX, 30, scale=3)
        self.fb.big(fmt_speed(t), self.CX, 54, scale=2)
        self.paint("saved")

    def show_toast(self, title, line1, line2=""):
        """Short informational screen (read-only drive, missing macro...)."""
        if not self._begin("toast"):
            return
        self._top_bar(title)
        self.fb.text(line1, self.CX, 30)
        if line2:
            self.fb.text(line2, self.CX, 42)
        self.paint("toast")

    def show_about(self, rows):
        """Device info screen: a title bar over left-aligned label: value
        rows (model, firmware, device id)."""
        if not self._begin("about"):
            return
        self._top_bar(tr("about_title"))
        y = 19
        for label_s, value_s in rows:
            self.fb.text("%s:" % label_s, 4, y, anchor=0.0)
            self.fb.text(value_s, self.W - 4, y, anchor=1.0)
            y += 11
        self._bottom_bar(action=None)
        self.paint("about")

    def show_menu(self, title, items, sel, marked=None, action=None, hold=None):
        """Generic list menu (Settings, wheel menu). marked = index tagged
        with >. Longer lists scroll: the selection stays visible and small
        arrows on the right show there are items above/below.

        This is the screen issue #39 was about — every detent rebuilt five
        Labels, and a build that hit MemoryError left the PREVIOUS screen on
        the glass, so the wheel looked stuck at the row it opened on while the
        selection moved invisibly underneath. There is nothing left to
        allocate here, so there is nothing left to fail."""
        if not self._begin("menu"):
            return
        self._top_bar(title, hint=hold)
        n = len(items)
        top = sel - self.MENU_VIS + 1 if sel >= self.MENU_VIS else 0
        # keep the arrow strip clear of the selection rectangle
        rw = self.W - 8 if n > self.MENU_VIS else self.W
        for row in range(min(self.MENU_VIS, n)):
            i = top + row
            y = MENU_TOP + row * ROW_H
            on = i == sel
            if on:
                self.fb.rect(0, y - 4, rw, ROW_H)
            text = items[i] if marked is None else (
                "%s %s" % (">" if i == marked else " ", items[i]))
            self.fb.text(self.font.fit(str(text), rw - 4), self.CX, y, invert=on)
        if top > 0:
            self.fb.tri(self.W - 7, BAR_H + 2, 7, 4, down=False)
        if top + self.MENU_VIS < n:
            self.fb.tri(self.W - 7, BOT_SEP - 6, 7, 4, down=True)
        self._bottom_bar(action=action or tr("select"))
        self.paint("menu")

    def show_timeout(self, sec, lo, hi):
        if not self._begin("timeout"):
            return
        self._top_bar(tr("auto_return_title"))
        self.fb.big("%ds" % sec, self.CX, 27, scale=3)
        self._hbar((sec - lo) / float(hi - lo))
        self._bottom_bar(action=tr("save"))
        self.paint("timeout")

    def show_host(self):
        if not self._begin("host"):
            return
        self._top_bar("MKYADA")
        self.fb.text(tr("host"), self.CX, 34)
        self.paint("host")

    def show_headless(self):
        """The menu module could not load (import/compile/MemoryError). Keys
        and serial still work; show why instead of leaving the boot 'loading'
        splash frozen, which reads as a brick."""
        if not self._begin("headless"):
            return
        self._top_bar("MKYADA")
        self.fb.text(tr("menu_fail"), self.CX, 30)
        self.fb.text(tr("menu_fail_hint"), self.CX, 44)
        self.paint("headless")

    def show_error(self, msg):
        if not self._begin("error"):
            return
        self._top_bar("MKYADA")
        self.fb.text(tr("err_title"), self.CX, 26)
        msg = str(msg)
        self.fb.text(self.font.fit(msg, self.W - 4), self.CX, 40)
        rest = msg[len(self.font.fit(msg, self.W - 4)):]
        if rest:
            self.fb.text(self.font.fit(rest, self.W - 4), self.CX, 50)
        self.paint("error")

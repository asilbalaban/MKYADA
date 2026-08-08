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
#
# ── COORDINATES ───────────────────────────────────────────────────────────
# Every y below is the TOP of the glyph box, which is how docs/simulator.html
# (and the design source behind it) anchors text. Fb.text defaults to treating
# y as the cap centre, so the two helpers _txt/_hero convert once and the
# screens read exactly like the simulator, number for number. If a screen ever
# looks a few pixels off, that conversion is the first thing to check.

import time

import displayio

from mkyada.font import Fb, Font
from mkyada.i18n import tr, upper

FONT_PATH = "/fonts/mkyada.fnt"
INIT_TRIES = 3

BAR_H = 9          # inverted title strip (the design's bar(), not the old 11)
ROW_H = 13         # list row pitch
ROW_TOP = 12       # first list row
VIS = 4            # list rows that fit
SB_X = 125         # scrollbar column
SB_Y = 11
SB_H = 52
# Boot and firmware-update share one progress bar: same size, same place, so
# the two "the keypad is busy with itself" screens read as one thing.
PBAR_Y = 43
PBAR_H = 8
PBAR_FOOT = 53
# Grid tiles. Columns are 41px with a 2px gutter, which is what leaves the
# dividers out of the picture entirely — a tile can clear its own box without
# ever touching its neighbour or the chrome.
TILE_X = (0, 43, 86)
TILE_W = 41
HERO_SCALE = 3


def fmt_speed(t):
    return "%.1fx" % (t / 10)


def fmt_hero(t):
    v = t / 10
    return ("%d" % v) if v >= 10 else ("%.1f" % v)


def fmt_bytes(done, total):
    if total:
        return "%.1f / %.1f KB" % (done / 1024.0, total / 1024.0)
    return "%.1f KB" % (done / 1024.0)


class Oled:
    MENU_VIS = VIS   # ui.py reads this to page its lists
    # Shown on the boot splash. app.py fills it in from /VERSION before the
    # first frame; a class attribute so a harness that builds an Oled without
    # running __init__ (tests/oled_render_test.py) still finds it.
    fw = ""

    def __init__(self, cfg):
        self.display = None
        self.fb = None
        self.font = None
        self._last = None   # key of the screen currently on the glass
        self._cells = None  # per-tile cache for the grid
        self._menu = None   # (chrome, rows) cache for the lists
        self._chrome = None # grid chrome signature (band/page/state)
        self._emod = None   # per-tile cache for the Dial module
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

    # --- coordinate helpers ------------------------------------------------
    def _txt(self, s, x, y, anchor=0.5, invert=False):
        """Text with y = TOP of the glyph box."""
        self.fb.text(s, x, y, anchor, invert, False)

    def _hero(self, s, x, y, scale=2, anchor=0.5, c=1, fit=None):
        """Scaled text with y = TOP of the glyph box.

        `fit` is the room the hero has, in SCREEN pixels. It is applied here
        rather than at the call sites because it has to be measured against the
        SCALED advance: four screens passed the full 124 to font.fit() and then
        drew the result at 2x or 3x, so a long macro name ran off both edges of
        the glass instead of being cut."""
        if fit is not None:
            s = self.font.fit(str(s), fit // scale)
        self.fb.big(s, x, y + (7 * scale) // 2, scale, anchor, c)

    def _dots(self, y, n, sel):
        """Position dots. The selected one is a 3x3 square, the rest single
        pixels — three rects for the whole row instead of n circle objects."""
        x0 = self.CX - (n * 8 - 8) // 2 - 1
        for i in range(n):
            x = x0 + i * 8
            if i == sel:
                self.fb.rect(x, y, 3, 3)
            else:
                self.fb.rect(x + 1, y + 1, 1, 1)

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

    # --- chrome ------------------------------------------------------------
    def _bar9(self, left, right=None):
        """The design's bar(): 9px inverted strip, title left, optional label
        right."""
        fb = self.fb
        fb.rect(0, 0, self.W, BAR_H)
        self._txt(left, 2, 1, 0.0, True)
        if right:
            self._txt(right, self.W - 2, 1, 1.0, True)

    def _hdr9(self, title, hint=None):
        """The design's hdr(): back chevron, title, hairline at y=9. The old
        bottom bar is gone in this design, so the action / "hold" hint moved up
        here — which is what buys the list its fourth row back at 13px pitch."""
        from mkyada import icons
        fb = self.fb
        fb.icon(1, 1, icons.get("chevron-left"))
        rw = 0
        if hint:
            s = self.font.fit(str(hint), 52)
            rw = self.font.measure(s) + 3
            self._txt(s, self.W - 2, 1, 1.0)
        self._txt(self.font.fit(str(title), 115 - rw), 11, 1, 0.0)
        fb.hline(0, 9, self.W)

    def _badge(self, s):
        """The corner badge on the editors: a carved box with lit text. Width
        follows the text — the design's was a fixed 29px because it always said
        "EDIT", and ours says SEC / SN / SPEED."""
        t = self.font.fit(str(s), 44)
        w = self.font.measure(t) + 6
        x = self.W - 2 - w
        self.fb.rfill(x, 1, w, 7, 0, 1)
        self._txt(t, x + 3, 1, 0.0)

    def _pbar(self, frac, c):
        """The progress bar boot and update share. c is 0 on boot (an inverted
        field, so it is carved) and 1 on update."""
        p = min(1.0, max(0.0, frac))
        self.fb.frame(4, PBAR_Y, 120, PBAR_H, c)
        self.fb.rect(6, PBAR_Y + 2, int(116 * p), PBAR_H - 4, c)

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
            self._chrome = None
        if key != "menu":
            self._menu = None
        if key != "encmod":
            self._emod = None
        self.fb.clear()
        return True

    # --- screens -----------------------------------------------------------
    def show_boot(self, frac=0.0):
        """Inverted splash: the whole panel lights and everything is carved out
        of it. Up before the heavy imports run, and the phase line under the
        wordmark says which third of the boot we are in."""
        if not self.display:
            return
        self._cells = None
        self._menu = None
        p = min(1.0, max(0.0, frac))
        fb = self.fb
        fb.fill(1)
        self._hero("MKYADA", self.CX, 11, 2, 0.5, 0)
        fb.hline(29, 29, 70, 0)
        phase = tr("boot_disp") if p < 0.33 else (
            tr("boot_cfg") if p < 0.66 else tr("boot_hid"))
        self._txt(phase, self.CX, 34, 0.5, True)
        self._pbar(p, 0)
        self._txt("RP2040", 4, PBAR_FOOT, 0.0, True)
        if self.fw:
            self._txt(self.fw, self.W - 4, PBAR_FOOT, 1.0, True)
        self.paint("boot")

    def boot_progress(self, frac):
        """Redraw just the bar and the phase line while the boot advances."""
        if not self.display or self._last != "boot":
            return
        self.show_boot(frac)

    def show_update(self, frac, restarting=False, done=0, total=0):
        """Locked firmware-update screen. Where the design source showed
        '1.3.0 > 1.4.0' we show a byte counter instead: update_begin carries
        the total size and nothing else, so a version line would be invented."""
        if not self._begin("update"):
            return
        p = min(1.0, max(0.0, frac))
        fb = self.fb
        self._bar9(tr("update_title"))
        fb.rect(0, 12, self.W, 11)
        self._txt(tr("updating2"), self.CX, 14, 0.5, True)
        self._txt(tr("restarting") if restarting else fmt_bytes(done, total),
                  self.CX, 29)
        self._pbar(p, 1)
        self._txt(tr("updating"), 4, PBAR_FOOT, 0.0)
        self._txt("%d%%" % int(p * 100), self.W - 4, PBAR_FOOT, 1.0)
        self.paint("update")

    def show_transfer(self):
        """The app is reading or writing files: the keypad is held still for
        the duration, so say so.

        Sibling of show_update on purpose — both are screens the keypad cannot
        be used from, and the inverted strip is what the two have in common.
        No progress bar: a save is a run of independent file transfers and the
        app never says how many, so a bar here would be invented. Painted once
        on the way in and once on the way out; every repaint in between is
        300ms of a USB FIFO nobody is draining, which is a corrupted chunk."""
        if not self._begin("transfer"):
            return
        from mkyada import icons
        fb = self.fb
        self._bar9(tr("transfer_title"))
        fb.rect(0, 12, self.W, 11)
        self._txt(tr("transfer2"), self.CX, 14, 0.5, True)
        fb.icon2(self.CX - 8, 30, icons.get("database"))
        self._txt(tr("transfer"), self.CX, 50, 0.5)
        self.paint("transfer")

    def show_settings(self, title, items, sel):
        """Settings list. items = [(label, kind, value)] where kind is
        "text" | "toggle" | "none" — the state used to be baked into the label
        ("Layer band: on"); it is a column of its own now."""
        if not self.display:
            return
        fb = self.fb
        n = len(items)
        top = min(sel - VIS + 1, max(0, n - VIS)) if sel >= VIS else 0
        chrome = (title, top, n)
        want = []
        for i in range(VIS):
            idx = top + i
            if idx >= n:
                break
            label, kind, value = items[idx]
            want.append((self.font.fit(label, 95), kind, value, idx == sel))
        fresh = self._last != "menu" or self._menu is None or \
            self._menu[0] != chrome
        if fresh:
            self._begin("menu")
            self._hdr9(title)
            th = max(8, (SB_H * VIS + n // 2) // n) if n else SB_H
            ty = SB_Y + ((SB_H - th) * top) // max(1, n - VIS)
            fb.sbarv(SB_X, SB_Y, SB_H, ty, th)
            was = None
        else:
            was = self._menu[1]
        for i in range(len(want)):
            w = want[i]
            if was is not None and i < len(was) and was[i] == w:
                continue
            y = ROW_TOP + i * ROW_H
            on = w[3]
            fb.rect(0, y, 124, 12, 1 if on else 0)
            self._txt(w[0], 4, y + 3, 0.0, on)
            if w[1] == "toggle":
                fb.sw(103, y + 2, w[2], 0 if on else 1)
            elif w[1] == "text":
                self._txt(str(w[2]), 120, y + 3, 1.0, on)
        self._menu = (chrome, want)
        self.paint("menu")

    def show_menu(self, title, items, sel, marked=None, action=None, hold=None):
        """Generic list — language, wheel menus, host lists. Same frame as the
        settings list. The device's old ">" marker for the assigned option is a
        tick icon on the right now, so the label stays left-aligned."""
        if not self.display:
            return
        from mkyada import icons
        fb = self.fb
        n = len(items)
        top = min(sel - VIS + 1, max(0, n - VIS)) if sel >= VIS else 0
        hint = hold or action or None
        chrome = (title, hint, top, n, marked)
        wide = 115 if marked is None else 95
        want = []
        for i in range(VIS):
            idx = top + i
            if idx >= n:
                break
            want.append((self.font.fit(str(items[idx]), wide),
                         idx == sel, idx == marked))
        fresh = self._last != "menu" or self._menu is None or \
            self._menu[0] != chrome
        if fresh:
            self._begin("menu")
            self._hdr9(title, hint)
            if n > VIS:
                th = max(8, (SB_H * VIS + n // 2) // n)
                ty = SB_Y + ((SB_H - th) * top) // max(1, n - VIS)
                fb.sbarv(SB_X, SB_Y, SB_H, ty, th)
            was = None
        else:
            was = self._menu[1]
        tick = icons.get("check")
        for i in range(len(want)):
            w = want[i]
            if was is not None and i < len(was) and was[i] == w:
                continue
            y = ROW_TOP + i * ROW_H
            on = w[1]
            fb.rect(0, y, 124, 12, 1 if on else 0)
            self._txt(w[0], 4, y + 3, 0.0, on)
            if w[2]:
                fb.icon(112, y + 2, tick, 0 if on else 1)
        self._menu = (chrome, want)
        self.paint("menu")

    def show_speed(self, layer_name, key_no, t, lo=1, hi=100):
        """Speed editor: badged title, hero number, 15 segments, the range at
        the bottom."""
        from mkyada import icons
        if not self._begin("speed"):
            return
        fb = self.fb
        fb.rect(0, 0, self.W, BAR_H)
        fb.icon(1, 1, icons.get("chevron-left"), 0)
        self._txt("%s > K%d" % (upper(layer_name), key_no), 11, 1, 0.0, True)
        self._badge(upper(tr("speed")))
        self._hero(fmt_hero(t), self.CX, 13, HERO_SCALE)
        fb.segbar(4, 38, 120, 10, 15, max(1, (t * 15 + hi // 2) // hi))
        self._txt(fmt_hero(lo), 4, 52, 0.0)
        self._txt(tr("save"), self.CX, 52)
        self._txt(fmt_hero(hi), self.W - 4, 52, 1.0)
        self.paint("speed")

    def show_timeout(self, sec, lo, hi):
        """Auto-return editor: hero + unit, a centre sight, and a notched ruler
        that slides with the value."""
        from mkyada import icons
        if not self._begin("timeout"):
            return
        fb = self.fb
        f = self.font
        fb.rect(0, 0, self.W, BAR_H)
        fb.icon(1, 1, icons.get("chevron-left"), 0)
        self._txt(tr("auto_return_title"), 11, 1, 0.0, True)
        unit = tr("sec_unit")
        self._badge(unit)
        bv = str(sec)
        bw = f.measure(bv) * HERO_SCALE
        gx = (self.W - (bw + 4 + f.measure(unit))) // 2
        self._hero(bv, gx, 13, HERO_SCALE, 0)
        self._txt(unit, gx + bw + 4, 27, 0.0)
        fb.rect(64, 39, 1, 1)
        fb.rect(63, 40, 3, 1)
        fb.rect(62, 41, 5, 1)
        off = (sec * 2) % 18
        major = (sec * 2 // 18) * 3
        for i in range(-1, 24):
            x = 4 + i * 6 - off
            if x < 1 or x > 126:
                continue
            maj = (i + major) % 3 == 0
            fb.vline(x, 44 if maj else 48, 8 if maj else 4)
        fb.hline(0, 52, self.W)
        self._txt(tr("save"), self.CX, 55)
        self.paint("timeout")

    def _grid_bar(self, band, page, st):
        """The grid's band. The design source hangs its indicators off the
        right edge, so ours do too: page position, then the LIVE chip, then the
        blinking record dot with a steady REC beside it. The layer/profile text
        takes whatever is left. Recording used to be "(R)" inside that text —
        the dot reads at a glance, the text did not."""
        fb = self.fb
        f = self.font
        fb.rect(0, 0, self.W, BAR_H)
        rx = self.W - 2
        if page:
            s = "%d/%d" % (page[0] + 1, page[1])
            self._txt(s, rx, 1, 1.0, True)
            rx -= f.measure(s) + 4
        if st and st[1]:
            lab = upper(tr("live_t"))
            w = f.measure(lab) + 6
            x = rx - w + 1
            fb.rfill(x, 1, w, 7, 0, 1)
            self._txt(lab, x + 3, 1, 0.0)
            rx = x - 3
        if st and st[0]:
            lab = upper(tr("rec_t"))
            self._txt(lab, rx, 1, 1.0, True)
            rx -= f.measure(lab) + 3
            if st[2]:
                fb.rect(rx - 4, 3, 4, 4, 0)
            rx -= 7
        if band:
            self._txt(f.fit(str(band), max(0, rx - 3)), 2, 1, 0.0, True)

    def show_grid(self, labels, active, invert=True, band=None, icons_=None,
                  page=None, st=None):
        """3x2 macro grid. Rounded tiles with a 2px gutter, the selected one
        filled; the action icon sits above the name.

        page = (sel, n) turns on wheel paging: the band gets a position, a dot
        row appears at y=60 and the tiles are the design's 23px. Without it the
        dot row's 5px go back to the tiles (25px each).

        Only the tiles whose content changed are redrawn, and a tile clears
        just its own box — the gutter means it can never eat a neighbour or the
        chrome, so moving the selection pushes two tiles instead of 64 rows."""
        if not self.display:
            return
        fb = self.fb
        f = self.font
        has_st = bool(st and (st[0] or st[1]))
        # The bar follows the BAND, not the paging. With the layer band off
        # there is nothing worth spending a 9px strip on, and the page counter
        # goes with it — the dot row already says which page you are on. The
        # tiles take the space instead, which is the whole point of turning the
        # band off. A live REC/LIVE marker still earns the strip on its own.
        bar = bool(band) or has_st
        top = 11 if bar else 2
        bot = 59 if page else 62   # the dot row owns 59..63
        h = (bot - top - 1) // 2
        block = 2 * h + 1
        ytop = top + (bot - top - block) // 2
        pad = (h - 23) // 2
        chrome = (bar, h, ytop, band, page, st)
        fresh = self._last != "grid" or self._cells is None or \
            self._chrome != chrome
        if fresh:
            fb.clear()
            self._cells = [None] * 6
            self._chrome = chrome
            if bar:
                self._grid_bar(band, page if band else None, st)
            if page:
                self._dots(60, page[1], page[0])
        for k in range(6):
            pair = labels[k] if k < len(labels) else ("", "")
            art = icons_[k] if icons_ and k < len(icons_) else None
            on = k == active and invert
            want = (pair[0] or "", pair[1] or "", art, on)
            if self._cells[k] == want:
                continue
            self._cells[k] = want
            x = TILE_X[k % 3]
            y = ytop + (k // 3) * (h + 1)
            # Clear the tile's own box only. Everything outside it — gutter,
            # band, dot row — is chrome drawn once.
            fb.rect(x, y, TILE_W, h, 0)
            if on:
                fb.rfill(x, y, TILE_W, h, 1, 0)
            else:
                fb.rframe(x, y, TILE_W, h, 1)
            mid = x + 20
            if want[1]:
                # The design's tiles hold one-line constants; ours hold user
                # macro names. An icon plus two lines does not fit in 23px, so
                # a name that needs two lines drops the icon and stays whole —
                # the other way round would cut the name.
                self._txt(f.fit(want[0], 37), mid, y + 4 + pad, 0.5, on)
                self._txt(f.fit(want[1], 37), mid, y + 12 + pad, 0.5, on)
            elif art:
                fb.icon(x + 17, y + 4 + pad, art, 0 if on else 1)
                self._txt(f.fit(want[0], 37), mid, y + 14 + pad, 0.5, on)
            else:
                self._txt(f.fit(want[0], 37), mid, y + 8 + pad, 0.5, on)
        self.paint("grid")

    def show_encmod(self, name, labels, sel):
        """Dial module: title strip + a 3x2 tile map of the six slots,
        mirroring the physical key layout the way the grid does. The filled
        tile is the slot the wheel drives; a key press moves it. An empty
        slot is a bare dash — that key is dead while the module is open.

        Same repaint contract as the grid: only tiles whose content changed
        are redrawn, so hopping slots while a color wheel is live costs two
        tiles, never a full frame."""
        if not self.display:
            return
        fb = self.fb
        f = self.font
        fresh = self._last != "encmod" or self._emod is None
        if fresh:
            fb.clear()
            self._emod = [None] * 6
            self._bar9(f.fit(upper(name), 86), "DIAL")
        top = 11
        h = 25
        for k in range(6):
            lab = labels[k] if k < len(labels) else None
            want = (lab, k == sel)
            if self._emod[k] == want:
                continue
            self._emod[k] = want
            x = TILE_X[k % 3]
            y = top + (k // 3) * (h + 1)
            fb.rect(x, y, TILE_W, h, 0)
            mid = x + TILE_W // 2 + 1
            ty = y + (h - 7) // 2
            if lab is None:
                self._txt("-", mid, ty, 0.5, False)
            elif want[1]:
                fb.rfill(x, y, TILE_W, h, 1, 0)
                self._txt(f.fit(lab, 37), mid, ty, 0.5, True)
            else:
                fb.rframe(x, y, TILE_W, h, 1)
                self._txt(f.fit(lab, 37), mid, ty, 0.5, False)
        self.paint("encmod")

    def update_band(self, band, page=None, st=None):
        """Repaint ONLY the band on the live grid. The record dot blinks twice
        a second and the OBS scene changes on every switch; driving those
        through a full show_grid used to allocate a label set each time.
        Returns False when the caller has to fall back to a full paint."""
        if not self.display or self._last != "grid" or self._chrome is None:
            return False
        if not self._chrome[0]:
            return False
        page = page if band else None   # the counter rides with the band
        self._grid_bar(band, page, st)
        self._chrome = self._chrome[:3] + (band, page, st)
        self.paint("grid")
        return True

    def show_home(self, pos, layer_count, layer_names, nick=None, active=False):
        """Layer picker: arrows either side, a 2x letter, the layer's name
        under it when it has one, position dots at the bottom.

        The design source puts a 2x icon above the letter; it is dropped here
        because on this device the letter IS the layer — the icon added no
        information. The hero sits at the same y on every page so neither it
        nor the arrows jump as the wheel moves through them."""
        from mkyada import icons
        if not self._begin("home"):
            return
        fb = self.fb
        n = layer_count + 1
        self._bar9(tr("menu_t"), "%d/%d" % (pos + 1, n))
        is_set = pos >= layer_count
        hero = tr("settings") if is_set else upper(layer_names[pos])
        sub = "" if is_set else (nick or (upper(tr("on")) if active else ""))
        if pos > 0:
            fb.icon(1, 26, icons.get("chevron-left"))
        if not is_set:
            fb.icon(self.W - 9, 26, icons.get("chevron-right"))
        # The arrows own the outer 11px on each side; the hero gets the rest.
        self._hero(hero, self.CX, 23, 2, fit=106)
        if sub:
            self._txt(sub, self.CX, 42)
        self._dots(57, n, pos)
        self.paint("home")

    def show_keytest(self, s):
        """All six keys at once with a press counter each, wheel and module
        buttons underneath. The old screen showed one control at a time, so
        finding the silent key meant pressing them in turn."""
        if not self._begin("keytest"):
            return
        fb = self.fb
        self._bar9(tr("keys_test"), tr("hold_exit"))
        for k in range(6):
            x = TILE_X[k % 3]
            y = 11 + (k // 3) * 16
            on = s["last"] == k
            if on:
                fb.rfill(x, y, TILE_W, 15, 1, 0)
            else:
                fb.rframe(x, y, TILE_W, 15, 1)
            self._txt("K%d" % (k + 1), x + 3, y + 4, 0.0, on)
            self._txt(str(s["cnt"][k]), x + 38, y + 4, 1.0, on)
        fb.hline(0, 44, self.W)
        enc = s["enc"]
        self._txt("ENC %s%d" % ("+" if enc >= 0 else "", enc), 3, 46, 0.0)
        self._txt("PSH %d" % s["nav"][0], self.W - 2, 46, 1.0)
        self._txt("BACK %d" % s["nav"][1], 3, 55, 0.0)
        self._txt("CONFIRM %d" % s["nav"][2], self.W - 2, 55, 1.0)
        self.paint("keytest")

    def show_pixels(self):
        """Every pixel lit. A dead column or a stuck row is invisible on a
        normal screen — most of it is dark anyway — but obvious against a solid
        field. Any button leaves, so there is no way to get stuck here."""
        if not self._begin("pixels"):
            return
        self.fb.fill(1)
        self.paint("pixels")

    def show_about(self, rows):
        """Device info: a 9px title over label/value rows at 10px pitch."""
        if not self._begin("about"):
            return
        for i in range(min(len(rows), 5)):
            y = 11 + i * 10
            self._txt(rows[i][0], 3, y + 2, 0.0)
            self._txt(self.font.fit(str(rows[i][1]), 86), self.W - 2, y + 2, 1.0)
        self._bar9(tr("about_title"))
        self.paint("about")

    # The overlay box. It was 34px at y=16, which is where the toast's third
    # line ended one pixel off the bottom border — the letters read as sitting
    # ON the frame — while 14 rows of screen went unused underneath. 44px
    # centred gives every line room and leaves an even margin top and bottom.
    # The icon lands at y=24 either way, so it did not move.
    DLG_Y = 10
    DLG_H = 44

    def _dialog(self, art, ok=True):
        """The dithered backdrop plus the rounded box both overlays sit in."""
        fb = self.fb
        y, h = self.DLG_Y, self.DLG_H
        fb.dither()
        fb.rfill(8, y, 112, h, 0)
        fb.rframe(8, y, 112, h, 1)
        fb.icon2(14, y + (h - 16) // 2, art)

    def show_saved(self, layer_name, key_no, t):
        if not self.display:
            return
        from mkyada import icons
        self._cells = None
        self._menu = None
        self._dialog(icons.get("check"))
        self._hero(upper(tr("save")), 34, 19, 2, 0.0, fit=90)
        self._txt(self.font.fit(
            "%s > K%d  %s" % (upper(layer_name), key_no, fmt_speed(t)), 84),
            34, 36, 0.0)
        self.paint("saved")

    def show_toast(self, title, line1="", line2="", ok=False):
        """Same box, but a toast has three pieces and our glyph box is a row
        taller than the design's — a 2x title plus two lines does not fit in
        34px, so all three are one scale."""
        if not self.display:
            return
        from mkyada import icons
        self._cells = None
        self._menu = None
        self._dialog(icons.get("check") if ok else icons.get("warning"))
        f = self.font
        # 11px pitch, so three lines sit evenly instead of the old 22/32/41
        # bunching them toward the frame.
        self._txt(f.fit(title, 84), 34, 18, 0.0)
        if line1:
            self._txt(f.fit(line1, 84), 34, 29, 0.0)
        if line2:
            self._txt(f.fit(line2, 84), 34, 40, 0.0)
        self.paint("toast")

    def show_card(self, title, big, line=None, hint=None):
        """Action card for the wheel menu: 9px bar, a 2x hero, an optional
        status line, and the design's plain hint row instead of a filled bar."""
        if not self._begin("card"):
            return
        f = self.font
        self._bar9(title)
        hy = 20 if line else 25
        self._hero(str(big or ""), self.CX, hy, 2, fit=124)
        if line:
            self._txt(f.fit(str(line), 124), self.CX, 38)
        if hint:
            self._txt(f.fit(str(hint), 124), self.CX, 56)
        self.paint("card")

    def show_adjust(self, title, hero, frac, action=None):
        """Host-driven slider — the speed editor's frame. No min/max labels:
        the protocol does not carry them for a slider."""
        from mkyada import icons
        if not self._begin("adjust"):
            return
        fb = self.fb
        f = self.font
        p = max(0.0, min(1.0, frac))
        fb.rect(0, 0, self.W, BAR_H)
        fb.icon(1, 1, icons.get("chevron-left"), 0)
        self._txt(f.fit(str(title), 80), 11, 1, 0.0, True)
        if action:
            self._badge(upper(action))
        self._hero(str(hero), self.CX, 13, HERO_SCALE, fit=124)
        fb.segbar(4, 38, 120, 10, 15, max(1, int(p * 15 + 0.5)))
        self._txt(tr("back"), 4, 52, 0.0)
        self._txt("%d%%" % int(p * 100 + 0.5), self.W - 4, 52, 1.0)
        self.paint("adjust")

    def show_obsrec(self, o):
        """OBS record card. The bar is the design's recorder strip: a blinking
        dot with a steady REC beside it on the left, the key on the right."""
        if not self._begin("obsrec"):
            return
        fb = self.fb
        f = self.font
        fb.rect(0, 0, self.W, BAR_H)
        if o.get("rec"):
            if o.get("blink"):
                fb.rect(3, 3, 4, 4, 0)
            self._txt(upper(tr("rec_t")), 10, 1, 0.0, True)
        else:
            self._txt(upper(tr("idle_t")), 3, 1, 0.0, True)
        if o.get("key"):
            self._txt("%s %d" % (upper(tr("key_t")), o["key"]),
                      self.W - 2, 1, 1.0, True)
        self._hero(str(o.get("time") or "00:00"), self.CX, 16, 2, fit=124)
        if o.get("scene"):
            self._txt(f.fit(str(o["scene"]), 124), self.CX, 36)
        if o.get("hint"):
            self._txt(f.fit(str(o["hint"]), 124), self.CX, 56)
        self.paint("obsrec")

    def show_obs(self, o):
        """OBS status screen: a state chip top right, the elapsed time, the
        scene as a pill and the mic level as segments. The design source ends
        with a CPU / DROP / FPS row; we do not have those numbers, so that row
        carries the action hint instead."""
        if not self._begin("obs"):
            return
        fb = self.fb
        f = self.font
        fb.rect(0, 0, self.W, BAR_H)
        self._txt("OBS", 2, 1, 0.0, True)
        rec = bool(o.get("rec"))
        lab = upper(tr("rec_t")) if rec else (
            upper(tr("live_t")) if o.get("live") else upper(tr("idle_t")))
        dot = 5 if rec else 0
        bw = f.measure(lab) + 6 + dot
        bx = self.W - 2 - bw
        fb.rfill(bx, 1, bw, 7, 0, 1)
        if rec and o.get("blink"):
            fb.rect(bx + 3, 3, 3, 3)
        self._txt(lab, bx + 3 + dot, 1, 0.0)
        self._hero(str(o.get("time") or "00:00"), self.CX, 12, 2, fit=124)
        # Turkish labels are wider, so the pill and the segment bar start after
        # the label instead of at the design's fixed x.
        sl = upper(tr("scene_t"))
        sx = max(38, 2 + f.measure(sl) + 4)
        self._txt(sl, 2, 30, 0.0)
        sn = f.fit(str(o.get("scene") or ""), self.W - sx - 6)
        fb.rfill(sx, 29, f.measure(sn) + 6, 9, 1)
        self._txt(sn, sx + 3, 30, 0.0, True)
        ml = upper(tr("mic_t"))
        mx = max(24, 2 + f.measure(ml) + 4)
        self._txt(ml, 2, 42, 0.0)
        fb.segbar(mx, 42, self.W - 6 - mx, 7, 14,
                  max(0, int(o.get("mic", 0) * 14 / 100 + 0.5)))
        fb.hline(0, 51, self.W)
        if o.get("hint"):
            self._txt(f.fit(str(o["hint"]), 124), self.CX, 54)
        self.paint("obs")

    def show_obscenter(self, o):
        """OBS Center dashboard (proto v13). Every widget is optional — a
        None field means the app turned it off — and the enabled ones reflow
        top-down, vertically centred in whatever room the quick-key row
        leaves. The timer drops from 2x to 1x only when the stack would not
        fit, which is the everything-on + six-labels case."""
        if not self._begin("obscenter"):
            return
        fb = self.fb
        f = self.font
        fb.rect(0, 0, self.W, BAR_H)
        self._txt("OBS", 2, 1, 0.0, True)
        rec = o.get("rec")
        live = o.get("live")
        if rec is not None or live is not None:
            lab = upper(tr("rec_t")) if rec else (
                upper(tr("live_t")) if live else upper(tr("idle_t")))
            dot = 5 if rec else 0
            bw = f.measure(lab) + 6 + dot
            bx = self.W - 2 - bw
            fb.rfill(bx, 1, bw, 7, 0, 1)
            if rec and o.get("blink"):
                fb.rect(bx + 3, 3, 3, 3)
            self._txt(lab, bx + 3 + dot, 1, 0.0)
        t = o.get("time")
        sc = o.get("scene")
        mic = o.get("mic")
        cpu = o.get("cpu")
        fps = o.get("fps")
        drop = o.get("drop")
        health = cpu is not None or fps is not None or drop is not None
        kl = o.get("klabels")
        bot = 50 if kl is not None else 62
        avail = bot - 11
        th = 16
        total = ((th + 2) if t is not None else 0) \
            + (11 if sc is not None else 0) \
            + (9 if mic is not None else 0) \
            + (10 if health else 0)
        if total:
            total -= 2  # no gap after the last widget
        if t is not None and total > avail:
            total -= 8
            th = 8
        y = 11 + max(0, (avail - total) // 2)
        if t is not None:
            if th == 16:
                self._hero(str(t or "00:00"), self.CX, y, 2, fit=124)
            else:
                self._txt(f.fit(str(t or "00:00"), 124), self.CX, y)
            y += th + 2
        focus = o.get("focus")
        if sc is not None:
            sl = upper(tr("scene_t"))
            sx = max(38, 2 + f.measure(sl) + 4)
            self._txt(sl, 2, y + 1, 0.0)
            if focus == "scene":
                # the wheel drives this row now: a frame around its label
                fb.frame(0, y, f.measure(sl) + 5, 9)
            sn = f.fit(str(sc), self.W - sx - 6)
            fb.rfill(sx, y, f.measure(sn) + 6, 9, 1)
            self._txt(sn, sx + 3, y + 1, 0.0, True)
            y += 11
        if mic is not None:
            ml = upper(tr("mic_t"))
            mx = max(24, 2 + f.measure(ml) + 4)
            if o.get("mute"):
                # muted = the label itself lights up as a solid block
                fb.rect(0, y, f.measure(ml) + 4, 7)
                self._txt(ml, 2, y, 0.0, True)
            else:
                self._txt(ml, 2, y, 0.0)
            if focus == "mic":
                # sits 1px proud of the row so it reads over a muted block
                fb.frame(0, y - 1, f.measure(ml) + 6, 9)
            fb.segbar(mx, y, self.W - 6 - mx, 7, 14,
                      max(0, int(mic * 14 / 100 + 0.5)))
            y += 9
        if health:
            if cpu is not None:
                self._txt("CPU %d%%" % cpu, 2, y, 0.0)
            if drop is not None:
                self._txt("DROP %d" % drop, self.CX, y, 0.5)
            if fps is not None:
                self._txt("%d FPS" % fps, self.W - 2, y, 1.0)
            y += 10
        if kl is not None:
            fb.hline(0, 52, self.W)
            for i in range(6):
                s = str(kl[i]) if i < len(kl) and kl[i] else ""
                if s:
                    self._txt(f.fit(s, 20), 11 + i * 21, 55, 0.5)
        self.paint("obscenter")

    def _alert(self, key, title, l1, l2=None, art=None):
        """The design's fault screen: a 2x warning icon with two lines beside
        it. Theirs sits high because an error code and a retry line follow; we
        have neither, so the block is centred between bar and bottom."""
        from mkyada import icons
        if not self._begin(key):
            return False
        fb = self.fb
        self._bar9(title)
        fb.icon2(6, 27, art or icons.get("warning"))
        self._txt(self.font.fit(str(l1 or ""), 96), 28, 29, 0.0)
        if l2:
            self._txt(self.font.fit(str(l2), 96), 28, 39, 0.0)
        return True

    def show_headless(self):
        """The menu module could not load (import/compile/MemoryError). Keys
        and serial still work; show why instead of leaving the boot splash
        frozen, which reads as a brick."""
        if self._alert("headless", "MKYADA", tr("menu_fail"),
                       tr("menu_fail_hint")):
            self.paint("headless")

    def show_error(self, msg):
        s = str(msg)
        head = self.font.fit(s, 96)
        if self._alert("error", upper(tr("err_title")), head,
                       s[len(head):] or None):
            self.paint("error")

    def show_host(self):
        """Host mode with no key names yet: the app drives the menu but has not
        said what the keys are."""
        if not self._begin("host"):
            return
        self._bar9("MKYADA")
        self._hero("HOST", self.CX, 22, 2)
        self._txt(self.font.fit(tr("host"), 124), self.CX, 44)
        self.paint("host")

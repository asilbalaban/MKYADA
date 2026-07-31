# The bitmap font MKYADA draws with, and the framebuffer it draws into.
#
# This replaces adafruit_display_text + adafruit_bitmap_font, which were the
# RP2040's biggest fragmentation source: every screen built a fresh Group of
# Labels, and each Label rasterized its glyphs onto the heap. CircuitPython's
# GC never compacts, so that churn left the heap "10KB free but shredded" —
# the state behind failed macro saves, the wedged menu wheel and the blinking
# grid labels. Here nothing is allocated after boot: one resident Bitmap for
# the screen, two resident atlases for the glyphs, and every draw is a
# bitmaptools call into memory that already exists.
#
# The .fnt format is documented in scripts/build-font.mjs, which produces it.

import displayio

import bitmaptools

MAGIC = b"MKF2"

# Last resort for characters the font doesn't draw. Turkish is NOT in here any
# more — we draw all twelve letters now — but a macro or profile name can still
# arrive carrying an accent we never designed, and dropping it silently would
# turn "Café" into "Caf". Fold what folds; everything else becomes '?', which
# at least says "a character was here".
FOLD = {
    "á": "a", "à": "a", "â": "a", "ä": "a", "å": "a", "ã": "a",
    "é": "e", "è": "e", "ê": "e", "ë": "e",
    "í": "i", "ì": "i", "î": "i", "ï": "i",
    "ó": "o", "ò": "o", "ô": "o", "õ": "o",
    "ú": "u", "ù": "u", "û": "u",
    "ñ": "n", "ý": "y", "ÿ": "y", "æ": "a", "ø": "o", "ß": "s",
    "Á": "A", "À": "A", "Â": "A", "Ä": "A", "Å": "A", "Ã": "A",
    "É": "E", "È": "E", "Ê": "E", "Ë": "E",
    "Í": "I", "Ì": "I", "Î": "I", "Ï": "I",
    "Ó": "O", "Ò": "O", "Ô": "O", "Õ": "O",
    "Ú": "U", "Ù": "U", "Û": "U",
    "Ñ": "N", "Æ": "A", "Ø": "O",
    "–": "-", "—": "-", "'": "'", "'": "'", """: '"', """: '"', "…": ".",
}


class Font:
    """The glyph atlas: every glyph laid out side by side in one Bitmap, plus
    an inverted copy.

    Two copies exist because `blit` copies source values as-is, so drawing
    black-on-white (the title bar, the selected grid cell) can't be done by
    flipping a colour — it needs a source whose glyph pixels are 0 and whose
    background is 1, blitted with skip_source_index=1 so only the glyph lands.
    The second atlas costs ~560 bytes, once, forever."""

    def __init__(self, path):
        # Read the whole file and close it immediately. The old BDF path kept
        # file handles open for the runtime (glyphs rasterized lazily from
        # disk), and FAT can't overwrite an open file — that is what made
        # firmware updates die on /fonts/spleen-5x8.bdf and what release_fonts()
        # existed to work around. 716 bytes read once removes the whole issue.
        with open(path, "rb") as f:
            data = f.read()
        if data[:4] != MAGIC:
            raise ValueError("bad font")
        self.box_w = data[4]
        self.box_h = data[5]
        self.first = data[6]
        n_ascii = data[7]
        n_extra = data[8]
        n = n_ascii + n_extra
        self.n = n
        self.last = self.first + n_ascii - 1

        off = 10
        self.adv = data[off:off + n]
        off += n
        # Turkish is scattered across Unicode (Ş is U+015E, ğ is U+011F), so
        # anything past the contiguous ASCII run is looked up in a dict built
        # once here. ASCII — the common case — stays a subtraction.
        self.extra = {}
        for i in range(n_extra):
            cp = data[off] | (data[off + 1] << 8)
            self.extra[cp] = n_ascii + i
            off += 2

        bpc = self.box_h >> 3  # bytes per column
        aw = n * self.box_w
        self.atlas = displayio.Bitmap(aw, self.box_h, 2)
        self.inv = displayio.Bitmap(aw, self.box_h, 2)
        # Fill the inverted atlas first and only punch the lit pixels out of
        # it, so the decode loop below touches each lit pixel exactly once
        # instead of every pixel twice.
        bitmaptools.fill_region(self.inv, 0, 0, aw, self.box_h, 1)
        atlas = self.atlas
        inv = self.inv
        for col in range(aw):
            base = off + col * bpc
            for b in range(bpc):
                bits = data[base + b]
                if not bits:
                    continue
                y0 = b << 3
                for bit in range(8):
                    if bits & (1 << bit):
                        atlas[col, y0 + bit] = 1
                        inv[col, y0 + bit] = 0

    def index(self, ch):
        """Glyph index for a character. Never returns -1 for a printable
        character: unknown ones fold (é -> e) and whatever is left becomes '?',
        so a name is never silently shortened on screen."""
        c = ord(ch)
        if self.first <= c <= self.last:
            return c - self.first
        i = self.extra.get(c, -1)
        if i >= 0:
            return i
        f = FOLD.get(ch)
        if f is not None:
            return ord(f) - self.first
        return 0x3F - self.first  # '?'

    # Every hot loop below inlines the ASCII case instead of calling index().
    # On the RP2040 a Python-level call costs ~90us, which was HALF the price
    # of drawing a character — the glyph blit itself is ~106us. Turkish and
    # anything foldable still go through index(); they are the rare path.

    def measure(self, s):
        """Pixel width of a string. Replaces the old fixed `maxc` character
        count — with proportional advances, 'Kamera' and 'WWWWWW' are not the
        same width, and the grid used to truncate both at 10 characters."""
        w = 0
        adv = self.adv
        first = self.first
        last = self.last
        for ch in s:
            c = ord(ch)
            w += adv[c - first if first <= c <= last else self.index(ch)]
        return w

    def fit(self, s, px):
        """The longest prefix of `s` that fits in `px` pixels."""
        w = 0
        adv = self.adv
        first = self.first
        last = self.last
        n = 0
        for ch in s:
            c = ord(ch)
            w += adv[c - first if first <= c <= last else self.index(ch)]
            if w > px:
                return s[:n]
            n += 1
        return s


class Fb:
    """The screen: one Bitmap, allocated at boot and never rebuilt.

    Every screen in oled.py is a sequence of clear/rect/text calls into this
    surface followed by one refresh(). No Groups, no Labels, no allocation per
    frame — which is the entire point of the exercise."""

    def __init__(self, w, h, font):
        self.W = w
        self.H = h
        self.CX = w // 2
        self.font = font
        self.bmp = displayio.Bitmap(w, h, 2)
        self.pal = displayio.Palette(2)
        self.pal[0] = 0x000000
        self.pal[1] = 0xFFFFFF
        self.tg = displayio.TileGrid(self.bmp, pixel_shader=self.pal)
        self.group = displayio.Group()
        self.group.append(self.tg)

    # --- primitives ---
    def clear(self):
        # Bitmap.fill is a memset; bitmaptools.fill_region is a per-pixel C
        # loop, which on this board is 9.3ms for the full screen against
        # 0.06ms — 145x, and it was the single largest line item in a repaint.
        # Measured on the board: fill() marks the whole bitmap dirty just like
        # fill_region (a push after either takes the same 78.5ms), so nothing
        # downstream can tell the difference.
        self.bmp.fill(0)

    def rect(self, x, y, w, h, c=1):
        x2 = x + w
        y2 = y + h
        if x < 0:
            x = 0
        if y < 0:
            y = 0
        if x2 > self.W:
            x2 = self.W
        if y2 > self.H:
            y2 = self.H
        if x2 > x and y2 > y:
            bitmaptools.fill_region(self.bmp, x, y, x2, y2, c)

    def hline(self, x, y, w, c=1):
        self.rect(x, y, w, 1, c)

    def vline(self, x, y, h, c=1):
        self.rect(x, y, 1, h, c)

    def tri(self, x, y, w, h, down=True, c=1):
        """Solid triangle — the menu's scroll arrows. vectorio.Polygon used to
        do this and cost an object per paint."""
        for row in range(h):
            span = w - 2 * row if down else 2 * row + 1
            if span <= 0:
                continue
            self.rect(x + (w - span) // 2, y + row, span, 1, c)

    # --- v2 chrome ---------------------------------------------------------
    # Everything below is built on rect() on purpose: no new allocation, no new
    # displayio object, and each one is a handful of fill_region calls. They are
    # the vocabulary the redesigned screens are drawn in (docs/simulator.html
    # holds the same set in JavaScript, primitive for primitive).

    def fill(self, c=1):
        """Whole screen to one value. clear() is fill(0); the boot screen is
        fill(1) with everything carved out of it."""
        self.bmp.fill(c)

    def frame(self, x, y, w, h, c=1):
        """Plain rectangle outline."""
        self.hline(x, y, w, c)
        self.hline(x, y + h - 1, w, c)
        self.vline(x, y, h, c)
        self.vline(x + w - 1, y, h, c)

    def rfill(self, x, y, w, h, c=1, bg=0):
        """Filled block with its four corner pixels punched back to `bg` — at
        this size that reads as a rounded block."""
        self.rect(x, y, w, h, c)
        self.rect(x, y, 1, 1, bg)
        self.rect(x + w - 1, y, 1, 1, bg)
        self.rect(x, y + h - 1, 1, 1, bg)
        self.rect(x + w - 1, y + h - 1, 1, 1, bg)

    def rframe(self, x, y, w, h, c=1):
        """rfill's outline: edges drawn, corners left empty."""
        self.hline(x + 1, y, w - 2, c)
        self.hline(x + 1, y + h - 1, w - 2, c)
        self.vline(x, y + 1, h - 2, c)
        self.vline(x + w - 1, y + 1, h - 2, c)

    def sw(self, x, y, on, c=1):
        """17x8 on/off switch. `c` is the drawing colour: a selected settings
        row is an inverted block, so its switch has to be carved out of it (0)
        or it disappears into the fill."""
        b = 0 if c else 1
        if on:
            self.rfill(x, y, 17, 8, c, b)
            self.rect(x + 10, y + 2, 5, 4, b)
        else:
            self.rframe(x, y, 17, 8, c)
            self.rect(x + 3, y + 2, 5, 4, c)

    def sbarv(self, x, y, h, ty, th):
        """Thin vertical scrollbar: dotted track one pixel to the right, a 3px
        wide thumb over it."""
        yy = y
        while yy < y + h:
            self.rect(x + 1, yy, 1, 1)
            yy += 2
        self.rect(x, ty, 3, th)

    def segbar(self, x, y, w, h, n, f):
        """Segmented value bar: `n` segments, the first `f` filled, the rest
        showing only their baseline."""
        step = (w + 1) // n
        sw_ = step - 1
        for i in range(n):
            sx = x + i * step
            if i < f:
                self.rect(sx, y, sw_, h)
            else:
                self.rect(sx, y + h - 1, sw_, 1)

    def icon(self, x, y, data, c=1):
        """8x8 icon from 8 packed bytes, one per row, bit 7 = leftmost pixel.
        Scanned by row and emitted as runs, the same trick big() uses: an icon
        averages ~4 runs a row instead of 8 pixel-sized fill_region calls."""
        if not data:
            return
        for row in range(8):
            bits = data[row]
            if not bits:
                continue
            run = 0
            for col in range(8):
                if bits & (0x80 >> col):
                    run += 1
                    continue
                if run:
                    self.rect(x + col - run, y + row, run, 1, c)
                    run = 0
            if run:
                self.rect(x + 8 - run, y + row, run, 1, c)

    def icon2(self, x, y, data, c=1):
        """Same icon at 2x — the dialog and alert screens."""
        if not data:
            return
        for row in range(8):
            bits = data[row]
            if not bits:
                continue
            run = 0
            for col in range(8):
                if bits & (0x80 >> col):
                    run += 1
                    continue
                if run:
                    self.rect(x + (col - run) * 2, y + row * 2, run * 2, 2, c)
                    run = 0
            if run:
                self.rect(x + (8 - run) * 2, y + row * 2, run * 2, 2, c)

    def dither(self):
        """50% checkerboard — the backdrop the saved/toast dialogs sit on, so
        the screen behind still reads as present but clearly inactive."""
        for y in range(self.H):
            x = y & 1
            while x < self.W:
                self.rect(x, y, 1, 1)
                x += 2

    # --- text ---
    def text(self, s, x, y, anchor=0.5, invert=False, vcenter=True):
        """Draw `s` with its box-left at x (anchor 0.0), centred (0.5) or
        right-aligned (1.0). y is the cap-centre when vcenter, else the box top.

        Anchoring is done here, once, in integers — the Label class used to do
        it with float anchor points and a re-layout per assignment."""
        f = self.font
        if not s:
            return x
        if anchor:
            w = f.measure(s)
            x -= int(w * anchor)
        if vcenter:
            # rows 0..6 hold the caps; centring on the cap (not the box) is
            # what keeps text optically level inside the 11px bars.
            y -= 3
        src = f.inv if invert else f.atlas
        skip = 1 if invert else 0
        bw = f.box_w
        bh = f.box_h
        adv = f.adv
        first = f.first
        last = f.last
        W = self.W
        bmp = self.bmp
        for ch in s:
            c = ord(ch)
            i = c - first if first <= c <= last else f.index(ch)
            a = adv[i]
            if x + a > 0 and x < W:
                # Narrow the SOURCE rather than relying on blit to clip a
                # destination overrun. It does clip, but a glyph straddling the
                # right edge is the exact case that used to end in an exception
                # inside a paint, and a paint that raises leaves the previous
                # screen frozen on the glass (issue #39's failure mode).
                w = bw if x + bw <= W else W - x
                bitmaptools.blit(bmp, src, x, y,
                                 x1=i * bw, y1=0, x2=i * bw + w, y2=bh,
                                 skip_source_index=skip)
            x += a
        return x

    def big(self, s, x, y, scale=2, anchor=0.5, c=1):
        """Scaled text for the hero numbers (speed, volume, the boot wordmark).

        Drawn by expanding lit pixels rather than from a pre-scaled atlas: the
        hero lines are at most a handful of characters and never on a hot path,
        so a few fill_region calls are cheaper than the ~500 bytes a second
        atlas would cost forever.

        `c` is the drawing colour. The boot screen is an inverted field, so its
        wordmark is carved out of it with c=0 rather than blitted onto it.

        Scanned by ROW, emitting one rect per run of lit pixels. Per-pixel
        rects meant ~40 fill_region calls for a two-digit hero at ~50us of call
        overhead each; a glyph's lit pixels come in horizontal runs of 3-5, so
        this is the same picture for a third of the calls."""
        f = self.font
        if not s:
            return x
        if anchor:
            x -= int(f.measure(s) * scale * anchor)
        y -= (7 * scale) // 2
        atlas = f.atlas
        bw = f.box_w
        bh = f.box_h
        adv = f.adv
        first = f.first
        last = f.last
        for ch in s:
            # NOT `c` — that is the colour parameter. Shadowing it here made
            # every rect below take a character code as its colour, which
            # fill_region rejects on a 2-value bitmap ("out of range of
            # target"), and since the boot splash is the first thing drawn the
            # whole display fell back to headless.
            cp = ord(ch)
            i = cp - first if first <= cp <= last else f.index(ch)
            gx = i * bw
            for cy in range(bh):
                run = 0
                for cx in range(bw):
                    if atlas[gx + cx, cy]:
                        run += 1
                        continue
                    if run:
                        self.rect(x + (cx - run) * scale, y + cy * scale,
                                  run * scale, scale, c)
                        run = 0
                if run:
                    self.rect(x + (bw - run) * scale, y + cy * scale,
                              run * scale, scale, c)
            x += adv[i] * scale
        return x

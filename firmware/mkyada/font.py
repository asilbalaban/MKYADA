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

    def measure(self, s):
        """Pixel width of a string. Replaces the old fixed `maxc` character
        count — with proportional advances, 'Kamera' and 'WWWWWW' are not the
        same width, and the grid used to truncate both at 10 characters."""
        w = 0
        adv = self.adv
        for ch in s:
            i = self.index(ch)
            if i >= 0:
                w += adv[i]
        return w

    def fit(self, s, px):
        """The longest prefix of `s` that fits in `px` pixels."""
        w = 0
        adv = self.adv
        for n, ch in enumerate(s):
            i = self.index(ch)
            if i < 0:
                continue
            w += adv[i]
            if w > px:
                return s[:n]
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
        bitmaptools.fill_region(self.bmp, 0, 0, self.W, self.H, 0)

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
        W = self.W
        for ch in s:
            i = f.index(ch)
            if i < 0:
                continue
            a = adv[i]
            if x + a > 0 and x < W:
                # Narrow the SOURCE rather than relying on blit to clip a
                # destination overrun. It does clip, but a glyph straddling the
                # right edge is the exact case that used to end in an exception
                # inside a paint, and a paint that raises leaves the previous
                # screen frozen on the glass (issue #39's failure mode).
                w = bw if x + bw <= W else W - x
                bitmaptools.blit(self.bmp, src, x, y,
                                 x1=i * bw, y1=0, x2=i * bw + w, y2=bh,
                                 skip_source_index=skip)
            x += a
        return x

    def big(self, s, x, y, scale=2, anchor=0.5):
        """Scaled text for the hero numbers (speed, volume, the boot wordmark).

        Drawn by expanding lit pixels rather than from a pre-scaled atlas: the
        hero lines are at most a handful of characters and never on a hot path,
        so a few hundred fill_region calls are cheaper than the ~500 bytes a
        second atlas would cost forever."""
        f = self.font
        if not s:
            return x
        if anchor:
            x -= int(f.measure(s) * scale * anchor)
        y -= (7 * scale) // 2
        atlas = f.atlas
        bw = f.box_w
        for ch in s:
            i = f.index(ch)
            if i < 0:
                continue
            gx = i * bw
            for cx in range(bw):
                for cy in range(f.box_h):
                    if atlas[gx + cx, cy]:
                        self.rect(x + cx * scale, y + cy * scale, scale, scale)
            x += f.adv[i] * scale
        return x

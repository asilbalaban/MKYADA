"""A real (if slow) software displayio + bitmaptools, so firmware drawing code
can run on a desktop and be inspected pixel by pixel.

The previous stubs were hollow — Bitmap.__setitem__ was `pass` — which was fine
when the firmware drew with Labels the tests never looked inside. Now that every
screen is plain pixels, the drawing itself is testable, and issues #35 and #36
(text running off the screen, labels smearing together in a bar) are exactly the
class of bug a renderer can catch and a logic test cannot.
"""
import sys
import types


class Bitmap:
    def __init__(self, w, h, n=2):
        self.width, self.height, self.values = w, h, n
        self.px = bytearray(w * h)

    def __setitem__(self, key, v):
        x, y = key if isinstance(key, tuple) else (key % self.width, key // self.width)
        if 0 <= x < self.width and 0 <= y < self.height:
            self.px[y * self.width + x] = v
        else:
            raise IndexError("(%d,%d) outside %dx%d" % (x, y, self.width, self.height))

    def __getitem__(self, key):
        x, y = key if isinstance(key, tuple) else (key % self.width, key // self.width)
        return self.px[y * self.width + x]

    def dirty(self, *a):
        pass

    def rows(self):
        """The bitmap as one string of '#' and '.' per row — the form the
        golden files store, because a diff of it is readable."""
        out = []
        for y in range(self.height):
            r = self.px[y * self.width:(y + 1) * self.width]
            out.append("".join("#" if v else "." for v in r))
        return out


class Palette:
    def __init__(self, n):
        self.colors = [0] * n

    def __setitem__(self, i, v):
        self.colors[i] = v

    def __getitem__(self, i):
        return self.colors[i]


class TileGrid:
    def __init__(self, bitmap, pixel_shader=None, x=0, y=0):
        self.bitmap, self.x, self.y = bitmap, x, y


class Group(list):
    def append(self, item):  # noqa: A003 - mirror displayio.Group
        super().append(item)


def fill_region(dest, x1, y1, x2, y2, value):
    for y in range(max(0, y1), min(dest.height, y2)):
        row = y * dest.width
        for x in range(max(0, x1), min(dest.width, x2)):
            dest.px[row + x] = value


def blit(dest, source, x, y, x1=0, y1=0, x2=None, y2=None,
         skip_source_index=None, skip_dest_index=None):
    if x2 is None:
        x2 = source.width
    if y2 is None:
        y2 = source.height
    for sy in range(y1, y2):
        dy = y + sy - y1
        if not 0 <= dy < dest.height:
            continue
        for sx in range(x1, x2):
            dx = x + sx - x1
            if not 0 <= dx < dest.width:
                continue
            v = source.px[sy * source.width + sx]
            if skip_source_index is not None and v == skip_source_index:
                continue
            if skip_dest_index is not None and dest.px[dy * dest.width + dx] == skip_dest_index:
                continue
            dest.px[dy * dest.width + dx] = v


def draw_line(dest, x1, y1, x2, y2, value):
    steps = max(abs(x2 - x1), abs(y2 - y1), 1)
    for i in range(steps + 1):
        x = x1 + (x2 - x1) * i // steps
        y = y1 + (y2 - y1) * i // steps
        if 0 <= x < dest.width and 0 <= y < dest.height:
            dest.px[y * dest.width + x] = value


def install():
    """Register the fake modules under their CircuitPython names."""
    displayio = types.ModuleType("displayio")
    displayio.Bitmap = Bitmap
    displayio.Palette = Palette
    displayio.TileGrid = TileGrid
    displayio.Group = Group
    displayio.release_displays = lambda: None
    sys.modules["displayio"] = displayio

    bt = types.ModuleType("bitmaptools")
    bt.fill_region = fill_region
    bt.blit = blit
    bt.draw_line = draw_line
    sys.modules["bitmaptools"] = bt
    return displayio, bt

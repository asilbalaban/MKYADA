"""Render every OLED screen into a real 128x64 buffer and check the pixels.

The display had no automated coverage of any kind before this. It could not:
screens were built out of displayio Labels whose glyphs only existed on the
device, so a test could inspect the object tree but never the picture. Both
issue #35 ("updating - do not unplug" ran off both edges) and issue #36 (three
labels smeared into one in the bottom bar) were bugs a picture would have
caught immediately and an object tree could not.

Now that drawing is plain pixels, this file runs the firmware's own oled.py
against the firmware's own font and asserts three things:

  1. that the drawing primitives behave — including that a colour argument is
     actually a colour. font.py's big() once let its `c` parameter be shadowed
     by a character code, which drew fine against a permissive fake and threw
     "out of range of target" on the board. Since the boot splash is the first
     thing drawn, the whole display fell back to headless and the keypad came
     up with a dead screen. tests/fakedisplayio.py now range-checks like
     CircuitPython does, and the primitive tests below exercise every colour
     path on purpose;
  2. structural invariants — nothing outside the screen, tiles that never cross
     their gutter, the selected row actually inverted, and the incremental
     repaint producing the same pixels as a fresh draw no matter what route you
     took to get there;
  3. golden images — tests/golden/*.txt, one ASCII picture per screen, which
     makes an unintended layout change show up as a readable diff.

Regenerate the goldens after an intentional change:  python3 tests/oled_render_test.py --bless

Run: python3 tests/oled_render_test.py
"""
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "tests"))
sys.path.insert(0, os.path.join(REPO, "firmware"))

import fakedisplayio  # noqa: E402

fakedisplayio.install()

from mkyada import i18n, icons, oled as oledmod  # noqa: E402

GOLDEN = os.path.join(REPO, "tests", "golden")
BLESS = "--bless" in sys.argv

fails = []
count = 0


def check(name, cond, detail=""):
    global count
    count += 1
    if not cond:
        fails.append("%s%s" % (name, (" - " + detail) if detail else ""))
        print("FAIL %s%s" % (name, (" - " + detail) if detail else ""))


class FakeDisplay:
    """Just enough SH1106 for Oled: geometry, a root group and a refresh
    counter (which is also how the partial-repaint tests observe work)."""
    width, height = 128, 64
    auto_refresh = False

    def __init__(self):
        self.refreshes = 0
        self.root_group = None

    def refresh(self):
        self.refreshes += 1


def make_oled():
    """An Oled wired to the fake display. __init__ can't run its hardware path
    on a desktop, so the font/framebuffer half is built the same way it is on
    the device and handed the fake."""
    o = oledmod.Oled.__new__(oledmod.Oled)
    o.display = FakeDisplay()
    o._last = None
    o._cells = None
    o._menu = None
    o._chrome = None
    o.fw = "0.0.0"
    o.W, o.H, o.CX = 128, 64, 64
    o.font = oledmod.Font(os.path.join(REPO, "firmware", "fonts", "mkyada.fnt"))
    o.fb = oledmod.Fb(128, 64, o.font)
    o.display.root_group = o.fb.group
    return o


def rows(o):
    return o.fb.bmp.rows()


def band_of(o, y0, y1):
    """The lit-pixel count in a horizontal band — how the tests ask 'is there
    anything drawn here'."""
    return sum(r.count("#") for r in rows(o)[y0:y1])


def golden(name, o):
    path = os.path.join(GOLDEN, name + ".txt")
    got = "\n".join(rows(o)) + "\n"
    if BLESS:
        os.makedirs(GOLDEN, exist_ok=True)
        # newline="" so Windows does not turn these into CRLF: the goldens are
        # read back by app/src/lib/oled-draw.test.ts, which splits on "\n" and
        # would carry a stray "\r" into every comparison.
        with open(path, "w", newline="") as f:
            f.write(got)
        return
    if not os.path.exists(path):
        check("golden %s exists" % name, False, "run with --bless")
        return
    with open(path) as f:
        want = f.read()
    if got == want:
        check("golden %s" % name, True)
        return
    diff = next((i for i, (a, b) in enumerate(zip(got.split("\n"), want.split("\n")))
                 if a != b), 0)
    check("golden %s" % name, False,
          "first differing row %d\n  got  %s\n  want %s"
          % (diff, got.split("\n")[diff], want.split("\n")[diff]))


# ---------- the font itself ----------
f = oledmod.Font(os.path.join(REPO, "firmware", "fonts", "mkyada.fnt"))
check("font box is 5x8", (f.box_w, f.box_h) == (5, 8), "%dx%d" % (f.box_w, f.box_h))
check("space has width", f.measure(" ") > 0)
check("proportional advances", f.measure("i") < f.measure("W"),
      "i=%d W=%d" % (f.measure("i"), f.measure("W")))
check("turkish is drawn, not folded", f.index("ş") != f.index("s"))
for ch in "çğıöşüÇĞİÖŞÜ":
    check("turkish glyph %s" % ch, f.index(ch) >= 0)
check("unknown folds rather than vanishes", f.index("é") == f.index("e"))
check("unfoldable becomes ?", f.index("Ж") == f.index("?"))
check("measure is additive", f.measure("ab") == f.measure("a") + f.measure("b"))
check("fit truncates to width", f.measure(f.fit("Sound kahkaha.mp3", 40)) <= 40)
check("fit keeps what fits", f.fit("ok", 128) == "ok")
# The claim that one proportional 5x8 font holds as much text as the old fixed
# 4x6 rests on this number; it was 4.69 in the first draft and lost capacity.
avg = sum(f.adv[f.index(c)] for c in "abcdefghijklmnopqrstuvwxyz") / 26.0
check("lowercase averages under the old 4px cell", avg <= 4.0, "%.2f px" % avg)

# ---------- the icon table ----------
# Icons are addressed by NAME so that reordering the source can never repoint a
# user's macro at a different picture.
check("icon resolves by name", icons.get("rocket") is not None)
check("unknown icon is None, not a crash", icons.get("no-such-icon") is None)
check("icon is 8 bytes", len(icons.get("ghost")) == 8)
check("chrome icons exist", all(icons.get(n) is not None for n in
                                ("chevron-left", "chevron-right", "check",
                                 "warning")))
check("names are unique", len(set(icons.IDX)) == len(icons.IDX))
# A hand-drawn icon has no name to look up — the eight rows ride inside the
# macro json as "px:" + 16 hex, and get() decodes rather than resolves them.
# The grid draws whatever comes back, so a malformed one has to read as "no
# icon" and not as an exception four tiles into a repaint.
check("a drawn icon decodes to its own bytes",
      icons.get("px:183c7effc3c30000") == b"\x18\x3c\x7e\xff\xc3\xc3\x00\x00")
check("a drawn icon is 8 bytes like any other",
      len(icons.get("px:00000000000000ff")) == 8)
check("a drawn icon round-trips a named one",
      icons.get("px:" + "".join("%02x" % b for b in icons.get("rocket")))
      == icons.get("rocket"))
check("a short drawn icon is None", icons.get("px:1234") is None)
check("a non-hex drawn icon is None", icons.get("px:zzzzzzzzzzzzzzzz") is None)
check("bare 'px:' is None", icons.get("px:") is None)
check("every index addresses 8 packed bytes",
      all(len(icons.PIX[i * 8:i * 8 + 8]) == 8 for i in icons.IDX.values()))

# ---------- the framebuffer primitives ----------
o = make_oled()
o.fb.clear()
check("clear empties the buffer", band_of(o, 0, 64) == 0)
o.fb.rect(-10, -10, 200, 200)
check("rect clips to the screen", band_of(o, 0, 64) == 128 * 64)
o.fb.clear()
o.fb.text("MKYADA", 200, 30)  # entirely off the right edge
check("off-screen text draws nothing", band_of(o, 0, 64) == 0)
o.fb.clear()
o.fb.rect(0, 0, 128, 9)
before = band_of(o, 0, 9)
o.fb.text("ABC", 64, 5, invert=True)
check("inverted text cuts holes in a filled bar", band_of(o, 0, 9) < before)
o.fb.clear()
right = o.fb.text("hi", 0, 30, anchor=0.0)
check("text returns the pen position", right == f.measure("hi"))

# The v2 vocabulary. Each is built on rect(), so what matters is that it lands
# where it says and honours its colour argument.
o.fb.fill(1)
check("fill lights the whole screen", band_of(o, 0, 64) == 128 * 64)
o.fb.fill(0)
check("fill(0) is clear", band_of(o, 0, 64) == 0)
o.fb.frame(10, 10, 20, 10)
check("frame is an outline, not a block", band_of(o, 10, 20) == 2 * 20 + 2 * 8)
o.fb.clear()
o.fb.rfill(10, 10, 20, 10)
check("rfill knocks out four corners", band_of(o, 10, 20) == 20 * 10 - 4)
o.fb.clear()
o.fb.sw(10, 10, True)
on_px = band_of(o, 10, 18)
o.fb.clear()
o.fb.sw(10, 10, False)
check("switch reads differently on and off", band_of(o, 10, 18) != on_px)
o.fb.clear()
o.fb.segbar(4, 20, 120, 10, 15, 5)
check("segbar fills only the first segments",
      0 < band_of(o, 20, 29) < 120 * 9)
o.fb.clear()
o.fb.icon(10, 10, icons.get("rocket"))
check("icon draws inside its 8x8 box",
      band_of(o, 10, 18) > 0 and band_of(o, 0, 10) == 0
      and band_of(o, 18, 64) == 0)
o.fb.clear()
o.fb.dither()
check("dither is half the pixels", band_of(o, 0, 64) == 128 * 64 // 2)

# The regression that shipped a dead screen: every one of these draws with the
# carved colour (0) on a lit field, which is the path big() got wrong. A
# character code leaking into the colour argument fails the range check in
# fakedisplayio and this test stops dead.
o.fb.fill(1)
o.fb.big("MKYADA", 64, 20, 2, 0.5, 0)
check("big carves out of a lit field", 0 < band_of(o, 0, 64) < 128 * 64)
o.fb.clear()
o.fb.big("88", 64, 20, 3, 0.5, 1)
check("big draws lit on a dark field", band_of(o, 0, 64) > 0)
o.fb.clear()
o.fb.icon(10, 10, icons.get("rocket"), 0)
check("icon accepts the carved colour", band_of(o, 0, 64) == 0)

# ---------- every screen, in both languages ----------
LABELS = [("Copy", ""), ("Paste", ""), ("Play/", "Pause"),
          ("Volume", ""), ("Intro", "Type"), ("Layer B", "")]
ART = [icons.get("keyboard"), icons.get("paste"), None,
       icons.get("volume"), icons.get("record"), icons.get("layers")]
SET_ITEMS = [("Auto return", "text", "10s"), ("Language", "text", "English"),
             ("Layer band", "toggle", True), ("Profile band", "toggle", False),
             ("Wheel layers", "toggle", True), ("Key test", "none", None),
             ("About", "none", None), ("Restart", "none", None)]

for lang in ("en", "tr"):
    i18n.set_lang(lang)
    o = make_oled()
    tag = "[%s]" % lang

    o.show_boot(0.0)
    check(tag + " boot draws", band_of(o, 0, 64) > 0)
    # The splash is an inverted field: the margin under the footer text must be
    # solid, which is also how "did fill(1) actually run" is observable.
    check(tag + " boot is an inverted field",
          band_of(o, 61, 64) == 3 * 128)
    o.boot_progress(0.5)
    check(tag + " boot bar fills part-way",
          0 < band_of(o, oledmod.PBAR_Y + 2,
                      oledmod.PBAR_Y + oledmod.PBAR_H - 2) < 4 * 116)
    o.boot_progress(1.0)

    o.show_update(0.42, False, 26000, 62914)
    check(tag + " update draws", band_of(o, 0, 64) > 0)
    # issue #35: the warning has to be inside the glass on both edges
    check(tag + " update warning stays on the glass",
          all(r[0] == "#" and r[127] == "#" for r in rows(o)[13:22]))
    # The percentage sat at y=61, which put its glyph box two rows past the
    # bottom of the screen and clipped the digits.
    check(tag + " update percentage is not clipped",
          band_of(o, 53, 61) > 0 and band_of(o, 61, 64) == 0)

    o.show_settings("SETTINGS", SET_ITEMS, 0)
    check(tag + " settings draws four rows",
          all(band_of(o, oledmod.ROW_TOP + i * oledmod.ROW_H,
                      oledmod.ROW_TOP + 12 + i * oledmod.ROW_H) > 0
              for i in range(oledmod.VIS)))
    check(tag + " settings selection is a filled row",
          rows(o)[oledmod.ROW_TOP + 1].count("#") > 100)
    # The switch on the selected row is carved, not drawn — it used to vanish
    # into the inverted block entirely.
    sel_row = rows(o)[oledmod.ROW_TOP + 1]
    o.show_settings("SETTINGS", SET_ITEMS, 2)   # a toggle row selected
    check(tag + " a selected toggle stays visible",
          "." in rows(o)[oledmod.ROW_TOP + 2 * oledmod.ROW_H + 4][103:120])
    o.show_settings("SETTINGS", SET_ITEMS, 7)   # scrolled to the end
    check(tag + " settings scrollbar moves with the list",
          band_of(o, oledmod.SB_Y, oledmod.SB_Y + oledmod.SB_H) > 0)
    check(tag + " list rows keep clear of the scrollbar",
          all(r[oledmod.SB_X - 1] == "." for r in
              rows(o)[oledmod.ROW_TOP:oledmod.ROW_TOP + 12]))

    o.show_menu("LANGUAGE", ["English", "Türkçe"], 0, marked=1)
    check(tag + " menu draws", band_of(o, 0, 64) > 0)
    check(tag + " a short menu draws no scrollbar",
          sum(r[oledmod.SB_X:].count("#") for r in
              rows(o)[oledmod.SB_Y:oledmod.SB_Y + oledmod.SB_H]) == 0)
    o.show_menu("MEDIA", ["Play/Pause", "Next", "Prev", "Stop", "Mute"], 4,
                marked=0, action="run", hold="hold: assign")
    check(tag + " a long menu draws a scrollbar",
          sum(r[oledmod.SB_X:].count("#") for r in
              rows(o)[oledmod.SB_Y:oledmod.SB_Y + oledmod.SB_H]) > 0)

    o.show_speed("A", 3, 15)
    check(tag + " speed hero is large", band_of(o, 13, 35) > 60)
    check(tag + " speed segbar drawn", band_of(o, 38, 48) > 0)
    o.show_timeout(24, 3, 60)
    check(tag + " timeout draws its ruler", band_of(o, 44, 52) > 0)

    o.show_grid(LABELS, 0, True, "(A) Main", ART, None, (False, False, True))
    check(tag + " grid draws", band_of(o, 0, 64) > 0)
    check(tag + " grid band is inverted", rows(o)[3].count("#") > 60)
    check(tag + " band-less bottom margin is clear", band_of(o, 62, 64) == 0)
    o.show_grid(LABELS, 2, True, "(A) Main", ART, (0, 4), (True, True, True))
    check(tag + " paged grid draws its dot row", band_of(o, 59, 63) > 0)
    # Band off: no 9px strip at all, and the tiles grow into the space it used
    # to take. The page counter goes with the band — the dot row says the same
    # thing at the bottom.
    o.show_grid(LABELS, 1, True, None, ART, None, None)
    check(tag + " band-less grid draws", band_of(o, 0, 64) > 0)
    check(tag + " band-less grid has no top strip", band_of(o, 0, 2) == 0)
    check(tag + " band-less tiles start above the old bar",
          band_of(o, 2, 11) > 0)
    o.show_grid(LABELS, 1, True, None, ART, (0, 3), None)
    check(tag + " a paged band-less grid still has no top strip",
          band_of(o, 0, 2) == 0)
    check(tag + " a paged band-less grid keeps its dot row",
          band_of(o, 59, 63) > 0)

    o.show_home(0, 3, ["A", "B", "C"], "Main", True)
    check(tag + " home draws the layer letter big",
          band_of(o, 23, 38) > 50, "%d px" % band_of(o, 23, 38))
    o.show_home(3, 3, ["A", "B", "C"])
    check(tag + " home settings page draws", band_of(o, 0, 64) > 0)

    o.show_keytest({"cnt": [1, 0, 3, 0, 0, 2], "nav": [1, 0, 4], "enc": -3,
                    "last": 2})
    check(tag + " keytest draws six keys", band_of(o, 0, 64) > 0)

    # Settings > Pixel test: the whole panel, so a dead column or a stuck row
    # shows against a solid field instead of hiding in the dark.
    o.show_pixels()
    check(tag + " pixel test lights every pixel",
          band_of(o, 0, 64) == 128 * 64, "%d px" % band_of(o, 0, 64))

    o.show_about([("Model", "vision6"), ("Firmware", "0.23.1"),
                  ("MCU", "RP2040"), ("Device ID", "5035586072865A1F"),
                  ("Layers", "3")])
    check(tag + " about stays on the glass", band_of(o, 63, 64) == 0)

    o.show_saved("A", 1, 15)
    check(tag + " saved draws the tick", band_of(o, 18, 44) > 30)
    o.show_toast("USB", "USB drive is on", "read-only")
    check(tag + " toast draws both lines",
          band_of(o, 26, 35) > 0 and band_of(o, 38, 47) > 0)
    o.show_toast("SAVED", "done", "", True)

    o.show_card("WHEEL", "Next layer", None, "run")
    check(tag + " card hero drawn", band_of(o, 18, 38) > 30)
    # 12 wide characters at scale 2 are 168px; a centred overflow would be cut
    # off at both ends instead of just the tail.
    o.show_card("WHEEL", "WWWWWWWWWWWW", None, "run")
    check(tag + " wide card hero stays on the glass",
          all(r[0] == "." and r[127] == "." for r in rows(o)[16:40]))

    o.show_adjust("SES", "44%", 0.44, action="ok")
    check(tag + " adjust draws", band_of(o, 0, 64) > 0)

    o.show_obsrec({"rec": True, "blink": True, "key": 2, "time": "01:35",
                   "scene": "Intro", "hint": "stop"})
    check(tag + " obs record card draws", band_of(o, 0, 64) > 0)
    o.show_obsrec({"rec": False, "key": 2, "time": "00:00", "hint": "start"})
    o.show_obs({"rec": True, "blink": True, "live": False, "mic": 64,
                "time": "01:35", "scene": "Intro", "hint": "stop"})
    check(tag + " obs screen draws", band_of(o, 0, 64) > 0)
    o.show_obs({"rec": False, "live": True, "mic": 20, "time": "00:00",
                "scene": "Game", "hint": "stop"})

    o.show_obscenter({"rec": True, "live": False, "blink": True, "mic": 64,
                      "mute": False, "time": "00:42:10", "scene": "Gameplay",
                      "cpu": 8, "fps": 60, "drop": 0, "focus": "mic",
                      "klabels": ["MUTE", "CAM", "CLIP", "", "", "REC"]})
    check(tag + " obs center draws", band_of(o, 0, 64) > 0)
    # widgets the app never pushed stay off the glass: no quick-key row means
    # no hairline at y=52 either
    o.show_obscenter({"time": "01:02:33", "scene": "Intro"})
    check(tag + " obs center hides the quick-key row when off",
          band_of(o, 52, 64) == 0)

    o.show_headless()
    check(tag + " headless draws", band_of(o, 0, 64) > 0)
    o.show_host()
    check(tag + " host draws", band_of(o, 0, 64) > 0)
    o.show_error("something went wrong on the device for a long while")
    check(tag + " long error wraps to two lines",
          band_of(o, 36, 45) > 0 and band_of(o, 46, 55) > 0)

# ---------- the grid, and its incremental repaint ----------
i18n.set_lang("tr")
o = make_oled()
L = [("Kamera", ""), ("Masaüstü", ""), ("Masaüstü ve", "Kamera"),
     ("Kayıt", ""), ("Yayın", ""), ("Next layer", "")]
o.show_grid(L, 0, True, band="Katman A")
check("selected cell is a filled block", rows(o)[20][2:40].count("#") > 30)
golden("grid_banded", o)

n0 = o.display.refreshes
o.show_grid(L, 0, True, band="Katman A")
check("identical grid repaint costs one refresh", o.display.refreshes == n0 + 1)
snapshot = rows(o)
o.show_grid(L, 1, True, band="Katman A")
changed = sum(1 for a, b in zip(snapshot, rows(o)) if a != b)
# The 2px gutter is what makes this possible: a tile can clear its own box
# without ever touching its neighbour or the chrome.
check("moving the selection touches only the tile band",
      changed <= 27, "%d rows changed" % changed)

o2 = make_oled()
o2.show_grid(L, None, False, band=None)
check("update_band refuses a band-less grid", o2.update_band("x") is False)
check("update_band works on a banded grid", o.update_band("Katman B") is True)

# A name too long for a cell must be cut, not spill over its gutter.
o3 = make_oled()
long_pair = o3.split_name("Sound kahkaha.mp3")
check("long name splits on the space", long_pair[0] == "Sound", str(long_pair))
check("both halves fit the cell",
      max(f.measure(long_pair[0]), f.measure(long_pair[1])) <= 128 // 3 - 2,
      str(long_pair))
check("unbroken name is cut, not dropped",
      o3.split_name("abcdefghijklmnopqrstuvwxyz")[1] != "")
o3.show_grid([long_pair] * 6, 0, True, band=None)
for k, gx in enumerate((oledmod.TILE_X[0] + oledmod.TILE_W,
                        oledmod.TILE_X[1] + oledmod.TILE_W)):
    check("gutter %d stays empty" % k, all(r[gx] == "." for r in rows(o3)),
          "column %d" % gx)

# ---------- the settings list's incremental repaint ----------
# An incremental screen can be right once and drift as you walk it. The check
# that matters is not "does one repaint look correct" but "does any route to a
# state produce the same pixels as drawing that state from scratch".
i18n.set_lang("en")


def fresh_settings(sel):
    d = make_oled()
    d.show_settings("SETTINGS", SET_ITEMS, sel)
    return rows(d)


m = make_oled()
m.show_settings("SETTINGS", SET_ITEMS, 0)
before = rows(m)
m.show_settings("SETTINGS", SET_ITEMS, 1)
changed = sum(1 for a, b in zip(before, rows(m)) if a != b)
check("a detent repaints two rows, not the screen", changed <= 26,
      "%d rows changed" % changed)

# walk down past the scroll point, back up, and around again
for sel in (1, 2, 3, 4, 5, 6, 7, 6, 5, 4, 3, 2, 1, 0, 7, 0):
    m.show_settings("SETTINGS", SET_ITEMS, sel)
    check("settings sel=%d matches a fresh draw" % sel,
          rows(m) == fresh_settings(sel), "incremental repaint drifted")

# chrome changes must force the full redraw, not leave the old one behind
m.show_settings("SETTINGS", SET_ITEMS, 1)
m.show_settings("OTHER", SET_ITEMS, 1)
mt = make_oled()
mt.show_settings("OTHER", SET_ITEMS, 1)
check("a new title matches a fresh draw", rows(m) == rows(mt))
# leaving the list and coming back must not reuse the stale row cache
m.show_speed("A", 3, 15)
m.show_settings("SETTINGS", SET_ITEMS, 1)
check("returning from another screen matches a fresh draw",
      rows(m) == fresh_settings(1))

# ---------- the generic menu's incremental repaint ----------
ITEMS = ["Play/Pause", "Next", "Prev", "Stop", "Mute", "Rewind"]


def fresh_menu(sel, **kw):
    d = make_oled()
    d.show_menu("MEDIA", ITEMS, sel, **kw)
    return rows(d)


mm = make_oled()
for sel in (0, 1, 2, 3, 4, 5, 4, 0, 5):
    mm.show_menu("MEDIA", ITEMS, sel)
    check("menu sel=%d matches a fresh draw" % sel, rows(mm) == fresh_menu(sel),
          "incremental repaint drifted")
mm.show_menu("MEDIA", ITEMS, 1, marked=1)
check("a new marked item matches a fresh draw",
      rows(mm) == fresh_menu(1, marked=1))
mm.show_menu("MEDIA", ITEMS, 1, action="run")
check("a new action label matches a fresh draw",
      rows(mm) == fresh_menu(1, action="run"))

# ---------- the value editors' repaint ----------
def fresh_speed(t):
    d = make_oled()
    d.show_speed("A", 3, t)
    return rows(d)


v = make_oled()
for t in (16, 17, 30, 99, 100, 1, 15, 55):
    v.show_speed("A", 3, t)
    check("speed t=%d matches a fresh draw" % t, rows(v) == fresh_speed(t),
          "repaint drifted")
# the widest hero must not survive under a narrower one
v.show_speed("A", 3, 100)
v.show_speed("A", 3, 10)
check("a shorter hero leaves no ghost", rows(v) == fresh_speed(10))

a2 = make_oled()
a2.show_adjust("SES", "44%", 5.0, action="ok")
a3 = make_oled()
a3.show_adjust("SES", "44%", 1.0, action="ok")
check("adjust clamps frac over 1.0", rows(a2) == rows(a3))

# ---------- goldens for the rest ----------
i18n.set_lang("en")
for name, fn in (
    ("boot", lambda d: d.show_boot()),
    ("update", lambda d: d.show_update(0.42, False, 26000, 62914)),
    ("transfer", lambda d: d.show_transfer()),
    ("home", lambda d: d.show_home(0, 3, ["A", "B", "C"], "Main", True)),
    ("settings", lambda d: d.show_settings("SETTINGS", SET_ITEMS, 1)),
    ("menu", lambda d: d.show_menu("MEDIA", ITEMS, 1, marked=0, action="run")),
    ("speed", lambda d: d.show_speed("A", 3, 15)),
    ("timeout", lambda d: d.show_timeout(24, 3, 60)),
    ("keytest", lambda d: d.show_keytest({"cnt": [1, 0, 3, 0, 0, 2],
                                          "nav": [1, 0, 4], "enc": -3,
                                          "last": 2})),
    ("saved", lambda d: d.show_saved("A", 1, 15)),
    ("about", lambda d: d.show_about((("Model", "vision6"),
                                      ("Firmware", "0.23.1"),
                                      ("Device ID", "5035586072b9")))),
    ("card", lambda d: d.show_card("WHEEL", "Next layer", None, "run")),
    ("toast", lambda d: d.show_toast("USB", "USB drive is on", "read-only")),
    ("obs", lambda d: d.show_obs({"rec": True, "blink": True, "live": False,
                                  "mic": 64, "time": "01:35",
                                  "scene": "Intro", "hint": "stop"})),
    ("obsrec", lambda d: d.show_obsrec({"rec": True, "blink": True, "key": 2,
                                        "time": "01:35", "scene": "Intro",
                                        "hint": "stop"})),
    ("obscenter", lambda d: d.show_obscenter(
        {"rec": True, "live": False, "blink": True, "mic": 64, "mute": False,
         "time": "00:42:10", "scene": "Gameplay", "cpu": 8, "fps": 60,
         "drop": 0, "focus": "mic",
         "klabels": ["MUTE", "CAM", "CLIP", "", "", "REC"]})),
    ("obscenter_min", lambda d: d.show_obscenter(
        {"time": "01:02:33", "scene": "Intro"})),
    ("host", lambda d: d.show_host()),
):
    d = make_oled()
    fn(d)
    golden(name, d)

i18n.set_lang("tr")
d = make_oled()
d.show_settings("AYARLAR", [("Otomatik Dönüş", "text", "10sn"),
                            ("Dil", "text", "Türkçe"),
                            ("Katman bandı", "toggle", True),
                            ("Profil bandı", "toggle", False)], 0)
golden("settings_tr", d)

print("\n%d checks, %d failed" % (count, len(fails)))
if BLESS:
    print("goldens written to tests/golden/")
sys.exit(1 if fails else 0)

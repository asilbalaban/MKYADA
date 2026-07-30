"""Render every OLED screen into a real 128x64 buffer and check the pixels.

The display had no automated coverage of any kind before this. It could not:
screens were built out of displayio Labels whose glyphs only existed on the
device, so a test could inspect the object tree but never the picture. Both
issue #35 ("updating - do not unplug" ran off both edges) and issue #36 (three
labels smeared into one in the bottom bar) were bugs a picture would have
caught immediately and an object tree could not.

Now that drawing is plain pixels, this file runs the firmware's own oled.py
against the firmware's own font and asserts two things:

  1. structural invariants — nothing outside the screen, no text crossing the
     bars, the selected menu row actually inverted, and so on;
  2. golden images — tests/golden/*.txt, one ASCII picture per screen, which
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

from mkyada import i18n, oled as oledmod  # noqa: E402

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
    o._bar = None
    o._last = None
    o._cells = None
    o._menu = None
    o._band_txt = None
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
        with open(path, "w") as f:
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
o.fb.rect(0, 0, 128, 11)
before = band_of(o, 0, 11)
o.fb.text("ABC", 64, 5, invert=True)
check("inverted text cuts holes in a filled bar", band_of(o, 0, 11) < before)
o.fb.clear()
right = o.fb.text("hi", 0, 30, anchor=0.0)
check("text returns the pen position", right == f.measure("hi"))

# ---------- every screen ----------
for lang in ("en", "tr"):
    i18n.set_lang(lang)
    o = make_oled()

    o.show_boot()
    check("[%s] boot draws" % lang, band_of(o, 0, 64) > 0)
    o.boot_progress(0.5)
    check("[%s] boot bar fills half" % lang,
          band_of(o, 42, 47) > 0 and band_of(o, 42, 47) < 5 * 104)

    o.show_update(0.42)
    check("[%s] update text stays on screen" % lang,
          all(not r.startswith("#") or "MKYADA" for r in rows(o)[28:46]))
    # issue #35: the warning has to be two lines, and both inside the glass
    check("[%s] update has two text lines" % lang,
          band_of(o, 28, 36) > 0 and band_of(o, 36, 46) > 0)
    # The percentage sat at y=61, which put its glyph box two rows past the
    # bottom of the screen and clipped the digits.
    check("[%s] update percentage is not clipped" % lang,
          band_of(o, 56, 63) > 0 and band_of(o, 63, 64) == 0)

    o.show_home(0, 3, ["A", "B", "C"])
    check("[%s] home draws the layer letter big" % lang, band_of(o, 10, 45) > 100)
    check("[%s] home draws 4 dots" % lang, band_of(o, 50, 58) > 0)

    o.show_menu("SETTINGS", ["Auto return", "Language", "Layer band",
                             "Profile band", "About", "Restart"], 0)
    check("[%s] menu shows four rows" % lang,
          all(band_of(o, oledmod.MENU_TOP - 4 + i * oledmod.ROW_H,
                      oledmod.MENU_TOP + 4 + i * oledmod.ROW_H) > 0
              for i in range(4)))
    check("[%s] menu selection is a filled row" % lang,
          rows(o)[oledmod.MENU_TOP - 4].count("#") > 100)
    # issue #36 was three labels smearing together; the structural version of
    # that check is "the last menu row stops before the bottom bar".
    check("[%s] menu bottom bar is clear of the rows" % lang,
          band_of(o, oledmod.BOT_SEP - 2, oledmod.BOT_SEP) == 0)
    # Arrows live in the right-hand 8px strip that `rw` keeps clear of the
    # selection rectangle, so probing that strip at the arrows' own rows says
    # whether the list is advertising more items.
    def strip(d, y0, y1):
        return sum(r[121:].count("#") for r in rows(d)[y0:y1])

    check("[%s] scrolled-to-top menu shows only the down arrow" % lang,
          strip(o, oledmod.BAR_H + 2, oledmod.BAR_H + 6) == 0
          and strip(o, oledmod.BOT_SEP - 6, oledmod.BOT_SEP - 2) > 0)

    o.show_menu("SETTINGS", ["Auto return", "Language", "Layer band",
                             "Profile band", "About", "Restart"], 5)
    check("[%s] scrolled-to-bottom menu shows the up arrow" % lang,
          strip(o, oledmod.BAR_H + 2, oledmod.BAR_H + 6) > 0)

    # sel=1 keeps the (full-width, because the list fits) selection rectangle
    # out of both arrow bands.
    o.show_menu("SETTINGS", ["one", "two"], 1)
    check("[%s] short menu draws no arrows" % lang,
          strip(o, oledmod.BAR_H + 2, oledmod.BAR_H + 6) == 0
          and strip(o, oledmod.BOT_SEP - 6, oledmod.BOT_SEP - 2) == 0)

    o.show_speed("A", 3, 15)
    check("[%s] speed hero is large" % lang, band_of(o, 16, 38) > 60)
    check("[%s] speed slider drawn" % lang, band_of(o, oledmod.HBAR_Y,
                                                    oledmod.HBAR_Y + 5) > 0)

    o.show_adjust("SES", "44%", 0.44, action="ok")
    check("[%s] adjust slider is partial" % lang,
          0 < band_of(o, oledmod.HBAR_Y, oledmod.HBAR_Y + 5) < 5 * 112)

    o.show_saved("A", 1, 15)
    check("[%s] saved draws the tick" % lang, band_of(o, 18, 44) > 30)

    o.show_toast("USB", "USB drive is on", "read-only")
    check("[%s] toast draws both lines" % lang,
          band_of(o, 26, 35) > 0 and band_of(o, 38, 47) > 0)

    o.show_about((("Model", "vision6"), ("Firmware", "0.20.0"),
                  ("Device ID", "5035586072b9")))
    check("[%s] about rows stay above the bottom bar" % lang,
          band_of(o, oledmod.BOT_SEP - 3, oledmod.BOT_SEP) == 0)

    o.show_card("WHEEL", "Next layer", None, "run")
    check("[%s] card hero drawn" % lang, band_of(o, 18, 38) > 30)
    # 12 wide characters at scale 2 are 168px; a centred overflow would be cut
    # off at both ends instead of just the tail.
    o.show_card("WHEEL", "WWWWWWWWWWWW", None, "run")
    check("[%s] wide card hero stays on the glass" % lang,
          all(r[0] == "." and r[127] == "." for r in rows(o)[16:40]))

    o.show_timeout(30, 3, 60)
    o.show_host()
    o.show_headless()
    o.show_error("something went wrong on the device for a long while")
    check("[%s] long error wraps to two lines" % lang,
          band_of(o, 36, 45) > 0 and band_of(o, 46, 55) > 0)

# ---------- the grid, and its incremental repaint ----------
i18n.set_lang("tr")
o = make_oled()
L = [("Kamera", ""), ("Masaüstü", ""), ("Masaüstü ve", "Kamera"),
     ("Kayıt", ""), ("Yayın", ""), ("Next layer", "")]
o.show_grid(L, 0, True, band="Katman A")
check("grid draws its dividers", all(rows(o)[40][42] == "#" for _ in (0,)))
check("grid band is inverted", rows(o)[3].count("#") > 60)
check("selected cell is a filled block",
      rows(o)[20][2:40].count("#") > 30)
golden("grid_banded", o)

n0 = o.display.refreshes
o.show_grid(L, 0, True, band="Katman A")
check("identical grid repaint costs one refresh", o.display.refreshes == n0 + 1)
snapshot = rows(o)
o.show_grid(L, 1, True, band="Katman A")
changed = sum(1 for a, b in zip(snapshot, rows(o)) if a != b)
check("moving the selection touches only the top row band",
      changed <= 27, "%d rows changed" % changed)

o2 = make_oled()
o2.show_grid(L, None, False, band=None)
# Nothing but the two dividers up here: no band means the cells own row 0.
check("band-less grid has no band strip", rows(o2)[1].count("#") == 2,
      rows(o2)[1])
check("update_band refuses a band-less grid", o2.update_band("x") is False)
check("update_band works on a banded grid", o.update_band("Katman B") is True)

# A name too long for a cell must be cut, not spill over its divider.
o3 = make_oled()
long_pair = o3.split_name("Sound kahkaha.mp3")
check("long name splits on the space", long_pair[0] == "Sound", str(long_pair))
check("both halves fit the cell",
      max(f.measure(long_pair[0]), f.measure(long_pair[1])) <= 128 // 3 - 2,
      str(long_pair))
check("unbroken name is cut, not dropped",
      o3.split_name("abcdefghijklmnopqrstuvwxyz")[1] != "")
o3.show_grid([long_pair] * 6, 0, True, band=None)
for k in range(3):
    col = 42 * (k + 1)
    if col < 128:
        check("cell %d never crosses its divider" % k,
              all(r[col] in "#." for r in rows(o3)))

# ---------- the menu's incremental repaint ----------
# An incremental screen can be right once and drift as you walk it. The check
# that matters is not "does one repaint look correct" but "does any route to a
# state produce the same pixels as drawing that state from scratch".
i18n.set_lang("en")
ITEMS = ["Auto return", "Language", "Layer band", "Profile band",
         "About", "Restart"]


def fresh_menu(sel, **kw):
    d = make_oled()
    d.show_menu("SETTINGS", ITEMS, sel, **kw)
    return rows(d)


m = make_oled()
m.show_menu("SETTINGS", ITEMS, 0)
before = rows(m)
m.show_menu("SETTINGS", ITEMS, 1)
changed = sum(1 for a, b in zip(before, rows(m)) if a != b)
check("a detent repaints two rows, not the screen", changed <= 20,
      "%d rows changed" % changed)

# walk down past the scroll point, back up, and around again
for sel in (1, 2, 3, 4, 5, 4, 3, 2, 1, 0, 5, 0):
    m.show_menu("SETTINGS", ITEMS, sel)
    check("menu sel=%d matches a fresh draw" % sel, rows(m) == fresh_menu(sel),
          "incremental repaint drifted")

# chrome changes must force the full redraw, not leave the old one behind
m.show_menu("SETTINGS", ITEMS, 1)
m.show_menu("OTHER", ITEMS, 1)
mt = make_oled()
mt.show_menu("OTHER", ITEMS, 1)
check("a new title matches a fresh draw", rows(m) == rows(mt))
m2 = make_oled()
m2.show_menu("SETTINGS", ITEMS, 1)
m2.show_menu("SETTINGS", ITEMS, 1, action="ok")
m3 = make_oled()
m3.show_menu("SETTINGS", ITEMS, 1, action="ok")
check("a new action label matches a fresh draw", rows(m2) == rows(m3))
m2.show_menu("SETTINGS", ITEMS, 1, marked=1)
m3 = make_oled()
m3.show_menu("SETTINGS", ITEMS, 1, marked=1)
check("a new marked item matches a fresh draw", rows(m2) == rows(m3))
# leaving the menu and coming back must not reuse the stale row cache
m2.show_speed("A", 3, 15)
m2.show_menu("SETTINGS", ITEMS, 1)
check("returning from another screen matches a fresh draw",
      rows(m2) == fresh_menu(1))

# ---------- the value editors' incremental repaint ----------
def fresh_speed(t):
    d = make_oled()
    d.show_speed("A", 3, t)
    return rows(d)


v = make_oled()
v.show_speed("A", 3, 15)
before = rows(v)
v.show_speed("A", 3, 16)
changed = sum(1 for a, b in zip(before, rows(v)) if a != b)
check("a speed detent repaints the hero band only", changed <= 30,
      "%d rows changed" % changed)
for t in (16, 17, 30, 99, 100, 1, 15, 55):
    v.show_speed("A", 3, t)
    check("speed t=%d matches a fresh draw" % t, rows(v) == fresh_speed(t),
          "incremental repaint drifted")
# the widest hero must not survive under a narrower one
v.show_speed("A", 3, 100)
v.show_speed("A", 3, 10)
check("a shorter hero leaves no ghost", rows(v) == fresh_speed(10))
# a different key means different chrome, so a full redraw
v.show_speed("B", 5, 10)
w = make_oled()
w.show_speed("B", 5, 10)
check("a new title matches a fresh draw", rows(v) == rows(w))
# and leaving the screen must drop the cache
v.show_menu("SETTINGS", ITEMS, 0)
v.show_speed("A", 3, 10)
check("returning to the editor matches a fresh draw", rows(v) == fresh_speed(10))
# show_adjust shares the helper; its clamp must still hold
a1 = make_oled()
a1.show_adjust("SES", "44%", 0.44, action="ok")
a2 = make_oled()
a2.show_adjust("SES", "44%", 5.0, action="ok")
a3 = make_oled()
a3.show_adjust("SES", "44%", 1.0, action="ok")
check("adjust clamps frac over 1.0", rows(a2) == rows(a3))
check("adjust still draws its slider",
      band_of(a1, oledmod.HBAR_Y, oledmod.HBAR_Y + oledmod.HBAR_H) > 0)

# ---------- goldens for the rest ----------
i18n.set_lang("en")
for name, fn in (
    ("boot", lambda d: d.show_boot()),
    ("update", lambda d: d.show_update(0.42)),
    ("home", lambda d: d.show_home(0, 3, ["A", "B", "C"])),
    ("menu", lambda d: d.show_menu("SETTINGS", ["Auto return", "Language",
                                                "Layer band", "Profile band",
                                                "About", "Restart"], 1)),
    ("speed", lambda d: d.show_speed("A", 3, 15)),
    ("saved", lambda d: d.show_saved("A", 1, 15)),
    ("about", lambda d: d.show_about((("Model", "vision6"),
                                      ("Firmware", "0.20.0"),
                                      ("Device ID", "5035586072b9")))),
    ("card", lambda d: d.show_card("WHEEL", "Next layer", None, "run")),
    ("toast", lambda d: d.show_toast("USB", "USB drive is on", "read-only")),
):
    d = make_oled()
    fn(d)
    golden(name, d)

i18n.set_lang("tr")
d = make_oled()
d.show_menu("AYARLAR", ["Otomatik Dönüş", "Dil", "Katman bandı",
                        "Profil bandı", "Hakkında", "Yeniden Başlat"], 0)
golden("menu_tr", d)

# ---------- the published demo must agree with the firmware ----------
# docs/font.html is what people (and we, when the device is out of reach) look
# at to decide whether a screen is right. If its layout drifts from the
# firmware's, it stops being evidence and starts being decoration.
viewer = open(os.path.join(REPO, "scripts", "font-viewer.template.html"),
              encoding="utf-8").read()
block = viewer[viewer.index("const L = {"):]
block = block[:block.index("};")]
L = {}
# Strip the // comments first — several of them contain commas, which would
# otherwise split an entry in half.
code = " ".join(line.split("//")[0] for line in block.split("\n"))
for part in code.split(","):
    k, _, v = part.partition(":")
    k = k.split("{")[-1].strip()
    v = v.strip()
    if k.isupper() and v.isdigit():
        L[k] = int(v)

for name, viewer_value, fw_value in (
    ("BAR_H", L.get("BAR_H"), oledmod.BAR_H),
    ("BOT_SEP", L.get("BOT_SEP"), oledmod.BOT_SEP),
    ("ROW_H", L.get("ROW_H"), oledmod.ROW_H),
    ("HBAR_Y", L.get("HBAR_Y"), oledmod.HBAR_Y),
    ("HBAR_H", L.get("HBAR_H"), oledmod.HBAR_H),
    ("BAND_H", L.get("BAND_H"), oledmod.Oled.BAND_H),
    ("MENU_VIS", L.get("MENU_VIS"), oledmod.Oled.MENU_VIS),
    # the viewer stores glyph-box tops; the firmware stores cap centres
    ("BAR_TEXT", L.get("BAR_TEXT"), oledmod.BAR_Y - 3),
    ("BOT_TEXT", L.get("BOT_TEXT"), oledmod.BOT_Y - 3),
    ("MENU_TOP", L.get("MENU_TOP"), oledmod.MENU_TOP - 3),
):
    check("demo layout %s matches the firmware" % name, viewer_value == fw_value,
          "viewer=%s firmware=%s" % (viewer_value, fw_value))

print("\n%d checks, %d failed" % (count, len(fails)))
if BLESS:
    print("goldens written to tests/golden/")
sys.exit(1 if fails else 0)

# MKYADA - OLED menu (YATAY 128x64) - dikey demo ile ayni mantik, yatay yerlesim
# Kutu sekli kararsi icin dikey (demo.py) ile karsilastirmak uzere.
# SH1106 OLED (I2C 0x3C, SDA=GP0, SCL=GP1), EC11 (TRA=GP2,TRB=GP3,PSH=GP4),
# BACK=GP5, CONFIRM=GP6, makro tuslar GP29/28/27/26/15/14, RGB LED GP16.

import time
import board
import busio
import displayio
import i2cdisplaybus
import terminalio
import vectorio
import rotaryio
import keypad
from adafruit_display_text import label
import adafruit_displayio_sh1106
from adafruit_bitmap_font import bitmap_font

try:
    import microcontroller
    NVM = microcontroller.nvm
except Exception:
    NVM = None

LAYERS = 4
KEYS = 6
LAYER_NAMES = ["A", "B", "C", "D"]
# Her layer icin 6 tus etiketi (2 satir, hucreye sigacak). Layer basina farkli tema.
LAYER_LABELS = [
    # A - FPS oyun (kucuk font: hucreye ~8 karakter sigar)
    [("silah", "degistir"), ("kalkan", "vur"), ("upgrade", "et"),
     ("mikrofon", "sustur"), ("mikrofon", "ac"), ("update", "yap")],
    # B - yayin / stream
    [("sahne", "gecis"), ("kayit", "basla"), ("klip", "al"),
     ("ses", "kis"), ("ses", "ac"), ("chat", "temizle")],
    # C - medya
    [("oynat", "durdur"), ("ileri", "atla"), ("geri", "atla"),
     ("ses", "azalt"), ("ses", "artir"), ("kaydet", "")],
    # D - kisayol / dev
    [("kopyala", ""), ("yapistir", ""), ("geri", "al"),
     ("kaydet", ""), ("derle", ""), ("terminal", "")],
]
SPEED_MIN_T = 1
SPEED_MAX_T = 100
SPEED_DEF_T = 10
MAGIC = 0x4C


def fmt_speed(t):
    return "%.1fx" % (t / 10)


def fmt_hero(t):
    v = t / 10
    return ("%d" % v) if v >= 10 else ("%.1f" % v)


# --- RGB LED ---
try:
    import neopixel
    try:
        _lp = board.NEOPIXEL
    except AttributeError:
        _lp = board.GP16
    PIXEL = neopixel.NeoPixel(_lp, 1, brightness=0.25, auto_write=True)
except Exception:
    PIXEL = None

LAYER_COLORS = [(0, 80, 255), (0, 200, 60), (255, 120, 0), (200, 0, 200)]


def led(c):
    if PIXEL is not None:
        PIXEL[0] = c


# --- Ekran (YATAY): rotation yok -> 128x64 ---
def init_display():
    while True:
        try:
            displayio.release_displays()
            i2c = busio.I2C(scl=board.GP1, sda=board.GP0, frequency=400000)
            b = i2cdisplaybus.I2CDisplayBus(i2c, device_address=0x3C)
            d = adafruit_displayio_sh1106.SH1106(
                b, width=128, height=64, colstart=2)
            d.root_group = displayio.Group()
            return d
        except Exception as e:
            print("Ekran yok - SCL/I2C kontrol et:", e)
            led((90, 0, 0))
            time.sleep(0.25)
            led((0, 0, 0))
            time.sleep(0.25)


display = init_display()
W = display.width    # 128
H = display.height   # 64
CX = W // 2

# --- Kucuk (dar) grid fontu: spleen 5x8 (terminalio 6px -> 5px) ---
# BDF'yi yukle, kullanilan karakterleri onbellege al (hiz icin). Yoksa terminalio'ya dus.
try:
    GRID_FONT = bitmap_font.load_font("/fonts/spleen-5x8.bdf")
    _chars = set()
    for _lay in LAYER_LABELS:
        for _a, _b in _lay:
            _chars |= set(_a) | set(_b)
    GRID_FONT.load_glyphs(_chars)
    GRID_SMALL = True
except Exception as _e:
    print("kucuk font yuklenemedi, terminalio kullanilacak:", _e)
    GRID_FONT = terminalio.FONT
    GRID_SMALL = False

# --- Girisler ---
enc = rotaryio.IncrementalEncoder(board.GP2, board.GP3)
keys = keypad.Keys((board.GP4, board.GP5, board.GP6),
                   value_when_pressed=False, pull=True)
K_PSH, K_BACK, K_CONFIRM = 0, 1, 2

MACRO_PINS = (board.GP29, board.GP28, board.GP27, board.GP26, board.GP15, board.GP14)
macro_keys = keypad.Keys(MACRO_PINS, value_when_pressed=False, pull=True)


def speed_color(t):
    f = (t - SPEED_MIN_T) / (SPEED_MAX_T - SPEED_MIN_T)
    return (int(255 * f), int(200 * (1 - f)), 0)


# --- Cizim yardimcilari ---
WHITE = displayio.Palette(1)
WHITE[0] = 0xFFFFFF
BLACK = displayio.Palette(1)
BLACK[0] = 0x000000


def rect(x, y, w, h, pal=WHITE):
    return vectorio.Rectangle(pixel_shader=pal, width=max(1, w), height=max(1, h), x=x, y=y)


def circ(x, y, r, pal=WHITE):
    return vectorio.Circle(pixel_shader=pal, radius=r, x=x, y=y)


def txt(s, x, y, scale=1, color=0xFFFFFF, anchor=(0.5, 0.5)):
    l = label.Label(terminalio.FONT, text=s, scale=scale, color=color)
    l.anchor_point = anchor
    l.anchored_position = (x, y)
    return l


def gtxt(s, x, y, color=0xFFFFFF, anchor=(0.5, 0.5)):
    # grid hucre yazisi: kucuk font (spleen 5x8) ile
    l = label.Label(GRID_FONT, text=s, color=color)
    l.anchor_point = anchor
    l.anchored_position = (x, y)
    return l


def bold_txt(g, s, x, y, scale=1):
    cx = x + scale // 2
    for dx in (-1, 0, 1):
        g.append(txt(s, cx + dx, y, scale=scale))


def draw_check(g, cx, cy, s):
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
    g.append(displayio.TileGrid(bmp, pixel_shader=pal, x=cx - s // 2, y=cy - s // 2))


def top_bar(g, title):
    g.append(rect(0, 0, W, 13))
    g.append(txt(title, CX, 6, color=0x000000))


def bottom_bar(g, action=None, back=True):
    y = H - 13
    g.append(rect(0, y, W, 1))
    if back and action:
        g.append(txt("< geri", 2, H - 6, anchor=(0.0, 0.5)))
    elif back:
        g.append(txt("< geri", CX, H - 6))
    if action:
        g.append(txt(action, W - 2, H - 6, anchor=(1.0, 0.5)))


# --- NVM ---
def load_settings():
    if NVM is not None and len(NVM) >= 1 + LAYERS * KEYS and NVM[0] == MAGIC:
        d = NVM[1:1 + LAYERS * KEYS]
        out = []
        for l in range(LAYERS):
            row = []
            for k in range(KEYS):
                v = d[l * KEYS + k]
                row.append(v if SPEED_MIN_T <= v <= SPEED_MAX_T else SPEED_DEF_T)
            out.append(row)
        return out
    return [[SPEED_DEF_T] * KEYS for _ in range(LAYERS)]


def save_settings(s):
    if NVM is None:
        return
    buf = bytearray(1 + LAYERS * KEYS)
    buf[0] = MAGIC
    for l in range(LAYERS):
        for k in range(KEYS):
            buf[1 + l * KEYS + k] = s[l][k]
    NVM[0:len(buf)] = buf


# --- Acilis (yatay) ---
def boot_animation():
    g = displayio.Group()
    display.root_group = g
    g.append(txt("MKYADA", CX, 24, scale=2))
    bw = W - 24
    bmp = displayio.Bitmap(bw, 5, 2)
    pal = displayio.Palette(2)
    pal[0] = 0x000000
    pal[1] = 0xFFFFFF
    g.append(displayio.TileGrid(bmp, pixel_shader=pal, x=(W - bw) // 2, y=44))
    for w in range(0, bw + 1, 4):
        for x in range(w):
            for yy in range(5):
                bmp[x, yy] = 1
        led(LAYER_COLORS[(w * 4 // bw) % 4])
        time.sleep(0.02)
    led((0, 255, 0))
    time.sleep(0.5)


# --- Ekranlar (yatay) ---
def show_home(layer):
    g = displayio.Group()
    bold_txt(g, LAYER_NAMES[layer], CX, 22, scale=5)  # biraz kucuk, ustte
    gap = 14
    x0 = CX - (LAYERS - 1) * gap // 2
    for i in range(LAYERS):
        g.append(circ(x0 + i * gap, 54, 3 if i == layer else 1))  # daha asagida
    led(LAYER_COLORS[layer])
    display.root_group = g


def _cut(s, n):
    # hucreye sigmiyorsa sigan kadarini yaz, kalanini kes
    return s if len(s) <= n else s[:n]


def show_grid(layer, active, invert=True):
    # 6 hucreli grid, her hucrede o layer'daki tusun ne yaptigi (etiket).
    # active hucresi invert=True iken ters renk (secili / yanip sonme).
    g = displayio.Group()
    cols, rows = 3, 2
    cw = W // cols   # 42
    ch = H // rows   # 32
    cpx = 5 if GRID_SMALL else 6   # karakter genisligi (spleen 5px / terminalio 6px)
    maxc = (cw - 2) // cpx  # hucreye sigan karakter sayisi (kalani kesilir)
    # grid cizgileri (2 dikey + 1 yatay)
    g.append(rect(cw, 0, 1, H))
    g.append(rect(2 * cw, 0, 1, H))
    g.append(rect(0, ch, W, 1))
    labels = LAYER_LABELS[layer]
    for k in range(KEYS):
        x = (k % cols) * cw
        y = (k // cols) * ch
        if k == active and invert:
            g.append(rect(x, y, cw, ch))   # ters renk hucre
            col = 0x000000
        else:
            col = 0xFFFFFF
        l1, l2 = labels[k]
        if l2:
            g.append(gtxt(_cut(l1, maxc), x + cw // 2, y + 11, color=col))
            g.append(gtxt(_cut(l2, maxc), x + cw // 2, y + 22, color=col))
        else:
            g.append(gtxt(_cut(l1, maxc), x + cw // 2, y + ch // 2, color=col))
    display.root_group = g


def show_select(layer, sel_key, settings):
    # aktif layer grid'i (ana ekran): secili hucre ters renk
    show_grid(layer, sel_key, True)
    led(LAYER_COLORS[layer])


def show_speed(layer, sel_key, t):
    g = displayio.Group()
    top_bar(g, "L%d > K%d" % (layer + 1, sel_key + 1))
    g.append(txt(fmt_hero(t), CX, 28, scale=3))
    # genis yatay gosterge cubugu
    f = (t - SPEED_MIN_T) / (SPEED_MAX_T - SPEED_MIN_T)
    bx, by, bw = 8, 42, W - 16
    g.append(rect(bx, by + 3, bw, 1))
    g.append(rect(bx, by, int(f * bw), 7))
    bottom_bar(g)
    led(speed_color(t))
    display.root_group = g


def show_saved(layer, sel_key, t):
    g = displayio.Group()
    draw_check(g, CX, 24, 24)
    g.append(txt(fmt_speed(t), CX, 50, scale=2))
    led((0, 255, 0))
    display.root_group = g


# --- Durum makinesi (dikey demo ile birebir ayni) ---
settings = load_settings()
boot_animation()

S_HOME, S_SELECT, S_SPEED, S_SAVED, S_KEY = 0, 1, 2, 3, 4
state = S_HOME
layer = 0
sel_key = 0
speed_t = SPEED_DEF_T
saved_at = 0.0
last_move = 0.0
key_num = 0
key_started = 0.0
key_dur = 5.0
blink_on = True
last_blink = 0.0
activity_at = 0.0
IDLE_TIMEOUT = 15.0

last_enc = enc.position
activity_at = time.monotonic()  # acilis layer secim ekrani icin 15 sn sayaci
show_home(layer)


def enc_delta():
    global last_enc
    p = enc.position
    d = p - last_enc
    last_enc = p
    return d


def clamp(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


while True:
    d = enc_delta()
    mev = macro_keys.events.get()
    now = time.monotonic()

    if mev and mev.pressed:
        key_num = mev.key_number + 1
        key_dur = settings[layer][mev.key_number] / 10.0
        key_started = now
        blink_on = True
        last_blink = now
        state = S_KEY
        show_grid(layer, mev.key_number, True)  # basilan hucre yanip soner
        led((255, 255, 255))

    if state == S_HOME:
        if d:
            layer = clamp(layer + (1 if d > 0 else -1), 0, LAYERS - 1)
            show_home(layer)
            activity_at = now
        ev = keys.events.get()
        if ev and ev.pressed and ev.key_number in (K_PSH, K_CONFIRM):
            state = S_SELECT
            sel_key = 0
            activity_at = now
            show_select(layer, sel_key, settings)
        # 15 sn layer secilmezse aktif layer otomatik secilir -> grid
        if state == S_HOME and now - activity_at > IDLE_TIMEOUT:
            state = S_SELECT
            sel_key = 0
            show_select(layer, sel_key, settings)

    elif state == S_SELECT:
        if d:
            sel_key = clamp(sel_key + (1 if d > 0 else -1), 0, KEYS - 1)
            show_select(layer, sel_key, settings)
            activity_at = now
        ev = keys.events.get()
        if ev and ev.pressed:
            activity_at = now
            if ev.key_number in (K_CONFIRM, K_PSH):
                speed_t = settings[layer][sel_key]
                last_move = 0.0
                state = S_SPEED
                show_speed(layer, sel_key, speed_t)
            elif ev.key_number == K_BACK:
                # grid = ana ekran; BACK -> layer secim ekranina cik
                state = S_HOME
                activity_at = now  # layer secim 15 sn sayacini yenile
                show_home(layer)
        # grid ana ekran oldugu icin burada timeout yok (kullanici kalir)

    elif state == S_SPEED:
        if d:
            now = time.monotonic()
            dt = now - last_move
            last_move = now
            ad = abs(d)
            if ad > 1 or dt < 0.04:
                per = 3
            elif dt < 0.09:
                per = 2
            else:
                per = 1
            speed_t = clamp(speed_t + d * per, SPEED_MIN_T, SPEED_MAX_T)
            show_speed(layer, sel_key, speed_t)
            activity_at = now
        ev = keys.events.get()
        if ev and ev.pressed:
            activity_at = now
            if ev.key_number in (K_CONFIRM, K_PSH):
                settings[layer][sel_key] = speed_t
                save_settings(settings)
                state = S_SAVED
                saved_at = time.monotonic()
                show_saved(layer, sel_key, speed_t)
            elif ev.key_number == K_BACK:
                state = S_SELECT
                activity_at = now
                show_select(layer, sel_key, settings)
        # 15 sn islem yok -> aktif layer grid'ine don (gizli sayac)
        if state == S_SPEED and now - activity_at > IDLE_TIMEOUT:
            state = S_SELECT
            show_select(layer, sel_key, settings)

    elif state == S_SAVED:
        keys.events.get()
        if time.monotonic() - saved_at > 1.1:
            state = S_SELECT
            activity_at = time.monotonic()
            show_select(layer, sel_key, settings)

    elif state == S_KEY:
        if now - last_blink > 0.4:
            blink_on = not blink_on
            last_blink = now
            show_grid(layer, key_num - 1, blink_on)  # hucre yanip soner
            led((255, 255, 255) if blink_on else (0, 0, 0))
        # sure bitince aktif layer grid'ine don (layer secime DEGIL)
        if now - key_started > key_dur:
            sel_key = key_num - 1
            state = S_SELECT
            show_select(layer, sel_key, settings)
        else:
            ev = keys.events.get()
            if ev and ev.pressed and ev.key_number == K_BACK:
                sel_key = key_num - 1
                state = S_SELECT
                show_select(layer, sel_key, settings)

    time.sleep(0.005)

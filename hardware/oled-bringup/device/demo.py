# MKYADA - OLED menu (DIKEY 64x128, encoder tepede) - urun tasarimi
# SH1106 OLED (I2C 0x3C, SDA=GP0, SCL=GP1), EC11 (TRA=GP2,TRB=GP3,PSH=GP4),
# BACK=GP5, CONFIRM=GP6, kart uzeri RGB LED (GP16)
#
# Tasarim:
#   - ust serit  : baglam (ana ekranda marka, alt ekranlarda "L1 > K3")
#   - orta       : kahraman deger (buyuk)
#   - alt serit  : buton aksiyonlari ("< geri" / "kaydet")
#   - tus secimi : 6 tusun hepsi + hizlari listede, secili ters renk
#   - hiz        : 0.1x adimlarla surekli (0.1x .. 10.0x), NVM'e kaydedilir

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

try:
    import microcontroller
    NVM = microcontroller.nvm
except Exception:
    NVM = None

LAYERS = 4
KEYS = 6
LAYER_NAMES = ["A", "B", "C", "D"]  # layer isimleri (harf)
SPEED_MIN_T = 1     # 0.1x
SPEED_MAX_T = 100   # 10.0x
SPEED_DEF_T = 10    # 1.0x
MAGIC = 0x4C


def fmt_speed(t):
    return "%.1fx" % (t / 10)


def fmt_hero(t):
    # hiz ekranindaki buyuk deger: 10.0 sigmiyor -> "10", digerleri "1.0"
    v = t / 10
    return ("%d" % v) if v >= 10 else ("%.1f" % v)


# --- RGB LED (once kur; ekran hatasinda kirmizi uyari icin gerekli) ---
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


# --- Ekran (dikey): SCL temassizsa cokme; tekrar dene + LED kirmizi uyari ---
def init_display():
    while True:
        try:
            displayio.release_displays()
            # 400kHz: tam kare gonderimi hizlanir -> ekran gecikmesi azalir
            i2c = busio.I2C(scl=board.GP1, sda=board.GP0, frequency=400000)
            b = i2cdisplaybus.I2CDisplayBus(i2c, device_address=0x3C)
            d = adafruit_displayio_sh1106.SH1106(
                b, width=128, height=64, colstart=2)
            d.rotation = 90   # dikey: constructor degil, property ile dondur
            d.root_group = displayio.Group()  # acilis RAM copunu/logo artigini temizle
            return d
        except Exception as e:
            print("Ekran yok - SCL/I2C kontrol et:", e)
            led((90, 0, 0))
            time.sleep(0.25)
            led((0, 0, 0))
            time.sleep(0.25)


display = init_display()
W = display.width    # 64
H = display.height   # 128
CX = W // 2

# --- Girisler ---
enc = rotaryio.IncrementalEncoder(board.GP2, board.GP3)
keys = keypad.Keys((board.GP4, board.GP5, board.GP6),
                   value_when_pressed=False, pull=True)
K_PSH, K_BACK, K_CONFIRM = 0, 1, 2

# 6 makro tusu (3V3 altinda sirali): K1=GP29 ... K6=GP14
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


def bold_txt(g, s, x, y, scale=1):
    # terminalio karakter hucrede hafif solda kalir -> saga kaydirip ortala
    # yatay smear (-1,0,1) = kalin gorunum
    cx = x + scale // 2
    for dx in (-1, 0, 1):
        g.append(txt(s, cx + dx, y, scale=scale))


def draw_check(g, cx, cy, s):
    # ekrana sigan bir check (tik) ikonu ciz (bitmap uzerine iki kalin cizgi)
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
    g.append(txt(title, CX, 6, color=0x000000))  # ortali


def bottom_bar(g, action=None, back=True):
    y = H - 13
    g.append(rect(0, y, W, 1))  # ayirici cizgi
    if back and action:
        g.append(txt("< geri", 2, H - 6, anchor=(0.0, 0.5)))
    elif back:
        g.append(txt("< geri", CX, H - 6))  # tek basina -> ortali
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


# --- Acilis ---
def boot_animation():
    g = displayio.Group()
    display.root_group = g
    # MKYADA direkt (animasyonsuz) + altinda loading bar; dikeyde ortali, yazi yok
    g.append(txt("MKYADA", CX, 56))
    bw = W - 16
    bmp = displayio.Bitmap(bw, 5, 2)
    pal = displayio.Palette(2)
    pal[0] = 0x000000
    pal[1] = 0xFFFFFF
    g.append(displayio.TileGrid(bmp, pixel_shader=pal, x=(W - bw) // 2, y=68))
    for w in range(0, bw + 1, 3):
        for x in range(w):
            for yy in range(5):
                bmp[x, yy] = 1
        led(LAYER_COLORS[(w * 4 // bw) % 4])
        time.sleep(0.02)
    led((0, 255, 0))
    time.sleep(0.5)


# --- Ekranlar ---
def show_home(layer):
    g = displayio.Group()
    # header/yazi yok: kocaman kalin layer harfi + 4 nav noktasi
    bold_txt(g, LAYER_NAMES[layer], CX, 54, scale=6)
    gap = 14
    x0 = CX - (LAYERS - 1) * gap // 2
    for i in range(LAYERS):
        g.append(circ(x0 + i * gap, 96, 3 if i == layer else 1))
    led(LAYER_COLORS[layer])
    display.root_group = g


def show_key(n, on):
    # makro tusu geri bildirimi: buyuk K<n> yanip soner (on=False -> bos ekran)
    g = displayio.Group()
    if on:
        bold_txt(g, "K%d" % n, CX, 58, scale=4)
        led((255, 255, 255))
    else:
        led((0, 0, 0))
    display.root_group = g


def show_select(layer, sel_key, settings):
    g = displayio.Group()
    # layer ekrani gibi: buyuk K no + altinda hiz + 6 nokta, ortali
    bold_txt(g, "K%d" % (sel_key + 1), CX, 42, scale=4)
    g.append(txt(fmt_speed(settings[layer][sel_key]), CX, 72, scale=1))
    gap = 10
    x0 = CX - (KEYS - 1) * gap // 2
    for k in range(KEYS):
        g.append(circ(x0 + k * gap, 92, 3 if k == sel_key else 1))
    bottom_bar(g)   # sadece geri
    led(LAYER_COLORS[layer])
    display.root_group = g


def show_speed(layer, sel_key, t):
    g = displayio.Group()
    top_bar(g, "L%d > K%d" % (layer + 1, sel_key + 1))
    g.append(txt(fmt_hero(t), CX, 50, scale=3))   # x yok, 10.0 -> 10
    # yatay gosterge cubugu (alt yazi yok)
    f = (t - SPEED_MIN_T) / (SPEED_MAX_T - SPEED_MIN_T)
    bx, by, bw = 6, 80, W - 12
    g.append(rect(bx, by + 3, bw, 1))               # iz
    g.append(rect(bx, by, int(f * bw), 7))          # dolu
    bottom_bar(g)   # sadece geri
    led(speed_color(t))
    display.root_group = g


def show_saved(layer, sel_key, t):
    g = displayio.Group()
    # yazi yerine check ikonu + altinda hiz
    draw_check(g, CX, 46, 26)
    g.append(txt(fmt_speed(t), CX, 84, scale=2))
    led((0, 255, 0))
    display.root_group = g


# --- Durum makinesi ---
settings = load_settings()
boot_animation()

S_HOME, S_SELECT, S_SPEED, S_SAVED, S_KEY = 0, 1, 2, 3, 4
state = S_HOME
layer = 0
sel_key = 0
speed_t = SPEED_DEF_T
saved_at = 0.0
last_move = 0.0   # hiz ayarinda ivme icin son cevirme zamani
key_num = 0       # gosterilen makro tusu
key_started = 0.0
key_dur = 5.0     # yanip sonme suresi = tusun hizi (saniye)
blink_on = True
last_blink = 0.0
activity_at = 0.0  # menu ekranlarinda son islem zamani (15 sn timeout)
IDLE_TIMEOUT = 15.0

last_enc = enc.position
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

    # makro tusu HER ekranda: acik menuyu iptal et, ana ekrana don ve
    # basilan tusu yanip sondur (menudeki degisiklik KAYDEDILMEZ)
    if mev and mev.pressed:
        key_num = mev.key_number + 1
        key_dur = settings[layer][mev.key_number] / 10.0  # hiz kadar saniye
        key_started = now
        blink_on = True
        last_blink = now
        state = S_KEY
        show_key(key_num, True)

    if state == S_HOME:
        if d:
            layer = clamp(layer + (1 if d > 0 else -1), 0, LAYERS - 1)
            show_home(layer)
        ev = keys.events.get()
        # tekere bas (PSH) VEYA CONFIRM -> hiz ayarina gir
        if ev and ev.pressed and ev.key_number in (K_PSH, K_CONFIRM):
            state = S_SELECT
            sel_key = 0
            activity_at = now
            show_select(layer, sel_key, settings)

    elif state == S_SELECT:
        if d:
            sel_key = clamp(sel_key + (1 if d > 0 else -1), 0, KEYS - 1)
            show_select(layer, sel_key, settings)
            activity_at = now
        ev = keys.events.get()
        if ev and ev.pressed:
            activity_at = now
            # CONFIRM veya tekere basma -> sec
            if ev.key_number in (K_CONFIRM, K_PSH):
                speed_t = settings[layer][sel_key]
                last_move = 0.0
                state = S_SPEED
                show_speed(layer, sel_key, speed_t)
            elif ev.key_number == K_BACK:
                state = S_HOME
                show_home(layer)
        # 15 sn islem yok -> ana menu (gizli sayac)
        if state == S_SELECT and now - activity_at > IDLE_TIMEOUT:
            state = S_HOME
            show_home(layer)

    elif state == S_SPEED:
        if d:
            # ivme: biriken tik sayisi (|d|) VEYA tiklar-arasi sure (dt) hizi verir.
            # cizim gecikmesinde tikler birikir -> |d| buyur -> buyuk sicrama.
            now = time.monotonic()
            dt = now - last_move
            last_move = now
            ad = abs(d)
            if ad > 1 or dt < 0.04:
                per = 3        # hizli ceviriyor: tik basina 0.3x
            elif dt < 0.09:
                per = 2        # orta
            else:
                per = 1        # yavas = hassas 0.1x
            speed_t = clamp(speed_t + d * per, SPEED_MIN_T, SPEED_MAX_T)
            show_speed(layer, sel_key, speed_t)
            activity_at = now
        ev = keys.events.get()
        if ev and ev.pressed:
            activity_at = now
            # CONFIRM veya tekere basma -> kaydet
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
        # 15 sn islem yok -> ana menu (gizli sayac)
        if state == S_SPEED and now - activity_at > IDLE_TIMEOUT:
            state = S_HOME
            show_home(layer)

    elif state == S_SAVED:
        keys.events.get()
        if time.monotonic() - saved_at > 1.1:
            state = S_SELECT
            activity_at = time.monotonic()
            show_select(layer, sel_key, settings)

    elif state == S_KEY:
        # yanip sonme
        if now - last_blink > 0.4:
            blink_on = not blink_on
            last_blink = now
            show_key(key_num, blink_on)
        # tusun hizi kadar saniye sonra ana ekrana don (yeni tus basimi sifirlar)
        if now - key_started > key_dur:
            state = S_HOME
            show_home(layer)
        else:
            ev = keys.events.get()
            if ev and ev.pressed and ev.key_number == K_BACK:
                state = S_HOME
                show_home(layer)

    time.sleep(0.005)

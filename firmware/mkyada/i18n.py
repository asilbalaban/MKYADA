# Device UI language. config.json "lang" ("en" | "tr") picks the table;
# changeable both from the app (Setup) and on the device (Settings > Language,
# which rewrites config.json so both sides always agree).
#
# The Turkish table is written in real Turkish. It used to be ASCII-folded
# ("Yazi Tipi", "OTOMATIK DONUS") because the bundled BDF fonts covered basic
# Latin only; MKYADA's own font draws all twelve Turkish letters, so the
# folding is gone. mkyada/font.py still folds anything it does NOT have (a
# macro name with an acute accent), so nothing ever silently disappears.

LANGS = ("en", "tr")
LANG_DESC = ("English", "Türkçe")
DEFAULT_LANG = "en"

STRINGS = {
    "en": {
        "loading": "loading",
        "back": "< back",
        "save": "save",
        "select": "select",
        "settings": "SETTINGS",
        "auto_return": "Auto return",
        "language": "Language",
        "show_layer": "Layer band",
        "show_profile": "Profile band",
        "on": "on",
        "off": "off",
        "layer_band": "Layer %s",
        "about": "About",
        "about_title": "ABOUT",
        "model": "Model",
        "firmware": "Firmware",
        "device_id": "Device ID",
        "restart": "Restart",
        # Added with the redesigned menu.
        "wheel_layers": "Wheel layers",
        "boot_disp": "display",
        "boot_cfg": "profiles",
        "boot_hid": "USB HID",
        "update_title": "FIRMWARE UPDATE",
        "sec_unit": "SEC",
        "idle_t": "IDLE",
        "live_t": "LIVE",
        "rec_t": "REC",
        "scene_t": "SCENE",
        "speed": "speed",
        "auto_return_title": "AUTO RETURN",
        "lang_title": "SETTINGS > LANGUAGE",
        "host": "Connected to app",
        "menu_fail": "menu unavailable",
        "menu_fail_hint": "reinstall from app",
        "err_title": "error - see serial log",
        "no_macro": "no macro on this key",
        "assign_app": "assign one in the app",
        "usb_on": "USB drive is on",
        "read_only": "read-only - use the app",
        "save_fail": "could not save",
        # two short lines: the 128px band fits ~21 characters, and the one-line
        # version ran off both edges of the screen (issue #35)
        "updating": "updating",
        "updating2": "do not unplug",
        "restarting": "restarting...",
        "setup_test": "SETUP - TEST",
        "press_key": "press a key",
        "keys_test": "KEY TEST",
        "pixel_test": "Pixel test",
        "pixel_hint": "any button: back",
        "keys_test_paused": "Macros paused",
        "keys_test_switch": "Use another tab",
        # Settings > Key test — the same check with no app attached
        "key_test": "Key test",
        "test_press": "press a key or turn",
        "hold_exit": "hold PSH: exit",
        # context-aware wheel menu (issue: wheel-menu redesign)
        "wheel": "WHEEL",
        "key_t": "KEY",
        "media": "MEDIA",
        "volume": "VOLUME",
        "bright": "BRIGHTNESS",
        "scroll_t": "SCROLL",
        "run_t": "ACTION",
        "run": "run",
        "hint_repeat": "turn: repeat",
        "hint_track": "turn: track",
        "hint_vol": "turn: volume",
        "hint_bright": "turn: bright",
        "hint_scroll": "turn: scroll",
        "app_needed": "MKYADA app required",
        "open_app": "open it on the computer",
        "no_assign": "no action here",
        "assigned": "assigned",
        "hold_set": "hold: assign",
        "menu_t": "LAYER",
        "mic_t": "MIC",
    },
    "tr": {
        "loading": "yükleniyor",
        "back": "< geri",
        "save": "kaydet",
        "select": "seç",
        "settings": "AYARLAR",
        "auto_return": "Otomatik Dönüş",
        "language": "Dil",
        "show_layer": "Katman bandı",
        "show_profile": "Profil bandı",
        "on": "açık",
        "off": "kapalı",
        "layer_band": "Katman %s",
        "about": "Hakkında",
        "about_title": "HAKKINDA",
        "model": "Model",
        "firmware": "Yazılım",
        "device_id": "Cihaz No",
        "restart": "Yeniden Başlat",
        # Yeni menüyle gelenler.
        "wheel_layers": "Tekerle katman",
        "boot_disp": "ekran",
        "boot_cfg": "profiller",
        "boot_hid": "USB HID",
        "update_title": "YAZILIM GÜNCELLEME",
        "sec_unit": "SN",
        "idle_t": "BOŞTA",
        "live_t": "YAYINDA",
        "rec_t": "KAYIT",
        "scene_t": "SAHNE",
        "speed": "hız",
        "auto_return_title": "OTOMATİK DÖNÜŞ",
        "lang_title": "AYARLAR > DİL",
        "host": "Uygulamaya bağlı",
        "menu_fail": "menü yüklenemedi",
        "menu_fail_hint": "uygulamadan yükleyin",
        "err_title": "hata - seri kayda bak",
        "no_macro": "bu tuşta makro yok",
        "assign_app": "uygulamadan atayın",
        "usb_on": "USB disk açık",
        "read_only": "salt okunur - uygulamayı kullan",
        "save_fail": "kaydedilemedi",
        "updating": "güncelleniyor",
        "updating2": "fişi çekmeyin",
        "restarting": "yeniden başlatılıyor",
        "setup_test": "KURULUM - TEST",
        "press_key": "bir tuşa bas",
        "keys_test": "TUŞ TESTİ",
        "pixel_test": "Piksel testi",
        "pixel_hint": "herhangi bir tuş: geri",
        "keys_test_paused": "Makrolar durduruldu",
        "keys_test_switch": "Başka sekme kullan",
        "key_test": "Tuş testi",
        "test_press": "tuşa bas veya çevir",
        "hold_exit": "PSH tut: çık",
        # context-aware wheel menu (issue: wheel-menu redesign)
        "wheel": "TEKER",
        "key_t": "TUŞ",
        "media": "MEDYA",
        "volume": "SES",
        "bright": "PARLAKLIK",
        "scroll_t": "KAYDIR",
        "run_t": "EYLEM",
        "run": "çalıştır",
        "hint_repeat": "çevir: tekrarla",
        "hint_track": "çevir: parça",
        "hint_vol": "çevir: ses",
        "hint_bright": "çevir: parlaklık",
        "hint_scroll": "çevir: kaydır",
        "app_needed": "MKYADA uygulaması gerekli",
        "open_app": "bilgisayarda aç",
        "no_assign": "burada atama yok",
        "assigned": "atandı",
        "hold_set": "tut: ata",
        "menu_t": "KATMAN",
        "mic_t": "MİKROFON",
    },
}

_lang = DEFAULT_LANG


def set_lang(lang):
    global _lang
    _lang = lang if lang in LANGS else DEFAULT_LANG


def get_lang():
    return _lang


def tr(key):
    table = STRINGS.get(_lang) or STRINGS[DEFAULT_LANG]
    return table.get(key) or STRINGS[DEFAULT_LANG].get(key, key)


def upper(s):
    """Uppercase the way the UI language wants it.

    str.upper() is locale-blind: it maps Turkish "i" to "I", so the device drew
    "HATA - SERI KAYDA BAK" where Turkish spells it "SERİ". Turkish is the one
    language here that needs the dotted/dotless pair handled, and only two
    characters are involved, so the fix is two replaces rather than a case
    table the board would have to carry.

    ("ı".upper() is already "I", so only the "i" -> "İ" direction needs help;
    the second replace is there for text that mixes both.)"""
    s = str(s)
    if _lang == "tr":
        s = s.replace("i", "İ").replace("ı", "I")
    return s.upper()

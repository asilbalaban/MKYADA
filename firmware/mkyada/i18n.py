# Device UI language. config.json "lang" ("en" | "tr") picks the table;
# changeable both from the app (Setup) and on the device (Settings > Language,
# which rewrites config.json so both sides always agree).
#
# Turkish strings are ASCII-safe on purpose: the bundled BDF fonts cover
# basic Latin only, so dotted/undotted Turkish letters would render as
# missing glyphs.

LANGS = ("en", "tr")
LANG_DESC = ("English", "Turkce")
DEFAULT_LANG = "en"

STRINGS = {
    "en": {
        "loading": "loading",
        "back": "< back",
        "save": "save",
        "select": "select",
        "settings": "SETTINGS",
        "font": "Font",
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
        "speed": "speed",
        "auto_return_title": "AUTO RETURN",
        "font_title": "SETTINGS > FONT",
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
        "updating": "updating - do not unplug",
        "restarting": "restarting...",
        "setup_test": "SETUP - TEST",
        "press_key": "press a key",
        "keys_test": "KEY TEST",
        "keys_test_paused": "Macros paused",
        "keys_test_switch": "Use another tab",
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
        "loading": "yukleniyor",
        "back": "< geri",
        "save": "kaydet",
        "select": "sec",
        "settings": "AYARLAR",
        "font": "Yazi Tipi",
        "auto_return": "Otomatik Donus",
        "language": "Dil",
        "show_layer": "Katman bandi",
        "show_profile": "Profil bandi",
        "on": "acik",
        "off": "kapali",
        "layer_band": "Katman %s",
        "about": "Hakkinda",
        "about_title": "HAKKINDA",
        "model": "Model",
        "firmware": "Yazilim",
        "device_id": "Cihaz No",
        "restart": "Yeniden Baslat",
        "speed": "hiz",
        "auto_return_title": "OTOMATIK DONUS",
        "font_title": "AYARLAR > YAZI TIPI",
        "lang_title": "AYARLAR > DIL",
        "host": "Uygulamaya bagli",
        "menu_fail": "menu yuklenemedi",
        "menu_fail_hint": "uygulamadan yukleyin",
        "err_title": "hata - seri kayda bak",
        "no_macro": "bu tusta macro yok",
        "assign_app": "uygulamadan atayin",
        "usb_on": "USB disk acik",
        "read_only": "salt okunur - uygulamayi kullan",
        "save_fail": "kaydedilemedi",
        "updating": "guncelleniyor - fisi cekmeyin",
        "restarting": "yeniden baslatiliyor...",
        "setup_test": "KURULUM - TEST",
        "press_key": "bir tusa bas",
        "keys_test": "TUS TESTI",
        "keys_test_paused": "Makrolar durduruldu",
        "keys_test_switch": "Baska sekme kullan",
        # context-aware wheel menu (issue: wheel-menu redesign)
        "wheel": "TEKER",
        "key_t": "TUS",
        "media": "MEDYA",
        "volume": "SES",
        "bright": "PARLAKLIK",
        "scroll_t": "KAYDIR",
        "run_t": "EYLEM",
        "run": "calistir",
        "hint_repeat": "cevir: tekrarla",
        "hint_track": "cevir: parca",
        "hint_vol": "cevir: ses",
        "hint_bright": "cevir: parlaklik",
        "hint_scroll": "cevir: kaydir",
        "app_needed": "MKYADA uygulamasi gerekli",
        "open_app": "bilgisayarda ac",
        "no_assign": "burada atama yok",
        "assigned": "atandi",
        "hold_set": "tut: ata",
        "menu_t": "KATMAN",
        "mic_t": "MIKROFON",
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

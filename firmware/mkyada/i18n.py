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

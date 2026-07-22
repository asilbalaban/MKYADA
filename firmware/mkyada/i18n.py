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
        "restart": "Restart",
        "speed": "speed",
        "auto_return_title": "AUTO RETURN",
        "font_title": "SETTINGS > FONT",
        "lang_title": "SETTINGS > LANGUAGE",
        "host": "Connected to app",
        "err_title": "error - see serial log",
        "no_macro": "no macro on this key",
        "assign_app": "assign one in the app",
        "usb_on": "USB drive is on",
        "read_only": "read-only - use the app",
        "save_fail": "could not save",
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
        "restart": "Yeniden Baslat",
        "speed": "hiz",
        "auto_return_title": "OTOMATIK DONUS",
        "font_title": "AYARLAR > YAZI TIPI",
        "lang_title": "AYARLAR > DIL",
        "host": "Uygulamaya bagli",
        "err_title": "hata - seri kayda bak",
        "no_macro": "bu tusta macro yok",
        "assign_app": "uygulamadan atayin",
        "usb_on": "USB disk acik",
        "read_only": "salt okunur - uygulamayi kullan",
        "save_fail": "kaydedilemedi",
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

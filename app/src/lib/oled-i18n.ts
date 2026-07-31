// The Vision 6's own UI strings. GENERATED — do not edit.
//
// Source:    firmware/mkyada/i18n.py
// Generator: node scripts/build-oled-i18n.mjs
//
// The screens are laid out around how wide these are, so the demo page and
// the app's preview have to use the device's exact wording — a Turkish label
// that grows by four pixels in the firmware and not here would make both
// quietly stop being evidence.

export const LANGS = ["en", "tr"] as const;
export type Lang = (typeof LANGS)[number];
export const LANG_DESC: Record<Lang, string> = {
  en: "English",
  tr: "Türkçe",
};
export const DEFAULT_LANG: Lang = "en";

export const STRINGS: Record<Lang, Record<string, string>> = {
  en: {
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
    "updating": "updating",
    "updating2": "do not unplug",
    "restarting": "restarting...",
    "transfer_title": "DATA TRANSFER",
    "transfer": "app is writing files",
    "transfer2": "keys paused",
    "setup_test": "SETUP - TEST",
    "press_key": "press a key",
    "keys_test": "KEY TEST",
    "pixel_test": "Pixel test",
    "pixel_hint": "any button: back",
    "keys_test_paused": "Macros paused",
    "keys_test_switch": "Use another tab",
    "key_test": "Key test",
    "test_press": "press a key or turn",
    "hold_exit": "hold PSH: exit",
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
  tr: {
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
    "transfer_title": "VERİ AKTARIMI",
    "transfer": "uygulama yazıyor",
    "transfer2": "tuşlar duraklatıldı",
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
};

let current: Lang = DEFAULT_LANG;

/** Switch the language the screens draw in. Unknown values fall back to the
 * default, the same way the firmware's set_lang does. */
export function setLang(l: string | null | undefined): Lang {
  current = (LANGS as readonly string[]).includes(l ?? '') ? (l as Lang) : DEFAULT_LANG;
  return current;
}

export function getLang(): Lang {
  return current;
}

/** One string. An unknown key echoes itself rather than drawing nothing —
 * matching the firmware, so a missing string is visible on the glass. */
export function tr(key: string): string {
  return STRINGS[current][key] ?? STRINGS[DEFAULT_LANG][key] ?? key;
}

/** Uppercase the way the UI language wants it — the same two replaces
 * firmware/mkyada/i18n.py does, NOT toLocaleUpperCase. Locale-aware casing
 * would be a third behaviour: the point is to draw exactly what the glass
 * draws, and the board has no locale tables. */
export function upper(s: string): string {
  let t = String(s);
  if (current === 'tr') t = t.replace(/i/g, '\u0130').replace(/\u0131/g, 'I');
  return t.toUpperCase();
}

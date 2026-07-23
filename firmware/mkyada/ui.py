# Vision 6 menu module: EC11 encoder + PSH/BACK/CONFIRM buttons driving the
# OLED screens in mkyada/oled.py. Non-blocking — App.run_loop() calls tick()
# every iteration; playback never waits on the UI.
#
# Default interaction (the bring-up demo, productionized):
#   home     encoder scrolls layer letters + SETTINGS, PSH/CONFIRM enters
#   grid     the active layer's 6 macro names; encoder selects a cell,
#            CONFIRM opens that key's speed editor, BACK returns home
#   speed    encoder edits 0.1x-10.0x, CONFIRM persists it into the key's
#            macro file (settings.speed) — the app sees the same value
# Custom slots (macros/enc-cw.json etc., written by the app) override the
# resting grid: rotation/BACK/CONFIRM then play their macros, and PSH opens
# a temporary "select mode" with the default navigation. Menus themselves
# always navigate normally, so settings stay reachable.
#
# NVM keeps only UI prefs: [magic, font_idx, idle_secs, last_layer].
# Macro speeds live in the macro files — single source of truth.

import gc
import json
import os
import time

import board
import keypad
import rotaryio

try:
    import microcontroller
except Exception:
    microcontroller = None
try:
    NVM = microcontroller.nvm if microcontroller else None
except Exception:
    NVM = None

from mkyada import i18n
from mkyada.i18n import tr
from mkyada.models import MODELS, UI_SLOTS
from mkyada.oled import FONTS, FONT_DESC, DEFAULT_FONT_IDX, fmt_speed

LAYER_NAMES = "abcdefgh"

MAGIC = 0x4E
NVM_LEN = 4

SPEED_MIN_T, SPEED_MAX_T, SPEED_DEF_T = 1, 100, 10
TMO_MIN, TMO_MAX, DEFAULT_TIMEOUT = 3, 60, 10

K_PSH, K_BACK, K_CONFIRM = 0, 1, 2
NAV_SLOT = ("psh", "back", "confirm")  # host-mode event names

(S_HOME, S_SELECT, S_SPEED, S_SAVED, S_SET_MENU, S_FONT, S_TIMEOUT,
 S_PLAYING, S_HOST, S_TOAST, S_LANG) = range(11)

SET_FONT, SET_TMO, SET_LANG, SET_REBOOT = 0, 1, 2, 3


def set_items():
    return (tr("font"), tr("auto_return"), tr("language"), tr("restart"))

SAVED_DWELL_S = 1.1
TOAST_DWELL_S = 1.6
META_MAX_WHOLE = 4096  # parse pretty-printed files only up to this size


def clamp(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


class Ui:
    def __init__(self, app, oled):
        self.app = app
        self.oled = oled
        m = MODELS[app.model]
        ea, eb = m["encoder"]
        self.enc = rotaryio.IncrementalEncoder(getattr(board, ea),
                                               getattr(board, eb))
        self.nav = keypad.Keys(tuple(getattr(board, n) for n in m["nav"]),
                               value_when_pressed=False, pull=True)
        self.last_enc = self.enc.position

        i18n.set_lang(app.config.get("lang"))
        self.font_idx, self.idle_secs, last_layer = self._nvm_load()
        self.lang_sel = 0
        self.state = S_HOME
        self.prev_state = S_HOME  # where to return after host mode / toast
        self.home_pos = 0
        self.sel_key = 0
        self.sel_mode = False  # temporary default-nav mode on a custom grid
        self.speed_t = SPEED_DEF_T
        self.set_menu_sel = 0
        self.font_sel = 0
        self.tmo_val = self.idle_secs
        self.saved_at = 0.0
        self.toast_at = 0.0
        self.last_move = 0.0
        self.activity_at = time.monotonic()
        self.playing_cell = None
        self._pending_layer = clamp(last_layer, 0,
                                    app.config["layer_count"] - 1)
        self._enc_batch = 0  # host mode: accumulated detents
        self._labels = {}  # layer -> [(l1, l2)] * 6
        self._speeds = {}  # (layer, key0) -> tenths
        self._slots = {}   # layer -> {slot: path or None}

    # --- NVM prefs ---
    def _nvm_load(self):
        if NVM is not None and len(NVM) >= NVM_LEN and NVM[0] == MAGIC:
            fi, tmo, lyr = NVM[1], NVM[2], NVM[3]
            if not 0 <= fi < len(FONTS):
                fi = DEFAULT_FONT_IDX
            if not TMO_MIN <= tmo <= TMO_MAX:
                tmo = DEFAULT_TIMEOUT
            if not 0 <= lyr < len(LAYER_NAMES):
                lyr = 0
            return fi, tmo, lyr
        return DEFAULT_FONT_IDX, DEFAULT_TIMEOUT, 0

    def _nvm_save(self):
        if NVM is None:
            return
        try:
            NVM[0:NVM_LEN] = bytes((MAGIC, self.font_idx, self.idle_secs,
                                    self.app.layer))
        except Exception:
            pass

    # --- labels / speeds / slots (lazy per layer) ---
    def _read_meta(self, path):
        """(name, speed_tenths) from a macro file's header without loading
        events: stream files carry both in line 1, legacy app files are one
        line anyway; small pretty-printed files get a full parse."""
        try:
            size = os.stat(path)[6]
        except OSError:
            return None, SPEED_DEF_T
        data = None
        try:
            with open(path, "rb") as f:
                try:
                    data = json.loads(f.readline())
                except ValueError:
                    if size <= META_MAX_WHOLE:
                        f.seek(0)
                        data = json.load(f)
        except (OSError, ValueError, MemoryError):
            data = None
        if not isinstance(data, dict):
            return None, SPEED_DEF_T
        name = data.get("name")
        speed = (data.get("settings") or {}).get("speed", 1.0)
        try:
            t = clamp(int(round(float(speed) * 10)), SPEED_MIN_T, SPEED_MAX_T)
        except (TypeError, ValueError):
            t = SPEED_DEF_T
        return (name if isinstance(name, str) and name else None), t

    def _split_name(self, name):
        cw = 128 // 3
        maxc = (cw - 2) // self.oled.grid_cpx
        name = name.strip()
        if len(name) <= maxc:
            return (name, "")
        cut = name.rfind(" ", 0, maxc + 1)
        if cut <= 0:
            return (name[:maxc], name[maxc:maxc * 2])
        return (name[:cut], name[cut + 1:])

    def _exists(self, path):
        try:
            os.stat(path)
            return True
        except OSError:
            return False

    def load_layer(self, l):
        labels = []
        chars = set()
        for k in range(1, 7):
            name, t = self._read_meta(self.app.macro_path_for(k, l))
            self._speeds[(l, k - 1)] = t
            pair = self._split_name(name or ("K%d" % k))
            labels.append(pair)
            chars |= set(pair[0]) | set(pair[1])
        self._labels[l] = labels
        self.oled.ensure_glyphs("".join(chars))
        slots = {}
        for s in UI_SLOTS:
            p = self.app.slot_path(s, l)
            if not self._exists(p):
                p0 = self.app.slot_path(s, 0)
                p = p0 if (l != 0 and self._exists(p0)) else None
            slots[s] = p
        self._slots[l] = slots
        gc.collect()

    def labels(self, l):
        if l not in self._labels:
            self.load_layer(l)
        return self._labels[l]

    def slots(self, l):
        if l not in self._slots:
            self.load_layer(l)
        return self._slots[l]

    def speed_tenths(self, l, key0):
        if (l, key0) not in self._speeds:
            self.load_layer(l)
        return self._speeds.get((l, key0), SPEED_DEF_T)

    def invalidate_labels(self, path=None):
        """A macro file changed (app upload / delete). Drop the affected
        layer's cache; None drops everything."""
        if path is None:
            layers = list(self._labels.keys()) + list(self._slots.keys())
        else:
            name = path.rsplit("/", 1)[-1]
            if name.endswith(".json"):
                name = name[:-5]
            l = 0
            if "-" in name:
                suffix = name.rsplit("-", 1)[-1]
                if len(suffix) == 1 and suffix in LAYER_NAMES:
                    l = LAYER_NAMES.index(suffix)
            layers = [l]
            if l == 0:
                layers = list(set([0] + list(self._slots.keys())))  # slot fallback
        for l in set(layers):
            self._labels.pop(l, None)
            self._slots.pop(l, None)
            for k in range(6):
                self._speeds.pop((l, k), None)
        if self.state == S_SELECT and self.app.layer in set(layers):
            self._draw_grid()

    # --- speed persistence ---
    def persist_speed(self, l, key0, tenths):
        """Rewrite settings.speed inside the key's macro file. Returns
        "ok" | "missing" | "readonly" | "error"."""
        path = self.app.macro_path_for(key0 + 1, l)
        tmp = path + ".part"
        speed = tenths / 10.0
        gc.collect()  # a big recorded macro gets rewritten below; start clean
        try:
            f = open(path, "rb")
        except OSError:
            return "missing"
        try:
            line = f.readline()
            try:
                data = json.loads(line)
                stream = isinstance(data, dict) and data.get("stream")
            except ValueError:
                data = None
                stream = False
            if data is None:
                try:
                    size = os.stat(path)[6]
                    if size > META_MAX_WHOLE:
                        return "error"
                    f.seek(0)
                    data = json.load(f)
                except (ValueError, MemoryError, OSError):
                    return "error"
            if not isinstance(data, dict):
                return "error"
            s = dict(data.get("settings") or {})
            s["speed"] = speed
            data["settings"] = s
            try:
                out = open(tmp, "wb")
            except OSError as e:
                return "readonly" if (e.args and e.args[0] == 30) else "error"
            try:
                out.write(json.dumps(data).encode("utf-8"))
                if stream:
                    out.write(b"\n")
                    while True:
                        chunk = f.read(1024)
                        if not chunk:
                            break
                        out.write(chunk)
            finally:
                out.close()
        except (OSError, MemoryError):
            try:
                os.remove(tmp)
            except OSError:
                pass
            return "error"
        finally:
            f.close()
        try:
            os.remove(path)
        except OSError:
            pass
        try:
            os.rename(tmp, path)
        except OSError:
            return "error"
        self._speeds[(l, key0)] = tenths
        self.app.proto.send({"t": "macro_changed", "file": path,
                             "reason": "speed"})
        return "ok"

    # --- hooks from App ---
    def start(self):
        """First draw; runs once from App.run_loop()."""
        self.oled.boot_progress(1.0)
        if self._pending_layer:
            self.app.set_layer_idx(self._pending_layer)  # re-enters on_layer
        l = self.app.layer
        self.oled.load_grid_font(self.font_idx, self._glyphs_for(l))
        self._labels.clear()  # re-split with the real font metrics
        # Boot straight into the last active layer's macro grid, not the layer
        # picker: the common case is "use the keypad", and the picker still
        # sits one BACK away. Avoids the boot-time picker feeling stuck while
        # the first layer's labels load.
        self.home_pos = l
        self.sel_key = 0
        self.sel_mode = False
        self.state = S_SELECT
        self.activity_at = time.monotonic()
        self._draw_grid()

    def _glyphs_for(self, l):
        pairs = self.labels(l)
        return "".join(a + b for a, b in pairs)

    def on_layer(self):
        if self.state in (S_HOME, S_SELECT):
            self.sel_key = 0
            self.sel_mode = False
            if self.state == S_SELECT:
                self._draw_grid()
            else:
                self.home_pos = self.app.layer
                self._draw_home()

    def on_reload(self):
        i18n.set_lang(self.app.config.get("lang"))
        self._labels.clear()
        self._speeds.clear()
        self._slots.clear()
        self.sel_key = 0
        self.sel_mode = False
        if self.state not in (S_HOST, S_PLAYING):
            self.state = S_SELECT
            self._draw_grid()

    def on_mode(self, mode):
        if mode == "host":
            if self.state != S_HOST:
                self.prev_state = S_SELECT
                self.state = S_HOST
                self.oled.show_host()
        elif self.state == S_HOST:
            self.state = S_SELECT
            self._drain_inputs()
            self._draw_grid()

    def on_play_start(self, trigger, path):
        # Only a physical macro-key press changes the screen; encoder-slot
        # and host-commanded plays leave it alone (they can fire fast, and a
        # full SH1106 refresh per detent would crawl).
        if trigger is None or self.state == S_HOST:
            return
        key_no = self.app.config["key_map"][trigger]
        self.playing_cell = key_no - 1
        self.state = S_PLAYING
        self.oled.show_grid(self.labels(self.app.layer), self.playing_cell, True)

    def on_play_done(self):
        self._drain_inputs()  # inputs queued during playback are stale
        if self.state == S_PLAYING:
            self.sel_key = self.playing_cell or 0
            self.playing_cell = None
            self.state = S_SELECT
            self._draw_grid()

    # --- input plumbing ---
    def _enc_delta(self):
        p = self.enc.position
        d = p - self.last_enc
        self.last_enc = p
        return d

    def _drain_inputs(self):
        self.last_enc = self.enc.position
        while self.nav.events.get():
            pass

    def _play_slot(self, slot):
        path = self.slots(self.app.layer).get(slot)
        if path:
            self.app.play_file(path, trigger=None)
            return True
        return False

    # --- drawing shortcuts ---
    def _draw_home(self):
        c = self.app.config["layer_count"]
        self.oled.show_home(self.home_pos, c, LAYER_NAMES[:c])
        if self.home_pos < c:
            self.app.led.set(layer=self.home_pos)  # preview color
        else:
            self.app.led.set(layer=self.app.layer)

    def _draw_grid(self):
        l = self.app.layer
        invert = self.sel_mode or not self._grid_custom()
        self.oled.show_grid(self.labels(l), self.sel_key, invert)

    def _grid_custom(self):
        s = self.slots(self.app.layer)
        return bool(s.get("enc-cw") or s.get("enc-ccw"))

    def _enter_grid(self):
        self.sel_mode = False
        self.state = S_SELECT
        self._draw_grid()

    def _enter_speed(self):
        l = self.app.layer
        self.speed_t = self.speed_tenths(l, self.sel_key)
        self.last_move = 0.0
        self.state = S_SPEED
        self.oled.show_speed(LAYER_NAMES[l], self.sel_key + 1, self.speed_t)

    def _toast(self, title, line1, line2=""):
        self.state = S_TOAST
        self.toast_at = time.monotonic()
        self.oled.show_toast(title, line1, line2)

    # --- per-state handlers ---
    def tick(self, now):
        if self.state == S_HOST:
            self._tick_host()
            return
        if self.state == S_PLAYING:
            return  # playback owns the loop; on_play_done() restores us
        d = self._enc_delta()
        ev = self.nav.events.get()
        press = ev.key_number if (ev and ev.pressed) else None
        if d or press is not None:
            self.activity_at = now

        if self.state == S_HOME:
            self._st_home(now, d, press)
        elif self.state == S_SELECT:
            self._st_select(now, d, press)
        elif self.state == S_SPEED:
            self._st_speed(now, d, press)
        elif self.state == S_SAVED:
            if now - self.saved_at > SAVED_DWELL_S:
                self._enter_grid()
        elif self.state == S_TOAST:
            if press is not None or now - self.toast_at > TOAST_DWELL_S:
                self._enter_grid()
        elif self.state == S_SET_MENU:
            self._st_set_menu(now, d, press)
        elif self.state == S_FONT:
            self._st_font(now, d, press)
        elif self.state == S_TIMEOUT:
            self._st_timeout(now, d, press)
        elif self.state == S_LANG:
            self._st_lang(now, d, press)

    def _tick_host(self):
        """Forward encoder/nav to the app; it performs the assigned actions
        (soundboard, OBS, ...) computer-side."""
        d = self._enc_delta()
        if d:
            self.app.proto.send({"t": "enc", "d": 1 if d > 0 else -1,
                                 "n": abs(d)})
        while True:
            ev = self.nav.events.get()
            if not ev:
                break
            self.app.proto.send({"t": "btn", "slot": NAV_SLOT[ev.key_number],
                                 "down": bool(ev.pressed)})

    def _st_home(self, now, d, press):
        c = self.app.config["layer_count"]
        if d:
            self.home_pos = clamp(self.home_pos + (1 if d > 0 else -1), 0, c)
            self._draw_home()
        if press in (K_PSH, K_CONFIRM):
            if self.home_pos == c:  # SETTINGS
                self.set_menu_sel = 0
                self.state = S_SET_MENU
                self.oled.show_menu(tr("settings"), set_items(), 0)
            else:
                self.app.set_layer_idx(self.home_pos)
                self._nvm_save()
                self._enter_grid()
        elif press == K_BACK:
            self._enter_grid()
        elif now - self.activity_at > self.idle_secs:
            self._enter_grid()  # idle returns to the confirmed layer's grid

    def _go_home(self):
        self.sel_mode = False
        self.home_pos = self.app.layer
        self.state = S_HOME
        self._draw_home()

    def _st_select(self, now, d, press):
        slots = self.slots(self.app.layer)
        custom = self._grid_custom()  # any slot assigned on this layer
        nav_live = self.sel_mode or not custom
        if d:
            enc_custom = (not nav_live) and (slots.get("enc-cw")
                                             or slots.get("enc-ccw"))
            if enc_custom:
                # custom encoder: one play per detent, direction-mapped
                slot = "enc-cw" if d > 0 else "enc-ccw"
                for _ in range(min(abs(d), 4)):  # cap a fast spin burst
                    if not self._play_slot(slot):
                        break
            else:
                self.sel_key = clamp(self.sel_key + (1 if d > 0 else -1), 0, 5)
                self._draw_grid()
        if press is None:
            if self.sel_mode and now - self.activity_at > self.idle_secs:
                self.sel_mode = False  # back to the customized resting grid
                self._draw_grid()
            return
        if press == K_PSH:
            if custom:
                # PSH is the guaranteed menu key on a customized grid:
                # toggles the temporary default-navigation "select mode"
                self.sel_mode = not self.sel_mode
                self._draw_grid()
            else:
                self._enter_speed()
        elif press == K_CONFIRM:
            if nav_live:
                self._enter_speed()
            elif not self._play_slot("btn-confirm"):
                self._enter_speed()
        elif press == K_BACK:
            if nav_live:
                self._go_home()
            elif not self._play_slot("btn-back"):
                self._go_home()

    def _st_speed(self, now, d, press):
        if d:
            dt = now - self.last_move
            self.last_move = now
            ad = abs(d)
            per = 3 if (ad > 1 or dt < 0.04) else (2 if dt < 0.09 else 1)
            self.speed_t = clamp(self.speed_t + d * per, SPEED_MIN_T, SPEED_MAX_T)
            self.oled.show_speed(LAYER_NAMES[self.app.layer], self.sel_key + 1,
                                 self.speed_t)
        if press in (K_PSH, K_CONFIRM):
            res = self.persist_speed(self.app.layer, self.sel_key, self.speed_t)
            if res == "ok":
                self.state = S_SAVED
                self.saved_at = now
                self.oled.show_saved(LAYER_NAMES[self.app.layer],
                                     self.sel_key + 1, self.speed_t)
            elif res == "missing":
                self._toast(tr("speed").upper(), tr("no_macro"), tr("assign_app"))
            elif res == "readonly":
                self._toast(tr("speed").upper(), tr("usb_on"), tr("read_only"))
            else:
                self._toast(tr("speed").upper(), tr("save_fail"), "")
        elif press == K_BACK:
            self._enter_grid()
        elif now - self.activity_at > self.idle_secs:
            self._enter_grid()

    def _st_set_menu(self, now, d, press):
        if d:
            self.set_menu_sel = clamp(self.set_menu_sel + (1 if d > 0 else -1),
                                      0, len(set_items()) - 1)
            self.oled.show_menu(tr("settings"), set_items(), self.set_menu_sel)
        if press in (K_PSH, K_CONFIRM):
            if self.set_menu_sel == SET_FONT:
                self.font_sel = self.font_idx
                self.state = S_FONT
                self.oled.show_menu(tr("font_title"), FONT_DESC,
                                    self.font_sel, marked=self.font_idx)
            elif self.set_menu_sel == SET_TMO:
                self.tmo_val = self.idle_secs
                self.last_move = 0.0
                self.state = S_TIMEOUT
                self.oled.show_timeout(self.tmo_val, TMO_MIN, TMO_MAX)
            elif self.set_menu_sel == SET_LANG:
                self.lang_sel = i18n.LANGS.index(i18n.get_lang())
                self.state = S_LANG
                self.oled.show_menu(tr("lang_title"), i18n.LANG_DESC,
                                    self.lang_sel, marked=self.lang_sel)
            elif microcontroller:
                microcontroller.reset()
        elif press == K_BACK:
            self.home_pos = self.app.config["layer_count"]
            self.state = S_HOME
            self._draw_home()
        elif now - self.activity_at > self.idle_secs:
            self._enter_grid()

    def _st_font(self, now, d, press):
        if d:
            self.font_sel = clamp(self.font_sel + (1 if d > 0 else -1),
                                  0, len(FONTS) - 1)
            self.oled.show_menu(tr("font_title"), FONT_DESC, self.font_sel,
                                marked=self.font_idx)
        if press in (K_PSH, K_CONFIRM):
            self.font_idx = self.font_sel
            self.oled.load_grid_font(self.font_idx,
                                     self._glyphs_for(self.app.layer))
            self._labels.clear()  # re-split for the new char width
            self._nvm_save()
            self._enter_grid()
        elif press == K_BACK:
            self.state = S_SET_MENU
            self.oled.show_menu(tr("settings"), set_items(), self.set_menu_sel)
        elif now - self.activity_at > self.idle_secs:
            self._enter_grid()

    def persist_lang(self, lang):
        """Rewrite config.json "lang" so the app sees the same choice.
        Returns "ok" | "readonly" | "error"."""
        path = "/config.json"
        tmp = path + ".part"
        try:
            with open(path) as f:
                data = json.load(f)
            if not isinstance(data, dict):
                data = {}
        except (OSError, ValueError, MemoryError):
            data = {}
        data["lang"] = lang
        try:
            with open(tmp, "w") as f:
                json.dump(data, f)
            try:
                os.remove(path)
            except OSError:
                pass
            os.rename(tmp, path)
        except OSError as e:
            try:
                os.remove(tmp)
            except OSError:
                pass
            return "readonly" if (e.args and e.args[0] == 30) else "error"
        self.app.config["lang"] = lang
        i18n.set_lang(lang)
        self.app.send_config()  # a connected app refreshes its Setup view
        return "ok"

    def _st_lang(self, now, d, press):
        if d:
            self.lang_sel = clamp(self.lang_sel + (1 if d > 0 else -1),
                                  0, len(i18n.LANGS) - 1)
            self.oled.show_menu(tr("lang_title"), i18n.LANG_DESC, self.lang_sel,
                                marked=i18n.LANGS.index(i18n.get_lang()))
        if press in (K_PSH, K_CONFIRM):
            res = self.persist_lang(i18n.LANGS[self.lang_sel])
            if res == "ok":
                self.state = S_SET_MENU
                self.oled.show_menu(tr("settings"), set_items(), self.set_menu_sel)
            elif res == "readonly":
                self._toast(tr("language").upper(), tr("usb_on"), tr("read_only"))
            else:
                self._toast(tr("language").upper(), tr("save_fail"), "")
        elif press == K_BACK:
            self.state = S_SET_MENU
            self.oled.show_menu(tr("settings"), set_items(), self.set_menu_sel)
        elif now - self.activity_at > self.idle_secs:
            self._enter_grid()

    def _st_timeout(self, now, d, press):
        if d:
            dt = now - self.last_move
            self.last_move = now
            per = 3 if (abs(d) > 1 or dt < 0.05) else 1
            self.tmo_val = clamp(self.tmo_val + d * per, TMO_MIN, TMO_MAX)
            self.oled.show_timeout(self.tmo_val, TMO_MIN, TMO_MAX)
        if press in (K_PSH, K_CONFIRM):
            self.idle_secs = self.tmo_val
            self._nvm_save()
            self.state = S_SET_MENU
            self.oled.show_menu(tr("settings"), set_items(), self.set_menu_sel)
        elif press == K_BACK:
            self.state = S_SET_MENU
            self.oled.show_menu(tr("settings"), set_items(), self.set_menu_sel)
        elif now - self.activity_at > self.idle_secs:
            self._enter_grid()

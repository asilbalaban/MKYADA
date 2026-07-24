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
# resting grid: rotation/BACK/CONFIRM/PSH then play their macros, and the
# menus keep default navigation. Each menu context can be overridden on its
# own too (issue #19): macros/<slot>@home.json applies on the layer picker,
# macros/<slot>@menu.json inside settings. Button slots may carry key-logic
# variants (double / hold) resolved here from nav events; a "menu"-kind
# assignment drives the BUILT-IN navigation (never other custom slots).
# Escape hatch: on a customized grid PSH toggles a temporary default-nav
# "select mode"; with PSH itself assigned, holding it ESC_HOLD_S does —
# unless the user deliberately gave PSH its own hold action (then the menu
# stays reachable via keys mapped to menu actions, or the app).
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
# nav key -> its assignable slot name (standalone custom assignments)
NAV_SLOTS = {K_PSH: "btn-psh", K_BACK: "btn-back", K_CONFIRM: "btn-confirm"}
# PSH held this long toggles select mode when its slot has no hold variant —
# past the 400 ms variant default so an assigned hold still wins cleanly
ESC_HOLD_S = 1.2

(S_HOME, S_SELECT, S_SPEED, S_SAVED, S_SET_MENU, S_FONT, S_TIMEOUT,
 S_PLAYING, S_HOST, S_TOAST, S_LANG) = range(11)

(SET_FONT, SET_TMO, SET_LANG, SET_BAND_LAYER, SET_BAND_PROFILE,
 SET_REBOOT) = range(6)

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
        self._slots = {}   # layer -> {slot: meta dict or None} (grid context)
        self._ctx_slots = {}  # "home" / "menu" -> {slot: meta dict or None}
        self._injecting = 0  # >0 while a macro key drives the menu (inject)

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

    def _node(self, d):
        """Classify what an assignment (macro dict) does when it fires:
        ("menu", action) drives the built-in navigation, ("play",) plays
        the macro file. None for an absent/invalid variant."""
        if not isinstance(d, dict):
            return None
        if d.get("kind") == "menu":
            return ("menu", d.get("menu") or "default")
        return ("play",)

    def _read_slot_meta(self, path):
        """What a slot file's tap/double/hold gestures do, parsed from the
        header line without loading events (same cost as _read_meta).
        Returns a meta dict, or None when the file doesn't exist."""
        try:
            size = os.stat(path)[6]
        except OSError:
            return None
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
            data = {}
        variants = data.get("variants")
        if data.get("stream") or not isinstance(variants, dict):
            variants = {}  # stream files never carry variants
        s = data.get("settings") or {}
        return {"path": path,
                "tap": self._node(data) or ("play",),
                "double": self._node(variants.get("double")),
                "hold": self._node(variants.get("hold")),
                "hold_s": (s.get("hold_ms") or 400) / 1000.0,
                "double_s": (s.get("double_ms") or 250) / 1000.0}

    def _set_items(self):
        cfg = self.app.config
        return (tr("font"), tr("auto_return"), tr("language"),
                "%s: %s" % (tr("show_layer"),
                            tr("on") if cfg["show_layer"] else tr("off")),
                "%s: %s" % (tr("show_profile"),
                            tr("on") if cfg["show_profile"] else tr("off")),
                tr("restart"))

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
            slots[s] = self._read_slot_meta(p) if p else None
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

    def ctx_slots(self, ctx):
        """Per-context nav overrides ("home" = layer picker, "menu" =
        settings): macros/<slot>@<ctx>.json — global files, no layers."""
        if ctx not in self._ctx_slots:
            slots = {}
            for s in UI_SLOTS:
                slots[s] = self._read_slot_meta(self.app.slot_ctx_path(s, ctx))
            self._ctx_slots[ctx] = slots
        return self._ctx_slots[ctx]

    def speed_tenths(self, l, key0):
        if (l, key0) not in self._speeds:
            self.load_layer(l)
        return self._speeds.get((l, key0), SPEED_DEF_T)

    def invalidate_labels(self, path=None):
        """A macro file changed (app upload / delete). Drop the affected
        layer's cache; None drops everything."""
        if path is None:
            layers = list(self._labels.keys()) + list(self._slots.keys())
            self._ctx_slots.clear()
        else:
            name = path.rsplit("/", 1)[-1]
            if name.endswith(".json"):
                name = name[:-5]
            if "@" in name:
                # context override (enc-cw@home) — global, not layered
                self._ctx_slots.pop(name.rsplit("@", 1)[-1], None)
                return
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

    def on_label(self):
        """The app pushed (or cleared) its profile label / key names."""
        if self.state == S_HOST:
            self._draw_host()
        elif self.state == S_SELECT and self.app.config["show_profile"]:
            self._draw_grid()

    def _draw_host(self):
        """Host-mode screen: the active profile's six key names as a grid
        (pushed by the app in the "label" message, proto v6) so the user
        sees what the keys do — not just that an app owns them. Falls back
        to the plain "Connected to app" text when the app sent no names."""
        keys = self.app.host_keys
        if not keys:
            self.oled.show_host()
            return
        labels = []
        chars = set()
        for i in range(6):
            name = keys[i] if i < len(keys) and keys[i] else "K%d" % (i + 1)
            pair = self._split_name(name)
            labels.append(pair)
            chars |= set(pair[0]) | set(pair[1])
        self.oled.ensure_glyphs("".join(chars))
        self.oled.show_grid(labels, None, False, band=self._band())

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
        self._ctx_slots.clear()
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
                self._draw_host()
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
        self.oled.show_grid(self.labels(self.app.layer), self.playing_cell, True,
                            band=self._band())

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

    def _toggle_sel_mode(self):
        self.sel_mode = not self.sel_mode
        if self.state == S_SELECT:
            self._draw_grid()

    def _resolve_nav(self, key, has_double, has_hold, hold_s, double_s):
        """Blocking tap/double/hold pick for a nav button — the counterpart
        of App.resolve_variant, fed by keypad events instead of Buttons.
        Zero added latency when only a tap exists (callers skip this)."""
        t0 = time.monotonic()
        while True:
            if has_hold and time.monotonic() - t0 >= hold_s:
                return "hold"
            ev = self.nav.events.get()
            if ev and ev.key_number == key and not ev.pressed:
                break
            self.app.led.tick()
            time.sleep(0.002)
        if not has_double:
            return "tap"
        t1 = time.monotonic()
        while time.monotonic() - t1 < double_s:
            ev = self.nav.events.get()
            if ev and ev.key_number == key and ev.pressed:
                return "double"
            self.app.led.tick()
            time.sleep(0.002)
        return "tap"

    def _run_node(self, node, meta, choice, now, default, dflt):
        """Fire one resolved slot gesture. A "menu"-kind assignment drives
        the BUILT-IN navigation (never another custom slot — no recursion);
        its "default" action means whatever this input does out of the box."""
        if node[0] == "menu":
            act = node[1]
            if act == "left":
                default(now, -1, None)
            elif act == "right":
                default(now, 1, None)
            elif act == "confirm":
                default(now, 0, K_CONFIRM)
            elif act == "back":
                default(now, 0, K_BACK)
            else:
                dflt()
        else:
            self.app.play_file(meta["path"], trigger=None, variant=choice)

    def _custom_input(self, now, d, press, slots, default):
        """Layer a context's custom slot assignments over its built-in
        (now, d, press) handler. Select mode bypasses every assignment;
        injected menu actions (macro keys) resolve as plain taps — there
        is no physical press whose release could be waited on."""
        if d:
            cw = ccw = None
            if not self.sel_mode:
                cw = slots.get("enc-cw")
                ccw = slots.get("enc-ccw")
            if cw or ccw:
                meta = cw if d > 0 else ccw
                if meta:  # other direction of a half-assigned wheel: no-op
                    step = 1 if d > 0 else -1
                    for _ in range(min(abs(d), 4)):  # cap a fast spin burst
                        self._run_node(meta["tap"], meta, "tap", now, default,
                                       lambda: default(now, step, None))
            else:
                default(now, d, None)
        if press is None:
            return
        meta = None if self.sel_mode else slots.get(NAV_SLOTS.get(press))
        if not meta:
            default(now, 0, press)
            return
        esc = press == K_PSH and not self._injecting  # PSH hold escape
        has_hold = bool(meta["hold"]) or esc
        choice = "tap"
        if not self._injecting and (has_hold or meta["double"]):
            choice = self._resolve_nav(press, bool(meta["double"]), has_hold,
                                       meta["hold_s"] if meta["hold"]
                                       else ESC_HOLD_S, meta["double_s"])
        if choice == "hold" and not meta["hold"]:
            self._toggle_sel_mode()  # the escape, not an assignment
            return
        node = meta.get(choice) or meta["tap"]
        self._run_node(node, meta, choice, now, default,
                       lambda: default(now, 0, press))

    # --- drawing shortcuts ---
    def _draw_home(self):
        c = self.app.config["layer_count"]
        self.oled.show_home(self.home_pos, c, LAYER_NAMES[:c])
        if self.home_pos < c:
            self.app.led.set(layer=self.home_pos)  # preview color
        else:
            self.app.led.set(layer=self.app.layer)

    def _band(self):
        """Status-strip text over the grid, or None. Layer part is always
        device-known; the profile part is whatever label the app last
        pushed (t:"label") and vanishes with the app."""
        cfg = self.app.config
        label = self.app.host_label if cfg["show_profile"] else None
        if cfg["show_layer"]:
            letter = LAYER_NAMES[self.app.layer].upper()
            if label:
                return "%s: %s" % (letter, label)
            return tr("layer_band") % letter
        return label

    def _draw_grid(self):
        l = self.app.layer
        invert = self.sel_mode or not self._enc_custom()
        self.oled.show_grid(self.labels(l), self.sel_key, invert,
                            band=self._band())

    def _enc_custom(self):
        """Wheel rotation is customized — the selection highlight rests."""
        s = self.slots(self.app.layer)
        return bool(s.get("enc-cw") or s.get("enc-ccw"))

    def _grid_custom(self):
        """Any grid slot assigned: PSH becomes the select-mode toggle."""
        s = self.slots(self.app.layer)
        for k in UI_SLOTS:
            if s.get(k):
                return True
        return False

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
        self._dispatch(now, d, press)

    def inject(self, action):
        """A macro key mapped to a device-menu action drives the UI as if the
        encoder or CONFIRM/BACK were used (menu left/right/confirm/back)."""
        if self.state in (S_HOST, S_PLAYING):
            return  # menu nav is meaningless while playing / app-owned
        now = time.monotonic()
        self._injecting += 1
        try:
            if action == "left":
                self._dispatch(now, -1, None)
            elif action == "right":
                self._dispatch(now, 1, None)
            elif action == "confirm":
                self._dispatch(now, 0, K_CONFIRM)
            elif action == "back":
                self._dispatch(now, 0, K_BACK)
        finally:
            self._injecting -= 1

    def _dispatch(self, now, d, press):
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
        self._custom_input(now, d, press, self.ctx_slots("home"),
                           self._home_default)
        if not d and press is None and now - self.activity_at > self.idle_secs:
            self._enter_grid()  # idle returns to the confirmed layer's grid

    def _home_default(self, now, d, press):
        c = self.app.config["layer_count"]
        if d:
            self.home_pos = clamp(self.home_pos + (1 if d > 0 else -1), 0, c)
            self._draw_home()
        if press in (K_PSH, K_CONFIRM):
            if self.home_pos == c:  # SETTINGS
                self.set_menu_sel = 0
                self.state = S_SET_MENU
                self.oled.show_menu(tr("settings"), self._set_items(), 0)
            else:
                self.app.set_layer_idx(self.home_pos)
                self._nvm_save()
                self._enter_grid()
        elif press == K_BACK:
            self._enter_grid()

    def _go_home(self):
        # sel_mode survives into home/menus: entered as the escape from a
        # customized grid, it must keep navigation default until the user
        # lands back on the grid (issue #19)
        self.home_pos = self.app.layer
        self.state = S_HOME
        self._draw_home()

    def _st_select(self, now, d, press):
        self._custom_input(now, d, press, self.slots(self.app.layer),
                           self._select_default)
        if (not d and press is None and self.sel_mode
                and now - self.activity_at > self.idle_secs):
            self.sel_mode = False  # back to the customized resting grid
            self._draw_grid()

    def _select_default(self, now, d, press):
        if d:
            self.sel_key = clamp(self.sel_key + (1 if d > 0 else -1), 0, 5)
            self._draw_grid()
        if press == K_PSH:
            if self._grid_custom():
                # PSH is the guaranteed menu key on a customized grid:
                # toggles the temporary default-navigation "select mode"
                self._toggle_sel_mode()
            else:
                self._enter_speed()
        elif press == K_CONFIRM:
            self._enter_speed()
        elif press == K_BACK:
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
        self._custom_input(now, d, press, self.ctx_slots("menu"),
                           self._set_menu_default)
        if not d and press is None and now - self.activity_at > self.idle_secs:
            self._enter_grid()

    def _set_menu_default(self, now, d, press):
        if d:
            self.set_menu_sel = clamp(self.set_menu_sel + (1 if d > 0 else -1),
                                      0, len(self._set_items()) - 1)
            self.oled.show_menu(tr("settings"), self._set_items(), self.set_menu_sel)
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
            elif self.set_menu_sel in (SET_BAND_LAYER, SET_BAND_PROFILE):
                key = ("show_layer" if self.set_menu_sel == SET_BAND_LAYER
                       else "show_profile")
                title = tr(key).upper()
                res = self.persist_cfg({key: not self.app.config[key]})
                if res == "ok":
                    self.oled.show_menu(tr("settings"), self._set_items(),
                                        self.set_menu_sel)
                elif res == "readonly":
                    self._toast(title, tr("usb_on"), tr("read_only"))
                else:
                    self._toast(title, tr("save_fail"), "")
            elif microcontroller:
                microcontroller.reset()
        elif press == K_BACK:
            self.home_pos = self.app.config["layer_count"]
            self.state = S_HOME
            self._draw_home()

    def _st_font(self, now, d, press):
        self._custom_input(now, d, press, self.ctx_slots("menu"),
                           self._font_default)
        if not d and press is None and now - self.activity_at > self.idle_secs:
            self._enter_grid()

    def _font_default(self, now, d, press):
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
            self.oled.show_menu(tr("settings"), self._set_items(), self.set_menu_sel)

    def persist_cfg(self, updates):
        """Merge updates into config.json (and the live config) so the app
        always sees the same values. Returns "ok" | "readonly" | "error"."""
        path = "/config.json"
        tmp = path + ".part"
        try:
            with open(path) as f:
                data = json.load(f)
            if not isinstance(data, dict):
                data = {}
        except (OSError, ValueError, MemoryError):
            data = {}
        data.update(updates)
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
        self.app.config.update(updates)
        self.app.send_config()  # a connected app refreshes its view
        return "ok"

    def persist_lang(self, lang):
        """Rewrite config.json "lang" so the app sees the same choice.
        Returns "ok" | "readonly" | "error"."""
        res = self.persist_cfg({"lang": lang})
        if res == "ok":
            i18n.set_lang(lang)
        return res

    def _st_lang(self, now, d, press):
        self._custom_input(now, d, press, self.ctx_slots("menu"),
                           self._lang_default)
        if not d and press is None and now - self.activity_at > self.idle_secs:
            self._enter_grid()

    def _lang_default(self, now, d, press):
        if d:
            self.lang_sel = clamp(self.lang_sel + (1 if d > 0 else -1),
                                  0, len(i18n.LANGS) - 1)
            self.oled.show_menu(tr("lang_title"), i18n.LANG_DESC, self.lang_sel,
                                marked=i18n.LANGS.index(i18n.get_lang()))
        if press in (K_PSH, K_CONFIRM):
            res = self.persist_lang(i18n.LANGS[self.lang_sel])
            if res == "ok":
                self.state = S_SET_MENU
                self.oled.show_menu(tr("settings"), self._set_items(), self.set_menu_sel)
            elif res == "readonly":
                self._toast(tr("language").upper(), tr("usb_on"), tr("read_only"))
            else:
                self._toast(tr("language").upper(), tr("save_fail"), "")
        elif press == K_BACK:
            self.state = S_SET_MENU
            self.oled.show_menu(tr("settings"), self._set_items(), self.set_menu_sel)

    def _st_timeout(self, now, d, press):
        self._custom_input(now, d, press, self.ctx_slots("menu"),
                           self._timeout_default)
        if not d and press is None and now - self.activity_at > self.idle_secs:
            self._enter_grid()

    def _timeout_default(self, now, d, press):
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
            self.oled.show_menu(tr("settings"), self._set_items(), self.set_menu_sel)
        elif press == K_BACK:
            self.state = S_SET_MENU
            self.oled.show_menu(tr("settings"), self._set_items(), self.set_menu_sel)

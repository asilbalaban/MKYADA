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
# how long the device waits for the app to answer a host-kind CONFIRM with a
# `menu` before giving up and showing the "app required" toast
CTX_WAIT_S = 1.5

(S_HOME, S_SELECT, S_SPEED, S_SAVED, S_SET_MENU, S_FONT, S_TIMEOUT,
 S_PLAYING, S_HOST, S_TOAST, S_LANG, S_TEST, S_ABOUT, S_CTX) = range(14)

# media usages the wheel treats as a "turn to adjust" knob rather than a
# single transport key (see _enter_ctx). Volume rotates up/down, CONFIRM mutes.
VOL_USAGES = ("volume_up", "volume_down", "mute")
BRIGHT_USAGES = ("brightness_up", "brightness_down")

# the media wheel menu is a browser of every consumer usage: turn to highlight
# one, tap to fire it once, hold to reassign the key to it (issue: wheel-menu
# grammar). Order is the on-screen list order.
MEDIA_OPTS = ("play_pause", "next_track", "prev_track", "stop", "mute",
              "volume_up", "volume_down", "brightness_up", "brightness_down")
MEDIA_LABEL = {"play_pause": "Play/Pause", "next_track": "Next",
               "prev_track": "Prev", "stop": "Stop", "mute": "Mute",
               "volume_up": "Vol +", "volume_down": "Vol -",
               "brightness_up": "Bright +", "brightness_down": "Bright -"}

# menu-kind (layer / nav) options the wheel browser offers: switch layers or
# jump to a screen. The absolute layer_a.. entries are appended per device from
# layer_count. All are runnable on-device with no host, so the browser reassigns
# standalone just like the media one (issue: layer keys only ran "next layer").
MENU_FIXED_OPTS = ("layer_next", "layer_prev", "home", "grid", "settings")
MENU_LABEL = {"layer_next": "Next layer", "layer_prev": "Prev layer",
              "home": "Home", "grid": "Grid", "settings": "Settings"}

# how long CONFIRM/PSH must be held inside a menu to mean "assign" (vs a tap =
# "do it once"). Matches the key-logic hold default.
MENU_HOLD_S = 0.4

(SET_FONT, SET_TMO, SET_LANG, SET_BAND_LAYER, SET_BAND_PROFILE,
 SET_ABOUT, SET_REBOOT) = range(7)

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
        if app.config.get("enc_swap"):
            ea, eb = eb, ea  # encoder soldered backwards: flip CW/CCW
        self.enc = rotaryio.IncrementalEncoder(getattr(board, ea),
                                               getattr(board, eb))
        nav_pins = app.config.get("nav") or m["nav"]
        self.nav = keypad.Keys(tuple(getattr(board, n) for n in nav_pins),
                               value_when_pressed=False, pull=True)
        self.last_enc = self.enc.position

        i18n.set_lang(app.config.get("lang"))
        self.font_idx, self.idle_secs, last_layer = self._nvm_load()
        # config.json can carry font/timeout (the app-facing mirror). When it
        # does, it wins over NVM so a value set from the app applies; either
        # way we publish the resolved values into app.config so hello reports
        # them without waiting for the first on-device change.
        cf = app.config.get("font")
        if isinstance(cf, int) and 0 <= cf < len(FONTS):
            self.font_idx = cf
        ct = app.config.get("timeout")
        if isinstance(ct, int) and TMO_MIN <= ct <= TMO_MAX:
            self.idle_secs = ct
        app.config["font"] = self.font_idx
        app.config["timeout"] = self.idle_secs
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
        self.ctx = None  # active context-menu (S_CTX) descriptor
        self._degraded_at = 0  # last degraded-grid repair repaint
        self._blink_at = 0  # last (R)/(L) band-marker blink flip
        self._blink_on = True
        self.sysvol = None  # live system output volume % pushed by the app
        self._pending_layer = clamp(last_layer, 0,
                                    app.config["layer_count"] - 1)
        self._enc_batch = 0  # host mode: accumulated detents
        self._labels = {}  # layer -> [(l1, l2)] * 6
        self._speeds = {}  # (layer, key0) -> tenths
        self._kinds = {}   # (layer, key0) -> (kind, sub) for the wheel menu
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
        """(name, speed_tenths, kind, sub) from a macro file's header without
        loading events: stream files carry it in line 1, legacy app files are
        one line anyway; small pretty-printed files get a full parse. `kind`
        drives the context-aware wheel menu (issue: wheel-menu redesign); `sub`
        is the one extra field that menu needs (media usage, obs action, ...)."""
        try:
            size = os.stat(path)[6]
        except OSError:
            return None, SPEED_DEF_T, None, None
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
            return None, SPEED_DEF_T, None, None
        name = data.get("name")
        speed = (data.get("settings") or {}).get("speed", 1.0)
        try:
            t = clamp(int(round(float(speed) * 10)), SPEED_MIN_T, SPEED_MAX_T)
        except (TypeError, ValueError):
            t = SPEED_DEF_T
        kind = data.get("kind")
        sub = None
        if kind == "obs":
            o = data.get("obs")
            sub = o.get("action") if isinstance(o, dict) else None
        elif kind == "media":
            sub = data.get("media")
        elif kind == "mic":
            sub = data.get("mic_mode") or "toggle"
        elif kind == "scroll":
            sc = data.get("scroll")
            sub = sc.get("dir") if isinstance(sc, dict) else None
        elif kind == "menu":
            sub = data.get("menu")
        return (name if isinstance(name, str) and name else None), t, kind, sub

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
                tr("about"),
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
            name, t, kind, sub = self._read_meta(self.app.macro_path_for(k, l))
            self._speeds[(l, k - 1)] = t
            self._kinds[(l, k - 1)] = (kind, sub)
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

    def kind_sub(self, l, key0):
        """(kind, sub) for the key's assignment, driving the wheel menu."""
        if (l, key0) not in self._kinds:
            self.load_layer(l)
        return self._kinds.get((l, key0), (None, None))

    def cache_stats(self):
        """Container sizes for the console heap telemetry — the growing one
        names the retainer when free memory declines over a session."""
        return (len(self._labels), len(self._slots), len(self._kinds),
                len(self._speeds), len(self._ctx_slots))

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
            base, l = name, 0
            if "-" in name:
                stem, suffix = name.rsplit("-", 1)
                if len(suffix) == 1 and suffix in LAYER_NAMES:
                    base, l = stem, LAYER_NAMES.index(suffix)
            # Only grid key files (keyN[-l]) and slot files (enc-cw[-l], ...)
            # live in these caches. Anything else — profile copies
            # (p_<id>_key1) and sequence/variant part files (key3-b.2) — used
            # to be misread as "layer A changed" and wipe EVERY layer: the
            # app's connect-time profile sync then caused ~15 back-to-back
            # full wipes + repaints, refilling the caches mid-session and
            # shredding the heap until repaints died.
            if not ((base.startswith("key") and base[3:].isdigit())
                    or base in UI_SLOTS):
                return
            layers = [l]
            if l == 0 and base in UI_SLOTS:
                # layer-A slot files are the fallback other layers inherit
                layers = list(set([0] + list(self._slots.keys())))
        for l in set(layers):
            self._labels.pop(l, None)
            self._slots.pop(l, None)
            for k in range(6):
                self._speeds.pop((l, k), None)
                self._kinds.pop((l, k), None)
        if self.state == S_SELECT and self.app.layer in set(layers):
            self._draw_grid()

    # --- speed persistence ---
    def persist_speed(self, l, key0, tenths):
        """Rewrite settings.speed inside the key's macro file. Returns
        "ok" | "missing" | "readonly" | "error".

        Under an active profile the new speed lands in the PROFILE's file
        (copy-on-write from the standalone macro the first time), so a
        per-app speed never touches the shared standalone config (issue #23).
        """
        read_path = self.app.macro_path_for(key0 + 1, l)  # profile file or std
        if self.app.profile_id:
            path = self.app.profile_key_path(key0 + 1)  # write target (profile)
        else:
            path = read_path
        tmp = path + ".part"
        speed = tenths / 10.0
        gc.collect()  # a big recorded macro gets rewritten below; start clean
        try:
            f = open(read_path, "rb")
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
        # Preload EVERY layer now, while the heap is young. These caches are
        # small but long-lived; loading them lazily on first visit used to pin
        # them into the middle of an aging heap, and since CircuitPython's GC
        # never compacts, the heap shredded until layer repaints died on
        # double-digit-byte allocations ("B never shows"). Front-loading them
        # (and every layer's glyphs, in one font pass) keeps the long-lived
        # objects low and the rest of the heap in one piece.
        n = self.app.config["layer_count"]
        chars = ""
        try:
            for i in range(n):
                chars += self._glyphs_for(i)
        except MemoryError:
            gc.collect()  # boot must survive; missing glyphs load lazily
        self.oled.load_grid_font(self.font_idx, chars or self._glyphs_for(l))
        self._labels.clear()  # re-split with the real font metrics
        try:
            for i in range(n):
                self.labels(i)
        except MemoryError:
            gc.collect()
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

    def on_profile(self):
        """A per-app profile was activated or cleared (issue #23): the macro
        files behind every key/slot changed, so drop the cached labels,
        speeds and slots and repaint the grid with the new set."""
        self._labels.clear()
        self._speeds.clear()
        self._kinds.clear()
        self._slots.clear()
        if self.state in (S_SELECT, S_CTX):
            self._enter_grid()

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
        # the app may have changed font/timeout in config.json — apply them
        changed = False
        ct = self.app.config.get("timeout")
        if isinstance(ct, int) and TMO_MIN <= ct <= TMO_MAX and ct != self.idle_secs:
            self.idle_secs = ct
            changed = True
        cf = self.app.config.get("font")
        if isinstance(cf, int) and 0 <= cf < len(FONTS) and cf != self.font_idx:
            self.font_idx = cf
            self.oled.load_grid_font(self.font_idx,
                                     self._glyphs_for(self.app.layer))
            changed = True
        if changed:
            self._nvm_save()
        self.app.config["font"] = self.font_idx
        self.app.config["timeout"] = self.idle_secs
        self._labels.clear()
        self._speeds.clear()
        self._kinds.clear()
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
            self.app.pump()  # serial keeps draining while the gesture holds
            self.app.led.tick()
            time.sleep(0.002)
        if not has_double:
            return "tap"
        t1 = time.monotonic()
        while time.monotonic() - t1 < double_s:
            ev = self.nav.events.get()
            if ev and ev.key_number == key and ev.pressed:
                return "double"
            self.app.pump()
            self.app.led.tick()
            time.sleep(0.002)
        return "tap"

    def _run_node(self, node, meta, choice, now, default, dflt):
        """Fire one resolved slot gesture. A "menu"-kind assignment drives
        the BUILT-IN navigation (never another custom slot — no recursion);
        its "default" action means whatever this input does out of the box,
        and "none" turns the control off — the input is swallowed."""
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
            elif act == "home":
                self._go_home()
            elif act == "settings":
                self._goto_settings()
            elif act == "grid":
                self._enter_grid()
            elif act == "layer_next":
                self._jump_layer(1)
            elif act == "layer_prev":
                self._jump_layer(-1)
            elif act[:6] == "layer_" and len(act) == 7:
                self._goto_layer(LAYER_NAMES.find(act[6]))
            elif act == "select":
                self._toggle_sel_mode()  # built-in PSH-hold escape, now assignable (issue #26)
            elif act == "none":
                pass  # assigned "Do nothing" in the app
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
        pushed (t:"label") and vanishes with the app. A per-layer nickname
        (config "layer_names") replaces the plain "Layer A" with "(A) NAME"."""
        cfg = self.app.config
        label = self.app.host_label if cfg["show_profile"] else None
        marks = self._band_marks()
        if cfg["show_layer"]:
            idx = self.app.layer
            letter = LAYER_NAMES[idx].upper()
            names = cfg.get("layer_names")
            nick = names[idx] if names and idx < len(names) else None
            # The app-pushed label (live OBS scene / profile name) wins over
            # the stored nickname: it's the dynamic status the user watches.
            if label:
                return "(%s) %s%s" % (letter, marks, label)
            if nick:
                return "(%s) %s%s" % (letter, marks, nick)
            return tr("layer_band") % letter
        return (marks + label) if label else label

    def _band_marks(self):
        """Blinking OBS state markers before the band text: (R) while
        recording, (L) while live-streaming. The blink phase swaps them for
        same-width spaces so the rest of the band doesn't shift."""
        m = ""
        if self.app.host_rec:
            m += "(R)"
        if self.app.host_live:
            m += "(L)"
        if not m:
            return ""
        if not self._blink_on:
            m = " " * len(m)
        return m + " "

    def on_sysvol(self, percent):
        """The app pushed the live system volume (the device can't read it).
        Shown on volume-kind grid cells; repaint the grid if it's up."""
        try:
            v = clamp(int(percent), 0, 100)
        except (TypeError, ValueError):
            v = None
        if v == self.sysvol:
            return
        self.sysvol = v
        if v is not None:
            self.oled.ensure_glyphs("%0123456789")
        if self.state == S_SELECT:
            self._draw_grid()

    def _grid_labels(self, l):
        """Base labels with the live system volume overlaid on volume-kind
        cells (their second line becomes '%NN')."""
        labels = self.labels(l)
        if self.sysvol is None:
            return labels
        out = None
        for k in range(6):
            kind, _ = self._kinds.get((l, k), (None, None))
            if kind == "volume":
                if out is None:
                    out = list(labels)
                a = labels[k][0] if k < len(labels) else "Vol"
                out[k] = (a or "Vol", "%%%d" % self.sysvol)
        return out if out is not None else labels

    def _draw_grid(self):
        # show_grid itself compacts, retries and degrades per-cell — no
        # wrapper here: the extra nested handler frames exhausted the fixed
        # pystack ("pystack exhausted" in on_layer).
        l = self.app.layer
        invert = self.sel_mode or not self._enc_custom()
        self.oled.show_grid(self._grid_labels(l), self.sel_key, invert,
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

    def _cell_name(self, l, k0):
        """The key's display label, joined back from the two grid lines."""
        try:
            a, b = self.labels(l)[k0]
            return (a + " " + b).strip() or ("K%d" % (k0 + 1))
        except Exception:
            return "K%d" % (k0 + 1)

    # kinds whose whole point is the wheel menu (a continuous slider), so
    # pressing the physical key should open the menu, not "run" a poor default
    PRESS_MENU_KINDS = ("volume", "mic_level")

    def wants_press_menu(self, key_no):
        """True if pressing key `key_no` should open its wheel menu (slider
        kinds) rather than play its macro. Called from App.on_edge."""
        kind, _ = self.kind_sub(self.app.layer, key_no - 1)
        return kind in self.PRESS_MENU_KINDS

    def open_key_menu(self, key_no):
        """Open the given key's wheel menu as if it were selected on the grid
        and CONFIRM pressed — the physical key press is the entry point."""
        if self.state in (S_HOST, S_PLAYING, S_TEST):
            return
        self.sel_key = clamp(key_no - 1, 0, 5)
        self.sel_mode = False
        self._enter_ctx()

    def _enter_ctx(self):
        """Context-aware wheel menu: CONFIRM on the selected key opens a menu
        that fits the key's action instead of always the speed editor.
        Speed-editing kinds (recorded / typed text / legacy files) keep the
        speed screen; the rest get an action card that's useful on its own."""
        l = self.app.layer
        k0 = self.sel_key
        kind, sub = self.kind_sub(l, k0)
        path = self.app.macro_path_for(k0 + 1, l)
        if kind in (None, "recorded", "text"):
            self._enter_speed()
            return
        name = self._cell_name(l, k0)
        if kind in ("keystroke", "combo"):
            # turn = fire the key again and again (turbo); CONFIRM = fire once
            self._card_state("key", path, tr("key_t"), name, tr("hint_repeat"))
        elif kind == "scroll":
            self._card_state("scroll", path, tr("scroll_t"), name,
                             tr("hint_scroll"))
        elif kind == "media":
            # browse every media key: turn to highlight, tap to fire once,
            # hold to reassign this key to the highlighted one
            self._enter_optlist("media", path, MEDIA_OPTS, sub, tr("media"))
        elif kind == "volume":
            # app running -> absolute % slider (host reads/sets system volume);
            # app closed -> a relative HID volume knob (press mutes)
            if self.app.proto.connected and self.app.host_menus:
                self._ctx_host(kind, sub, path, k0, l)
            else:
                self._card_state("adjust", path, tr("volume"), name,
                                 tr("hint_vol"), up="volume_up",
                                 down="volume_down", conf="mute")
        elif kind == "menu":
            # layer / navigation keys: browse the whole family (next/prev layer,
            # jump to a specific layer, Home/Grid/Settings), tap to run it live,
            # hold to reassign — all standalone, the device rewrites the file
            self._enter_optlist("menu", path, self._menu_opts(), sub,
                                 tr("menu_t"))
        elif kind == "sequence":
            self._card_state("fire", path, tr("run_t"), name, tr("run"))
        elif kind in ("launch", "command", "sound", "mic", "mic_level",
                      "webhook", "obs"):
            self._ctx_host(kind, sub, path, k0, l)
        else:
            self._enter_speed()

    def _card_state(self, mode, path, title, big, hint,
                    up=None, down=None, conf=None):
        self.ctx = {"mode": mode, "path": path, "up": up, "down": down,
                    "conf": conf}
        self.state = S_CTX
        self.activity_at = time.monotonic()
        self.oled.show_card(title, big[:12], None, hint)

    def _menu_opts(self):
        """The layer/nav actions the menu-kind browser offers on this device:
        step layers, jump to each existing layer, then Home/Grid/Settings."""
        n = self.app.config["layer_count"]
        opts = ["layer_next", "layer_prev"]
        opts += ["layer_" + LAYER_NAMES[i] for i in range(n)]
        opts += ["home", "grid", "settings"]
        return opts

    def _opt_label(self, kind, o):
        if kind == "media":
            return MEDIA_LABEL.get(o, o)
        if kind == "menu":
            if len(o) == 7 and o[:6] == "layer_":
                return "Layer " + o[6].upper()
            return MENU_LABEL.get(o, o)
        return str(o)

    def _enter_optlist(self, kind, path, opts, cur, title):
        """A local option browser (media): turn highlights, a tap fires the
        highlighted option, a hold reassigns the key to it. `cur` = the option
        the key is assigned to now (shown marked, cursor starts on it)."""
        opts = list(opts)
        sel = opts.index(cur) if cur in opts else 0
        self.ctx = {"mode": "optlist", "kind": kind, "opts": opts,
                    "assigned": sel, "sel": sel, "path": path, "title": title}
        self.state = S_CTX
        self.activity_at = time.monotonic()
        self._draw_optlist()

    def _draw_optlist(self):
        c = self.ctx
        labels = [self._opt_label(c["kind"], o) for o in c["opts"]]
        self.oled.show_menu(c["title"], labels, c["sel"],
                            marked=c["assigned"], action=tr("run"),
                            hold=tr("hold_set"))

    def _resolve_hold(self, key, hold_s=MENU_HOLD_S):
        """Blocking tap-vs-hold pick for a menu press: "hold" once held past
        hold_s, else "tap" on release. Serial/LED keep pumping meanwhile."""
        t0 = time.monotonic()
        while True:
            if time.monotonic() - t0 >= hold_s:
                return "hold"
            ev = self.nav.events.get()
            if ev and ev.key_number == key and not ev.pressed:
                return "tap"
            self.app.pump()
            self.app.led.tick()
            time.sleep(0.002)

    def _write_macro(self, path, data):
        """Atomically (re)write a whole-file macro, refresh caches and tell the
        app. Returns "ok" | "readonly" | "error". Profile-aware: `path` is
        already the active target (macro_path_for)."""
        tmp = path + ".part"
        try:
            with open(tmp, "w") as f:
                json.dump(data, f)
        except OSError as e:
            try:
                os.remove(tmp)
            except OSError:
                pass
            return "readonly" if (e.args and e.args[0] == 30) else "error"
        try:
            os.remove(path)
        except OSError:
            pass
        try:
            os.rename(tmp, path)
        except OSError:
            return "error"
        self.invalidate_labels(path)
        self.app.proto.send({"t": "macro_changed", "file": path,
                             "reason": "assign"})
        return "ok"

    def _write_media_macro(self, path, usage):
        return self._write_macro(path, {
            "format": "mkyada-macro", "version": 2,
            "name": MEDIA_LABEL.get(usage, usage), "kind": "media",
            "media": usage,
            "events": [{"delay": 0, "type": "consumer", "usage": usage}]})

    def _write_menu_macro(self, path, act):
        return self._write_macro(path, {
            "format": "mkyada-macro", "version": 2,
            "name": self._opt_label("menu", act), "kind": "menu",
            "menu": act, "events": []})

    def _run_menu_act(self, act):
        """Perform a layer/nav menu action live (tap in the menu browser). Each
        of these transitions the UI itself, so the wheel menu is replaced by the
        action's own screen — no redraw of the browser needed."""
        if act == "layer_next":
            self._jump_layer(1)
        elif act == "layer_prev":
            self._jump_layer(-1)
        elif len(act) == 7 and act[:6] == "layer_":
            self._goto_layer(LAYER_NAMES.find(act[6]))
        elif act == "home":
            self._go_home()
        elif act == "grid":
            self._enter_grid()
        elif act == "settings":
            self._goto_settings()

    def _ctx_host(self, kind, sub, path, k0, l):
        """A host-only action (OBS, webhook, mic, ...). The device can't perform
        it alone: ask the app for a menu (proto v9). The app answers with a
        `menu` message rendered by on_menu; if it never does (or isn't there),
        fall back to the "app required" toast."""
        if self.app.proto.connected and self.app.host_menus:
            self.app.proto.send({"t": "ctx", "key": k0 + 1,
                                 "layer": LAYER_NAMES[l], "kind": kind,
                                 "sub": sub, "file": path})
            self.ctx = {"mode": "wait", "key": k0 + 1, "layer": LAYER_NAMES[l],
                        "deadline": time.monotonic() + CTX_WAIT_S}
            self.state = S_CTX
            self.activity_at = time.monotonic()
            self.oled.show_card(tr("wheel"), "...", None, None)
        else:
            self._toast(tr("wheel"), tr("app_needed"), tr("open_app"))

    def on_menu(self, msg):
        """The app rendered/updated the open wheel menu (host-fed list, slider
        or status card). Ignored unless a menu is open for this key."""
        if self.state != S_CTX or not self.ctx:
            return
        key = msg.get("key")
        if key is not None and self.ctx.get("key") not in (None, key):
            return  # a menu meant for a different key
        # a live re-render of the same menu (REC timer, external volume) keeps
        # the user's cursor and doesn't reset the idle timer
        prev = self.ctx if self.ctx.get("mode") == "host" else None
        items = msg.get("items") or []
        sel_in = msg.get("sel")
        sel = int(sel_in) if sel_in is not None else (prev["sel"] if prev else 0)
        self.ctx = {"mode": "host", "mtype": msg.get("mtype") or "card",
                    "key": self.ctx.get("key") or key,
                    "layer": self.ctx.get("layer") or msg.get("layer"),
                    "title": str(msg.get("title") or tr("wheel")),
                    "big": str(msg.get("big") or ""),
                    "l1": str(msg.get("l1") or ""),
                    "l2": str(msg.get("l2") or ""),
                    "hint": msg.get("hint"), "action": msg.get("action"),
                    "hold": msg.get("hold"), "items": items,
                    "sel": clamp(sel, 0, max(0, len(items) - 1)),
                    "value": msg.get("value"),
                    "min": int(msg.get("min") or 0),
                    "max": int(msg.get("max") or 100),
                    "step": int(msg.get("step") or 1),
                    "unit": str(msg.get("unit") or "")}
        if prev is None:
            self.activity_at = time.monotonic()
        self._draw_host_menu()

    def on_menu_result(self, msg):
        """The app finished a picked/fired action: optionally refresh a
        rewritten macro's label, show a brief toast, and close the menu."""
        if self.state != S_CTX:
            return
        changed = msg.get("changed")
        if changed:
            self.invalidate_labels(changed)
        toast = msg.get("toast")
        if isinstance(toast, list) and toast:
            title = str(toast[0])
            line1 = str(toast[1]) if len(toast) > 1 else ""
            self._toast(title, line1, "")
        else:
            self._enter_grid()

    def on_host_gone(self):
        """The app disconnected: abandon any open host menu and drop the live
        system-volume readout (it would otherwise freeze on a stale value)."""
        had_vol = self.sysvol is not None
        self.sysvol = None
        if self.state == S_CTX and self.ctx and \
                self.ctx.get("mode") in ("host", "wait"):
            self._enter_grid()
        elif had_vol and self.state == S_SELECT:
            self._draw_grid()

    def _item_label(self, it):
        try:
            return str(it[1])[:21]
        except (IndexError, TypeError):
            return ""

    def _draw_host_menu(self):
        c = self.ctx
        mt = c["mtype"]
        if mt == "list":
            items = [self._item_label(it) for it in c["items"]] or [""]
            marked = None
            for i, it in enumerate(c["items"]):
                if len(it) > 2 and it[2]:
                    marked = i
                    break
            self.oled.show_menu(c["title"], items, c["sel"], marked=marked,
                                action=c.get("action") or tr("select"),
                                hold=tr("hold_set") if c.get("hold") else None)
        elif mt == "slider":
            v = c["value"] or 0
            span = c["max"] - c["min"]
            frac = (v - c["min"]) / float(span) if span else 0.0
            self.oled.show_adjust(c["title"], "%d%s" % (v, c["unit"]), frac,
                                  c.get("action") or tr("save"))
        else:  # card
            self.oled.show_card(c["title"], (c["big"] or "")[:12],
                                c["l1"] or None, c.get("hint"))

    def _close_host_menu(self):
        if self.app.proto.connected:
            self.app.proto.send({"t": "menu_ev", "ev": "close"})
        self._enter_grid()

    def _st_ctx(self, now, d, press):
        """Wheel-menu handler. Local action cards run entirely on the device;
        host menus (mode "host") relay turn/press as menu_ev and re-render from
        the app's menu messages. BACK / idle close and notify the app."""
        c = self.ctx or {}
        mode = c.get("mode")
        if mode == "wait":
            if press == K_BACK:
                self._close_host_menu()
            elif now >= c.get("deadline", now):
                self._toast(tr("wheel"), tr("app_needed"), tr("open_app"))
            return
        if mode == "host":
            self._st_ctx_host(now, d, press)
            return
        # --- local menus (keystroke / scroll knob / media browser / volume) ---
        if press == K_BACK:
            self._enter_grid()
            return
        eng = self.app.engine
        if mode == "optlist":
            if d:
                c["sel"] = clamp(c["sel"] + (1 if d > 0 else -1), 0,
                                 len(c["opts"]) - 1)
                self._draw_optlist()
            if press in (K_PSH, K_CONFIRM):
                self._optlist_press(press)
                return
        elif mode in ("key", "scroll"):
            if d:
                for _ in range(min(abs(d), 4)):
                    self.app.play_file(path=c["path"], trigger=None)
            if press in (K_PSH, K_CONFIRM):
                self.app.play_file(path=c["path"], trigger=None)
        elif mode == "fire":  # sequence: CONFIRM runs the whole macro once
            if press in (K_PSH, K_CONFIRM):
                self.app.play_file(path=c["path"], trigger=None)
        elif mode == "adjust":  # volume/brightness knob (standalone fallback)
            if d:
                usage = c["up"] if d > 0 else c["down"]
                if usage:
                    for _ in range(min(abs(d), 4)):
                        eng.consumer_tap(usage)
            if press in (K_PSH, K_CONFIRM) and c.get("conf"):
                eng.consumer_tap(c["conf"])
        if press is None and not d and now - self.activity_at > self.idle_secs:
            self._enter_grid()

    def _optlist_press(self, press):
        """A tap fires the highlighted option once; a hold reassigns the key to
        it (device-written macro, so it works standalone)."""
        c = self.ctx
        opt = c["opts"][c["sel"]]
        if self._resolve_hold(press) == "hold":
            if c["kind"] == "media":
                res = self._write_media_macro(c["path"], opt)
            elif c["kind"] == "menu":
                res = self._write_menu_macro(c["path"], opt)
            else:
                res = "error"
            if res == "ok":
                c["assigned"] = c["sel"]
                self._toast(c["title"], tr("assigned"),
                            self._opt_label(c["kind"], opt))
            elif res == "readonly":
                self._toast(c["title"], tr("usb_on"), tr("read_only"))
            else:
                self._toast(c["title"], tr("save_fail"), "")
        elif c["kind"] == "media":
            self.app.engine.consumer_tap(opt)
        elif c["kind"] == "menu":
            self._run_menu_act(opt)  # transitions the UI itself

    def _st_ctx_host(self, now, d, press):
        c = self.ctx
        mt = c["mtype"]
        send = self.app.proto.send
        if mt == "list":
            if d and c["items"]:
                c["sel"] = clamp(c["sel"] + (1 if d > 0 else -1), 0,
                                 len(c["items"]) - 1)
                self._draw_host_menu()
            if press in (K_PSH, K_CONFIRM):
                it = c["items"][c["sel"]] if c["items"] else None
                # tap = use it now (switch scene / do the mode); hold = reassign
                ev = "assign" if self._resolve_hold(press) == "hold" else "pick"
                send({"t": "menu_ev", "ev": ev,
                      "id": (it[0] if it else None)})
            elif press == K_BACK:
                self._close_host_menu()
        elif mt == "slider":
            if d:
                step = c["step"] or 1
                c["value"] = clamp((c["value"] or 0) + d * step,
                                   c["min"], c["max"])
                self._draw_host_menu()
                send({"t": "menu_ev", "ev": "value", "v": c["value"]})
            if press in (K_PSH, K_CONFIRM):
                send({"t": "menu_ev", "ev": "close"})
                self._enter_grid()
            elif press == K_BACK:
                self._close_host_menu()
        else:  # card
            if press in (K_PSH, K_CONFIRM):
                send({"t": "menu_ev", "ev": "fire"})
            elif d:
                send({"t": "menu_ev", "ev": "value", "v": 1 if d > 0 else -1})
            elif press == K_BACK:
                self._close_host_menu()
        if (press is None and not d
                and now - self.activity_at > self.idle_secs):
            self._close_host_menu()

    def _toast(self, title, line1, line2=""):
        self.state = S_TOAST
        self.toast_at = time.monotonic()
        self.oled.show_toast(title, line1, line2)

    # --- per-state handlers ---
    def tick(self, now):
        if self.state == S_HOST:
            self._tick_host()
            return
        if self.state == S_TEST:
            self._tick_test()
            return
        if self.state == S_PLAYING:
            return  # playback owns the loop; on_play_done() restores us
        d = self._enc_delta()
        ev = self.nav.events.get()
        # Mirror the wheel/nav to a connected app even in standalone mode, the
        # same way macro keys stream their btn events on every screen — so the
        # Setup test panel lights up live with no "host mode" round-trip. The
        # inputs still drive the menu below; the app just gets to watch.
        if self.app.proto.connected:
            if d:
                self.app.proto.send({"t": "enc", "d": 1 if d > 0 else -1,
                                     "n": abs(d)})
            if ev:
                self.app.proto.send({"t": "btn",
                                     "slot": NAV_SLOT[ev.key_number],
                                     "down": bool(ev.pressed)})
        press = ev.key_number if (ev and ev.pressed) else None
        self._dispatch(now, d, press)

    def inject(self, action):
        """A macro key mapped to a device-menu action drives the UI as if the
        encoder or CONFIRM/BACK were used (menu left/right/confirm/back).
        "home" / "settings" jump straight to that screen."""
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
            elif action == "home":
                self._go_home()
            elif action == "settings":
                self._goto_settings()
            elif action == "grid":
                self._enter_grid()
            elif action == "layer_next":
                self._jump_layer(1)
            elif action == "layer_prev":
                self._jump_layer(-1)
            elif action[:6] == "layer_" and len(action) == 7:
                self._goto_layer(LAYER_NAMES.find(action[6]))
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
        elif self.state == S_CTX:
            self._st_ctx(now, d, press)
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
        elif self.state == S_ABOUT:
            self._st_about(now, d, press)

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

    def _tick_test(self):
        """Setup test mode: the wheel/nav stream to the app's tester like host
        mode AND show on the screen (wheel direction / pressed nav button + its
        pin), so every control is verifiable on the device. Key presses come
        via App.on_edge (on_test_key)."""
        d = self._enc_delta()
        if d:
            if self.app.proto.connected:
                self.app.proto.send({"t": "enc", "d": 1 if d > 0 else -1,
                                     "n": abs(d)})
            ea, eb = MODELS[self.app.model]["encoder"]
            self.oled.show_toast(tr("setup_test"),
                                 "Wheel " + ("CW" if d > 0 else "CCW"),
                                 "%s/%s" % (ea, eb))
        while True:
            ev = self.nav.events.get()
            if not ev:
                break
            if self.app.proto.connected:
                self.app.proto.send({"t": "btn",
                                     "slot": NAV_SLOT[ev.key_number],
                                     "down": bool(ev.pressed)})
            if ev.pressed:
                names = self.app.nav_pin_names() or ()
                pin = names[ev.key_number] if ev.key_number < len(names) else "?"
                self.oled.show_toast(tr("setup_test"),
                                     NAV_SLOT[ev.key_number].upper(), pin)

    # --- Test mode: Setup wiring test (issue #24) / Keys tab (issue #33) ---
    def on_test_enter(self, ui="wiring"):
        self.state = S_TEST
        self.test_ui = ui
        self._drain_inputs()
        if ui == "keys":
            # Keys tab is open on the app: warn that macros are paused here.
            self.oled.show_toast(tr("keys_test"), tr("keys_test_paused"),
                                 tr("keys_test_switch"))
        else:
            self.oled.show_toast(tr("setup_test"), tr("press_key"), "")

    def on_test_key(self, key_no, pin):
        if self.state != S_TEST:
            return
        if getattr(self, "test_ui", "wiring") == "keys":
            # Keys tab: the static "macros paused" warning is already up, so
            # don't repaint per press. Building the label (which reads the
            # macro file for its name and lazily loads BDF glyphs) plus the
            # blocking OLED refresh would stall the button scan long enough
            # that the release edge is reported late — the app's live key
            # highlight then lingers, looking like the key "kept running its
            # macro" even though playback is suppressed. Nothing to show here.
            return
        # Setup wiring test: showing the pressed key + pin IS the point.
        try:
            a, b = self.labels(self.app.layer)[key_no - 1]
            name = (a + " " + b).strip()
        except Exception:
            name = ""
        self.oled.show_toast(tr("setup_test"), name or ("K%d" % key_no),
                             "K%d  %s" % (key_no, pin))

    def on_test_leave(self):
        if self.state == S_TEST:
            self._drain_inputs()
            self.state = S_SELECT
            self._draw_grid()

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
                self._goto_settings()
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
        self.activity_at = time.monotonic()  # injected jumps carry no press
        self._draw_home()

    def _goto_settings(self):
        """Open the settings menu — from the home SETTINGS entry, or as a
        direct-jump "settings" menu action assigned to a key/control."""
        self.set_menu_sel = 0
        self.state = S_SET_MENU
        self.activity_at = time.monotonic()
        self.oled.show_menu(tr("settings"), self._set_items(), 0)

    def _jump_layer(self, step):
        """Switch the active layer by a relative step (menu action "layer_next"
        / "layer_prev")."""
        c = self.app.config["layer_count"]
        self._goto_layer((self.app.layer + step) % c)

    def _goto_layer(self, idx):
        """Jump straight to an absolute layer index (menu action "layer_a"..)
        — same flow as confirming a layer on the home screen. Ignores an index
        past this device's layer_count."""
        if 0 <= idx < self.app.config["layer_count"]:
            self.app.set_layer_idx(idx)
            self._nvm_save()
            # no retry wrapper: show_grid is self-healing, and nested
            # except-handler retries exhausted the pystack
            self._enter_grid()

    def _st_select(self, now, d, press):
        self._custom_input(now, d, press, self.slots(self.app.layer),
                           self._select_default)
        if (not d and press is None and self.sel_mode
                and now - self.activity_at > self.idle_secs):
            self.sel_mode = False  # back to the customized resting grid
            self._draw_grid()
        # Self-healing labels: a paint under memory pressure may have skipped
        # a cell ("6. kutu önce gözüküyor sonra kayboluyor"). Once things calm
        # down (~1s later), quietly repaint so no label stays missing.
        if (self.oled.grid_degraded and not d and press is None
                and now - self._degraded_at > 1.0):
            self._degraded_at = now
            self._draw_grid()
        # Blink the (R)/(L) OBS markers in the band. Cheap since the grid
        # group is persistent: this repaint only swaps the band label text.
        cfg = self.app.config
        if ((self.app.host_rec or self.app.host_live)
                and (cfg["show_layer"] or cfg["show_profile"])
                and not d and press is None
                and now - self._blink_at > 0.6):
            self._blink_at = now
            self._blink_on = not self._blink_on
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
                self._enter_ctx()
        elif press == K_CONFIRM:
            self._enter_ctx()
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
            elif self.set_menu_sel == SET_ABOUT:
                self.state = S_ABOUT
                self.oled.show_about(self._about_lines())
            elif microcontroller:
                microcontroller.reset()
        elif press == K_BACK:
            self.home_pos = self.app.config["layer_count"]
            self.state = S_HOME
            self._draw_home()

    def _about_lines(self):
        """(label, value) pairs for the About screen: model, firmware, UID."""
        app = self.app
        uid = getattr(app, "uid", None) or ""
        return ((tr("model"), app.model),
                (tr("firmware"), app.fw_version),
                (tr("device_id"), uid[:12]))

    def _st_about(self, now, d, press):
        # read-only info screen; any nav (or BACK) returns to the menu
        if press is not None or now - self.activity_at > self.idle_secs:
            self.state = S_SET_MENU
            self.oled.show_menu(tr("settings"), self._set_items(),
                                self.set_menu_sel)

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
            # mirror into config.json so a connected app sees the choice
            # (best-effort: NVM already holds it; ignore a read-only drive)
            self.persist_cfg({"font": self.font_idx})
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
            self.persist_cfg({"timeout": self.idle_secs})  # app-facing mirror
            self.state = S_SET_MENU
            self.oled.show_menu(tr("settings"), self._set_items(), self.set_menu_sel)
        elif press == K_BACK:
            self.state = S_SET_MENU
            self.oled.show_menu(tr("settings"), self._set_items(), self.set_menu_sel)

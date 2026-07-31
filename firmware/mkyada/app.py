# MKYADA firmware — main application (loaded by code.py's bootstrap).
#
# One codebase, two models (see mkyada/models.py):
#   core6    screenless keypad, keys on GP0.., layer key cycles layers
#   vision6  SH1106 OLED + EC11 encoder menu module, keys on the far edge
# Standalone: a key press plays the macro JSON mapped to it by name convention
#   (macros/key<N>.json, layer B -> key<N>-b.json, ...). No app required.
# Host mode: entered when the desktop app sends {"t":"host_enter"}; key events
#   stream to the app over serial and playback happens only on its commands.
#   Falls back to standalone if the app goes silent for PING_TIMEOUT seconds.
#
# If anything in this module fails to import or construct, code.py drops into
# its built-in rescue console so the desktop app can always repair the board.

import gc
import json
import os
import time

# CircuitPython-only heap gauges; the desktop simulator's gc lacks them
_mem_free = getattr(gc, "mem_free", lambda: -1)
_mem_alloc = getattr(gc, "mem_alloc", lambda: -1)
from binascii import a2b_base64, b2a_base64, crc32

import board
import digitalio
import keypad
import microcontroller

# File copies onto a visible CIRCUITPY drive must never reboot the board
# mid-transfer — a multi-file firmware copy used to trigger a reload per
# file, running half-updated trees (the classic field brick). Updates end
# with an explicit {"t":"reset"} from the app instead.
try:
    import supervisor
    supervisor.runtime.autoreload = False
except Exception:
    pass

from mkyada.models import (MODELS, resolve_model, resolve_pins,
                           validate_key_pins, validate_nav_pins,
                           detect_candidates)


def _read_config_dict():
    try:
        with open("/config.json") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError, MemoryError):
        return {}


# Resolve the model and put the branded boot screen up BEFORE the heavy
# imports below — on Vision 6 the display must never show console text, and
# engine/proto imports cost enough time to leave a visible gap otherwise.
_cfg_early = _read_config_dict()
MODEL = resolve_model(_cfg_early.get("model"))
from mkyada import i18n
i18n.set_lang(_cfg_early.get("lang"))
del _cfg_early
OLED = None
if MODELS[MODEL]["display"]:
    try:
        from mkyada.oled import Oled
        OLED = Oled(MODELS[MODEL]["display"])
        # The splash prints the firmware version, and /VERSION is a cheap read
        # that has to happen anyway — do it here rather than leave the first
        # frame's corner blank until App.__init__ runs.
        try:
            with open("/VERSION") as _vf:
                OLED.fw = _vf.read().strip()
        except Exception:
            pass
        OLED.show_boot(0.0)
    except Exception as e:  # display stack missing/broken: run headless
        print("oled init failed:", e)
        OLED = None

from mkyada import led as ledmod
from mkyada.engine import Engine, StopPlayback
from mkyada.led import Led
from mkyada.proto import Proto

if OLED:
    OLED.boot_progress(0.5)  # heavy imports done

gc.collect()  # compact before the biggest compile of the boot sequence
try:
    from mkyada.ui import Ui
except (ImportError, MemoryError):
    # ui.py is the largest module; compiling it on-device can MemoryError on
    # a fragmented heap (release builds ship .mpy, but a source install must
    # survive too). One compacted retry, then run headless — keys and serial
    # must come up no matter what the menu module does.
    gc.collect()
    try:
        from mkyada.ui import Ui
    except Exception:
        Ui = None

gc.collect()  # the display stack litters the heap; start the app compacted

DEBOUNCE_S = 0.02
PING_TIMEOUT_S = 5.0
PROTO_VERSION = 11 # v11: macro files may carry a top-level "icon" naming one of
                   # the icons in icons/src/icons.txt — the grid draws it above
                   # the key's name; absent falls back to the action kind's
                   # default (KIND_ICON in ui.py). Plus mtype:"obs", a live OBS
                   # status shape for the wheel menu. Both additive: old apps
                   # send neither and old firmware skips both;
                   # v10: "font" is gone from hello and config.json. One font
                   # ships now, so the setting had nothing left to choose; an
                   # older app reading hello sees the field missing and simply
                   # reports the keypad as pre-0.14.0 for prefs, which is a
                   # cosmetic downgrade rather than a break;
                   # v9: context-aware wheel menu — "hostinfo" (the app
                   # advertises menu support), "ctx" (device asks the app for a
                   # host-kind key's menu), "menu"/"menu_ev"/"menu_result"
                   # (render / events / close for the on-screen wheel menu);
                   # v8: "profile" command — the app activates a per-app
                   # profile natively (macro paths redirect to its files) so
                   # the on-device grid/wheel/speed editor run it, no host mode;
                   # v7: update_begin/update_end/update_abort (locked update
                   # mode with on-screen progress), fs_write/fs_read CRC32
                   # verification, "bootloader" (UF2 without the BOOT button)
                   # and the code.py rescue console (hello mode:"rescue");
                   # v6: direct "scroll" command (app-accelerated wheel) and
                   # "label" carries the profile's key names (host-mode grid);
                   # v5: "play" accepts hold:true (key held until "stop");
                   # v4: streamed JSONL macro files (full-rate playback);
                   # v3: fs_* file management over serial (hidden-drive mode)
UPDATE_IDLE_ABORT_S = 30.0  # app silent this long mid-update: back to normal
WATCHDOG_S = 8.0  # hardware watchdog window (RP2040 max ~8.3s)
MACRO_FORMATS = ("mkyada-macro", "asil-macro")
LAYER_NAMES = "abcdefgh"
# Raw bytes per fs_chunk line (base64 inflates 4/3, must stay under MAX_LINE).
# Bigger chunks mean fewer ack round-trips; but on vision6 the display stack
# fragments the heap, so each chunk's transient base64 + JSON buffers (~1.4x
# the raw size, several copies live at once) can MemoryError on a contiguous
# allocation. 1KB keeps the whole per-chunk peak tiny, which is what lets the
# app read a big recorded (mouse-path) macro back off a screen model at all;
# the extra ack round-trips are ~ms on CDC. Core 6 has the whole heap free.
FS_CHUNK = 1024 if MODELS[MODEL]["display"] else 8192
FS_ACK_TIMEOUT_S = 3.0
# Biggest raw fs_WRITE chunk we advertise in hello. An inbound chunk must be
# copied out of the RX buffer as ONE contiguous block, and CircuitPython never
# compacts: measured on a working board, a 1451-byte line (1KB chunk) was
# refused with 14.5KB free, while ~740-byte lines (512B chunks) land every
# time. Reads keep FS_CHUNK — they have their own adaptive halving.
FS_WRITE_CHUNK = 512 if MODELS[MODEL]["display"] else 8192
# Consecutive MemoryErrors the main loop absorbs (compact + resume) before it
# gives up and takes the branded reset. A fragmented heap refusing ONE big
# serial line is normal under load; refusing many in a row is a real leak.
OOM_RECOVERIES = 20
# The host abandons a chunk after ~8s and just stops sending. Reclaim an
# upload that goes quiet for longer so its file handle — and the UI, which
# is held still during transfers — are never stuck waiting for a dead one.
UPLOAD_IDLE_S = 12.0
# Periodic heap telemetry on the CDC console. Off in shipping firmware — it is
# only useful with something actually reading /dev/cu.usbmodem101, and the
# noise buries the rare lines that matter (line drops, OOM recoveries).
DEBUG_TELEMETRY = False
# UI hooks deferred while a file transfer is in flight (see ui_call). Purely
# cosmetic: the band label, the live volume readout, the idle tick. NOT
# on_profile — that one drops stale caches, so deferring it would leave the
# grid naming the wrong profile's macros (and set_profile already no-ops when
# the id is unchanged, so it only fires on a real switch).
COSMETIC_HOOKS = ("tick", "on_label", "on_sysvol")

DEFAULT_CONFIG = {
    "model": None,       # "core6" | "vision6"; null = auto (I2C probe once)
    "lang": "en",        # device UI language ("en" | "tr"); editable from the
                         # app (Setup) and on the device (Settings > Language)
    "key_count": 6,
    "pins": None,        # per-key GPIO names, e.g. ["GP29",...,"GP13"] when a
                         # key is soldered off the model's default order;
                         # null = the model's pin_order (mkyada/models.py)
    "layer_key": None,   # 1-based key number, or null (always null on vision6)
    "layer_count": 2,
    "layer_mode": "toggle",  # kept for config compat; press always cycles a->b->...
    "key_map": None,     # per-GPIO logical key numbers, e.g. [3,1,2] when the
                         # solder order differs; null = identity (GP0 = key 1)
    "busy_other": "ignore",  # another macro key pressed while playing:
                             # "ignore" it, or "switch" (stop + play the new one)
    "screen": {"width": 1920, "height": 1080},
    "usb_drive": False,  # CIRCUITPY drive hidden by default (finished-product
                         # mode: the app manages files over serial). Only an
                         # explicit true shows it — same rule as boot.py. Hold
                         # key 1 at power-on to force the drive back on.
    "watchdog": True,    # hardware watchdog: a hung firmware hard-resets
                         # itself instead of bricking (false only for bench
                         # debugging — a paused debugger trips it)
    "show_layer": False,    # vision6: band over the grid with the active layer
    "show_profile": False,  # vision6: band shows the app-pushed profile label
    "wheel_layers": False,  # vision6: the wheel walks layers as well as keys —
                            # past the sixth tile it wraps into the next
                            # layer's first, and the grid grows a dot row.
                            # Off by default: it changes what the wheel does,
                            # and an existing keypad should not have its wheel
                            # behaviour move under it on an update.
    "timeout": None,     # vision6: auto-return idle seconds (mirror of the
                         # on-device Settings > Auto-return); null = NVM value
    "nav": None,         # vision6: PSH/BACK/CONFIRM pin order override, e.g.
                         # ["GP4","GP6","GP5"] to fix a swapped BACK/CONFIRM
                         # solder; null = the model's default nav (models.py)
    "enc_swap": False,   # vision6: encoder soldered backwards (CW/CCW flipped);
                         # true swaps the two encoder pins in ui.py
    "layer_names": None, # vision6: optional per-layer nickname shown in the
                         # grid top bar as "(A) NICKNAME". The app/software
                         # still labels layers A/B/C/D everywhere; only the
                         # device band uses the nickname. A list aligned to
                         # layers (index 0 = layer A); null/"" entries keep the
                         # plain "Layer A"; null = no custom names at all.
}


def read_text(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None


def uid_hex():
    return "".join("%02x" % b for b in microcontroller.cpu.uid)


class Buttons:
    """Active-low buttons with per-key debounce and press/release edges."""

    def __init__(self, pins):
        self.ios = []
        for pin in pins:
            io = digitalio.DigitalInOut(pin)
            io.direction = digitalio.Direction.INPUT
            io.pull = digitalio.Pull.UP
            self.ios.append(io)
        count = len(self.ios)
        self.stable = [False] * count
        self.changed_at = [0.0] * count

    def deinit(self):
        for io in self.ios:
            try:
                io.deinit()
            except Exception:
                pass
        self.ios = []

    def scan(self):
        """Return [(index, pressed_bool), ...] edges since last scan."""
        edges = []
        now = time.monotonic()
        for i, io in enumerate(self.ios):
            raw = not io.value
            if raw != self.stable[i] and now - self.changed_at[i] > DEBOUNCE_S:
                self.stable[i] = raw
                self.changed_at[i] = now
                edges.append((i, raw))
        return edges


class KeyMatrix:
    """Main key matrix via keypad.Keys: scanned in the background with a
    hardware event queue, so a press during a long blocking stretch (a grid
    paint + gc takes 100-300ms) is delivered late instead of LOST — the
    level-sampled Buttons scanner silently missed taps that fit inside a
    blocked window ("D->A gecislerinde zaman zaman tekrar basmak gerekiyor").
    Buttons stays for the wiring wizard, which needs raw level access."""

    def __init__(self, pins):
        self._keys = keypad.Keys(tuple(pins), value_when_pressed=False,
                                 pull=True)
        # current levels, for hold checks (resolve_variant, hold_repeat)
        self.stable = [False] * len(pins)

    def deinit(self):
        try:
            self._keys.deinit()
        except Exception:
            pass

    def scan(self):
        """Drain queued key events -> [(index, pressed_bool), ...]."""
        edges = []
        while True:
            ev = self._keys.events.get()
            if not ev:
                break
            if ev.key_number < len(self.stable):
                self.stable[ev.key_number] = ev.pressed
            edges.append((ev.key_number, ev.pressed))
        return edges


class App:
    def __init__(self):
        self.fw_version = read_text("/VERSION") or "0.0.0"
        self.model = MODEL
        self.uid = uid_hex()  # stable per-board id, also shown on About
        self.engine = Engine()
        self.proto = Proto()
        self.led = Led()
        self.config = dict(DEFAULT_CONFIG)
        self.load_config()
        self.buttons = KeyMatrix(resolve_pins(self.key_pin_names()))
        self.layer = 0
        self.mode = "standalone"
        self.last_rx = 0.0
        self.playing_key = None  # 0-based index of the key that started playback
        self.pending_play = None  # (path, trigger) queued by restart/switch policies
        self._mem_report_at = 0  # last heap-telemetry print (console)
        self.upload = None  # in-flight fs_write: {"path", "tmp", "f", "seq"}
        self.upload_at = 0.0  # last chunk received (stale-upload reclaim)
        self.ui_stale = False  # a repaint was skipped during a transfer
        self.pin_watch = None  # ("names", Buttons) while pin-detect mode is on
        self.pin_watch_until = 0.0
        self.host_label = None  # app-pushed profile/app label for the band
        self.host_keys = None  # app-pushed profile key names (host-mode grid)
        self.host_rec = False  # OBS is recording — band blinks "(R)"
        self.host_live = False  # OBS is streaming — band blinks "(L)"
        self.host_menus = False  # app advertised wheel-menu support (hostinfo)
        # Active per-app profile (issue #23): a file prefix like "p_p123" the
        # app sets via {t:"profile"}. When set, macro paths resolve to that
        # profile's files (falling back to the standalone macro when a key
        # isn't overridden), so the whole on-device UI — grid, wheel, speed
        # editor — runs the profile's config natively instead of the app
        # holding host mode. Cleared when the app disconnects.
        self.profile_id = None
        # "Test keys" mode: while the app's Setup or Keys tab is the frontmost
        # view, macro keys don't play — the app still gets the btn stream to
        # light up the pressed key, but on-device playback is suppressed on
        # EVERY model (issue #33: previously only Vision 6 with a screen). The
        # Vision 6 screen shows a hint ("wiring" = Setup pressed-key/pin,
        # "keys" = Keys tab macros-paused warning); core6 has no screen so it
        # goes quiet. Cleared on {t:"test_leave"} and on app disconnect.
        self.test_mode = False
        self.test_ui = "wiring"  # which screen the active test tab wants
        # ...unless the user opened Settings > Key test on the device itself:
        # nobody on the other end of the cable owns that one, so the "app went
        # away, un-suppress the keys" cleanup below must not end it.
        self.test_local = False
        self.inbox = []  # serial messages drained during blocking key logic
        self.updating = False  # locked update mode (update_begin..update_end)
        self.update_total = 0  # bytes announced by update_begin
        self.update_done = 0  # bytes written so far (drives the progress bar)
        self.update_last_frac = -1.0
        self.update_deadline = 0.0
        self.wd = None  # armed hardware watchdog (run_loop)
        self.ui = None  # vision6 menu module (encoder + OLED state machine)
        if OLED and Ui:
            try:
                self.ui = Ui(self, OLED)
            except Exception as e:
                print("ui init failed:", e)

    # --- self-healing ---
    def arm_watchdog(self):
        """Hardware watchdog: if the firmware ever stops feeding (a hard
        hang, even inside a C call), the chip hard-resets and comes back
        clean instead of sitting bricked. Armed only once the main loop is
        entered — boot-time font loading must never race it."""
        if not self.config.get("watchdog", True):
            return
        try:
            from watchdog import WatchDogMode
            wd = microcontroller.watchdog
            wd.timeout = WATCHDOG_S
            wd.mode = WatchDogMode.RESET
            wd.feed()
            self.wd = wd
        except Exception as e:
            print("watchdog unavailable:", e)

    def feed(self):
        if self.wd:
            try:
                self.wd.feed()
            except Exception:
                pass

    def pump(self):
        """Drain serial into the inbox WITHOUT handling anything — called
        from blocking key logic (tap/double/hold resolution) so a transfer
        burst can't back up the USB CDC buffer and stall the host's writes.
        Handling waits until the gesture resolves: a command must never
        reenter playback from inside the gesture that started it."""
        self.feed()
        msgs = self.proto.poll()
        if msgs:
            self.inbox.extend(msgs)
            if len(self.inbox) > 64:  # bound memory under a command flood
                del self.inbox[: len(self.inbox) - 64]

    # --- config ---
    def load_config(self):
        cfg = dict(DEFAULT_CONFIG)
        try:
            with open("/config.json") as f:
                data = json.load(f)
            if isinstance(data, dict):
                for k in DEFAULT_CONFIG:
                    if k in data:
                        cfg[k] = data[k]
        except (OSError, ValueError, MemoryError):
            self.led.error()
        m = MODELS[MODEL]
        cfg["model"] = MODEL  # resolved value, not the raw file field
        if cfg.get("lang") not in i18n.LANGS:
            cfg["lang"] = i18n.DEFAULT_LANG
        max_keys = min(len(m["pin_order"]), m["max_keys"])
        cfg["key_count"] = max(1, min(max_keys, int(cfg.get("key_count") or 6)))
        cfg["pins"] = validate_key_pins(cfg.get("pins"), cfg["key_count"], MODEL)
        if m["layer_via"] == "ui":
            cfg["layer_key"] = None  # all keys are macro keys on vision6
        else:
            lk = cfg.get("layer_key")
            cfg["layer_key"] = int(lk) if lk and 1 <= int(lk) <= cfg["key_count"] else None
        cfg["layer_count"] = max(m["min_layers"],
                                 min(len(LAYER_NAMES), int(cfg.get("layer_count") or 2)))
        km = cfg.get("key_map")
        if not (isinstance(km, list) and len(km) == cfg["key_count"]
                and sorted(km) == list(range(1, cfg["key_count"] + 1))):
            km = list(range(1, cfg["key_count"] + 1))  # identity
        cfg["key_map"] = km
        if cfg.get("busy_other") not in ("ignore", "switch"):
            cfg["busy_other"] = "ignore"
        cfg["usb_drive"] = cfg.get("usb_drive") is True  # same rule as boot.py
        cfg["show_layer"] = cfg.get("show_layer") is True
        cfg["show_profile"] = cfg.get("show_profile") is True
        # timeout: light bounds here (the UI clamps to its exact TMO range);
        # null means "use the device's NVM value".
        tmo = cfg.get("timeout")
        cfg["timeout"] = tmo if isinstance(tmo, int) and 3 <= tmo <= 60 else None
        cfg["nav"] = validate_nav_pins(cfg.get("nav"), MODEL)
        cfg["enc_swap"] = cfg.get("enc_swap") is True
        # layer_names: per-layer nicknames for the band, aligned to layers.
        # Keep only up to layer_count entries; blanks become None; strings are
        # capped so an over-long name can't blow past the OLED width.
        names = cfg.get("layer_names")
        if isinstance(names, list):
            clean = []
            for v in names[:cfg["layer_count"]]:
                clean.append(v.strip()[:20] if isinstance(v, str) and v.strip()
                             else None)
            cfg["layer_names"] = clean if any(clean) else None
        else:
            cfg["layer_names"] = None
        self.config = cfg
        self.engine.set_screen(cfg["screen"].get("width", 1920),
                               cfg["screen"].get("height", 1080))

    def key_pin_names(self):
        c = self.config
        return c["pins"] or list(MODELS[MODEL]["pin_order"][: c["key_count"]])

    def nav_pin_names(self):
        """The effective PSH/BACK/CONFIRM pins (config override or the model
        default), or None on a model without nav buttons (core6)."""
        base = MODELS[MODEL].get("nav")
        if not base:
            return None
        return self.config.get("nav") or list(base)

    def _file_exists(self, path):
        try:
            os.stat(path)
            return True
        except OSError:
            return False

    def profile_key_path(self, key_no):
        """The active profile's file for a numbered key (no fallback) — used
        by the speed editor's copy-on-write so a per-app speed lands in the
        profile, not the shared standalone macro."""
        return "/macros/%s_key%d.json" % (self.profile_id, key_no)

    def macro_path(self, key_no):
        return self.macro_path_for(key_no, self.layer)

    def macro_path_for(self, key_no, layer_idx):
        if self.profile_id:
            # A profile is a full, independent config (issue #23): a new one is
            # seeded as a copy of the standalone keys, so its files ARE the
            # config. No fallback to the standalone macro — a key the user
            # cleared has no profile file and must do nothing, not inherit the
            # global assignment (that's what "not assigned in this profile"
            # means). Module slots keep their fallback (see slot_path).
            return "/macros/%s_key%d.json" % (self.profile_id, key_no)
        if layer_idx == 0:
            return "/macros/key%d.json" % key_no
        return "/macros/key%d-%s.json" % (key_no, LAYER_NAMES[layer_idx])

    def slot_path(self, slot, layer_idx):
        """Macro file behind an encoder/nav virtual slot (see UI_SLOTS)."""
        if self.profile_id:
            p = "/macros/%s_%s.json" % (self.profile_id, slot)
            if self._file_exists(p):
                return p  # overridden in this profile
        if layer_idx == 0:
            return "/macros/%s.json" % slot
        return "/macros/%s-%s.json" % (slot, LAYER_NAMES[layer_idx])

    def slot_ctx_path(self, slot, ctx):
        """Macro file overriding a nav control inside a menu context
        ("home" = the layer picker, "menu" = settings). Global — menus are
        not layered, so no layer suffix (issue #19)."""
        return "/macros/%s@%s.json" % (slot, ctx)

    def set_layer_idx(self, i):
        """Single path for layer changes: serial set_layer, the layer key,
        and the vision6 encoder menu all land here."""
        self.layer = i
        self.led.set(layer=i)
        self.announce_layer()
        self.ui_call("on_layer")

    def menu_layer_jump(self, menu):
        """Resolve a layer-jump device-menu action (layer_next / layer_prev /
        layer_a..layer_h) to an absolute layer and switch to it. Used on core6,
        which has no menu UI but must still honor a "go to layer X" key
        (issue #30); vision6 routes these through the menu instead."""
        if not menu:
            return
        n = self.config["layer_count"]
        if menu == "layer_next":
            self.set_layer_idx((self.layer + 1) % n)
        elif menu == "layer_prev":
            self.set_layer_idx((self.layer - 1) % n)
        elif menu[:6] == "layer_" and len(menu) == 7:
            i = LAYER_NAMES.find(menu[6])
            if 0 <= i < n:
                self.set_layer_idx(i)

    def set_profile(self, pid):
        """Switch the active per-app profile (or None). The set of macro
        files behind the grid changes, so the UI must drop its cached
        labels/speeds/slots and repaint."""
        if pid == self.profile_id:
            return
        self.profile_id = pid
        self.ui_call("on_profile")

    def ui_call(self, name, *args):
        """Run a UI hook, but never let a display/menu failure (including a
        MemoryError from displayio churn) take the keypad down with it —
        keys and serial must keep working even if a screen draw dies."""
        if not self.ui:
            return
        # A file transfer must own the main loop. Every repaint costs 100-300ms
        # in which the USB receive FIFO is not drained, and the chunk arriving
        # then loses bytes out of the middle of its line — a corrupted or
        # dropped chunk, i.e. a failed save. The app suppresses its own status
        # pushes during a transfer too; this covers the ones already queued
        # (and any older app). State still updates; the screen catches up in
        # one repaint when the transfer ends.
        # The same goes for a firmware update, which owns the screen as well as
        # the link: a status push arriving mid-update repainted the grid over
        # the "do not unplug" screen for one frame before the next chunk drew
        # it again (issue #35).
        if (self.upload is not None or self.updating) and name in COSMETIC_HOOKS:
            self.ui_stale = True
            return
        try:
            getattr(self.ui, name)(*args)
        except Exception as e:
            print("ui error in", name, ":", repr(e))
            try:
                # full traceback on the console — a bare repr made the layer
                # MemoryError hunt blind guesswork
                import traceback
                traceback.print_exception(e)
            except Exception:
                pass
            gc.collect()

    def send_config(self):
        cfg = dict(self.config)
        cfg["t"] = "config"
        self.proto.send(cfg)

    # --- serial ---
    def hello(self):
        c = self.config
        return {"t": "hello", "fw": self.fw_version, "proto": PROTO_VERSION,
                "format": "mkyada", "uid": uid_hex(), "model": self.model,
                "key_count": c["key_count"], "layer_key": c["layer_key"],
                "layer_count": c["layer_count"], "layer_mode": c["layer_mode"],
                "key_map": c["key_map"], "usb_drive": c["usb_drive"],
                "pins": self.key_pin_names(), "nav": self.nav_pin_names(),
                "show_layer": c["show_layer"], "show_profile": c["show_profile"],
                "timeout": c.get("timeout"),
                "enc_swap": c.get("enc_swap"), "layer_names": c.get("layer_names"),
                # Biggest raw fs_write chunk this board can digest. A chunk
                # arrives as ONE base64 line needing a single contiguous heap
                # block, and the display model's heap is fragmented enough to
                # refuse 2KB while reporting 13KB free — so it names its own
                # safe size instead of letting the host discover it by
                # crashing the transfer. Older apps ignore the field.
                "fs_chunk": FS_WRITE_CHUNK,
                "layer": LAYER_NAMES[self.layer], "mode": self.mode}

    def handle_msg(self, msg, in_playback=False):
        """Process one serial message. Returns True if playback must stop."""
        t = msg.get("t")
        self.last_rx = time.monotonic()
        if self.updating:
            # any traffic keeps the locked update session alive
            self.update_deadline = time.monotonic() + UPDATE_IDLE_ABORT_S
        if t == "ping":
            self.proto.send({"t": "pong"})
        elif t == "identify":
            self.proto.send(self.hello())
        elif t == "stop":
            return True
        elif in_playback:
            # file ops can't run mid-playback — tell the app instead of
            # letting it wait for a response that never comes
            if t in ("fs_list", "fs_read", "fs_write", "fs_delete"):
                self.proto.send({"t": "err", "re": t, "code": "busy",
                                 "msg": "playback in progress"})
            return False  # everything else waits until playback ends
        elif self.updating and t not in (
                "fs_list", "fs_read", "fs_write", "fs_delete", "fs_ack",
                "update_begin", "update_end", "update_abort", "get_config",
                "reset", "bootloader"):
            # locked update mode: nothing may compete with the transfer —
            # tell the app instead of silently dropping the command
            self.proto.send({"t": "err", "re": t, "code": "updating",
                             "msg": "update in progress"})
        elif t == "update_begin":
            # Locked update mode: keys, menus and playback are suspended,
            # the screen shows transfer progress, and only file traffic is
            # accepted until update_end resets the board (or the app goes
            # silent for UPDATE_IDLE_ABORT_S and the keypad unlocks itself).
            self.stop_pin_watch()
            self.close_upload(discard=True)
            self.updating = True
            try:
                self.update_total = max(0, int(msg.get("bytes") or 0))
            except (TypeError, ValueError):
                self.update_total = 0
            self.update_done = 0
            self.update_last_frac = -1.0
            self.update_deadline = time.monotonic() + UPDATE_IDLE_ABORT_S
            self.led.set(state=ledmod.PLAYING)
            self.proto.send({"t": "ok", "re": "update_begin"})
            self.show_update()
        elif t == "update_end":
            self.proto.send({"t": "ok", "re": "update_end"})
            if OLED:
                try:
                    OLED.show_update(1.0, restarting=True)
                except Exception:
                    pass
            time.sleep(0.2)
            microcontroller.reset()
        elif t == "update_abort":
            self.end_update()
            self.proto.send({"t": "ok", "re": "update_abort"})
        elif t == "bootloader":
            # Enter the UF2 bootloader without the physical BOOT button —
            # the only way to reflash CircuitPython on a sealed unit.
            self.proto.send({"t": "ok", "re": "bootloader"})
            time.sleep(0.1)
            try:
                microcontroller.on_next_reset(microcontroller.RunMode.UF2)
            except Exception:
                try:
                    microcontroller.on_next_reset(
                        microcontroller.RunMode.BOOTLOADER)
                except Exception:
                    return self.fs_err("bootloader", "unsupported")
            microcontroller.reset()
        elif t in ("fs_list", "fs_read", "fs_write", "fs_delete"):
            # An fs op that OOMs (fragmented heap right after a connect's
            # display churn) must answer "oom" — an escaped MemoryError would
            # hit run()'s fatal handler and hard-RESET the board, and a
            # swallowed one would strand the host on its timeout.
            try:
                getattr(self, t)(msg)
            except MemoryError:
                gc.collect()
                self.fs_err(t, "oom", "out of memory")
        elif t == "fs_ack":
            pass  # stray ack from a transfer we already gave up on
        elif t == "host_enter":
            self.set_mode("host")
            self.proto.send({"t": "ok", "re": "host_enter"})
        elif t == "host_leave":
            self.set_mode("standalone")
            self.proto.send({"t": "ok", "re": "host_leave"})
        elif t == "test_enter":
            # Suppress macro playback on every model (issue #33). core6 has no
            # screen, so ui_call is a harmless no-op there.
            self.test_mode = True
            self.test_local = False
            self.test_ui = msg.get("ui") or "wiring"
            self.ui_call("on_test_enter", self.test_ui)
            self.proto.send({"t": "ok", "re": "test_enter"})
        elif t == "test_leave":
            if self.test_mode:
                self.test_mode = False
                self.test_local = False
                self.ui_call("on_test_leave")
            self.proto.send({"t": "ok", "re": "test_leave"})
        elif t == "profile":
            # Activate/clear a per-app profile: redirect macro paths to the
            # profile's files so the device runs it natively (issue #23). No
            # host mode — the wheel, nav and speed editor keep working.
            pid = msg.get("id")
            self.set_profile(str(pid) if pid else None)
            self.proto.send({"t": "ok", "re": "profile"})
        elif t == "play":
            path = "/" + str(msg.get("file", "")).lstrip("/")
            self.play_file(path, trigger=None,
                           speed=msg.get("speed"), repeat=msg.get("repeat"),
                           hold=bool(msg.get("hold")))
        elif t == "keys":
            self.engine.tap_combo(msg.get("mods"), str(msg.get("key", "")))
            self.proto.send({"t": "ok", "re": "keys"})
        elif t == "get_config":
            self.send_config()
        elif t == "reload":
            self.stop_pin_watch()
            self.load_config()
            self.buttons.deinit()
            self.buttons = KeyMatrix(resolve_pins(self.key_pin_names()))
            self.layer = 0
            self.led.set(layer=0)
            self.proto.send({"t": "ok", "re": "reload"})
            self.proto.send(self.hello())
            self.announce_layer()
            self.ui_call("on_reload")
        elif t == "reset":
            # Hard reset: re-runs boot.py (needed after firmware updates).
            self.proto.send({"t": "ok", "re": "reset"})
            time.sleep(0.1)
            microcontroller.reset()
        elif t == "set_layer":
            name = str(msg.get("layer", "a"))
            if name in LAYER_NAMES[: self.config["layer_count"]]:
                self.proto.send({"t": "ok", "re": "set_layer"})
                self.set_layer_idx(LAYER_NAMES.index(name))
        elif t == "pin_detect":
            if msg.get("on"):
                self.start_pin_watch()
            else:
                self.stop_pin_watch()
            self.proto.send({"t": "ok", "re": "pin_detect"})
        elif t == "label":
            # the app's active profile: its name for the grid band (config
            # show_profile) and, since proto v6, its six key names — shown
            # as a grid on the host-mode screen instead of the bare
            # "Connected to app" text. Empty text / absent keys clear;
            # cleared automatically when the app disconnects.
            text = str(msg.get("text") or "")[:24] or None
            keys = msg.get("keys")
            if isinstance(keys, list) and keys:
                keys = [str(k or "")[:24] for k in keys[:6]]
                if not any(keys):
                    keys = None
            else:
                keys = None
            rec = bool(msg.get("rec"))
            live = bool(msg.get("live"))
            self.proto.send({"t": "ok", "re": "label"})
            if (text != self.host_label or keys != self.host_keys
                    or rec != self.host_rec or live != self.host_live):
                self.host_label = text
                self.host_keys = keys
                self.host_rec = rec
                self.host_live = live
                self.ui_call("on_label")
        elif t == "scroll":
            # direct wheel ticks (proto v6): the app drives profile wheel
            # slots through this with host-side acceleration — no file, no
            # play_start/done round-trip, so a spin feels like a real wheel
            try:
                self.engine.wheel_burst(msg.get("dy"), msg.get("dx"),
                                        msg.get("mods"))
            except (ValueError, TypeError) as e:
                # garbage numbers, or the USB stack rejected the report
                # (boot.py descriptor older than engine.py — power-cycle)
                self.proto.send({"t": "err", "re": "scroll", "code": "hid",
                                 "msg": str(e)})
            else:
                self.proto.send({"t": "ok", "re": "scroll"})
        elif t == "hostinfo":
            # The app advertises which optional features it speaks. Today just
            # wheel menus (context-aware CONFIRM): without this, the device
            # keeps host-kind keys on the "app required" toast. An old app
            # never sends it; the flag clears on disconnect (run_loop).
            self.host_menus = bool(msg.get("menus"))
        elif t == "sysvol":
            # live system output volume for the grid (the device can't read it):
            # the app pushes it while connected; volume-kind cells show it.
            self.ui_call("on_sysvol", msg.get("percent"))
        elif t == "menu":
            # render / update the on-screen wheel menu (host-fed list, slider
            # or status card). The UI owns what's currently open.
            self.ui_call("on_menu", msg)
        elif t == "menu_result":
            # the app finished a picked action: close the menu, optionally show
            # a toast and invalidate a rewritten macro's cached label.
            self.ui_call("on_menu_result", msg)
        elif t == "led":
            # app feedback color (e.g. mic muted -> red); "off" restores the
            # normal LED grammar. Cleared automatically on app disconnect.
            mode = str(msg.get("mode", "off"))
            if mode == "off":
                self.led.clear_override()
            else:
                self.led.set_override(mode, msg.get("rgb") or (255, 0, 0))
            self.proto.send({"t": "ok", "re": "led"})
        return False

    def announce_layer(self):
        """Tell a connected app which layer is active (sidebar indicator)."""
        self.proto.send({"t": "layer", "layer": LAYER_NAMES[self.layer]})

    # --- locked update mode ---
    def end_update(self):
        if not self.updating:
            return
        self.updating = False
        self.close_upload(discard=True)
        self.set_mode(self.mode)  # restore the LED grammar
        self.ui_call("on_reload")  # repaint whatever screen was up

    def show_update(self):
        if not OLED or not self.updating:
            return
        frac = (self.update_done / self.update_total) if self.update_total else 0.0
        frac = min(1.0, max(0.0, frac))
        # repaint at most every 2% — the OLED refresh must not slow the
        # transfer down to its own frame rate
        if frac - self.update_last_frac < 0.02 and self.update_last_frac >= 0:
            return
        self.update_last_frac = frac
        try:
            OLED.show_update(frac, False, self.update_done, self.update_total)
        except Exception:
            gc.collect()

    # --- serial file management (proto v3) ---
    # With the USB drive hidden (config usb_drive=false) the app can't reach
    # the filesystem as mass storage, so it manages files over serial:
    #   fs_list {path} -> {"t":"fs_list","entries":[{name,size,dir}]}
    #   fs_read {path} -> fs_chunk stream (base64), app answers fs_ack each
    #   fs_write {path,seq,data,eof} -> ok per chunk; .part temp + rename
    #   fs_delete {path} -> ok
    # Writes need a writable filesystem, i.e. the drive must be hidden —
    # otherwise the host owns it and we answer {"code":"readonly"}.

    def fs_err(self, re, code, msg=""):
        self.proto.send({"t": "err", "re": re, "code": code, "msg": str(msg)})

    def fs_path(self, msg):
        p = "/" + str(msg.get("path", "")).lstrip("/")
        if ".." in p or p == "/":
            return None
        return p

    def close_upload(self, discard=False):
        up = self.upload
        self.upload = None
        if not up:
            return
        try:
            up["f"].close()
        except Exception:
            pass
        if discard:
            try:
                os.remove(up["tmp"])
            except OSError:
                pass

    def fs_list(self, msg):
        gc.collect()
        path = "/" + str(msg.get("path", "")).strip("/")
        try:
            names = os.listdir(path)
        except OSError as e:
            return self.fs_err("fs_list", "not_found", e)
        # Paginate: a well-used keypad's macros dir holds dozens of files
        # (layers + profile copies), and serializing them as ONE reply needs a
        # multi-KB contiguous string — which a display-churned heap can't
        # always give. The dumps then MemoryError'd and the reply was silently
        # lost: the app saw a keypad that never answered ("keys all blank").
        # Small batches keep every allocation tiny; "more" marks continuation.
        batch = []
        for name in names:
            try:
                st = os.stat((path.rstrip("/") + "/" + name))
            except OSError:
                continue
            batch.append({"name": name, "size": st[6],
                          "dir": bool(st[0] & 0x4000)})
            if len(batch) >= 8:
                self.proto.send({"t": "fs_list", "path": path,
                                 "entries": batch, "more": True})
                batch = []
                gc.collect()
        self.proto.send({"t": "fs_list", "path": path, "entries": batch})

    def fs_read(self, msg):
        path = self.fs_path(msg)
        if not path:
            return self.fs_err("fs_read", "bad_path", msg.get("path"))
        gc.collect()  # compact the heap before the transfer's transient buffers
        try:
            f = open(path, "rb")
        except OSError as e:
            return self.fs_err("fs_read", "not_found", e)
        seq = 0
        crc = 0
        # Adaptive chunking: each chunk's transient buffers (raw + base64 +
        # the JSON line, several copies at once) need contiguous heap, and a
        # display-churned vision6 sometimes can't give even the 1KB default —
        # one big recorded macro then failed with "oom" on EVERY retry. When a
        # chunk OOMs (read, encode, or send), rewind the file and halve the
        # chunk size instead of giving up; 128-byte pieces always fit.
        size = FS_CHUNK
        try:
            while True:
                self.feed()
                pos = f.tell()
                try:
                    chunk = f.read(size)
                    eof = len(chunk) < size
                    data = b2a_base64(chunk).decode().strip() if chunk else ""
                    out = {"t": "fs_chunk", "path": path, "seq": seq,
                           "data": data, "eof": eof}
                    if eof:
                        out["crc"] = crc32(chunk, crc) & 0xFFFFFFFF
                    sent = self.proto.send(out)
                except MemoryError:
                    chunk = data = out = None
                    gc.collect()
                    if size > 128:
                        size //= 2
                        f.seek(pos)
                        continue
                    raise
                if not sent:
                    # the reply couldn't be serialized/written — treat like an
                    # OOM: shrink and resend this same chunk rather than
                    # leaving the host waiting for a line that never went out
                    chunk = data = out = None
                    gc.collect()
                    if size > 128:
                        size //= 2
                        f.seek(pos)
                        continue
                    raise MemoryError("send")
                crc = crc32(chunk, crc)
                # free this chunk's buffers before the next read so the heap
                # stays compact — a big recorded macro is many chunks and the
                # display stack leaves little contiguous room on vision6
                chunk = data = out = None
                gc.collect()
                if eof:
                    break
                if not self.wait_fs_ack():
                    break  # app went away mid-read
                seq += 1
        except MemoryError:
            # never let a read take the keypad down (which would repaint the
            # console onto the OLED) — tell the app so it can retry
            gc.collect()
            self.fs_err("fs_read", "oom", "out of memory")
        finally:
            f.close()
            gc.collect()

    def wait_fs_ack(self):
        """Flow control for fs_read: one chunk in flight at a time."""
        t0 = time.monotonic()
        while time.monotonic() - t0 < FS_ACK_TIMEOUT_S:
            self.feed()
            for m in self.proto.poll():
                self.last_rx = time.monotonic()
                if m.get("t") == "fs_ack":
                    return True
                if m.get("t") == "ping":
                    self.proto.send({"t": "pong"})
                # anything else mid-transfer is dropped on purpose
            self.led.tick()
            time.sleep(0.002)
        return False

    def fs_write(self, msg):
        path = self.fs_path(msg)
        if not path:
            return self.fs_err("fs_write", "bad_path", msg.get("path"))
        seq = int(msg.get("seq") or 0)
        if seq == 0:
            self.close_upload(discard=True)
            tmp = path + ".part"
            try:
                self.fs_mkparents(path)
                f = open(tmp, "wb")
            except OSError as e:
                code = "readonly" if (e.args and e.args[0] == 30) else "io"
                return self.fs_err("fs_write", code, e)
            self.upload = {"path": path, "tmp": tmp, "f": f, "seq": 0, "crc": 0}
        up = self.upload
        if not up or up["path"] != path or seq != up["seq"]:
            self.close_upload(discard=True)
            return self.fs_err("fs_write", "bad_seq", seq)
        self.upload_at = time.monotonic()
        data = msg.get("data")
        try:
            if data:
                raw = a2b_base64(data)
                up["f"].write(raw)
                up["crc"] = crc32(raw, up["crc"])
                if self.updating:
                    self.update_done += len(raw)
                    self.show_update()
                raw = None
        except (OSError, ValueError) as e:
            self.close_upload(discard=True)
            return self.fs_err("fs_write", "io", e)
        up["seq"] += 1
        if not msg.get("eof"):
            return self.proto.send({"t": "ok", "re": "fs_write", "seq": seq})
        # end-to-end integrity: the sender may attach the whole file's CRC32
        # to the eof chunk — a mismatch discards the .part so a corrupted
        # transfer can never replace a good file
        got = up["crc"] & 0xFFFFFFFF
        want = msg.get("crc")
        if want is not None:
            try:
                want = int(want) & 0xFFFFFFFF
            except (TypeError, ValueError):
                want = None
        if want is not None and want != got:
            self.close_upload(discard=True)
            return self.fs_err("fs_write", "crc", "crc mismatch")
        self.upload = None
        try:
            up["f"].close()
            try:
                os.remove(path)  # FAT rename can't overwrite
            except OSError:
                pass
            os.rename(up["tmp"], path)
        except OSError as e:
            return self.fs_err("fs_write", "io", e)
        self.proto.send({"t": "ok", "re": "fs_write", "seq": seq, "eof": True,
                         "crc": got})
        if path.startswith("/macros/"):
            self.ui_call("invalidate_labels", path)

    def fs_mkparents(self, path):
        parts = path.split("/")[1:-1]
        cur = ""
        for p in parts:
            cur += "/" + p
            try:
                os.mkdir(cur)
            except OSError:
                pass  # already exists (or open() will surface the error)

    def fs_delete(self, msg):
        path = self.fs_path(msg)
        if not path:
            return self.fs_err("fs_delete", "bad_path", msg.get("path"))
        try:
            os.remove(path)
        except OSError as e:
            code = "readonly" if (e.args and e.args[0] == 30) else "not_found"
            return self.fs_err("fs_delete", code, e)
        self.proto.send({"t": "ok", "re": "fs_delete", "path": path})

    def set_mode(self, mode):
        self.mode = mode
        self.led.set(state=ledmod.HOST if mode == "host" else ledmod.IDLE,
                     layer=self.layer)
        self.ui_call("on_mode", mode)

    # --- pin detect (key wiring wizard) ---
    # The app turns this on, asks the user to press the mystery key, and
    # reads which GPIO toggles. Normal key handling is suspended meanwhile.
    PIN_WATCH_TIMEOUT_S = 120.0

    def start_pin_watch(self):
        self.stop_pin_watch()
        self.buttons.deinit()
        names = detect_candidates(MODEL)
        self.pin_watch = (names, Buttons(resolve_pins(names)))
        self.pin_watch_until = time.monotonic() + self.PIN_WATCH_TIMEOUT_S

    def stop_pin_watch(self):
        if not self.pin_watch:
            return
        _, watch = self.pin_watch
        self.pin_watch = None
        watch.deinit()
        self.buttons = KeyMatrix(resolve_pins(self.key_pin_names()))

    def tick_pin_watch(self, now):
        names, watch = self.pin_watch
        for i, pressed in watch.scan():
            self.proto.send({"t": "pin", "pin": names[i], "down": pressed})
        if now > self.pin_watch_until or not self.proto.connected:
            self.stop_pin_watch()

    # --- key logic (macro format v3) ---
    def resolve_variant(self, i, variants, settings):
        """Decide tap / double press / long press for pressed key i.
        Top-level events are the tap; variants hold the alternatives.
        Blocks briefly (bounded by hold_ms / double_ms), like playback does.
        Zero added latency when only a tap exists — callers skip this."""
        hold_s = (settings.get("hold_ms") or 400) / 1000.0
        double_s = (settings.get("double_ms") or 250) / 1000.0
        has_hold = isinstance(variants.get("hold"), dict)
        has_double = isinstance(variants.get("double"), dict)
        t0 = time.monotonic()
        while self.buttons.stable[i]:
            if has_hold and time.monotonic() - t0 >= hold_s:
                return "hold"
            self.buttons.scan()
            self.pump()  # keep serial drained; commands run after the gesture
            self.led.tick()
            time.sleep(0.002)
        if not has_double:
            return "tap"
        t1 = time.monotonic()
        while time.monotonic() - t1 < double_s:
            for j, pressed in self.buttons.scan():
                if j == i and pressed:
                    return "double"
            self.pump()
            self.led.tick()
            time.sleep(0.002)
        return "tap"

    # --- playback ---
    def load_macro(self, f):
        """First line decides the flavor: v4 stream header ({"stream":true}
        + one event per following line), single-line whole-file JSON (what
        the app writes for proto<=3), or pretty-printed JSON (hand-made).
        Returns (data, stream_pos): stream_pos is the file offset of the
        first event line for stream files, None for whole-file macros."""
        line = f.readline()
        try:
            data = json.loads(line)
        except ValueError:
            f.seek(0)
            data = json.load(f)  # pretty-printed multi-line file
            return data, None
        if isinstance(data, dict) and data.get("stream"):
            return data, f.tell()
        return data, None

    def stream_events(self, f):
        """Yield events from a v4 stream file one JSON line at a time —
        O(1) RAM per event, so macro length is bounded by flash, not RAM."""
        while True:
            line = f.readline()
            if not line:
                return
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except ValueError:
                pass  # skip a corrupt line rather than abort mid-macro

    def hold_key(self, events, trigger, should_stop):
        """Single-key hold passthrough: press the HID key, keep the report
        held while the physical key stays down, release on release. The host
        OS's typematic repeat generates the character stream — exactly a
        normal keyboard's rate and initial delay. `trigger` None = a serial
        hold play: released by the app's "stop" (via should_stop) or when
        the app goes away."""
        self.engine.key_down(events[0])
        try:
            while True:
                if should_stop():
                    raise StopPlayback()
                if trigger is not None:
                    if not self.buttons.stable[trigger]:
                        return
                elif (not self.proto.connected
                        or time.monotonic() - self.last_rx > PING_TIMEOUT_S):
                    return  # app vanished mid-hold: never leave a key stuck
                self.led.tick()
                time.sleep(0.002)
        finally:
            self.engine.key_up(events[1])

    def play_file(self, path, trigger=None, speed=None, repeat=None,
                  hold=False, variant=None):
        f = None
        try:
            gc.collect()
            f = open(path, "rb")  # binary keeps tell/seek exact for replays
            data, stream_pos = self.load_macro(f)
            if stream_pos is None:
                f.close()
                f = None
        except OSError:
            if f:
                f.close()
            self.led.error()
            self.proto.send({"t": "err", "re": "play", "code": "not_found", "msg": path})
            return
        except ValueError:
            if f:
                f.close()
            self.led.error()
            self.proto.send({"t": "err", "re": "play", "code": "bad_json", "msg": path})
            return
        except MemoryError:
            if f:
                f.close()
            gc.collect()
            self.led.error()
            self.proto.send({"t": "err", "re": "play", "code": "oom", "msg": path})
            return
        if not isinstance(data, dict) or data.get("format") not in MACRO_FORMATS:
            if f:
                f.close()
            self.led.error()
            self.proto.send({"t": "err", "re": "play", "code": "bad_format", "msg": path})
            return

        # key logic: standalone presses pick tap/double/hold themselves; a
        # Vision 6 nav slot passes the gesture it already resolved as
        # `variant` (mkyada/ui.py). The chosen variant is announced so the
        # app can run host-side variants (launch/command/sound compile to
        # empty events on the device). Runs BEFORE the menu-kind check so a
        # variant can swap in a different kind — e.g. tap drives the menu,
        # hold plays a real macro, or the other way around.
        # Stream files carry no variants (the app never writes that combo);
        # a stray "variants" in a stream header is ignored and plays as tap.
        variants = data.get("variants") if stream_pos is None else None
        if isinstance(variants, dict) and variants and (
                trigger is not None or variant in ("double", "hold")):
            if trigger is not None:
                choice = self.resolve_variant(trigger, variants,
                                              data.get("settings") or {})
            else:
                choice = variant if isinstance(variants.get(variant), dict) else "tap"
            if self.proto.connected:
                self.proto.send({"t": "key_action", "file": path,
                                 "key": (self.config["key_map"][trigger]
                                         if trigger is not None else None),
                                 "layer": LAYER_NAMES[self.layer],
                                 "variant": choice})
            if choice != "tap":
                v = variants.get(choice) or {}
                data["events"] = v.get("events") or []
                data["kind"] = v.get("kind")
                data["menu"] = v.get("menu")
                s = dict(data.get("settings") or {})
                s.update(v.get("settings") or {})
                data["settings"] = s

        # A "menu" macro drives the on-screen menu instead of the HID engine:
        # a normal key acts like the encoder / CONFIRM / BACK. No-op without a
        # display (core6 has no UI to steer), but harmless.
        if data.get("kind") == "menu":
            if f:
                f.close()
            menu = data.get("menu")
            self.proto.send({"t": "play_start", "file": path})
            if self.ui:
                self.ui_call("inject", menu)
            else:
                # core6 has no menu UI, but a "go to layer X" key must still
                # switch layers (issue #30). Other menu actions stay no-ops.
                self.menu_layer_jump(menu)
            self.proto.send({"t": "play_done", "file": path, "stopped": False})
            return

        settings = data.get("settings") or {}
        if speed is None:
            speed = settings.get("speed", 1.0)
        if repeat is None:
            repeat = settings.get("repeat", 1)
        loop = int(repeat) == 0
        # what a re-press of the same key does while playing: stop or restart
        on_repress = settings.get("on_repress", "stop")
        events = data.get("events") or []
        screen = data.get("screen")
        # A plain single-key macro: one key down + its up, nothing else.
        # These get the real-keyboard hold treatment (issue #20): the HID
        # usage stays down while the physical key is down and the HOST's
        # typematic repeat produces the eeee… stream at the user's own
        # keyboard rate — replaying the file per character capped at ~7 cps.
        plain_tap = (not variants and len(events) == 2
                     and events[0].get("type") == "key"
                     and events[0].get("action") == "down"
                     and events[1].get("type") == "key"
                     and events[1].get("action") == "up"
                     and events[0].get("key") == events[1].get("key"))
        # replay while the physical key is held down (like OS key repeat);
        # single keys default ON — "hold_repeat": false opts out
        hold_repeat = settings.get("hold_repeat")
        if hold_repeat is None:
            hold_repeat = plain_tap and data.get("kind", "keystroke") == "keystroke"
        hold_repeat = bool(hold_repeat)

        self.playing_key = trigger
        self.led.set(state=ledmod.LOOPING if loop else ledmod.PLAYING)
        self.proto.send({"t": "play_start", "file": path})
        self.ui_call("on_play_start", trigger, path)
        stopped = False

        def should_stop():
            # Same key again: stop (or queue a restart). Another macro key:
            # per config, ignore it or switch to its macro. Host plays
            # (trigger None) stop on any key.
            self.feed()
            for i, pressed in self.buttons.scan():
                if not pressed:
                    continue
                if trigger is None or i == trigger:
                    if trigger is not None and on_repress == "restart":
                        self.pending_play = (path, trigger)
                    return True
                if trigger is not None and self.config["busy_other"] == "switch":
                    key_no = self.config["key_map"][i]
                    if self.config["layer_key"] == key_no:
                        continue
                    self.pending_play = (self.macro_path(key_no), i)
                    return True
            # Process the whole batch even once a stop is seen: a file
            # request polled alongside the stop must still get its "busy"
            # reply, or the app's write waits out its full timeout instead
            # of retrying the moment playback ends.
            stop = False
            for m in self.proto.poll():
                if self.handle_msg(m, in_playback=True):
                    stop = True
            return stop

        try:
            if (plain_tap and not loop and int(repeat) == 1
                    and (hold or (hold_repeat and trigger is not None))):
                # real-keyboard hold: HID key down until the physical key
                # (or, for serial holds, the app's "stop") lets go
                self.hold_key(events, trigger, should_stop)
            else:
                runs = 0
                while True:
                    if stream_pos is None:
                        evs = events
                    else:
                        f.seek(stream_pos)  # each pass re-reads the event lines
                        evs = self.stream_events(f)
                    self.engine.play(evs, screen=screen, speed=speed,
                                     should_stop=should_stop, tick=self.led.tick)
                    runs += 1
                    if loop:
                        continue
                    if runs < max(1, int(repeat)):
                        continue
                    # "aaaa…" behaviour: keep replaying while the key stays down
                    if hold_repeat and trigger is not None and self.buttons.stable[trigger]:
                        self.buttons.scan()  # keep edge state fresh
                        if self.buttons.stable[trigger]:
                            continue
                    break
        except StopPlayback:
            stopped = True
        except MemoryError:
            stopped = True
            gc.collect()
            self.led.error()
            self.proto.send({"t": "err", "re": "play", "code": "oom", "msg": path})
        except OSError:
            stopped = True
            self.led.error()
            self.proto.send({"t": "err", "re": "play", "code": "io", "msg": path})
        except ValueError as e:
            # USB stack rejected a report — classic cause: boot.py's HID
            # descriptor (applied only at power-on) predates engine.py's
            # report layout after a partial update. Fail the key soft; a
            # power cycle re-runs boot.py and heals the mismatch.
            stopped = True
            self.led.error()
            self.proto.send({"t": "err", "re": "play", "code": "hid", "msg": str(e)})
        finally:
            if f:
                f.close()
            self.playing_key = None
            events = data = None
            gc.collect()
            self.set_mode(self.mode)  # restore idle/host LED
            self.proto.send({"t": "play_done", "file": path, "stopped": stopped})
            self.ui_call("on_play_done")

    # --- key handling ---
    def on_edge(self, i, pressed):
        if self.updating:
            return  # keys are dead during a locked update
        c = self.config
        key_no = c["key_map"][i]  # logical key; i is the GPIO (solder) index
        # stream edges to a connected app in BOTH modes: standalone edges
        # power computer-side key actions (launch/command/sound) and the live
        # keypad view even when no profile holds host mode
        if self.mode == "host" or self.proto.connected:
            self.proto.send({"t": "btn", "key": key_no, "phys": i + 1,
                             "layer": LAYER_NAMES[self.layer],
                             "edge": "down" if pressed else "up"})
        if self.test_mode:
            # Test mode (Setup or Keys tab): never play the macro. On a Vision 6
            # the screen echoes the pressed key + pin so wiring/keys can be
            # verified; core6 just swallows it.
            if pressed:
                self.ui_call("on_test_key", key_no, self.key_pin_names()[i])
            return
        if self.mode == "host":
            return
        if c["layer_key"] == key_no:
            if pressed:
                self.set_layer_idx((self.layer + 1) % c["layer_count"])
            return
        if pressed:
            # Slider-style keys (volume / mic level) have no useful "run": a
            # bare press opens their wheel menu directly, so the physical key
            # acts like selecting it and pressing PSH (issue: wheel-menu UX).
            if self.press_opens_menu(key_no):
                self.ui_call("open_key_menu", key_no)
                return
            self.play_file(self.macro_path(key_no), trigger=i)

    def press_opens_menu(self, key_no):
        """Whether pressing this key should open its wheel menu instead of
        playing (Vision 6 slider kinds). Safe on core6 (no ui)."""
        if not self.ui:
            return False
        try:
            return self.ui.wants_press_menu(key_no)
        except Exception:
            return False

    # --- main loop ---
    def run(self):
        # A MemoryError is a MOMENT, not a broken keypad: the heap is
        # fragmented right now, and the allocation that failed (usually a
        # serial line during a macro save) will fit again after a collect.
        # Resetting for it aborted the transfer AND rebooted the board
        # mid-save. So: compact, resume the loop, and only fall through to
        # the branded reset if the failures keep coming (a real leak).
        oom = 0
        while True:
            try:
                self.run_loop() if oom == 0 else self.spin()
                return
            except MemoryError as e:
                oom += 1
                gc.collect()
                print("recovered from", repr(e), "free", _mem_free(),
                      "count", oom)
                if oom <= OOM_RECOVERIES:
                    continue
                return self.crash(e)
            except Exception as e:
                return self.crash(e)

    def crash(self, e):
        # Finished-product UX: a branded error screen instead of a raw
        # traceback (which CircuitPython would otherwise paint onto the
        # OLED once code stops), then a self-heal restart — a transient
        # failure (e.g. a MemoryError under load) must not leave a dead
        # keypad, and the console must never own the screen. The hard
        # reset (vs a soft reload) also disarms the watchdog and re-runs
        # boot.py, so the retry starts from a fully clean state.
        print("fatal:", repr(e))
        if OLED:
            try:
                OLED.show_error(repr(e))
            except Exception:
                pass
        t0 = time.monotonic()
        while time.monotonic() - t0 < 5:
            self.feed()  # keep the watchdog quiet while the error shows
            time.sleep(0.1)
        microcontroller.reset()

    def run_loop(self):
        self.led.set(state=ledmod.IDLE, layer=0)
        self.ui_call("start")
        # A Vision 6 whose menu module never loaded (self.ui is None: ui.py
        # shipped as source and the display-fragmented heap MemoryError'd on
        # the compile, or Ui() construction failed) must not sit forever on
        # the boot "loading" splash — that reads as a dead board. Replace it
        # with a clear status; keys and serial keep working, and the app can
        # reinstall the precompiled .mpy build to restore the menu.
        if OLED and not self.ui:
            try:
                OLED.show_headless()
            except Exception:
                pass
        self.arm_watchdog()
        self.spin()

    def spin(self):
        """The main loop proper. Split from run_loop's one-time setup so an
        absorbed MemoryError can resume it without re-running boot."""
        while True:
            self.feed()
            now = time.monotonic()
            if self.updating:
                # locked update: keys and menus are suspended; if the app
                # dies mid-transfer the lock must not outlive it
                if now > self.update_deadline:
                    print("update abandoned; unlocking")
                    self.end_update()
            elif self.pin_watch:
                self.tick_pin_watch(now)  # wiring wizard owns the keys
            else:
                for i, pressed in self.buttons.scan():
                    self.on_edge(i, pressed)
            # restart/switch policies queue the next macro instead of
            # recursing inside the playback stack
            while self.pending_play:
                path, trig = self.pending_play
                self.pending_play = None
                self.play_file(path, trigger=trig)
            # messages drained during blocking key logic run first, in order
            while self.inbox:
                self.handle_msg(self.inbox.pop(0))
            for msg in self.proto.poll():
                self.handle_msg(msg)
            if self.mode == "host":
                if (not self.proto.connected
                        or time.monotonic() - self.last_rx > PING_TIMEOUT_S):
                    self.set_mode("standalone")
            # app-commanded LED feedback must not outlive the app
            if self.led.override and not self.proto.connected:
                self.led.clear_override()
            # ...and neither must its profile label on the band
            if ((self.host_label or self.host_keys or self.host_rec
                 or self.host_live) and not self.proto.connected):
                self.host_label = None
                self.host_keys = None
                self.host_rec = False
                self.host_live = False
                self.ui_call("on_label")
            # the app's wheel-menu support (and any open host menu) can't
            # outlive the connection either
            if self.host_menus and not self.proto.connected:
                self.host_menus = False
                self.ui_call("on_host_gone")
            # a profile is app-driven too: revert to the standalone config so
            # a crashed/closed app can't strand the device on a profile
            if self.profile_id and not self.proto.connected:
                self.set_profile(None)
            # test mode is app-driven: a closed app must not strand the keypad
            # with its keys dead. Settings > Key test is the exception — it was
            # opened on the device and ends on the device (ui._leave_keytest).
            if self.test_mode and not self.test_local and not self.proto.connected:
                self.test_mode = False
                self.ui_call("on_test_leave")
            # a half-received upload must not leak its file handle either
            if self.upload and not self.proto.connected:
                self.close_upload(discard=True)
            # ...nor outlive the host that abandoned it. The host gives up on
            # a chunk after ~8s and simply stops sending; without this the
            # stale upload sat there forever, and since the UI is held still
            # during a transfer (below) that FROZE THE SCREEN — no layer
            # repaints, no blinking (R) — until the app disconnected.
            if self.upload and time.monotonic() - self.upload_at > UPLOAD_IDLE_S:
                print("upload abandoned:", self.upload["path"])
                self.close_upload(discard=True)
            # ...and neither must a locked update session
            if self.updating and not self.proto.connected:
                self.end_update()
            # A file transfer needs every contiguous byte it can get: the UI's
            # repaints allocate in the SAME size class as an incoming chunk,
            # so hold the screen still until the upload lands. (A save is a
            # second or two; a crash mid-save costs the whole macro.)
            if not self.updating and not self.upload:
                # catch up on whatever the transfer suppressed, in one paint
                if self.ui_stale:
                    self.ui_stale = False
                    self.ui_call("on_label")
                self.ui_call("tick", now)
            self.led.tick()
            # Heap trend on the console (~10s). OFF by default: the console
            # CDC is a shared resource and this is the line that made a debug
            # session unusable. Flip DEBUG_TELEMETRY to bring it back.
            if DEBUG_TELEMETRY and now - self._mem_report_at > 10:
                self._mem_report_at = now
                stats = None
                if self.ui:
                    try:
                        stats = self.ui.cache_stats()
                    except Exception:
                        pass
                print("memfree", _mem_free(), "alloc", _mem_alloc(),
                      "caches", stats)
            time.sleep(0.002)


def main():
    App().run()

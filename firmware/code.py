# MKYADA firmware — main loop.
#
# One codebase, two models (see mkyada/models.py):
#   core6    screenless keypad, keys on GP0.., layer key cycles layers
#   vision6  SH1106 OLED + EC11 encoder menu module, keys on the far edge
# Standalone: a key press plays the macro JSON mapped to it by name convention
#   (macros/key<N>.json, layer B -> key<N>-b.json, ...). No app required.
# Host mode: entered when the desktop app sends {"t":"host_enter"}; key events
#   stream to the app over serial and playback happens only on its commands.
#   Falls back to standalone if the app goes silent for PING_TIMEOUT seconds.

import gc
import json
import os
import time
from binascii import a2b_base64, b2a_base64

import board
import digitalio
import microcontroller

from mkyada.models import (MODELS, resolve_model, resolve_pins,
                           validate_key_pins, detect_candidates)


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
        OLED.show_boot()
    except Exception as e:  # display stack missing/broken: run headless
        print("oled init failed:", e)
        OLED = None

from mkyada import led as ledmod
from mkyada.engine import Engine, StopPlayback
from mkyada.led import Led
from mkyada.proto import Proto

if OLED:
    OLED.boot_progress(0.5)  # heavy imports done

try:
    from mkyada.ui import Ui
except ImportError:
    Ui = None

gc.collect()  # the display stack litters the heap; start the app compacted

DEBOUNCE_S = 0.02
PING_TIMEOUT_S = 5.0
PROTO_VERSION = 5  # v5: "play" accepts hold:true (key held until "stop");
                   # v4: streamed JSONL macro files (full-rate playback);
                   # v3: fs_* file management over serial (hidden-drive mode)
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
    "usb_drive": True,   # false = hide the CIRCUITPY drive from the host;
                         # the app manages files over serial instead (boot.py)
    "show_layer": False,    # vision6: band over the grid with the active layer
    "show_profile": False,  # vision6: band shows the app-pushed profile label
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


class App:
    def __init__(self):
        self.fw_version = read_text("/VERSION") or "0.0.0"
        self.model = MODEL
        self.engine = Engine()
        self.proto = Proto()
        self.led = Led()
        self.config = dict(DEFAULT_CONFIG)
        self.load_config()
        self.buttons = Buttons(resolve_pins(self.key_pin_names()))
        self.layer = 0
        self.mode = "standalone"
        self.last_rx = 0.0
        self.playing_key = None  # 0-based index of the key that started playback
        self.pending_play = None  # (path, trigger) queued by restart/switch policies
        self.upload = None  # in-flight fs_write: {"path", "tmp", "f", "seq"}
        self.pin_watch = None  # ("names", Buttons) while pin-detect mode is on
        self.pin_watch_until = 0.0
        self.host_label = None  # app-pushed profile/app label for the band
        self.ui = None  # vision6 menu module (encoder + OLED state machine)
        if OLED and Ui:
            try:
                self.ui = Ui(self, OLED)
            except Exception as e:
                print("ui init failed:", e)

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
        cfg["usb_drive"] = cfg.get("usb_drive") is not False  # same rule as boot.py
        cfg["show_layer"] = cfg.get("show_layer") is True
        cfg["show_profile"] = cfg.get("show_profile") is True
        self.config = cfg
        self.engine.set_screen(cfg["screen"].get("width", 1920),
                               cfg["screen"].get("height", 1080))

    def key_pin_names(self):
        c = self.config
        return c["pins"] or list(MODELS[MODEL]["pin_order"][: c["key_count"]])

    def macro_path(self, key_no):
        return self.macro_path_for(key_no, self.layer)

    def macro_path_for(self, key_no, layer_idx):
        if layer_idx == 0:
            return "/macros/key%d.json" % key_no
        return "/macros/key%d-%s.json" % (key_no, LAYER_NAMES[layer_idx])

    def slot_path(self, slot, layer_idx):
        """Macro file behind an encoder/nav virtual slot (see UI_SLOTS)."""
        if layer_idx == 0:
            return "/macros/%s.json" % slot
        return "/macros/%s-%s.json" % (slot, LAYER_NAMES[layer_idx])

    def set_layer_idx(self, i):
        """Single path for layer changes: serial set_layer, the layer key,
        and the vision6 encoder menu all land here."""
        self.layer = i
        self.led.set(layer=i)
        self.announce_layer()
        self.ui_call("on_layer")

    def ui_call(self, name, *args):
        """Run a UI hook, but never let a display/menu failure (including a
        MemoryError from displayio churn) take the keypad down with it —
        keys and serial must keep working even if a screen draw dies."""
        if not self.ui:
            return
        try:
            getattr(self.ui, name)(*args)
        except Exception as e:
            print("ui error in", name, ":", repr(e))
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
                "pins": self.key_pin_names(),
                "show_layer": c["show_layer"], "show_profile": c["show_profile"],
                "layer": LAYER_NAMES[self.layer], "mode": self.mode}

    def handle_msg(self, msg, in_playback=False):
        """Process one serial message. Returns True if playback must stop."""
        t = msg.get("t")
        self.last_rx = time.monotonic()
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
        elif t == "fs_list":
            self.fs_list(msg)
        elif t == "fs_read":
            self.fs_read(msg)
        elif t == "fs_write":
            self.fs_write(msg)
        elif t == "fs_delete":
            self.fs_delete(msg)
        elif t == "fs_ack":
            pass  # stray ack from a transfer we already gave up on
        elif t == "host_enter":
            self.set_mode("host")
            self.proto.send({"t": "ok", "re": "host_enter"})
        elif t == "host_leave":
            self.set_mode("standalone")
            self.proto.send({"t": "ok", "re": "host_leave"})
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
            self.buttons = Buttons(resolve_pins(self.key_pin_names()))
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
            # the app's active profile / foreground-app label for the grid
            # band (config show_profile). Empty text clears; cleared
            # automatically when the app disconnects.
            text = str(msg.get("text") or "")[:24] or None
            self.proto.send({"t": "ok", "re": "label"})
            if text != self.host_label:
                self.host_label = text
                self.ui_call("on_label")
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
        entries = []
        try:
            for name in os.listdir(path):
                try:
                    st = os.stat((path.rstrip("/") + "/" + name))
                except OSError:
                    continue
                entries.append({"name": name, "size": st[6],
                                "dir": bool(st[0] & 0x4000)})
        except OSError as e:
            return self.fs_err("fs_list", "not_found", e)
        self.proto.send({"t": "fs_list", "path": path, "entries": entries})

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
        try:
            while True:
                chunk = f.read(FS_CHUNK)
                eof = len(chunk) < FS_CHUNK
                data = b2a_base64(chunk).decode().strip() if chunk else ""
                self.proto.send({"t": "fs_chunk", "path": path, "seq": seq,
                                 "data": data, "eof": eof})
                # free this chunk's buffers before the next read so the heap
                # stays compact — a big recorded macro is many chunks and the
                # display stack leaves little contiguous room on vision6
                chunk = data = None
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
            self.upload = {"path": path, "tmp": tmp, "f": f, "seq": 0}
        up = self.upload
        if not up or up["path"] != path or seq != up["seq"]:
            self.close_upload(discard=True)
            return self.fs_err("fs_write", "bad_seq", seq)
        data = msg.get("data")
        try:
            if data:
                up["f"].write(a2b_base64(data))
        except (OSError, ValueError) as e:
            self.close_upload(discard=True)
            return self.fs_err("fs_write", "io", e)
        up["seq"] += 1
        if not msg.get("eof"):
            return self.proto.send({"t": "ok", "re": "fs_write", "seq": seq})
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
        self.proto.send({"t": "ok", "re": "fs_write", "seq": seq, "eof": True})
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
        self.buttons = Buttons(resolve_pins(self.key_pin_names()))

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
            self.led.tick()
            time.sleep(0.002)
        if not has_double:
            return "tap"
        t1 = time.monotonic()
        while time.monotonic() - t1 < double_s:
            for j, pressed in self.buttons.scan():
                if j == i and pressed:
                    return "double"
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

    def play_file(self, path, trigger=None, speed=None, repeat=None, hold=False):
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

        # A "menu" macro drives the on-screen menu instead of the HID engine:
        # a normal key acts like the encoder / CONFIRM / BACK. No-op without a
        # display (core6 has no UI to steer), but harmless.
        if data.get("kind") == "menu":
            if f:
                f.close()
            self.proto.send({"t": "play_start", "file": path})
            self.ui_call("inject", data.get("menu"))
            self.proto.send({"t": "play_done", "file": path, "stopped": False})
            return

        # key logic: standalone presses pick tap/double/hold themselves; the
        # chosen variant is announced so the app can run host-side variants
        # (launch/command/sound compile to empty events on the device).
        # Stream files carry no variants (the app never writes that combo);
        # a stray "variants" in a stream header is ignored and plays as tap.
        variants = data.get("variants") if stream_pos is None else None
        if trigger is not None and isinstance(variants, dict) and variants:
            choice = self.resolve_variant(trigger, variants,
                                          data.get("settings") or {})
            if self.proto.connected:
                self.proto.send({"t": "key_action", "file": path,
                                 "key": self.config["key_map"][trigger],
                                 "layer": LAYER_NAMES[self.layer],
                                 "variant": choice})
            if choice != "tap":
                v = variants.get(choice) or {}
                data["events"] = v.get("events") or []
                s = dict(data.get("settings") or {})
                s.update(v.get("settings") or {})
                data["settings"] = s

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
        c = self.config
        key_no = c["key_map"][i]  # logical key; i is the GPIO (solder) index
        # stream edges to a connected app in BOTH modes: standalone edges
        # power computer-side key actions (launch/command/sound) and the live
        # keypad view even when no profile holds host mode
        if self.mode == "host" or self.proto.connected:
            self.proto.send({"t": "btn", "key": key_no, "phys": i + 1,
                             "layer": LAYER_NAMES[self.layer],
                             "edge": "down" if pressed else "up"})
        if self.mode == "host":
            return
        if c["layer_key"] == key_no:
            if pressed:
                self.set_layer_idx((self.layer + 1) % c["layer_count"])
            return
        if pressed:
            self.play_file(self.macro_path(key_no), trigger=i)

    # --- main loop ---
    def run(self):
        try:
            self.run_loop()
        except Exception as e:
            # Finished-product UX: a branded error screen instead of a raw
            # traceback (which CircuitPython would otherwise paint onto the
            # OLED once code stops), then a self-heal restart — a transient
            # failure (e.g. a MemoryError under load) must not leave a dead
            # keypad, and the console must never own the screen.
            print("fatal:", repr(e))
            if OLED:
                try:
                    OLED.show_error(repr(e))
                except Exception:
                    pass
            time.sleep(5)
            import supervisor
            supervisor.reload()

    def run_loop(self):
        self.led.set(state=ledmod.IDLE, layer=0)
        self.ui_call("start")
        while True:
            now = time.monotonic()
            if self.pin_watch:
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
            if self.host_label and not self.proto.connected:
                self.host_label = None
                self.ui_call("on_label")
            # a half-received upload must not leak its file handle either
            if self.upload and not self.proto.connected:
                self.close_upload(discard=True)
            self.ui_call("tick", now)
            self.led.tick()
            time.sleep(0.002)


App().run()

# MKYADA firmware — main loop.
#
# Standalone: a key press plays the macro JSON mapped to it by name convention
#   (macros/key<N>.json, layer B -> key<N>-b.json, ...). No app required.
# Host mode: entered when the desktop app sends {"t":"host_enter"}; key events
#   stream to the app over serial and playback happens only on its commands.
#   Falls back to standalone if the app goes silent for PING_TIMEOUT seconds.

import gc
import json
import time

import board
import digitalio
import microcontroller

from mkyada import led as ledmod
from mkyada.engine import Engine, StopPlayback
from mkyada.led import Led
from mkyada.proto import Proto

# Key pins in solder order — every castellated GPIO on the RP2040-Zero's
# edge, walking the perimeter: GP0-GP8 down the right side, GP9-GP14 along
# the bottom, GP15 + GP26-GP29 up the left. (GP16 drives the onboard
# WS2812; GP17-GP25 are rear test pads, not edge pins.) 6 keys is the
# reference build; solder GP0..GP(n-1) for any n up to 20 and set key_count.
PIN_ORDER = (
    board.GP0, board.GP1, board.GP2, board.GP3, board.GP4, board.GP5,
    board.GP6, board.GP7, board.GP8, board.GP9, board.GP10, board.GP11,
    board.GP12, board.GP13, board.GP14, board.GP15,
    board.GP26, board.GP27, board.GP28, board.GP29,
)
DEBOUNCE_S = 0.02
PING_TIMEOUT_S = 5.0
PROTO_VERSION = 2  # v2: key_action + led ops, btn streamed in standalone too
MACRO_FORMATS = ("mkyada-macro", "asil-macro")
LAYER_NAMES = "abcdefgh"

DEFAULT_CONFIG = {
    "key_count": 6,
    "layer_key": None,   # 1-based key number, or null
    "layer_count": 2,
    "layer_mode": "toggle",  # kept for config compat; press always cycles a->b->...
    "key_map": None,     # per-GPIO logical key numbers, e.g. [3,1,2] when the
                         # solder order differs; null = identity (GP0 = key 1)
    "busy_other": "ignore",  # another macro key pressed while playing:
                             # "ignore" it, or "switch" (stop + play the new one)
    "screen": {"width": 1920, "height": 1080},
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

    def __init__(self, count):
        self.ios = []
        for pin in PIN_ORDER[:count]:
            io = digitalio.DigitalInOut(pin)
            io.direction = digitalio.Direction.INPUT
            io.pull = digitalio.Pull.UP
            self.ios.append(io)
        self.stable = [False] * count
        self.changed_at = [0.0] * count

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
        self.engine = Engine()
        self.proto = Proto()
        self.led = Led()
        self.config = dict(DEFAULT_CONFIG)
        self.load_config()
        self.buttons = Buttons(self.config["key_count"])
        self.layer = 0
        self.mode = "standalone"
        self.last_rx = 0.0
        self.playing_key = None  # 0-based index of the key that started playback
        self.pending_play = None  # (path, trigger) queued by restart/switch policies

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
        cfg["key_count"] = max(1, min(len(PIN_ORDER), int(cfg.get("key_count") or 6)))
        lk = cfg.get("layer_key")
        cfg["layer_key"] = int(lk) if lk and 1 <= int(lk) <= cfg["key_count"] else None
        cfg["layer_count"] = max(2, min(len(LAYER_NAMES), int(cfg.get("layer_count") or 2)))
        km = cfg.get("key_map")
        if not (isinstance(km, list) and len(km) == cfg["key_count"]
                and sorted(km) == list(range(1, cfg["key_count"] + 1))):
            km = list(range(1, cfg["key_count"] + 1))  # identity
        cfg["key_map"] = km
        if cfg.get("busy_other") not in ("ignore", "switch"):
            cfg["busy_other"] = "ignore"
        self.config = cfg
        self.engine.set_screen(cfg["screen"].get("width", 1920),
                               cfg["screen"].get("height", 1080))

    def macro_path(self, key_no):
        if self.layer == 0:
            return "/macros/key%d.json" % key_no
        return "/macros/key%d-%s.json" % (key_no, LAYER_NAMES[self.layer])

    # --- serial ---
    def hello(self):
        c = self.config
        return {"t": "hello", "fw": self.fw_version, "proto": PROTO_VERSION,
                "format": "mkyada", "uid": uid_hex(),
                "key_count": c["key_count"], "layer_key": c["layer_key"],
                "layer_count": c["layer_count"], "layer_mode": c["layer_mode"],
                "key_map": c["key_map"],
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
            return False  # everything else waits until playback ends
        elif t == "host_enter":
            self.set_mode("host")
            self.proto.send({"t": "ok", "re": "host_enter"})
        elif t == "host_leave":
            self.set_mode("standalone")
            self.proto.send({"t": "ok", "re": "host_leave"})
        elif t == "play":
            path = "/" + str(msg.get("file", "")).lstrip("/")
            self.play_file(path, trigger=None,
                           speed=msg.get("speed"), repeat=msg.get("repeat"))
        elif t == "keys":
            self.engine.tap_combo(msg.get("mods"), str(msg.get("key", "")))
            self.proto.send({"t": "ok", "re": "keys"})
        elif t == "get_config":
            cfg = dict(self.config)
            cfg["t"] = "config"
            self.proto.send(cfg)
        elif t == "reload":
            self.load_config()
            self.layer = 0
            self.led.set(layer=0)
            self.proto.send({"t": "ok", "re": "reload"})
            self.proto.send(self.hello())
            self.announce_layer()
        elif t == "reset":
            # Hard reset: re-runs boot.py (needed after firmware updates).
            self.proto.send({"t": "ok", "re": "reset"})
            time.sleep(0.1)
            microcontroller.reset()
        elif t == "set_layer":
            name = str(msg.get("layer", "a"))
            if name in LAYER_NAMES[: self.config["layer_count"]]:
                self.layer = LAYER_NAMES.index(name)
                self.led.set(layer=self.layer)
                self.proto.send({"t": "ok", "re": "set_layer"})
                self.announce_layer()
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

    def set_mode(self, mode):
        self.mode = mode
        self.led.set(state=ledmod.HOST if mode == "host" else ledmod.IDLE,
                     layer=self.layer)

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
    def play_file(self, path, trigger=None, speed=None, repeat=None):
        try:
            gc.collect()
            with open(path) as f:
                data = json.load(f)
        except OSError:
            self.led.error()
            self.proto.send({"t": "err", "re": "play", "code": "not_found", "msg": path})
            return
        except ValueError:
            self.led.error()
            self.proto.send({"t": "err", "re": "play", "code": "bad_json", "msg": path})
            return
        except MemoryError:
            gc.collect()
            self.led.error()
            self.proto.send({"t": "err", "re": "play", "code": "oom", "msg": path})
            return
        if data.get("format") not in MACRO_FORMATS:
            self.led.error()
            self.proto.send({"t": "err", "re": "play", "code": "bad_format", "msg": path})
            return

        # key logic: standalone presses pick tap/double/hold themselves; the
        # chosen variant is announced so the app can run host-side variants
        # (launch/command/sound compile to empty events on the device)
        variants = data.get("variants")
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
        # replay while the physical key is held down (like OS key repeat)
        hold_repeat = bool(settings.get("hold_repeat"))
        events = data.get("events") or []
        screen = data.get("screen")

        self.playing_key = trigger
        self.led.set(state=ledmod.LOOPING if loop else ledmod.PLAYING)
        self.proto.send({"t": "play_start", "file": path})
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
            for m in self.proto.poll():
                if self.handle_msg(m, in_playback=True):
                    return True
            return False

        try:
            runs = 0
            while True:
                self.engine.play(events, screen=screen, speed=speed,
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
        finally:
            self.playing_key = None
            del events, data
            gc.collect()
            self.set_mode(self.mode)  # restore idle/host LED
            self.proto.send({"t": "play_done", "file": path, "stopped": stopped})

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
                self.layer = (self.layer + 1) % c["layer_count"]
                self.led.set(layer=self.layer)
                self.announce_layer()
            return
        if pressed:
            self.play_file(self.macro_path(key_no), trigger=i)

    # --- main loop ---
    def run(self):
        self.led.set(state=ledmod.IDLE, layer=0)
        while True:
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
            self.led.tick()
            time.sleep(0.002)


App().run()

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

PIN_ORDER = (board.GP0, board.GP1, board.GP2, board.GP3, board.GP4, board.GP5)
DEBOUNCE_S = 0.02
PING_TIMEOUT_S = 5.0
PROTO_VERSION = 1
MACRO_FORMATS = ("mkyada-macro", "asil-macro")
LAYER_NAMES = "abcdefgh"

DEFAULT_CONFIG = {
    "key_count": 6,
    "layer_key": None,   # 1-based key number, or null
    "layer_count": 2,
    "layer_mode": "toggle",  # "toggle" cycles a->b->..., "hold" = momentary layer b
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
        self.config = cfg
        self.engine.set_screen(cfg["screen"].get("width", 1920),
                               cfg["screen"].get("height", 1080))

    def macro_path(self, key_index):
        n = key_index + 1
        if self.layer == 0:
            return "/macros/key%d.json" % n
        return "/macros/key%d-%s.json" % (n, LAYER_NAMES[self.layer])

    # --- serial ---
    def hello(self):
        c = self.config
        return {"t": "hello", "fw": self.fw_version, "proto": PROTO_VERSION,
                "format": "mkyada", "uid": uid_hex(),
                "key_count": c["key_count"], "layer_key": c["layer_key"],
                "layer_count": c["layer_count"], "layer_mode": c["layer_mode"],
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
        elif t == "set_layer":
            name = str(msg.get("layer", "a"))
            if name in LAYER_NAMES[: self.config["layer_count"]]:
                self.layer = LAYER_NAMES.index(name)
                self.led.set(layer=self.layer)
                self.proto.send({"t": "ok", "re": "set_layer"})
        return False

    def set_mode(self, mode):
        self.mode = mode
        self.led.set(state=ledmod.HOST if mode == "host" else ledmod.IDLE,
                     layer=self.layer)

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

        settings = data.get("settings") or {}
        if speed is None:
            speed = settings.get("speed", 1.0)
        if repeat is None:
            repeat = settings.get("repeat", 1)
        loop = int(repeat) == 0
        events = data.get("events") or []
        screen = data.get("screen")

        self.playing_key = trigger
        self.led.set(state=ledmod.LOOPING if loop else ledmod.PLAYING)
        self.proto.send({"t": "play_start", "file": path})
        stopped = False

        def should_stop():
            # Panic: the triggering key again (standalone), or any key (host play).
            for i, pressed in self.buttons.scan():
                if pressed and (trigger is None or i == trigger):
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
                if not loop and runs >= max(1, int(repeat)):
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
        key_no = i + 1
        if self.mode == "host":
            self.proto.send({"t": "btn", "key": key_no,
                             "layer": LAYER_NAMES[self.layer],
                             "edge": "down" if pressed else "up"})
            return
        if c["layer_key"] == key_no:
            if c["layer_mode"] == "hold":
                self.layer = 1 if pressed else 0
            elif pressed:
                self.layer = (self.layer + 1) % c["layer_count"]
            self.led.set(layer=self.layer)
            return
        if pressed:
            self.play_file(self.macro_path(i), trigger=i)

    # --- main loop ---
    def run(self):
        self.led.set(state=ledmod.IDLE, layer=0)
        while True:
            for i, pressed in self.buttons.scan():
                self.on_edge(i, pressed)
            for msg in self.proto.poll():
                self.handle_msg(msg)
            if self.mode == "host":
                if (not self.proto.connected
                        or time.monotonic() - self.last_rx > PING_TIMEOUT_S):
                    self.set_mode("standalone")
            self.led.tick()
            time.sleep(0.002)


App().run()

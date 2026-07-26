"""Desktop simulation of the MKYADA firmware: stubs CircuitPython modules,
then exercises engine playback, config loading, layer logic and the serial
protocol handler. Run: python3 tests/firmware_sim_test.py"""
import json
import os
import sys
import types

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FFW = os.path.join(REPO, "firmware")

# ---------- CircuitPython stubs ----------
sent_reports = []


class FakeHidDevice:
    def __init__(self, usage_page, usage):
        self.usage_page, self.usage = usage_page, usage

    def send_report(self, buf, report_id=None):
        # mouse is a two-report device (pointer id 2 / scroll id 4); the
        # tests tell them apart by length, matching boot.py's lengths
        sent_reports.append((self.usage_page, self.usage, bytes(buf)))


usb_hid = types.ModuleType("usb_hid")
usb_hid.devices = [FakeHidDevice(0x01, 0x06), FakeHidDevice(0x01, 0x02),
                   FakeHidDevice(0x0C, 0x01)]
sys.modules["usb_hid"] = usb_hid

usb_cdc = types.ModuleType("usb_cdc")
usb_cdc.data = None
sys.modules["usb_cdc"] = usb_cdc

board = types.ModuleType("board")
for i in list(range(16)) + [16] + list(range(26, 30)):
    setattr(board, "GP%d" % i, "GP%d" % i)
sys.modules["board"] = board


class FakeDigitalInOut:
    def __init__(self, pin):
        self.pin = pin
        self.direction = None
        self.pull = None
        self.value = True  # not pressed (pull-up)


digitalio = types.ModuleType("digitalio")
digitalio.DigitalInOut = FakeDigitalInOut
digitalio.Direction = types.SimpleNamespace(INPUT="in")
digitalio.Pull = types.SimpleNamespace(UP="up")
sys.modules["digitalio"] = digitalio

class _ResetCalled(SystemExit):
    pass


microcontroller = types.ModuleType("microcontroller")
microcontroller.cpu = types.SimpleNamespace(uid=bytes(range(8)))
microcontroller.reset = lambda: (_ for _ in ()).throw(_ResetCalled())
microcontroller.RunMode = types.SimpleNamespace(UF2="uf2", BOOTLOADER="btl")
microcontroller.next_reset_to = []
microcontroller.on_next_reset = lambda mode: microcontroller.next_reset_to.append(mode)
sys.modules["microcontroller"] = microcontroller


class FakeNeoPixel(list):
    def __init__(self, pin, n, brightness=1.0, auto_write=True):
        super().__init__([(0, 0, 0)] * n)


neopixel = types.ModuleType("neopixel")
neopixel.NeoPixel = FakeNeoPixel
sys.modules["neopixel"] = neopixel

# --- display / encoder stubs (vision6 UI). busio, i2cdisplaybus and
# adafruit_displayio_sh1106 are deliberately NOT stubbed: Oled.__init__ then
# fails its retries and runs headless, which is exactly the code path a
# desktop test can exercise.


# displayio and bitmaptools are software implementations with real pixel
# semantics (tests/fakedisplayio.py), shared with tests/oled_render_test.py
# which renders the screens and diffs them against golden pictures.
sys.path.insert(0, os.path.join(REPO, "tests"))
import fakedisplayio  # noqa: E402

fakedisplayio.install()

rotaryio = types.ModuleType("rotaryio")


class FakeEncoder:
    def __init__(self, a, b):
        self.position = 0


rotaryio.IncrementalEncoder = FakeEncoder
sys.modules["rotaryio"] = rotaryio

keypad = types.ModuleType("keypad")


class FakeKeyEvent:
    def __init__(self, key_number, pressed):
        self.key_number, self.pressed = key_number, pressed


class FakeEventQueue:
    def __init__(self):
        self.queue = []

    def get(self):
        return self.queue.pop(0) if self.queue else None


class FakeKeys:
    def __init__(self, pins, value_when_pressed=False, pull=True):
        self.pins = pins
        self.events = FakeEventQueue()


keypad.Keys = FakeKeys
keypad.Event = FakeKeyEvent
sys.modules["keypad"] = keypad

sys.path.insert(0, FFW)

# ---------- tests ----------
failures = []


def check(name, cond, detail=""):
    print(("PASS" if cond else "FAIL"), name, detail if not cond else "")
    if not cond:
        failures.append(name)


# 1. hidmap resolution
from mkyada.hidmap import resolve_key  # noqa: E402

check("vk letter A", resolve_key({"vk": 65}) == ("key", 0x04))
check("mod ctrl_l by name", resolve_key({"key": "ctrl_l"}) == ("mod", 0x01))
check("char fallback 'a'", resolve_key({"key": "a"}) == ("key", 0x04))
check("f5 by name", resolve_key({"key": "f5"}) == ("key", 0x3E))
check("unknown -> None", resolve_key({"key": "☃"}) is None)

# 2. engine playback of the demo macro
from mkyada.engine import Engine, StopPlayback  # noqa: E402

eng = Engine()
with open(os.path.join(FFW, "macros", "key1.json")) as f:
    demo = json.load(f)
for ev in demo["events"]:
    ev["delay"] = min(ev["delay"], 1)  # speed the test up
eng.play(demo["events"], screen={"width": 1920, "height": 1080})
kbd = [r for r in sent_reports if r[1] == 0x06]
check("kbd reports emitted", len(kbd) > 12, str(len(kbd)))
check("report is 8 bytes", all(len(r[2]) == 8 for r in kbd))
check("'m' pressed", any(r[2][2] == 0x10 for r in kbd))
check("ends released", kbd[-1][2] == bytes(8))

# mouse + consumer
import struct  # noqa: E402

sent_reports.clear()
eng.play([{"delay": 0, "type": "move", "x": 960, "y": 540},
          {"delay": 0, "type": "button", "action": "down", "button": "left"},
          {"delay": 0, "type": "button", "action": "up", "button": "left"},
          {"delay": 0, "type": "consumer", "usage": "volume_up"}],
         screen={"width": 1920, "height": 1080})
mouse = [r for r in sent_reports if r[1] == 0x02]
cons = [r for r in sent_reports if r[0] == 0x0C]
# pointer report is buttons + X + Y (5 bytes, report id 2; boot.py descriptor)
check("mouse pointer report is 5 bytes", all(len(r[2]) == 5 for r in mouse), str(mouse[:1]))
xy = struct.unpack("<BHH", mouse[0][2]) if mouse else None
check("abs move scaled", xy and abs(xy[1] - 16383) < 40 and abs(xy[2] - 16391) < 60, str(xy))
check("left click down bit", any(r[2][0] & 0x01 for r in mouse))
check("consumer volume_up", any(struct.unpack('<H', r[2])[0] == 0xE9 for r in cons), str(cons))

# scroll: its own 2-byte report (wheel + pan) so the cursor never moves
sent_reports.clear()
eng.play([{"delay": 0, "type": "scroll", "dy": 3}], screen=None)
wheel = [struct.unpack("<bb", r[2]) for r in sent_reports
         if r[1] == 0x02 and len(r[2]) == 2]
check("vertical scroll wheel +1 steps", sum(1 for m in wheel if m[0] == 1) == 3, str(wheel))
check("vertical scroll no pan", all(m[1] == 0 for m in wheel), str(wheel))
check("scroll sends no pointer report",
      not any(r[1] == 0x02 and len(r[2]) == 5 for r in sent_reports),
      str(sent_reports))

sent_reports.clear()
eng.play([{"delay": 0, "type": "scroll", "dy": 0, "dx": -2}], screen=None)
hwheel = [struct.unpack("<bb", r[2]) for r in sent_reports
          if r[1] == 0x02 and len(r[2]) == 2]
check("horizontal scroll pan -1 steps", sum(1 for m in hwheel if m[1] == -1) == 2, str(hwheel))
check("horizontal scroll no wheel", all(m[0] == 0 for m in hwheel), str(hwheel))

# keyboard-only macros must not touch the mouse at all — the pointer report
# is absolute, so a stray one teleports the cursor (the old release_all bug)
sent_reports.clear()
eng.play([{"delay": 0, "type": "key", "action": "down", "key": "a"},
          {"delay": 0, "type": "key", "action": "up", "key": "a"}], screen=None)
check("kbd-only macro sends no mouse report",
      not any(r[1] == 0x02 for r in sent_reports), str(sent_reports))

# wheel_burst (serial "scroll", proto v6): modifiers held around the ticks
sent_reports.clear()
eng.wheel_burst(2, 0, ["ctrl"])
burst_kbd = [r[2] for r in sent_reports if r[1] == 0x06]
burst_wheel = [struct.unpack("<bb", r[2]) for r in sent_reports
               if r[1] == 0x02 and len(r[2]) == 2]
check("wheel_burst holds ctrl", burst_kbd and burst_kbd[0][0] == 0x01, str(burst_kbd))
check("wheel_burst releases ctrl", burst_kbd[-1][0] == 0x00, str(burst_kbd))
check("wheel_burst ticks", [m[0] for m in burst_wheel] == [1, 1], str(burst_wheel))

# stop mid-play
calls = {"n": 0}


def stopper():
    calls["n"] += 1
    return calls["n"] > 2


try:
    eng.play([{"delay": 5, "type": "wait"}] * 100, should_stop=stopper)
    check("StopPlayback raised", False)
except StopPlayback:
    check("StopPlayback raised", True)

# drift-free scheduling: 100 x 10ms events with a 2ms-slow tick must finish in
# ~1.0s wall time. The old per-event relative sleeps accumulated the tick cost
# (>=1.2s); absolute deadlines absorb it.
import time as _time  # noqa: E402

t0 = _time.monotonic()
eng.play([{"delay": 10, "type": "wait"}] * 100, tick=lambda: _time.sleep(0.002))
drift_t = _time.monotonic() - t0
check("playback timing drift-free", 0.93 <= drift_t <= 1.15, "%.3fs (want ~1.0s)" % drift_t)

# 3. serial protocol line parsing (the CircuitPython bytearray regression)
from mkyada.proto import Proto  # noqa: E402


class FakeSerial:
    def __init__(self, chunks):
        self.buf = b"".join(chunks)
        self.connected = True

    @property
    def in_waiting(self):
        return len(self.buf)

    def read(self, n):
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def write(self, data):
        return len(data)


p = Proto()
p.ser = FakeSerial([b'{"t":"ping"}\n{"t":"iden', b'tify"}\npartial'])
msgs = p.poll()
check("proto parses two lines", [m["t"] for m in msgs] == ["ping", "identify"], str(msgs))
check("proto keeps partial", bytes(p.buf) == b"partial", str(bytes(p.buf)))

# 4. App logic (exec mkyada/app.py's body; nothing runs at module level —
# code.py's bootstrap is what calls main())
with open(os.path.join(FFW, "mkyada", "app.py")) as f:
    src = f.read()
code_mod = types.ModuleType("fwmain")
exec(compile(src, "app.py", "exec"), code_mod.__dict__)

app = code_mod.App()
check("default key_count", app.config["key_count"] == 6)
check("default key_map identity", app.config["key_map"] == [1, 2, 3, 4, 5, 6])
check("macro path layer a", app.macro_path(1) == "/macros/key1.json")
app.layer = 1
check("macro path layer b", app.macro_path(3) == "/macros/key3-b.json")
app.layer = 0

hello = app.hello()
check("hello uid", hello["uid"] == "0001020304050607")
check("hello mode", hello["mode"] == "standalone")

# layer toggle via on_edge (+ every change announces {"t":"layer"} to the app)
app.config["layer_key"] = 6
app.config["layer_count"] = 3
layer_msgs = []
_orig_send = app.proto.send
app.proto.send = lambda obj: (layer_msgs.append(obj), True)[1]
app.on_edge(5, True)
check("toggle -> layer b", app.layer == 1)
check("layer announced", layer_msgs[-1] == {"t": "layer", "layer": "b"}, str(layer_msgs))
app.on_edge(5, True)
check("toggle -> layer c", app.layer == 2)
app.on_edge(5, True)
check("toggle wraps -> a", app.layer == 0)

# "hold" layer mode was removed — even with it in config, press just cycles
app.config["layer_mode"] = "hold"
app.on_edge(5, True)
check("hold config still cycles", app.layer == 1)
app.on_edge(5, False)
check("release does nothing", app.layer == 1)
app.on_edge(5, True)
app.on_edge(5, True)
check("back to a", app.layer == 0)
app.proto.send = _orig_send

# key_map remap: GPIO 0 -> logical key 3
app.config["layer_key"] = None
app.config["layer_mode"] = "toggle"
app.config["key_map"] = [3, 1, 2, 4, 5, 6]
played = []
app.play_file = lambda path, trigger=None, **kw: played.append(path)
app.on_edge(0, True)
check("remap gpio0 -> key3", played == ["/macros/key3.json"], str(played))
app.on_edge(1, True)
check("remap gpio1 -> key1", played[-1] == "/macros/key1.json", str(played))

# key_map validation: bad map falls back to identity
app.config = dict(app.config)
del app.play_file  # restore real method

# more than 6 keys: key_count 8 survives load_config; 13 clamps to the pin count
import builtins as _b, io as _io
_real_open = _b.open
def _cfg_open(payload):
    def fake(path, *a, **k):
        if str(path) == "/config.json":
            return _io.StringIO(json.dumps(payload))
        return _real_open(path, *a, **k)
    return fake
_b.open = _cfg_open({"key_count": 8})
app.load_config()
check("8 keys allowed", app.config["key_count"] == 8, str(app.config["key_count"]))
check("8-key identity map", app.config["key_map"] == list(range(1, 9)), str(app.config["key_map"]))
_b.open = _cfg_open({"key_count": 99})
app.load_config()
check("key_count clamped to pins", app.config["key_count"] == 20, str(app.config["key_count"]))
_b.open = _real_open
_b.open = _cfg_open({"key_count": 6})
app.load_config()
_b.open = _real_open
app.config["key_map"] = [3, 1, 2, 4, 5, 6]

# host mode: btn events carry logical key + physical pin
outbox = []
app.proto.send = lambda obj: (outbox.append(obj), True)[1]
app.handle_msg({"t": "host_enter"})
check("mode host", app.mode == "host")
app.on_edge(1, True)
check("btn streamed logical", any(m.get("t") == "btn" and m["key"] == 1 for m in outbox), str(outbox))
check("btn has phys", any(m.get("t") == "btn" and m.get("phys") == 2 for m in outbox), str(outbox))

# play command with missing file -> err not_found
outbox.clear()
app.handle_msg({"t": "play", "file": "macros/nope.json"})
check("err not_found", any(m.get("code") == "not_found" for m in outbox), str(outbox))

# --- playback collision policies + hold-to-repeat ------------------------
import tempfile

app.handle_msg({"t": "host_leave"})
app.config["key_map"] = list(range(1, 7))
app.config["layer_key"] = None
app.config["busy_other"] = "ignore"
_orig_scan = app.buttons.scan
_orig_play = app.engine.play

def macro_file(settings):
    f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump({"format": "mkyada-macro", "version": 2, "settings": settings,
               "events": [{"delay": 0, "type": "key", "action": "down", "key": "a"},
                          {"delay": 0, "type": "key", "action": "up", "key": "a"}]}, f)
    f.close()
    return f.name

# on_repress "restart": same key mid-play queues a replay
path_restart = macro_file({"on_repress": "restart"})
presses = [[(0, True)]]
app.buttons.scan = lambda: presses.pop(0) if presses else []
app.pending_play = None
app.play_file(path_restart, trigger=0)
check("restart queues same macro", app.pending_play == (path_restart, 0), str(app.pending_play))

# on_repress default: same key just stops
path_stop = macro_file({})
presses = [[(0, True)]]
app.pending_play = None
app.play_file(path_stop, trigger=0)
check("re-press stops by default", app.pending_play is None, str(app.pending_play))

# busy_other "switch": another key mid-play queues that key's macro
app.config["busy_other"] = "switch"
presses = [[(2, True)]]
app.pending_play = None
app.play_file(path_stop, trigger=0)
check("switch queues other macro", app.pending_play == ("/macros/key3.json", 2), str(app.pending_play))

# busy_other "ignore" (default): another key does nothing
app.config["busy_other"] = "ignore"
presses = [[(2, True)]]
app.pending_play = None
app.play_file(path_stop, trigger=0)
check("ignore keeps playing", app.pending_play is None, str(app.pending_play))

# single keys hold like a real keyboard BY DEFAULT (issue #20): the HID key
# stays down while the physical key is down — the host's typematic repeat
# makes the eeee… — and is released when the key is released. No replay loop.
path_hold = macro_file({})  # plain tap, no explicit hold_repeat
sent_reports.clear()
runs = {"n": 0}
app.engine.play = lambda *a, **kw: runs.__setitem__("n", runs["n"] + 1)
app.buttons.scan = lambda: []
app.buttons.stable[0] = True
_orig_tick = app.led.tick
ticks = {"n": 0}
def _release_after_3_ticks():
    ticks["n"] += 1
    if ticks["n"] >= 3:
        app.buttons.stable[0] = False
app.led.tick = _release_after_3_ticks
app.play_file(path_hold, trigger=0)
kbd = [r[2] for r in sent_reports if r[1] == 0x06]
check("hold: key pressed", any(0x04 in r[2:] for r in kbd), str(kbd))
check("hold: released on key-up", kbd and 0x04 not in kbd[-1][2:], str(kbd))
check("hold: held across ticks", ticks["n"] >= 3, str(ticks))
check("hold: no replay loop", runs["n"] == 0, str(runs))

# "hold_repeat": false opts a single key back into play-once
path_once = macro_file({"hold_repeat": False})
app.led.tick = _orig_tick
app.buttons.stable[0] = True
runs["n"] = 0
app.play_file(path_once, trigger=0)
check("hold_repeat false plays once", runs["n"] == 1, str(runs))
app.buttons.stable[0] = False

# non-single-key macros keep the replay-while-held behaviour
def multi_macro_file(settings):
    f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump({"format": "mkyada-macro", "version": 2, "settings": settings,
               "events": [{"delay": 0, "type": "key", "action": "down", "key": "ctrl_l"},
                          {"delay": 0, "type": "key", "action": "down", "key": "a"},
                          {"delay": 0, "type": "key", "action": "up", "key": "a"},
                          {"delay": 0, "type": "key", "action": "up", "key": "ctrl_l"}]}, f)
    f.close()
    return f.name

path_multi = multi_macro_file({"hold_repeat": True})
runs["n"] = 0
def _fake_play(events, **kw):
    runs["n"] += 1
    if runs["n"] >= 3:
        app.buttons.stable[0] = False
app.engine.play = _fake_play
app.buttons.stable[0] = True
app.play_file(path_multi, trigger=0)
check("hold_repeat replays while held", runs["n"] == 3, str(runs))

# serial hold (proto v5): {"t":"play","hold":true} keeps the key down until
# the app's {"t":"stop"} — how host mode gives profile keys the same feel
app.engine.play = _orig_play
sent_reports.clear()
app.proto.ser = FakeSerial([])  # connected, so the hold doesn't bail out
app.last_rx = _time.monotonic()
_orig_poll = app.proto.poll
polls = {"n": 0}
def _stop_on_second_poll():
    polls["n"] += 1
    return [{"t": "stop"}] if polls["n"] >= 2 else []
app.proto.poll = _stop_on_second_poll
app.play_file(path_hold, trigger=None, hold=True)
kbd = [r[2] for r in sent_reports if r[1] == 0x06]
check("serial hold: key pressed", any(0x04 in r[2:] for r in kbd), str(kbd))
check("serial hold: released on stop", kbd and 0x04 not in kbd[-1][2:], str(kbd))
check("serial hold: waited for stop", polls["n"] >= 2, str(polls))
app.proto.poll = _orig_poll
app.proto.ser = None

app.buttons.scan = _orig_scan
app.engine.play = _orig_play

# --- v4 stream macro files (proto v4): header line + one event per line ---
def stream_macro_file(events, settings=None):
    f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    hdr = {"format": "mkyada-macro", "version": 4, "stream": True,
           "screen": {"width": 1920, "height": 1080}}
    if settings:
        hdr["settings"] = settings
    f.write(json.dumps(hdr) + "\n")
    for ev in events:
        f.write(json.dumps(ev) + "\n")
    f.close()
    return f.name


tap_events = [{"delay": 0, "type": "key", "action": "down", "key": "a"},
              {"delay": 0, "type": "key", "action": "up", "key": "a"}]

outbox.clear()
sent_reports.clear()
path_stream = stream_macro_file(
    tap_events + [{"delay": 0, "type": "move", "x": 960, "y": 540}])
app.play_file(path_stream)
check("stream file plays", any(m.get("t") == "play_done" and not m.get("stopped")
                               for m in outbox), str(outbox))
check("stream kbd 'a' pressed", any(r[1] == 0x06 and r[2][2] == 0x04 for r in sent_reports))
check("stream move emitted", any(r[1] == 0x02 for r in sent_reports))
check("stream no error", not any(m.get("t") == "err" for m in outbox), str(outbox))

# repeat replays by seeking back to the first event line — no extra RAM
outbox.clear()
sent_reports.clear()
path_stream3 = stream_macro_file(tap_events, settings={"repeat": 3})
app.play_file(path_stream3)
presses3 = sum(1 for r in sent_reports if r[1] == 0x06 and r[2][2] == 0x04)
check("stream repeat=3 replays 3x", presses3 == 3, str(presses3))

# a corrupt event line is skipped, not fatal
path_corrupt = stream_macro_file(tap_events)
with open(path_corrupt, "a") as fh:
    fh.write("{not json}\n")
    fh.write(json.dumps({"delay": 0, "type": "move", "x": 10, "y": 10}) + "\n")
outbox.clear()
app.play_file(path_corrupt)
check("stream corrupt line skipped",
      any(m.get("t") == "play_done" for m in outbox)
      and not any(m.get("t") == "err" for m in outbox), str(outbox))

# pretty-printed whole-file JSON still plays (hand-made files on the drive)
fpp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
json.dump({"format": "mkyada-macro", "version": 2, "events": tap_events}, fpp, indent=2)
fpp.close()
outbox.clear()
sent_reports.clear()
app.play_file(fpp.name)
check("pretty JSON still plays",
      any(m.get("t") == "play_done" for m in outbox)
      and not any(m.get("t") == "err" for m in outbox), str(outbox))

# a HID report the USB stack rejects (boot.py descriptor older than
# engine.py after a partial update) fails the key soft: err "hid" + LED
# blink, never the fatal handler's crash-loop. The macro must actually
# touch the mouse: keyboard-only macros no longer send pointer reports.
outbox.clear()


def _reject(buf, report_id=None):
    raise ValueError("report length must be 6")


fmm = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
json.dump({"format": "mkyada-macro", "version": 2,
           "events": [{"delay": 0, "type": "move", "x": 10, "y": 10}]}, fmm)
fmm.close()
_orig_mouse_send = app.engine.mouse.send_report
app.engine.mouse.send_report = _reject
app.play_file(fmm.name)
check("hid mismatch -> err not crash",
      any(m.get("t") == "err" and m.get("code") == "hid" for m in outbox)
      and any(m.get("t") == "play_done" and m.get("stopped") for m in outbox),
      str(outbox))
app.engine.mouse.send_report = _orig_mouse_send

# --- key logic: tap / double press / long press (macro format v3) ---------
def variant_file():
    f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump({
        "format": "mkyada-macro", "version": 3,
        "settings": {"hold_ms": 30, "double_ms": 30},
        "events": [{"delay": 0, "type": "key", "action": "down", "key": "a"},
                   {"delay": 0, "type": "key", "action": "up", "key": "a"}],
        "variants": {
            "double": {"events": [
                {"delay": 0, "type": "key", "action": "down", "key": "b"},
                {"delay": 0, "type": "key", "action": "up", "key": "b"}]},
            "hold": {"events": [
                {"delay": 0, "type": "key", "action": "down", "key": "c"},
                {"delay": 0, "type": "key", "action": "up", "key": "c"}]},
        },
    }, f)
    f.close()
    return f.name


def pressed_usages():
    return {r[2][2] for r in sent_reports if r[1] == 0x06 and r[2][2]}


path_variants = variant_file()
outbox.clear()
app.proto.send = lambda obj: (outbox.append(obj), True)[1]
app.proto.ser = FakeSerial([])  # "connected" so key_action is announced

# tap: key released before the call, no second press within the window
sent_reports.clear()
app.buttons.stable[0] = False
presses = []
app.buttons.scan = lambda: presses.pop(0) if presses else []
app.play_file(path_variants, trigger=0)
check("variant tap plays top-level events", pressed_usages() == {0x04}, str(pressed_usages()))
check("variant tap announced", any(
    m.get("t") == "key_action" and m.get("variant") == "tap" for m in outbox), str(outbox))

# double: a second press arrives inside the double window
sent_reports.clear()
outbox.clear()
app.buttons.stable[0] = False
presses = [[(0, True)]]
app.play_file(path_variants, trigger=0)
check("variant double plays double events", pressed_usages() == {0x05}, str(pressed_usages()))
check("variant double announced", any(
    m.get("t") == "key_action" and m.get("variant") == "double" for m in outbox), str(outbox))

# hold: key stays down past hold_ms
sent_reports.clear()
outbox.clear()
app.buttons.stable[0] = True
presses = []
app.play_file(path_variants, trigger=0)
check("variant hold plays hold events", pressed_usages() == {0x06}, str(pressed_usages()))
check("variant hold announced", any(
    m.get("t") == "key_action" and m.get("variant") == "hold" for m in outbox), str(outbox))
app.buttons.stable[0] = False
app.buttons.scan = _orig_scan
app.proto.send = _orig_send

# --- standalone btn streaming: edges reach a connected app in both modes --
outbox.clear()
app.proto.send = lambda obj: (outbox.append(obj), True)[1]
app.handle_msg({"t": "host_leave"})
app.play_file = lambda path, trigger=None, **kw: None  # don't actually play
app.on_edge(1, True)
check("standalone btn streamed when connected",
      any(m.get("t") == "btn" and m.get("edge") == "down" for m in outbox), str(outbox))
del app.play_file
app.proto.send = _orig_send
app.proto.ser = None

# --- serial "led" op (proto v2): app feedback override --------------------
check("hello reports proto v9", app.hello()["proto"] == 9, str(app.hello()["proto"]))
check("hello reports usb_drive", app.hello()["usb_drive"] == app.config["usb_drive"], str(app.hello()))

# profile path resolution (issue #23): a profile is a full independent config —
# numbered keys resolve to the profile's file with NO fallback (a cleared key
# does nothing), while module slots keep their standalone fallback.
app.handle_msg({"t": "profile", "id": "p_test"})
check("profile set via serial", app.profile_id == "p_test")
check("profile key path no fallback", app.macro_path_for(1, 0) == "/macros/p_test_key1.json",
      app.macro_path_for(1, 0))
check("profile key path ignores layer", app.macro_path_for(2, 1) == "/macros/p_test_key2.json",
      app.macro_path_for(2, 1))
check("profile slot falls back to standalone", app.slot_path("enc-cw", 0) == "/macros/enc-cw.json",
      app.slot_path("enc-cw", 0))
app.handle_msg({"t": "profile", "id": None})
check("profile cleared", app.profile_id is None)
check("no profile -> standalone key path", app.macro_path_for(1, 0) == "/macros/key1.json",
      app.macro_path_for(1, 0))
app.proto.ser = FakeSerial([])
app.handle_msg({"t": "led", "mode": "solid", "rgb": [255, 0, 0]})
check("led solid override set", app.led.override == ("solid", (255, 0, 0)), str(app.led.override))
app.handle_msg({"t": "led", "mode": "blink", "rgb": [0, 0, 255]})
check("led blink override set", app.led.override == ("blink", (0, 0, 255)), str(app.led.override))
app.handle_msg({"t": "led", "mode": "off"})
check("led override cleared by off", app.led.override is None, str(app.led.override))
app.handle_msg({"t": "led", "mode": "solid", "rgb": "garbage"})
check("led garbage rgb tolerated", app.led.override is None, str(app.led.override))

# --- serial "label" op (fw 0.9.0): app-pushed profile label ---------------
outbox.clear()
app.proto.send = lambda obj: (outbox.append(obj), True)[1]
app.handle_msg({"t": "label", "text": "Photoshop"})
check("label stored", app.host_label == "Photoshop", str(app.host_label))
check("label acked", outbox[-1] == {"t": "ok", "re": "label"}, str(outbox[-1:]))
app.handle_msg({"t": "label", "text": "x" * 40})
check("label truncated to 24", app.host_label == "x" * 24, str(app.host_label))
app.handle_msg({"t": "label", "text": ""})
check("label empty clears", app.host_label is None, str(app.host_label))
app.handle_msg({"t": "label"})
check("label missing text clears", app.host_label is None, str(app.host_label))

# proto v6: the label can carry the profile's key names (host-mode grid)
app.handle_msg({"t": "label", "text": "PS", "keys": ["Zoom in", "Zoom out",
                "", "Undo", "Redo", "Save", "extra7"]})
check("label keys stored (capped at 6)",
      app.host_keys == ["Zoom in", "Zoom out", "", "Undo", "Redo", "Save"],
      str(app.host_keys))
app.handle_msg({"t": "label", "text": "PS", "keys": ["", "", "", "", "", ""]})
check("label all-empty keys -> None", app.host_keys is None, str(app.host_keys))
app.handle_msg({"t": "label", "text": "PS", "keys": "garbage"})
check("label garbage keys tolerated", app.host_keys is None, str(app.host_keys))
app.handle_msg({"t": "label", "text": ""})
check("label clear drops keys too", app.host_label is None and app.host_keys is None)

# --- serial "scroll" op (proto v6): app-accelerated wheel -----------------
sent_reports.clear()
outbox.clear()
app.handle_msg({"t": "scroll", "dy": 4, "mods": ["CTRL"]})
check("scroll acked", outbox[-1] == {"t": "ok", "re": "scroll"}, str(outbox[-1:]))
s_wheel = [struct.unpack("<bb", r[2]) for r in sent_reports
           if r[1] == 0x02 and len(r[2]) == 2]
s_kbd = [r[2] for r in sent_reports if r[1] == 0x06]
check("scroll ticks sent", sum(1 for m in s_wheel if m[0] == 1) == 4, str(s_wheel))
check("scroll holds+releases ctrl",
      s_kbd and s_kbd[0][0] == 0x01 and s_kbd[-1][0] == 0x00, str(s_kbd))
outbox.clear()
app.handle_msg({"t": "scroll", "dy": "garbage"})
check("scroll garbage -> err", outbox[-1].get("code") == "hid", str(outbox[-1:]))
app.proto.send = _orig_send
app.proto.ser = None

# --- serial file management (proto v3): fs_* commands ---------------------
# The firmware roots every path at "/" (the CIRCUITPY drive). That maps
# directly onto a POSIX temp dir but not onto Windows drive letters, so this
# section runs on POSIX only (CI covers it).
import binascii  # noqa: E402
import shutil  # noqa: E402


def fs_section():
    fs_dir = tempfile.mkdtemp()  # absolute path; fs_path() keeps it absolute
    fs_rel = fs_dir.lstrip("/")
    outbox.clear()
    app.proto.send = lambda obj: (outbox.append(obj), True)[1]

    # chunked write: two chunks + eof, lands atomically via .part + rename
    payload = b'{"format":"mkyada-macro","version":2,"events":[]}' * 50
    half = len(payload) // 2
    b64 = lambda b: binascii.b2a_base64(b).decode().strip()  # noqa: E731
    app.handle_msg({"t": "fs_write", "path": fs_rel + "/macros/key1.json",
                    "seq": 0, "data": b64(payload[:half]), "eof": False})
    check("fs_write chunk acked", outbox[-1] == {"t": "ok", "re": "fs_write", "seq": 0}, str(outbox[-1:]))
    app.handle_msg({"t": "fs_write", "path": fs_rel + "/macros/key1.json",
                    "seq": 1, "data": b64(payload[half:]), "eof": True})
    check("fs_write eof acked", outbox[-1].get("eof") is True, str(outbox[-1:]))
    with open(fs_dir + "/macros/key1.json", "rb") as f:
        check("fs_write content intact", f.read() == payload)
    check("fs_write .part cleaned", not os.path.exists(fs_dir + "/macros/key1.json.part"))

    # out-of-order chunk -> bad_seq error, upload discarded
    app.handle_msg({"t": "fs_write", "path": fs_rel + "/x.bin", "seq": 0,
                    "data": b64(b"aa"), "eof": False})
    app.handle_msg({"t": "fs_write", "path": fs_rel + "/x.bin", "seq": 5,
                    "data": b64(b"bb"), "eof": True})
    check("fs_write bad seq rejected", outbox[-1].get("code") == "bad_seq", str(outbox[-1:]))
    check("fs_write bad seq leaves no file", not os.path.exists(fs_dir + "/x.bin"))

    # read it back (multi-chunk: the app acks each chunk; stub that here)
    outbox.clear()
    app.wait_fs_ack = lambda: True
    app.handle_msg({"t": "fs_read", "path": fs_rel + "/macros/key1.json"})
    del app.wait_fs_ack
    chunks = [m for m in outbox if m.get("t") == "fs_chunk"]
    got = b"".join(binascii.a2b_base64(m["data"]) for m in chunks if m["data"])
    check("fs_read roundtrip", got == payload and chunks[-1]["eof"] is True,
          "%d chunks, %d bytes" % (len(chunks), len(got)))

    outbox.clear()
    app.handle_msg({"t": "fs_read", "path": fs_rel + "/nope.json"})
    check("fs_read missing -> not_found", outbox[-1].get("code") == "not_found", str(outbox[-1:]))

    # a MemoryError mid-read reports oom instead of propagating (which would
    # crash the loop and repaint the console onto the OLED)
    outbox.clear()
    _orig_send = app.proto.send
    _calls = {"n": 0}

    def _boom(obj):
        if obj.get("t") == "fs_chunk":
            _calls["n"] += 1
            raise MemoryError("simulated")
        return _orig_send(obj)

    app.proto.send = _boom
    app.wait_fs_ack = lambda: True
    app.handle_msg({"t": "fs_read", "path": fs_rel + "/macros/key1.json"})
    app.proto.send = _orig_send
    del app.wait_fs_ack
    # the adaptive reader halves the chunk a few times before giving up, so
    # several attempts are expected — what matters is err oom, not a crash
    check("fs_read oom -> err not crash",
          _calls["n"] >= 1 and outbox and outbox[-1].get("code") == "oom",
          str(outbox[-1:]))

    # list + delete
    outbox.clear()
    app.handle_msg({"t": "fs_list", "path": fs_rel + "/macros"})
    listed = outbox[-1]
    check("fs_list sees the file",
          listed.get("t") == "fs_list"
          and any(e["name"] == "key1.json" and e["size"] == len(payload) and not e["dir"]
                  for e in listed.get("entries", [])),
          str(listed))
    # a big directory pages its listing (>8 entries → "more"-flagged batches),
    # so the reply never needs one multi-KB dumps on a fragmented heap
    for i in range(20):
        with open(fs_dir + "/macros/pg%02d.json" % i, "w") as f:
            f.write("{}")
    outbox.clear()
    app.handle_msg({"t": "fs_list", "path": fs_rel + "/macros"})
    pages = [m for m in outbox if m.get("t") == "fs_list"]
    total = sum(len(p.get("entries", [])) for p in pages)
    check("fs_list paginates",
          len(pages) >= 3 and all(p.get("more") for p in pages[:-1])
          and not pages[-1].get("more") and total >= 20,
          "pages=%d total=%d" % (len(pages), total))
    for i in range(20):
        os.remove(fs_dir + "/macros/pg%02d.json" % i)

    app.handle_msg({"t": "fs_delete", "path": fs_rel + "/macros/key1.json"})
    check("fs_delete ok", outbox[-1].get("re") == "fs_delete" and outbox[-1].get("t") == "ok", str(outbox[-1:]))
    check("fs_delete removed", not os.path.exists(fs_dir + "/macros/key1.json"))

    # path traversal is refused
    outbox.clear()
    app.handle_msg({"t": "fs_read", "path": "../etc/passwd"})
    check("fs path traversal refused", outbox[-1].get("code") == "bad_path", str(outbox[-1:]))

    # mid-playback: fs ops answer busy instead of silently stalling the app
    outbox.clear()
    app.handle_msg({"t": "fs_write", "path": fs_rel + "/y.bin", "seq": 0,
                    "data": "", "eof": True}, in_playback=True)
    check("fs busy during playback", outbox[-1].get("code") == "busy", str(outbox[-1:]))

    app.proto.send = _orig_send
    shutil.rmtree(fs_dir, ignore_errors=True)


if os.name != "nt":
    fs_section()
else:
    print("SKIP fs_* section (POSIX-rooted paths; covered on CI)")

# usb_drive config: finished-product default is hidden (False); an explicit
# true shows the drive and survives load_config
_b.open = _cfg_open({"usb_drive": True})
app.load_config()
check("usb_drive true honored", app.config["usb_drive"] is True)
_b.open = _cfg_open({})
app.load_config()
check("usb_drive defaults off", app.config["usb_drive"] is False)
_b.open = _real_open
app.load_config()

# show_layer / show_profile (fw 0.9.0): default off, non-bool coerced off
_b.open = _cfg_open({"show_layer": True, "show_profile": "yes"})
app.load_config()
check("show_layer true honored", app.config["show_layer"] is True)
check("show_profile non-bool -> off", app.config["show_profile"] is False)
_b.open = _cfg_open({})
app.load_config()
check("band flags default off", app.config["show_layer"] is False
      and app.config["show_profile"] is False)
check("hello mirrors band flags", app.hello()["show_layer"] is False
      and app.hello()["show_profile"] is False, str(app.hello()))
_b.open = _real_open
app.load_config()

# --- models / two-device plumbing -----------------------------------------
from mkyada import models as modelsmod  # noqa: E402

VIS_PINS = ["GP29", "GP28", "GP27", "GP26", "GP15", "GP14"]
check("resolve core6", modelsmod.resolve_model("core6") == "core6")
check("resolve vision6", modelsmod.resolve_model("vision6") == "vision6")
check("resolve default (no i2c hw)", modelsmod.resolve_model(None) == "core6")
check("pins valid", modelsmod.validate_key_pins(VIS_PINS, 6, "vision6") == VIS_PINS)
check("pins wrong len", modelsmod.validate_key_pins(VIS_PINS[:5], 6, "vision6") is None)
check("pins reserved refused",
      modelsmod.validate_key_pins(["GP0"] + VIS_PINS[1:], 6, "vision6") is None)
check("pins duplicate refused",
      modelsmod.validate_key_pins(["GP29"] + VIS_PINS[:5], 6, "vision6") is None)
check("pins unknown refused",
      modelsmod.validate_key_pins(["GP99"] + VIS_PINS[1:], 6, "vision6") is None)
cands = modelsmod.detect_candidates("vision6")
check("detect candidates skip reserved",
      "GP13" in cands and not any(c in cands for c in
                                  ("GP0", "GP1", "GP2", "GP3", "GP4", "GP5", "GP6", "GP16")),
      str(cands))

hello2 = app.hello()
check("hello model core6", hello2["model"] == "core6", str(hello2.get("model")))
check("hello pins default order", hello2["pins"] == ["GP0", "GP1", "GP2", "GP3", "GP4", "GP5"],
      str(hello2["pins"]))

# custom pins survive load_config and drive the button pin list
_b.open = _cfg_open({"pins": ["GP5", "GP4", "GP3", "GP2", "GP1", "GP0"]})
app.load_config()
check("custom pins accepted", app.key_pin_names() == ["GP5", "GP4", "GP3", "GP2", "GP1", "GP0"])
_b.open = _cfg_open({"pins": ["GP16", "GP4", "GP3", "GP2", "GP1", "GP0"]})
app.load_config()
check("reserved pin falls back to default", app.config["pins"] is None)
_b.open = _real_open
app.load_config()

# pin_detect: wiring wizard streams GPIO edges, then restores the keys
outbox.clear()
app.proto.send = lambda obj: (outbox.append(obj), True)[1]
app.proto.ser = FakeSerial([])
app.handle_msg({"t": "pin_detect", "on": True})
check("pin watch armed", app.pin_watch is not None)
watch_names, watch_btns = app.pin_watch
watch_btns.ios[watch_names.index("GP13")].value = False  # user presses the key
import time as _t2  # noqa: E402

app.tick_pin_watch(_t2.monotonic())
check("pin event streamed",
      any(m.get("t") == "pin" and m.get("pin") == "GP13" and m.get("down") for m in outbox),
      str(outbox))
app.handle_msg({"t": "pin_detect", "on": False})
check("pin watch restored", app.pin_watch is None and len(app.buttons.stable) == 6)
app.proto.send = _orig_send
app.proto.ser = None

# --- vision6: fresh module exec with a vision6 config ---------------------
_b.open = _cfg_open({"model": "vision6", "layer_key": 3, "layer_count": 1,
                     "key_count": 12})
vis_mod = types.ModuleType("fwvis")
exec(compile(src, "app.py", "exec"), vis_mod.__dict__)
vapp = vis_mod.App()
_b.open = _real_open
import mkyada.ui as uimod  # noqa: E402

check("vision6 model resolved", vapp.model == "vision6")
check("vision6 layer_key forced null", vapp.config["layer_key"] is None)
check("vision6 single layer allowed", vapp.config["layer_count"] == 1)
check("vision6 key_count clamped to 6", vapp.config["key_count"] == 6)
vhello = vapp.hello()
check("vision6 hello model", vhello["model"] == "vision6")
check("vision6 hello pins", vhello["pins"] == VIS_PINS, str(vhello["pins"]))
check("vision6 oled headless on desktop", vis_mod.OLED is not None and not vis_mod.OLED.ok)
check("vision6 ui attached", vapp.ui is not None)

# --- vision6 UI: labels, speed persistence, slots, host events ------------
ui = vapp.ui
voutbox = []
vapp.proto.send = lambda obj: (voutbox.append(obj), True)[1]
vapp.proto.ser = FakeSerial([])
mac_dir = tempfile.mkdtemp()
LN = "abcdefgh"


def vpath(k, l):
    return os.path.join(mac_dir, "key%d%s.json" % (k, "" if l == 0 else "-" + LN[l]))


vapp.macro_path_for = vpath
vapp.slot_path = lambda s, l: os.path.join(
    mac_dir, "%s%s.json" % (s, "" if l == 0 else "-" + LN[l]))

with open(vpath(1, 0), "w") as f:  # v4 stream file: name+speed in the header
    f.write(json.dumps({"format": "mkyada-macro", "version": 4, "stream": True,
                        "name": "volume up", "settings": {"speed": 1.5}}) + "\n")
    f.write(json.dumps({"delay": 0, "type": "key", "action": "down", "key": "a"}) + "\n")
    f.write(json.dumps({"delay": 0, "type": "key", "action": "up", "key": "a"}) + "\n")
with open(vpath(2, 0), "w") as f:  # single-line legacy whole-file macro
    json.dump({"format": "mkyada-macro", "version": 2, "name": "mute",
               "settings": {"speed": 2.0}, "events": []}, f)

ui.load_layer(0)
vlabels = ui.labels(0)
# "volume up" is 35px wide and a cell holds 40, so it now stays on ONE line.
# The old fixed 10-character cut split it for no reason — that is the
# proportional font paying for itself.
check("label split from stream header", vlabels[0] == ("volume up", ""), str(vlabels[0]))
check("label fallback K3", vlabels[2][0] == "K3", str(vlabels))
check("speed tenths from stream", ui.speed_tenths(0, 0) == 15)
check("speed tenths from legacy", ui.speed_tenths(0, 1) == 20)

# Splitting is by pixels now. The display is headless here (no I2C bus on a
# desktop) so no font was loaded; attach the real one so these exercise the
# metrics the device actually uses.
from mkyada.font import Font as _Font  # noqa: E402
ui.oled.font = _Font(os.path.join(FFW, "fonts", "mkyada.fnt"))
ui._labels.clear()
ui.load_layer(0)
vlabels = ui.labels(0)
check("split short stays", ui._split_name("copy") == ("copy", ""))
check("split at word gap", ui._split_name("switch weapon") == ("switch", "weapon"),
      str(ui._split_name("switch weapon")))
check("narrow letters pack tighter than wide ones",
      ui._split_name("lllllllllllll")[1] == ""
      and ui._split_name("WWWWWWWWWWWWW")[1] != "")
check("split hard cut", ui._split_name("abcdefghijklmnop") == ("abcdefghij", "klmnop"))

res = ui.persist_speed(0, 0, 30)
with open(vpath(1, 0)) as f:
    vlines = f.read().strip().split("\n")
vhdr = json.loads(vlines[0])
check("persist stream ok", res == "ok")
check("persist header speed 3.0", vhdr["settings"]["speed"] == 3.0 and vhdr.get("stream"))
check("persist events intact", len(vlines) == 3, str(len(vlines)))
check("persist announces macro_changed",
      any(m.get("t") == "macro_changed" and m.get("reason") == "speed" for m in voutbox),
      str(voutbox))
check("persist cache updated", ui.speed_tenths(0, 0) == 30)
check("persist missing file", ui.persist_speed(0, 4, 10) == "missing")
res2 = ui.persist_speed(0, 1, 5)
with open(vpath(2, 0)) as f:
    vdata2 = json.load(f)
check("persist whole-file speed 0.5", res2 == "ok" and vdata2["settings"]["speed"] == 0.5)
check("persist keeps name", vdata2["name"] == "mute")

# per-profile speed (issue #23): under an active profile the speed editor
# copy-on-writes into the PROFILE's file, leaving the standalone macro alone.
def vprof_key_path(k):
    return os.path.join(mac_dir, "p_test_key%d.json" % k)


vapp.profile_id = "p_test"
vapp.profile_key_path = vprof_key_path
res_cow = ui.persist_speed(0, 0, 40)  # key1: no profile file yet -> seed it
check("profile speed cow ok", res_cow == "ok")
check("profile file created", os.path.exists(vprof_key_path(1)))
with open(vprof_key_path(1)) as f:
    cow_lines = f.read().strip().split("\n")
check("profile speed 4.0", json.loads(cow_lines[0])["settings"]["speed"] == 4.0)
check("profile cow kept events", len(cow_lines) == 3, str(len(cow_lines)))
with open(vpath(1, 0)) as f:  # standalone macro untouched (still 3.0)
    check("standalone speed untouched",
          json.loads(f.readline())["settings"]["speed"] == 3.0)
vapp.profile_id = None
ui._speeds.clear()  # drop the profile-scoped cache before the slot tests

with open(vapp.slot_path("enc-cw", 0), "w") as f:  # custom encoder slot
    json.dump({"format": "mkyada-macro", "version": 2, "name": "vol+",
               "events": []}, f)
ui.invalidate_labels()
check("slot found on layer a", bool(ui.slots(0)["enc-cw"]))
check("slot layer b falls back to a",
      ui.slots(1)["enc-cw"]["path"] == vapp.slot_path("enc-cw", 0),
      str(ui.slots(1)["enc-cw"]))
check("slot unassigned is None", ui.slots(0)["btn-back"] is None)
check("slot meta tap is play", ui.slots(0)["enc-cw"]["tap"] == ("play",),
      str(ui.slots(0)["enc-cw"]))

# boot goes straight to the active layer's grid, not the layer picker
ui.start()
check("boot lands on grid not home", ui.state == uimod.S_SELECT)

vplays = []
vapp.play_file = lambda path, trigger=None, **k: vplays.append(path)
ui.state = uimod.S_SELECT
ui.sel_mode = False
ui.enc.position += 2
ui.tick(_t2.monotonic())
check("custom encoder plays per detent",
      vplays == [vapp.slot_path("enc-cw", 0)] * 2, str(vplays))
ui.state = uimod.S_SELECT
ui.sel_mode = True  # select mode: rotation moves the cell instead
vplays.clear()
ui.enc.position += 1
ui.tick(_t2.monotonic())
check("select mode keeps navigation", vplays == [] and ui.sel_key == 1,
      "%s sel=%d" % (vplays, ui.sel_key))

ui._labels[1] = [("x", "")] * 6
ui.invalidate_labels("/macros/key3-b.json")
check("invalidate drops layer b", 1 not in ui._labels)

# menu-nav injected by a macro key drives the UI like the encoder/buttons
ui.state = uimod.S_SELECT
ui.sel_mode = True   # plain navigation grid
ui.sel_key = 0
ui.inject("right")
check("inject right moves selection", ui.sel_key == 1, "sel=%d" % ui.sel_key)
ui.inject("left")
check("inject left moves selection", ui.sel_key == 0, "sel=%d" % ui.sel_key)
ui.inject("confirm")
check("inject confirm opens speed editor", ui.state == uimod.S_SPEED)
ui.inject("back")
check("inject back leaves speed editor", ui.state != uimod.S_SPEED)
prev_state = ui.state
ui.state = uimod.S_HOST
ui.inject("right")  # ignored while app owns the screen
check("inject ignored in host mode", ui.state == uimod.S_HOST)
ui.state = prev_state

voutbox.clear()
vapp.handle_msg({"t": "host_enter"})
check("host mode shows host screen", ui.state == uimod.S_HOST)
ui.enc.position += 3
ui.tick(_t2.monotonic())
check("host encoder event batched",
      any(m.get("t") == "enc" and m.get("d") == 1 and m.get("n") == 3 for m in voutbox),
      str(voutbox))
ui.nav.events.queue.append(FakeKeyEvent(1, True))
ui.tick(_t2.monotonic())
check("host nav slot event",
      any(m.get("t") == "btn" and m.get("slot") == "back" and m.get("down") for m in voutbox),
      str(voutbox))
vapp.handle_msg({"t": "host_leave"})
check("host exit restores grid", ui.state == uimod.S_SELECT)

# host-mode grid (proto v6): the app pushes the profile's key names in the
# label message; entering host mode (or a label change while in it) draws
# them as a grid — headless here, so the point is state + no crash
vapp.handle_msg({"t": "label", "text": "Photoshop",
                 "keys": ["Zoom in", "Zoom out", "Undo", "", "", ""]})
vapp.handle_msg({"t": "host_enter"})
check("host grid state", ui.state == uimod.S_HOST)
vapp.handle_msg({"t": "label", "text": "Photoshop",
                 "keys": ["A", "B", "C", "D", "E", "F"]})  # on_label redraw
check("host grid survives label update", ui.state == uimod.S_HOST)
vapp.handle_msg({"t": "label", "text": ""})  # back to plain host screen
check("host label cleared in host mode",
      vapp.host_label is None and vapp.host_keys is None)
vapp.handle_msg({"t": "host_leave"})
check("host grid exit restores grid", ui.state == uimod.S_SELECT)

# --- issue #19: btn-psh, slot key logic, per-context overrides ------------
# btn-psh is a grid slot: tap plays its macro (resolved from a queued
# release), holding it past ESC_HOLD_S is the guaranteed select-mode escape
with open(vapp.slot_path("btn-psh", 0), "w") as f:
    json.dump({"format": "mkyada-macro", "version": 2, "name": "mute",
               "kind": "media", "events": []}, f)
ui.invalidate_labels()
ui.state = uimod.S_SELECT
ui.sel_mode = False
vplays.clear()
ui.nav.events.queue.append(FakeKeyEvent(0, False))  # released -> tap
ui._dispatch(_t2.monotonic(), 0, uimod.K_PSH)
check("psh tap plays its macro", vplays == [vapp.slot_path("btn-psh", 0)],
      str(vplays))
vplays.clear()
ui._dispatch(_t2.monotonic(), 0, uimod.K_PSH)  # never released -> escape hold
check("psh hold escape toggles select mode", ui.sel_mode and vplays == [],
      "sel_mode=%s %s" % (ui.sel_mode, vplays))
ui._dispatch(_t2.monotonic(), 0, uimod.K_PSH)  # sel_mode: default PSH exits it
check("psh in select mode toggles back", not ui.sel_mode)

# an own hold variant beats the escape and drives BUILT-IN navigation
with open(vapp.slot_path("btn-psh", 0), "w") as f:
    json.dump({"format": "mkyada-macro", "version": 3, "name": "mute",
               "kind": "media", "events": [],
               "variants": {"hold": {"kind": "menu", "menu": "back",
                                     "events": []}}}, f)
ui.invalidate_labels()
ui.state = uimod.S_SELECT
ui.sel_mode = False
vplays.clear()
ui._dispatch(_t2.monotonic(), 0, uimod.K_PSH)  # held -> hold variant
check("psh hold variant = menu back goes home",
      ui.state == uimod.S_HOME and not ui.sel_mode and vplays == [],
      "state=%d" % ui.state)

# menu-kind tap on an encoder slot drives the built-in nav (no recursion)
with open(vapp.slot_path("enc-ccw", 0), "w") as f:
    json.dump({"format": "mkyada-macro", "version": 2, "kind": "menu",
               "menu": "left", "events": []}, f)
ui.invalidate_labels()
ui.state = uimod.S_SELECT
ui.sel_mode = False
ui.sel_key = 3
vplays.clear()
ui._dispatch(_t2.monotonic(), -1, None)
check("menu-kind enc slot drives built-in nav",
      ui.sel_key == 2 and vplays == [], "sel=%d %s" % (ui.sel_key, vplays))

# menu:"none" = the app's "Do nothing": the input is swallowed — no nav
# move, no playback (an off switch that overrides the built-in action)
with open(vapp.slot_path("enc-ccw", 0), "w") as f:
    json.dump({"format": "mkyada-macro", "version": 2, "kind": "menu",
               "menu": "none", "events": []}, f)
ui.invalidate_labels()
ui.state = uimod.S_SELECT
ui.sel_mode = False
ui.sel_key = 3
vplays.clear()
ui._dispatch(_t2.monotonic(), -1, None)
check("menu-none enc slot swallows the input",
      ui.sel_key == 3 and vplays == [], "sel=%d %s" % (ui.sel_key, vplays))
with open(vapp.slot_path("btn-back", 0), "w") as f:
    json.dump({"format": "mkyada-macro", "version": 2, "kind": "menu",
               "menu": "none", "events": []}, f)
ui.invalidate_labels()
ui._dispatch(_t2.monotonic(), 0, uimod.K_BACK)
check("menu-none BACK slot swallows the press",
      ui.state == uimod.S_SELECT and vplays == [], "state=%d" % ui.state)
os.remove(os.path.join(mac_dir, "btn-back.json"))
ui.invalidate_labels()

# direct-jump menu actions (fw 0.12.0): "settings" opens the settings menu,
# "home" the layer screen — injected from a macro key or assigned to a slot
ui.state = uimod.S_SELECT
ui.inject("settings")
check("inject settings jumps to the settings menu",
      ui.state == uimod.S_SET_MENU, "state=%d" % ui.state)
ui.inject("home")
check("inject home jumps to the layer screen",
      ui.state == uimod.S_HOME and ui.home_pos == vapp.layer,
      "state=%d pos=%d" % (ui.state, ui.home_pos))
with open(vapp.slot_path("btn-confirm", 0), "w") as f:
    json.dump({"format": "mkyada-macro", "version": 2, "kind": "menu",
               "menu": "settings", "events": []}, f)
ui.invalidate_labels()
ui.state = uimod.S_SELECT
vplays.clear()
ui._dispatch(_t2.monotonic(), 0, uimod.K_CONFIRM)
check("menu-settings CONFIRM slot opens settings",
      ui.state == uimod.S_SET_MENU and vplays == [], "state=%d" % ui.state)
os.remove(os.path.join(mac_dir, "btn-confirm.json"))
ui.invalidate_labels()
_lyr0 = vapp.layer
ui.inject("layer_next")
check("inject layer_next cycles the layer and shows the grid",
      vapp.layer == (_lyr0 + 1) % vapp.config["layer_count"]
      and ui.state == uimod.S_SELECT,
      "layer=%d state=%d" % (vapp.layer, ui.state))
ui.inject("layer_prev")
check("inject layer_prev returns", vapp.layer == _lyr0, str(vapp.layer))
ui.state = uimod.S_HOME
ui.inject("grid")
check("inject grid jumps to the key grid", ui.state == uimod.S_SELECT,
      "state=%d" % ui.state)
ui._enter_grid()

# --- context-aware wheel menu (issue: wheel-menu redesign) ----------------
# CONFIRM on the selected key opens a menu that fits the key's action kind,
# not always the speed editor. Each key1 rewrite below is re-read after
# invalidate_labels drops the (kind, sub) cache.
def _write_key1(obj):
    obj.setdefault("format", "mkyada-macro")
    obj.setdefault("version", 2)
    obj.setdefault("events", [])
    with open(vpath(1, 0), "w") as f:
        json.dump(obj, f)
    ui.invalidate_labels("/macros/key1.json")


def _confirm_key1():
    ui.state = uimod.S_SELECT
    ui.sel_mode = False
    ui.sel_key = 0
    vplays.clear()
    ui._dispatch(_t2.monotonic(), 0, uimod.K_CONFIRM)


# no kind (a plain recorded/stream macro) still opens the speed editor
_write_key1({"name": "macro", "stream": True, "settings": {"speed": 1.0}})
_confirm_key1()
check("ctx: kindless key opens speed editor", ui.state == uimod.S_SPEED,
      "state=%d" % ui.state)

# keystroke -> a "key" card (turn = turbo-fire, CONFIRM = fire once)
_write_key1({"name": "Undo", "kind": "keystroke", "combo": {"mods": [], "key": "z"}})
_confirm_key1()
check("ctx: keystroke opens an action card",
      ui.state == uimod.S_CTX and ui.ctx["mode"] == "key",
      "state=%d ctx=%s" % (ui.state, ui.ctx))
ui.enc.position += 2  # turn -> fire the key twice
vplays.clear()
ui.tick(_t2.monotonic())
check("ctx: keystroke card turbo-fires per detent",
      vplays == [vpath(1, 0)] * 2, str(vplays))

# media -> an options browser: cursor starts on the assigned usage; a tap
# fires the highlighted one, a hold reassigns the key to it (issue: grammar)
_write_key1({"name": "Vol+", "kind": "media", "media": "volume_up",
             "events": [{"delay": 0, "type": "consumer", "usage": "volume_up"}]})
_confirm_key1()
check("ctx: media opens an options browser",
      ui.state == uimod.S_CTX and ui.ctx["mode"] == "optlist"
      and ui.ctx["assigned"] == uimod.MEDIA_OPTS.index("volume_up"),
      "ctx=%s" % (ui.ctx,))
# tap the highlighted option -> fires it once (queue a release so it reads tap)
_creports = len(sent_reports)
ui.nav.events.queue.append(FakeKeyEvent(uimod.K_CONFIRM, True))
ui.nav.events.queue.append(FakeKeyEvent(uimod.K_CONFIRM, False))
ui.tick(_t2.monotonic())
check("ctx: media tap fires the highlighted key",
      len(sent_reports) > _creports, "reports+%d" % (len(sent_reports) - _creports))
# hold on a different option -> reassigns the key (device writes the macro)
ui.ctx["sel"] = uimod.MEDIA_OPTS.index("play_pause")
ui.nav.events.queue.append(FakeKeyEvent(uimod.K_CONFIRM, True))  # never released -> hold
ui.tick(_t2.monotonic())
with open(vpath(1, 0)) as f:
    _reassigned = json.load(f)
check("ctx: media hold reassigns the key",
      _reassigned.get("kind") == "media" and _reassigned.get("media") == "play_pause",
      str(_reassigned))

# discoverability: the browser's bottom bar must advertise hold-to-reassign,
# otherwise a first-timer never learns the gesture (issue: hold hint on screen)
_menu_kw = {}
_orig_show_menu = ui.oled.show_menu
def _cap_show_menu(*a, **k):
    _menu_kw.clear()
    _menu_kw.update(k)
    return _orig_show_menu(*a, **k)
ui.oled.show_menu = _cap_show_menu
_write_key1({"name": "Vol+", "kind": "media", "media": "volume_up",
             "events": [{"delay": 0, "type": "consumer", "usage": "volume_up"}]})
_confirm_key1()
ui._draw_optlist()
check("ctx: media browser shows the hold-to-reassign hint",
      bool(_menu_kw.get("hold")), str(_menu_kw))

# menu (layer / nav) key: the wheel browses the whole family, taps run the
# highlighted one live and holds reassign — not just "run next layer" forever
# (issue: layer keys only ran next layer, no prev/goto/reassign)
vapp.config["layer_count"] = 2
_write_key1({"name": "Layer+", "kind": "menu", "menu": "layer_next"})
_confirm_key1()
check("ctx: menu opens the layer browser",
      ui.state == uimod.S_CTX and ui.ctx.get("mode") == "optlist"
      and ui.ctx.get("kind") == "menu"
      and ui.ctx["opts"][ui.ctx["assigned"]] == "layer_next",
      "ctx=%s" % (ui.ctx,))
check("ctx: layer browser shows the hold-to-reassign hint",
      bool(_menu_kw.get("hold")), str(_menu_kw))
# turn to "layer_prev" and hold -> the device rewrites the key standalone
ui.ctx["sel"] = ui.ctx["opts"].index("layer_prev")
ui.nav.events.queue.append(FakeKeyEvent(uimod.K_CONFIRM, True))  # never released
ui.tick(_t2.monotonic())
with open(vpath(1, 0)) as f:
    _mre = json.load(f)
check("ctx: menu hold reassigns the key to prev layer",
      _mre.get("kind") == "menu" and _mre.get("menu") == "layer_prev", str(_mre))
# a tap on a layer action runs it live and leaves the wheel menu
_write_key1({"name": "Layer+", "kind": "menu", "menu": "layer_next"})
_confirm_key1()
_lyr_before = vapp.layer
ui.ctx["sel"] = ui.ctx["opts"].index("layer_next")
ui.nav.events.queue.append(FakeKeyEvent(uimod.K_CONFIRM, True))
ui.nav.events.queue.append(FakeKeyEvent(uimod.K_CONFIRM, False))  # release -> tap
ui.tick(_t2.monotonic())
check("ctx: menu tap runs the layer action and leaves the menu",
      ui.state != uimod.S_CTX and vapp.layer == (_lyr_before + 1) % 2,
      "state=%d layer=%d" % (ui.state, vapp.layer))
vapp.set_layer_idx(0)  # the tap switched layers; restore for the tests below
vapp.config["layer_count"] = 1  # restore the single-layer vision6 fixture
ui.invalidate_labels("/macros/key1.json")

# a host-only kind (OBS) with no app menu support -> the app-needed toast
vapp.host_menus = False
_write_key1({"name": "Scene", "kind": "obs", "obs": {"action": "setScene"}})
_confirm_key1()
check("ctx: host kind shows the app-needed toast", ui.state == uimod.S_TOAST,
      "state=%d" % ui.state)

# with the app advertising menu support (hostinfo): CONFIRM asks the app for a
# menu (ctx message) and shows a waiting card until the app answers
vapp.handle_msg({"t": "hostinfo", "menus": 1})
check("ctx: hostinfo sets host_menus", vapp.host_menus is True)
voutbox.clear()
_confirm_key1()
_ctxmsg = next((m for m in voutbox if m.get("t") == "ctx"), None)
check("ctx: host kind asks the app (ctx message)",
      _ctxmsg is not None and _ctxmsg.get("kind") == "obs"
      and _ctxmsg.get("sub") == "setScene" and _ctxmsg.get("key") == 1,
      str(_ctxmsg))
check("ctx: host kind waits for the menu",
      ui.state == uimod.S_CTX and ui.ctx["mode"] == "wait", "ctx=%s" % (ui.ctx,))

# the app answers with a list menu (scene picker) -> rendered, cursor navigable
ui.on_menu({"t": "menu", "mtype": "list", "key": 1, "title": "SCENE",
            "items": [["Intro", "Intro", 0], ["Game", "Game", 1]], "sel": 1})
check("ctx: menu switches to host list", ui.ctx["mode"] == "host"
      and ui.ctx["mtype"] == "list" and ui.ctx["sel"] == 1, "ctx=%s" % (ui.ctx,))
# a plain host list (no hold flag) shows no reassign hint...
_menu_kw.clear()
ui._draw_host_menu()
check("ctx: host list without hold flag has no reassign hint",
      not _menu_kw.get("hold"), str(_menu_kw))
# ...but when the app marks the menu reassignable (OBS scene / mic mode), the
# device shows the hold-to-reassign affordance so the gesture is discoverable
ui.on_menu({"t": "menu", "mtype": "list", "key": 1, "title": "SCENE",
            "items": [["Intro", "Intro", 0], ["Game", "Game", 1]], "sel": 1,
            "hold": True})
_menu_kw.clear()
ui._draw_host_menu()
check("ctx: reassignable host list shows the hold hint",
      bool(_menu_kw.get("hold")), str(_menu_kw))
ui.oled.show_menu = _orig_show_menu
voutbox.clear()
ui.enc.position -= 1  # turn up -> select the first scene
ui.tick(_t2.monotonic())
check("ctx: list turn moves the cursor", ui.ctx["sel"] == 0, "sel=%d" % ui.ctx["sel"])
# a tap on a list item = "pick" (use it live); a hold = "assign" (reassign)
ui.nav.events.queue.append(FakeKeyEvent(uimod.K_CONFIRM, True))
ui.nav.events.queue.append(FakeKeyEvent(uimod.K_CONFIRM, False))
ui.tick(_t2.monotonic())
_pick = next((m for m in voutbox if m.get("t") == "menu_ev"), None)
check("ctx: list tap picks the item (live)",
      _pick is not None and _pick.get("ev") == "pick" and _pick.get("id") == "Intro",
      str(_pick))
voutbox.clear()
ui.nav.events.queue.append(FakeKeyEvent(uimod.K_CONFIRM, True))  # held -> assign
ui.tick(_t2.monotonic())
_assign = next((m for m in voutbox if m.get("t") == "menu_ev"), None)
check("ctx: list hold reassigns the item",
      _assign is not None and _assign.get("ev") == "assign" and _assign.get("id") == "Intro",
      str(_assign))

# the app answers menu_result -> the menu closes with a toast
ui.on_menu_result({"t": "menu_result", "ok": True, "toast": ["SCENE", "Saved"]})
check("ctx: menu_result closes to a toast", ui.state == uimod.S_TOAST)

# a status card: CONFIRM sends a "fire" event, the app performs the action
ui._enter_grid()
ui.state = uimod.S_SELECT
vapp.host_menus = True
_write_key1({"name": "Rec", "kind": "obs", "obs": {"action": "recordToggle"}})
_confirm_key1()
ui.on_menu({"t": "menu", "mtype": "card", "key": 1, "title": "RECORD",
            "big": "REC", "l1": "ready", "hint": "toggle"})
check("ctx: card menu renders", ui.ctx["mtype"] == "card")
voutbox.clear()
ui.nav.events.queue.append(FakeKeyEvent(uimod.K_CONFIRM, True))
ui.tick(_t2.monotonic())
_fire = next((m for m in voutbox if m.get("t") == "menu_ev"), None)
check("ctx: card CONFIRM fires", _fire is not None and _fire.get("ev") == "fire",
      str(_fire))

# the app going away abandons an open host menu
ui.on_menu({"t": "menu", "mtype": "card", "key": 1, "title": "RECORD", "big": "REC"})
ui.on_host_gone()
check("ctx: host disconnect closes the menu", ui.state == uimod.S_SELECT)

# volume kind: app present -> host slider (ctx asked); app absent -> a local
# HID volume knob card (press mutes)
ui.state = uimod.S_SELECT
vapp.host_menus = True
_write_key1({"name": "Vol", "kind": "volume",
             "events": [{"delay": 0, "type": "consumer", "usage": "mute"}]})
voutbox.clear()
_confirm_key1()
check("ctx: volume with app asks for a host slider",
      any(m.get("t") == "ctx" and m.get("kind") == "volume" for m in voutbox)
      and ui.ctx["mode"] == "wait", "ctx=%s" % (ui.ctx,))
vapp.host_menus = False
_confirm_key1()
check("ctx: volume without app falls back to a local knob",
      ui.state == uimod.S_CTX and ui.ctx["mode"] == "adjust"
      and ui.ctx["conf"] == "mute", "ctx=%s" % (ui.ctx,))

# a volume key opens its wheel menu when the PHYSICAL key is pressed (acts as
# PSH) — a slider kind has no useful "run"
_write_key1({"name": "Vol", "kind": "volume",
             "events": [{"delay": 0, "type": "consumer", "usage": "mute"}]})
ui._enter_grid()
check("press: volume key wants the menu on press", ui.wants_press_menu(1) is True)
ui.open_key_menu(1)
check("press: pressing a volume key opens its menu",
      ui.state == uimod.S_CTX and ui.ctx["mode"] == "adjust", "state=%d" % ui.state)
_write_key1({"name": "Play", "kind": "media", "media": "play_pause",
             "events": [{"delay": 0, "type": "consumer", "usage": "play_pause"}]})
ui._enter_grid()
check("press: a media key still runs (no press-menu)", ui.wants_press_menu(1) is False)

# live system volume shows on volume-kind grid cells (app pushes sysvol)
_write_key1({"name": "Vol", "kind": "volume",
             "events": [{"delay": 0, "type": "consumer", "usage": "mute"}]})
ui._enter_grid()
ui.on_sysvol(40)
check("sysvol: stored", ui.sysvol == 40)
_gl = ui._grid_labels(0)
check("sysvol: volume cell shows the percent", _gl[0][1] == "%40", str(_gl[0]))
ui.on_host_gone()
check("sysvol: cleared when the app disconnects", ui.sysvol is None)

# mic level is host-only: pressing asks the app for a slider
vapp.host_menus = True
_write_key1({"name": "MicLvl", "kind": "mic_level", "events": []})
ui._enter_grid()
voutbox.clear()
ui.open_key_menu(1)
check("ctx: mic_level asks the app for a slider",
      any(m.get("t") == "ctx" and m.get("kind") == "mic_level" for m in voutbox)
      and ui.ctx["mode"] == "wait", "ctx=%s" % (ui.ctx,))
vapp.host_menus = False

# restore key1 to its original stream file for any later expectations
with open(vpath(1, 0), "w") as f:
    f.write(json.dumps({"format": "mkyada-macro", "version": 4, "stream": True,
                        "name": "volume up", "settings": {"speed": 3.0}}) + "\n")
    f.write(json.dumps({"delay": 0, "type": "key", "action": "down", "key": "a"}) + "\n")
    f.write(json.dumps({"delay": 0, "type": "key", "action": "up", "key": "a"}) + "\n")
ui.invalidate_labels("/macros/key1.json")
ui._enter_grid()

# per-context overrides: enc-cw@home plays on the layer picker; the other
# direction of a half-assigned wheel is dead; unassigned BACK stays default
vapp.slot_ctx_path = lambda s, c: os.path.join(mac_dir, "%s@%s.json" % (s, c))
with open(vapp.slot_ctx_path("enc-cw", "home"), "w") as f:
    json.dump({"format": "mkyada-macro", "version": 2, "name": "vol+",
               "events": []}, f)
ui._ctx_slots.clear()
ui.state = uimod.S_HOME
ui.home_pos = 0
vplays.clear()
ui._dispatch(_t2.monotonic(), 1, None)
check("home ctx encoder override plays",
      vplays == [vapp.slot_ctx_path("enc-cw", "home")], str(vplays))
vplays.clear()
ui._dispatch(_t2.monotonic(), -1, None)
check("half-assigned home wheel other direction is dead",
      vplays == [] and ui.home_pos == 0, "pos=%d %s" % (ui.home_pos, vplays))
ui._dispatch(_t2.monotonic(), 0, uimod.K_BACK)
check("home ctx unassigned BACK keeps default", ui.state == uimod.S_SELECT)
ui.invalidate_labels("/macros/enc-cw@home.json")
check("ctx invalidate drops the context cache", "home" not in ui._ctx_slots)

# select mode entered on the grid keeps default nav inside home too
ui.state = uimod.S_HOME
ui.sel_mode = True
ui.home_pos = 0
vplays.clear()
ui._ctx_slots.clear()
ui._dispatch(_t2.monotonic(), 1, None)
check("select mode overrides home ctx customs",
      vplays == [] and ui.home_pos == 1, "pos=%d %s" % (ui.home_pos, vplays))
ui.sel_mode = False
ui._enter_grid()

# cleanup: drop the issue-19 slot files so earlier expectations stay valid
for _f in ("btn-psh.json", "enc-ccw.json", "enc-cw@home.json"):
    try:
        os.remove(os.path.join(mac_dir, _f))
    except OSError:
        pass
ui.invalidate_labels()
ui._ctx_slots.clear()

# --- language (config "lang", i18n tables) --------------------------------
from mkyada import i18n as i18nmod  # noqa: E402

check("lang default en", vapp.config["lang"] == "en", str(vapp.config.get("lang")))
_b.open = _cfg_open({"model": "vision6", "lang": "tr"})
vapp.load_config()
check("lang tr accepted", vapp.config["lang"] == "tr")
_b.open = _cfg_open({"model": "vision6", "lang": "xx"})
vapp.load_config()
check("lang invalid -> en", vapp.config["lang"] == "en")
_b.open = _real_open
i18nmod.set_lang("tr")
check("i18n tr strings", i18nmod.tr("settings") == "AYARLAR"
      and i18nmod.tr("restart") == "Yeniden Başlat")
# The Turkish table used to be ASCII-folded because the bundled BDF fonts had
# no Turkish glyphs. It is real Turkish now, so the invariant flips: every
# character of every string must be one the shipped font actually DRAWS —
# reaching font.py's fold table would mean a letter silently degrades.
_f = _Font(os.path.join(FFW, "fonts", "mkyada.fnt"))
_missing = sorted({ch for tbl in i18nmod.STRINGS.values() for v in tbl.values()
                   for ch in v
                   if not (_f.first <= ord(ch) <= _f.last or ord(ch) in _f.extra)}
                  | {ch for d in i18nmod.LANG_DESC for ch in d
                     if not (_f.first <= ord(ch) <= _f.last or ord(ch) in _f.extra)})
check("every UI string is drawable by the shipped font", not _missing, str(_missing))
i18nmod.set_lang("en")
check("i18n back to en", i18nmod.tr("settings") == "SETTINGS")
check("i18n unknown key echoes", i18nmod.tr("nope-key") == "nope-key")

# settings menu: localized items incl. Language and the band toggles
check("set menu has language", ui._set_items()[uimod.SET_LANG] == "Language")
check("set menu band toggles show state",
      ui._set_items()[uimod.SET_BAND_LAYER] == "Layer band: off"
      and ui._set_items()[uimod.SET_BAND_PROFILE] == "Profile band: off",
      str(ui._set_items()))

# grid band composition (fw 0.9.0): layer part is device-side, profile part
# is whatever the app last pushed via {"t":"label"}
vapp.config["show_layer"] = False
vapp.config["show_profile"] = False
vapp.host_label = "Photoshop"
check("band both off -> none", ui._band() is None, str(ui._band()))
vapp.config["show_layer"] = True
vapp.layer = 1
check("band layer only", ui._band() == "Layer B", str(ui._band()))
vapp.config["show_profile"] = True
check("band layer + profile", ui._band() == "(B) Photoshop", str(ui._band()))
# the app-pushed label (live OBS scene / profile) outranks the stored nickname
vapp.config["layer_names"] = [None, "studyo"]
check("band label beats nickname", ui._band() == "(B) Photoshop", str(ui._band()))
vapp.host_label = None
check("band nickname without label", ui._band() == "(B) studyo", str(ui._band()))
vapp.host_label = "Photoshop"
vapp.config["layer_names"] = None
# blinking OBS markers: (R) recording, (L) live — swapped for same-width
# spaces on the off phase so the band text doesn't shift
vapp.host_rec = True
ui._blink_on = True
check("band rec marker", ui._band() == "(B) (R) Photoshop", str(ui._band()))
vapp.host_live = True
check("band rec+live markers", ui._band() == "(B) (R)(L) Photoshop", str(ui._band()))
ui._blink_on = False
check("band markers blink off keeps width",
      ui._band() == "(B) " + " " * 6 + " Photoshop", str(ui._band()))
ui._blink_on = True
vapp.host_rec = False
vapp.host_live = False
check("band markers gone when idle", ui._band() == "(B) Photoshop", str(ui._band()))

# hello advertises the biggest fs_write chunk this board's heap can hold in
# one contiguous block, so the app never has to discover it by failing
_h = vapp.hello()
check("hello advertises fs_chunk", _h.get("fs_chunk") == vis_mod.FS_WRITE_CHUNK,
      str(_h.get("fs_chunk")))
check("display model caps write chunk at 512B", vis_mod.FS_WRITE_CHUNK == 512,
      str(vis_mod.FS_WRITE_CHUNK))

# the blink tick: idle _st_select calls flip the phase every ~0.6s while a
# marker is active, throttled in between
vapp.host_rec = True
ui.state = uimod.S_SELECT
ui.sel_mode = False
ui._blink_at = 0.0
ui.activity_at = 1000.0
_b0 = ui._blink_on
ui._st_select(1000.0, 0, None)
check("blink tick flips phase", ui._blink_on == (not _b0), str(ui._blink_on))
ui._st_select(1000.2, 0, None)
check("blink tick throttled <0.6s", ui._blink_on == (not _b0), str(ui._blink_on))
ui._st_select(1000.7, 0, None)
check("blink tick flips again", ui._blink_on == _b0, str(ui._blink_on))
vapp.host_rec = False
ui._blink_on = True
vapp.config["show_layer"] = False
check("band profile only", ui._band() == "Photoshop", str(ui._band()))
vapp.host_label = None
check("band profile without label -> none", ui._band() is None, str(ui._band()))

# {"t":"label"} lands in host_label and redraws through on_label (headless
# no-op here — the point is it must not crash mid-grid)
ui.state = uimod.S_SELECT
vapp.handle_msg({"t": "label", "text": "GIMP", "rec": True, "live": True})
check("vision6 label stored", vapp.host_label == "GIMP", str(vapp.host_label))
check("vision6 rec/live flags stored", vapp.host_rec and vapp.host_live)
vapp.handle_msg({"t": "label", "text": ""})
check("vision6 label cleared", vapp.host_label is None)
check("vision6 rec/live flags cleared", not vapp.host_rec and not vapp.host_live)
vapp.config["show_profile"] = False
vapp.layer = 0

# persist_lang rewrites config.json and announces the fresh config

_lang_dir = tempfile.mkdtemp()
_lang_cfg = os.path.join(_lang_dir, "config.json")
with open(_lang_cfg, "w") as f:
    json.dump({"model": "vision6", "layer_count": 4}, f)


def _lang_open(path, *a, **k):
    p = str(path)
    if p.startswith("/config.json"):
        return _real_open(_lang_cfg + p[len("/config.json"):], *a, **k)
    return _real_open(path, *a, **k)


_orig_os_remove, _orig_os_rename = os.remove, os.rename


def _map(p):
    p = str(p)
    return _lang_cfg + p[len("/config.json"):] if p.startswith("/config.json") else p


os.remove = lambda p: _orig_os_remove(_map(p))
os.rename = lambda a, b: _orig_os_rename(_map(a), _map(b))
_b.open = _lang_open
voutbox.clear()
vapp.proto.send = lambda obj: (voutbox.append(obj), True)[1]
res_lang = ui.persist_lang("tr")
_b.open = _real_open
os.remove, os.rename = _orig_os_remove, _orig_os_rename
with open(_lang_cfg) as f:
    _lang_data = json.load(f)
check("persist_lang ok", res_lang == "ok")
check("persist_lang wrote file", _lang_data.get("lang") == "tr"
      and _lang_data.get("layer_count") == 4, str(_lang_data))
check("persist_lang announces config",
      any(m.get("t") == "config" and m.get("lang") == "tr" for m in voutbox), str(voutbox))
check("persist_lang applied", i18nmod.get_lang() == "tr")
i18nmod.set_lang("en")
vapp.config["lang"] = "en"
shutil.rmtree(_lang_dir, ignore_errors=True)

# NVM prefs roundtrip (magic 0x4E: font, idle timeout, last layer)
class FakeNvm(bytearray):
    pass


uimod.NVM = FakeNvm(16)
ui.font_idx, ui.idle_secs = 1, 42
vapp.layer = 0
ui._nvm_save()
check("nvm magic", uimod.NVM[0] == 0x4E)
check("nvm roundtrip", ui._nvm_load() == (1, 42, 0), str(ui._nvm_load()))
uimod.NVM = None

vapp.proto.send = _orig_send
vapp.proto.ser = None
shutil.rmtree(mac_dir, ignore_errors=True)

# 5. app<->firmware contract: every fixture the app compiles (tests/fixtures/,
# regenerated by `npx tsx tests/gen_fixtures.ts`) must play cleanly in the
# engine and leave the keyboard released.
FIXTURES = os.path.join(REPO, "tests", "fixtures")
fixture_files = sorted(f for f in os.listdir(FIXTURES) if f.endswith(".json"))
check("contract fixtures present", len(fixture_files) >= 9, str(fixture_files))
for fname in fixture_files:
    with open(os.path.join(FIXTURES, fname)) as f:
        macro = json.load(f)
    events = [dict(ev, delay=min(ev.get("delay", 0), 1)) for ev in macro["events"]]
    sent_reports.clear()
    try:
        eng.play(events, screen=macro.get("screen") or {"width": 1920, "height": 1080})
        ok = True
    except Exception as e:  # noqa: BLE001 — any crash fails the contract
        ok = False
        check("fixture plays: " + fname, False, repr(e))
    if ok:
        kbd = [r for r in sent_reports if r[1] == 0x06]
        released = (not kbd) or kbd[-1][2] == bytes(8)
        check("fixture plays: " + fname, released,
              "keyboard left pressed" if kbd else "")

# 6. proto v7 safety net: locked update mode, CRC-verified writes, and the
# code.py rescue console that keeps a board repairable after a broken update.
import binascii  # noqa: E402
import tempfile as _tf  # noqa: E402

fs_dir = _tf.mkdtemp()
app.fs_path = lambda msg: os.path.join(fs_dir, str(msg.get("path", "")).lstrip("/"))
outbox = []
app.proto.send = lambda obj: (outbox.append(obj), True)[1]
app.proto.ser = FakeSerial([])

# CRC-verified fs_write: good CRC lands the file...
payload = b'{"format":"mkyada-macro","events":[]}'
b64 = binascii.b2a_base64(payload).decode().strip()
crc = binascii.crc32(payload) & 0xFFFFFFFF
app.handle_msg({"t": "fs_write", "path": "m.json", "seq": 0, "data": b64,
                "eof": True, "crc": crc})
check("crc write ok", outbox[-1].get("eof") and outbox[-1].get("crc") == crc,
      str(outbox[-1]))
with open(os.path.join(fs_dir, "m.json"), "rb") as f:
    check("crc write content", f.read() == payload)

# ...a bad CRC discards it instead of replacing the good file
outbox.clear()
app.handle_msg({"t": "fs_write", "path": "m.json", "seq": 0, "data": b64,
                "eof": True, "crc": (crc ^ 1)})
check("crc mismatch rejected", outbox[-1].get("code") == "crc", str(outbox[-1]))
with open(os.path.join(fs_dir, "m.json"), "rb") as f:
    check("crc mismatch keeps old file", f.read() == payload)
check("crc mismatch leaves no .part",
      not os.path.exists(os.path.join(fs_dir, "m.json.part")))

# locked update mode: only transfer traffic runs, keys are dead, the lock
# auto-expires if the app dies mid-update
outbox.clear()
app.handle_msg({"t": "update_begin", "bytes": len(payload)})
check("update locks", app.updating is True)
check("update warning split in two", all(
    len(i18nmod.STRINGS[lang]["updating"]) <= 21
    and len(i18nmod.STRINGS[lang]["updating2"]) <= 21
    for lang in i18nmod.STRINGS),
    str([(l, i18nmod.STRINGS[l].get("updating2")) for l in i18nmod.STRINGS]))
check("update_begin ok", any(m.get("re") == "update_begin" for m in outbox))
outbox.clear()
app.handle_msg({"t": "play", "file": "macros/key1.json"})
check("play refused while updating", outbox[-1].get("code") == "updating",
      str(outbox[-1]))
played_upd = []
app.play_file = lambda *a, **k: played_upd.append(a)
app.on_edge(0, True)
check("keys dead while updating", played_upd == [])
del app.play_file
# ...and so is the screen: a status push arriving mid-update used to repaint
# the grid over the "do not unplug" screen for a frame (issue #35)
_upd_painted = []


class _CosmeticUI:
    def tick(self, now):
        _upd_painted.append("tick")

    def on_label(self):
        _upd_painted.append("on_label")

    def on_profile(self):
        _upd_painted.append("on_profile")


_real_ui, app.ui = app.ui, _CosmeticUI()
app.ui_stale = False
app.ui_call("on_label")
app.ui_call("tick", 0)
check("cosmetic hooks deferred while updating", _upd_painted == [],
      str(_upd_painted))
check("deferred paint remembered", app.ui_stale is True)
app.ui_call("on_profile")  # not cosmetic: cache drops must still happen
check("on_profile still runs while updating", _upd_painted == ["on_profile"],
      str(_upd_painted))
app.ui = _real_ui
outbox.clear()
app.handle_msg({"t": "fs_write", "path": "m2.bin", "seq": 0, "data": b64,
                "eof": True, "crc": crc})
check("update progress counted", app.update_done == len(payload),
      str(app.update_done))
app.update_deadline = 0  # simulate the app going silent past the deadline
app.updating and app.end_update()
check("abandoned update unlocks", app.updating is False)

# update_end hard-resets the board
outbox.clear()
app.handle_msg({"t": "update_begin", "bytes": 1})
try:
    app.handle_msg({"t": "update_end"})
    check("update_end resets", False, "no reset")
except _ResetCalled:
    check("update_end resets", True)
app.updating = False

# bootloader command: UF2 on next reset, then reset
outbox.clear()
microcontroller.next_reset_to.clear()
try:
    app.handle_msg({"t": "bootloader"})
    check("bootloader resets", False, "no reset")
except _ResetCalled:
    check("bootloader resets", True)
check("bootloader arms uf2", microcontroller.next_reset_to == ["uf2"],
      str(microcontroller.next_reset_to))
app.proto.ser = None

# rescue console: main firmware import fails -> code.py must still answer
# identify/fs_list and reset on command
class RescueSerial:
    def __init__(self, script):
        self.inbuf = b"".join(json.dumps(m).encode() + b"\n" for m in script)
        self.out = []
        self.connected = True
        self.write_timeout = None

    @property
    def in_waiting(self):
        return len(self.inbuf)

    def read(self, n):
        out, self.inbuf = self.inbuf[:n], self.inbuf[n:]
        return out

    def write(self, data):
        self.out.append(data)
        return len(data)


resc_ser = RescueSerial([{"t": "identify"}, {"t": "ping"},
                         {"t": "fs_list", "path": "/"}, {"t": "reset"}])
usb_cdc.data = resc_ser
supervisor_stub = types.ModuleType("supervisor")
supervisor_stub.runtime = types.SimpleNamespace(autoreload=True)
sys.modules["supervisor"] = supervisor_stub
sys.modules["mkyada.app"] = None  # poison: forces the bootstrap's ImportError
with open(os.path.join(FFW, "code.py")) as f:
    rescue_src = f.read()
resc_mod = types.ModuleType("fwrescue")
try:
    exec(compile(rescue_src, "code.py", "exec"), resc_mod.__dict__)
    check("rescue reset exits", False, "rescue loop never reset")
except _ResetCalled:
    check("rescue reset exits", True)
resc_msgs = [json.loads(l) for l in b"".join(resc_ser.out).splitlines()]
resc_hello = next((m for m in resc_msgs if m.get("t") == "hello"), None)
check("rescue hello", resc_hello is not None, str(resc_msgs))
check("rescue hello mode", resc_hello and resc_hello.get("mode") == "rescue")
check("rescue hello err", resc_hello and "err" in resc_hello, str(resc_hello))
check("rescue pong", any(m.get("t") == "pong" for m in resc_msgs))
check("rescue fs_list", any(m.get("t") == "fs_list" for m in resc_msgs))
check("rescue kills autoreload", supervisor_stub.runtime.autoreload is False)
sys.modules.pop("mkyada.app", None)
usb_cdc.data = None
shutil.rmtree(fs_dir, ignore_errors=True)

print()
print("FAILED:" if failures else "ALL FIRMWARE SIM TESTS PASSED", failures or "")
sys.exit(1 if failures else 0)

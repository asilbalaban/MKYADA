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

    def send_report(self, buf):
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

microcontroller = types.ModuleType("microcontroller")
microcontroller.cpu = types.SimpleNamespace(uid=bytes(range(8)))
sys.modules["microcontroller"] = microcontroller


class FakeNeoPixel(list):
    def __init__(self, pin, n, brightness=1.0, auto_write=True):
        super().__init__([(0, 0, 0)] * n)


neopixel = types.ModuleType("neopixel")
neopixel.NeoPixel = FakeNeoPixel
sys.modules["neopixel"] = neopixel

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
xy = struct.unpack("<BHHb", mouse[0][2]) if mouse else None
check("abs move scaled", xy and abs(xy[1] - 16383) < 40 and abs(xy[2] - 16391) < 60, str(xy))
check("left click down bit", any(r[2][0] & 0x01 for r in mouse))
check("consumer volume_up", any(struct.unpack('<H', r[2])[0] == 0xE9 for r in cons), str(cons))

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

# 4. App logic (import code.py body without running the loop)
with open(os.path.join(FFW, "code.py")) as f:
    src = f.read().replace("App().run()", "")
code_mod = types.ModuleType("fwmain")
exec(compile(src, "code.py", "exec"), code_mod.__dict__)

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
app.proto.send = lambda obj: layer_msgs.append(obj)
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
app.proto.send = lambda obj: outbox.append(obj)
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

# hold_repeat: replays while the physical key stays down
path_hold = macro_file({"hold_repeat": True})
runs = {"n": 0}
def _fake_play(events, **kw):
    runs["n"] += 1
    if runs["n"] >= 3:
        app.buttons.stable[0] = False
app.engine.play = _fake_play
app.buttons.scan = lambda: []
app.buttons.stable[0] = True
app.play_file(path_hold, trigger=0)
check("hold_repeat replays while held", runs["n"] == 3, str(runs))

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
app.proto.send = lambda obj: outbox.append(obj)
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
app.proto.send = lambda obj: outbox.append(obj)
app.handle_msg({"t": "host_leave"})
app.play_file = lambda path, trigger=None, **kw: None  # don't actually play
app.on_edge(1, True)
check("standalone btn streamed when connected",
      any(m.get("t") == "btn" and m.get("edge") == "down" for m in outbox), str(outbox))
del app.play_file
app.proto.send = _orig_send
app.proto.ser = None

# --- serial "led" op (proto v2): app feedback override --------------------
check("hello reports proto v4", app.hello()["proto"] == 4, str(app.hello()["proto"]))
check("hello reports usb_drive", app.hello()["usb_drive"] is True, str(app.hello()))
app.proto.ser = FakeSerial([])
app.handle_msg({"t": "led", "mode": "solid", "rgb": [255, 0, 0]})
check("led solid override set", app.led.override == ("solid", (255, 0, 0)), str(app.led.override))
app.handle_msg({"t": "led", "mode": "blink", "rgb": [0, 0, 255]})
check("led blink override set", app.led.override == ("blink", (0, 0, 255)), str(app.led.override))
app.handle_msg({"t": "led", "mode": "off"})
check("led override cleared by off", app.led.override is None, str(app.led.override))
app.handle_msg({"t": "led", "mode": "solid", "rgb": "garbage"})
check("led garbage rgb tolerated", app.led.override is None, str(app.led.override))
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
    app.proto.send = lambda obj: outbox.append(obj)

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

    # list + delete
    outbox.clear()
    app.handle_msg({"t": "fs_list", "path": fs_rel + "/macros"})
    listed = outbox[-1]
    check("fs_list sees the file",
          listed.get("t") == "fs_list"
          and any(e["name"] == "key1.json" and e["size"] == len(payload) and not e["dir"]
                  for e in listed.get("entries", [])),
          str(listed))
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

# usb_drive config: default on, explicit false survives load_config
_b.open = _cfg_open({"usb_drive": False})
app.load_config()
check("usb_drive false honored", app.config["usb_drive"] is False)
_b.open = _cfg_open({})
app.load_config()
check("usb_drive defaults on", app.config["usb_drive"] is True)
_b.open = _real_open
app.load_config()

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

print()
print("FAILED:" if failures else "ALL FIRMWARE SIM TESTS PASSED", failures or "")
sys.exit(1 if failures else 0)

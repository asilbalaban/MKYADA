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
for i in list(range(6)) + [16]:
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
eng.SLICE = 0.001
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
check("macro path layer a", app.macro_path(0) == "/macros/key1.json")
app.layer = 1
check("macro path layer b", app.macro_path(2) == "/macros/key3-b.json")
app.layer = 0

hello = app.hello()
check("hello uid", hello["uid"] == "0001020304050607")
check("hello mode", hello["mode"] == "standalone")

# layer toggle via on_edge
app.config["layer_key"] = 6
app.config["layer_count"] = 3
app.on_edge(5, True)
check("toggle -> layer b", app.layer == 1)
app.on_edge(5, True)
check("toggle -> layer c", app.layer == 2)
app.on_edge(5, True)
check("toggle wraps -> a", app.layer == 0)

# hold mode
app.config["layer_mode"] = "hold"
app.on_edge(5, True)
check("hold down -> b", app.layer == 1)
app.on_edge(5, False)
check("hold up -> a", app.layer == 0)

# host mode: btn events instead of playback
outbox = []
app.proto.send = lambda obj: outbox.append(obj)
app.handle_msg({"t": "host_enter"})
check("mode host", app.mode == "host")
app.on_edge(1, True)
check("btn streamed", any(m.get("t") == "btn" and m["key"] == 2 for m in outbox), str(outbox))

# play command with missing file -> err not_found
outbox.clear()
app.handle_msg({"t": "play", "file": "macros/nope.json"})
check("err not_found", any(m.get("code") == "not_found" for m in outbox), str(outbox))

print()
print("FAILED:" if failures else "ALL FIRMWARE SIM TESTS PASSED", failures or "")
sys.exit(1 if failures else 0)

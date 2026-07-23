# Macro playback engine: mkyada-macro JSON events -> USB HID reports.
# Port of the proven Raspberry Pi engine (pi/player.py); writes through
# usb_hid.devices instead of /dev/hidg*.

import struct
import time

import usb_hid

from mkyada.hidmap import CONSUMER_USAGE, resolve_key

try:
    from supervisor import ticks_ms
except ImportError:  # desktop simulation
    def ticks_ms():
        return int(time.monotonic() * 1000)

# supervisor.ticks_ms() wraps at 2**29; monotonic-float clocks lose ms
# precision after ~1h uptime, ticks don't.
_TICKS_PERIOD = 1 << 29
_TICKS_HALF = _TICKS_PERIOD // 2


def _ticks_diff(a, b):
    """a - b in ms, correct across the ticks_ms wrap."""
    return ((a - b + _TICKS_HALF) & (_TICKS_PERIOD - 1)) - _TICKS_HALF


def _find_device(usage_page, usage):
    for dev in usb_hid.devices:
        if dev.usage_page == usage_page and dev.usage == usage:
            return dev
    raise RuntimeError("HID device %02x:%02x not found" % (usage_page, usage))


class StopPlayback(Exception):
    pass


class Engine:
    """Owns the three HID interfaces and plays event streams through them."""

    POLL_MS = 20  # how often should_stop()/tick() run during playback

    def __init__(self):
        self.kbd = _find_device(0x01, 0x06)
        self.mouse = _find_device(0x01, 0x02)
        self.consumer = _find_device(0x0C, 0x01)
        self.mods = 0        # modifier byte
        self.keys = []       # pressed usages (max 6)
        self.buttons = 0     # mouse button byte
        self.mx = 16384      # last absolute position (0..32767)
        self.my = 16384
        self.sw = 1919       # screen size - 1 for scaling
        self.sh = 1079
        self._last_poll = ticks_ms()

    def set_screen(self, width, height):
        self.sw = max(1, int(width) - 1)
        self.sh = max(1, int(height) - 1)

    # --- keyboard ---
    def _kbd_report(self):
        ks = (self.keys + [0, 0, 0, 0, 0, 0])[:6]
        self.kbd.send_report(bytes([self.mods & 0xFF, 0] + ks))

    def key_down(self, ev):
        r = resolve_key(ev)
        if not r:
            return
        kind, val = r
        if kind == "mod":
            self.mods |= val
        elif val not in self.keys:
            if len(self.keys) < 6:
                self.keys.append(val)
        self._kbd_report()

    def key_up(self, ev):
        r = resolve_key(ev)
        if not r:
            return
        kind, val = r
        if kind == "mod":
            self.mods &= ~val & 0xFF
        elif val in self.keys:
            self.keys.remove(val)
        self._kbd_report()

    # --- mouse ---
    def _mouse_report(self, wheel=0, pan=0):
        # Report layout matches boot.py ABS_MOUSE_DESCRIPTOR:
        # buttons(1) X(2) Y(2) wheel(1, vertical) pan(1, AC Pan / horizontal).
        # Older firmware built a 6-byte report (no pan); the display models
        # ship this 7-byte one. usb_hid rejects a wrong length, so the
        # descriptor and in_report_lengths in boot.py must stay in lockstep.
        self.mouse.send_report(struct.pack(
            "<BHHbb", self.buttons & 0x07, self.mx & 0x7FFF, self.my & 0x7FFF,
            wheel, pan))

    def move(self, x, y):
        self.mx = max(0, min(32767, int(x * 32767 / self.sw)))
        self.my = max(0, min(32767, int(y * 32767 / self.sh)))
        self._mouse_report()

    def button(self, name, down, x=None, y=None):
        bit = {"left": 0x01, "right": 0x02, "middle": 0x04}.get(name, 0x01)
        if x is not None:
            self.move(x, y)
        if down:
            self.buttons |= bit
        else:
            self.buttons &= ~bit & 0xFF
        self._mouse_report()

    def scroll(self, dy, dx=0):
        """Vertical (dy) and/or horizontal (dx) wheel ticks. Each unit is one
        detent-sized report, sent a few ms apart so hosts register every step
        (a single big report gets coalesced into one notch by some apps)."""
        vstep = 1 if dy > 0 else -1
        for _ in range(min(abs(int(dy)), 10)):
            self._mouse_report(wheel=vstep)
            time.sleep(0.01)
        hstep = 1 if dx > 0 else -1
        for _ in range(min(abs(int(dx)), 10)):
            self._mouse_report(pan=hstep)
            time.sleep(0.01)
        self._mouse_report(0, 0)

    # --- consumer (media keys) ---
    def consumer_tap(self, usage_name):
        usage = CONSUMER_USAGE.get(usage_name)
        if usage is None:
            return
        self.consumer.send_report(struct.pack("<H", usage))
        time.sleep(0.02)
        self.consumer.send_report(struct.pack("<H", 0))

    def release_all(self):
        self.mods = 0
        self.keys = []
        self.buttons = 0
        self._kbd_report()
        self._mouse_report()

    # --- direct combo (serial "keys" command / tiny bindings) ---
    def tap_combo(self, mod_names, key_label, hold_ms=30):
        from mkyada.hidmap import MOD_NAME
        for m in mod_names or ():
            self.mods |= MOD_NAME.get(str(m).lower(), 0)
        self._kbd_report()
        self.key_down({"key": key_label})
        time.sleep(hold_ms / 1000)
        self.key_up({"key": key_label})
        self.mods = 0
        self._kbd_report()

    # --- playback ---
    def _poll(self, should_stop, tick):
        self._last_poll = ticks_ms()
        if should_stop and should_stop():
            raise StopPlayback()
        if tick:
            tick()

    def _wait_until(self, start, due_ms, should_stop, tick):
        """Wait until `due_ms` after `start` (absolute deadline, so per-event
        overhead is absorbed instead of accumulating across the macro)."""
        while True:
            now = ticks_ms()
            if _ticks_diff(now, self._last_poll) >= self.POLL_MS:
                self._poll(should_stop, tick)
                now = ticks_ms()
            remaining = due_ms - _ticks_diff(now, start)
            if remaining <= 0:
                return
            # short slices keep the deadline sharp; host HID polling
            # quantizes to >=1ms anyway, so no busy-spin needed
            time.sleep(0.004 if remaining > 4 else remaining / 1000.0)

    def play(self, events, screen=None, speed=1.0, should_stop=None, tick=None):
        """Play one pass over an iterable of events. Raises StopPlayback on abort."""
        if screen:
            self.set_screen(screen.get("width", 1920), screen.get("height", 1080))
        speed = max(0.01, speed)
        self.release_all()
        start = ticks_ms()
        due = 0.0  # ms since start; float so speed scaling stays exact
        try:
            # poll once per pass so even an all-zero-delay macro (where no
            # wait ever goes stale) still honors stop/restart/switch presses
            self._poll(should_stop, tick)
            for ev in events:
                due += ev.get("delay", 0) / speed
                self._wait_until(start, due, should_stop, tick)
                t = ev.get("type")
                if t == "key":
                    (self.key_down if ev.get("action") == "down" else self.key_up)(ev)
                elif t == "move":
                    self.move(ev.get("x", 0), ev.get("y", 0))
                elif t == "button":
                    self.button(ev.get("button", "left"), ev.get("action") == "down",
                                ev.get("x"), ev.get("y"))
                elif t == "scroll":
                    self.scroll(ev.get("dy", 0), ev.get("dx", 0))
                elif t == "consumer":
                    self.consumer_tap(ev.get("usage", ""))
                # "wait" and unknown types: delay already applied above
        finally:
            self.release_all()

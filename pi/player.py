#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
asil-macro JSON oynatma motoru.
JSON'daki olaylari okuyup Raspberry Pi'nin HID gadget'ina yazar:
  /dev/hidg0 -> klavye (8 byte)
  /dev/hidg1 -> absolute mouse (6 byte)

Kullanim (tek basina test):  sudo python3 player.py <macro.json>
"""
import json, time, struct, sys

HIDG_KBD   = "/dev/hidg0"
HIDG_MOUSE = "/dev/hidg1"

# --- Windows sanal tus kodu (VK) -> USB HID usage ---
VK_TO_HID = {}
for i in range(ord('A'), ord('Z') + 1):          # A-Z -> 0x04..
    VK_TO_HID[i] = 0x04 + (i - ord('A'))
for n in range(1, 10):                            # 1-9 -> 0x1e..
    VK_TO_HID[0x30 + n] = 0x1e + (n - 1)
VK_TO_HID[0x30] = 0x27                            # 0
for f in range(12):                               # F1-F12 -> 0x3a..
    VK_TO_HID[0x70 + f] = 0x3a + f
VK_TO_HID.update({
    0x0D: 0x28, 0x1B: 0x29, 0x08: 0x2a, 0x09: 0x2b, 0x20: 0x2c,   # enter esc bksp tab space
    0x25: 0x50, 0x26: 0x52, 0x27: 0x4f, 0x28: 0x51,               # arrows L U R D
    0x2E: 0x4c, 0x24: 0x4a, 0x23: 0x4d, 0x21: 0x4b, 0x22: 0x4e, 0x2D: 0x49,  # del home end pgup pgdn ins
    0xBA: 0x33, 0xBB: 0x2e, 0xBC: 0x36, 0xBD: 0x2d, 0xBE: 0x37, 0xBF: 0x38,
    0xC0: 0x35, 0xDB: 0x2f, 0xDC: 0x31, 0xDD: 0x30, 0xDE: 0x34,   # noktalama (OEM)
})

# VK -> modifier biti (ctrl/shift/alt/win)
MOD_VK = {
    0x10: 0x02, 0xA0: 0x02, 0xA1: 0x20,   # SHIFT / LSHIFT / RSHIFT
    0x11: 0x01, 0xA2: 0x01, 0xA3: 0x10,   # CTRL  / LCTRL  / RCTRL
    0x12: 0x04, 0xA4: 0x04, 0xA5: 0x40,   # ALT   / LMENU  / RMENU(AltGr)
    0x5B: 0x08, 0x5C: 0x80,               # LWIN / RWIN
}

# isim (pynput) -> HID usage  (vk yoksa yedek)
NAME_TO_HID = {
    "enter": 0x28, "return": 0x28, "esc": 0x29, "escape": 0x29,
    "backspace": 0x2a, "tab": 0x2b, "space": 0x2c, "caps_lock": 0x39,
    "up": 0x52, "down": 0x51, "left": 0x50, "right": 0x4f,
    "delete": 0x4c, "home": 0x4a, "end": 0x4d,
    "page_up": 0x4b, "page_down": 0x4e, "insert": 0x49,
}
for f in range(1, 13):
    NAME_TO_HID[f"f{f}"] = 0x39 + f

# isim -> modifier biti
MOD_NAME = {
    "shift": 0x02, "shift_l": 0x02, "shift_r": 0x20,
    "ctrl": 0x01, "ctrl_l": 0x01, "ctrl_r": 0x10,
    "alt": 0x04, "alt_l": 0x04, "alt_r": 0x40, "alt_gr": 0x40,
    "cmd": 0x08, "cmd_l": 0x08, "cmd_r": 0x80, "win": 0x08,
}

CHAR_TO_HID = {c: 0x04 + i for i, c in enumerate("abcdefghijklmnopqrstuvwxyz")}
CHAR_TO_HID.update({str((d + 1) % 10): 0x1e + d for d in range(10)})  # 1..9,0
CHAR_TO_HID.update({"-": 0x2d, "=": 0x2e, "[": 0x2f, "]": 0x30, "\\": 0x31,
                    ";": 0x33, "'": 0x34, "`": 0x35, ",": 0x36, ".": 0x37, "/": 0x38})


def resolve_key(ev):
    """olay -> ('mod', bit) ya da ('key', usage) ya da None"""
    vk = ev.get("vk")
    label = (ev.get("key") or "").lower()
    if vk in MOD_VK:
        return ("mod", MOD_VK[vk])
    if label in MOD_NAME:
        return ("mod", MOD_NAME[label])
    if vk in VK_TO_HID:
        return ("key", VK_TO_HID[vk])
    if label in NAME_TO_HID:
        return ("key", NAME_TO_HID[label])
    if label in CHAR_TO_HID:
        return ("key", CHAR_TO_HID[label])
    return None


class Player:
    def __init__(self, screen_w=1920, screen_h=1080):
        self.k = open(HIDG_KBD, "rb+", buffering=0)
        self.m = open(HIDG_MOUSE, "rb+", buffering=0)
        self.mods = 0          # modifier byte
        self.keys = []         # basili usage'lar (en fazla 6)
        self.buttons = 0       # mouse buton byte
        self.mx = 16384        # son mutlak konum (0..32767)
        self.my = 16384
        self.sw = max(1, screen_w - 1)
        self.sh = max(1, screen_h - 1)

    # --- klavye ---
    def _kbd_report(self):
        ks = (self.keys + [0, 0, 0, 0, 0, 0])[:6]
        self.k.write(bytes([self.mods & 0xff, 0] + ks))

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
            self.mods &= ~val & 0xff
        elif val in self.keys:
            self.keys.remove(val)
        self._kbd_report()

    # --- mouse ---
    def _mouse_report(self, wheel=0):
        self.m.write(struct.pack("<BHHb", self.buttons & 0x07,
                                 self.mx & 0x7fff, self.my & 0x7fff, wheel))

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
            self.buttons &= ~bit & 0xff
        self._mouse_report()

    def scroll(self, dy):
        step = 1 if dy > 0 else -1
        for _ in range(min(abs(int(dy)), 10)):
            self._mouse_report(wheel=step)
            time.sleep(0.01)
        self._mouse_report(0)

    def release_all(self):
        self.mods = 0; self.keys = []; self.buttons = 0
        self._kbd_report(); self._mouse_report()

    def close(self):
        try: self.release_all()
        finally:
            self.k.close(); self.m.close()


def play(data, speed=1.0):
    """data: asil-macro dict (ya da olay listesi)."""
    if isinstance(data, dict):
        screen = data.get("screen", {})
        events = data.get("events", [])
    else:
        screen, events = {}, data
    p = Player(screen.get("width", 1920), screen.get("height", 1080))
    try:
        p.release_all()
        for ev in events:
            d = ev.get("delay", 0) / 1000.0 / max(0.01, speed)
            if d > 0:
                time.sleep(d)
            t = ev.get("type")
            if t == "key":
                (p.key_down if ev.get("action") == "down" else p.key_up)(ev)
            elif t == "move":
                p.move(ev.get("x", 0), ev.get("y", 0))
            elif t == "button":
                p.button(ev.get("button", "left"), ev.get("action") == "down",
                         ev.get("x"), ev.get("y"))
            elif t == "scroll":
                p.scroll(ev.get("dy", 0))
    finally:
        p.close()


def play_file(path, speed=1.0):
    with open(path, "r", encoding="utf-8") as f:
        play(json.load(f), speed)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("kullanim: sudo python3 player.py <macro.json> [hiz]")
    play_file(sys.argv[1], float(sys.argv[2]) if len(sys.argv) > 2 else 1.0)
    print("oynatma bitti")

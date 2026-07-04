# Key resolution tables: macro JSON events -> USB HID usages.
# Ported unchanged from the Raspberry Pi prototype (pi/player.py), where these
# tables were validated end-to-end against recordings made on Windows.

# Windows virtual-key code (VK) -> USB HID usage
VK_TO_HID = {}
for i in range(ord("A"), ord("Z") + 1):           # A-Z -> 0x04..
    VK_TO_HID[i] = 0x04 + (i - ord("A"))
for n in range(1, 10):                            # 1-9 -> 0x1e..
    VK_TO_HID[0x30 + n] = 0x1E + (n - 1)
VK_TO_HID[0x30] = 0x27                            # 0
for f in range(12):                               # F1-F12 -> 0x3a..
    VK_TO_HID[0x70 + f] = 0x3A + f
VK_TO_HID.update({
    0x0D: 0x28, 0x1B: 0x29, 0x08: 0x2A, 0x09: 0x2B, 0x20: 0x2C,   # enter esc bksp tab space
    0x25: 0x50, 0x26: 0x52, 0x27: 0x4F, 0x28: 0x51,               # arrows L U R D
    0x2E: 0x4C, 0x24: 0x4A, 0x23: 0x4D, 0x21: 0x4B, 0x22: 0x4E, 0x2D: 0x49,  # del home end pgup pgdn ins
    0xBA: 0x33, 0xBB: 0x2E, 0xBC: 0x36, 0xBD: 0x2D, 0xBE: 0x37, 0xBF: 0x38,
    0xC0: 0x35, 0xDB: 0x2F, 0xDC: 0x31, 0xDD: 0x30, 0xDE: 0x34,   # OEM punctuation
})

# VK -> modifier bit (ctrl/shift/alt/win)
MOD_VK = {
    0x10: 0x02, 0xA0: 0x02, 0xA1: 0x20,   # SHIFT / LSHIFT / RSHIFT
    0x11: 0x01, 0xA2: 0x01, 0xA3: 0x10,   # CTRL  / LCTRL  / RCTRL
    0x12: 0x04, 0xA4: 0x04, 0xA5: 0x40,   # ALT   / LMENU  / RMENU(AltGr)
    0x5B: 0x08, 0x5C: 0x80,               # LWIN / RWIN
}

# pynput-style name -> HID usage (fallback when vk is absent)
NAME_TO_HID = {
    "enter": 0x28, "return": 0x28, "esc": 0x29, "escape": 0x29,
    "backspace": 0x2A, "tab": 0x2B, "space": 0x2C, "caps_lock": 0x39,
    "up": 0x52, "down": 0x51, "left": 0x50, "right": 0x4F,
    "delete": 0x4C, "home": 0x4A, "end": 0x4D,
    "page_up": 0x4B, "page_down": 0x4E, "insert": 0x49,
}
for f in range(1, 13):
    NAME_TO_HID["f%d" % f] = 0x39 + f

# name -> modifier bit
MOD_NAME = {
    "shift": 0x02, "shift_l": 0x02, "shift_r": 0x20,
    "ctrl": 0x01, "ctrl_l": 0x01, "ctrl_r": 0x10,
    "alt": 0x04, "alt_l": 0x04, "alt_r": 0x40, "alt_gr": 0x40,
    "cmd": 0x08, "cmd_l": 0x08, "cmd_r": 0x80, "win": 0x08,
}

CHAR_TO_HID = {c: 0x04 + i for i, c in enumerate("abcdefghijklmnopqrstuvwxyz")}
CHAR_TO_HID.update({str((d + 1) % 10): 0x1E + d for d in range(10)})  # 1..9,0
CHAR_TO_HID.update({"-": 0x2D, "=": 0x2E, "[": 0x2F, "]": 0x30, "\\": 0x31,
                    ";": 0x33, "'": 0x34, "`": 0x35, ",": 0x36, ".": 0x37, "/": 0x38})

# Consumer-control usages (media keys) for {"type": "consumer"} events
CONSUMER_USAGE = {
    "play_pause": 0xCD, "next_track": 0xB5, "prev_track": 0xB6, "stop": 0xB7,
    "mute": 0xE2, "volume_up": 0xE9, "volume_down": 0xEA,
    "brightness_up": 0x6F, "brightness_down": 0x70,
}


def resolve_key(ev):
    """Event dict -> ('mod', bit) | ('key', usage) | None."""
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

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Asil Macro Pad - tetikleyici daemon.
Pi'ye takili klavye(ler)i dinler; web arayuzunde atanan kisayol basilinca
ilgili makroyu player ile oynatir. index.json degisince kisayollari yeniden yukler.

Calistir:  sudo python3 triggerd.py
"""
import os, json, time, threading, string, selectors
from evdev import InputDevice, list_devices, ecodes

import player  # ayni klasor

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(BASE, "data")
MACRO_DIR = os.path.join(DATA, "macros")
INDEX = os.path.join(DATA, "index.json")

# --- evdev tus kodu -> normalize isim (web arayuzu ile ayni) ---
EV2NAME = {}
for c in string.ascii_lowercase:
    EV2NAME[getattr(ecodes, f"KEY_{c.upper()}")] = c
for d in range(10):
    EV2NAME[getattr(ecodes, f"KEY_{d}")] = str(d)
for n in range(1, 13):
    EV2NAME[getattr(ecodes, f"KEY_F{n}")] = f"f{n}"
EV2NAME.update({
    ecodes.KEY_ENTER: "enter", ecodes.KEY_ESC: "esc", ecodes.KEY_SPACE: "space",
    ecodes.KEY_TAB: "tab", ecodes.KEY_UP: "up", ecodes.KEY_DOWN: "down",
    ecodes.KEY_LEFT: "left", ecodes.KEY_RIGHT: "right", ecodes.KEY_DELETE: "delete",
    ecodes.KEY_MINUS: "-", ecodes.KEY_EQUAL: "=", ecodes.KEY_GRAVE: "`",
    ecodes.KEY_COMMA: ",", ecodes.KEY_DOT: ".", ecodes.KEY_SLASH: "/",
    ecodes.KEY_SEMICOLON: ";", ecodes.KEY_APOSTROPHE: "'",
    ecodes.KEY_LEFTBRACE: "[", ecodes.KEY_RIGHTBRACE: "]", ecodes.KEY_BACKSLASH: "\\",
})

CTRL  = {ecodes.KEY_LEFTCTRL, ecodes.KEY_RIGHTCTRL}
ALT   = {ecodes.KEY_LEFTALT, ecodes.KEY_RIGHTALT}
SHIFT = {ecodes.KEY_LEFTSHIFT, ecodes.KEY_RIGHTSHIFT}
WIN   = {ecodes.KEY_LEFTMETA, ecodes.KEY_RIGHTMETA}


class Triggers:
    """index.json'dan kisayol -> makro yolu eslemesi (mtime ile otomatik yenilenir)."""
    def __init__(self):
        self.mtime = 0
        self.rules = []   # list of (shortcut_dict, path)
        self.reload()

    def reload(self):
        try:
            m = os.path.getmtime(INDEX)
        except OSError:
            self.rules = []; return
        if m == self.mtime:
            return
        self.mtime = m
        with open(INDEX, encoding="utf-8") as f:
            idx = json.load(f)
        rules = []
        for mac in idx.get("macros", []):
            sc = mac.get("shortcut")
            if sc and sc.get("key"):
                rules.append((sc, os.path.join(MACRO_DIR, mac["id"] + ".json")))
        self.rules = rules
        print(f"[triggerd] {len(rules)} kisayol yuklendi:",
              [f"{shortcut_text(s)}" for s, _ in rules], flush=True)

    def match(self, ctrl, alt, shift, win, key):
        for sc, path in self.rules:
            if (bool(sc.get("ctrl")) == ctrl and bool(sc.get("alt")) == alt and
                    bool(sc.get("shift")) == shift and bool(sc.get("win")) == win and
                    str(sc.get("key")).lower() == key):
                return path
        return None


def shortcut_text(sc):
    p = [n for n, k in (("Ctrl", "ctrl"), ("Alt", "alt"), ("Shift", "shift"), ("Win", "win")) if sc.get(k)]
    p.append(str(sc.get("key", "")).upper())
    return "+".join(p)


busy = threading.Event()


def fire(path):
    if busy.is_set():
        print("[triggerd] zaten oynatiliyor, atlandi", flush=True)
        return
    if not os.path.exists(path):
        print("[triggerd] makro dosyasi yok:", path, flush=True)
        return
    busy.set()
    print("[triggerd] >>> oynatiliyor:", os.path.basename(path), flush=True)

    def run():
        try:
            player.play_file(path)
            print("[triggerd] oynatma bitti", flush=True)
        except Exception as e:
            print("[triggerd] oynatma hatasi:", e, flush=True)
        finally:
            busy.clear()
    threading.Thread(target=run, daemon=True).start()


def keyboard_devices():
    devs = []
    for p in list_devices():
        d = InputDevice(p)
        caps = d.capabilities().get(ecodes.EV_KEY, [])
        if ecodes.KEY_1 in caps and ecodes.KEY_LEFTCTRL in caps:
            devs.append(d)
    return devs


def main():
    triggers = Triggers()
    devs = keyboard_devices()
    if not devs:
        raise SystemExit("Klavye bulunamadi. Pi'ye klavye tak.")
    print("[triggerd] izlenen cihazlar:", [d.name for d in devs], flush=True)
    sel = selectors.DefaultSelector()
    for d in devs:
        d.grab()
        sel.register(d, selectors.EVENT_READ)

    ctrl = alt = shift = win = False
    try:
        while True:
            for sk, _ in sel.select(timeout=1.0):
                for e in sk.fileobj.read():
                    if e.type != ecodes.EV_KEY:
                        continue
                    code, val = e.code, e.value
                    if code in CTRL:   ctrl  = val != 0
                    elif code in ALT:  alt   = val != 0
                    elif code in SHIFT: shift = val != 0
                    elif code in WIN:  win   = val != 0
                    elif val == 1:     # normal tus, basildi
                        name = EV2NAME.get(code)
                        if name:
                            path = triggers.match(ctrl, alt, shift, win, name)
                            if path:
                                fire(path)
            triggers.reload()   # index degistiyse kisayollari yenile
    finally:
        for d in devs:
            try: d.ungrab()
            except Exception: pass


if __name__ == "__main__":
    main()

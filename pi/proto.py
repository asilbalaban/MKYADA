#!/usr/bin/env python3
# Prototip: Pi'den Windows'a HID klavye + mouse testi.
#   proto.py macro  -> makroyu bir kez oynatir (i + mouse salla + i)
#   proto.py watch  -> Pi klavyesinde Ctrl+1 bekler, basilinca makroyu oynatir
import sys, time, struct, selectors
from evdev import InputDevice, list_devices, ecodes

HIDG_KBD   = '/dev/hidg0'
HIDG_MOUSE = '/dev/hidg1'
USAGE_I    = 0x0c   # USB HID usage kodu: 'i'

def kbd_report(mod=0, key=0):
    # [modifiers, reserved, k1..k6]
    return bytes([mod & 0xff, 0, key & 0xff, 0, 0, 0, 0, 0])

def mouse_report(buttons=0, x=0, y=0, wheel=0):
    # buttons(1) + X(2,abs) + Y(2,abs) + wheel(1) = 6 byte
    return struct.pack('<BHHb', buttons & 0x07, x & 0x7fff, y & 0x7fff, wheel)

def tap_i(k):
    k.write(kbd_report(0, USAGE_I)); time.sleep(0.04)
    k.write(kbd_report(0, 0));       time.sleep(0.06)

def wiggle(m):
    # ekran uzerinde gezdir (0..32767 mutlak koordinat)
    for (x, y) in [(8000,8000),(24000,8000),(24000,24000),(8000,24000),(16000,16000)]:
        m.write(mouse_report(0, x, y)); time.sleep(0.2)

def run_macro():
    with open(HIDG_KBD,'rb+',buffering=0) as k, open(HIDG_MOUSE,'rb+',buffering=0) as m:
        print("-> 'i' yaziliyor"); tap_i(k); time.sleep(0.3)
        print("-> mouse sallaniyor"); wiggle(m); time.sleep(0.3)
        print("-> tekrar 'i' yaziliyor"); tap_i(k)
    print("Makro tamam: i + mouse + i")

def keyboard_devices():
    devs = []
    for p in list_devices():
        d = InputDevice(p)
        caps = d.capabilities().get(ecodes.EV_KEY, [])
        if ecodes.KEY_1 in caps and ecodes.KEY_LEFTCTRL in caps:
            devs.append(d)
    return devs

def watch():
    devs = keyboard_devices()
    if not devs:
        print("HATA: Pi'ye klavye takili degil."); sys.exit(1)
    print("Izlenen cihazlar:", [d.name for d in devs])
    sel = selectors.DefaultSelector()
    for d in devs:
        d.grab()  # tuslar Pi'nin kendi konsoluna gitmesin
        sel.register(d, selectors.EVENT_READ)
    ctrl = False
    print("Ctrl+1 bekleniyor (cikis: Ctrl+C)")
    try:
        while True:
            for key, _ in sel.select():
                for e in key.fileobj.read():
                    if e.type == ecodes.EV_KEY:
                        if e.code in (ecodes.KEY_LEFTCTRL, ecodes.KEY_RIGHTCTRL):
                            ctrl = e.value in (1, 2)   # 1=down 2=repeat 0=up
                        elif e.code == ecodes.KEY_1 and e.value == 1 and ctrl:
                            print(">>> Ctrl+1 algilandi -> makro oynatiliyor")
                            run_macro()
    finally:
        for d in devs:
            try: d.ungrab()
            except Exception: pass

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'macro'
    (watch if cmd == 'watch' else run_macro)()

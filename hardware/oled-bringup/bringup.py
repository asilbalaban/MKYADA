#!/usr/bin/env python3
"""MKYADA OLED bring-up - host runner.

Sectigin CircuitPython testini karta (CIRCUITPY diskine code.py olarak) yukler
ve seri ciktisini canli akitir. Ekstra pip paketi gerekmez (stdlib termios).

Kullanim:
    python3 hardware/oled-bringup/bringup.py scan     # I2C tarama (0x3c ara)
    python3 hardware/oled-bringup/bringup.py diag     # canli hat teshisi (SDA/SCL)
    python3 hardware/oled-bringup/bringup.py oled      # ekrana MKYADA + cerceve bas
    python3 hardware/oled-bringup/bringup.py monitor    # sadece seri ciktiyi izle

Cikmak icin: Ctrl-C
"""

import glob
import os
import re
import select
import shutil
import sys
import termios
import time

DEVICE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "device")
DRIVE = "/Volumes/CIRCUITPY"
PORT_GLOB = "/dev/cu.usbmodem*"

TESTS = {
    "scan": "scan.py",
    "diag": "diag.py",
    "oled": "oled.py",
    "inputs": "inputs.py",
    "demo": "demo.py",
}

# ANSI/OSC kacis dizilerini temizle (CircuitPython'in yilan/baslik ciktisi)
_ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")


def bekle(kosul, mesaj, timeout=60):
    """kosul() True olana kadar bekle; olmadiysa None don."""
    t0 = time.monotonic()
    uyarildi = False
    while time.monotonic() - t0 < timeout:
        sonuc = kosul()
        if sonuc:
            return sonuc
        if not uyarildi:
            print(mesaj, flush=True)
            uyarildi = True
        time.sleep(0.4)
    return None


def find_drive():
    return DRIVE if os.path.isdir(DRIVE) else None


def find_port():
    ports = sorted(glob.glob(PORT_GLOB))
    return ports[0] if ports else None


def deploy(test):
    src = os.path.join(DEVICE_DIR, TESTS[test])
    if not os.path.isfile(src):
        sys.exit("Test dosyasi yok: %s" % src)
    drive = bekle(find_drive, ">>> CIRCUITPY diski yok. Karti tak (BOOTSEL degil, normal mod).")
    if not drive:
        sys.exit("CIRCUITPY bulunamadi (timeout). Kart bagli mi?")
    shutil.copyfile(src, os.path.join(drive, "code.py"))
    try:
        os.sync()
    except Exception:
        pass
    print(">>> yuklendi: device/%s -> CIRCUITPY/code.py" % TESTS[test], flush=True)


def open_serial(port):
    fd = os.open(port, os.O_RDONLY | os.O_NOCTTY | os.O_NONBLOCK)
    try:
        attrs = termios.tcgetattr(fd)
        # raw: giris/cikis/yerel islemeyi kapat
        attrs[0] = 0                      # iflag
        attrs[1] = 0                      # oflag
        attrs[3] = 0                      # lflag
        attrs[2] = (attrs[2] & ~termios.CSIZE) | termios.CS8
        attrs[2] |= termios.CREAD | termios.CLOCAL
        attrs[6][termios.VMIN] = 0
        attrs[6][termios.VTIME] = 0
        termios.tcsetattr(fd, termios.TCSANOW, attrs)
    except termios.error:
        pass
    return fd


def monitor(port):
    """Seri portu canli akit. Kart reload olurken kopmayi tolere et."""
    print(">>> seri izleniyor (%s). Cikmak icin Ctrl-C.\n" % port, flush=True)
    buf = b""
    fd = None
    try:
        while True:
            if fd is None:
                p = find_port() or port
                if not (p and os.path.exists(p)):
                    p = bekle(find_port, ">>> seri port yok, kart bekleniyor...")
                    if not p:
                        continue
                try:
                    fd = open_serial(p)
                except OSError:
                    time.sleep(0.5)
                    continue
            r, _, _ = select.select([fd], [], [], 0.5)
            if not r:
                continue
            try:
                data = os.read(fd, 4096)
            except OSError:
                os.close(fd)
                fd = None
                continue
            if not data:
                continue
            buf += data
            buf = _ANSI.sub(b"", buf)
            # tam satirlari yaz, yarim satiri buffer'da tut
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                text = line.replace(b"\r", b"").decode("utf-8", "replace")
                print(text, flush=True)
    except KeyboardInterrupt:
        print("\n>>> durduruldu.", flush=True)
    finally:
        if fd is not None:
            os.close(fd)


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help", "help"):
        print(__doc__)
        return
    cmd = sys.argv[1]
    if cmd == "monitor":
        port = bekle(find_port, ">>> seri port yok. Karti tak.")
        if not port:
            sys.exit("Seri port bulunamadi.")
        monitor(port)
        return
    if cmd not in TESTS:
        sys.exit("Bilinmeyen komut: %s (scan|diag|oled|monitor)" % cmd)
    deploy(cmd)
    port = bekle(find_port, ">>> seri port bekleniyor...")
    if not port:
        sys.exit("Seri port bulunamadi (kart yuklemeden sonra gorunmedi).")
    # kart yuklemeyi isleyip reload etsin
    time.sleep(0.5)
    monitor(port)


if __name__ == "__main__":
    main()

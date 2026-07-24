# MKYADA firmware — bootstrap + rescue console.
#
# This file must stay tiny and must import NOTHING outside the CircuitPython
# builtins until the main firmware (mkyada/app.py) is loaded: it is the last
# line of defense. If the main firmware fails to import or construct — a
# corrupted file after an interrupted update, an out-of-memory compile, a
# broken library — the board does NOT die at the loading screen. It drops
# into the rescue console below: a minimal JSON-lines responder on the data
# CDC channel that speaks enough of the serial protocol (identify, fs_*,
# reset, bootloader) for the desktop app to rewrite every firmware file and
# reboot the board back to life. No BOOT button, no opening the case.
#
# KeyboardInterrupt (Ctrl-C) and supervisor reloads pass through untouched —
# developers keep their REPL.

import gc
import time

MAX_LINE = 16384  # matches mkyada/proto.py's garbage guard


def run_rescue(err):
    """Minimal serial repair console. Builtins only — by the time we are
    here, nothing under /mkyada or /lib can be trusted."""
    import json
    import os
    import microcontroller
    from binascii import a2b_base64, b2a_base64, crc32

    try:
        import supervisor
        supervisor.runtime.autoreload = False  # no reload storms mid-repair
    except Exception:
        pass
    try:
        microcontroller.watchdog.deinit()  # a crashed app may have armed it
    except Exception:
        pass

    err_s = repr(err)[:120]
    print("MKYADA rescue console:", err_s)

    try:
        import usb_cdc
        ser = usb_cdc.data
    except Exception:
        ser = None
    if not ser:
        # No data channel (very old boot.py?) — leave the console/REPL free
        # for a manual or app-driven REPL rescue instead of looping forever.
        print("no usb_cdc.data; rescue console unavailable")
        return

    try:
        ser.write_timeout = 0.2  # a stalled host must never hang the board
    except Exception:
        pass

    led = None
    try:  # best-effort: red blink = alive but in rescue
        import board
        import neopixel
        led = neopixel.NeoPixel(board.GP16, 1, brightness=0.15, auto_write=True)
    except Exception:
        pass

    def fw_version():
        try:
            with open("/VERSION") as f:
                return f.read().strip()
        except OSError:
            return "0.0.0"

    def uid_hex():
        return "".join("%02x" % b for b in microcontroller.cpu.uid)

    def send(obj):
        try:
            ser.write(json.dumps(obj).encode("utf-8") + b"\n")
        except Exception:
            pass

    def send_err(re, code, msg=""):
        send({"t": "err", "re": re, "code": code, "msg": str(msg)})

    def clean_path(msg):
        p = "/" + str(msg.get("path", "")).lstrip("/")
        if ".." in p or p == "/":
            return None
        return p

    def hello():
        # Carries the fields the app's device cards render, with inert
        # defaults — a rescue-mode board must never crash the UI.
        send({"t": "hello", "format": "mkyada", "mode": "rescue",
              "fw": fw_version(), "proto": 7, "uid": uid_hex(),
              "err": err_s, "key_count": 0, "layer_key": None,
              "layer_count": 1, "layer_mode": "toggle", "layer": "a"})

    upload = {}  # path -> {"f", "tmp", "seq", "crc"} (single slot)

    def close_upload(discard=False):
        up = upload.pop("cur", None)
        if not up:
            return
        try:
            up["f"].close()
        except Exception:
            pass
        if discard:
            try:
                os.remove(up["tmp"])
            except OSError:
                pass

    def fs_write(msg):
        path = clean_path(msg)
        if not path:
            return send_err("fs_write", "bad_path", msg.get("path"))
        seq = int(msg.get("seq") or 0)
        if seq == 0:
            close_upload(discard=True)
            parts = path.split("/")[1:-1]
            cur = ""
            for part in parts:
                cur += "/" + part
                try:
                    os.mkdir(cur)
                except OSError:
                    pass
            tmp = path + ".part"
            try:
                f = open(tmp, "wb")
            except OSError as e:
                code = "readonly" if (e.args and e.args[0] == 30) else "io"
                return send_err("fs_write", code, e)
            upload["cur"] = {"path": path, "tmp": tmp, "f": f, "seq": 0,
                             "crc": 0}
        up = upload.get("cur")
        if not up or up["path"] != path or seq != up["seq"]:
            close_upload(discard=True)
            return send_err("fs_write", "bad_seq", seq)
        data = msg.get("data")
        try:
            if data:
                raw = a2b_base64(data)
                up["f"].write(raw)
                up["crc"] = crc32(raw, up["crc"])
                raw = None
        except (OSError, ValueError) as e:
            close_upload(discard=True)
            return send_err("fs_write", "io", e)
        up["seq"] += 1
        if not msg.get("eof"):
            return send({"t": "ok", "re": "fs_write", "seq": seq})
        got = up["crc"] & 0xFFFFFFFF
        want = msg.get("crc")
        if want is not None:
            try:
                want = int(want) & 0xFFFFFFFF
            except (TypeError, ValueError):
                want = None
        if want is not None and want != got:
            close_upload(discard=True)
            return send_err("fs_write", "crc", "crc mismatch")
        upload.pop("cur", None)
        try:
            up["f"].close()
            try:
                os.remove(path)  # FAT rename can't overwrite
            except OSError:
                pass
            os.rename(up["tmp"], path)
        except OSError as e:
            return send_err("fs_write", "io", e)
        send({"t": "ok", "re": "fs_write", "seq": seq, "eof": True,
              "crc": got})

    def fs_read(msg, poll_line):
        path = clean_path(msg)
        if not path:
            return send_err("fs_read", "bad_path", msg.get("path"))
        gc.collect()
        try:
            f = open(path, "rb")
        except OSError as e:
            return send_err("fs_read", "not_found", e)
        seq = 0
        crc = 0
        try:
            while True:
                chunk = f.read(1024)
                eof = len(chunk) < 1024
                crc = crc32(chunk, crc)
                data = b2a_base64(chunk).decode().strip() if chunk else ""
                out = {"t": "fs_chunk", "path": path, "seq": seq,
                       "data": data, "eof": eof}
                if eof:
                    out["crc"] = crc & 0xFFFFFFFF
                send(out)
                chunk = data = None
                gc.collect()
                if eof:
                    break
                # one chunk in flight: wait for the app's fs_ack
                t0 = time.monotonic()
                acked = False
                while time.monotonic() - t0 < 3.0:
                    m = poll_line()
                    if m and m.get("t") == "fs_ack":
                        acked = True
                        break
                    if m and m.get("t") == "ping":
                        send({"t": "pong"})
                    time.sleep(0.002)
                if not acked:
                    break
                seq += 1
        except MemoryError:
            gc.collect()
            send_err("fs_read", "oom", "out of memory")
        finally:
            f.close()
            gc.collect()

    def fs_list(msg):
        path = "/" + str(msg.get("path", "")).strip("/")
        entries = []
        try:
            for name in os.listdir(path):
                try:
                    st = os.stat(path.rstrip("/") + "/" + name)
                except OSError:
                    continue
                entries.append({"name": name, "size": st[6],
                                "dir": bool(st[0] & 0x4000)})
        except OSError as e:
            return send_err("fs_list", "not_found", e)
        send({"t": "fs_list", "path": path, "entries": entries})

    def fs_delete(msg):
        path = clean_path(msg)
        if not path:
            return send_err("fs_delete", "bad_path", msg.get("path"))
        try:
            os.remove(path)
        except OSError as e:
            code = "readonly" if (e.args and e.args[0] == 30) else "not_found"
            return send_err("fs_delete", code, e)
        send({"t": "ok", "re": "fs_delete", "path": path})

    # NOTE: CircuitPython bytearrays don't support `del buf[:i]` — reslice
    # into a fresh bytearray instead (same workaround as mkyada/proto.py).
    state = {"buf": bytearray()}

    def poll_line():
        """Return the next parsed JSON message, or None."""
        buf = state["buf"]
        try:
            n = ser.in_waiting
            if n:
                buf += ser.read(n)
        except Exception:
            return None
        i = buf.find(b"\n")
        if i < 0:
            if len(buf) > MAX_LINE:
                buf = bytearray()
            state["buf"] = buf
            return None
        line = bytes(buf[:i]).strip()
        state["buf"] = buf[i + 1:]
        if not line:
            return None
        try:
            msg = json.loads(line)
        except (ValueError, MemoryError):
            gc.collect()
            return None
        return msg if isinstance(msg, dict) else None

    blink_at = 0.0
    while True:
        now = time.monotonic()
        if led and now >= blink_at:
            try:
                led[0] = (60, 0, 0) if (int(now * 2) % 2) else (0, 0, 0)
            except Exception:
                led = None
            blink_at = now + 0.25
        msg = poll_line()
        if not msg:
            time.sleep(0.01)
            continue
        t = msg.get("t")
        if t == "ping":
            send({"t": "pong"})
        elif t == "identify":
            hello()
        elif t == "fs_write":
            fs_write(msg)
        elif t == "fs_read":
            fs_read(msg, poll_line)
        elif t == "fs_list":
            fs_list(msg)
        elif t == "fs_delete":
            fs_delete(msg)
        elif t == "update_begin":
            close_upload(discard=True)
            send({"t": "ok", "re": "update_begin"})
        elif t in ("update_end", "reset"):
            send({"t": "ok", "re": t})
            time.sleep(0.2)
            microcontroller.reset()
        elif t == "update_abort":
            close_upload(discard=True)
            send({"t": "ok", "re": "update_abort"})
        elif t == "bootloader":
            send({"t": "ok", "re": "bootloader"})
            time.sleep(0.2)
            try:
                microcontroller.on_next_reset(microcontroller.RunMode.UF2)
            except Exception:
                try:
                    microcontroller.on_next_reset(
                        microcontroller.RunMode.BOOTLOADER)
                except Exception:
                    send_err("bootloader", "unsupported")
                    continue
            microcontroller.reset()
        elif t == "stop":
            pass  # nothing plays in rescue mode
        else:
            send_err(t or "?", "rescue", "rescue mode: repair firmware")


try:
    from mkyada.app import main
except MemoryError:
    # one compacted retry before giving up — a fragmented heap can fail the
    # first compile of a large module and pass the second
    gc.collect()
    try:
        from mkyada.app import main
    except Exception as e:
        main = None
        _boot_err = e
except KeyboardInterrupt:
    raise
except Exception as e:
    main = None
    _boot_err = e

if main:
    try:
        main()
    except KeyboardInterrupt:
        raise
    except Exception as e:
        # main() already self-heals via its own error screen + reset; landing
        # here means even that failed — hold the board in the rescue console.
        run_rescue(e)
else:
    run_rescue(_boot_err)

# App <-> device serial protocol transport: JSON-lines over usb_cdc.data.
# One JSON object per newline-terminated line, both directions.
# See docs/serial-protocol.md for the message catalogue.

import gc
import json

import usb_cdc


class Proto:
    # Commands are tiny, but fs_write lines carry ~2.7KB of base64 when the
    # USB drive is hidden and files travel over serial instead.
    MAX_LINE = 16384

    def __init__(self):
        self.ser = usb_cdc.data
        self.buf = bytearray()
        if self.ser:
            try:
                # A host that stops reading (hung app, closed port with data
                # in flight) must never block the keypad: without a timeout,
                # write() can wait forever on a full CDC TX buffer — with the
                # watchdog armed that would hard-reset a healthy board.
                self.ser.write_timeout = 0.2
            except Exception:
                pass

    @property
    def connected(self):
        return bool(self.ser and self.ser.connected)

    def poll(self):
        """Drain the serial buffer; return a list of parsed message dicts."""
        msgs = []
        if not self.ser:
            return msgs
        try:
            n = self.ser.in_waiting
            if n:
                self.buf += self.ser.read(n)
        except Exception:
            return msgs
        while True:
            i = self.buf.find(b"\n")
            if i < 0:
                break
            # CircuitPython bytearrays don't support `del buf[:i]`
            line = bytes(self.buf[:i]).strip()
            self.buf = self.buf[i + 1 :]
            if line:
                try:
                    msg = json.loads(line)
                    if isinstance(msg, dict):
                        msgs.append(msg)
                except ValueError:
                    pass
                except MemoryError:
                    # The heap was too fragmented to parse this line (right
                    # after a connect the display churn leaves little room —
                    # even a tiny fs_read can hit this). Silently dropping it
                    # made the host wait out its full timeout on a request the
                    # keypad never saw ("data transfer failed" at startup), so:
                    # compact and retry, and if it still won't fit, tell the
                    # host which op died so it can retry NOW instead of hanging.
                    gc.collect()
                    try:
                        msg = json.loads(line)
                        if isinstance(msg, dict):
                            msgs.append(msg)
                    except ValueError:
                        pass
                    except MemoryError:
                        gc.collect()
                        for op in (b"fs_read", b"fs_list", b"fs_write",
                                   b"fs_delete"):
                            if op in line:
                                self.send({"t": "err", "re": op.decode(),
                                           "code": "oom",
                                           "msg": "out of memory"})
                                break
        if len(self.buf) > self.MAX_LINE:  # garbage guard
            self.buf = bytearray()
        return msgs

    def send(self, obj):
        """Send one message. Returns True if the line went out — senders that
        MUST deliver (fs replies) check this: a silently dropped reply used to
        strand the host on its full timeout with no clue."""
        if not self.ser:
            return False
        try:
            self.ser.write(json.dumps(obj).encode("utf-8") + b"\n")
            return True
        except MemoryError:
            # Serializing the reply OOM'd (fs_chunk lines are ~KBs) — compact
            # and retry once before reporting failure.
            gc.collect()
            try:
                self.ser.write(json.dumps(obj).encode("utf-8") + b"\n")
                return True
            except Exception:
                return False
        except Exception:
            return False

# App <-> device serial protocol transport: JSON-lines over usb_cdc.data.
# One JSON object per newline-terminated line, both directions.
# See docs/serial-protocol.md for the message catalogue.

import json

import usb_cdc


class Proto:
    MAX_LINE = 1024  # commands are tiny; big data travels via the CIRCUITPY drive

    def __init__(self):
        self.ser = usb_cdc.data
        self.buf = bytearray()

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
        if len(self.buf) > self.MAX_LINE:  # garbage guard
            self.buf = bytearray()
        return msgs

    def send(self, obj):
        if not self.ser:
            return
        try:
            self.ser.write(json.dumps(obj).encode("utf-8") + b"\n")
        except Exception:
            pass

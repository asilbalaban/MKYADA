# MKYADA firmware — USB device setup (runs once at power-on, before code.py)
#
# Presents the RP2040-Zero to the host as:
#   HID keyboard (stock, report ID 1)
#   HID absolute-position mouse (custom, report ID 2) — same report layout as the
#     Raspberry Pi prototype gadget that was proven to work inside games:
#     buttons(1B) + X(16-bit abs 0..32767) + Y(16-bit abs) + wheel(8-bit rel)
#   HID consumer control (stock, report ID 3) — media keys
#   CDC serial: console (debug/REPL) + data (app protocol)
#   Mass storage: CIRCUITPY drive enabled by default; `"usb_drive": false` in
#     config.json hides it (finished-product mode: the app manages all files
#     over serial — see the fs_* commands in docs/serial-protocol.md).
#     Recovery: hold key 1 while plugging in to force the drive back on —
#     GP0 on Core 6; GP29 (macro key 1) on Vision 6, whose GP0 is OLED SDA.
#
# Model comes from config.json "model" only — boot.py never probes hardware
# (must stay fast and dependency-light). An unreadable config falls back to
# core6 defaults, which are safe on both boards: GP0 idles high on Vision 6,
# so the drive simply stays visible, the default for a config-less board.

import json

import board
import digitalio
import storage
import supervisor
import usb_cdc
import usb_hid

try:
    with open("/config.json") as _f:
        _data = json.load(_f)
    CFG = _data if isinstance(_data, dict) else {}
except (OSError, ValueError):
    CFG = {}

VISION6 = CFG.get("model") == "vision6"
RECOVERY_PIN = board.GP29 if VISION6 else board.GP0
PRODUCT = "MKYADA Vision 6" if VISION6 else "MKYADA Keypad"

ABS_MOUSE_DESCRIPTOR = bytes((
    0x05, 0x01,        # Usage Page (Generic Desktop)
    0x09, 0x02,        # Usage (Mouse)
    0xA1, 0x01,        # Collection (Application)
    0x85, 0x02,        #   Report ID (2)
    0x09, 0x01,        #   Usage (Pointer)
    0xA1, 0x00,        #   Collection (Physical)
    0x05, 0x09,        #     Usage Page (Buttons)
    0x19, 0x01,        #     Usage Minimum (1)
    0x29, 0x03,        #     Usage Maximum (3)
    0x15, 0x00,        #     Logical Minimum (0)
    0x25, 0x01,        #     Logical Maximum (1)
    0x95, 0x03,        #     Report Count (3)
    0x75, 0x01,        #     Report Size (1)
    0x81, 0x02,        #     Input (Data, Variable, Absolute)
    0x95, 0x01,        #     Report Count (1)
    0x75, 0x05,        #     Report Size (5)
    0x81, 0x03,        #     Input (Constant) — padding
    0x05, 0x01,        #     Usage Page (Generic Desktop)
    0x09, 0x30,        #     Usage (X)
    0x09, 0x31,        #     Usage (Y)
    0x16, 0x00, 0x00,  #     Logical Minimum (0)
    0x26, 0xFF, 0x7F,  #     Logical Maximum (32767)
    0x75, 0x10,        #     Report Size (16)
    0x95, 0x02,        #     Report Count (2)
    0x81, 0x02,        #     Input (Data, Variable, Absolute)
    0x09, 0x38,        #     Usage (Wheel)
    0x15, 0x81,        #     Logical Minimum (-127)
    0x25, 0x7F,        #     Logical Maximum (127)
    0x75, 0x08,        #     Report Size (8)
    0x95, 0x01,        #     Report Count (1)
    0x81, 0x06,        #     Input (Data, Variable, Relative)
    0xC0,              #   End Collection
    0xC0,              # End Collection
))

abs_mouse = usb_hid.Device(
    report_descriptor=ABS_MOUSE_DESCRIPTOR,
    usage_page=0x01,
    usage=0x02,
    report_ids=(2,),
    in_report_lengths=(6,),
    out_report_lengths=(0,),
)

def usb_drive_wanted():
    """config.json `usb_drive` (default: visible). Holding key 1 (active
    low) during power-on overrides to visible — the escape hatch if the app
    is unavailable while the drive is hidden."""
    try:
        io = digitalio.DigitalInOut(RECOVERY_PIN)
        io.direction = digitalio.Direction.INPUT
        io.pull = digitalio.Pull.UP
        held = not io.value
        io.deinit()
        if held:
            return True
    except Exception:
        pass
    return CFG.get("usb_drive") is not False


supervisor.set_usb_identification(manufacturer="MKYADA", product=PRODUCT)
try:
    # No supervisor scribbles on the Vision 6 OLED or serial titles; the
    # branded boot screen in code.py owns the display from the first frame.
    supervisor.status_bar.console = False
    supervisor.status_bar.display = False
except Exception:
    pass
usb_hid.enable((usb_hid.Device.KEYBOARD, abs_mouse, usb_hid.Device.CONSUMER_CONTROL))
usb_cdc.enable(console=True, data=True)
if not usb_drive_wanted():
    # Finished-product mode: no CIRCUITPY drive on the host. That frees the
    # filesystem for the firmware itself, so the app can manage files over
    # serial (fs_* commands) — including config.json to turn this back off.
    storage.disable_usb_drive()
    storage.remount("/", readonly=False)

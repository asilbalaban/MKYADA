# MKYADA firmware — USB device setup (runs once at power-on, before code.py)
#
# Presents the RP2040-Zero to the host as:
#   HID keyboard (stock, report ID 1)
#   HID absolute-position mouse (custom) — three reports in TWO top-level
#   collections on one interface:
#     collection 1 — report 2 (pointer): buttons(1B) + X(16-bit abs 0..32767)
#       + Y(16-bit abs), and report 4 (scroll): wheel(8-bit rel, vertical) +
#       pan(8-bit rel, AC Pan)
#     collection 2 — report 5 (rel pointer): buttons(1B) + dX(8-bit rel) +
#       dY(8-bit rel) — nudges the cursor from wherever the user has it (Dial
#       drag slots); an absolute report can't do that without knowing the
#       position.
#     Scroll is split from the pointer on purpose: X/Y are absolute, so a
#     wheel tick riding the same report would re-assert the last known
#     position and teleport the cursor (a scroll-only macro used to jump the
#     mouse to screen center). A dedicated scroll report leaves the cursor
#     where the user has it.
#     The rel pointer is in its own COLLECTION on purpose: Windows binds
#     mouhid.sys per top-level Usage(Mouse) collection and cannot handle one
#     that declares X/Y both absolutely and relatively — see the descriptor.
#   HID consumer control (stock, report ID 3) — media keys
#   CDC serial: console (debug/REPL) + data (app protocol)
#   USB MIDI: OFF by default, on with `"midi": true` in config.json. Named
#     after the product string, so a DAW lists it as "MKYADA Vision 6" rather
#     than "CircuitPython usb_midi". Skipped whenever the CIRCUITPY drive is
#     visible: the RP2040 has 7 endpoint pairs and the two together sit on the
#     ceiling, so the drive — the recovery path — wins.
#   Mass storage: CIRCUITPY drive HIDDEN by default (finished-product mode:
#     the app manages all files over serial — see the fs_* commands in
#     docs/serial-protocol.md). Only `"usb_drive": true` in config.json shows
#     it. Recovery: hold key 1 while plugging in to force the drive back on —
#     GP0 on Core 6; GP29 (macro key 1) on Vision 6, whose GP0 is OLED SDA.
#
# Model comes from config.json "model" only — boot.py never probes hardware
# (must stay fast and dependency-light). An unreadable/absent config falls
# back to core6 defaults with the drive hidden — the same finished-product
# default a fresh firmware install gets; hold key 1 at power-on to recover
# the drive (GP0 idles high on Vision 6, so the pull-up read is reliable).

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
    0x85, 0x02,        #   Report ID (2) — pointer
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
    0xC0,              #   End Collection
    0x85, 0x04,        #   Report ID (4) — scroll (no X/Y: cursor stays put)
    0x09, 0x01,        #   Usage (Pointer)
    0xA1, 0x00,        #   Collection (Physical)
    0x09, 0x38,        #     Usage (Wheel) — vertical
    0x15, 0x81,        #     Logical Minimum (-127)
    0x25, 0x7F,        #     Logical Maximum (127)
    0x75, 0x08,        #     Report Size (8)
    0x95, 0x01,        #     Report Count (1)
    0x81, 0x06,        #     Input (Data, Variable, Relative)
    0x05, 0x0C,        #     Usage Page (Consumer)
    0x0A, 0x38, 0x02,  #     Usage (AC Pan) — horizontal scroll
    0x15, 0x81,        #     Logical Minimum (-127)
    0x25, 0x7F,        #     Logical Maximum (127)
    0x75, 0x08,        #     Report Size (8)
    0x95, 0x01,        #     Report Count (1)
    0x81, 0x06,        #     Input (Data, Variable, Relative)
    0xC0,              #   End Collection
    0xC0,              # End Collection — mouse #1 (absolute pointer + wheel)
    # The relative pointer gets its OWN top-level collection. It must not
    # share the one above: Windows binds mouhid.sys per top-level
    # Usage(Mouse) collection and asks the HID parser for that mouse's X/Y
    # once. With report 2 declaring X/Y Absolute (16-bit, 0..32767) and
    # report 5 declaring the same usages Relative (8-bit, -127..127) inside
    # one collection it gets two contradictory answers, fails StartDevice,
    # and the devnode lands in CM_PROB_FAILED_START — taking the absolute
    # pointer and the wheel down with it, because a collection starts or
    # fails as a unit. Split in two, each collection describes one
    # unambiguous mouse and both start. (Field bug: fw 0.28.0-0.30.0 had no
    # working mouse AT ALL on Windows — no macro cursor movement, no Dial
    # zoom/scroll/drag. macOS binds per usage and tolerated it, which is
    # why it shipped.)
    0x05, 0x01,        # Usage Page (Generic Desktop)
    0x09, 0x02,        # Usage (Mouse)
    0xA1, 0x01,        # Collection (Application)
    0x85, 0x05,        #   Report ID (5) — relative pointer (Dial drag)
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
    0x15, 0x81,        #     Logical Minimum (-127)
    0x25, 0x7F,        #     Logical Maximum (127)
    0x75, 0x08,        #     Report Size (8)
    0x95, 0x02,        #     Report Count (2)
    0x81, 0x06,        #     Input (Data, Variable, Relative)
    0xC0,              #   End Collection
    0xC0,              # End Collection — mouse #2 (relative pointer)
))

abs_mouse = usb_hid.Device(
    report_descriptor=ABS_MOUSE_DESCRIPTOR,
    usage_page=0x01,
    usage=0x02,
    report_ids=(2, 4, 5),
    in_report_lengths=(5, 2, 3),  # pointer / scroll / rel pointer (engine.py)
    out_report_lengths=(0, 0, 0),
)

def usb_drive_wanted():
    """config.json `usb_drive` — the drive is shown ONLY when this is
    explicitly true; absent/unreadable config keeps it hidden (the
    finished-product default). Holding key 1 (active low) during power-on
    overrides to visible — the escape hatch if the app is unavailable while
    the drive is hidden."""
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
    return CFG.get("usb_drive") is True


# Auto-reload is a development convenience and a field hazard: a multi-file
# copy onto a visible CIRCUITPY drive reloads the board once per file, so it
# repeatedly runs half-updated trees (observed as a crash-loop brick during
# app-driven updates). The firmware reboots via an explicit {"t":"reset"}
# from the app instead; manual installs end with an unplug/replug anyway.
supervisor.runtime.autoreload = False

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
# USB MIDI, so a key can drive a DAW as well as type. It is LAST and wrapped
# because it is the only interface we can run out of endpoints for: the
# RP2040 has 7 pairs and we already spend 5 (HID 1 + CDC console 2 + CDC data
# 2), 6 with the CIRCUITPY drive. Enabling MIDI on top of a visible drive
# would sit exactly on the ceiling, so it yields to the drive instead — the
# drive is the recovery path and must never lose. If enable() still raises,
# swallowing it costs MIDI and keeps the keyboard and the serial link, which
# is what the app needs to talk the board back out of a bad config.
DRIVE = usb_drive_wanted()  # claims and releases the recovery pin: ask once
if CFG.get("midi") is True and not DRIVE:
    try:
        import usb_midi

        # Windows refuses to enumerate a device whose audio-control interface
        # name is over 31 characters; both product strings are well under.
        # (macOS caches these names — renaming needs an Audio MIDI Setup
        # cache clear before the new one shows up.)
        usb_midi.set_names(streaming_interface_name=PRODUCT,
                           audio_control_interface_name=PRODUCT,
                           in_jack_name=PRODUCT, out_jack_name=PRODUCT)
        usb_midi.enable()
    except Exception:
        pass
else:
    # Off by default: an unused MIDI port on every keypad is a confusing
    # extra device in every DAW's input list, and it costs an endpoint.
    try:
        import usb_midi

        usb_midi.disable()
    except Exception:
        pass
if not DRIVE:
    # Finished-product mode: no CIRCUITPY drive on the host. That frees the
    # filesystem for the firmware itself, so the app can manage files over
    # serial (fs_* commands) — including config.json to turn this back off.
    storage.disable_usb_drive()
    storage.remount("/", readonly=False)

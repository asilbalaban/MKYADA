# Model table: one firmware serves every MKYADA hardware variant.
#
# Pins are stored as board attribute NAMES (strings) and resolved with
# getattr(board, name) at runtime, so host-side tests can stub `board`
# without owning real pin objects.
#
#   core6    the screenless keypad: keys soldered GP0..GP(n-1) in perimeter
#            order, layer switching via a dedicated layer key.
#   vision6  the OLED model: SH1106 128x64 on I2C plus an EC11 encoder and
#            BACK/CONFIRM buttons occupy GP0-GP6, so the six macro keys sit
#            on the opposite edge and layers are picked on the screen.

import board

MODELS = {
    "core6": {
        "pin_order": (
            "GP0", "GP1", "GP2", "GP3", "GP4", "GP5", "GP6", "GP7",
            "GP8", "GP9", "GP10", "GP11", "GP12", "GP13", "GP14", "GP15",
            "GP26", "GP27", "GP28", "GP29",
        ),
        "layer_via": "key",     # dedicated layer key cycles A -> B -> ...
        "display": None,
        "encoder": None,
        "nav": None,
        "recovery_pin": "GP0",  # hold at power-on to force the USB drive back
        "max_keys": 20,
        "min_layers": 2,
        "reserved": ("GP16",),  # onboard WS2812
        "usb_product": "MKYADA Keypad",
    },
    "vision6": {
        "pin_order": ("GP29", "GP28", "GP27", "GP26", "GP15", "GP14"),
        "layer_via": "ui",      # encoder menu picks the layer; no layer key
        "display": {"sda": "GP0", "scl": "GP1", "addr": 0x3C,
                    "width": 128, "height": 64, "colstart": 2},
        "encoder": ("GP2", "GP3"),
        "nav": ("GP4", "GP5", "GP6"),  # PSH, BACK, CONFIRM
        "recovery_pin": "GP29",  # macro key 1 (GP0 belongs to the OLED)
        "max_keys": 6,
        "min_layers": 1,
        # display + encoder + nav + LED: never available as key pins
        "reserved": ("GP0", "GP1", "GP2", "GP3", "GP4", "GP5", "GP6", "GP16"),
        "usb_product": "MKYADA Vision 6",
    },
}

DEFAULT_MODEL = "core6"

# Encoder / module-button virtual slots (vision6): each may carry a macro
# file just like a key, named macros/<slot>.json (+ "-<layer>" suffix).
# When a layer assigns enc-cw/enc-ccw, rotating on the resting grid plays
# them instead of moving the selection; btn-back/btn-confirm likewise.
UI_SLOTS = ("enc-cw", "enc-ccw", "btn-back", "btn-confirm")


def resolve_pins(names):
    return tuple(getattr(board, n) for n in names)


def probe_display():
    """One-shot I2C probe for the Vision 6 OLED at 0x3C. Used only when
    config.json carries no "model" (a freshly soldered board). On a Core 6
    the same pins are key switches to GND with no pull-ups, so busio either
    refuses the bus or the scan comes back empty — both mean "core6"."""
    i2c = None
    try:
        import busio
        i2c = busio.I2C(scl=board.GP1, sda=board.GP0)
        while not i2c.try_lock():
            pass
        try:
            return 0x3C in i2c.scan()
        finally:
            i2c.unlock()
    except Exception:
        return False
    finally:
        if i2c is not None:
            try:
                i2c.deinit()
            except Exception:
                pass


def resolve_model(cfg_value):
    """Model from config.json if valid, else hardware probe, else core6."""
    if cfg_value in MODELS:
        return cfg_value
    return "vision6" if probe_display() else DEFAULT_MODEL


def validate_key_pins(pins, key_count, model):
    """A config "pins" list overrides the model's default solder order —
    the escape hatch for a key soldered to an unexpected GPIO. Returns the
    validated list of names, or None to use the model default."""
    m = MODELS[model]
    if not isinstance(pins, (list, tuple)) or len(pins) != key_count:
        return None
    seen = []
    for name in pins:
        if (not isinstance(name, str) or name in m["reserved"]
                or name in seen or not hasattr(board, name)):
            return None
        seen.append(name)
    return list(pins)


def detect_candidates(model):
    """GPIO names worth watching in pin-detect mode: every edge pin the
    model doesn't reserve for itself."""
    all_pins = MODELS["core6"]["pin_order"]  # the full RP2040-Zero edge
    reserved = MODELS[model]["reserved"]
    return tuple(n for n in all_pins if n not in reserved)

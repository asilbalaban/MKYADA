# Status LED on the RP2040-Zero's onboard WS2812 (GP16).
#
#   idle        layer color, dim solid (A green / B blue / C purple / D teal)
#   playing     amber fast blink; looping macro -> slow amber blink
#   host mode   layer color breathing toward white
#   error       red triple-blink overlay, then back to current state

import time

import board

try:
    import neopixel
except ImportError:
    neopixel = None  # lib missing: run without a status LED

LAYER_COLORS = ((0, 255, 0), (0, 80, 255), (170, 0, 255), (0, 255, 180))
AMBER = (255, 120, 0)
RED = (255, 0, 0)

IDLE, PLAYING, LOOPING, HOST = 0, 1, 2, 3


class Led:
    def __init__(self):
        try:
            self.px = neopixel.NeoPixel(board.GP16, 1, brightness=0.15, auto_write=True) if neopixel else None
        except Exception:
            self.px = None
        self.state = IDLE
        self.layer = 0
        self.error_until = 0
        self._apply()

    def _color(self):
        return LAYER_COLORS[self.layer % len(LAYER_COLORS)]

    def _apply(self, color=None):
        if self.px:
            try:
                self.px[0] = color or self._color()
            except Exception:
                pass

    def set(self, state=None, layer=None):
        if state is not None:
            self.state = state
        if layer is not None:
            self.layer = layer
        self._apply(AMBER if self.state in (PLAYING, LOOPING) else None)

    def error(self):
        self.error_until = time.monotonic() + 1.2

    def tick(self):
        """Animate; call every main-loop iteration."""
        if not self.px:
            return
        now = time.monotonic()
        if now < self.error_until:                       # red triple-blink overlay
            self._apply(RED if int(now * 5) % 2 == 0 else (0, 0, 0))
            return
        if self.state == LOOPING:                        # slow amber blink
            self._apply(AMBER if int(now * 2) % 2 == 0 else (0, 0, 0))
        elif self.state == PLAYING:                      # fast amber blink
            self._apply(AMBER if int(now * 4) % 2 == 0 else (0, 0, 0))
        elif self.state == HOST:                         # breathe layer color -> white
            phase = (now % 2.0) / 2.0
            level = phase * 2 if phase < 0.5 else (1 - phase) * 2
            r, g, b = self._color()
            self._apply((int(r + (255 - r) * level * 0.6),
                         int(g + (255 - g) * level * 0.6),
                         int(b + (255 - b) * level * 0.6)))
        else:
            self._apply()

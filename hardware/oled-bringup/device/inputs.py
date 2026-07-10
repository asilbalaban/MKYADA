# MKYADA bring-up - encoder + buton + nvm testi
# Encoder: TRA->GP2, TRB->GP3 | PSH->GP4, BACK->GP5, CONFIRM->GP6
# Tekeri cevir / butonlara bas -> seri ciktida gorunmeli.

import time
import board
import rotaryio
import keypad

# NVM (kalici ayar hafizasi) var mi?
try:
    import microcontroller
    nvm = microcontroller.nvm
    print("NVM:", ("VAR, %d byte" % len(nvm)) if nvm is not None else "YOK")
except Exception as e:
    print("NVM kontrol hatasi:", e)

enc = rotaryio.IncrementalEncoder(board.GP2, board.GP3)
keys = keypad.Keys(
    (board.GP4, board.GP5, board.GP6),
    value_when_pressed=False,   # bosta HIGH, basinca GND'ye ceker
    pull=True,                  # ic pull-up
)
ISIM = {0: "PSH(enc)", 1: "BACK", 2: "CONFIRM"}

print("=== Input testi: tekeri cevir + butonlara bas (Ctrl-C ile cik) ===")
son = enc.position
while True:
    p = enc.position
    if p != son:
        print("ENCODER:", p, "yon:", "sag" if p > son else "sol")
        son = p
    ev = keys.events.get()
    if ev:
        print("BUTON:", ISIM.get(ev.key_number), "->",
              "BASILDI" if ev.pressed else "birakildi")
    time.sleep(0.005)

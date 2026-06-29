#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Asil Macro Recorder
-------------------
Windows'ta global klavye + mouse hareketlerini kaydeder, duzenlemeni saglar
ve "asil-macro" JSON formatinda disa aktarir. Bu JSON, Raspberry Pi web
arayuzune yuklenip bir kisayola atanir; Pi onu USB HID ile tekrar oynatir.

Calistirma:  python macro_recorder.py
Bagimlilik:  pip install pynput     (tkinter Python ile gelir)

Kayit:  F9 = kayit baslat/durdur (toggle).  Boylece arayuze tiklamadan
        kayda baslayip bitirebilirsin; F9'un kendisi kayda dahil edilmez.
"""

import json
import time
import tkinter as tk
from tkinter import ttk, filedialog, messagebox

try:
    from pynput import keyboard, mouse
except ImportError:
    raise SystemExit("Once 'pynput' kurulmali:  pip install pynput")

# Mouse hareketlerini en fazla bu sıklıkta ornekle (ms) -> tabloyu bogmasin
MOVE_SAMPLE_MS = 20
# Kaydi baslat/durdur kisayolu
TOGGLE_KEY = keyboard.Key.f9


# ----------------------------------------------------------------------------
# pynput tus -> kanonik isim/vk
# ----------------------------------------------------------------------------
def key_to_fields(key):
    """pynput key -> (label, vk).  label gosterim/oynatma icin, vk Windows
    sanal tus kodu (en guvenilir eslesme)."""
    if isinstance(key, keyboard.KeyCode):
        vk = key.vk
        label = key.char if key.char is not None else (f"vk_{vk}" if vk else "?")
        return label, vk
    else:  # ozel tus (Key enum): space, enter, ctrl_l, shift, f1, esc ...
        vk = getattr(key, "value", None)
        vk = getattr(vk, "vk", None)
        return key.name, vk


# ----------------------------------------------------------------------------
# Kayit motoru (pynput dinleyicileri ayri thread'lerde calisir)
# ----------------------------------------------------------------------------
class Recorder:
    def __init__(self):
        self.events = []          # kaydedilen olaylar (kanonik dict)
        self.recording = False
        self._last_t = None       # son olay zamani (perf_counter)
        self._last_move_t = 0.0    # son ornekleme zamani
        self._kbd = None
        self._mouse = None
        self.just_stopped = False  # UI thread'i bilgilendirmek icin bayrak

    # -- yardimcilar --
    def _stamp(self):
        """Bir onceki olaydan bu yana gecen ms (delay) dondur, saati guncelle."""
        now = time.perf_counter()
        if self._last_t is None:
            d = 0
        else:
            d = int(round((now - self._last_t) * 1000))
        self._last_t = now
        return max(0, d)

    def _add(self, ev):
        ev["delay"] = self._stamp()
        # delay'i olayin basina koymak icin yeniden sirala
        ev = {"delay": ev.pop("delay"), **ev}
        self.events.append(ev)

    # -- klavye --
    def _on_press(self, key):
        if key == TOGGLE_KEY:
            self.toggle()
            return
        if not self.recording:
            return
        label, vk = key_to_fields(key)
        self._add({"type": "key", "action": "down", "key": label, "vk": vk})

    def _on_release(self, key):
        if key == TOGGLE_KEY or not self.recording:
            return
        label, vk = key_to_fields(key)
        self._add({"type": "key", "action": "up", "key": label, "vk": vk})

    # -- mouse --
    def _on_move(self, x, y):
        if not self.recording:
            return
        now = time.perf_counter()
        if (now - self._last_move_t) * 1000 < MOVE_SAMPLE_MS:
            return
        self._last_move_t = now
        self._add({"type": "move", "x": int(x), "y": int(y)})

    def _on_click(self, x, y, button, pressed):
        if not self.recording:
            return
        self._add({"type": "button", "action": "down" if pressed else "up",
                   "button": button.name, "x": int(x), "y": int(y)})

    def _on_scroll(self, x, y, dx, dy):
        if not self.recording:
            return
        self._add({"type": "scroll", "dx": int(dx), "dy": int(dy),
                   "x": int(x), "y": int(y)})

    # -- kontrol --
    def start_listeners(self):
        self._kbd = keyboard.Listener(on_press=self._on_press,
                                      on_release=self._on_release)
        self._mouse = mouse.Listener(on_move=self._on_move,
                                     on_click=self._on_click,
                                     on_scroll=self._on_scroll)
        self._kbd.start()
        self._mouse.start()

    def toggle(self):
        if not self.recording:
            self.events = []
            self._last_t = None
            self._last_move_t = 0.0
            self.recording = True
        else:
            self.recording = False
            self.just_stopped = True


# ----------------------------------------------------------------------------
# Olay -> insan okunur kisa metin (tabloda gosterim)
# ----------------------------------------------------------------------------
def describe(ev):
    t = ev.get("type")
    if t == "key":
        return f"{'BAS' if ev['action']=='down' else 'BIRAK'}  '{ev.get('key')}'"
    if t == "move":
        return f"-> ({ev.get('x')}, {ev.get('y')})"
    if t == "button":
        return f"{'TIK-BAS' if ev['action']=='down' else 'TIK-BIRAK'}  {ev.get('button')}  ({ev.get('x')},{ev.get('y')})"
    if t == "scroll":
        return f"tekerlek dx={ev.get('dx')} dy={ev.get('dy')}"
    return str(ev)


# ----------------------------------------------------------------------------
# Duzenleme penceresi (olay tipine gore alanlar)
# ----------------------------------------------------------------------------
FIELDS = {
    "key":    [("action", "Aksiyon (down/up)"), ("key", "Tus"), ("vk", "vk (sayi)")],
    "move":   [("x", "X"), ("y", "Y")],
    "button": [("action", "Aksiyon (down/up)"), ("button", "Buton (left/right/middle)"),
               ("x", "X"), ("y", "Y")],
    "scroll": [("dx", "dx"), ("dy", "dy"), ("x", "X"), ("y", "Y")],
}


class EditDialog(tk.Toplevel):
    def __init__(self, master, ev):
        super().__init__(master)
        self.title("Adimi duzenle")
        self.result = None
        self.transient(master)
        self.grab_set()
        self.vars = {}

        row = 0
        ttk.Label(self, text="Gecikme (ms):").grid(row=row, column=0, sticky="e", padx=6, pady=4)
        self.delay_var = tk.StringVar(value=str(ev.get("delay", 0)))
        ttk.Entry(self, textvariable=self.delay_var, width=14).grid(row=row, column=1, padx=6, pady=4)
        row += 1

        for field, label in FIELDS.get(ev.get("type"), []):
            ttk.Label(self, text=label + ":").grid(row=row, column=0, sticky="e", padx=6, pady=4)
            v = tk.StringVar(value="" if ev.get(field) is None else str(ev.get(field)))
            ttk.Entry(self, textvariable=v, width=14).grid(row=row, column=1, padx=6, pady=4)
            self.vars[field] = v
            row += 1

        btns = ttk.Frame(self)
        btns.grid(row=row, column=0, columnspan=2, pady=8)
        ttk.Button(btns, text="Tamam", command=self._ok).pack(side="left", padx=4)
        ttk.Button(btns, text="Iptal", command=self.destroy).pack(side="left", padx=4)
        self._ev = dict(ev)

    def _ok(self):
        ev = self._ev
        try:
            ev["delay"] = max(0, int(float(self.delay_var.get())))
        except ValueError:
            messagebox.showerror("Hata", "Gecikme sayi olmali")
            return
        for field, v in self.vars.items():
            val = v.get().strip()
            if field in ("x", "y", "dx", "dy", "vk"):
                ev[field] = int(val) if val not in ("", "None") else None
            else:
                ev[field] = val
        self.result = ev
        self.destroy()


# ----------------------------------------------------------------------------
# Ana uygulama
# ----------------------------------------------------------------------------
class App:
    def __init__(self, root):
        self.root = root
        self.rec = Recorder()
        self.events = []   # duzenlenebilir calisma kopyasi
        root.title("Asil Macro Recorder")
        root.geometry("760x520")

        # ust bar
        top = ttk.Frame(root); top.pack(fill="x", padx=8, pady=6)
        ttk.Label(top, text="Makro adi:").pack(side="left")
        self.name_var = tk.StringVar(value="Makro 1")
        ttk.Entry(top, textvariable=self.name_var, width=22).pack(side="left", padx=(4, 12))
        self.rec_btn = ttk.Button(top, text="● Kayit (F9)", command=self.rec.toggle)
        self.rec_btn.pack(side="left")
        ttk.Button(top, text="Ac (JSON)", command=self.load_json).pack(side="right")
        ttk.Button(top, text="Kaydet (JSON)", command=self.save_json).pack(side="right", padx=4)

        # tablo
        cols = ("no", "delay", "type", "detail")
        self.tree = ttk.Treeview(root, columns=cols, show="headings", selectmode="extended")
        for c, t, w in [("no", "#", 50), ("delay", "Gecikme(ms)", 110),
                        ("type", "Tur", 90), ("detail", "Detay", 460)]:
            self.tree.heading(c, text=t)
            self.tree.column(c, width=w, anchor="w")
        self.tree.pack(fill="both", expand=True, padx=8, pady=4)
        self.tree.bind("<Double-1>", lambda e: self.edit_selected())

        # alt bar
        bot = ttk.Frame(root); bot.pack(fill="x", padx=8, pady=6)
        for txt, cmd in [("Duzenle", self.edit_selected), ("Sil", self.delete_selected),
                         ("Yukari", lambda: self.move(-1)), ("Asagi", lambda: self.move(1))]:
            ttk.Button(bot, text=txt, command=cmd).pack(side="left", padx=3)
        self.status = ttk.Label(bot, text="Hazir. F9 ile kayda basla.")
        self.status.pack(side="right")

        self.rec.start_listeners()
        self._tick()

    # ---- periyodik UI guncelleme (listener thread'lerinden guvenli) ----
    def _tick(self):
        if self.rec.recording:
            self.status.config(text=f"● KAYIT...  {len(self.rec.events)} olay   (durdur: F9)")
            self.rec_btn.config(text="■ Durdur (F9)")
        else:
            self.rec_btn.config(text="● Kayit (F9)")
        if self.rec.just_stopped:
            self.rec.just_stopped = False
            self.events = list(self.rec.events)
            self._strip_trailing_toggle()
            self.refresh()
            self.status.config(text=f"Kayit bitti: {len(self.events)} olay.")
        self.root.after(120, self._tick)

    def _strip_trailing_toggle(self):
        # guvenlik: F9 zaten kaydedilmiyor; yine de bos kuyrugu temizle
        while self.events and self.events[-1].get("type") == "key" and \
                self.events[-1].get("key") == "f9":
            self.events.pop()

    # ---- tablo ----
    def refresh(self):
        self.tree.delete(*self.tree.get_children())
        for i, ev in enumerate(self.events):
            self.tree.insert("", "end", iid=str(i),
                             values=(i + 1, ev.get("delay", 0), ev.get("type"), describe(ev)))

    def _selected_indices(self):
        return sorted(int(i) for i in self.tree.selection())

    def edit_selected(self):
        idx = self._selected_indices()
        if not idx:
            return
        i = idx[0]
        dlg = EditDialog(self.root, self.events[i])
        self.root.wait_window(dlg)
        if dlg.result is not None:
            self.events[i] = dlg.result
            self.refresh()
            self.tree.selection_set(str(i))

    def delete_selected(self):
        idx = self._selected_indices()
        for i in reversed(idx):
            del self.events[i]
        self.refresh()

    def move(self, direction):
        idx = self._selected_indices()
        if not idx:
            return
        i = idx[0]
        j = i + direction
        if 0 <= j < len(self.events):
            self.events[i], self.events[j] = self.events[j], self.events[i]
            self.refresh()
            self.tree.selection_set(str(j))

    # ---- JSON ----
    def save_json(self):
        path = filedialog.asksaveasfilename(defaultextension=".json",
                                            filetypes=[("JSON", "*.json")],
                                            initialfile=f"{self.name_var.get()}.json")
        if not path:
            return
        data = {
            "format": "asil-macro",
            "version": 1,
            "name": self.name_var.get(),
            "screen": {"width": self.root.winfo_screenwidth(),
                       "height": self.root.winfo_screenheight()},
            "events": self.events,
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        self.status.config(text=f"Kaydedildi: {path}")

    def load_json(self):
        path = filedialog.askopenfilename(filetypes=[("JSON", "*.json")])
        if not path:
            return
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if data.get("format") != "asil-macro":
            messagebox.showwarning("Uyari", "Bu dosya asil-macro formatinda gorunmuyor.")
        self.name_var.set(data.get("name", "Makro"))
        self.events = data.get("events", [])
        self.refresh()
        self.status.config(text=f"Yuklendi: {path}  ({len(self.events)} olay)")


def main():
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Asil Macro Recorder v2
----------------------
Windows'ta global klavye + mouse hareketlerini kaydeder, GELISMIS sekilde
duzenlemeni saglar ve "asil-macro" JSON formatinda disa aktarir.

Yenilikler (v2):
  - Ardisik mouse hareketleri TEK satirda gruplanir (baslangic -> bitis, nokta
    sayisi, toplam sure).
  - Grup suresini tek hamlede degistir (orn. 3000ms -> 300ms); alttaki noktalarin
    zamanlamasi orantili olceklenir. Istege bagli "duz cizgi" sadelestirme.
  - Bir satirin uzerine gelince, ekran haritasinda o koordinat gosterilir
    (tiklama = nokta, hareket = ok).

Kayit:  F9 = baslat/durdur (toggle).
Bagimlilik:  pip install pynput   (tkinter Python ile gelir)
"""

import json, time
import tkinter as tk
from tkinter import ttk, filedialog, messagebox

try:
    from pynput import keyboard, mouse
except ImportError:
    raise SystemExit("Once 'pynput' kurulmali:  pip install pynput")

MOVE_SAMPLE_MS = 15          # mouse hareketi ornekleme sikligi
TOGGLE_KEY = keyboard.Key.f9


# ---------------------------------------------------------------- tus eslemeleri
def key_to_fields(key):
    if isinstance(key, keyboard.KeyCode):
        vk = key.vk
        label = key.char if key.char is not None else (f"vk_{vk}" if vk else "?")
        return label, vk
    vk = getattr(getattr(key, "value", None), "vk", None)
    return key.name, vk


# ---------------------------------------------------------------- kayit motoru
class Recorder:
    def __init__(self):
        self.events = []
        self.recording = False
        self._last_t = None
        self._last_move_t = 0.0
        self.just_stopped = False

    def _stamp(self):
        now = time.perf_counter()
        d = 0 if self._last_t is None else int(round((now - self._last_t) * 1000))
        self._last_t = now
        return max(0, d)

    def _add(self, ev):
        d = self._stamp()
        self.events.append({"delay": d, **ev})

    def _on_press(self, key):
        if key == TOGGLE_KEY:
            self.toggle(); return
        if not self.recording: return
        label, vk = key_to_fields(key)
        self._add({"type": "key", "action": "down", "key": label, "vk": vk})

    def _on_release(self, key):
        if key == TOGGLE_KEY or not self.recording: return
        label, vk = key_to_fields(key)
        self._add({"type": "key", "action": "up", "key": label, "vk": vk})

    def _on_move(self, x, y):
        if not self.recording: return
        now = time.perf_counter()
        if (now - self._last_move_t) * 1000 < MOVE_SAMPLE_MS: return
        self._last_move_t = now
        self._add({"type": "move", "x": int(x), "y": int(y)})

    def _on_click(self, x, y, button, pressed):
        if not self.recording: return
        self._add({"type": "button", "action": "down" if pressed else "up",
                   "button": button.name, "x": int(x), "y": int(y)})

    def _on_scroll(self, x, y, dx, dy):
        if not self.recording: return
        self._add({"type": "scroll", "dx": int(dx), "dy": int(dy), "x": int(x), "y": int(y)})

    def start_listeners(self):
        keyboard.Listener(on_press=self._on_press, on_release=self._on_release).start()
        mouse.Listener(on_move=self._on_move, on_click=self._on_click,
                       on_scroll=self._on_scroll).start()

    def toggle(self):
        if not self.recording:
            self.events = []; self._last_t = None; self._last_move_t = 0.0
            self.recording = True
        else:
            self.recording = False; self.just_stopped = True


# ---------------------------------------------------------- gruplama / duzlestirme
def group_events(events):
    """Duz olay listesi -> 'item' listesi (ardisik move'lar movegroup olur)."""
    items, i, n = [], 0, len(events)
    while i < n:
        if events[i].get("type") == "move":
            j, pts = i, []
            lead = events[i].get("delay", 0)
            while j < n and events[j].get("type") == "move":
                e = events[j]
                pts.append({"x": e.get("x", 0), "y": e.get("y", 0),
                            "dt": 0 if j == i else e.get("delay", 0)})
                j += 1
            items.append({"type": "movegroup", "delay": lead, "points": pts})
            i = j
        else:
            items.append(dict(events[i])); i += 1
    return items


def flatten_items(items):
    out = []
    for it in items:
        if it.get("type") == "movegroup":
            for k, p in enumerate(it["points"]):
                out.append({"delay": it["delay"] if k == 0 else p["dt"],
                            "type": "move", "x": p["x"], "y": p["y"]})
        else:
            out.append(dict(it))
    return out


def group_duration(g):
    return sum(p["dt"] for p in g["points"])


def set_group_duration(g, new_ms):
    pts = g["points"]
    old = group_duration(g)
    if len(pts) <= 1:
        return
    if old <= 0:
        each = new_ms / (len(pts) - 1)
        for k, p in enumerate(pts):
            p["dt"] = 0 if k == 0 else int(round(each))
    else:
        f = new_ms / old
        for k, p in enumerate(pts):
            if k > 0:
                p["dt"] = max(0, int(round(p["dt"] * f)))


def straighten(g):
    """Sadece baslangic ve bitis noktasini birak (duz/ani hareket)."""
    if len(g["points"]) >= 2:
        dur = group_duration(g)
        g["points"] = [g["points"][0], {**g["points"][-1], "dt": dur}]


# ---------------------------------------------------------------- gosterim
def describe(it):
    t = it.get("type")
    if t == "movegroup":
        p0, p1 = it["points"][0], it["points"][-1]
        return f"➜ ({p0['x']},{p0['y']}) → ({p1['x']},{p1['y']})   •   {len(it['points'])} nokta"
    if t == "key":
        return f"{'BAS' if it['action']=='down' else 'BIRAK'}  '{it.get('key')}'"
    if t == "button":
        a = "TIK-BAS" if it["action"] == "down" else "TIK-BIRAK"
        return f"{a}  {it.get('button')}  ({it.get('x')},{it.get('y')})"
    if t == "scroll":
        return f"tekerlek dy={it.get('dy')}"
    return str(it)


def row_type_label(it):
    return {"movegroup": "🖱 Hareket", "key": "⌨ Tus",
            "button": "🖱 Tik", "scroll": "🖲 Tekerlek"}.get(it.get("type"), it.get("type"))


def row_delay(it):
    return it.get("delay", 0)


def row_dur(it):
    return group_duration(it) if it.get("type") == "movegroup" else "-"


# ---------------------------------------------------------------- ekran onizleme
class ScreenPreview(tk.Canvas):
    W = 360

    def __init__(self, master):
        super().__init__(master, width=self.W, height=self.W * 9 // 16,
                         bg="#0f1115", highlightthickness=1, highlightbackground="#444")
        self.screen = (1920, 1080)

    def set_screen(self, w, h):
        self.screen = (max(1, w), max(1, h))
        self.config(height=int(self.W * self.screen[1] / self.screen[0]))

    def _sx(self, x): return x * self.W / self.screen[0]
    def _sy(self, y): return y * (self.winfo_reqheight()) / self.screen[1]

    def show(self, it):
        self.delete("all")
        self.create_rectangle(1, 1, self.W - 1, self.winfo_reqheight() - 1, outline="#333")
        if it is None:
            return
        t = it.get("type")
        if t == "movegroup":
            pts = it["points"]
            coords = []
            for p in pts:
                coords += [self._sx(p["x"]), self._sy(p["y"])]
            if len(coords) >= 4:
                self.create_line(*coords, fill="#4dabf7", width=2, arrow=tk.LAST,
                                 smooth=True)
            x0, y0 = self._sx(pts[0]["x"]), self._sy(pts[0]["y"])
            x1, y1 = self._sx(pts[-1]["x"]), self._sy(pts[-1]["y"])
            self._dot(x0, y0, "#37b24d")   # baslangic yesil
            self._dot(x1, y1, "#f03e3e")   # bitis kirmizi
        elif t in ("button", "move", "scroll") and it.get("x") is not None:
            self._dot(self._sx(it["x"]), self._sy(it["y"]),
                      "#f59f00" if t == "button" else "#4dabf7")

    def _dot(self, x, y, color):
        r = 5
        self.create_oval(x - r, y - r, x + r, y + r, fill=color, outline="white")


# ---------------------------------------------------------------- duzenleme penceresi
GENERIC_FIELDS = {
    "key":    [("action", "Aksiyon (down/up)"), ("key", "Tus"), ("vk", "vk (sayi)")],
    "button": [("action", "Aksiyon (down/up)"), ("button", "Buton (left/right/middle)"),
               ("x", "X"), ("y", "Y")],
    "scroll": [("dx", "dx"), ("dy", "dy"), ("x", "X"), ("y", "Y")],
}


class EditDialog(tk.Toplevel):
    def __init__(self, master, it):
        super().__init__(master)
        self.title("Adimi duzenle")
        self.transient(master); self.grab_set()
        self.result = None
        self._it = dict(it)
        if it.get("type") == "movegroup":
            self._it["points"] = [dict(p) for p in it["points"]]
        self.vars = {}
        r = 0

        ttk.Label(self, text="Gecikme (baslamadan once, ms):").grid(row=r, column=0, sticky="e", padx=6, pady=4)
        self.delay_var = tk.StringVar(value=str(it.get("delay", 0)))
        ttk.Entry(self, textvariable=self.delay_var, width=16).grid(row=r, column=1, padx=6, pady=4); r += 1

        if it.get("type") == "movegroup":
            p0, p1 = it["points"][0], it["points"][-1]
            ttk.Label(self, text=f"Baslangic: ({p0['x']}, {p0['y']})").grid(row=r, column=0, columnspan=2, sticky="w", padx=6); r += 1
            ttk.Label(self, text=f"Bitis: ({p1['x']}, {p1['y']})   •   {len(it['points'])} nokta").grid(row=r, column=0, columnspan=2, sticky="w", padx=6); r += 1
            ttk.Label(self, text="Toplam hareket suresi (ms):").grid(row=r, column=0, sticky="e", padx=6, pady=4)
            self.dur_var = tk.StringVar(value=str(group_duration(it)))
            ttk.Entry(self, textvariable=self.dur_var, width=16).grid(row=r, column=1, padx=6, pady=4); r += 1
            self.straight = tk.BooleanVar(value=False)
            ttk.Checkbutton(self, text="Duz cizgiye indir (ara noktalari sil)",
                            variable=self.straight).grid(row=r, column=0, columnspan=2, sticky="w", padx=6, pady=2); r += 1
        else:
            for f, label in GENERIC_FIELDS.get(it.get("type"), []):
                ttk.Label(self, text=label + ":").grid(row=r, column=0, sticky="e", padx=6, pady=4)
                v = tk.StringVar(value="" if it.get(f) is None else str(it.get(f)))
                ttk.Entry(self, textvariable=v, width=16).grid(row=r, column=1, padx=6, pady=4)
                self.vars[f] = v; r += 1

        b = ttk.Frame(self); b.grid(row=r, column=0, columnspan=2, pady=10)
        ttk.Button(b, text="Tamam", command=self._ok).pack(side="left", padx=4)
        ttk.Button(b, text="Iptal", command=self.destroy).pack(side="left", padx=4)

    def _ok(self):
        it = self._it
        try:
            it["delay"] = max(0, int(float(self.delay_var.get())))
        except ValueError:
            messagebox.showerror("Hata", "Gecikme sayi olmali"); return
        if it.get("type") == "movegroup":
            if self.straight.get():
                straighten(it)
            try:
                set_group_duration(it, max(0, int(float(self.dur_var.get()))))
            except ValueError:
                messagebox.showerror("Hata", "Sure sayi olmali"); return
        else:
            for f, v in self.vars.items():
                val = v.get().strip()
                it[f] = (int(val) if val not in ("", "None") else None) if f in ("x", "y", "dx", "dy", "vk") else val
        self.result = it
        self.destroy()


# ---------------------------------------------------------------- ana uygulama
class App:
    def __init__(self, root):
        self.root = root
        self.rec = Recorder()
        self.items = []
        self.screen = {"width": root.winfo_screenwidth(), "height": root.winfo_screenheight()}
        root.title("Asil Macro Recorder v2")
        root.geometry("980x600")

        top = ttk.Frame(root); top.pack(fill="x", padx=8, pady=6)
        ttk.Label(top, text="Makro adi:").pack(side="left")
        self.name_var = tk.StringVar(value="Makro 1")
        ttk.Entry(top, textvariable=self.name_var, width=22).pack(side="left", padx=(4, 12))
        self.rec_btn = ttk.Button(top, text="● Kayit (F9)", command=self.rec.toggle)
        self.rec_btn.pack(side="left")
        ttk.Button(top, text="Ac (JSON)", command=self.load_json).pack(side="right")
        ttk.Button(top, text="Kaydet (JSON)", command=self.save_json).pack(side="right", padx=4)

        main = ttk.Frame(root); main.pack(fill="both", expand=True, padx=8, pady=4)

        left = ttk.Frame(main); left.pack(side="left", fill="both", expand=True)
        cols = ("no", "type", "delay", "dur", "detail")
        self.tree = ttk.Treeview(left, columns=cols, show="headings", selectmode="extended")
        for c, t, w in [("no", "#", 44), ("type", "Tur", 96), ("delay", "Gecikme(ms)", 92),
                        ("dur", "Sure(ms)", 80), ("detail", "Detay", 340)]:
            self.tree.heading(c, text=t); self.tree.column(c, width=w, anchor="w")
        self.tree.pack(fill="both", expand=True)
        self.tree.bind("<Double-1>", lambda e: self.edit_selected())
        self.tree.bind("<Motion>", self._on_hover)
        self.tree.bind("<<TreeviewSelect>>", lambda e: self._preview_selected())

        right = ttk.Frame(main); right.pack(side="right", fill="y", padx=(10, 0))
        ttk.Label(right, text="Ekran onizleme").pack(anchor="w")
        self.preview = ScreenPreview(right); self.preview.pack()
        self.info = ttk.Label(right, text="Bir satirin uzerine gel", foreground="#666")
        self.info.pack(anchor="w", pady=(6, 0))

        bot = ttk.Frame(root); bot.pack(fill="x", padx=8, pady=6)
        for txt, cmd in [("Duzenle", self.edit_selected), ("Sil", self.delete_selected),
                         ("Yukari", lambda: self.move(-1)), ("Asagi", lambda: self.move(1))]:
            ttk.Button(bot, text=txt, command=cmd).pack(side="left", padx=3)
        self.status = ttk.Label(bot, text="Hazir. F9 ile kayda basla.")
        self.status.pack(side="right")

        self.rec.start_listeners()
        self._tick()

    # ---- kayit durum dongusu ----
    def _tick(self):
        if self.rec.recording:
            self.status.config(text=f"● KAYIT...  {len(self.rec.events)} olay   (durdur: F9)")
            self.rec_btn.config(text="■ Durdur (F9)")
        else:
            self.rec_btn.config(text="● Kayit (F9)")
        if self.rec.just_stopped:
            self.rec.just_stopped = False
            self.screen = {"width": self.root.winfo_screenwidth(),
                           "height": self.root.winfo_screenheight()}
            self.items = group_events(self.rec.events)
            self.preview.set_screen(self.screen["width"], self.screen["height"])
            self.refresh()
            self.status.config(text=f"Kayit bitti: {len(self.items)} adim "
                                     f"({len(self.rec.events)} ham olay).")
        self.root.after(120, self._tick)

    # ---- tablo ----
    def refresh(self):
        self.tree.delete(*self.tree.get_children())
        for i, it in enumerate(self.items):
            self.tree.insert("", "end", iid=str(i),
                             values=(i + 1, row_type_label(it), row_delay(it),
                                     row_dur(it), describe(it)))

    def _sel(self):
        return sorted(int(i) for i in self.tree.selection())

    def _on_hover(self, e):
        row = self.tree.identify_row(e.y)
        if row != "":
            it = self.items[int(row)]
            self.preview.show(it)
            self.info.config(text=self._info_text(it))

    def _preview_selected(self):
        idx = self._sel()
        if idx:
            self.preview.show(self.items[idx[0]])
            self.info.config(text=self._info_text(self.items[idx[0]]))

    def _info_text(self, it):
        if it.get("type") == "movegroup":
            return f"Hareket • {group_duration(it)} ms • {len(it['points'])} nokta"
        if it.get("type") == "button":
            return f"Tik ({it.get('x')},{it.get('y')})"
        return row_type_label(it)

    def edit_selected(self):
        idx = self._sel()
        if not idx: return
        i = idx[0]
        dlg = EditDialog(self.root, self.items[i])
        self.root.wait_window(dlg)
        if dlg.result is not None:
            self.items[i] = dlg.result
            self.refresh(); self.tree.selection_set(str(i)); self._preview_selected()

    def delete_selected(self):
        for i in reversed(self._sel()):
            del self.items[i]
        self.refresh()

    def move(self, d):
        idx = self._sel()
        if not idx: return
        i = idx[0]; j = i + d
        if 0 <= j < len(self.items):
            self.items[i], self.items[j] = self.items[j], self.items[i]
            self.refresh(); self.tree.selection_set(str(j))

    # ---- JSON ----
    def save_json(self):
        path = filedialog.asksaveasfilename(defaultextension=".json",
                                            filetypes=[("JSON", "*.json")],
                                            initialfile=f"{self.name_var.get()}.json")
        if not path: return
        data = {"format": "asil-macro", "version": 1, "name": self.name_var.get(),
                "screen": self.screen, "events": flatten_items(self.items)}
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        self.status.config(text=f"Kaydedildi: {path}")

    def load_json(self):
        path = filedialog.askopenfilename(filetypes=[("JSON", "*.json")])
        if not path: return
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if data.get("format") != "asil-macro":
            messagebox.showwarning("Uyari", "Bu dosya asil-macro formatinda gorunmuyor.")
        self.name_var.set(data.get("name", "Makro"))
        self.screen = data.get("screen", self.screen)
        self.preview.set_screen(self.screen.get("width", 1920), self.screen.get("height", 1080))
        self.items = group_events(data.get("events", []))
        self.refresh()
        self.status.config(text=f"Yuklendi: {len(self.items)} adim")


def main():
    root = tk.Tk(); App(root); root.mainloop()


if __name__ == "__main__":
    main()

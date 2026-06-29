#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Asil Macro Pad - web arayuzu (Flask).
Makro JSON'larini yukle, listele, kisayol ata, sil, test oynat.
Veriler: /home/asil/macropad/macros/<id>.json + index.json
Calistir:  sudo python3 webapp.py    ->  http://asil.local:5000
(HID'e yazabilmek icin root gerekir.)
"""
import os, json, uuid, threading
from flask import Flask, request, redirect, url_for, render_template_string, jsonify

import player  # ayni klasor

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(BASE, "data")
MACRO_DIR = os.path.join(DATA, "macros")
INDEX = os.path.join(DATA, "index.json")
os.makedirs(MACRO_DIR, exist_ok=True)

app = Flask(__name__)


def load_index():
    if os.path.exists(INDEX):
        with open(INDEX, encoding="utf-8") as f:
            return json.load(f)
    return {"macros": []}


def save_index(idx):
    with open(INDEX, "w", encoding="utf-8") as f:
        json.dump(idx, f, ensure_ascii=False, indent=2)


def shortcut_text(sc):
    if not sc:
        return "—"
    parts = []
    if sc.get("ctrl"): parts.append("Ctrl")
    if sc.get("alt"): parts.append("Alt")
    if sc.get("shift"): parts.append("Shift")
    if sc.get("win"): parts.append("Win")
    parts.append(str(sc.get("key", "")).upper())
    return " + ".join(parts)


PAGE = """
<!doctype html><html lang=tr><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Asil Macro Pad</title>
<style>
 body{font-family:system-ui,Segoe UI,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;color:#1a1a1a}
 h1{font-size:22px} table{width:100%;border-collapse:collapse;margin-top:12px}
 th,td{border-bottom:1px solid #e3e3e3;padding:10px 8px;text-align:left;font-size:14px}
 .sc{font-family:ui-monospace,monospace;background:#f1f3f5;padding:2px 8px;border-radius:6px}
 button{cursor:pointer;border:1px solid #ccc;background:#fff;border-radius:7px;padding:6px 10px;font-size:13px}
 button.primary{background:#2563eb;color:#fff;border-color:#2563eb}
 button.danger{color:#c92a2a;border-color:#f1c2c2}
 .upload{margin-top:16px;padding:14px;border:1px dashed #bbb;border-radius:10px;background:#fafafa}
 .muted{color:#888;font-size:12px}
 #cap{position:fixed;inset:0;background:#000a;display:none;align-items:center;justify-content:center}
 #cap div{background:#fff;padding:28px 32px;border-radius:14px;text-align:center;font-size:18px}
</style></head><body>
<h1>🎹 Asil Macro Pad</h1>
<p class=muted>Pi'ye takili klavyeden atadigin kisayola basinca makro Windows'ta oynatilir.</p>

<table><thead><tr><th>Ad</th><th>Olay</th><th>Kisayol</th><th>Islem</th></tr></thead><tbody>
{% for m in macros %}
<tr>
 <td>{{m.name}}</td>
 <td>{{m.events}}</td>
 <td><span class=sc>{{ sc(m.shortcut) }}</span></td>
 <td>
   <button onclick="capture('{{m.id}}')">Kisayol ata</button>
   <form style="display:inline" method=post action="/play/{{m.id}}"><button class=primary>Test oynat</button></form>
   <form style="display:inline" method=post action="/delete/{{m.id}}" onsubmit="return confirm('Silinsin mi?')"><button class=danger>Sil</button></form>
 </td>
</tr>
{% else %}
<tr><td colspan=4 class=muted>Henuz makro yok. Asagidan bir JSON yukle.</td></tr>
{% endfor %}
</tbody></table>

<div class=upload>
 <form method=post action="/upload" enctype=multipart/form-data>
   <b>Makro yukle (.json):</b>
   <input type=file name=file accept=.json required>
   <button class=primary>Yukle</button>
 </form>
 <p class=muted>MacroRecorder.exe ile kaydedip "Kaydet (JSON)" dedigin dosyayi sec.</p>
</div>

<div id=cap><div>Kisayola bas...<br><span class=muted>(Esc = iptal)</span></div></div>
<script>
let capId=null;
function capture(id){capId=id;document.getElementById('cap').style.display='flex';}
function norm(e){
  let c=e.code;
  if(c.startsWith('Digit'))return c.slice(5);
  if(c.startsWith('Key'))return c.slice(3).toLowerCase();
  if(/^F\\d+$/.test(c))return c.toLowerCase();
  const m={Escape:'esc',Enter:'enter',Space:'space',Tab:'tab',Minus:'-',Equal:'=',
    Backquote:'`',Comma:',',Period:'.',Slash:'/',Semicolon:';',Quote:"'",
    BracketLeft:'[',BracketRight:']',Backslash:'\\\\',
    ArrowUp:'up',ArrowDown:'down',ArrowLeft:'left',ArrowRight:'right',Delete:'delete'};
  return (m[c]||c).toLowerCase();
}
window.addEventListener('keydown',function(e){
  if(capId===null)return;
  e.preventDefault();
  if(e.key==='Escape'){capId=null;document.getElementById('cap').style.display='none';return;}
  if(['Control','Alt','Shift','Meta'].includes(e.key))return; // sadece modifier ise bekle
  const sc={ctrl:e.ctrlKey,alt:e.altKey,shift:e.shiftKey,win:e.metaKey,key:norm(e)};
  fetch('/assign/'+capId,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sc)})
    .then(()=>location.reload());
  capId=null;document.getElementById('cap').style.display='none';
});
</script>
</body></html>
"""


@app.route("/")
def index():
    idx = load_index()
    return render_template_string(PAGE, macros=idx["macros"], sc=shortcut_text)


@app.route("/upload", methods=["POST"])
def upload():
    f = request.files.get("file")
    if not f:
        return redirect(url_for("index"))
    try:
        data = json.load(f.stream)
    except Exception:
        return "Gecersiz JSON", 400
    mid = uuid.uuid4().hex[:8]
    with open(os.path.join(MACRO_DIR, mid + ".json"), "w", encoding="utf-8") as out:
        json.dump(data, out, ensure_ascii=False, indent=2)
    idx = load_index()
    idx["macros"].append({
        "id": mid,
        "name": data.get("name", "Makro"),
        "events": len(data.get("events", [])),
        "shortcut": None,
    })
    save_index(idx)
    return redirect(url_for("index"))


@app.route("/assign/<mid>", methods=["POST"])
def assign(mid):
    sc = request.get_json(force=True)
    idx = load_index()
    for m in idx["macros"]:
        if m["id"] == mid:
            m["shortcut"] = sc
    save_index(idx)
    return jsonify(ok=True)


@app.route("/delete/<mid>", methods=["POST"])
def delete(mid):
    idx = load_index()
    idx["macros"] = [m for m in idx["macros"] if m["id"] != mid]
    save_index(idx)
    try:
        os.remove(os.path.join(MACRO_DIR, mid + ".json"))
    except FileNotFoundError:
        pass
    return redirect(url_for("index"))


@app.route("/play/<mid>", methods=["POST"])
def play(mid):
    path = os.path.join(MACRO_DIR, mid + ".json")
    if os.path.exists(path):
        threading.Thread(target=player.play_file, args=(path,), daemon=True).start()
    return redirect(url_for("index"))


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)

#!/usr/bin/env node
// Build the icon family from icons/src/icons.txt.
//
// Why a build step: the icons are a design asset that has to stay editable as
// pixels, but the consumers need them packed — the firmware (as bytes in
// flash) and the web side (the app's picker, and the demo page bundled from
// it). Hand-copying a 270-entry table between them is exactly the kind of
// thing that silently drifts, so the ASCII source is the single truth and
// everything else is generated from it.
//
// Packing: one icon = 8 bytes, one per row, bit 7 = leftmost pixel. Same layout
// the firmware will read, so the hex here is literally the flash image.
//
// Outputs, both generated, never hand-edited:
//   firmware/mkyada/icons.py    one bytes literal + a name index, so the device
//                               looks an icon up by the name the macro carries
//   app/src/lib/oled-icons.ts   the same table for the app's picker and for the
//                               OLED drawing layer — which docs/simulator.html
//                               is bundled from (scripts/build-demo.mjs), so
//                               the demo page has no third copy
//
// Usage:  node scripts/build-icons.mjs            rewrite both
//         node scripts/build-icons.mjs --check    verify only (CI)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Deliberately NOT under fonts/src: build-font.mjs compiles every .txt it finds
// there, so the icon source sitting beside the font source made that script
// try to parse icons as glyphs and die.
const SRC = path.join(ROOT, "icons", "src", "icons.txt");

const die = (m) => { console.error("[icons] " + m); process.exit(1); };

/** Parse the ASCII source.
 *  Pixel rows also start with '#', so the row pattern is tested BEFORE the
 *  name pattern — the other way round eats every lit-left-edge row as a name. */
function parse(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const cats = [];          // [{name, icons:[...]}]
  const icons = new Map();  // name -> [8 rows]
  let cat = null, name = null, rows = null;
  const flush = (lineNo) => {
    if (name === null) return;
    if (rows.length !== 8) die(`${name}: ${rows.length} satır (8 olmalı) — satır ${lineNo}`);
    if (icons.has(name)) die(`${name}: aynı ad iki kez`);
    icons.set(name, rows);
    if (!cat) die(`${name}: kategori başlığı ("## ...") yok`);
    cat.icons.push(name);
    name = null; rows = null;
  };
  lines.forEach((raw, i) => {
    const l = raw.replace(/\s+$/, "");
    if (/^[.#]{8}$/.test(l)) {
      if (name === null) die(`satır ${i + 1}: adı olmayan piksel satırı`);
      rows.push(l);
      return;
    }
    if (!l.trim()) return;
    if (l.startsWith("## ")) { flush(i + 1); cat = { name: l.slice(3).trim(), icons: [] }; cats.push(cat); return; }
    if (l.startsWith("#")) {
      const n = l.slice(1).trim();
      // Başlıktaki açıklama satırları da '#' ile başlıyor; ad olabilmesi için
      // kebab-case ve boşluksuz olmalı.
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(n)) return;
      flush(i + 1);
      name = n; rows = [];
      return;
    }
    die(`satır ${i + 1}: anlaşılmayan içerik: ${JSON.stringify(l)}`);
  });
  flush(lines.length);
  return { cats, icons };
}

const pack = (rows) =>
  rows.map((r) => {
    let b = 0;
    for (let x = 0; x < 8; x++) if (r[x] === "#") b |= 1 << (7 - x);
    return b.toString(16).padStart(2, "0");
  }).join("");

/** The firmware module. One bytes literal for every icon back to back, plus a
 *  name -> index dict; `get(name)` slices 8 bytes out of it. A dict of 270
 *  separate bytes objects would be 270 heap objects on a board whose whole
 *  problem is fragmentation, so this is one object and one dict. */
function renderPy({ cats, icons }) {
  const names = [...icons.keys()];
  const out = [];
  out.push("# The MKYADA icon family. GENERATED — do not edit.");
  out.push("#");
  out.push("# Source:    icons/src/icons.txt");
  out.push("# Generator: node scripts/build-icons.mjs");
  out.push("#");
  out.push(`# ${names.length} icons, ${cats.length} categories, ` +
           `${names.length * 8} bytes of pixels.`);
  out.push("# Layout: 8 bytes per icon, one per row, bit 7 = leftmost pixel.");
  out.push("#");
  out.push("# A macro picks an icon by NAME (\"icon\": \"rocket\" in its json), not");
  out.push("# by index: names are permanent, so extending or reordering the set can");
  out.push("# never repoint an existing macro at a different picture. An unknown");
  out.push("# name returns None and the caller falls back to the action family's");
  out.push("# default — an icon that is dropped one day cannot blank a grid cell.");
  out.push("#");
  out.push("# Everything lives in ONE bytes object rather than 270 of them: on a");
  out.push("# board whose whole problem is heap fragmentation, the object count is");
  out.push("# the thing that matters, not the 2 KB.");
  out.push("");
  // one long bytes literal, wrapped
  const hexAll = names.map((n) => pack(icons.get(n))).join("");
  out.push("PIX = (");
  for (let i = 0; i < hexAll.length; i += 64) {
    out.push('    b"' + hexAll.slice(i, i + 64).replace(/../g, (h) => "\\x" + h) + '"');
  }
  out.push(")");
  out.push("");
  out.push("IDX = {");
  let buf = "   ";
  names.forEach((n, i) => {
    const e = ` ${JSON.stringify(n)}: ${i},`;
    if (buf.length + e.length > 96) { out.push(buf); buf = "   "; }
    buf += e;
  });
  if (buf.trim()) out.push(buf);
  out.push("}");
  out.push("");
  out.push("");
  out.push("def get(name):");
  out.push('    """The 8 bytes for `name`, or None if the set does not have it.');
  out.push("");
  out.push('    A name of the form "px:" + 16 hex digits is not a lookup at all:');
  out.push("    it IS the picture, one hex byte per row, drawn by the user in the");
  out.push("    app. Carrying the eight bytes inside the macro's own json is what");
  out.push("    keeps a hand-drawn icon working with no second file to ship, no");
  out.push("    index to keep in step, and nothing to leak when the macro is");
  out.push('    deleted."""');
  out.push("    if name is not None and name[:3] == \"px:\":");
  out.push("        h = name[3:]");
  out.push("        if len(h) != 16:");
  out.push("            return None");
  out.push("        try:");
  out.push("            b = bytearray(8)");
  out.push("            for i in range(8):");
  out.push("                b[i] = int(h[i * 2:i * 2 + 2], 16)");
  out.push("        except ValueError:");
  out.push("            return None  # garbage in the json must not stop the grid");
  out.push("        return bytes(b)");
  out.push("    i = IDX.get(name, -1)");
  out.push("    if i < 0:");
  out.push("        return None");
  out.push("    return PIX[i * 8:i * 8 + 8]");
  out.push("");
  return out.join("\n");
}

/** The app module. Same packed bytes, plus the categories — the macro editor's
 *  icon picker groups by them, and the OLED preview needs the pixels so it can
 *  draw the grid cell the device will draw. */
function renderTs({ cats, icons }) {
  const names = [...icons.keys()];
  const hexAll = names.map((n) => pack(icons.get(n))).join("");
  const out = [];
  out.push("// The MKYADA icon family. GENERATED — do not edit.");
  out.push("//");
  out.push("// Source:    icons/src/icons.txt");
  out.push("// Generator: node scripts/build-icons.mjs");
  out.push("//");
  out.push(`// ${names.length} icons, ${cats.length} categories, ` +
           `${names.length * 8} bytes of pixels.`);
  out.push("// Layout: 8 bytes per icon, one per row, bit 7 = leftmost pixel —");
  out.push("// byte for byte what firmware/mkyada/icons.py ships to the board.");
  out.push("//");
  out.push("// A macro picks an icon by NAME, never by index: names are permanent, so");
  out.push("// extending or reordering the set cannot repoint an existing macro at a");
  out.push("// different picture. An unknown name returns null and the caller falls");
  out.push("// back to the action family's default.");
  out.push("");
  out.push("/** Category label -> the icon names in it, in source order. */");
  out.push("export const ICON_CATEGORIES: readonly (readonly [string, readonly string[]])[] = [");
  for (const c of cats) {
    out.push(`  [${JSON.stringify(c.name)}, [${c.icons.map((n) => JSON.stringify(n)).join(", ")}]],`);
  }
  out.push("];");
  out.push("");
  out.push("/** Every icon name, in source order. */");
  out.push("export const ICON_NAMES: readonly string[] = [");
  let nbuf = " ";
  names.forEach((n) => {
    const e = ` ${JSON.stringify(n)},`;
    if (nbuf.length + e.length > 96) { out.push(nbuf); nbuf = " "; }
    nbuf += e;
  });
  if (nbuf.trim()) out.push(nbuf);
  out.push("];");
  out.push("");
  out.push("// One hex string rather than an array of arrays: it keeps this generated");
  out.push("// file diffable per icon and costs one decode at module load.");
  out.push("const PIX_HEX =");
  for (let i = 0; i < hexAll.length; i += 72) {
    const last = i + 72 >= hexAll.length;
    out.push(`  "${hexAll.slice(i, i + 72)}"${last ? ";" : " +"}`);
  }
  out.push("");
  out.push("const PIX = new Uint8Array(PIX_HEX.length / 2);");
  out.push("for (let i = 0; i < PIX.length; i++) {");
  out.push("  PIX[i] = parseInt(PIX_HEX.slice(i * 2, i * 2 + 2), 16);");
  out.push("}");
  out.push("");
  out.push("const IDX = new Map<string, number>(ICON_NAMES.map((n, i) => [n, i]));");
  out.push("");
  out.push("/** A hand-drawn icon: the eight rows carried inline instead of named.");
  out.push(" *  Same syntax the firmware decodes in icons.py get(). */");
  out.push("export const CUSTOM_ICON_PREFIX = \"px:\";");
  out.push("");
  out.push("/** Pack eight row bytes into the `px:` name a macro can store. */");
  out.push("export function packCustomIcon(rows: ArrayLike<number>): string {");
  out.push("  let h = \"\";");
  out.push("  for (let i = 0; i < 8; i++) {");
  out.push("    h += ((rows[i] ?? 0) & 0xff).toString(16).padStart(2, \"0\");");
  out.push("  }");
  out.push("  return CUSTOM_ICON_PREFIX + h;");
  out.push("}");
  out.push("");
  out.push("/** The 8 packed rows for `name`, or null if the set does not have it.");
  out.push(" *  A `px:` name is decoded rather than looked up — see icons.py get(). */");
  out.push("export function iconBytes(name: string | null | undefined): Uint8Array | null {");
  out.push("  if (!name) return null;");
  out.push("  if (name.startsWith(CUSTOM_ICON_PREFIX)) {");
  out.push("    const h = name.slice(CUSTOM_ICON_PREFIX.length);");
  out.push("    if (!/^[0-9a-fA-F]{16}$/.test(h)) return null;");
  out.push("    const b = new Uint8Array(8);");
  out.push("    for (let i = 0; i < 8; i++) b[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);");
  out.push("    return b;");
  out.push("  }");
  out.push("  const i = IDX.get(name);");
  out.push("  if (i === undefined) return null;");
  out.push("  return PIX.subarray(i * 8, i * 8 + 8);");
  out.push("}");
  out.push("");
  return out.join("\n");
}

const src = fs.existsSync(SRC) ? fs.readFileSync(SRC, "utf8") : die(`${SRC} yok`);
const parsed = parse(src);
const py = renderPy(parsed);
const ts = renderTs(parsed);
const PY = path.join(ROOT, "firmware", "mkyada", "icons.py");
const TS = path.join(ROOT, "app", "src", "lib", "oled-icons.ts");

const curPy = fs.existsSync(PY) ? fs.readFileSync(PY, "utf8") : null;
const curTs = fs.existsSync(TS) ? fs.readFileSync(TS, "utf8") : null;

if (process.argv.includes("--check")) {
  const bad = [];
  if (curPy !== py) bad.push("firmware/mkyada/icons.py");
  if (curTs !== ts) bad.push("app/src/lib/oled-icons.ts");
  if (bad.length) die(`${bad.join(", ")} kaynakla uyuşmuyor — ` +
                      "node scripts/build-icons.mjs çalıştırın");
  console.log(`[icons] güncel — ${parsed.icons.size} ikon, ${parsed.cats.length} kategori`);
  process.exit(0);
}

fs.writeFileSync(PY, py);
fs.writeFileSync(TS, ts);
console.log(`[icons] yazıldı — ${parsed.icons.size} ikon, ${parsed.cats.length} kategori, ` +
            `${parsed.icons.size * 8} bayt paketli`);
console.log("        firmware/mkyada/icons.py + app/src/lib/oled-icons.ts");

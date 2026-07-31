#!/usr/bin/env node
// Compile fonts/src/*.txt -> firmware/fonts/*.fnt, the bitmap font the Vision
// 6 blits to its framebuffer.
//
// Why we ship our own font at all: the firmware used to render text with
// adafruit_display_text Labels over BDF fonts, which rasterize glyphs lazily
// onto the heap. On an RP2040 whose GC never compacts, rebuilding a screen's
// Labels was THE fragmentation source (see oled.py "displayio churn") — the
// bug class behind failed macro saves and the wedged menu wheel. The
// replacement draws into one persistent Bitmap and blits glyphs out of a
// resident atlas, which allocates nothing per frame. That needs a font in a
// format we control, so: this.
//
// Drawn from scratch rather than converted from the BDFs we used to bundle.
// A converted font stays a derivative work — Spleen is BSD and carries an
// attribution obligation — and dropping every third-party font is one of the
// points of the exercise.
//
// Source format (fonts/src/mkyada.txt), plain text, editable in any editor:
//
//   name mkyada
//   box 5 8           glyph box: width, height (height must be a multiple of 8)
//   first 0x20        first codepoint; glyphs must follow contiguously
//
//   glyph A           # or: glyph 0x41 — space must use the hex form,
//                     # `glyph 0x20 advance 3`, since it has no visible token
//   .###.
//   #...#
//   ...               exactly `box height` rows of `box width` cells
//
// '#' (or 'X'/'*') lights a pixel; anything else is background. A glyph's
// advance is derived from its rightmost lit column + 1px gap, so narrow
// letters pack tight — that proportional spacing is what lets ONE 5x8 font
// fit more text per grid cell than the fixed 4x6 font it replaces. Override
// with `advance N` (space needs it; it has no lit pixels).
//
// Binary layout (.fnt) — little detail on purpose, the device parses it with
// a couple of loops and no allocations beyond the atlas itself:
//
//   0  "MKF2"                          magic
//   4  box_w, box_h                    u8 each
//   6  first, ascii_count              u8 each
//   8  extra_count, reserved           u8 each
//  10  advance[ascii_count+extra_count]   u8 each
//      extra_codepoints[extra_count]      u16 little-endian
//      columns[(ascii_count+extra_count) * box_w * (box_h/8)]
//
// Glyph index for codepoint c: `c - first` while c is inside the leading
// contiguous ASCII run, otherwise ascii_count + position in the extras table.
// The split exists because Turkish is scattered across Unicode (Ş is U+015E,
// ğ is U+011F) while ASCII is not, and the common case should stay a
// subtraction rather than a dict hit.
//
// Each column byte holds 8 vertical pixels, LSB = topmost row. box_h 8 means
// one byte per column, which is why the format is this small (~600B) and why
// unpacking on the device is a flat loop.
//
// The device derives the inverted atlas (black-on-white, for the title bar and
// the selected grid cell) and the 2x hero atlas (the big numbers on the speed
// and volume screens) from this same data at boot — they are not stored, so
// there is exactly one drawn source for every size on screen.
//
// Usage: node scripts/build-font.mjs [--preview] [--term] [--show TEXT] [--check]
//        --preview    writes PNG proofs next to the source (atlas + samples)
//        --term       draws the atlas and the sample screens in the terminal
//        --show TEXT  draws just TEXT, at 1x and at the 2x hero size
//        --check      compiles and validates without writing the .fnt

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(ROOT, "fonts", "src");
const OUT_DIR = path.join(ROOT, "firmware", "fonts");
const PREVIEW = process.argv.includes("--preview");
const CHECK = process.argv.includes("--check");
const TERM = process.argv.includes("--term");
const SHOW = process.argv.includes("--show")
  ? process.argv[process.argv.indexOf("--show") + 1] ?? ""
  : null;

// The firmware's atlas is a displayio.Bitmap sized count*box_w by box_h, and
// every byte of it is resident for the whole runtime. Keep that honest: a
// font that quietly grew past this would eat the headroom this whole rewrite
// exists to create.
const MAX_FNT_BYTES = 2048;

const log = (m) => console.log(`[font] ${m}`);
const die = (m) => {
  console.error(`[font] ERROR: ${m}`);
  process.exit(1);
};

// --- source parsing ---

/** Parse a `.txt` font source into {name, boxW, boxH, first, glyphs[]}. */
function parseSource(text, file) {
  const lines = text.split(/\r?\n/);
  const meta = { name: null, boxW: 0, boxH: 0, first: 0x20 };
  const glyphs = [];
  let cur = null; // {code, advance|null, rows[]}

  const fail = (i, m) => die(`${path.basename(file)}:${i + 1}: ${m}`);

  const finish = (i) => {
    if (!cur) return;
    if (cur.rows.length !== meta.boxH) {
      fail(i, `glyph ${describe(cur.code)} has ${cur.rows.length} rows, expected ${meta.boxH}`);
    }
    glyphs.push(cur);
    cur = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Inside a glyph, a line of the right length is pixel data — even if it
    // starts with '#', which is also the comment marker everywhere else.
    if (cur && cur.rows.length < meta.boxH && raw.length && !/^\s*(glyph|#\s)/.test(raw)) {
      const row = raw.replace(/\s+$/, "");
      if (row.length > meta.boxW) fail(i, `row is ${row.length} cells, box width is ${meta.boxW}`);
      cur.rows.push(row.padEnd(meta.boxW, "."));
      continue;
    }
    // Full-line comments only. '#' is simultaneously the comment marker, a lit
    // pixel, and the name of a glyph, so a trailing "# note" could not be told
    // apart from the `glyph #` directive or from a pixel row.
    if (/^\s*#(\s|$)/.test(raw)) continue;
    const line = raw.trim();
    if (!line) continue;

    const [key, ...rest] = line.split(/\s+/);
    switch (key) {
      case "name":
        finish(i);
        meta.name = rest[0];
        break;
      case "box":
        finish(i);
        meta.boxW = Number(rest[0]);
        meta.boxH = Number(rest[1]);
        if (!meta.boxW || !meta.boxH) fail(i, "box needs a width and a height");
        if (meta.boxH % 8) fail(i, `box height ${meta.boxH} must be a multiple of 8`);
        break;
      case "first":
        finish(i);
        meta.first = Number(rest[0]);
        break;
      case "glyph": {
        finish(i);
        if (!meta.boxW) fail(i, "glyph before box");
        const code = parseCode(rest[0], (m) => fail(i, m));
        let advance = null;
        const ai = rest.indexOf("advance");
        if (ai >= 0) advance = Number(rest[ai + 1]);
        cur = { code, advance, rows: [] };
        break;
      }
      default:
        fail(i, `unknown directive "${key}"`);
    }
  }
  finish(lines.length);

  if (!glyphs.length) die(`${path.basename(file)}: no glyphs`);
  const index = new Map(glyphs.map((g) => [g.code, g]));
  return { ...meta, glyphs, index };
}

const glyphOf = (font, ch) => font.index.get(ch.codePointAt(0));

/** `A`, `0x41`, or `' '` -> codepoint. */
function parseCode(tok, fail) {
  if (tok === undefined) return fail("glyph needs a character or code");
  if (/^0x[0-9a-f]+$/i.test(tok)) return parseInt(tok, 16);
  if (tok.length === 3 && tok[0] === "'" && tok[2] === "'") return tok.charCodeAt(1);
  if ([...tok].length === 1) return tok.codePointAt(0);
  return fail(`cannot read glyph code "${tok}"`);
}

const describe = (code) =>
  code >= 0x21 && code <= 0x7e ? `'${String.fromCharCode(code)}'` : `0x${code.toString(16)}`;

// --- compilation ---

function compile(font, file) {
  const { boxW, boxH, first, glyphs } = font;
  const where = path.basename(file);

  // Two lookup regimes, because Turkish is scattered across Unicode while
  // ASCII is not. The leading run stays contiguous so the device resolves the
  // common case with one subtraction; everything past it (Turkish, icons) is
  // listed in an extras table it turns into a dict once at boot.
  const ascii = glyphs.filter((g) => g.code < 0x7f);
  const extras = glyphs.filter((g) => g.code >= 0x7f);

  ascii.forEach((g, i) => {
    const want = first + i;
    if (g.code !== want) {
      die(`${where}: expected ${describe(want)} at position ${i}, found ${describe(g.code)} — ` +
          `the ASCII run must be contiguous from ${describe(first)}`);
    }
  });
  if (glyphs.slice(0, ascii.length).some((g) => g.code >= 0x7f)) {
    die(`${where}: the contiguous ASCII glyphs must all come before the extras`);
  }
  const seen = new Set();
  for (const g of extras) {
    if (seen.has(g.code)) die(`${where}: ${describe(g.code)} is defined twice`);
    if (g.code > 0xffff) die(`${where}: ${describe(g.code)} is past U+FFFF, which the table can't hold`);
    seen.add(g.code);
  }

  const bytesPerCol = boxH / 8;
  const advances = Buffer.alloc(glyphs.length);
  const columns = Buffer.alloc(glyphs.length * boxW * bytesPerCol);

  glyphs.forEach((g, gi) => {
    let rightmost = -1;
    for (let x = 0; x < boxW; x++) {
      for (let y = 0; y < boxH; y++) {
        if (!lit(g.rows[y][x])) continue;
        rightmost = Math.max(rightmost, x);
        const off = (gi * boxW + x) * bytesPerCol + (y >> 3);
        columns[off] |= 1 << (y & 7);
      }
    }
    // +1 for the inter-glyph gap; an empty glyph (space) must be told its width.
    const auto = rightmost + 2;
    if (g.advance == null && rightmost < 0) {
      die(`${where}: glyph ${describe(g.code)} is blank — give it an explicit "advance N"`);
    }
    const adv = g.advance ?? auto;
    g.advance = adv; // resolve once; the preview and the size report reuse it
    if (adv < 1 || adv > boxW + 2) {
      die(`${where}: glyph ${describe(g.code)} advance ${adv} out of range 1..${boxW + 2}`);
    }
    advances[gi] = adv;
  });

  const header = Buffer.alloc(10);
  header.write("MKF2", 0, "ascii");
  header[4] = boxW;
  header[5] = boxH;
  header[6] = first;
  header[7] = ascii.length;
  header[8] = extras.length;
  header[9] = 0; // reserved
  const extraTable = Buffer.alloc(extras.length * 2);
  extras.forEach((g, i) => extraTable.writeUInt16LE(g.code, i * 2));

  font.asciiCount = ascii.length;
  font.extras = extras.map((g) => g.code);
  return Buffer.concat([header, advances, extraTable, columns]);
}

const lit = (c) => c === "#" || c === "X" || c === "*";

// --- PNG proofs ---

/** Minimal 8-bit grayscale PNG writer (node's zlib does the compression). */
function png(width, height, pixels) {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter: none
    pixels.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[i] = c;
    }
  }
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c;
}

/** A tiny framebuffer with the same primitives the firmware will have. */
function canvas(w, h, scale = 1) {
  const px = Buffer.alloc(w * h); // 0 = black
  return {
    w, h, scale, px,
    set(x, y, on) {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      px[y * w + x] = on ? 255 : 0;
    },
    rect(x, y, rw, rh, on = true) {
      for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) this.set(xx, yy, on);
    },
    /** Blit a string; returns the pen x after it. `zoom` doubles pixels (hero). */
    text(font, s, x, y, { invert = false, zoom = 1 } = {}) {
      const { boxW, boxH } = font;
      for (const ch of s) {
        const g = glyphOf(font, ch);
        if (!g) continue;
        for (let gx = 0; gx < boxW; gx++) {
          for (let gy = 0; gy < boxH; gy++) {
            const on = lit(g.rows[gy][gx]);
            if (!on && !invert) continue;
            for (let dy = 0; dy < zoom; dy++) {
              for (let dx = 0; dx < zoom; dx++) {
                this.set(x + gx * zoom + dx, y + gy * zoom + dy, invert ? !on : on);
              }
            }
          }
        }
        x += g.advance * zoom;
      }
      return x;
    },
    /** Block-character render: two pixel rows per terminal line, so a whole
     *  128x64 screen lands in 32 lines and needs no image viewer. */
    toTerm(pad = "  ") {
      const out = [];
      for (let y = 0; y < h; y += 2) {
        let line = "";
        for (let x = 0; x < w; x++) {
          const top = px[y * w + x] > 0;
          const bot = y + 1 < h && px[(y + 1) * w + x] > 0;
          line += top && bot ? "█" : top ? "▀" : bot ? "▄" : " ";
        }
        out.push(pad + line.replace(/\s+$/, ""));
      }
      return out.join("\n");
    },
    toPng() {
      const s = this.scale;
      if (s === 1) return png(w, h, px);
      const big = Buffer.alloc(w * s * h * s);
      for (let y = 0; y < h * s; y++) {
        for (let x = 0; x < w * s; x++) big[y * w * s + x] = px[((y / s) | 0) * w + ((x / s) | 0)];
      }
      return png(w * s, h * s, big);
    },
  };
}

function advanceOf(g, boxW, boxH) {
  let rightmost = -1;
  for (let x = 0; x < boxW; x++) {
    for (let y = 0; y < boxH; y++) if (lit(g.rows[y][x])) rightmost = Math.max(rightmost, x);
  }
  return rightmost + 2;
}

/** Glyph atlas: every glyph in a spaced grid, at 4x so pixels are visible. */
function buildAtlas(font) {
  const { boxW, boxH, glyphs } = font;
  const cols = 16;
  const cellW = boxW + 3;
  const cellH = boxH + 3;
  const rows = Math.ceil(glyphs.length / cols);
  const c = canvas(cols * cellW + 1, rows * cellH + 1, 4);
  glyphs.forEach((g, i) => {
    const cx = (i % cols) * cellW + 2;
    const cy = ((i / cols) | 0) * cellH + 2;
    for (let x = 0; x < boxW; x++) {
      for (let y = 0; y < boxH; y++) if (lit(g.rows[y][x])) c.set(cx + x, cy + y, true);
    }
  });
  return c;
}

/** 128x64 proofs at real device size — the honest test of legibility. These
 *  mirror the firmware's actual screens (title bar, menu, grid, hero number)
 *  so a font change can be judged where it matters, not on a specimen sheet. */
function buildSamples(font) {
  const right = (c, s, y, o) => c.text(font, s, 128 - 2 - measure(font, s), y, o);

  const menu = canvas(128, 64, 4);
  menu.rect(0, 0, 128, 13, true);
  menu.text(font, "AYARLAR", 2, 3, { invert: true });
  right(menu, "tut: ata", 3, { invert: true });
  menu.text(font, "▸ Ekran sönme", 2, 16);
  menu.text(font, "  Parlaklık", 2, 26);
  menu.text(font, "  USB sürücü ✓", 2, 36);
  menu.rect(0, 51, 128, 1, true);
  menu.text(font, "Geri", 2, 55);
  right(menu, "Seç", 55);

  // the 2x-doubled digits the speed and volume screens use
  const hero = canvas(128, 64, 4);
  hero.rect(0, 0, 128, 13, true);
  hero.text(font, "A>K3  HIZ", 2, 3, { invert: true });
  const big = "2.5x";
  hero.text(font, big, ((128 - measure(font, big) * 2) / 2) | 0, 20, { zoom: 2 });
  hero.rect(8, 45, 112, 1, true);
  hero.rect(8, 43, 60, 5, true);

  // the grid decides whether the font earns its keep: six 42px cells is the
  // tightest space any text has to live in
  const grid = canvas(128, 64, 4);
  grid.rect(0, 0, 128, 11, true);
  grid.text(font, "OBS: Masaüstü ●", 2, 2, { invert: true });
  const names = [["Giriş", ""], ["Oyun", "sahne"], ["Mola", ""],
                 ["Mikrofon", "aç/kapa"], ["Kayıt", "başlat"], ["Çıkış", ""]];
  names.forEach(([l1, l2], i) => {
    const cx = (i % 3) * 42;
    const cy = 11 + ((i / 3) | 0) * 27;
    const inv = i === 4; // one cell selected, the way playback highlights it
    if (inv) grid.rect(cx, cy, 42, 26, true);
    const mid = (s) => cx + (((42 - measure(font, s)) / 2) | 0);
    grid.text(font, l1, mid(l1), cy + (l2 ? 5 : 9), { invert: inv });
    if (l2) grid.text(font, l2, mid(l2), cy + 14, { invert: inv });
  });

  return [{ name: "menu", c: menu }, { name: "hero", c: hero }, { name: "grid", c: grid }];
}

/** Just one string, at both sizes — the fast loop when tuning a few glyphs. */
function buildShow(font, text) {
  const c = canvas(128, 64, 4);
  c.text(font, text, 2, 4);
  c.rect(0, 16, 128, 1, true);
  c.text(font, text, 2, 22, { zoom: 2 });
  c.rect(0, 42, 128, 1, true);
  c.rect(0, 46, 128, 13, true);
  c.text(font, text, 2, 48, { invert: true });
  return c;
}

function measure(font, s) {
  let w = 0;
  for (const ch of s) {
    const g = glyphOf(font, ch);
    if (g) w += g.advance;
  }
  return w;
}

// --- main ---

if (!fs.existsSync(SRC_DIR)) die(`no font sources at ${path.relative(ROOT, SRC_DIR)}`);
const sources = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith(".txt")).sort();
if (!sources.length) die(`no .txt font sources in ${path.relative(ROOT, SRC_DIR)}`);

for (const src of sources) {
  const file = path.join(SRC_DIR, src);
  const font = parseSource(fs.readFileSync(file, "utf8"), file);
  const bin = compile(font, file);

  const widest = Math.max(...font.glyphs.map((g) => g.advance));
  const avg = (font.glyphs.reduce((a, g) => a + g.advance, 0) / font.glyphs.length).toFixed(2);
  log(`${src}: ${font.glyphs.length} glyphs, ${font.boxW}x${font.boxH} box, ` +
      `advance ${avg} avg / ${widest} max, ${bin.length}B`);

  if (bin.length > MAX_FNT_BYTES) {
    die(`${src} compiles to ${bin.length}B, over the ${MAX_FNT_BYTES}B budget`);
  }

  const stem = src.replace(/\.txt$/, "");
  if (PREVIEW) {
    const shots = [{ name: "atlas", c: buildAtlas(font) }, ...buildSamples(font)];
    for (const { name, c } of shots) {
      const out = path.join(SRC_DIR, `${stem}-${name}.png`);
      fs.writeFileSync(out, c.toPng());
      log(`preview: ${path.relative(ROOT, out)}`);
    }
  }
  if (SHOW !== null) {
    console.log(`\n  ${stem}: "${SHOW}"  (1x / 2x / inverted)\n`);
    console.log(buildShow(font, SHOW).toTerm());
    console.log();
  }
  if (TERM) {
    for (const { name, c } of [{ name: "atlas", c: buildAtlas(font) }, ...buildSamples(font)]) {
      console.log(`\n  ${stem} — ${name}\n`);
      console.log(c.toTerm());
    }
    console.log();
  }
  if (!CHECK) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const out = path.join(OUT_DIR, src.replace(/\.txt$/, ".fnt"));
    fs.writeFileSync(out, bin);
    log(`wrote ${path.relative(ROOT, out)}`);
    if (stem === "mkyada") writeAppFont(bin);
  }
}

/** Mirror the compiled font into the desktop app as base64.
 *
 * The app draws its own little OLED previews (the wheel-menu screens in the
 * key editor and in Settings). Those used to be Courier text on a canvas — an
 * approximation that drifted from the device the moment the firmware got its
 * own font. Now app/src/lib/oled-fb.ts parses these exact bytes with a port of
 * font.py, so a preview is the same picture the glass shows, Turkish and
 * proportional spacing included. Generated, committed, and re-emitted here so
 * it can never lag the .fnt: CI runs --check and diffs. */
function writeAppFont(bin) {
  const out = path.join(ROOT, "app", "src", "lib", "oled-font.ts");
  if (!fs.existsSync(path.dirname(out))) return;
  const b64 = Buffer.from(bin).toString("base64");
  const wrapped = (b64.match(/.{1,96}/g) ?? []).map((l) => `  "${l}"`).join(" +\n");
  fs.writeFileSync(
    out,
    "// GENERATED by scripts/build-font.mjs — do not edit.\n" +
      "// firmware/fonts/mkyada.fnt, base64. See oled-fb.ts for the reader.\n" +
      "export const FONT_B64 =\n" +
      wrapped +
      ";\n",
  );
  log(`wrote ${path.relative(ROOT, out)}`);
}

#!/usr/bin/env node
// Build app/src/lib/oled-i18n.ts from firmware/mkyada/i18n.py.
//
// Why: the device's UI strings were written out three times — once in the
// firmware, once in docs/simulator.html and once in the font viewer — and the
// screens are laid out around how wide they are. A Turkish label that grew by
// four pixels in the firmware and not in the demo made the demo quietly stop
// being evidence. The firmware table is the truth; everything on the web side
// is generated from it.
//
// Only the tables are read: LANGS, LANG_DESC, DEFAULT_LANG and STRINGS. The
// parser is deliberately narrow — a plain dict of string literals — and fails
// loudly rather than guessing, because a silently half-parsed table is worse
// than no table.
//
// Usage:  node scripts/build-oled-i18n.mjs           rewrite
//         node scripts/build-oled-i18n.mjs --check   verify only (CI)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "firmware", "mkyada", "i18n.py");
const OUT = path.join(ROOT, "app", "src", "lib", "oled-i18n.ts");

const die = (m) => {
  console.error("[i18n] " + m);
  process.exit(1);
};

/** Decode a Python string literal — the tables use plain quoted strings with
 *  the odd \" or %s in them, nothing exotic. */
function pyStr(lit) {
  const q = lit[0];
  if ((q !== '"' && q !== "'") || lit[lit.length - 1] !== q) {
    die(`string literal beklendi: ${lit}`);
  }
  return lit
    .slice(1, -1)
    .replace(/\\(["'\\nt])/g, (_, c) =>
      ({ '"': '"', "'": "'", "\\": "\\", n: "\n", t: "\t" })[c]);
}

const src = fs.readFileSync(SRC, "utf8");

// LANGS = ("en", "tr")
const langsM = src.match(/^LANGS\s*=\s*\(([^)]*)\)/m);
if (!langsM) die("LANGS bulunamadı");
const LANGS = langsM[1].split(",").map((s) => s.trim()).filter(Boolean).map(pyStr);

const descM = src.match(/^LANG_DESC\s*=\s*\(([^)]*)\)/m);
if (!descM) die("LANG_DESC bulunamadı");
const LANG_DESC = descM[1].split(",").map((s) => s.trim()).filter(Boolean).map(pyStr);

const defM = src.match(/^DEFAULT_LANG\s*=\s*(.+)$/m);
if (!defM) die("DEFAULT_LANG bulunamadı");
const DEFAULT_LANG = pyStr(defM[1].trim());

// STRINGS = { "en": { "key": "value", ... }, "tr": { ... } }
const si = src.indexOf("STRINGS = {");
if (si < 0) die("STRINGS bulunamadı");
const body = src.slice(si);

const tables = {};
// Per language block: "en": {  ...  },
const langRe = /^\s{4}"([a-z]{2})":\s*\{$/gm;
let m;
while ((m = langRe.exec(body)) !== null) {
  const lang = m[1];
  const rest = body.slice(m.index + m[0].length);
  const end = rest.indexOf("\n    },");
  if (end < 0) die(`${lang}: tablo sonu bulunamadı`);
  const entries = {};
  const entRe = /^\s{8}("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*")\s*,?\s*$/gm;
  let e;
  const chunk = rest.slice(0, end);
  while ((e = entRe.exec(chunk)) !== null) entries[pyStr(e[1])] = pyStr(e[2]);
  // Every non-blank, non-comment line inside the block must have parsed, or a
  // string is missing from the web side and nothing would say so.
  const lines = chunk.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
  if (lines.length !== Object.keys(entries).length) {
    die(`${lang}: ${lines.length} satırdan ${Object.keys(entries).length} tanesi ayrıştırıldı — ` +
        "beklenmeyen bir biçim var");
  }
  tables[lang] = entries;
}
for (const l of LANGS) if (!tables[l]) die(`${l} tablosu yok`);

// Every language must carry every key the default has, or a screen falls back
// to a differently-sized string at run time and the layout shifts.
const baseKeys = Object.keys(tables[DEFAULT_LANG]);
for (const l of LANGS) {
  const missing = baseKeys.filter((k) => !(k in tables[l]));
  if (missing.length) die(`${l} eksik anahtarlar: ${missing.join(", ")}`);
}

const out = [];
out.push("// The Vision 6's own UI strings. GENERATED — do not edit.");
out.push("//");
out.push("// Source:    firmware/mkyada/i18n.py");
out.push("// Generator: node scripts/build-oled-i18n.mjs");
out.push("//");
out.push("// The screens are laid out around how wide these are, so the demo page and");
out.push("// the app's preview have to use the device's exact wording — a Turkish label");
out.push("// that grows by four pixels in the firmware and not here would make both");
out.push("// quietly stop being evidence.");
out.push("");
out.push(`export const LANGS = [${LANGS.map((l) => JSON.stringify(l)).join(", ")}] as const;`);
out.push("export type Lang = (typeof LANGS)[number];");
out.push(`export const LANG_DESC: Record<Lang, string> = {`);
LANGS.forEach((l, i) => out.push(`  ${l}: ${JSON.stringify(LANG_DESC[i] ?? l)},`));
out.push("};");
out.push(`export const DEFAULT_LANG: Lang = ${JSON.stringify(DEFAULT_LANG)};`);
out.push("");
out.push("export const STRINGS: Record<Lang, Record<string, string>> = {");
for (const l of LANGS) {
  out.push(`  ${l}: {`);
  for (const k of Object.keys(tables[l])) {
    out.push(`    ${JSON.stringify(k)}: ${JSON.stringify(tables[l][k])},`);
  }
  out.push("  },");
}
out.push("};");
out.push("");
out.push("let current: Lang = DEFAULT_LANG;");
out.push("");
out.push("/** Switch the language the screens draw in. Unknown values fall back to the");
out.push(" * default, the same way the firmware's set_lang does. */");
out.push("export function setLang(l: string | null | undefined): Lang {");
out.push("  current = (LANGS as readonly string[]).includes(l ?? '') ? (l as Lang) : DEFAULT_LANG;");
out.push("  return current;");
out.push("}");
out.push("");
out.push("export function getLang(): Lang {");
out.push("  return current;");
out.push("}");
out.push("");
out.push("/** One string. An unknown key echoes itself rather than drawing nothing —");
out.push(" * matching the firmware, so a missing string is visible on the glass. */");
out.push("export function tr(key: string): string {");
out.push("  return STRINGS[current][key] ?? STRINGS[DEFAULT_LANG][key] ?? key;");
out.push("}");
out.push("");
out.push("/** Uppercase the way the UI language wants it — the same two replaces");
out.push(" * firmware/mkyada/i18n.py does, NOT toLocaleUpperCase. Locale-aware casing");
out.push(" * would be a third behaviour: the point is to draw exactly what the glass");
out.push(" * draws, and the board has no locale tables. */");
out.push("export function upper(s: string): string {");
out.push("  let t = String(s);");
out.push("  if (current === 'tr') t = t.replace(/i/g, '\\u0130').replace(/\\u0131/g, 'I');");
out.push("  return t.toUpperCase();");
out.push("}");
out.push("");

const text = out.join("\n");
const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : null;
const n = baseKeys.length;

if (process.argv.includes("--check")) {
  // Line endings normalized: a Windows checkout is CRLF and the generator
  // emits LF, so a raw compare could never pass locally there.
  const lf = (s) => (s === null || s === undefined ? s : s.replace(/\r\n/g, "\n"));
  if (lf(cur) !== lf(text)) {
    die("app/src/lib/oled-i18n.ts firmware/mkyada/i18n.py ile uyuşmuyor — " +
        "node scripts/build-oled-i18n.mjs çalıştırın");
  }
  console.log(`[i18n] güncel — ${LANGS.length} dil, ${n} dize`);
  process.exit(0);
}

fs.writeFileSync(OUT, text);
console.log(`[i18n] yazıldı — ${LANGS.length} dil, ${n} dize -> app/src/lib/oled-i18n.ts`);

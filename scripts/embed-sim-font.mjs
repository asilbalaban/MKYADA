// Re-embeds firmware/fonts/mkyada.fnt into docs/simulator.html.
//
// The menu simulator is a single self-contained file — no fetch, no server —
// so the font it draws with lives inside it as base64. That copy has to be the
// bytes the device flashes, or the simulator's text metrics quietly drift from
// the real screen (the font is proportional: every advance width matters).
//
// Run: node scripts/embed-sim-font.mjs          rewrite the block
//      node scripts/embed-sim-font.mjs --check  verify only (exit 1 on drift)
//
// The --check form is what a CI guard would run, next to the existing
// "regenerate and git diff --exit-code" checks for docs/font.html and
// app/screenshots/oled-frames.js.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FNT = path.join(REPO, "firmware", "fonts", "mkyada.fnt");
const SIM = path.join(REPO, "docs", "simulator.html");
const BLOCK = /const FONT_B64 =[\s\S]*?;\r?\n/;
const CHECK = process.argv.includes("--check");

const font = fs.readFileSync(FNT);
const b64 = font.toString("base64");
const lines = [];
for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
const block =
  "const FONT_B64 =\n" +
  lines.map((c, i) => `"${c}"` + (i === lines.length - 1 ? ";" : " +")).join("\n") +
  "\n";

const html = fs.readFileSync(SIM, "utf8");
const found = html.match(BLOCK);
if (!found) {
  console.error("FONT_B64 block not found in docs/simulator.html");
  process.exit(1);
}

// Read the quoted chunks, don't split on "+": base64's own alphabet contains
// "+", so splitting on the concatenation operator shreds the payload.
const embedded = Buffer.from(
  (found[0].match(/"[^"]*"/g) || []).map((s) => s.slice(1, -1)).join(""),
  "base64",
);

if (embedded.equals(font)) {
  console.log(`up to date — ${font.length} bytes embedded`);
  process.exit(0);
}
if (CHECK) {
  console.error(
    `drift: simulator holds ${embedded.length} bytes, mkyada.fnt is ${font.length}.\n` +
      "Run: node scripts/embed-sim-font.mjs",
  );
  process.exit(1);
}
fs.writeFileSync(SIM, html.replace(BLOCK, block));
console.log(`embedded ${font.length} bytes into docs/simulator.html`);

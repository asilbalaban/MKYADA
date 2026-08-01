#!/usr/bin/env node
// Bundle the OLED drawing layer into docs/simulator.html.
//
// docs/simulator.html is a single static file people open straight off the
// filesystem or off the docs site — no bundler, no module server, no npm. It
// still has to draw the device with the device's real font, real icons, real
// strings and real screen code, and it must not own a second copy of any of
// them: the copies drifted, and a demo page that quietly stops matching the
// keypad is worse than none, because people trust it.
//
// So the page carries one generated <script> — app/src/lib/oled-bundle.ts and
// everything it imports, compiled to an IIFE on window.MKOLED. The app imports
// the same modules directly. One implementation, two consumers.
//
// The bundle is committed so the page works from a checkout with no build; CI
// runs --check to prove it is not stale.
//
// Usage:  node scripts/build-demo.mjs            rewrite the block
//         node scripts/build-demo.mjs --check    verify only (CI)

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "app", "src", "lib", "oled-bundle.ts");
const PAGE = path.join(ROOT, "docs", "simulator.html");
const BEGIN = "/* OLED_BUNDLE_BEGIN";
const END = "/* OLED_BUNDLE_END */";

const die = (m) => {
  console.error("[demo] " + m);
  process.exit(1);
};

// esbuild's Node API rather than its CLI: spawning the .cmd shim fails with
// EINVAL on Windows, and going through the API skips a process launch anyway.
// The dependency is the app's own, so the version is pinned by
// app/package-lock.json like everything else.
let esbuild;
try {
  esbuild = createRequire(path.join(ROOT, "app", "package.json"))("esbuild");
} catch {
  die("esbuild bulunamadı — app/ içinde `npm ci` çalıştırın");
}

let js;
try {
  const out = esbuild.buildSync({
    entryPoints: [ENTRY],
    bundle: true,
    format: "iife",
    globalName: "MKOLED",
    target: "es2020",
    platform: "browser",
    charset: "utf8",
    // Not minified on purpose: this file is committed, so a readable diff is
    // worth more than the bytes. It is a docs page, not a payload.
    minify: false,
    write: false,
  });
  js = out.outputFiles[0].text;
} catch (e) {
  die("esbuild başarısız:\n" + (e.message || e));
}

const header = [
  BEGIN + " — ÜRETİLMİŞTİR, elle düzenlemeyin.",
  "   Kaynak: app/src/lib/oled-bundle.ts (+ oled-fb / oled-screens / oled-icons /",
  "           oled-i18n / oled-font — uygulamanın kullandığı modüllerin aynısı)",
  "   Üreten: node scripts/build-demo.mjs",
  "",
  "   Bu sayfa ile uygulama aynı çizim kodunu çalıştırır; bir ekran burada",
  "   düzelip orada bozuk kalamaz. Cihazdaki Python uygulamasıyla arasındaki",
  "   uyum da tests/golden/*.txt üzerinden her commit'te denetlenir. */",
].join("\n");

const block = header + "\n" + js.trimEnd() + "\n" + END;

let html = fs.readFileSync(PAGE, "utf8");
const i = html.indexOf(BEGIN);
const j = html.indexOf(END);
if (i < 0 || j < 0) {
  die(`docs/simulator.html içinde ${BEGIN} / ${END} işaretleri yok`);
}

// The version the simulated keypad reports (boot splash, About). Hand-typed it
// went stale the first time the firmware was bumped and nothing said so, so it
// is stamped from firmware/VERSION like everything else here.
const FW = fs.readFileSync(path.join(ROOT, "firmware", "VERSION"), "utf8").trim();
const VER_RE = /const FW_VERSION="[^"]*";/;
if (!VER_RE.test(html)) die("docs/simulator.html içinde FW_VERSION satırı yok");

const next =
  (html.slice(0, i) + block + html.slice(j + END.length))
    .replace(VER_RE, `const FW_VERSION="${FW}";`);

const kb = (block.length / 1024).toFixed(1);

// The landing page's hero animation draws the same OLED screens, but it is a
// module script and cannot share simulator.html's inline block — so the same
// bundle also lands as a standalone file, committed and checked the same way.
const BUNDLE_FILE = path.join(ROOT, "docs", "oled-bundle.js");
const bundleOut = block + "\n";

if (process.argv.includes("--check")) {
  if (next !== html) {
    die("docs/simulator.html kaynakla uyuşmuyor — " +
        "node scripts/build-demo.mjs çalıştırın");
  }
  let cur = "";
  try { cur = fs.readFileSync(BUNDLE_FILE, "utf8"); } catch {}
  if (cur !== bundleOut) {
    die("docs/oled-bundle.js kaynakla uyuşmuyor — " +
        "node scripts/build-demo.mjs çalıştırın");
  }
  console.log(`[demo] güncel — ${kb} KB paket, fw ${FW}`);
  process.exit(0);
}

fs.writeFileSync(PAGE, next);
fs.writeFileSync(BUNDLE_FILE, bundleOut);
console.log(`[demo] yazıldı — ${kb} KB paket, fw ${FW} -> docs/simulator.html + docs/oled-bundle.js`);

#!/usr/bin/env node
// Build firmware-dist/ — the exact firmware tree the app installer bundles
// and the firmware release zip ships.
//
// Why a build step at all (issue: field brick on Vision 6): the RP2040 must
// otherwise COMPILE every module on the device at boot, and compiling the
// big ones (ui.py ~38KB) needs a large contiguous allocation that the
// display stack's fragmented heap can't always provide — the observed
// result was a MemoryError at the loading screen. Precompiled .mpy files
// import in a fraction of the RAM, which removes that failure mode
// completely. boot.py and code.py stay .py (CircuitPython requires source
// for those two; both are deliberately small).
//
// What it does:
//   1. copies firmware/ -> firmware-dist/ (skipping caches)
//   2. fetches the pinned neopixel.py if the tree doesn't carry it
//   3. fetches the mpy-cross build matching the bundled CircuitPython and
//      compiles mkyada/*.py and lib/**/*.py to .mpy (sources removed)
//
// Offline / failure fallback: if mpy-cross can't be fetched the dist ships
// .py sources — the firmware still boots (code.py retries the big import
// after a gc.collect() and falls back headless), it's just not as robust.
// Release builds must not silently ship that: pass --require-mpy in CI.
//
// Usage: node scripts/build-firmware-dist.mjs [--require-mpy]
//        MKYADA_NO_MPY=1 skips compilation (fast dev iteration)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Keep in sync with the bundled UF2 (app/resources/circuitpython/) and the
// CircuitPython tier in docs/vision6.md. The .mpy bytecode format only
// changes on major CircuitPython versions, but pin exactly anyway.
const CP_VERSION = "10.2.1";
const NEOPIXEL_REF = "6.4.2";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "firmware");
const DIST = path.join(ROOT, "firmware-dist");
const CACHE = path.join(ROOT, "scripts", ".cache");
const REQUIRE_MPY =
  process.argv.includes("--require-mpy") || process.env.MKYADA_REQUIRE_MPY === "1";

function log(msg) {
  console.log(`[firmware-dist] ${msg}`);
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) continue;
    if (entry.name.startsWith("._")) continue; // macOS AppleDouble litter
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function fetchTo(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function mpyCrossUrl() {
  const base = "https://adafruit-circuit-python.s3.amazonaws.com/bin/mpy-cross";
  if (process.platform === "win32") {
    return `${base}/windows/mpy-cross-windows-${CP_VERSION}.static.exe`;
  }
  if (process.platform === "darwin") {
    // Adafruit ships arm64-only for current versions; Apple-silicon runners
    // and machines are the norm. (Intel macs fall back to .py sources.)
    return `${base}/macos/mpy-cross-macos-${CP_VERSION}-arm64`;
  }
  return `${base}/linux-amd64/mpy-cross-linux-amd64-${CP_VERSION}.static`;
}

async function getMpyCross() {
  if (process.env.MKYADA_NO_MPY === "1") return null;
  const url = mpyCrossUrl();
  const bin = path.join(CACHE, path.basename(url));
  if (!fs.existsSync(bin)) {
    log(`fetching ${url}`);
    try {
      await fetchTo(url, bin);
    } catch (e) {
      if (REQUIRE_MPY) throw e;
      log(`WARNING: mpy-cross unavailable (${e.message}) — shipping .py sources`);
      return null;
    }
    if (process.platform !== "win32") fs.chmodSync(bin, 0o755);
  }
  return bin;
}

function* pyFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* pyFiles(p);
    else if (entry.name.endsWith(".py")) yield p;
  }
}

async function main() {
  fs.rmSync(DIST, { recursive: true, force: true });
  copyTree(SRC, DIST);

  // vendored at release time, like .github/workflows always did
  const neopixel = path.join(DIST, "lib", "neopixel.py");
  if (!fs.existsSync(neopixel)) {
    const url = `https://raw.githubusercontent.com/adafruit/Adafruit_CircuitPython_NeoPixel/${NEOPIXEL_REF}/neopixel.py`;
    log(`fetching neopixel.py ${NEOPIXEL_REF}`);
    try {
      await fetchTo(url, neopixel);
    } catch (e) {
      if (REQUIRE_MPY) throw e; // release builds must ship the LED driver
      log(`WARNING: neopixel.py unavailable (${e.message}) — LED support needs it`);
    }
  }

  const mpyCross = await getMpyCross();
  if (mpyCross) {
    let n = 0;
    for (const dir of ["mkyada", "lib"]) {
      const abs = path.join(DIST, dir);
      if (!fs.existsSync(abs)) continue;
      for (const py of [...pyFiles(abs)]) {
        const mpy = py.slice(0, -3) + ".mpy";
        execFileSync(mpyCross, ["-o", mpy, py], { stdio: "inherit" });
        fs.rmSync(py);
        n += 1;
      }
    }
    log(`compiled ${n} modules to .mpy (CircuitPython ${CP_VERSION})`);
  }

  const version = fs.readFileSync(path.join(DIST, "VERSION"), "utf8").trim();
  log(`firmware-dist ready: v${version}${mpyCross ? "" : " (source-only)"}`);
}

main().catch((e) => {
  console.error(`[firmware-dist] FAILED: ${e.message}`);
  process.exit(1);
});

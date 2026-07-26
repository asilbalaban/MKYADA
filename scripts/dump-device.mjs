#!/usr/bin/env node
// Dump the connected keypad's real setup into fonts/src/device.json, which the
// font viewer's demo then mirrors exactly (layer count, per-key labels, band,
// settings values).
//
// The keypad's serial link is single-owner: while the MKYADA app is running it
// holds the data CDC, so this must be run with the app QUIT. That is the whole
// reason this is a separate script rather than something the viewer build does
// on its own — it needs a moment where nothing else is talking to the device.
//
// Usage:  quit MKYADA, then  node scripts/dump-device.mjs
//         (add --port /dev/cu.usbmodemXXX to pick a specific device)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "fonts", "src", "device.json");

const argPort = process.argv.includes("--port")
  ? process.argv[process.argv.indexOf("--port") + 1]
  : null;

const die = (m) => { console.error(`[dump] ${m}`); process.exit(1); };
const log = (m) => console.log(`[dump] ${m}`);

/** CircuitPython exposes the REPL on the first CDC and our protocol on the
 *  second; the app connects to the second, so that is the one to use. */
function findPort() {
  if (argPort) return argPort;
  const ports = fs.readdirSync("/dev")
    .filter((f) => f.startsWith("cu.usbmodem"))
    .map((f) => "/dev/" + f)
    .sort();
  if (!ports.length) die("no /dev/cu.usbmodem* — is the keypad plugged in?");
  // the data CDC is the higher-numbered one of a pair
  return ports[ports.length - 1];
}

const PORT = findPort();
log(`port ${PORT}`);

// Raw mode, no echo, no flow control — anything else mangles the JSON lines.
try {
  execFileSync("stty", ["-f", PORT, "raw", "-echo", "115200"], { stdio: "ignore" });
} catch (e) {
  die(`could not configure ${PORT}: ${e.message}\n` +
      `       If it says "Resource busy", quit the MKYADA app first.`);
}

const fd = fs.openSync(PORT, "r+");
let buf = "";

function send(obj) {
  fs.writeSync(fd, JSON.stringify(obj) + "\n");
}

/** Read lines until `match` returns a value, or the deadline passes. */
function until(match, ms, what) {
  const stop = Date.now() + ms;
  const chunk = Buffer.alloc(4096);
  while (Date.now() < stop) {
    let n = 0;
    try { n = fs.readSync(fd, chunk, 0, chunk.length, null); } catch { n = 0; }
    if (n > 0) {
      buf += chunk.subarray(0, n).toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("{")) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const got = match(msg);
        if (got !== undefined) return got;
      }
    }
  }
  die(`timed out waiting for ${what}`);
}

// 1. hello — model, layer/key counts, which bands are on
send({ t: "ping" });
const hello = until((m) => (m.t === "hello" ? m : undefined), 4000, "hello");
log(`${hello.model} fw ${hello.fw}, ${hello.layer_count} layers x ${hello.key_count} keys`);

// 2. config.json — language, timeout, band flags
send({ t: "fs_read", path: "config.json" });
let cfgRaw = "";
until((m) => {
  if (m.t === "err") die(`config.json: ${m.code || ""} ${m.msg || ""}`);
  if (m.t !== "ok" || m.re !== "fs_read") return undefined;
  cfgRaw += Buffer.from(m.data || "", "base64").toString("utf8");
  return m.eof ? true : undefined;
}, 8000, "config.json");
const cfg = JSON.parse(cfgRaw);

// 3. every macro file that exists, for its display name
const LAYERS = "abcdefgh";
const keys = {};
for (let l = 0; l < (hello.layer_count || 1); l++) {
  for (let k = 1; k <= (hello.key_count || 6); k++) {
    const file = l === 0 ? `macros/key${k}.json` : `macros/key${k}-${LAYERS[l]}.json`;
    send({ t: "fs_read", path: file });
    let raw = "";
    const ok = until((m) => {
      if (m.t === "err") return null;                 // unassigned key
      if (m.t !== "ok" || m.re !== "fs_read") return undefined;
      raw += Buffer.from(m.data || "", "base64").toString("utf8");
      return m.eof ? true : undefined;
    }, 8000, file);
    if (!ok) continue;
    // the header line carries {"name": ...}; the rest is event data
    const head = raw.split("\n").find((s) => s.trim().startsWith("{"));
    let name = "";
    try { name = (JSON.parse(head) || {}).name || ""; } catch { /* leave blank */ }
    if (name) keys[`${LAYERS[l]}:${k}`] = name;
  }
}
fs.closeSync(fd);

const out = {
  model: hello.model,
  fw: hello.fw,
  uid: hello.uid,
  layer_count: hello.layer_count,
  key_count: hello.key_count,
  lang: cfg.lang || "en",
  timeout: cfg.timeout ?? 30,
  show_layer: !!cfg.show_layer,
  show_profile: !!cfg.show_profile,
  keys,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
log(`wrote ${path.relative(ROOT, OUT)} — ${Object.keys(keys).length} named keys`);
log("now run: node scripts/build-font.mjs --html");

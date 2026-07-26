// Connect-time keys loader (headless).
//
// The Keys page has always known how to read the keypad robustly — retry a
// settling drive, never trust an empty listing — but it only ran when that tab
// was open. Everything else that needs the assignments (the native sound-key
// map, background playback) was left to hope the user had visited Keys once,
// and the very first read fired at connect (devname sync) used to race the
// still-settling link and wedge it ("data transfer failed", only a replug
// fixed it).
//
// So we load once, centrally, right after a device connects: the same
// config → list → read sequence the Keys page uses, headless, writing into the
// shared keysCache. The Keys page then opens to a warm cache (no re-read), the
// sound-key map is rebuilt from it, and the fragile connect-time race is gone.

import { invoke } from "@tauri-apps/api/core";
import { ipc } from "./ipc";
import { keysCache, slotKey } from "./keys-cache";
import {
  defaultConfig,
  effectiveLayers,
  macroFileName,
  parseAssignment,
  parseDeviceMacro,
  slotFileName,
} from "./macro-model";
import { MODULE_SLOTS, deviceModel } from "./types";
import type { Assignment, DeviceConfig } from "./types";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const trace = (msg: string) => void invoke("debug_log", { msg: `loader: ${msg}` }).catch(() => {});

/** Load the keypad's config + every macro into keysCache. Returns true when
 * the cache is warm (either from this load or already); false means the load
 * was incomplete/aborted and the caller should retry after a beat. `isCurrent`
 * lets the caller abort a load whose drive/connection has been superseded. */
export async function loadKeysToCache(
  drivePath: string,
  isCurrent: () => boolean,
): Promise<boolean> {
  if (keysCache.get(drivePath)) return true; // already warm

  // config.json — retry while the (often serial-backed) drive is still
  // settling; a cold read throws or returns nothing.
  let config: DeviceConfig = defaultConfig();
  let configOk = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (!isCurrent()) return false;
    try {
      config = { ...config, ...JSON.parse(await ipc.driveRead(drivePath, "config.json")) };
      configOk = true;
      break;
    } catch {
      await sleep(200);
    }
  }
  if (!isCurrent()) return false;

  // macros dir — retry an empty listing until config has proven the drive is
  // readable (then an empty dir really means "no macros", not a cold mount).
  let existing = new Set<string>();
  let listOk = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (!isCurrent()) return false;
    try {
      const list = await ipc.driveList(drivePath, "macros");
      existing = new Set(list);
      listOk = true;
      if (list.length || configOk) break;
    } catch {
      // dir not browsable yet — fall through to the wait
    }
    await sleep(200);
  }
  if (!isCurrent()) return false;

  const layers = effectiveLayers(config);
  const vision6 = deviceModel(config) === "vision6";
  const slots: { key: string; file: string }[] = [];
  const add = (key: string, file: string) => {
    if (existing.has(file.split("/").pop()!)) slots.push({ key, file });
  };
  for (let l = 0; l < layers; l++) {
    for (let k = 1; k <= config.key_count; k++) {
      if (config.layer_key === k) continue;
      add(slotKey(k, l), macroFileName(k, l));
    }
    if (vision6) for (const s of MODULE_SLOTS) add(slotKey(s, l), slotFileName(s, l));
  }
  if (vision6) {
    // per-context nav overrides (layer screen / settings menu) are global
    for (const ctx of ["home", "menu"] as const) {
      for (const s of MODULE_SLOTS) add(slotKey(s, 0, ctx), slotFileName(s, 0, ctx));
    }
  }

  trace(`config ok=${configOk} listOk=${listOk} files=${existing.size} slots=${slots.length}`);

  // Read every macro, and RETRY the ones that fail in later rounds: a single
  // flaky read must not surface as "this key is unassigned". (That is exactly
  // what happened in the field — layers C/D read as blank because their reads
  // hit a transient error mid-sequence and were silently skipped.)
  const snapshot = new Map<string, Assignment>();
  let queue = slots;
  for (let round = 0; round < 3 && queue.length; round++) {
    if (round) {
      trace(`retry round ${round}: ${queue.length} files`);
      await sleep(400);
    }
    const failed: typeof slots = [];
    for (const s of queue) {
      if (!isCurrent()) return false;
      try {
        snapshot.set(
          s.key,
          parseAssignment(parseDeviceMacro(await ipc.driveRead(drivePath, s.file))),
        );
      } catch {
        failed.push(s);
      }
    }
    queue = failed;
  }
  if (!isCurrent()) return false;

  // Cache ONLY a complete, trusted result. A partial snapshot poisons the
  // Keys page (cached = never re-read → keys silently shown unassigned), so
  // an incomplete load caches nothing and the next attempt starts fresh.
  if (queue.length) {
    trace(`INCOMPLETE: ${queue.length} unread (${queue.map((s) => s.file).join(", ")}) — not caching`);
    return false;
  }
  if (listOk && (snapshot.size > 0 || configOk)) {
    trace(`complete: ${snapshot.size} assignments cached`);
    keysCache.set(drivePath, { config, assignments: snapshot });
    return true;
  }
  trace(`untrusted result (listOk=${listOk} size=${snapshot.size} configOk=${configOk}) — not caching`);
  return false;
}

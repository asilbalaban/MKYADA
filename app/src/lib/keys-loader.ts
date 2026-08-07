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
//
// Since issue #44 the load is PROGRESSIVE, polite, and mostly FREE:
//   - the config seeds the cache the moment it's read (complete:false), so
//     Setup / key test are usable seconds after plug-in;
//   - every macro lands in the cache as its read finishes; `complete` flips
//     true only at the end — a re-entered load resumes where it left off
//     instead of starting over;
//   - reads go through the background lane of the fs queue, so any
//     user-initiated drive op jumps ahead instead of waiting out the load;
//   - on proto v14 boards the device's meta.json manifest (per-file crc+size,
//     firmware-maintained) is diffed against the per-UID content cache
//     (device-state.ts): files whose signature matches hydrate with ZERO
//     link traffic, and a board seen before reconnects near-instantly.

import { invoke } from "@tauri-apps/api/core";
import { crc32Text, utf8Length } from "./crc32";
import {
  META_FILE,
  META_PROTO,
  applyMetaOverrides,
  metaStem,
  overlayAssignment,
  readMetaEntries,
} from "./device-meta";
import type { MetaEntry } from "./device-meta";
import { loadDeviceState, saveDeviceState } from "./device-state";
import type { FileSig } from "./device-state";
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
 * the cache is warm and complete (either from this load or already); false
 * means the load was incomplete/aborted and the caller should retry after a
 * beat — the partial cache stays and the retry resumes it. `isCurrent` lets
 * the caller abort a load whose drive/connection has been superseded;
 * `onProgress` feeds the non-blocking "loading keys (n/total)" banner; `uid`
 * keys the persistent content cache that makes reconnects near-free; `proto`
 * gates every manifest-based shortcut — pre-v14 firmware doesn't maintain
 * meta.json, so its signatures must never be trusted there. */
export async function loadKeysToCache(
  drivePath: string,
  isCurrent: () => boolean,
  onProgress?: (done: number, total: number) => void,
  uid?: string,
  proto = 0,
): Promise<boolean> {
  const manifestOk = proto >= META_PROTO;
  if (keysCache.get(drivePath)?.complete) return true; // already warm

  // config.json — retry while the (often serial-backed) drive is still
  // settling; a cold read throws or returns nothing.
  let config: DeviceConfig = defaultConfig();
  let configOk = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (!isCurrent()) return false;
    try {
      config = { ...config, ...JSON.parse(await ipc.driveReadBg(drivePath, "config.json")) };
      configOk = true;
      break;
    } catch {
      await sleep(200);
    }
  }
  if (!isCurrent()) return false;
  // Seed the cache the moment the config is trustworthy: Setup and the key
  // test only need this much, and they open NOW instead of after the macros.
  if (configOk) keysCache.seedPartial(drivePath, config);

  // macros dir — retry an empty listing until config has proven the drive is
  // readable (then an empty dir really means "no macros", not a cold mount).
  let existing = new Set<string>();
  let listOk = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (!isCurrent()) return false;
    try {
      const list = await ipc.driveListBg(drivePath, "macros");
      existing = new Set(list);
      listOk = true;
      if (list.length || configOk) break;
    } catch {
      // dir not browsable yet — fall through to the wait
    }
    await sleep(200);
  }
  if (!isCurrent()) return false;
  if (listOk) keysCache.seedPartial(drivePath, config);

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

  // meta.json sidecar (proto v14): speed/icon/name overrides that must shadow
  // the macro headers, exactly like the firmware's own overlay — plus the
  // firmware-maintained crc manifest the diff below runs on. One tiny read.
  let metaEntries: Record<string, MetaEntry> = {};
  if (existing.has("meta.json")) {
    metaEntries = await readMetaEntries(drivePath);
  }
  if (!isCurrent()) return false;

  // Per-UID content cache: hydrate every file whose manifest signature
  // matches what we remember — no read, no serial traffic. A missing entry
  // (older firmware, rescue write, reformat) just means "read it normally".
  const stored = uid && manifestOk ? await loadDeviceState(uid) : null;
  const rawByKey: Record<string, Assignment> = {};
  const sigs: Record<string, FileSig> = {};
  let hydrated = 0;
  const already = keysCache.get(drivePath)?.assignments;
  const total = slots.length;
  let done = 0;
  const report = () => onProgress?.(done, total);

  let queue: typeof slots = [];
  for (const s of slots) {
    if (already?.has(s.key)) {
      done++;
      continue; // an earlier round of THIS session already streamed it in
    }
    const base = s.file.split("/").pop()!;
    const entry = metaEntries[metaStem(s.file) ?? ""];
    const sig = stored?.files[base];
    const raw = stored?.assignments[s.key];
    if (
      raw &&
      sig &&
      entry &&
      typeof entry.c === "number" &&
      typeof entry.z === "number" &&
      entry.c === sig.c &&
      entry.z === sig.z
    ) {
      rawByKey[s.key] = raw;
      sigs[base] = sig;
      keysCache.setAssignment(drivePath, s.key, overlayAssignment(raw, entry));
      hydrated++;
      done++;
      continue;
    }
    queue.push(s);
  }
  if (hydrated) trace(`hydrated ${hydrated}/${total} from device-state (uid=${uid})`);
  report();

  // Read every remaining macro, and RETRY the ones that fail in later rounds:
  // a single flaky read must not surface as "this key is unassigned". (That
  // is exactly what happened in the field — layers C/D read as blank because
  // their reads hit a transient error mid-sequence and were silently skipped.)
  for (let round = 0; round < 3 && queue.length; round++) {
    if (round) {
      trace(`retry round ${round}: ${queue.length} files`);
      await sleep(400);
    }
    const failed: typeof slots = [];
    for (const s of queue) {
      if (!isCurrent()) return false;
      try {
        const text = await ipc.driveReadBg(drivePath, s.file);
        const stem = metaStem(s.file);
        const entry = stem ? metaEntries[stem] : undefined;
        const mf = parseDeviceMacro(text);
        const raw = parseAssignment(mf);
        rawByKey[s.key] = raw;
        const base = s.file.split("/").pop()!;
        sigs[base] =
          entry && typeof entry.c === "number" && typeof entry.z === "number"
            ? { c: entry.c, z: entry.z }
            : { c: crc32Text(text), z: utf8Length(text) };
        keysCache.setAssignment(
          drivePath,
          s.key,
          parseAssignment(applyMetaOverrides(mf, entry)),
        );
        done++;
        report();
      } catch {
        failed.push(s);
      }
    }
    queue = failed;
  }
  if (!isCurrent()) return false;

  if (queue.length) {
    // The partial snapshot STAYS — everything already read keeps working and
    // the caller's retry resumes from here. It just isn't complete yet.
    trace(`INCOMPLETE: ${queue.length} unread (${queue.map((s) => s.file).join(", ")})`);
    return false;
  }
  if (listOk && (done > 0 || configOk)) {
    trace(`complete: ${done} assignments cached (${hydrated} without reads)`);
    if (!keysCache.get(drivePath)) {
      keysCache.set(drivePath, { config, assignments: new Map() });
    }
    keysCache.markComplete(drivePath);
    if (manifestOk && configOk) {
      // Backfill the on-device manifest for files it doesn't cover yet — a
      // board freshly upgraded to v14 has macros but an empty meta.json, and
      // without c/z there the next connect can never skip a read. We just
      // read those very bytes, so their signatures are free; the firmware
      // picks the rewrite up like any meta.json write. Overrides are
      // preserved (read-modify-write of the same entries object).
      const missing = Object.entries(sigs).filter(([base]) => {
        const e = metaEntries[metaStem(`macros/${base}`) ?? ""];
        return !e || typeof e.c !== "number" || typeof e.z !== "number";
      });
      if (missing.length) {
        trace(`backfilling manifest for ${missing.length} files`);
        for (const [base, sig] of missing) {
          const stem = metaStem(`macros/${base}`);
          if (stem) metaEntries[stem] = { ...metaEntries[stem], c: sig.c, z: sig.z };
        }
        await ipc
          .driveWrite(
            drivePath,
            META_FILE,
            JSON.stringify({ format: "mkyada-meta", version: 1, entries: metaEntries }),
          )
          .catch(() => {});
      }
      // Remember what we saw so the NEXT connect of this board is free.
      if (uid) {
        await saveDeviceState(uid, {
          files: sigs,
          config,
          assignments: rawByKey,
          savedAt: new Date().toISOString(),
        });
      }
    }
    return true;
  }
  trace(`untrusted result (listOk=${listOk} done=${done} configOk=${configOk}) — not caching`);
  return false;
}

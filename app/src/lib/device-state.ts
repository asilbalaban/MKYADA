// Per-board persistent content cache (issue #44), keyed by the board's UID.
//
// The connect-time loader used to re-read every macro off the keypad on every
// plug-in — 1–2 minutes on a loaded Vision 6, multiplied by every board in a
// QA session. Since proto v14 the device keeps a CRC manifest in
// /macros/meta.json (c = crc32, z = size per file, firmware-maintained), so
// the app can now diff instead of re-reading: a file whose manifest signature
// matches what this store remembers is hydrated from here with ZERO link
// traffic, and only new/changed files are actually read.
//
// What's stored per UID: the config, every parsed assignment (RAW — without
// meta overrides, which are re-applied fresh from the sidecar on every
// connect), and each file's {c, z} signature. Recorded macros live here in
// full — that is precisely what makes a reconnect free.
//
// Self-healing by construction: anything that bypasses the manifest (rescue
// console writes, an older firmware, a reformatted board with no meta.json)
// yields a missing/mismatched signature and the file is simply re-read.

import { LazyStore } from "@tauri-apps/plugin-store";
import type { Assignment, DeviceConfig } from "./types";

/** A file's manifest signature — mirrors meta.json's `c`/`z`. */
export interface FileSig {
  c: number;
  z: number;
}

export interface StoredDeviceState {
  files: Record<string, FileSig>;
  config: DeviceConfig;
  /** slotKey → RAW assignment (no meta overrides applied). */
  assignments: Record<string, Assignment>;
  savedAt: string;
  fw?: string;
}

const store = new LazyStore("device-state.json");

export async function loadDeviceState(uid: string): Promise<StoredDeviceState | null> {
  if (!uid) return null;
  try {
    const all =
      (await store.get<Record<string, StoredDeviceState>>("boards")) ?? {};
    const s = all[uid.toLowerCase()];
    return s && s.files && s.config && s.assignments ? s : null;
  } catch {
    return null;
  }
}

export async function saveDeviceState(uid: string, state: StoredDeviceState): Promise<void> {
  if (!uid) return;
  try {
    const all =
      (await store.get<Record<string, StoredDeviceState>>("boards")) ?? {};
    all[uid.toLowerCase()] = state;
    await store.set("boards", all);
    await store.save();
  } catch {
    // best-effort: a failed save only costs a re-read next connect
  }
}

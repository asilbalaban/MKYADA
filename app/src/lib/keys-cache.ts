// In-memory snapshot of the Keys page per drive (issue #14). Every macro on
// the keypad is written through this app, so once the page has streamed the
// assignments in they stay valid across tab switches — no need to re-read
// them from the keypad ten seconds later. Writers (Keys save, Recorder
// assign) update the snapshot in place; config rewrites invalidate it.
//
// Since issue #44 the snapshot fills PROGRESSIVELY: the config lands the
// moment it's read (complete:false), each macro follows as its read finishes,
// and `complete` flips true only when every listed file made it in. Consumers
// that must not mistake "not read yet" for "unassigned" check `complete`;
// consumers that only need the config (Setup, key test) are usable seconds
// after plug-in instead of minutes.

import type { Assignment, DeviceConfig } from "./types";

export interface KeysSnapshot {
  config: DeviceConfig;
  assignments: Map<string, Assignment>;
  /** True once every listed macro file has been read into `assignments`.
   * While false, a missing key may simply not have streamed in yet. */
  complete: boolean;
}

/** Slot identifier shared by the Keys page and the cache: "key:layer".
 * Keys are numbers; Vision 6 module slots use their name ("enc-cw", …).
 * A module slot's home/menu context override is global (no layer):
 * "enc-cw@home". */
export function slotKey(slot: number | string, layerIndex: number, ctx = "grid"): string {
  return ctx !== "grid" ? `${slot}@${ctx}` : `${slot}:${layerIndex}`;
}

const cache = new Map<string, KeysSnapshot>();

// Subscribers (e.g. the native sound-key map builder) notified whenever the
// cached assignments change, so anything derived from them stays in sync.
const subscribers = new Set<() => void>();
const notify = () => subscribers.forEach((cb) => cb());

export const keysCache = {
  get(drive: string): KeysSnapshot | undefined {
    return cache.get(drive);
  },

  set(drive: string, snap: { config: DeviceConfig; assignments: Map<string, Assignment>; complete?: boolean }): void {
    cache.set(drive, {
      config: snap.config,
      assignments: new Map(snap.assignments),
      complete: snap.complete ?? true,
    });
    notify();
  },

  /** Seed a config-only snapshot the moment config.json is read (issue #44):
   * Setup and the key test become usable immediately; the assignments then
   * stream in one by one via setAssignment. Never downgrades a warm one. */
  seedPartial(drive: string, config: DeviceConfig): void {
    const cur = cache.get(drive);
    if (cur) return;
    cache.set(drive, { config, assignments: new Map(), complete: false });
    notify();
  },

  /** Record a saved (or cleared) key without invalidating the snapshot.
   * A missing snapshot is fine — the next full load will pick the file up. */
  setAssignment(drive: string, slot: string, a: Assignment | null): void {
    const snap = cache.get(drive);
    if (!snap) return;
    if (a) snap.assignments.set(slot, a);
    else snap.assignments.delete(slot);
    notify();
  },

  /** Every listed file made it in — the snapshot can be trusted as the whole
   * truth ("not in the map" now really means "unassigned"). */
  markComplete(drive: string): void {
    const snap = cache.get(drive);
    if (!snap || snap.complete) return;
    snap.complete = true;
    notify();
  },

  /** Fold a config change into the snapshot without dropping the streamed
   * assignments (issue #45) — for edits that can't move keys or layers
   * around (layer names, band toggles, timeout …). */
  patchConfig(drive: string, patch: Partial<DeviceConfig>): void {
    const snap = cache.get(drive);
    if (!snap) return;
    snap.config = { ...snap.config, ...patch };
    notify();
  },

  /** Drop a snapshot after something rewrote the device config (Setup /
   * Settings) — key count or layers may have changed under it. */
  invalidate(drive?: string): void {
    if (drive) cache.delete(drive);
    else cache.clear();
    notify();
  },

  /** Subscribe to assignment-set changes; returns an unsubscribe fn. */
  onChange(cb: () => void): () => void {
    subscribers.add(cb);
    return () => subscribers.delete(cb);
  },
};

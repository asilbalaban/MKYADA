// In-memory snapshot of the Keys page per drive (issue #14). Every macro on
// the keypad is written through this app, so once the page has streamed the
// assignments in they stay valid across tab switches — no need to re-read
// them from the keypad ten seconds later. Writers (Keys save, Recorder
// assign) update the snapshot in place; config rewrites invalidate it.

import type { Assignment, DeviceConfig } from "./types";

export interface KeysSnapshot {
  config: DeviceConfig;
  assignments: Map<string, Assignment>;
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

  set(drive: string, snap: KeysSnapshot): void {
    cache.set(drive, { config: snap.config, assignments: new Map(snap.assignments) });
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

// Parsed-macro cache shared between the Keys page (which writes macros) and the
// host-action runner in profiles.tsx (which reads them on every key press).
//
// A "sound" / "launch" / "webhook" key only carries a no-op macro on the device;
// the desktop app performs the real action when the key is pressed. It used to
// read and parse the macro file from the USB drive on EVERY press to discover
// what to do — a slow, contended round-trip that, when the key is tapped
// rapidly, queues up and intermittently fails. The result was sound effects
// that lagged or dropped ("sometimes it plays, sometimes it doesn't"). Caching
// the parsed macro makes the second press onward instant and reliable; the
// cache is invalidated whenever the file is rewritten (device macro_changed, or
// an in-app save) so it can never serve a stale action.

import type { MacroFile } from "./types";

const cache = new Map<string, MacroFile>();

// Subscribers notified whenever the macro set changes (a file was rewritten or
// the cache cleared). The native sound-key map is rebuilt from this so it stays
// in sync with in-app edits and on-device reassigns.
const subscribers = new Set<() => void>();
const notify = () => subscribers.forEach((cb) => cb());

const norm = (file: string) => file.replace(/^\//, "");
const keyFor = (drive: string, file: string) => `${drive}|${norm(file)}`;

export const macroFileCache = {
  get(drive: string, file: string): MacroFile | undefined {
    return cache.get(keyFor(drive, file));
  },
  set(drive: string, file: string, mf: MacroFile): void {
    cache.set(keyFor(drive, file), mf);
  },
  /** Drop one file (it was rewritten) — next press re-reads it fresh. */
  invalidate(drive: string, file: string): void {
    cache.delete(keyFor(drive, file));
    notify();
  },
  /** Drop every entry for a drive (disconnect / reconnect / re-sync). */
  clearDrive(drive: string): void {
    const prefix = `${drive}|`;
    for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
    notify();
  },
  clear(): void {
    cache.clear();
    notify();
  },
  /** Subscribe to macro-set changes; returns an unsubscribe fn. */
  onChange(cb: () => void): () => void {
    subscribers.add(cb);
    return () => subscribers.delete(cb);
  },
};

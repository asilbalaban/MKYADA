// The system-wide "stop playback" hotkey (Rust: src-tauri/src/remote.rs).
// Rust owns registration and persists the choice as `stopHotkey` in
// settings.json; this module mirrors its status for the Settings card and the
// playback bar's hint.

import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface StopHotkeyStatus {
  /** accelerator in force, e.g. "Ctrl+Alt+Shift+S"; "" = turned off */
  accel: string;
  default: string;
  /** false when off, or when the OS refused it (see error) */
  registered: boolean;
  error: string | null;
}

let status: StopHotkeyStatus | null = null;
let loading = false;
const listeners = new Set<() => void>();

function publish(s: StopHotkeyStatus) {
  status = s;
  listeners.forEach((l) => l());
}

export async function refreshStopHotkey(): Promise<void> {
  if (loading) return;
  loading = true;
  try {
    const s = await invoke<StopHotkeyStatus | null>("stop_hotkey_status");
    if (s) publish(s);
  } catch {
    // older backend / browser preview without the command — no hint shown
  } finally {
    loading = false;
  }
}

/** Register a new accelerator ("" turns the hotkey off). Rejects with a
 * readable message when the accelerator doesn't parse; an OS-level
 * registration failure resolves with `error` set instead. */
export async function setStopHotkey(accel: string): Promise<StopHotkeyStatus> {
  try {
    const s = await invoke<StopHotkeyStatus>("stop_hotkey_set", { accel });
    publish(s);
    return s;
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
  }
}

export function useStopHotkey(): StopHotkeyStatus | null {
  const s = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    () => status,
  );
  useEffect(() => {
    if (!status) void refreshStopHotkey();
  }, []);
  return s;
}

export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
}

// Live system variables (CPU / RAM / mic mute) streamed from the Rust side
// every 2 s as "vars:changed". Feeds the status strip and the optional
// LED-feedback rule (mic muted -> keypad LED red).

import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";

export interface SystemVars {
  cpu: number;
  mem_used: number;
  mem_total: number;
  mic_muted: boolean | null;
}

let vars: SystemVars | null = null;
const listeners = new Set<() => void>();

/** Call once at boot. */
export function initVariables() {
  void listen("vars:changed", (e) => {
    vars = e.payload as SystemVars;
    listeners.forEach((l) => l());
  });
}

export function useSystemVars(): SystemVars | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => vars,
  );
}

// Computer-side half of a REMOTE key press (proto v17 `press`), plus the
// registry of running multi actions that physical and remote presses share.
//
// A physical press reaches the app as a `btn` edge and profiles.tsx performs
// the launch/command/sound/webhook/OBS/mic side. A remote press (the Control
// page, Keys "Run on keypad", the playback bar's "Run again") streams no edge
// — the keypad only announces `play_start` with `src:"remote"`. So that one
// message is where the app performs the computer-side action, for every entry
// point at once. Keys with double/long-press variants are left alone: the
// firmware announces the chosen variant as `key_action`, which is already
// handled, and running them here too would fire the action twice.
//
// Pure decisions live here (unit-tested); the wiring is in profiles.tsx.

import { sequenceIsPureHid } from "./macro-model";
import type { Assignment, SequenceStep } from "./types";

export interface RemoteStart {
  key: number;
  /** layer letter */
  layer: string;
  /** macro path without the leading slash ("macros/key3-b.json") */
  file: string;
  /** profile id when the keypad played a profile file (p_<id>_keyN.json) */
  profileId: string | null;
}

/** A `play_start` that a remote press caused, or null for anything else
 * (physical presses, the app's own `play`, wheel slots). */
export function parseRemoteStart(m: Record<string, unknown>): RemoteStart | null {
  if (m.t !== "play_start" || m.src !== "remote") return null;
  if (typeof m.key !== "number" || !Number.isFinite(m.key)) return null;
  const file = typeof m.file === "string" ? m.file.replace(/^\//, "") : "";
  if (!file) return null;
  const layer = typeof m.layer === "string" && m.layer ? m.layer : "a";
  const pm = /(?:^|\/)p_(.+)_key\d+\.json$/.exec(file);
  return { key: m.key, layer, file, profileId: pm ? pm[1] : null };
}

export type RemotePlan =
  | { type: "none" }
  | { type: "host"; a: Assignment }
  | { type: "sequence"; steps: SequenceStep[]; speed: number };

/** What the app must do for a remotely pressed key with this assignment. */
export function remotePlan(a: Assignment | null | undefined): RemotePlan {
  if (!a || a.kind === "none") return { type: "none" };
  // key logic: the firmware resolves the gesture and announces key_action
  if (a.variants?.double || a.variants?.hold) return { type: "none" };
  switch (a.kind) {
    case "launch":
    case "command":
    case "sound":
    case "webhook":
    case "obs":
      return { type: "host", a };
    case "mic":
      // push-to-talk is "unmute while held" — a remote press has nothing to
      // hold, so unmute+mute at once would do nothing useful (Control
      // disables these keys)
      return a.mode === "push_to_talk" ? { type: "none" } : { type: "host", a };
    case "sequence":
      return sequenceIsPureHid(a.steps)
        ? { type: "none" } // one HID file: the keypad already played it
        : { type: "sequence", steps: a.steps, speed: a.speed ?? 1 };
    default:
      return { type: "none" }; // pure HID: the keypad did everything
  }
}

// ---------------------------------------------------------- sequences ---
// Mixed multi actions run in the app step by step. Every run is registered
// under its key id ("3:a", or a module slot "enc-cw") so a re-press — physical
// or remote — and any Stop (app, hotkey, tray) can cancel it.

export interface SequenceRun {
  cancelled: boolean;
}

const runs = new Map<string, SequenceRun>();
const listeners = new Set<() => void>();
let snapshot: ReadonlySet<string> = new Set();

function changed() {
  snapshot = new Set(runs.keys());
  listeners.forEach((l) => l());
}

/** Numbered key of a run id ("3:a" -> 3); null for module slots. */
export function keyOfId(id: string): number | null {
  const m = /^(\d+):/.exec(id);
  return m ? Number(m[1]) : null;
}

export const sequenceRuns = {
  get(id: string): SequenceRun | undefined {
    return runs.get(id);
  },
  start(id: string): SequenceRun {
    const run = { cancelled: false };
    runs.set(id, run);
    changed();
    return run;
  },
  end(id: string, run: SequenceRun): void {
    if (runs.get(id) !== run) return;
    runs.delete(id);
    changed();
  },
  /** Cancel every run of numbered key `n` (any layer). True if one ran. */
  cancelKey(n: number): boolean {
    let hit = false;
    for (const [id, run] of runs) {
      if (keyOfId(id) === n) {
        run.cancelled = true;
        runs.delete(id);
        hit = true;
      }
    }
    if (hit) changed();
    return hit;
  },
  /** A Stop from anywhere ends every multi action. */
  cancelAll(): void {
    if (!runs.size) return;
    for (const run of runs.values()) run.cancelled = true;
    runs.clear();
    changed();
  },
  /** Ids ("3:a") of the running multi actions (stable between changes). */
  running(): ReadonlySet<string> {
    return snapshot;
  },
  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => void listeners.delete(cb);
  },
};

// One-shot handoff for "edit this key's macro in the Recorder" (Keys page →
// Recorder page). A module-level stash is enough: the two pages never render
// at the same time, and the value is consumed on the Recorder's first mount.

import type { MacroFile } from "./types";

export interface RecorderEdit {
  macro: MacroFile;
  /** Key (and layer) the macro came from — preselected in "Put it on a key". */
  key: number;
  layer: number;
}

let pending: RecorderEdit | null = null;

export function stashRecorderEdit(edit: RecorderEdit) {
  pending = edit;
}

export function takeRecorderEdit(): RecorderEdit | null {
  const p = pending;
  pending = null;
  return p;
}

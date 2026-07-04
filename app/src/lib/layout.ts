// The user's real keyboard layout, resolved by the Rust side.
//
// Macro key labels are positional (US physical keys) because that's what the
// keypad sends as HID; the OS renders them through the active layout. This
// module answers two questions so the UI never lies about layouts:
//   displayKey("/")      -> "." on a Turkish keyboard (what that key types)
//   charToKeystroke("ç") -> { key: ".", shift: false } (which physical key
//                           to press to type that character)
// Until the map loads (or off-Tauri, e.g. tests), US fallback applies.

import { useSyncExternalStore } from "react";

export interface KeyChars {
  base: string;
  shift: string;
  /** AltGr (right-Alt / Option) character — how Turkish layouts reach "@". */
  altgr: string;
}

export interface Keystroke {
  key: string;
  shift: boolean;
  altgr?: boolean;
}

let MAP: Record<string, KeyChars> = {};
let REVERSE: Record<string, Keystroke> = {};
let version = 0;
const listeners = new Set<() => void>();

// US-layout fallback tables (also what tests exercise under Node).
const US_SHIFT_MAP: Record<string, string> = {
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7",
  "*": "8", "(": "9", ")": "0", "_": "-", "+": "=", "{": "[", "}": "]",
  "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/", "~": "`",
};
const US_DIRECT = new Set("abcdefghijklmnopqrstuvwxyz0123456789-=[]\\;'`,./");

function rebuildReverse() {
  REVERSE = {};
  // precedence when a char appears on several keys: base > shift > altgr
  for (const [label, ch] of Object.entries(MAP)) {
    if (ch.altgr && !(ch.altgr in REVERSE)) {
      REVERSE[ch.altgr] = { key: label, shift: false, altgr: true };
    }
  }
  for (const [label, ch] of Object.entries(MAP)) {
    if (ch.shift) REVERSE[ch.shift] = { key: label, shift: true };
  }
  for (const [label, ch] of Object.entries(MAP)) {
    if (ch.base) REVERSE[ch.base] = { key: label, shift: false };
  }
}

async function refresh() {
  // lazy import so this module stays loadable outside Tauri (unit tests)
  const { invoke } = await import("@tauri-apps/api/core");
  const map = await invoke<Record<string, KeyChars>>("keyboard_layout");
  if (!map || Object.keys(map).length === 0) return;
  MAP = map;
  rebuildReverse();
  version++;
  listeners.forEach((l) => l());
}

/** Load the layout map and keep it fresh when the user switches layouts. */
export function initLayout() {
  void refresh().catch(() => {});
  // layout switches happen outside the app; re-check whenever we get focus
  window.addEventListener("focus", () => void refresh().catch(() => {}));
}

/** Re-render when the layout map (finally) arrives or changes. */
export function useLayoutVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
  );
}

/**
 * What a positional key label types on the user's layout — for display only;
 * stored macros keep positional labels.
 */
export function displayKey(label: string): string {
  return MAP[label]?.base || label;
}

/**
 * Which physical key (positional label) + modifier produces a character on
 * the user's layout. Null when the character needs dead keys or isn't on the
 * layout at all.
 */
/**
 * Characters in a text that no single keystroke on the user's layout can
 * produce (IME-composed scripts like Hangul/Kanji, dead-key accents). The
 * UI warns instead of silently skipping them at compile time.
 */
export function untypeableChars(text: string): string[] {
  const bad = new Set<string>();
  for (const ch of text) {
    if (ch === "\n" || ch === "\t" || ch === " ") continue;
    if (!charToKeystroke(ch)) bad.add(ch);
  }
  return [...bad];
}

export function charToKeystroke(ch: string): Keystroke | null {
  if (Object.keys(REVERSE).length) return REVERSE[ch] ?? null;
  // US fallback
  const lower = ch.toLowerCase();
  if (ch !== lower && US_DIRECT.has(lower)) return { key: lower, shift: true };
  if (US_DIRECT.has(ch)) return { key: ch, shift: false };
  if (US_SHIFT_MAP[ch]) return { key: US_SHIFT_MAP[ch], shift: true };
  return null;
}

// Macro JSON model: compiling key assignments into mkyada-macro files and
// parsing them back for editing. "Everything is JSON": every assignment —
// even a plain Ctrl+A — becomes a macro file on the device.

import type { Assignment, DeviceConfig, MacroEvent, MacroFile } from "./types";
import { LAYER_NAMES } from "./types";

export const MEDIA_USAGES = [
  "play_pause",
  "next_track",
  "prev_track",
  "stop",
  "mute",
  "volume_up",
  "volume_down",
  "brightness_up",
  "brightness_down",
] as const;

export const MODIFIERS = ["CTRL", "SHIFT", "ALT", "WIN"] as const;

const MOD_TO_LABEL: Record<string, string> = {
  CTRL: "ctrl_l",
  SHIFT: "shift_l",
  ALT: "alt_l",
  WIN: "cmd_l",
};

// US-layout: shifted symbol -> base key
const SHIFT_MAP: Record<string, string> = {
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7",
  "*": "8", "(": "9", ")": "0", "_": "-", "+": "=", "{": "[", "}": "]",
  "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/", "~": "`",
};

const DIRECT_CHARS = new Set("abcdefghijklmnopqrstuvwxyz0123456789-=[]\\;'`,./");

/** Special keys assignable as a single keystroke. */
export const SPECIAL_KEYS = [
  "enter", "esc", "tab", "space", "backspace", "delete", "insert",
  "home", "end", "page_up", "page_down", "up", "down", "left", "right",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
];

export function macroFileName(keyNo: number, layerIndex: number): string {
  const suffix = layerIndex > 0 ? `-${LAYER_NAMES[layerIndex]}` : "";
  return `macros/key${keyNo}${suffix}.json`;
}

function keyTap(key: string, delayBefore: number, holdMs = 30): MacroEvent[] {
  return [
    { delay: delayBefore, type: "key", action: "down", key },
    { delay: holdMs, type: "key", action: "up", key },
  ];
}

function comboEvents(mods: string[], key: string): MacroEvent[] {
  const events: MacroEvent[] = [];
  for (const m of mods) {
    events.push({ delay: events.length ? 10 : 0, type: "key", action: "down", key: MOD_TO_LABEL[m] ?? m.toLowerCase() });
  }
  events.push({ delay: 10, type: "key", action: "down", key: key.toLowerCase() });
  events.push({ delay: 30, type: "key", action: "up", key: key.toLowerCase() });
  for (const m of [...mods].reverse()) {
    events.push({ delay: 10, type: "key", action: "up", key: MOD_TO_LABEL[m] ?? m.toLowerCase() });
  }
  return events;
}

function textEvents(text: string): MacroEvent[] {
  const events: MacroEvent[] = [];
  for (const ch of text) {
    let base = ch;
    let shifted = false;
    if (ch === "\n") base = "enter";
    else if (ch === "\t") base = "tab";
    else if (ch === " ") base = "space";
    else if (ch >= "A" && ch <= "Z") {
      base = ch.toLowerCase();
      shifted = true;
    } else if (SHIFT_MAP[ch]) {
      base = SHIFT_MAP[ch];
      shifted = true;
    } else if (!DIRECT_CHARS.has(ch)) {
      continue; // not representable on a US-layout HID report
    }
    if (shifted) events.push({ delay: 10, type: "key", action: "down", key: "shift_l" });
    events.push(...keyTap(base, shifted ? 5 : 10, 20));
    if (shifted) events.push({ delay: 5, type: "key", action: "up", key: "shift_l" });
  }
  if (events.length) events[0] = { ...events[0], delay: 0 };
  return events;
}

/** Compile an assignment to a macro file, or null when the key is unassigned. */
export function compileAssignment(a: Assignment, name?: string): MacroFile | null {
  const base = {
    format: "mkyada-macro" as const,
    version: 2,
    created: new Date().toISOString(),
  };
  switch (a.kind) {
    case "none":
      return null;
    case "keystroke":
      return { ...base, name: name ?? a.key, kind: "keystroke", combo: { mods: [], key: a.key }, events: keyTap(a.key, 0) };
    case "combo":
      return {
        ...base,
        name: name ?? [...a.mods, a.key.toUpperCase()].join("+"),
        kind: "combo",
        combo: { mods: a.mods, key: a.key },
        events: comboEvents(a.mods, a.key),
      };
    case "text":
      return { ...base, name: name ?? `Type: ${a.text.slice(0, 24)}`, kind: "text", text: a.text, events: textEvents(a.text) };
    case "media":
      return {
        ...base,
        name: name ?? a.usage,
        kind: "media",
        media: a.usage,
        events: [{ delay: 0, type: "consumer", usage: a.usage }],
      };
    case "recorded":
      return { ...migrateMacro(a.macro), name: name ?? a.name };
    case "launch":
      return null; // host-mode only, never written to the device
  }
}

/** Parse a macro file back into an editable assignment via its kind metadata. */
export function parseAssignment(m: MacroFile): Assignment {
  switch (m.kind) {
    case "keystroke":
      return { kind: "keystroke", key: m.combo?.key ?? "" };
    case "combo":
      return { kind: "combo", mods: m.combo?.mods ?? [], key: m.combo?.key ?? "" };
    case "text":
      return { kind: "text", text: m.text ?? "" };
    case "media":
      return { kind: "media", usage: m.media ?? "" };
    default:
      return { kind: "recorded", name: m.name ?? "macro", macro: m };
  }
}

/** Accept legacy asil-macro v1 files and rewrite them as v2. */
export function migrateMacro(m: MacroFile): MacroFile {
  if (m.format === "asil-macro") {
    return { ...m, format: "mkyada-macro", version: 2, kind: m.kind ?? "recorded" };
  }
  return m;
}

export function describeAssignment(a: Assignment): string {
  switch (a.kind) {
    case "none":
      return "Not assigned";
    case "keystroke":
      return a.key.toUpperCase();
    case "combo":
      return [...a.mods, a.key.toUpperCase()].join(" + ");
    case "text":
      return `Type "${a.text.length > 18 ? a.text.slice(0, 18) + "…" : a.text}"`;
    case "media":
      return a.usage.replace(/_/g, " ");
    case "recorded":
      return `▶ ${a.name}`;
    case "launch":
      return `↗ ${a.target.length > 20 ? a.target.slice(0, 20) + "…" : a.target}`;
  }
}

/** File name for a profile-scoped macro synced to the device drive. */
export function profileMacroFileName(profileId: string, keyNo: number): string {
  return `macros/p_${profileId}_key${keyNo}.json`;
}

export function defaultConfig(): DeviceConfig {
  return {
    format: "mkyada-config",
    version: 1,
    key_count: 6,
    layer_key: null,
    layer_count: 2,
    layer_mode: "toggle",
    screen: { width: screen.width, height: screen.height },
  };
}

/** Number of assignable macro slots for a config (the layer key isn't one). */
export function macroSlots(cfg: DeviceConfig): number {
  const keys = cfg.layer_key ? cfg.key_count - 1 : cfg.key_count;
  const layers = cfg.layer_key ? cfg.layer_count : 1;
  return keys * layers;
}

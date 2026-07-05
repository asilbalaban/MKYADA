// Macro JSON model: compiling key assignments into mkyada-macro files and
// parsing them back for editing. "Everything is JSON": every assignment —
// even a plain Ctrl+A — becomes a macro file on the device.

import type { Assignment, DeviceConfig, MacroEvent, MacroFile } from "./types";
import { LAYER_NAMES } from "./types";
import { charToKeystroke, displayKey } from "./layout";

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

export const IS_MAC = navigator.platform.toUpperCase().includes("MAC");

/**
 * Display name for a canonical modifier. Stored mods stay canonical
 * (CTRL/SHIFT/ALT/WIN) so macro JSONs are portable; only the UI adapts —
 * the HID "GUI" modifier is the Windows key on Windows and ⌘ on macOS,
 * and ALT is ⌥ Option on macOS.
 */
export function modifierDisplay(mod: string): string {
  if (!IS_MAC) return mod;
  return { CTRL: "⌃ CTRL", SHIFT: "⇧ SHIFT", ALT: "⌥ OPT", WIN: "⌘ CMD" }[mod] ?? mod;
}

// KeyboardEvent.code -> macro key label (layout-independent physical keys).
const CODE_TO_KEY: Record<string, string> = {
  Enter: "enter", Escape: "esc", Tab: "tab", Space: "space",
  Backspace: "backspace", Delete: "delete", Insert: "insert",
  Home: "home", End: "end", PageUp: "page_up", PageDown: "page_down",
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
  Backslash: "\\", Semicolon: ";", Quote: "'", Backquote: "`",
  Comma: ",", Period: ".", Slash: "/",
};

/** KeyboardEvent.code -> modifier label, for contexts (macro row editing)
 * where a bare modifier press is itself the key being set. */
export const MODIFIER_CODE_TO_KEY: Record<string, string> = {
  ShiftLeft: "shift_l", ShiftRight: "shift_r",
  ControlLeft: "ctrl_l", ControlRight: "ctrl_r",
  AltLeft: "alt_l", AltRight: "alt_r",
  MetaLeft: "cmd_l", MetaRight: "cmd_r",
  CapsLock: "caps_lock",
};

/**
 * Map a captured keydown to a macro key label, or null for events we can't
 * assign (bare modifier presses, media keys, …). Uses e.code so the physical
 * key wins regardless of the OS keyboard layout — matching what the keypad
 * will send as a US-layout HID report.
 */
export function keyFromEvent(e: KeyboardEvent): string | null {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(c)) return c.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(c)) return c.toLowerCase();
  return CODE_TO_KEY[c] ?? null;
}

/** Canonical modifiers held during a captured keydown. */
export function modsFromEvent(e: KeyboardEvent): string[] {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("CTRL");
  if (e.shiftKey) mods.push("SHIFT");
  if (e.altKey) mods.push("ALT");
  if (e.metaKey) mods.push("WIN");
  return mods;
}

/** Last path segment — for showing "Google Chrome.app" instead of the full path. */
export function fileBaseName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
}

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
    let mods: string[] = [];
    if (ch === "\n") base = "enter";
    else if (ch === "\t") base = "tab";
    else if (ch === " ") base = "space";
    else {
      // layout-aware: on a Turkish keyboard "ç" compiles to the physical key
      // that types it there (US "." position) and "@" to AltGr+Q, so the
      // keypad reproduces exactly what the user's layout renders
      const ks = charToKeystroke(ch);
      if (!ks) continue; // needs dead keys — not reachable via plain HID
      base = ks.key;
      if (ks.shift) mods.push("shift_l");
      if (ks.altgr) mods.push("alt_gr");
    }
    for (const m of mods) events.push({ delay: 10, type: "key", action: "down", key: m });
    events.push(...keyTap(base, mods.length ? 5 : 10, 20));
    for (const m of [...mods].reverse()) events.push({ delay: 5, type: "key", action: "up", key: m });
  }
  if (events.length) events[0] = { ...events[0], delay: 0 };
  return events;
}

/** True when the assignment has everything it needs to be saved. */
export function assignmentComplete(a: Assignment): boolean {
  switch (a.kind) {
    case "keystroke":
    case "combo":
      return !!a.key;
    case "text":
      return a.text.length > 0;
    case "launch":
      return a.target.length > 0;
    case "command":
      return a.command.length > 0;
    case "sound":
      return a.file.length > 0;
    default:
      return true;
  }
}

/** Compile an assignment to a macro file, or null when the key is unassigned. */
export function compileAssignment(a: Assignment, name?: string): MacroFile | null {
  const base = {
    format: "mkyada-macro" as const,
    version: 2,
    created: new Date().toISOString(),
  };
  const compiled = ((): MacroFile | null => {
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
      // launch/command can't be expressed as HID: stored as no-op files
      // (empty events) so the assignment travels with the device; the
      // desktop app watches key presses and performs the action.
      case "launch":
        return { ...base, name: name ?? `Open ${a.target}`, kind: "launch", target: a.target, events: [] };
      case "command":
        return { ...base, name: name ?? `Run ${a.command.slice(0, 24)}`, kind: "command", command: a.command, events: [] };
      case "sound":
        return {
          ...base,
          name: name ?? `Sound ${fileBaseName(a.file)}`,
          kind: "sound",
          sound: a.file,
          ...(a.holdAction && a.holdAction !== "stop" ? { sound_hold: a.holdAction } : {}),
          events: [],
        };
    }
  })();
  // behavior options ride along in settings, whatever the kind
  if (compiled && a.behavior) {
    const { on_repress, hold_repeat } = a.behavior;
    compiled.settings = {
      ...compiled.settings,
      ...(on_repress && on_repress !== "stop" ? { on_repress } : {}),
      ...(hold_repeat ? { hold_repeat } : {}),
    };
  }
  return compiled;
}

/** Parse a macro file back into an editable assignment via its kind metadata. */
export function parseAssignment(m: MacroFile): Assignment {
  const behavior =
    m.settings?.on_repress === "restart" || m.settings?.hold_repeat
      ? {
          behavior: {
            ...(m.settings?.on_repress ? { on_repress: m.settings.on_repress } : {}),
            ...(m.settings?.hold_repeat ? { hold_repeat: true } : {}),
          },
        }
      : {};
  switch (m.kind) {
    case "keystroke":
      return { kind: "keystroke", key: m.combo?.key ?? "", ...behavior };
    case "combo":
      return { kind: "combo", mods: m.combo?.mods ?? [], key: m.combo?.key ?? "", ...behavior };
    case "text":
      return { kind: "text", text: m.text ?? "", ...behavior };
    case "media":
      return { kind: "media", usage: m.media ?? "", ...behavior };
    case "launch":
      return { kind: "launch", target: m.target ?? "", ...behavior };
    case "command":
      return { kind: "command", command: m.command ?? "", ...behavior };
    case "sound":
      return {
        kind: "sound",
        file: m.sound ?? "",
        ...(m.sound_hold ? { holdAction: m.sound_hold } : {}),
        ...behavior,
      };
    default:
      return { kind: "recorded", name: m.name ?? "macro", macro: m, ...behavior };
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
      return displayKey(a.key).toUpperCase();
    case "combo":
      return [...a.mods.map(modifierDisplay), displayKey(a.key).toUpperCase()].join(" + ");
    case "text":
      return `Type "${a.text.length > 18 ? a.text.slice(0, 18) + "…" : a.text}"`;
    case "media":
      return a.usage.replace(/_/g, " ");
    case "recorded":
      return `▶ ${a.name}`;
    case "launch": {
      const short = fileBaseName(a.target);
      return `↗ ${short.length > 20 ? short.slice(0, 20) + "…" : short}`;
    }
    case "command":
      return `$ ${a.command.length > 20 ? a.command.slice(0, 20) + "…" : a.command}`;
    case "sound": {
      const short = fileBaseName(a.file);
      return `♪ ${short.length > 20 ? short.slice(0, 20) + "…" : short}`;
    }
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
    key_map: null,
    busy_other: "ignore",
    screen: { width: screen.width, height: screen.height },
  };
}

/** Number of assignable macro slots for a config (the layer key isn't one). */
export function macroSlots(cfg: DeviceConfig): number {
  const keys = cfg.layer_key ? cfg.key_count - 1 : cfg.key_count;
  const layers = cfg.layer_key ? cfg.layer_count : 1;
  return keys * layers;
}

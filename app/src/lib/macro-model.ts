// Macro JSON model: compiling key assignments into mkyada-macro files and
// parsing them back for editing. "Everything is JSON": every assignment —
// even a plain Ctrl+A — becomes a macro file on the device.

import type {
  Assignment,
  DeviceConfig,
  MacroEvent,
  MacroFile,
  MenuAction,
  MicMode,
  ModuleSlot,
  ScrollDir,
  SequenceStep,
  WebhookRequest,
} from "./types";
import { deviceModel, LAYER_NAMES, MODULE_SLOTS } from "./types";
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

/** File name for a Vision 6 encoder/nav slot macro — same layer-suffix rule
 * as key files (layer 0 unsuffixed). An absent file keeps the device's
 * built-in menu navigation for that control. */
export function slotFileName(slot: ModuleSlot, layerIndex: number): string {
  const suffix = layerIndex > 0 ? `-${LAYER_NAMES[layerIndex]}` : "";
  return `macros/${slot}${suffix}.json`;
}

/** Reverse of macroFileName/slotFileName: which slot + layer a device macro
 * path (e.g. from a `macro_changed` message) belongs to. Null for aux part
 * files, profile macros and anything else. */
export function parseMacroFileName(
  path: string,
): { slot: number | ModuleSlot; layer: number } | null {
  const base = path.replace(/^\/?(macros\/)?/, "");
  if (base.includes("/") || AUX_FILE_RE.test(base)) return null;
  const key = base.match(/^key(\d+)(?:-([a-h]))?\.json$/);
  if (key) return { slot: Number(key[1]), layer: key[2] ? LAYER_NAMES.indexOf(key[2]) : 0 };
  const mod = base.match(/^(enc-ccw|enc-cw|btn-back|btn-confirm)(?:-([a-h]))?\.json$/);
  if (mod && (MODULE_SLOTS as readonly string[]).includes(mod[1])) {
    return { slot: mod[1] as ModuleSlot, layer: mod[2] ? LAYER_NAMES.indexOf(mod[2]) : 0 };
  }
  return null;
}

/** How many layers actually exist: Vision 6 picks layers with its wheel, so
 * layer_count stands alone; elsewhere layers need a layer key to be reachable. */
export function effectiveLayers(cfg: {
  model?: string | null;
  layer_key?: number | null;
  layer_count: number;
}): number {
  if (deviceModel(cfg) === "vision6") return cfg.layer_count;
  return cfg.layer_key ? cfg.layer_count : 1;
}

// ------------------------------------------------------------- sequences ---
// A sequence made only of HID-expressible steps compiles into ONE macro file
// (steps concatenated with waits) and plays standalone on the keypad. As soon
// as a host step (launch/command/sound) is involved, the main file stays a
// no-op carrier of the step list and the desktop app orchestrates: HID steps
// are pre-compiled to sibling "part" files it plays over serial (still
// hardware HID), host steps it performs itself.

const HID_KINDS = new Set(["keystroke", "combo", "text", "media", "scroll", "recorded"]);

export function stepIsHid(step: SequenceStep): boolean {
  return HID_KINDS.has(step.a.kind);
}

/** True for kinds that have no HID equivalent and are performed by the
 * desktop app itself (open app/file/URL, run a command, play a sound,
 * toggle the system mic, call a webhook) — these do nothing on a keypad
 * plugged into a computer without the MKYADA app installed and running. */
export function kindRequiresHost(kind: Assignment["kind"]): boolean {
  return (
    kind === "launch" ||
    kind === "command" ||
    kind === "sound" ||
    kind === "mic" ||
    kind === "webhook"
  );
}

export function sequenceIsPureHid(steps: SequenceStep[]): boolean {
  return steps.every(stepIsHid);
}

/** True if this assignment needs the MKYADA app running to work at all
 * (won't do anything from a keypad alone plugged into another computer). */
export function assignmentRequiresHost(a: Assignment): boolean {
  if (a.kind === "sequence") return !sequenceIsPureHid(a.steps);
  return kindRequiresHost(a.kind);
}

/** Sibling file holding one pre-compiled HID step of a mixed sequence:
 * "macros/key3-b.json" step 2 -> "macros/key3-b.s2.json". The firmware only
 * ever plays exact key file names, so part files are inert on the device. */
export function sequencePartFileName(mainFile: string, stepIndex: number): string {
  return mainFile.replace(/\.json$/, `.s${stepIndex}.json`);
}

/** Pre-compiled part files a mixed sequence needs next to its main file.
 * Empty for pure-HID sequences (everything lives in the main file). */
export function compileSequenceParts(
  a: Assignment,
  mainFile: string,
): { path: string; file: MacroFile }[] {
  if (a.kind !== "sequence" || sequenceIsPureHid(a.steps)) return [];
  const parts: { path: string; file: MacroFile }[] = [];
  a.steps.forEach((step, i) => {
    if (!stepIsHid(step)) return;
    const file = compileAssignment(step.a, `Step ${i + 1}`);
    if (file) parts.push({ path: sequencePartFileName(mainFile, i), file });
  });
  return parts;
}

/** Sibling file for a key-logic variant of a PROFILE key: in host mode the
 * app decides tap/double/hold from the btn stream and plays these over
 * serial. (Global keys don't need parts — the firmware resolves variants
 * embedded in the main file itself.) */
export function variantPartFileName(mainFile: string, which: "double" | "hold"): string {
  return mainFile.replace(/\.json$/, which === "double" ? ".vd.json" : ".vh.json");
}

export function compileVariantParts(
  a: Assignment,
  mainFile: string,
): { path: string; file: MacroFile }[] {
  const parts: { path: string; file: MacroFile }[] = [];
  for (const which of ["double", "hold"] as const) {
    const va = a.variants?.[which];
    if (!va || va.kind === "none" || !HID_KINDS.has(va.kind)) continue;
    const file = compileAssignment(va);
    if (file) parts.push({ path: variantPartFileName(mainFile, which), file });
  }
  return parts;
}

/** Matches every auxiliary file a key's main macro may own on the drive
 * (sequence steps .sN.json, key-logic variants .vd/.vh.json) — used to
 * sweep stale ones after a re-save. */
export const AUX_FILE_RE = /\.(s\d+|vd|vh)\.json$/;

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

export const SCROLL_DEFAULT_AMOUNT = 3;

/** HID events for a scroll: hold any modifiers, send one wheel/pan tick event
 * (the firmware repeats it `amount` steps), then release the modifiers in
 * reverse. up/down drive the vertical wheel (dy); left/right the horizontal
 * pan (dx). */
function scrollEvents(dir: ScrollDir, amount: number, mods: string[]): MacroEvent[] {
  const events: MacroEvent[] = [];
  for (const m of mods) {
    events.push({ delay: events.length ? 10 : 0, type: "key", action: "down", key: MOD_TO_LABEL[m] ?? m.toLowerCase() });
  }
  const n = Math.max(1, Math.min(20, Math.round(amount)));
  const tick: MacroEvent =
    dir === "up"
      ? { delay: mods.length ? 10 : 0, type: "scroll", dy: n }
      : dir === "down"
        ? { delay: mods.length ? 10 : 0, type: "scroll", dy: -n }
        : dir === "right"
          ? { delay: mods.length ? 10 : 0, type: "scroll", dy: 0, dx: n }
          : { delay: mods.length ? 10 : 0, type: "scroll", dy: 0, dx: -n };
  events.push(tick);
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

const SCROLL_ARROW: Record<ScrollDir, string> = { up: "↑", down: "↓", left: "←", right: "→" };
const MENU_LABEL: Record<MenuAction, string> = {
  left: "Menu ←",
  right: "Menu →",
  confirm: "Menu confirm",
  back: "Menu back",
};

function scrollName(dir: ScrollDir, mods: string[]): string {
  const pre = mods.length ? `${mods.join("+")}+` : "";
  return `${pre}Scroll ${dir}`;
}

function menuName(action: MenuAction): string {
  return MENU_LABEL[action];
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
    case "mic":
      return true;
    case "webhook":
      return a.url.length > 0;
    case "sequence":
      return (
        a.steps.length > 0 &&
        a.steps.every((s) => s.a.kind !== "none" && s.a.kind !== "sequence" && assignmentComplete(s.a))
      );
    default:
      return true;
  }
}

/** Compile an assignment to a macro file, or null when the key is unassigned. */
export function compileAssignment(a: Assignment, name?: string): MacroFile | null {
  // a user-typed display name (Keys tab) overrides the auto-generated one
  name = name ?? (a.label?.trim() || undefined);
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
      case "scroll": {
        const amount = a.amount ?? SCROLL_DEFAULT_AMOUNT;
        const mods = a.mods ?? [];
        return {
          ...base,
          name: name ?? scrollName(a.dir, mods),
          kind: "scroll",
          scroll: { dir: a.dir, amount, ...(mods.length ? { mods } : {}) },
          events: scrollEvents(a.dir, amount, mods),
        };
      }
      case "menu":
        // device-only: empty events; the firmware routes a "menu" macro to
        // the on-screen UI instead of the HID engine
        return { ...base, name: name ?? menuName(a.action), kind: "menu", menu: a.action, events: [] };
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
      case "mic":
        return {
          ...base,
          name: name ?? micActionName(a.mode),
          kind: "mic",
          ...(a.mode && a.mode !== "toggle" ? { mic_mode: a.mode } : {}),
          events: [],
        };
      case "webhook": {
        const req: WebhookRequest = {
          url: a.url,
          ...(a.method && a.method !== "GET" ? { method: a.method } : {}),
          ...(a.headers?.length ? { headers: a.headers } : {}),
          ...(a.body ? { body: a.body } : {}),
        };
        return {
          ...base,
          name: name ?? `Webhook ${a.url.slice(0, 40)}`,
          kind: "webhook",
          webhook: req,
          events: [],
        };
      }
      case "sequence": {
        const pure = sequenceIsPureHid(a.steps);
        const events: MacroEvent[] = [];
        if (pure) {
          // one standalone macro file: steps back to back, waits in between
          a.steps.forEach((step, i) => {
            const compiled = compileAssignment(step.a);
            if (compiled) events.push(...compiled.events);
            if (step.delayMs > 0 && i < a.steps.length - 1) {
              events.push({ delay: step.delayMs, type: "wait" });
            }
          });
        }
        return {
          ...base,
          name: name ?? `Sequence (${a.steps.length} steps)`,
          kind: "sequence",
          seq: a.steps,
          events,
        };
      }
    }
  })();
  // behavior options ride along in settings, whatever the kind
  if (compiled && a.behavior) {
    const { on_repress, hold_repeat } = a.behavior;
    compiled.settings = {
      ...compiled.settings,
      ...(on_repress && on_repress !== "stop" ? { on_repress } : {}),
      // hold_repeat and key-logic variants are mutually exclusive: holding
      // the key IS the "hold" gesture once variants exist
      ...(hold_repeat && !hasVariants(a) ? { hold_repeat } : {}),
    };
  }
  // key logic (macro format v3): tap = the top-level events, double/hold
  // compiled as embedded variant files. Old firmware ignores `variants`
  // and plays the tap — graceful degradation.
  if (compiled && hasVariants(a)) {
    const vs: NonNullable<MacroFile["variants"]> = {};
    for (const which of ["double", "hold"] as const) {
      const va = a.variants?.[which];
      if (!va || va.kind === "none") continue;
      const vf = compileAssignment(va);
      if (vf) {
        delete vf.created;
        vs[which] = vf;
      }
    }
    if (Object.keys(vs).length) {
      compiled.variants = vs;
      compiled.version = 3;
    }
  }
  return compiled;
}

function hasVariants(a: Assignment): boolean {
  const d = a.variants?.double;
  const h = a.variants?.hold;
  return !!((d && d.kind !== "none") || (h && h.kind !== "none"));
}

/** Parse a macro file back into an editable assignment via its kind metadata. */
export function parseAssignment(m: MacroFile): Assignment {
  const a = parseAssignmentBase(m);
  if (m.variants && (m.variants.double || m.variants.hold)) {
    a.variants = {
      ...(m.variants.double ? { double: parseAssignmentBase(m.variants.double) } : {}),
      ...(m.variants.hold ? { hold: parseAssignmentBase(m.variants.hold) } : {}),
    };
  }
  // A stored name that differs from what we'd auto-generate is a user
  // override — surface it as the editable label. (Recorded macros carry
  // their name in the assignment itself.)
  if (m.name && a.kind !== "recorded" && compileAssignment(a)?.name !== m.name) {
    a.label = m.name;
  }
  return a;
}

function parseAssignmentBase(m: MacroFile): Assignment {
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
    case "scroll":
      return {
        kind: "scroll",
        dir: m.scroll?.dir ?? "up",
        ...(m.scroll?.amount ? { amount: m.scroll.amount } : {}),
        ...(m.scroll?.mods?.length ? { mods: m.scroll.mods } : {}),
        ...behavior,
      };
    case "menu":
      return { kind: "menu", action: m.menu ?? "confirm", ...behavior };
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
    case "mic":
      return { kind: "mic", ...(m.mic_mode ? { mode: m.mic_mode } : {}), ...behavior };
    case "webhook":
      return {
        kind: "webhook",
        url: m.webhook?.url ?? "",
        ...(m.webhook?.method ? { method: m.webhook.method } : {}),
        ...(m.webhook?.headers?.length ? { headers: m.webhook.headers } : {}),
        ...(m.webhook?.body ? { body: m.webhook.body } : {}),
        ...behavior,
      };
    case "sequence":
      return { kind: "sequence", steps: m.seq ?? [], ...behavior };
    default:
      return { kind: "recorded", name: m.name ?? "macro", macro: m, ...behavior };
  }
}

/**
 * Parse a macro file read back from the device drive: classic whole-file
 * JSON, or the proto-v4 stream layout (header line with `"stream":true`
 * followed by one event per line) reassembled into a normal MacroFile.
 */
export function parseDeviceMacro(raw: string): MacroFile {
  let file: MacroFile & { stream?: boolean };
  let rest: string[] = [];
  try {
    file = JSON.parse(raw) as MacroFile;
  } catch {
    const lines = raw.split("\n");
    file = JSON.parse(lines[0]) as MacroFile;
    rest = lines.slice(1);
  }
  if (file.stream) {
    file.events = rest.filter((l) => l.trim()).map((l) => JSON.parse(l) as MacroEvent);
    delete file.stream;
  }
  file.events ??= [];
  return file;
}

/** Accept legacy asil-macro v1 files and rewrite them as v2. */
export function migrateMacro(m: MacroFile): MacroFile {
  if (m.format === "asil-macro") {
    return { ...m, format: "mkyada-macro", version: 2, kind: m.kind ?? "recorded" };
  }
  return m;
}

export function describeAssignment(a: Assignment): string {
  if (a.kind !== "none" && a.label?.trim()) return a.label.trim();
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
    case "scroll": {
      const pre = a.mods?.length ? `${a.mods.map(modifierDisplay).join("+")} ` : "";
      const n = a.amount && a.amount !== SCROLL_DEFAULT_AMOUNT ? ` ×${a.amount}` : "";
      return `${pre}Scroll ${SCROLL_ARROW[a.dir]}${n}`;
    }
    case "menu":
      return MENU_LABEL[a.action];
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
    case "mic":
      return `🎤 ${MIC_MODE_LABELS[a.mode ?? "toggle"]}`;
    case "webhook": {
      const host = a.url.replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0];
      return `⇄ ${a.method ?? "GET"} ${host.length > 18 ? host.slice(0, 18) + "…" : host}`;
    }
    case "sequence":
      return `⧉ ${a.steps.length} step${a.steps.length === 1 ? "" : "s"}`;
  }
}

export const MIC_MODE_LABELS: Record<MicMode, string> = {
  toggle: "Mute/unmute mic",
  mute: "Mute mic",
  unmute: "Unmute mic",
  push_to_talk: "Push-to-talk",
};

function micActionName(mode?: MicMode): string {
  return MIC_MODE_LABELS[mode ?? "toggle"];
}

/** File name for a profile-scoped macro synced to the device drive. */
export function profileMacroFileName(profileId: string, key: number | ModuleSlot): string {
  return typeof key === "number"
    ? `macros/p_${profileId}_key${key}.json`
    : `macros/p_${profileId}_${key}.json`;
}

/** A Profile.keys entry names a key number ("3") or a module slot ("enc-cw"). */
export function profileKeySlot(k: string): number | ModuleSlot {
  return /^\d+$/.test(k) ? Number(k) : (k as ModuleSlot);
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
    // null passthroughs: device-set model/wiring/language survive rewrites
    model: null,
    pins: null,
    lang: null,
    screen: { width: screen.width, height: screen.height },
  };
}

/** Number of assignable macro slots for a config (the layer key isn't one). */
export function macroSlots(cfg: DeviceConfig): number {
  const keys = cfg.layer_key ? cfg.key_count - 1 : cfg.key_count;
  return keys * effectiveLayers(cfg);
}

// Shared types mirroring the firmware's config / macro / protocol schemas.

export interface Hello {
  t: "hello";
  fw: string;
  proto: number;
  format: string;
  uid: string;
  key_count: number;
  layer_key: number | null;
  layer_count: number;
  layer_mode: "toggle" | "hold";
  /** per-GPIO logical key numbers; absent on firmware < 0.1.4 */
  key_map?: number[];
  /** false = CIRCUITPY drive hidden, files managed over serial
   * (fs_* commands); absent on firmware < 0.4.0 */
  usb_drive?: boolean;
  /** hardware model ("core6" | "vision6"); absent on older firmware = core6 */
  model?: string;
  /** GPIO names in use, key 1 first (length == key_count); absent on older firmware */
  pins?: string[];
  /** Vision 6 grid band: show the active layer; absent on firmware < 0.9.0 */
  show_layer?: boolean;
  /** Vision 6 grid band: show the app-pushed profile label; absent on firmware < 0.9.0 */
  show_profile?: boolean;
  layer: string;
  mode: "standalone" | "host";
}

export interface DeviceInfo {
  port: string;
  hello: Hello;
}

export interface DriveInfo {
  path: string;
  uid: string;
  board: string;
}

export interface DeviceConfig {
  format: "mkyada-config";
  version: 1;
  key_count: number;
  layer_key: number | null;
  layer_count: number;
  /** kept for config compat — firmware always cycles on press ("toggle") */
  layer_mode: "toggle" | "hold";
  /** per-GPIO logical key numbers ([3,1,2] = GP0 acts as key 3); null = identity */
  key_map?: number[] | null;
  /** another macro key pressed while one is playing: ignore it, or switch to it */
  busy_other?: "ignore" | "switch";
  /** false hides the CIRCUITPY drive (boot.py); the app manages files over serial */
  usb_drive?: boolean;
  /** hardware model ("core6" | "vision6"); null/absent = firmware default (core6) */
  model?: string | null;
  /** per-key GPIO names (key 1 first); null = the model's default order */
  pins?: string[] | null;
  /** Vision 6 device UI language ("en" | "tr") — also editable on the device */
  lang?: string | null;
  /** Vision 6: band over the key grid naming the active layer — also on the device */
  show_layer?: boolean;
  /** Vision 6: the band shows the app's active profile label — also on the device */
  show_profile?: boolean;
  screen: { width: number; height: number };
}

// -------------------------------------------------- models & key wiring ---

export type DeviceModel = "core6" | "vision6";

/** Resolve a hello/config's model; old firmware omits the field = Core 6. */
export function deviceModel(h: { model?: string | null } | null | undefined): DeviceModel {
  return h?.model === "vision6" ? "vision6" : "core6";
}

export const MODEL_META: Record<DeviceModel, { label: string; image: string }> = {
  core6: { label: "MKYADA Core 6", image: "/devices/core6.png" },
  vision6: { label: "MKYADA Vision 6", image: "/devices/vision6.png" },
};

/** Every RP2040-Zero edge pin, in the order default key wiring walks them. */
export const EDGE_PINS = [
  ...Array.from({ length: 16 }, (_, i) => `GP${i}`), // GP0..GP15
  "GP26", "GP27", "GP28", "GP29",
];

/** Pins the firmware refuses for keys (Vision 6: screen/encoder/nav wiring). */
export const RESERVED_PINS: Record<DeviceModel, string[]> = {
  core6: ["GP16"],
  vision6: ["GP0", "GP1", "GP2", "GP3", "GP4", "GP5", "GP6", "GP16"],
};

/** Vision 6 factory key order (key 1 = GP29, walking down the right edge). */
export const VISION6_DEFAULT_PINS = ["GP29", "GP28", "GP27", "GP26", "GP15", "GP14"];

/** Edge pins a key may be wired to on this model (reserved ones excluded). */
export function assignablePins(model: DeviceModel): string[] {
  const reserved = new Set(RESERVED_PINS[model]);
  return EDGE_PINS.filter((p) => !reserved.has(p));
}

/** The model's default wiring when config.pins is null. */
export function defaultPins(model: DeviceModel, keyCount: number): string[] {
  if (model === "vision6") {
    // factory order first, then any remaining assignable pins for odd builds
    const rest = assignablePins("vision6").filter((p) => !VISION6_DEFAULT_PINS.includes(p));
    return [...VISION6_DEFAULT_PINS, ...rest].slice(0, keyCount);
  }
  return assignablePins("core6").slice(0, keyCount); // GP0..GP15 then GP26..GP29
}

/** Vision 6 encoder/nav slots that can carry macros like keys do.
 * btn-psh (the wheel's own push switch) needs firmware 0.9.0. */
export const MODULE_SLOTS = ["enc-cw", "enc-ccw", "btn-back", "btn-confirm", "btn-psh"] as const;
export type ModuleSlot = (typeof MODULE_SLOTS)[number];

export const MODULE_SLOT_LABELS: Record<ModuleSlot, string> = {
  "enc-cw": "Encoder →",
  "enc-ccw": "Encoder ←",
  "btn-back": "BACK button",
  "btn-confirm": "CONFIRM button",
  "btn-psh": "Encoder press (PSH)",
};

/** Where a Vision 6 module-control assignment applies (issue #19): the
 * resting key grid (per-layer, the classic behavior), the layer-picker
 * screen, or the settings menu. Grid files are macros/<slot>[-<layer>].json;
 * the menu contexts are global: macros/<slot>@home.json / <slot>@menu.json.
 * An absent file keeps that context's built-in navigation. Firmware 0.9.0. */
export const SLOT_CONTEXTS = ["grid", "home", "menu"] as const;
export type SlotContext = (typeof SLOT_CONTEXTS)[number];

export type MacroEvent = (
  | { delay: number; type: "key"; action: "down" | "up"; key: string; vk?: number | null }
  | { delay: number; type: "move"; x: number; y: number }
  | { delay: number; type: "button"; action: "down" | "up"; button: string; x?: number; y?: number }
  | { delay: number; type: "scroll"; dx?: number; dy: number; x?: number; y?: number }
  | { delay: number; type: "consumer"; usage: string }
  | { delay: number; type: "wait" }
) & {
  /** optional user-given row title, shown in the editor; ignored by playback */
  label?: string;
};

export interface MacroFile {
  format: "mkyada-macro" | "asil-macro";
  version: number;
  name?: string;
  created?: string;
  kind?:
    | "keystroke"
    | "combo"
    | "text"
    | "media"
    | "scroll"
    | "menu"
    | "recorded"
    | "launch"
    | "command"
    | "sound"
    | "mic"
    | "webhook"
    | "sequence";
  combo?: { mods: string[]; key: string };
  text?: string;
  media?: string;
  /** scroll kind: direction + how many wheel ticks + modifiers held (HID) */
  scroll?: { dir: ScrollDir; amount?: number; mods?: string[] };
  /** menu kind: which on-device menu action a key drives (Vision 6) */
  menu?: MenuAction;
  /** launch kind: app path, file path or URL — performed by the desktop app */
  target?: string;
  /** command kind: shell command line — performed by the desktop app */
  command?: string;
  /** sound kind: audio file path — played by the desktop app */
  sound?: string;
  /** sound kind: what holding the key does (default "stop") */
  sound_hold?: SoundHoldAction;
  /** mic kind: what the key does to the system microphone (default "toggle") */
  mic_mode?: MicMode;
  /** webhook kind: HTTP request performed by the desktop app */
  webhook?: WebhookRequest;
  /** sequence kind: the editable steps. Pure-HID sequences also compile
   * their steps into `events` (standalone); mixed ones leave `events` empty
   * and the desktop app orchestrates the steps. */
  seq?: SequenceStep[];
  /** Key logic (format v3): top-level `events` is the tap action; double
   * press / long press play these instead. Old firmware ignores this field
   * and simply plays the tap — graceful degradation. */
  variants?: { double?: MacroFile; hold?: MacroFile };
  screen?: { width: number; height: number };
  settings?: MacroSettings;
  events: MacroEvent[];
}

export interface MacroSettings {
  speed?: number;
  repeat?: number;
  /** pressing the macro's own key while it plays: stop it (default) or restart it */
  on_repress?: "stop" | "restart";
  /** replay while the physical key is held — like holding a letter key down.
   * Default ON for plain single-key macros (the firmware holds the HID key
   * and the host OS's typematic repeat does the rest), off for every other
   * kind; only deviations from that default are stored. */
  hold_repeat?: boolean;
  /** key logic: press-and-hold threshold in ms (default 400) */
  hold_ms?: number;
  /** key logic: double-press window in ms (default 250) */
  double_ms?: number;
}

/** Key-logic timing defaults, shared with the firmware. */
export const HOLD_MS_DEFAULT = 400;
export const DOUBLE_MS_DEFAULT = 250;

/** What holding a sound key (~half a second) does. */
export type SoundHoldAction = "stop" | "fade" | "restart";

/** A webhook key action: one fully user-defined HTTP request, curl-style —
 * smart lights, Discord/Telegram messages, Home Assistant, anything with an
 * HTTP API. Performed by the desktop app (HID can't speak HTTP). */
export interface WebhookRequest {
  url: string;
  /** HTTP method; default GET */
  method?: string;
  headers?: { name: string; value: string }[];
  /** raw request body — add a Content-Type header for JSON etc. */
  body?: string;
}

/**
 * What a "mic" key does to the system microphone:
 * - toggle: flip mute state on each press
 * - mute / unmute: always drive to that state on each press
 * - push_to_talk: unmute while the key is held down, mute again on release
 */
export type MicMode = "toggle" | "mute" | "unmute" | "push_to_talk";

/** Mouse-wheel scroll direction. up/down use the vertical wheel; left/right
 * use horizontal pan (AC Pan) — both are hardware HID on the keypad. */
export type ScrollDir = "up" | "down" | "left" | "right";

/** A device-menu navigation action a normal key can drive on the Vision 6:
 * the same effect as turning the encoder (left/right) or the CONFIRM / BACK
 * buttons. Handled on the device itself, so it only means anything there.
 * "default" (module slots only, firmware 0.9.0) keeps the control's built-in
 * action — the carrier for "tap stays stock, hold/double do something". */
export type MenuAction = "left" | "right" | "confirm" | "back" | "default";

/** Per-key behavior options shared by every assignment kind. */
export interface AssignmentBehavior {
  on_repress?: "stop" | "restart";
  hold_repeat?: boolean;
}

export type Assignment = (
  | { kind: "none" }
  | { kind: "keystroke"; key: string }
  | { kind: "combo"; mods: string[]; key: string }
  | { kind: "text"; text: string }
  | { kind: "media"; usage: string }
  // mouse-wheel scroll, optionally with modifiers held (e.g. Alt+wheel to
  // zoom in Illustrator, Ctrl+wheel to zoom a browser) — hardware HID
  | { kind: "scroll"; dir: ScrollDir; amount?: number; mods?: string[] }
  // drive the Vision 6's own on-screen menu from a normal key (device-only)
  | { kind: "menu"; action: MenuAction }
  | { kind: "recorded"; name: string; macro: MacroFile }
  // performed by the desktop app (not HID): open an app/file/URL, run a
  // command, play a sound effect
  | { kind: "launch"; target: string }
  | { kind: "command"; command: string }
  | { kind: "sound"; file: string; holdAction?: SoundHoldAction }
  | { kind: "mic"; mode?: MicMode }
  | ({ kind: "webhook" } & WebhookRequest)
  // Stream Deck-style multi action: run several actions with one press
  | { kind: "sequence"; steps: SequenceStep[] }
) & {
  behavior?: AssignmentBehavior;
  variants?: AssignmentVariants;
  /** User-chosen display name overriding the auto-generated one — shown in
   * the app and on the Vision 6 screen (stored as the macro file's `name`). */
  label?: string;
};

/** One step of a sequence; `delayMs` is an extra pause AFTER the step. */
export interface SequenceStep {
  /** any assignment except another sequence (no nesting) */
  a: Assignment;
  delayMs: number;
}

/** Key logic: alternative actions for double press / long press. The main
 * assignment itself is the tap. Variant assignments carry no variants of
 * their own and can't be sequences. Mutually exclusive with hold_repeat. */
export interface AssignmentVariants {
  double?: Assignment;
  hold?: Assignment;
}

export interface Profile {
  id: string;
  name: string;
  match: { exe: string; title_contains?: string | null };
  keys: Record<string, Assignment>; // key number ("3") or module slot ("enc-cw") -> action
}

export interface ForegroundInfo {
  exe: string;
  title: string;
}

export interface BtnEvent {
  t: "btn";
  /** logical key number (after key_map) */
  key: number;
  /** physical GPIO number (1 = GP0); absent on firmware < 0.1.4 */
  phys?: number;
  layer: string;
  edge: "down" | "up";
}

export interface UpdateInfo {
  available: boolean;
  current: string;
  latest: string;
  url: string;
}

export const LAYER_NAMES = "abcdefgh";

export function layerLabel(index: number): string {
  return LAYER_NAMES[index].toUpperCase();
}

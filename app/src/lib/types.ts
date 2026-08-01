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
  /** Vision 6 PSH/BACK/CONFIRM pin order (index 0=PSH,1=BACK,2=CONFIRM);
   * absent on firmware < 0.14.0 or on core6 (no nav buttons) */
  nav?: string[] | null;
  /** Vision 6 grid band: show the active layer; absent on firmware < 0.9.0 */
  show_layer?: boolean;
  /** Vision 6 grid band: show the app-pushed profile label; absent on firmware < 0.9.0 */
  show_profile?: boolean;
  /** Vision 6: the wheel walks layers as well as keys; absent on firmware < 0.25.0 */
  wheel_layers?: boolean;
  /** Vision 6 auto-return idle seconds (3–60); absent on firmware < 0.14.0 */
  timeout?: number;
  /** Vision 6 encoder wired backwards (CW/CCW flipped); absent on firmware < 0.14.0 */
  enc_swap?: boolean;
  /** Vision 6 per-layer nicknames for the grid band (index 0 = layer A);
   * null/"" entries keep "Layer A"; absent on firmware < 0.17.6 */
  layer_names?: (string | null)[] | null;
  layer: string;
  /** "rescue": the main firmware failed to start and code.py's rescue
   * console answered instead — only file repair + reset are available */
  mode: "standalone" | "host" | "rescue";
  /** rescue mode only: repr() of the error that killed the main firmware */
  err?: string;
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
  /** Vision 6 PSH/BACK/CONFIRM pin order override (fixes a swapped solder);
   * null = the model's default nav wiring */
  nav?: string[] | null;
  /** Vision 6 device UI language ("en" | "tr") — also editable on the device */
  lang?: string | null;
  /** Vision 6: band over the key grid naming the active layer — also on the device */
  show_layer?: boolean;
  /** Vision 6: the band shows the app's active profile label — also on the device */
  show_profile?: boolean;
  /** Vision 6: past the sixth tile the wheel wraps into the next layer — also on the device */
  wheel_layers?: boolean;
  /** Vision 6 auto-return idle seconds (3–60); null = keep the device's value */
  timeout?: number | null;
  /** Vision 6 encoder wired backwards — true flips the wheel's CW/CCW */
  enc_swap?: boolean;
  /** Vision 6 per-layer nicknames shown only in the device's grid band as
   * "(A) NAME". The app always labels layers A/B/C/D; null = no nicknames.
   * Aligned to layers (index 0 = layer A); null/"" entries keep "Layer A". */
  layer_names?: (string | null)[] | null;
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
  /** Grid icon by name (firmware/mkyada/icons.py). Absent = the firmware picks
   * the action kind's default. Older firmware ignores the field entirely. */
  icon?: string;
  created?: string;
  kind?:
    | "keystroke"
    | "combo"
    | "text"
    | "media"
    | "volume"
    | "mic_level"
    | "scroll"
    | "menu"
    | "recorded"
    | "launch"
    | "command"
    | "sound"
    | "mic"
    | "webhook"
    | "obs"
    | "obs_center"
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
  /** launch kind: the full target list when the key has more than one — the
   * Vision 6 wheel lists them (tap = open once, hold = make it the default).
   * `target` stays the default the key press opens; it is a member of this
   * list. Absent when the key has a single target. */
  targets?: string[];
  /** command kind: shell command line — performed by the desktop app */
  command?: string;
  /** command kind: the full command list when the key has more than one —
   * same wheel grammar as `targets`. `command` stays the default. */
  commands?: { label?: string; command: string }[];
  /** sound kind: audio file path — played by the desktop app */
  sound?: string;
  /** sound kind: the full sound list when the key has more than one — the
   * wheel lists them (tap = play once, hold = make it the key's default).
   * `sound` stays the default the key press plays; it is a member. Each entry
   * may carry a display `label`; the wheel falls back to the file name. */
  sounds?: { label?: string; sound: string }[];
  /** sound kind: what holding the key does (default "stop") */
  sound_hold?: SoundHoldAction;
  /** mic kind: what the key does to the system microphone (default "toggle") */
  mic_mode?: MicMode;
  /** webhook kind: HTTP request performed by the desktop app */
  webhook?: WebhookRequest;
  /** webhook kind: ALTERNATIVE requests beyond the default `webhook` — the
   * wheel lists the default first, then these (tap = send once, hold = swap
   * it in as the default). Unlike sounds/targets, this list does NOT include
   * the default: requests have no natural identity to match against. */
  webhooks?: (WebhookRequest & { label?: string })[];
  /** obs kind: an OBS Studio action performed by the desktop app over
   * obs-websocket (scene switch, record/stream/mic toggle, …) */
  obs?: ObsRequest;
  /** obs_center kind: the live OBS dashboard's per-key configuration —
   * which widgets show, which audio input the mic widgets follow, what the
   * encoder does and what the six keys fire while the dashboard is open */
  obs_center?: ObsCenterConfig;
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

/** What holding a sound key (~1 second) does. */
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
 * An OBS Studio control action, performed by the desktop app over
 * obs-websocket v5 (OBS 28+). HID can't speak WebSocket, so — like webhook —
 * the key compiles to a no-op macro that travels to the device but is executed
 * host-side while the app is connected. Each action maps to one obs-websocket
 * requestType (see obsActionToRequest in macro-model).
 */
export type ObsAction =
  | "setScene"
  | "recordStart"
  | "recordStop"
  | "recordToggle"
  | "streamStart"
  | "streamStop"
  | "streamToggle"
  | "micToggle"
  | "virtualCamToggle"
  | "replayBufferToggle"
  | "sourceToggle"
  | "hotkey";

/** Live OBS state pushed from the Rust obs-websocket client (`obs:changed`
 * event / `obs_state` command). Mirrors `obs::ObsSnapshot`. */
export interface ObsSnapshot {
  connected: boolean;
  currentScene?: string | null;
  recording: boolean;
  streaming: boolean;
  virtualCam: boolean;
  replayBuffer: boolean;
  error?: string | null;
}

/** What the encoder does while the OBS Center dashboard is open. */
export type ObsCenterEncoder = "mic" | "scene" | "off";

/** One of the six quick-action keys while the OBS Center is open: an OBS
 * action plus the short label the OLED's bottom row shows (≤5 chars). */
export interface ObsQuickKey {
  label: string;
  action: ObsRequest;
}

/** The OBS Center (kind "obs_center") per-key configuration. Lives in the
 * macro file so it travels with profiles and the standalone config. Every
 * widget is individually toggleable; a widget the user turned off is simply
 * never pushed to the device, which hides it (proto v13). */
export interface ObsCenterConfig {
  /** the audio input the mic VU / mute widget and the encoder fader follow */
  micInput?: string;
  /** default "mic": turn = input volume, press = mute toggle */
  encoder?: ObsCenterEncoder;
  widgets?: {
    /** REC / LIVE / IDLE chip in the top bar */
    status?: boolean;
    /** record (or stream) elapsed timer */
    timer?: boolean;
    /** current program scene pill */
    scene?: boolean;
    /** mic VU meter + mute indicator */
    mic?: boolean;
    /** CPU % / dropped frames / FPS row */
    health?: boolean;
  };
  /** exactly 6 entries, null = key unassigned (falls through to nothing) */
  quickKeys?: (ObsQuickKey | null)[];
}

/** Live OBS session numbers pushed from the Rust client (`obs:live` event)
 * while an OBS Center is open. Mirrors `obs::ObsLive`: every field optional,
 * each event carries only what changed. */
export interface ObsLive {
  recSecs?: number;
  streamSecs?: number;
  cpu?: number;
  fps?: number;
  dropped?: number;
  total?: number;
  micPct?: number;
  micMuted?: boolean;
}

/** An OBS key action: one action plus the fields that action needs. */
export interface ObsRequest {
  action: ObsAction;
  /** setScene: the scene to switch the program output to */
  sceneName?: string;
  /** micToggle: the audio input to mute/unmute (an OBS input name) */
  inputName?: string;
  /** sourceToggle: the scene that holds the source item to show/hide */
  sourceScene?: string;
  /** sourceToggle: the source (scene item) name to show/hide */
  sourceName?: string;
  /** hotkey: the OBS hotkey name for TriggerHotkeyByName */
  hotkeyName?: string;
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
 * action — the carrier for "tap stays stock, hold/double do something".
 * "none" (firmware 0.10.0) is the wire carrier of the "nothing" assignment:
 * the firmware swallows the input entirely.
 * Direct-jump actions (firmware 0.12.0): "home" opens the layer screen,
 * "settings" the on-device settings menu, "grid" the key grid;
 * "layer_next" / "layer_prev" switch the active layer immediately —
 * all assignable to any key or control.
 * "select" (firmware 0.17.0) toggles select mode — the built-in behavior that
 * was previously only reachable via the PSH long-press escape (issue #26).
 * "layer_a".."layer_h" (firmware 0.17.7) jump straight to that layer — an
 * absolute counterpart to layer_next/prev, assignable to any key incl. core6
 * (issue #30). The app only offers the layers that actually exist. */
export type MenuAction =
  | "left" | "right" | "confirm" | "back"
  | "home" | "settings" | "grid" | "layer_next" | "layer_prev" | "select"
  | "layer_a" | "layer_b" | "layer_c" | "layer_d"
  | "layer_e" | "layer_f" | "layer_g" | "layer_h"
  | "default" | "none";

/** Per-key behavior options shared by every assignment kind. */
export interface AssignmentBehavior {
  on_repress?: "stop" | "restart";
  hold_repeat?: boolean;
}

export type Assignment = (
  | { kind: "none" }
  // turn the input off: it does nothing at all — on a module slot this
  // overrides even the built-in menu action (stored as a menu:"none" carrier)
  | { kind: "nothing" }
  | { kind: "keystroke"; key: string }
  | { kind: "combo"; mods: string[]; key: string }
  | { kind: "text"; text: string }
  | { kind: "media"; usage: string }
  // system output-volume level: pressing mutes (HID, standalone); the Vision 6
  // wheel opens an absolute % slider while the app is running (host)
  | { kind: "volume" }
  // microphone input level: the Vision 6 wheel opens an input-gain slider —
  // host-only (no HID for capture gain)
  | { kind: "mic_level" }
  // mouse-wheel scroll, optionally with modifiers held (e.g. Alt+wheel to
  // zoom in Illustrator, Ctrl+wheel to zoom a browser) — hardware HID
  | { kind: "scroll"; dir: ScrollDir; amount?: number; mods?: string[] }
  // drive the Vision 6's own on-screen menu from a normal key (device-only)
  | { kind: "menu"; action: MenuAction }
  | { kind: "recorded"; name: string; macro: MacroFile }
  // performed by the desktop app (not HID): open an app/file/URL, run a
  // command, play a sound effect
  | { kind: "launch"; target: string; targets?: string[] }
  | { kind: "command"; command: string; commands?: { label?: string; command: string }[] }
  | { kind: "sound"; file: string; files?: { label?: string; file: string }[]; holdAction?: SoundHoldAction }
  | { kind: "mic"; mode?: MicMode }
  | ({ kind: "webhook" } & WebhookRequest & { hooks?: (WebhookRequest & { label?: string })[] })
  // control OBS Studio over obs-websocket (scene, record, stream, mic, …)
  | ({ kind: "obs" } & ObsRequest)
  // open the live OBS dashboard on the Vision 6 screen (host + screen only)
  | { kind: "obs_center"; center?: ObsCenterConfig }
  // Stream Deck-style multi action: run several actions with one press
  | { kind: "sequence"; steps: SequenceStep[] }
) & {
  behavior?: AssignmentBehavior;
  variants?: AssignmentVariants;
  /** User-chosen display name overriding the auto-generated one — shown in
   * the app and on the Vision 6 screen (stored as the macro file's `name`). */
  label?: string;
  /** User-chosen grid icon, by NAME from the generated family
   * (app/src/lib/oled-icons.ts). Unset means the action kind's own default.
   * Names are permanent, so extending the family cannot repoint this at a
   * different picture; an unknown name simply falls back to the default. */
  icon?: string;
  /** Playback speed multiplier (the macro file's `settings.speed`). Edited on
   * the Vision 6 wheel; round-tripped here so re-saving a key in the app does
   * not silently drop a device-set speed. Recorded macros carry theirs inside
   * `macro.settings` instead, so this stays unset for them. */
  speed?: number;
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

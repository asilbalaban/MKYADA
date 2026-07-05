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
  screen: { width: number; height: number };
}

export type MacroEvent =
  | { delay: number; type: "key"; action: "down" | "up"; key: string; vk?: number | null }
  | { delay: number; type: "move"; x: number; y: number }
  | { delay: number; type: "button"; action: "down" | "up"; button: string; x?: number; y?: number }
  | { delay: number; type: "scroll"; dx?: number; dy: number; x?: number; y?: number }
  | { delay: number; type: "consumer"; usage: string }
  | { delay: number; type: "wait" };

export interface MacroFile {
  format: "mkyada-macro" | "asil-macro";
  version: number;
  name?: string;
  created?: string;
  kind?: "keystroke" | "combo" | "text" | "media" | "recorded" | "launch" | "command" | "sound";
  combo?: { mods: string[]; key: string };
  text?: string;
  media?: string;
  /** launch kind: app path, file path or URL — performed by the desktop app */
  target?: string;
  /** command kind: shell command line — performed by the desktop app */
  command?: string;
  /** sound kind: audio file path — played by the desktop app */
  sound?: string;
  /** sound kind: what holding the key does (default "stop") */
  sound_hold?: SoundHoldAction;
  screen?: { width: number; height: number };
  settings?: MacroSettings;
  events: MacroEvent[];
}

export interface MacroSettings {
  speed?: number;
  repeat?: number;
  /** pressing the macro's own key while it plays: stop it (default) or restart it */
  on_repress?: "stop" | "restart";
  /** replay while the physical key is held — like holding a letter key down */
  hold_repeat?: boolean;
}

/** What holding a sound key (~half a second) does. */
export type SoundHoldAction = "stop" | "fade" | "restart";

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
  | { kind: "recorded"; name: string; macro: MacroFile }
  // performed by the desktop app (not HID): open an app/file/URL, run a
  // command, play a sound effect
  | { kind: "launch"; target: string }
  | { kind: "command"; command: string }
  | { kind: "sound"; file: string; holdAction?: SoundHoldAction }
) & { behavior?: AssignmentBehavior };

export interface Profile {
  id: string;
  name: string;
  match: { exe: string; title_contains?: string | null };
  keys: Record<string, Assignment>; // key number -> action
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

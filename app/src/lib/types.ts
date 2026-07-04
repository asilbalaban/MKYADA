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
  layer_mode: "toggle" | "hold";
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
  kind?: "keystroke" | "combo" | "text" | "media" | "recorded";
  combo?: { mods: string[]; key: string };
  text?: string;
  media?: string;
  screen?: { width: number; height: number };
  settings?: { speed?: number; repeat?: number };
  events: MacroEvent[];
}

export type Assignment =
  | { kind: "none" }
  | { kind: "keystroke"; key: string }
  | { kind: "combo"; mods: string[]; key: string }
  | { kind: "text"; text: string }
  | { kind: "media"; usage: string }
  | { kind: "recorded"; name: string; macro: MacroFile }
  // host-mode only: cannot be expressed as HID, runs on the computer
  | { kind: "launch"; target: string };

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
  key: number;
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

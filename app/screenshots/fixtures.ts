// Screenshot fixtures: a fully-populated Core 6 and Vision 6 keypad, built from
// real Assignment objects and compiled to on-device macro files through the
// SAME compiler the app uses (compileAssignment / serializeForDevice). That
// guarantees the mocked drive serves exactly what a real device would, so the
// Keys page renders identical labels/icons to production — no hand-authored
// device JSON that could drift from the parser.
//
// This module is dev-only scaffolding. It is never part of a production build
// (tsconfig `include` is ["src"], and vite build's entry is app/index.html),
// so `mock-tauri` never reaches dist — see the CI guard in ci.yml.

import {
  compileAssignment,
  compileSlotAssignment,
  macroFileName,
  slotFileName,
  SLOT_BUILTIN_ACTION,
} from "../src/lib/macro-model";
import { serializeForDevice } from "../src/lib/recorder-model";
import { MODULE_SLOTS } from "../src/lib/types";
import type {
  Assignment,
  DeviceConfig,
  Hello,
  MacroFile,
  ModuleSlot,
  Profile,
} from "../src/lib/types";

export type ModelName = "core6" | "vision6";

export interface Fixture {
  hello: Hello;
  drive: { path: string; uid: string; board: string };
  /** on-device file path (e.g. "config.json", "macros/key1.json") -> content */
  files: Record<string, string>;
  /** basenames under macros/, what drive_list("macros") returns */
  macroList: string[];
  profiles: Profile[];
  appVersion: string;
}

const APP_VERSION = "0.29.0";

// -------------------------------------------------------------- assignments ---
// key number (per layer) -> what it does. Chosen to show the range of action
// kinds a reader would want to see on the promo/docs screenshots.

/** A real recorded macro, so the Recorder screenshots show the editor doing its
 * job instead of its "record or import a macro to begin" placeholder. Written
 * as captured events (a mouse move, a click, a typed word, a shortcut) with the
 * row titles the recorder gives them — the same shape recording produces. */
const RECORDED: MacroFile = {
  format: "mkyada-macro",
  version: 3,
  kind: "recorded",
  name: "Post the clip",
  screen: { width: 1920, height: 1080 },
  settings: { speed: 1 },
  events: [
    { delay: 0, type: "move", x: 962, y: 214 },
    { delay: 180, type: "button", action: "down", button: "left", x: 962, y: 214 },
    { delay: 64, type: "button", action: "up", button: "left", x: 962, y: 214 },
    { delay: 320, type: "key", action: "down", key: "c" },
    { delay: 48, type: "key", action: "up", key: "c" },
    { delay: 96, type: "key", action: "down", key: "l" },
    { delay: 52, type: "key", action: "up", key: "l" },
    { delay: 88, type: "key", action: "down", key: "i" },
    { delay: 44, type: "key", action: "up", key: "i" },
    { delay: 92, type: "key", action: "down", key: "p" },
    { delay: 50, type: "key", action: "up", key: "p" },
    { delay: 260, type: "move", x: 1418, y: 662 },
    { delay: 140, type: "scroll", dy: -3, x: 1418, y: 662 },
    { delay: 300, type: "key", action: "down", key: "cmd" },
    { delay: 40, type: "key", action: "down", key: "enter" },
    { delay: 60, type: "key", action: "up", key: "enter" },
    { delay: 36, type: "key", action: "up", key: "cmd" },
  ],
};

const CORE6_KEYS: Record<number, Record<string, Assignment>> = {
  // layer A — everyday desktop
  0: {
    1: { kind: "combo", mods: ["cmd"], key: "c", label: "Copy" },
    2: { kind: "text", text: "All the best,\nAsil", label: "Signature" },
    3: { kind: "launch", target: "https://github.com/asilbalaban/MKYADA", label: "Open repo" },
    4: { kind: "media", usage: "PLAY_PAUSE", label: "Play / Pause" },
    5: { kind: "recorded", name: RECORDED.name!, macro: RECORDED, label: "Post the clip" },
  },
  // layer B — smart-home & shell
  1: {
    1: { kind: "webhook", url: "https://api.example.com/lights/toggle", method: "POST", label: "Desk lights" },
    2: { kind: "command", command: "npm run build", label: "Build" },
    3: { kind: "scroll", dir: "down", amount: 3, label: "Scroll down" },
    4: { kind: "sound", file: "ding.wav", holdAction: "stop", label: "Ding" },
    5: { kind: "mic", mode: "toggle", label: "Mute mic" },
  },
};

const VISION6_KEYS: Record<number, Record<string, Assignment>> = {
  // layer A — "Stream"
  0: {
    1: { kind: "obs", action: "setScene", sceneName: "Live", label: "Go Live" },
    2: { kind: "obs", action: "recordToggle", label: "Record" },
    3: { kind: "mic", mode: "push_to_talk", label: "Push-to-talk" },
    4: { kind: "launch", target: "discord://", label: "Discord" },
    5: { kind: "media", usage: "MUTE", label: "Mute" },
    6: { kind: "recorded", name: RECORDED.name!, macro: RECORDED, label: "Post the clip" },
  },
  // layer B — "Edit"
  1: {
    1: { kind: "combo", mods: ["cmd"], key: "z", label: "Undo" },
    2: { kind: "combo", mods: ["cmd", "shift"], key: "z", label: "Redo" },
    3: { kind: "scroll", dir: "up", amount: 2, label: "Zoom in" },
    4: { kind: "scroll", dir: "down", amount: 2, label: "Zoom out" },
    5: { kind: "combo", mods: ["cmd"], key: "s", label: "Save" },
    6: { kind: "combo", mods: ["cmd", "shift"], key: "e", label: "Export" },
  },
  // layer C — "Dev"
  2: {
    1: { kind: "command", command: "npm test", label: "Test" },
    2: { kind: "command", command: "git push", label: "Push" },
    3: { kind: "text", text: "console.log()", label: "console.log" },
    4: { kind: "launch", target: "https://localhost:1420", label: "Open dev" },
    5: { kind: "keystroke", key: "f5", label: "Reload" },
    6: { kind: "combo", mods: ["cmd"], key: "p", label: "Go to file" },
  },
};

// Vision 6 encoder + nav-button slots (grid context), per layer 0.
const VISION6_SLOTS: Partial<Record<ModuleSlot, Assignment>> = {
  "enc-cw": { kind: "media", usage: "VOLUME_INCREMENT", label: "Volume +" },
  "enc-ccw": { kind: "media", usage: "VOLUME_DECREMENT", label: "Volume −" },
  "btn-psh": { kind: "mic", mode: "toggle", label: "Mute mic" },
};

// ------------------------------------------------------------------ profiles ---

const PROFILES: Profile[] = [
  {
    id: "p-obs",
    name: "OBS Studio",
    match: { exe: "obs64.exe" },
    keys: {
      "1": { kind: "obs", action: "setScene", sceneName: "Live" },
      "2": { kind: "obs", action: "recordToggle" },
      "3": { kind: "mic", mode: "push_to_talk" },
    },
  },
  {
    id: "p-ps",
    name: "Photoshop",
    match: { exe: "Photoshop.exe" },
    keys: {
      "1": { kind: "combo", mods: ["cmd"], key: "z" },
      "2": { kind: "combo", mods: ["cmd", "alt"], key: "z" },
      "enc-cw": { kind: "scroll", dir: "up" },
      "enc-ccw": { kind: "scroll", dir: "down" },
    },
  },
  {
    id: "p-code",
    name: "VS Code",
    match: { exe: "Code.exe", title_contains: null },
    keys: {
      "1": { kind: "command", command: "npm test" },
      "2": { kind: "combo", mods: ["cmd"], key: "p" },
    },
  },
];

// ------------------------------------------------------------------ builders ---

function compileKeyFiles(
  keysByLayer: Record<number, Record<string, Assignment>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [layerStr, keys] of Object.entries(keysByLayer)) {
    const layer = Number(layerStr);
    for (const [keyStr, a] of Object.entries(keys)) {
      const macro = compileAssignment(a, a.label);
      if (!macro) continue;
      out[macroFileName(Number(keyStr), layer)] = serializeForDevice(macro, 8);
    }
  }
  return out;
}

function compileSlotFiles(slots: Partial<Record<ModuleSlot, Assignment>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const slot of MODULE_SLOTS) {
    const a = slots[slot];
    if (!a) continue;
    const macro = compileSlotAssignment(a, SLOT_BUILTIN_ACTION[slot]);
    if (!macro) continue;
    out[slotFileName(slot, 0, "grid")] = serializeForDevice(macro, 8);
  }
  return out;
}

function macroBasenames(files: Record<string, string>): string[] {
  return Object.keys(files)
    .filter((p) => p.startsWith("macros/"))
    .map((p) => p.split("/").pop()!);
}

// ------------------------------------------------------------------- core 6 ---

function core6(): Fixture {
  const config: DeviceConfig = {
    format: "mkyada-config",
    version: 1,
    key_count: 6,
    layer_key: 6,
    layer_count: 2,
    layer_mode: "toggle",
    key_map: null,
    busy_other: "ignore",
    model: "core6",
    pins: null,
    nav: null,
    enc_swap: false,
    lang: null,
    show_layer: false,
    show_profile: true,
    timeout: null,
    layer_names: null,
    screen: { width: 1920, height: 1080 },
  };
  const files: Record<string, string> = {
    "config.json": JSON.stringify(config, null, 2),
    ...compileKeyFiles(CORE6_KEYS),
  };
  const hello: Hello = {
    t: "hello",
    fw: "0.21.1",
    proto: 10,
    format: "mkyada-config",
    uid: "E6605481DB334C2A",
    key_count: 6,
    layer_key: 6,
    layer_count: 2,
    layer_mode: "toggle",
    usb_drive: true,
    model: "core6",
    layer: "a",
    mode: "standalone",
  };
  return {
    hello,
    drive: { path: "MOCK:core6", uid: hello.uid, board: "CIRCUITPY" },
    files,
    macroList: macroBasenames(files),
    profiles: PROFILES,
    appVersion: APP_VERSION,
  };
}

// ----------------------------------------------------------------- vision 6 ---

function vision6(): Fixture {
  const config: DeviceConfig = {
    format: "mkyada-config",
    version: 1,
    key_count: 6,
    layer_key: null,
    layer_count: 3,
    layer_mode: "toggle",
    key_map: null,
    busy_other: "ignore",
    model: "vision6",
    pins: null,
    nav: ["GP2", "GP3", "GP4"],
    enc_swap: false,
    lang: "en",
    show_layer: true,
    show_profile: true,
    timeout: 10,
    layer_names: ["Stream", "Edit", "Dev"],
    screen: { width: 1920, height: 1080 },
  };
  const files: Record<string, string> = {
    "config.json": JSON.stringify(config, null, 2),
    ...compileKeyFiles(VISION6_KEYS),
    ...compileSlotFiles(VISION6_SLOTS),
  };
  const hello: Hello = {
    t: "hello",
    fw: "0.21.1",
    proto: 10,
    format: "mkyada-config",
    uid: "E6605481DB119A7F",
    key_count: 6,
    layer_key: null,
    layer_count: 3,
    layer_mode: "toggle",
    usb_drive: true,
    model: "vision6",
    nav: ["GP2", "GP3", "GP4"],
    show_layer: true,
    show_profile: true,
    timeout: 10,
    enc_swap: false,
    layer_names: ["Stream", "Edit", "Dev"],
    layer: "a",
    mode: "standalone",
  };
  return {
    hello,
    drive: { path: "MOCK:vision6", uid: hello.uid, board: "CIRCUITPY" },
    files,
    macroList: macroBasenames(files),
    profiles: PROFILES,
    appVersion: APP_VERSION,
  };
}

export function buildFixture(model: ModelName): Fixture {
  return model === "vision6" ? vision6() : core6();
}

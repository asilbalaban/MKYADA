// Dev-only Tauri IPC mock for the screenshot harness. Installed BEFORE the app
// boots (see entry.html), it makes `@tauri-apps/api` resolve without a running
// Tauri backend and serves a fully-populated fake keypad so every screen paints
// real data with no hardware attached.
//
// NEVER shipped: tsconfig `include` is ["src"] and vite build's HTML entry is
// app/index.html, so this file and the string "mock-tauri" never reach dist.
// The CI guard in .github/workflows/ci.yml fails the build if they ever do.

import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { buildFixture, type ModelName } from "./fixtures";
import { defaultPins } from "../src/lib/types";

/** Push a device message to the app the way the Rust side would. Deferred a
 * tick so it never runs inside the IPC handler that provoked it. */
function emitDeviceMsg(msg: Record<string, unknown>) {
  setTimeout(() => void emit("device:msg", msg), 0);
}

const params = new URLSearchParams(location.search);
const model: ModelName = params.get("model") === "vision6" ? "vision6" : "core6";

// Force the light theme so promo/docs shots are consistent (decision: single
// theme). initTheme() in main.tsx reads this key on boot.
try {
  localStorage.setItem("mkyada-theme", "light");
} catch {
  /* ignore */
}

const fx = buildFixture(model);

// ---- remote playback control (proto v17) --------------------------------
// The fake keypad speaks v17 so the playback bar and "Run again" can be
// previewed: `press` starts a LOOPING play of that key (so Stop has something
// to stop) and `stop` ends it, with the same replies as the firmware.
// `?playing=3` boots with key 3 already looping (a reconnect mid-loop);
// `window.__mockPress(key)` presses a key from the devtools console.
// `?oldfw=1` keeps the fixture's pre-v17 proto (Control's "update firmware"
// state); `?nokeypad=1` boots with nothing plugged in.
const oldFw = params.get("oldfw") === "1";
const noKeypad = params.get("nokeypad") === "1";
if (!oldFw) fx.hello.proto = Math.max(fx.hello.proto, 17);
// Devices page states: `?fwupdate=1` bundles a newer firmware than the keypad
// runs (the hero's "Update firmware"); `?rescue=1` boots the keypad in its
// rescue console; `?fresh=1` has no config.json yet (the first-time setup
// wizard); `?others=1` adds a second plugged-in keypad (once the main one has
// auto-connected, which needs it to be alone on the first scan) and remembered ones.
const fwUpdate = params.get("fwupdate") === "1";
const rescueMode = params.get("rescue") === "1";
const fresh = params.get("fresh") === "1";
const others = params.get("others") === "1";
// the firmware reports its wiring and key order (proto ≥ 3), so Fix wiring works
if (!oldFw) {
  fx.hello.pins ??= defaultPins(model, fx.hello.key_count);
  fx.hello.key_map ??= Array.from({ length: fx.hello.key_count }, (_, i) => i + 1);
}
if (rescueMode) {
  fx.hello.mode = "rescue";
  fx.hello.err = "ImportError: no module named 'mkyada.ui'";
}
if (fresh) delete fx.files["config.json"];
const otherKeypad = {
  port: "MOCK2",
  hello: {
    ...fx.hello,
    uid: "E6605481DB77C3D0",
    model: fx.hello.model === "vision6" ? "core6" : "vision6",
    mode: "standalone" as const,
    err: undefined,
  },
};
let mainConnected = false;
type MockPlay = { file: string; key: number; layer: string; loop: boolean };
let mockPlaying: MockPlay | null = null;
const bootKey = Number(params.get("playing"));
if (bootKey > 0) {
  mockPlaying = { file: `/macros/key${bootKey}.json`, key: bootKey, layer: "a", loop: true };
}
fx.hello.playing = mockPlaying;

let mockCurLayer = "a";

function mockLayer(v: unknown): string {
  if (typeof v === "number") return "abcdefgh"[v] ?? "a";
  return typeof v === "string" && v ? v : mockCurLayer;
}

function mockPress(msg: Args) {
  const key = Number(msg.key);
  const layer = mockLayer(msg.layer);
  if (!(key >= 1 && key <= fx.hello.key_count)) {
    return emitDeviceMsg({ t: "err", re: "press", code: "bad_key", msg: String(msg.key) });
  }
  if (fx.hello.layer_key === key) {
    // the layer key cycles to the next layer, like the firmware
    const cur = "abcdefgh".indexOf(mockCurLayer);
    mockCurLayer = "abcdefgh"[(cur + 1) % fx.hello.layer_count];
    emitDeviceMsg({ t: "ok", re: "press", action: "layer" });
    return emitDeviceMsg({ t: "layer", layer: mockCurLayer });
  }
  if (msg.gesture && !["tap", "double", "hold"].includes(String(msg.gesture))) {
    return emitDeviceMsg({ t: "err", re: "press", code: "bad_gesture", msg: String(msg.gesture) });
  }
  const file = layer === "a" ? `/macros/key${key}.json` : `/macros/key${key}-${layer}.json`;
  const body = fx.files[file.slice(1)];
  if (body === undefined) {
    return emitDeviceMsg({ t: "err", re: "press", code: "not_assigned", msg: file });
  }
  // Vision 6 keys whose press opens an on-device menu (ui.py PRESS_MENU_KINDS)
  if (model === "vision6") {
    let kind = "";
    try {
      kind = String(JSON.parse(body).kind ?? "");
    } catch {
      /* not JSON */
    }
    if (["volume", "mic_level", "obs_center", "enc_module"].includes(kind) && !msg.gesture) {
      return emitDeviceMsg({ t: "err", re: "press", code: "unsupported", msg: "opens a keypad menu" });
    }
  }
  if (mockPlaying) {
    if (mockPlaying.file !== file) {
      return emitDeviceMsg({ t: "err", re: "press", code: "busy", msg: "another macro is playing" });
    }
    const done = mockPlaying;
    mockPlaying = null;
    emitDeviceMsg({ t: "ok", re: "press", action: "stop" });
    return emitDeviceMsg({ t: "play_done", file: done.file, stopped: true, reason: "repress" });
  }
  // computer-side carriers (launch, command, mixed multi action…) have no
  // events: the keypad starts and finishes them at once
  let empty = false;
  try {
    const events = JSON.parse(body).events;
    empty = !Array.isArray(events) || events.length === 0;
  } catch {
    /* streamed format — treat as a real macro */
  }
  if (empty) {
    emitDeviceMsg({ t: "ok", re: "press", action: "play" });
    emitDeviceMsg({ t: "play_start", file, key, layer, loop: false, src: "remote" });
    return emitDeviceMsg({ t: "play_done", file, stopped: false, reason: "done" });
  }
  mockPlaying = { file, key, layer, loop: true };
  emitDeviceMsg({ t: "ok", re: "press", action: "play" });
  emitDeviceMsg({ t: "play_start", ...mockPlaying, src: "remote" });
}

function mockStop() {
  const was = mockPlaying;
  mockPlaying = null;
  emitDeviceMsg({ t: "ok", re: "stop", was_playing: !!was });
  if (was) emitDeviceMsg({ t: "play_done", file: was.file, stopped: true, reason: "stop" });
}

(window as unknown as { __mockPress: (key: number, layer?: string) => void }).__mockPress = (
  key,
  layer,
) => mockPress({ key, layer });

const mockInvokes: { cmd: string; args: Args }[] = [];
(window as unknown as { __mockInvokes: typeof mockInvokes }).__mockInvokes = mockInvokes;

let mockHotkey = { accel: "Ctrl+Alt+Shift+S", default: "Ctrl+Alt+Shift+S", registered: true, error: null as string | null };

// Present a window labelled "main" so getCurrentWindow() (main.tsx / App.tsx)
// renders the Shell, not the overlay.
mockWindows("main");

// plugin-store: LazyStore.load() returns a resource id; get(rid,key) returns
// [value, exists]. Map rid -> store file so we can answer per-store.
const ridToPath = new Map<number, string>();
let ridSeq = 1;

function storeValue(path: string, key: string): unknown {
  if (others && path.includes("devices") && key === "devices") {
    const day = 86_400_000;
    const at = (d: number) => new Date(Date.now() - d * day).toISOString();
    return {
      [fx.hello.uid]: { uid: fx.hello.uid, name: "Stream deck", lastSeen: at(0), fw: fx.hello.fw },
      [otherKeypad.hello.uid]: { uid: otherKeypad.hello.uid, name: "", lastSeen: at(0), fw: fx.hello.fw },
      E6605481DB0042AA: { uid: "E6605481DB0042AA", name: "Office keypad", lastSeen: at(12), fw: "0.22.1" },
    };
  }
  if (path.includes("profiles")) {
    if (key === "profiles") return fx.profiles;
    if (key === "enabled") return true;
  }
  return undefined; // settings.json etc. fall back to the app's defaults
}

type Args = Record<string, unknown>;

mockIPC(
  (cmd, rawArgs) => {
    const args = (rawArgs ?? {}) as Args;
    // what the app asked the "backend" to do, for tests driving the preview
    if (!cmd.startsWith("plugin:")) mockInvokes.push({ cmd, args });
    switch (cmd) {
      // ---- device lifecycle: a single keypad, auto-connected on launch ----
      case "scan_devices": {
        const main = noKeypad ? [] : [{ port: "MOCK", hello: fx.hello }];
        return others && mainConnected ? [...main, otherKeypad] : main;
      }
      case "connected_port":
        return noKeypad ? null : "MOCK";
      case "connect_device":
        mainConnected = true;
        return null;
      case "disconnect_device":
        return null;
      case "device_send": {
        // The app pings before it reads any files and waits for a "pong"
        // (device.tsx waitForReady). Without an answer it spends 12 seconds
        // deciding the link is wedged, which is why every shot used to carry a
        // "Loading keys from the keypad…" banner.
        const msg = (args.msg ?? {}) as Args;
        if (msg.t === "ping") emitDeviceMsg({ t: "pong" });
        // Only the ?playing= preview answers identify: a hello is what tells
        // the app a loop is already running. Plain shots keep the old flow.
        if (msg.t === "identify" && bootKey > 0) emitDeviceMsg({ ...fx.hello, playing: mockPlaying });
        if (msg.t === "press") mockPress(msg);
        if (msg.t === "stop") mockStop();
        // the app's own `play` (sequence part files): a short one-shot
        if (msg.t === "play" && typeof msg.file === "string" && !mockPlaying) {
          const file = String(msg.file).startsWith("/") ? String(msg.file) : `/${msg.file}`;
          emitDeviceMsg({ t: "play_start", file, key: null, layer: mockCurLayer, loop: false, src: "host" });
          setTimeout(() => void emit("device:msg", { t: "play_done", file, stopped: false, reason: "done" }), 400);
        }
        if (msg.t === "set_layer") {
          mockCurLayer = mockLayer(msg.layer);
          emitDeviceMsg({ t: "layer", layer: mockCurLayer });
        }
        return null;
      }

      // ---- stop hotkey (remote.rs) --------------------------------------
      case "stop_hotkey_status":
        return mockHotkey;
      case "stop_hotkey_set": {
        const accel = String(args.accel ?? "").trim();
        if (accel && !accel.includes("+")) throw "Add at least one modifier (Ctrl, Alt, Shift)";
        mockHotkey = { ...mockHotkey, accel, registered: !!accel, error: null };
        return mockHotkey;
      }
      case "stop_playback_now":
        mockStop();
        return null;

      // ---- drive (CIRCUITPY) file access -------------------------------
      case "list_drives":
        return noKeypad ? [] : [fx.drive];
      case "drive_list": {
        const path = String(args.path ?? "");
        return path.startsWith("macros") ? fx.macroList : [];
      }
      case "drive_read": {
        const path = String(args.path ?? "");
        const content = fx.files[path];
        if (content === undefined) throw new Error(`mock: no file ${path}`);
        return content;
      }
      case "drive_write":
      case "drive_delete":
      case "drive_eject":
      case "drive_write_cancel":
        return null;

      // ---- app chrome: keep banners/prompts out of the shots -----------
      case "check_update":
        return { available: false, current: fx.appVersion, latest: fx.appVersion, url: "" };
      case "permissions_status":
        // A fully-granted Mac. Without `platform` the card fell back to its
        // Linux copy, so the published Application tab told readers no
        // permissions were needed — on the one OS where they are.
        return { platform: "macos", input_monitoring: "granted", accessibility: "granted" };
      case "firmware_bundled_version":
        return fwUpdate ? "0.26.0" : fx.hello.fw;
      case "firmware_diagnose":
        return {
          bundle_version: fx.hello.fw,
          device_version: fx.hello.fw,
          model,
          missing: rescueMode ? ["mkyada/ui.mpy"] : [],
          stale: [],
          extra: [],
          matching: rescueMode ? 41 : 42,
          total: 42,
        };
      case "list_bootloader_drives":
        return [];
      case "sound_outputs":
        // A plausible Mac: the built-in output plus the virtual device people
        // route soundboards through.
        return ["MacBook Pro Speakers", "Studio Display", "BlackHole 2ch"];
      case "obs_state":
        return {
          connected: false,
          recording: false,
          streaming: false,
          virtualCam: false,
          replayBuffer: false,
        };

      // ---- plugin-store (profiles.json / settings.json) ----------------
      case "plugin:store|load": {
        const rid = ridSeq++;
        ridToPath.set(rid, String(args.path ?? ""));
        return rid;
      }
      case "plugin:store|get": {
        const path = ridToPath.get(Number(args.rid)) ?? "";
        const value = storeValue(path, String(args.key ?? ""));
        return value === undefined ? [null, false] : [value, true];
      }
      case "plugin:store|has":
        return false;
      case "plugin:store|keys":
      case "plugin:store|values":
      case "plugin:store|entries":
        return [];
      case "plugin:store|length":
        return 0;

      // ---- app / autostart plugins -------------------------------------
      case "plugin:app|version":
        return fx.appVersion;
      case "plugin:app|name":
        return "MKYADA";
      case "plugin:autostart|is_enabled":
        return false;

      // Everything else (obs_action, mic_action, overlay_*, http_request,
      // recorder_*, run_command, save/set, …) is fire-and-forget in the UI
      // and wrapped in .catch — a resolved null is a safe no-op.
      default:
        return null;
    }
  },
  { shouldMockEvents: true },
);

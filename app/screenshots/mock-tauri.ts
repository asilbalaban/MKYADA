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

// Present a window labelled "main" so getCurrentWindow() (main.tsx / App.tsx)
// renders the Shell, not the overlay.
mockWindows("main");

// plugin-store: LazyStore.load() returns a resource id; get(rid,key) returns
// [value, exists]. Map rid -> store file so we can answer per-store.
const ridToPath = new Map<number, string>();
let ridSeq = 1;

function storeValue(path: string, key: string): unknown {
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
    switch (cmd) {
      // ---- device lifecycle: a single keypad, auto-connected on launch ----
      case "scan_devices":
        return [{ port: "MOCK", hello: fx.hello }];
      case "connected_port":
        return "MOCK";
      case "connect_device":
      case "disconnect_device":
        return null;
      case "device_send": {
        // The app pings before it reads any files and waits for a "pong"
        // (device.tsx waitForReady). Without an answer it spends 12 seconds
        // deciding the link is wedged, which is why every shot used to carry a
        // "Loading keys from the keypad…" banner.
        const msg = (args.msg ?? {}) as Args;
        if (msg.t === "ping") emitDeviceMsg({ t: "pong" });
        return null;
      }

      // ---- drive (CIRCUITPY) file access -------------------------------
      case "list_drives":
        return [fx.drive];
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
        return fx.hello.fw;
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

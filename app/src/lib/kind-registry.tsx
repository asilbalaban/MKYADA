// Single source of truth for every assignable action kind: its label, icon,
// category (how the picker groups it), whether it needs the desktop app, and
// what turning/pressing the Vision 6 wheel does on a key with this action (the
// "wheel menu"). The action editor, the wheel-menu preview card, and the
// Settings reference table all read from here, so a new kind is described in
// exactly one place.

import type { Assignment } from "./types";
import type { WheelPreview } from "./oled-draw";
import { KIND_ICON } from "../components/action-icons";
import { kindRequiresHost } from "./macro-model";

/** Which key the preview is standing in for. The speed editor prints "A > K3"
 * from it; callers that don't know (the Settings reference table shows one
 * example per kind, not a real key) leave it out and get the A/K1 default. */
export type PreviewWhere = { layer?: string; key?: number };

/** How the picker groups action kinds. Order here is the order shown. */
export const KIND_CATEGORIES = [
  { id: "keyboard", label: "Keyboard, mouse & text" },
  { id: "media", label: "Media & sound" },
  { id: "automation", label: "Automation" },
  { id: "stream", label: "Streaming" },
  { id: "device", label: "Device screen" },
  { id: "off", label: "Off" },
] as const;

export type KindCategory = (typeof KIND_CATEGORIES)[number]["id"];

/**
 * What the Vision 6 wheel does when you press CONFIRM on a key with this
 * action. Drives the on-device menu AND the in-app preview/reference so the two
 * can never drift.
 * - `mtype` picks which on-device screen renders (see docs/serial-protocol.md):
 *   speed  = the playback-speed editor (local)
 *   card   = a big status card; press fires/toggles, turn repeats/steps
 *   slider = a value bar with a percentage (e.g. system volume, host-backed)
 *   picker = a scrollable list fed by the app (e.g. OBS scenes)
 *   none   = no menu; pressing shows a short toast
 * - `title` is the ASCII heading shown on the 128×64 screen.
 * - `summary` is the one-line explanation shown in the app.
 * - `standaloneFallback`, for host kinds, is what happens with the app closed.
 */
export interface WheelSpec {
  mtype: "speed" | "card" | "slider" | "picker" | "none";
  title: string;
  summary: string;
  standaloneFallback?: string;
}

export interface KindMeta {
  id: Assignment["kind"];
  label: string;
  icon: string;
  category: KindCategory;
  /** True when the action only runs while the MKYADA app is running. */
  host: boolean;
  wheel: WheelSpec;
}

// Order within a category is the order listed here.
const KINDS: KindMeta[] = [
  // ── Keyboard, mouse & text ───────────────────────────────────────────────
  {
    id: "keystroke",
    label: "Single key",
    icon: KIND_ICON.keystroke,
    category: "keyboard",
    host: false,
    wheel: {
      mtype: "card",
      title: "KEY",
      summary: "Turn to fire the key again and again (e.g. keep hitting undo); press to fire once.",
    },
  },
  {
    id: "combo",
    label: "Key combination",
    icon: KIND_ICON.combo,
    category: "keyboard",
    host: false,
    wheel: {
      mtype: "card",
      title: "KEY",
      summary: "Turn to fire the shortcut repeatedly; press to fire once.",
    },
  },
  {
    // A sequence is how most people write "a macro" by hand — a few keystrokes
    // in a row — so it opens the keyboard group rather than hiding under
    // Automation next to webhooks and shell commands.
    id: "sequence",
    label: "Multi action (sequence)",
    icon: KIND_ICON.sequence,
    category: "keyboard",
    host: false,
    wheel: {
      mtype: "speed",
      title: "SPEED",
      summary: "Turn to set the playback speed (0.1×–10×) — the step delays scale with it; press to save.",
      standaloneFallback: "Steps that need the app are skipped when it's closed; the rest still run.",
    },
  },
  {
    id: "scroll",
    label: "Mouse scroll / zoom",
    icon: KIND_ICON.scroll,
    // A wheel/zoom key is typed input the same way a keystroke is: standalone
    // HID that lands wherever the cursor is, not a media transport.
    category: "keyboard",
    host: false,
    wheel: {
      mtype: "card",
      title: "SCROLL",
      summary: "Turn the wheel to scroll in the assigned direction; press for a single step.",
    },
  },
  {
    id: "text",
    label: "Type text",
    icon: KIND_ICON.text,
    category: "keyboard",
    host: false,
    wheel: {
      mtype: "speed",
      title: "SPEED",
      summary: "Turn to set the typing speed (0.1×–10×); press to save it on the device.",
    },
  },
  // ── Media & sound ────────────────────────────────────────────────────────
  {
    id: "sound",
    label: "Play a sound",
    icon: KIND_ICON.sound,
    category: "media",
    host: true,
    wheel: {
      mtype: "card",
      title: "SOUND",
      summary:
        "Press to play the sound. With several sounds on the key, the wheel lists them: tap to play one, hold to make it the default.",
      standaloneFallback: "Needs the MKYADA app — the wheel shows a short reminder.",
    },
  },
  {
    id: "volume",
    label: "Volume level",
    icon: KIND_ICON.volume,
    category: "media",
    host: false,
    wheel: {
      mtype: "slider",
      title: "VOLUME",
      summary: "Pressing the key opens a volume slider — turn to set the system volume by percent.",
      standaloneFallback: "App closed: a relative volume knob (turn up/down, no percent).",
    },
  },
  {
    id: "mic_level",
    label: "Microphone level",
    icon: KIND_ICON.mic_level,
    category: "media",
    host: true,
    wheel: {
      mtype: "slider",
      title: "MIC LEVEL",
      summary: "Pressing the key opens a mic input-level slider — turn to set the recording gain.",
      standaloneFallback: "Needs the MKYADA app — mic gain has no standalone control.",
    },
  },
  {
    id: "mic",
    label: "Mute/unmute microphone",
    icon: KIND_ICON.mic,
    category: "media",
    host: true,
    wheel: {
      mtype: "picker",
      title: "MIC",
      summary: "Turn to browse mute / unmute / toggle; tap to do it now, hold to reassign the key.",
      standaloneFallback: "Needs the MKYADA app — the wheel shows a short reminder.",
    },
  },
  {
    id: "media",
    label: "Media key",
    icon: KIND_ICON.media,
    category: "media",
    host: false,
    wheel: {
      mtype: "picker",
      title: "MEDIA",
      summary: "Turn to browse every media key, tap to use the highlighted one, hold to reassign this key to it.",
    },
  },
  // ── Automation ───────────────────────────────────────────────────────────
  {
    id: "recorded",
    label: "Recorded macro (JSON)",
    icon: KIND_ICON.recorded,
    category: "automation",
    host: false,
    wheel: {
      mtype: "speed",
      title: "SPEED",
      summary: "Turn to set the playback speed (0.1×–10×); press to save it on the device.",
    },
  },
  {
    id: "launch",
    label: "Open app / file / URL",
    icon: KIND_ICON.launch,
    category: "automation",
    host: true,
    wheel: {
      mtype: "card",
      title: "OPEN",
      summary:
        "Press to open the target on the computer. With several targets on the key, the wheel lists them: tap to open one, hold to make it the default.",
      standaloneFallback: "Needs the MKYADA app — the wheel shows a short reminder.",
    },
  },
  {
    id: "command",
    label: "Run terminal command",
    icon: KIND_ICON.command,
    category: "automation",
    host: true,
    wheel: {
      mtype: "card",
      title: "COMMAND",
      summary:
        "Press to run the command. With several commands on the key, the wheel lists them: tap to run one, hold to make it the default.",
      standaloneFallback: "Needs the MKYADA app — the wheel shows a short reminder.",
    },
  },
  {
    id: "webhook",
    label: "Call a webhook (HTTP request)",
    icon: KIND_ICON.webhook,
    category: "automation",
    host: true,
    wheel: {
      mtype: "card",
      title: "WEBHOOK",
      summary:
        "Press to send the request. With alternative requests on the key, the wheel lists them: tap to send one, hold to make it the default.",
      standaloneFallback: "Needs the MKYADA app — the wheel shows a short reminder.",
    },
  },
  // ── Streaming ────────────────────────────────────────────────────────────
  {
    id: "obs",
    label: "Control OBS Studio",
    icon: KIND_ICON.obs,
    category: "stream",
    host: true,
    wheel: {
      mtype: "card",
      title: "OBS",
      summary:
        "Depends on the OBS action: pick a scene to reassign the key, or see live REC/LIVE status and toggle it.",
      standaloneFallback: "Needs the MKYADA app connected to OBS — the wheel shows a short reminder.",
    },
  },
  {
    id: "obs_center",
    label: "OBS Center (live dashboard)",
    icon: KIND_ICON.obs_center,
    category: "stream",
    host: true,
    wheel: {
      mtype: "card",
      title: "OBS",
      summary:
        "Pressing the key opens a live OBS dashboard on the keypad screen: REC/LIVE status, timer, scene, mic meter and health — the six keys become your OBS shortcuts while it's open.",
      standaloneFallback: "Needs the MKYADA app connected to OBS, and a screen model.",
    },
  },
  // ── Device screen ────────────────────────────────────────────────────────
  {
    id: "menu",
    label: "Device menu (screen models)",
    icon: KIND_ICON.menu,
    category: "device",
    host: false,
    wheel: {
      mtype: "picker",
      title: "LAYER",
      summary:
        "Turn to browse layer & screen actions (next/prev layer, jump to a layer, Home/Grid/Settings); tap to run it, hold to reassign the key.",
    },
  },
  // ── Off ──────────────────────────────────────────────────────────────────
  {
    id: "none",
    label: "Not assigned",
    icon: KIND_ICON.none,
    category: "off",
    host: false,
    wheel: { mtype: "none", title: "", summary: "No action assigned — the wheel shows a short reminder." },
  },
  {
    id: "nothing",
    label: "Do nothing (turn this control off)",
    icon: KIND_ICON.nothing,
    category: "off",
    host: false,
    wheel: { mtype: "none", title: "", summary: "Turned off — the wheel does nothing here." },
  },
];

const BY_ID = new Map(KINDS.map((k) => [k.id, k]));

/** All kinds in display order (grouped by category). */
export function allKinds(): KindMeta[] {
  return KINDS;
}

/** Metadata for one kind. Falls back to the "none" entry for safety. */
export function kindMeta(kind: Assignment["kind"]): KindMeta {
  return BY_ID.get(kind) ?? BY_ID.get("none")!;
}

/** The wheel-menu behaviour for a kind (what CONFIRM does on the Vision 6). */
export function wheelSpec(kind: Assignment["kind"]): WheelSpec {
  return kindMeta(kind).wheel;
}

/** Label of the category a kind belongs to (e.g. "Keyboard & text"). */
export function categoryLabel(id: KindCategory): string {
  return KIND_CATEGORIES.find((c) => c.id === id)?.label ?? "";
}

function speedPreview(speed = 1, where?: PreviewWhere): WheelPreview {
  // The device composes this screen from the layer, the key and the speed in
  // tenths, so the preview passes the same three things rather than a
  // pre-rendered picture — that is what keeps oled-draw.test.ts able to check
  // it against the firmware's own golden image.
  return {
    screen: "speed",
    layer: where?.layer ?? "A",
    key: where?.key ?? 1,
    t: Math.max(1, Math.min(100, Math.round(speed * 10))),
  };
}

function basename(p: string): string {
  const b = p.split(/[\\/]/).pop() ?? p;
  return b.length > 12 ? b.slice(0, 11) + "…" : b;
}

const OBS_CARD: Record<string, { title: string; big: string }> = {
  recordStart: { title: "RECORD", big: "REC ●" },
  recordStop: { title: "RECORD", big: "REC ●" },
  recordToggle: { title: "RECORD", big: "REC ●" },
  streamStart: { title: "STREAM", big: "LIVE ●" },
  streamStop: { title: "STREAM", big: "LIVE ●" },
  streamToggle: { title: "STREAM", big: "LIVE ●" },
  virtualCamToggle: { title: "VIRTUAL CAM", big: "CAM" },
  replayBufferToggle: { title: "REPLAY", big: "BUFFER" },
  micToggle: { title: "OBS MIC", big: "MIC" },
  hotkey: { title: "OBS", big: "HOTKEY" },
};

/**
 * What the Vision 6 wheel screen looks like for this assignment — a faithful
 * mock of the on-device menu, filled with the assignment's own values. Used by
 * OledPreview in the editor and the Settings reference. Representative where
 * live data (scene lists, HTTP status) only exists at run time.
 */
export function wheelPreview(a: Assignment, where?: PreviewWhere): WheelPreview {
  switch (a.kind) {
    case "keystroke":
      return { screen: "card", title: "KEY", big: (a.key || "KEY").toUpperCase(), line: "turn: repeat", hint: "run" };
    case "combo":
      return {
        screen: "card",
        title: "KEY",
        big: [...a.mods, a.key].filter(Boolean).join("+").toUpperCase() || "COMBO",
        line: "turn: repeat",
        hint: "run",
      };
    case "text":
      return speedPreview(1, where);
    case "recorded":
      return speedPreview(a.macro?.settings?.speed ?? 1, where);
    case "volume":
      return { screen: "slider", title: "VOLUME", hero: "40%", frac: 0.4, action: "OK" };
    case "media": {
      // a browser of every media key, cursor on the assigned one
      const label = (u: string) =>
        ({ play_pause: "Play/Pause", next_track: "Next", prev_track: "Prev", stop: "Stop", mute: "Mute", volume_up: "Vol +", volume_down: "Vol -", brightness_up: "Bright +", brightness_down: "Bright -" })[u] ?? u;
      const opts = ["play_pause", "prev_track", "next_track", "stop", "mute", "volume_up", "volume_down"];
      const items = opts.map((u) => ({ label: label(u), mark: u === a.usage ? ("cursor" as const) : undefined }));
      if (!opts.includes(a.usage)) items[0] = { label: label(a.usage), mark: "cursor" };
      return { screen: "picker", title: "MEDIA", items, action: "Use", hold: "hold: assign" };
    }
    case "scroll":
      return { screen: "card", title: "SCROLL", big: a.dir.toUpperCase(), line: "turn: scroll", hint: "step" };
    case "obs": {
      if (a.action === "setScene")
        return {
          screen: "picker",
          title: "SCENE",
          items: [
            { label: a.sceneName || "Scene 1", mark: "cursor" },
            { label: "Scene 2", mark: "dot" },
            { label: "Scene 3" },
          ],
          action: "Pick",
          hold: "hold: assign",
        };
      if (a.action === "sourceToggle")
        return {
          screen: "picker",
          title: "SOURCES",
          items: [
            { label: a.sourceName || "Camera", mark: "dot" },
            { label: "Overlay" },
            { label: "Webcam" },
          ],
          action: "Toggle",
        };
      const card = OBS_CARD[a.action] ?? { title: "OBS", big: "OBS" };
      return { screen: "card", title: card.title, big: card.big, line: "live status", hint: "toggle" };
    }
    case "obs_center": {
      // a representative live dashboard, with the user's own widget toggles
      // and quick-key labels where they exist
      const w = a.center?.widgets ?? {};
      const on = (v?: boolean) => v !== false;
      const kl = (a.center?.quickKeys ?? []).map((q) => (q ? q.label : ""));
      while (kl.length < 6) kl.push("");
      return {
        screen: "obscenter",
        o: {
          rec: on(w.status) ? true : null,
          live: on(w.status) ? false : null,
          blink: true,
          time: on(w.timer) ? "00:42:10" : null,
          scene: on(w.scene) ? "Scene 1" : null,
          mic: on(w.mic) ? 64 : null,
          mute: on(w.mic) ? false : null,
          focus: on(w.mic) ? "mic" : on(w.scene) ? "scene" : null,
          cpu: on(w.health) ? 8 : null,
          drop: on(w.health) ? 0 : null,
          fps: on(w.health) ? 60 : null,
          klabels: kl.some(Boolean) ? kl : ["MUTE", "CAM", "CLIP", "", "", "REC"],
        },
      };
    }
    case "mic":
      return {
        screen: "picker",
        title: "MIC",
        items: [
          { label: "Toggle", mark: "cursor" },
          { label: "Mute" },
          { label: "Unmute" },
        ],
        action: "Do",
        hold: "hold: assign",
      };
    case "mic_level":
      return { screen: "slider", title: "MIC LEVEL", hero: "60%", frac: 0.6, action: "OK" };
    case "webhook": {
      if (a.hooks?.length) {
        const label = (h: { label?: string; url: string }, i: number) =>
          h.label || (() => { try { return new URL(h.url).hostname.replace(/^www\./, ""); } catch { return h.url || `#${i + 1}`; } })();
        const items = [{ url: a.url, label: "" }, ...a.hooks].map((h, i) => ({
          label: label(h, i) || "default",
          mark: i === 0 ? ("cursor" as const) : undefined,
        }));
        return { screen: "picker", title: "WEBHOOK", items, action: "Send", hold: "hold: assign" };
      }
      return { screen: "card", title: "WEBHOOK", big: "SEND", line: "add more in app", hint: "run" };
    }
    case "command": {
      if (a.commands && a.commands.length > 1) {
        const items = a.commands.map((c) => ({
          label: c.label || c.command,
          mark: c.command === a.command ? ("cursor" as const) : undefined,
        }));
        return { screen: "picker", title: "COMMAND", items, action: "Run", hold: "hold: assign" };
      }
      return { screen: "card", title: "COMMAND", big: "RUN", line: "add more in app", hint: "run" };
    }
    case "launch": {
      if (a.targets && a.targets.length > 1) {
        const items = a.targets.map((t) => ({
          label: basename(t),
          mark: t === a.target ? ("cursor" as const) : undefined,
        }));
        return { screen: "picker", title: "OPEN", items, action: "Open", hold: "hold: assign" };
      }
      return { screen: "card", title: "OPEN", big: a.target ? basename(a.target) : "OPEN", line: "add more in app", hint: "open" };
    }
    case "sound": {
      if (a.files && a.files.length > 1) {
        const items = a.files.map((f) => ({
          label: f.label || basename(f.file),
          mark: f.file === a.file ? ("cursor" as const) : undefined,
        }));
        return { screen: "picker", title: "SOUND", items, action: "Play", hold: "hold: assign" };
      }
      return { screen: "card", title: "SOUND", big: a.file ? basename(a.file) : "SOUND", line: "add more in app", hint: "play" };
    }
    case "sequence":
      return speedPreview(a.speed ?? 1, where);
    case "menu": {
      // a browser of the layer/nav family, cursor on the assigned action
      const label = (act: string) =>
        act.length === 7 && act.startsWith("layer_")
          ? `Layer ${act[6].toUpperCase()}`
          : ({ layer_next: "Next layer", layer_prev: "Prev layer", home: "Home", grid: "Grid", settings: "Settings" } as Record<string, string>)[act] ?? act;
      const opts = ["layer_prev", "layer_next", "home", "grid", "settings"];
      const items = opts.map((o) => ({ label: label(o), mark: o === a.action ? ("cursor" as const) : undefined }));
      if (!opts.includes(a.action)) items[0] = { label: label(a.action), mark: "cursor" };
      return { screen: "picker", title: "LAYER", items, action: "Run", hold: "hold: assign" };
    }
    default:
      return { screen: "toast", title: "WHEEL", line1: "no action here" };
  }
}

// Sanity: the registry's host flag must agree with the compiler's source of
// truth. This runs once at module load in dev; a mismatch is a wiring bug.
if (import.meta.env?.DEV) {
  for (const k of KINDS) {
    if (k.id === "none" || k.id === "nothing") continue;
    if (k.host !== kindRequiresHost(k.id)) {
      // eslint-disable-next-line no-console
      console.warn(`kind-registry: host flag for "${k.id}" disagrees with kindRequiresHost`);
    }
  }
}

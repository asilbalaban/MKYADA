// Remote playback control (proto v17): what the keypad is playing right now,
// what was last stopped (so the UI can offer "Run again"), and the helpers
// that stop a macro or press a key from the app.
//
// Why: people reach the keypad's computer over Chrome Remote Desktop and can't
// touch the keys, so a looping macro (settings.repeat: 0 — stopped by pressing
// the key again) would lock them out. Pure state logic lives here (unit-tested);
// the React side is lib/playback-context.tsx.

/** First protocol with `press`, the `stop` reply and the richer play_* fields. */
export const REMOTE_PROTO = 17;

/** How long the "Stopped key N · Run again" offer stays up. */
export const STOPPED_TTL_MS = 60_000;

export type PlaySource = "key" | "remote" | "host" | "slot" | "unknown";

export interface PlayingInfo {
  file: string;
  /** logical key number, or null (a Vision 6 wheel slot / an app play) */
  key: number | null;
  /** layer letter, or null when unknown (old firmware + profile file) */
  layer: string | null;
  loop: boolean;
  src: PlaySource;
  startedAt: number;
}

export interface StoppedInfo {
  file: string;
  key: number;
  layer: string | null;
  /** "stop" (serial stop — the app, the hotkey or the tray) | "repress" */
  reason: string;
  /** who asked for the stop, when this app sent it: "hotkey" | "tray" | "app"
   * | "remote-desktop" (a remote desktop session connected) */
  via: string | null;
  at: number;
}

export interface PlaybackTrack {
  playing: PlayingInfo | null;
  lastStopped: StoppedInfo | null;
}

export const EMPTY_TRACK: PlaybackTrack = { playing: null, lastStopped: null };

/** key/layer from a numbered-key macro path — the fallback for firmware
 * older than v17, whose play_start only names the file. Part files
 * (`key3.s1.json`), slots and menu overrides don't match. Profile files
 * (`p_<id>_key3.json`) give the key but no layer. */
export function keyFromFile(file: string): { key: number; layer: string | null } | null {
  const name = file.split("/").pop() ?? "";
  const m = /^(p_[^/]+_)?key(\d+)(?:-([a-h]))?\.json$/.exec(name);
  if (!m) return null;
  return { key: Number(m[2]), layer: m[1] ? null : (m[3] ?? "a") };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const SOURCES: PlaySource[] = ["key", "remote", "host", "slot"];

/** Fold one device message into the playback track. `via` is the source of a
 * stop this app sent moments ago (hotkey / tray / app), if any. */
export function reducePlayback(
  s: PlaybackTrack,
  msg: Record<string, unknown>,
  now: number,
  via: string | null = null,
): PlaybackTrack {
  switch (msg.t) {
    case "play_start": {
      const file = str(msg.file) ?? "";
      const guess = keyFromFile(file);
      const src = SOURCES.includes(msg.src as PlaySource) ? (msg.src as PlaySource) : "unknown";
      return {
        playing: {
          file,
          key: "key" in msg ? num(msg.key) : (guess?.key ?? null),
          layer: str(msg.layer) ?? guess?.layer ?? null,
          loop: msg.loop === true,
          src,
          startedAt: now,
        },
        // a new run supersedes any "Run again" offer
        lastStopped: null,
      };
    }
    case "play_done": {
      const p = s.playing;
      const file = str(msg.file) ?? p?.file ?? "";
      // Old firmware has no reason — only `stopped`.
      const reason = str(msg.reason) ?? (msg.stopped === true ? "stop" : "done");
      // Only a key play the user deliberately ended gets "Run again": app
      // plays (Recorder / Keys test, profile sequence parts) and wheel slots
      // are the app's own business, and "other" means a new macro took over.
      const keyed = !p || p.src === "key" || p.src === "remote" || p.src === "unknown";
      const key = p?.key ?? keyFromFile(file)?.key ?? null;
      if ((reason === "stop" || reason === "repress") && keyed && key !== null) {
        return {
          playing: null,
          lastStopped: {
            file,
            key,
            layer: p?.layer ?? keyFromFile(file)?.layer ?? null,
            reason,
            via: reason === "stop" ? via : null,
            at: now,
          },
        };
      }
      return { ...s, playing: null };
    }
    case "hello": {
      // A (re)connect or reload resyncs: v17 reports a running playback, so a
      // reconnecting app can still offer Stop for a loop started earlier.
      const pl = msg.playing as Record<string, unknown> | null | undefined;
      if (pl && typeof pl === "object") {
        const file = str(pl.file) ?? "";
        return {
          ...s,
          playing: {
            file,
            key: num(pl.key),
            layer: str(pl.layer),
            loop: pl.loop === true,
            src: "unknown",
            // keep the original start time across repeated hellos
            startedAt: s.playing?.file === file ? s.playing.startedAt : now,
          },
        };
      }
      return { ...s, playing: null };
    }
    default:
      return s;
  }
}

export type PressGesture = "tap" | "double" | "hold";

/** Readable text for a `press` refusal (err codes from firmware v17). */
export function pressErrorText(code: string): string {
  switch (code) {
    case "unsupported":
      return "This key opens a menu on the keypad, so it can't be pressed remotely";
    case "not_assigned":
      return "Nothing is assigned to this key";
    case "busy":
      return "The keypad is busy with another macro or a file transfer";
    case "updating":
      return "The keypad is updating its firmware";
    case "bad_key":
    case "bad_layer":
    case "bad_gesture":
      return "The keypad doesn't have that key or layer";
    default:
      return "The keypad refused the key press";
  }
}

/** Build a global-shortcut accelerator ("Ctrl+Alt+Shift+S") from a keydown.
 * Returns null while only modifiers are held. Names follow the Rust
 * global-hotkey parser (it upper-cases, so KeyboardEvent.code mostly works
 * as-is). */
export function accelFromEvent(e: {
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  code: string;
}): string | null {
  const code = e.code;
  if (!code || /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(code)) return null;
  let key = code;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  const mods = [
    e.ctrlKey && "Ctrl",
    e.altKey && "Alt",
    e.shiftKey && "Shift",
    e.metaKey && "Super",
  ].filter(Boolean);
  return [...mods, key].join("+");
}

/** Split an accelerator into display chips, with platform-friendly names. */
export function accelParts(accel: string, mac: boolean): string[] {
  return accel
    .split("+")
    .filter(Boolean)
    .map((p) => {
      const u = p.toUpperCase();
      if (u === "CTRL" || u === "CONTROL") return mac ? "Control" : "Ctrl";
      if (u === "ALT" || u === "OPTION") return mac ? "Option" : "Alt";
      if (u === "SUPER" || u === "CMD" || u === "COMMAND") return mac ? "Cmd" : "Win";
      if (u === "SHIFT") return "Shift";
      return p.length === 1 ? p.toUpperCase() : p;
    });
}

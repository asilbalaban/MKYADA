// OBS Center — the host side of the live OBS dashboard (proto v13).
//
// A key of kind "obs_center" opens a persistent `mtype:"obs"` menu with
// `obsview:"center"` on the Vision 6. This module owns that session: it
// subscribes to the Rust client's `obs:changed` (scene/rec/live) and
// `obs:live` (timer/stats/meter) events, keeps a desired-vs-pushed diff, and
// pushes change-gated deltas through a single 300ms pump — at most one serial
// line per pump tick — plus a full re-assert every 5s so a push lost during a
// device repaint heals itself (the issue-#37 pattern). While the session is
// open the six physical keys reach us as `btn` edges (the firmware swallows
// their local macros) and fire the configured OBS quick actions.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { obsActionToRequest } from "./macro-model";
import type { MacroFile, ObsCenterConfig, ObsLive, ObsSnapshot } from "./types";

/** What one full push carries. `undefined` = widget off, never sent. */
interface CenterState {
  rec?: boolean;
  live?: boolean;
  time?: string;
  scene?: string;
  mic?: number;
  mute?: boolean;
  cpu?: number;
  fps?: number;
  drop?: number;
  klabels?: string[];
  focus?: "mic" | "scene";
}

const PUMP_MS = 300;
const REASSERT_MS = 5000;
/** Scene-browse mode: revert the pill to the live scene after this idle. */
const SCENE_REVERT_MS = 3000;
/** One encoder detent in mic mode, in dB (clamped to -60..0). */
const MIC_STEP_DB = 1.5;

interface Session {
  cfg: ObsCenterConfig;
  sendMenu: (fields: Record<string, unknown>) => void;
  desired: CenterState;
  pushed: CenterState | null; // null = nothing pushed yet (first push is full)
  pump: ReturnType<typeof setInterval>;
  lastFull: number;
  unlisten: (() => void)[];
  // timer: seconds at the last obs:live poll + when we heard it, ticked
  // locally at 1Hz between polls so the display never stutters
  timerBase: number;
  timerAt: number;
  timerRunning: boolean;
  // scene-browse mode state
  scenes: string[];
  sceneIdx: number;
  browseAt: number; // 0 = not browsing
  liveScene: string;
  micDb: number | null;
  /** which control the wheel drives; holding CONFIRM cycles through these */
  focusTargets: ("mic" | "scene")[];
  focus: "mic" | "scene" | null;
  /** resolved audio input: the configured one, else OBS's own default mic */
  micInput: string | null;
}

let session: Session | null = null;

export function isObsCenterOpen(): boolean {
  return session !== null;
}

function fmtElapsed(secs: number): string {
  const h = Math.trunc(secs / 3600);
  const m = Math.trunc((secs % 3600) / 60);
  const s = Math.trunc(secs % 60);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}`;
}

function timerSecs(s: Session): number {
  if (!s.timerRunning) return s.timerBase;
  return s.timerBase + Math.round((Date.now() - s.timerAt) / 1000);
}

/** Push whatever changed since the last push; everything on the first push
 * and every REASSERT_MS after. Called from the pump only, so a burst of
 * events (meter + stats + a scene change) still costs one serial line. */
function flush(s: Session, force = false) {
  const now = Date.now();
  const full = force || s.pushed === null || now - s.lastFull >= REASSERT_MS;
  const out: Record<string, unknown> = {};
  const d = s.desired;
  for (const k of Object.keys(d) as (keyof CenterState)[]) {
    const v = d[k];
    if (v === undefined) continue;
    const prev = s.pushed?.[k];
    const changed = Array.isArray(v) ? JSON.stringify(v) !== JSON.stringify(prev) : v !== prev;
    if (full || changed) out[k] = v;
  }
  // a forced push always goes out, even with every widget off — the device
  // is waiting on it to draw its first (possibly empty) frame
  if (!Object.keys(out).length && !force) return;
  s.sendMenu({ mtype: "obs", obsview: "center", ...out });
  s.pushed = { ...(s.pushed ?? {}), ...(out as CenterState) };
  if (full) s.lastFull = now;
}

function applySnapshot(s: Session, snap: ObsSnapshot | null) {
  const w = s.cfg.widgets ?? {};
  s.liveScene = snap?.currentScene ?? "";
  if (w.status !== false) {
    s.desired.rec = !!snap?.recording;
    s.desired.live = !!snap?.streaming;
  }
  if (w.scene !== false && !s.browseAt) s.desired.scene = s.liveScene || "-";
  // record/stream state flipping restarts the local timer tick immediately;
  // the next 2s poll corrects the base
  const running = !!snap?.recording || !!snap?.streaming;
  if (running !== s.timerRunning) {
    s.timerRunning = running;
    s.timerAt = Date.now();
    if (!running) s.timerBase = 0;
  }
}

function applyLive(s: Session, l: ObsLive) {
  const w = s.cfg.widgets ?? {};
  if (l.recSecs !== undefined || l.streamSecs !== undefined) {
    // prefer the recording clock when both run (the demo's main use case)
    const secs = l.recSecs && l.recSecs > 0 ? l.recSecs : (l.streamSecs ?? l.recSecs ?? 0);
    if (secs > 0 || !s.timerRunning) {
      s.timerBase = secs;
      s.timerAt = Date.now();
    }
  }
  if (w.mic !== false) {
    if (l.micPct !== undefined) s.desired.mic = l.micPct;
    if (l.micMuted !== undefined) s.desired.mute = l.micMuted;
  }
  if (w.health !== false) {
    if (l.cpu !== undefined) s.desired.cpu = Math.round(l.cpu);
    if (l.fps !== undefined) s.desired.fps = Math.round(l.fps);
    if (l.dropped !== undefined) s.desired.drop = l.dropped;
  }
}

/** Open the dashboard session. `sendMenu` is the wheel-menu provider's push
 * (it stamps the key/layer); the first full push happens synchronously so the
 * device's 1.5s ctx wait never times out. */
export function openObsCenter(mf: MacroFile | null, sendMenu: (fields: Record<string, unknown>) => void) {
  closeObsCenter();
  const cfg: ObsCenterConfig = mf?.obs_center ?? {};
  const w = cfg.widgets ?? {};
  // the wheel drives the visible control rows; holding CONFIRM cycles focus
  const targets: ("mic" | "scene")[] = [];
  if (w.mic !== false) targets.push("mic");
  if (w.scene !== false) targets.push("scene");
  const wheelOn = (cfg.encoder ?? "mic") !== "off" && targets.length > 0;
  const first = cfg.encoder === "scene" && targets.includes("scene") ? "scene" : targets[0];
  const s: Session = {
    cfg,
    sendMenu,
    desired: {},
    pushed: null,
    pump: setInterval(() => {
      const cur = session;
      if (!cur) return;
      if (cur.desired.time !== undefined) cur.desired.time = fmtElapsed(timerSecs(cur));
      if (cur.browseAt && Date.now() - cur.browseAt > SCENE_REVERT_MS) {
        cur.browseAt = 0;
        if ((cur.cfg.widgets ?? {}).scene !== false) cur.desired.scene = cur.liveScene || "-";
      }
      flush(cur);
    }, PUMP_MS),
    lastFull: 0,
    unlisten: [],
    timerBase: 0,
    timerAt: Date.now(),
    timerRunning: false,
    scenes: [],
    sceneIdx: 0,
    browseAt: 0,
    liveScene: "",
    micDb: null,
    focusTargets: wheelOn ? targets : [],
    focus: wheelOn ? (first ?? null) : null,
    micInput: cfg.micInput ?? null,
  };
  session = s;
  if (s.focus) s.desired.focus = s.focus;

  // widget skeleton: fields for enabled widgets only — a disabled widget is
  // never pushed, and the firmware hides what it never hears about
  if (w.status !== false) {
    s.desired.rec = false;
    s.desired.live = false;
  }
  if (w.timer !== false) s.desired.time = "00:00:00";
  if (w.scene !== false) s.desired.scene = "-";
  if (w.mic !== false) {
    s.desired.mic = 0;
    s.desired.mute = false;
  }
  if (w.health !== false) {
    s.desired.cpu = 0;
    s.desired.fps = 0;
    s.desired.drop = 0;
  }
  const kl = (cfg.quickKeys ?? []).map((q) => (q ? q.label.slice(0, 5) : ""));
  while (kl.length < 6) kl.push("");
  if (kl.some(Boolean)) s.desired.klabels = kl.slice(0, 6);

  // the device is waiting on this to draw its first frame: push now
  flush(s, true);

  // live sources
  void invoke<ObsSnapshot | null>("obs_state")
    .then((snap) => {
      if (session === s) applySnapshot(s, snap);
    })
    .catch(() => {});
  // Resolve the audio input, then start the meter/stats session on it. No
  // configured input is the common case — fall back to OBS's own default mic
  // (GetSpecialInputs mic1), then to the first input in the list, so the mic
  // widgets and the fader work with zero setup.
  void (async () => {
    let input = cfg.micInput ?? null;
    if (!input) {
      const sp = await invoke<{ mic1?: string | null }>("obs_request", {
        requestType: "GetSpecialInputs",
        requestData: {},
      }).catch(() => null);
      input = sp?.mic1 ?? null;
    }
    if (!input) {
      const r = await invoke<{ inputs?: { inputName: string }[] }>("obs_request", {
        requestType: "GetInputList",
        requestData: {},
      }).catch(() => null);
      input = r?.inputs?.[0]?.inputName ?? null;
    }
    if (session !== s) return;
    s.micInput = input;
    void invoke("obs_live_start", { inputName: input }).catch(() => {});
    if (input && w.mic !== false) {
      const r = await invoke<{ inputMuted?: boolean }>("obs_request", {
        requestType: "GetInputMute",
        requestData: { inputName: input },
      }).catch(() => null);
      if (session === s && r?.inputMuted !== undefined) s.desired.mute = r.inputMuted;
    }
  })();
  void listen<ObsSnapshot>("obs:changed", (e) => {
    if (session === s) applySnapshot(s, e.payload);
  }).then((un) => (session === s ? s.unlisten.push(un) : un()));
  void listen<ObsLive>("obs:live", (e) => {
    if (session === s) applyLive(s, e.payload);
  }).then((un) => (session === s ? s.unlisten.push(un) : un()));
}

export function closeObsCenter() {
  const s = session;
  if (!s) return;
  session = null;
  clearInterval(s.pump);
  for (const un of s.unlisten) un();
  void invoke("obs_live_stop").catch(() => {});
}

/** Encoder turn (menu_ev value ±1): drives the FOCUSED control — the mic
 * fader or the scene browser. Hold-CONFIRM (ev "mode") moves the focus. */
export function obsCenterValue(v: number) {
  const s = session;
  if (!s) return;
  if (s.focus === "mic" && s.micInput) {
    void (async () => {
      if (s.micDb === null) {
        const r = await invoke<{ inputVolumeDb?: number }>("obs_request", {
          requestType: "GetInputVolume",
          requestData: { inputName: s.micInput },
        }).catch(() => null);
        if (session !== s) return;
        s.micDb = r?.inputVolumeDb ?? 0;
      }
      s.micDb = Math.max(-60, Math.min(0, s.micDb + (v > 0 ? MIC_STEP_DB : -MIC_STEP_DB)));
      await invoke("obs_action", {
        requestType: "SetInputVolume",
        requestData: { inputName: s.micInput, inputVolumeDb: s.micDb },
      }).catch(() => {});
    })();
  } else if (s.focus === "scene") {
    void (async () => {
      if (!s.scenes.length) {
        const r = await invoke<{ scenes?: { sceneName: string }[] }>("obs_request", {
          requestType: "GetSceneList",
          requestData: {},
        }).catch(() => null);
        if (session !== s) return;
        // OBS lists newest first; reverse so "turn right" walks down the list
        s.scenes = (r?.scenes ?? []).map((x) => x.sceneName).reverse();
        s.sceneIdx = Math.max(0, s.scenes.indexOf(s.liveScene));
      }
      if (!s.scenes.length) return;
      s.sceneIdx = Math.max(0, Math.min(s.scenes.length - 1, s.sceneIdx + (v > 0 ? 1 : -1)));
      s.browseAt = Date.now();
      if ((s.cfg.widgets ?? {}).scene !== false) s.desired.scene = `>${s.scenes[s.sceneIdx]}`;
    })();
  }
}

/** Encoder press (menu_ev fire): the focused control's action — mic mute
 * toggle, or "switch to the browsed scene". */
export function obsCenterFire() {
  const s = session;
  if (!s) return;
  if (s.focus === "mic" && s.micInput) {
    void invoke("obs_action", {
      requestType: "ToggleInputMute",
      requestData: { inputName: s.micInput },
    }).catch(() => {});
  } else if (s.focus === "scene" && s.browseAt && s.scenes.length) {
    s.browseAt = 0;
    void invoke("obs_action", {
      requestType: "SetCurrentProgramScene",
      requestData: { sceneName: s.scenes[s.sceneIdx] },
    }).catch(() => {});
  }
}

/** Hold-CONFIRM (menu_ev mode): move the wheel's focus to the next control
 * row. The device draws the frame from the `focus` push that follows. */
export function obsCenterMode() {
  const s = session;
  if (!s || s.focusTargets.length < 2 || !s.focus) return;
  const i = s.focusTargets.indexOf(s.focus);
  s.focus = s.focusTargets[(i + 1) % s.focusTargets.length];
  s.desired.focus = s.focus;
  if (s.focus !== "scene" && s.browseAt) {
    // leaving the scene row abandons an uncommitted browse
    s.browseAt = 0;
    if ((s.cfg.widgets ?? {}).scene !== false) s.desired.scene = s.liveScene || "-";
  }
}

/** A physical key edge while the dashboard is open: run its quick action.
 * The firmware swallowed the local macro, so this is the only executor. */
export function obsCenterBtn(key: number, edge: string) {
  const s = session;
  if (!s || edge !== "down") return;
  const q = s.cfg.quickKeys?.[key - 1];
  if (!q?.action) return;
  const { requestType, requestData } = obsActionToRequest(q.action);
  void invoke("obs_action", { requestType, requestData }).catch(() => {});
}

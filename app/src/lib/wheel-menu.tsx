// Vision 6 context-aware wheel menu — the host side (proto v9).
//
// When the user presses the wheel on a host-kind key (launch / command / sound
// / mic / webhook / OBS), the firmware can't perform it alone, so it sends a
// `ctx` message. This provider reads that key's macro file, answers with a
// `menu` describing the on-screen card/list/slider, then executes the user's
// `menu_ev` (fire / pick / value) and reports back with `menu_result`. See
// docs/serial-protocol.md and firmware/mkyada/ui.py (_ctx_host / on_menu).

import { ReactNode, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useDevice } from "./device";
import { useProfiles } from "./profiles";
import { ipc } from "./ipc";
import { macroFileCache } from "./macro-cache";
import { compileAssignment, obsActionToRequest, parseAssignment, parseDeviceMacro } from "./macro-model";
import {
  closeObsCenter,
  isObsCenterOpen,
  obsCenterBtn,
  obsCenterFire,
  obsCenterMode,
  obsCenterValue,
  openObsCenter,
} from "./obs-center";
import { serializeForDevice } from "./recorder-model";
import { playSound } from "./sound";
import type { Assignment, MacroFile, ObsSnapshot, Profile, WebhookRequest } from "./types";

interface OpenMenu {
  key: number;
  layer: string;
  file: string;
  kind: string;
  sub?: string;
  mf: MacroFile | null;
  /** last slider % pushed to the device (avoids redundant repaints) */
  volPct?: number;
}

/** OBS actions that show a live status card and toggle on CONFIRM. */
const OBS_STATUS: Record<string, { title: string; flag: keyof ObsSnapshot; on: string; off: string }> = {
  recordToggle: { title: "RECORD", flag: "recording", on: "REC ●", off: "READY" },
  recordStart: { title: "RECORD", flag: "recording", on: "REC ●", off: "READY" },
  recordStop: { title: "RECORD", flag: "recording", on: "REC ●", off: "READY" },
  streamToggle: { title: "STREAM", flag: "streaming", on: "LIVE ●", off: "READY" },
  streamStart: { title: "STREAM", flag: "streaming", on: "LIVE ●", off: "READY" },
  streamStop: { title: "STREAM", flag: "streaming", on: "LIVE ●", off: "READY" },
  virtualCamToggle: { title: "VIRTUAL CAM", flag: "virtualCam", on: "ON", off: "OFF" },
  replayBufferToggle: { title: "REPLAY", flag: "replayBuffer", on: "ON", off: "OFF" },
};

function basename(p?: string): string {
  if (!p) return "";
  const b = p.split(/[\\/]/).pop() ?? p;
  return b.length > 12 ? b.slice(0, 11) + "…" : b;
}

function trunc(s: string): string {
  return s.length > 12 ? s.slice(0, 11) + "…" : s;
}

/** List label for a webhook entry: its label, else the URL's host. */
function hookLabel(h: WebhookRequest & { label?: string }, i: number): string {
  if (h.label) return trunc(h.label);
  try {
    return trunc(new URL(h.url).hostname.replace(/^www\./, ""));
  } catch {
    return trunc(h.url) || `#${i + 1}`;
  }
}

/** The wheel list of a multi-value key: [id, label, marked] rows plus the
 * cursor start. Null when the key has a single value (card instead). */
function multiItems(all: string[] | null | undefined, def: string | undefined) {
  if (!all || all.length < 2) return null;
  const sel = Math.max(0, all.indexOf(def ?? ""));
  return { items: all.map((p, i) => [String(i), basename(p), i === sel ? 1 : 0]), sel };
}

export function WheelMenuProvider({ children }: { children: ReactNode }) {
  const { onMsg, send, drive, hello, port } = useDevice();
  const { activeProfile, profiles, saveProfiles } = useProfiles();
  // refs so the single subscription below always sees the latest values
  const driveRef = useRef(drive);
  driveRef.current = drive;
  const protoRef = useRef(hello?.proto ?? 0);
  protoRef.current = hello?.proto ?? 0;
  const profRef = useRef<{ active: Profile | null; all: Profile[]; save: typeof saveProfiles }>({
    active: activeProfile,
    all: profiles,
    save: saveProfiles,
  });
  profRef.current = { active: activeProfile, all: profiles, save: saveProfiles };

  const openRef = useRef<OpenMenu | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const obsUnlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const stopPoll = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
    const stopObs = () => {
      obsUnlistenRef.current?.();
      obsUnlistenRef.current = null;
    };
    const closeMenu = () => {
      stopPoll();
      stopObs();
      closeObsCenter();
      openRef.current = null;
    };
    const sendMenu = (fields: Record<string, unknown>) => {
      const o = openRef.current;
      if (!o) return;
      void send({ t: "menu", key: o.key, layer: o.layer, ...fields });
    };
    const sendResult = (ok: boolean, toast?: [string, string], changed?: string) => {
      void send({ t: "menu_result", ok, ...(toast ? { toast } : {}), ...(changed ? { changed } : {}) });
      closeMenu();
    };

    // ---- mic (system mute mode) ------------------------------------------
    // A mode browser: turn to highlight toggle / mute / unmute, tap to do it
    // live, hold to reassign the key to that mode.
    const MIC_MODES: [string, string][] = [
      ["toggle", "Toggle"],
      ["mute", "Mute"],
      ["unmute", "Unmute"],
    ];
    const buildMicList = (o: OpenMenu) => {
      const cur = o.mf?.mic_mode ?? "toggle";
      const items = MIC_MODES.map(([id, label]) => [id, label, id === cur ? 1 : 0]);
      const sel = Math.max(0, MIC_MODES.findIndex(([id]) => id === cur));
      sendMenu({ mtype: "list", title: "MIC", items, sel, action: "Do", hold: true });
    };

    // ---- system output volume / mic input level (host sliders) -----------
    // both are the same shape: read a %, turn to set it live, poll for external
    // changes. `cmd` picks output vs mic; `kind` gates the poll.
    const levelSlider = async (getCmd: string, title: string) => {
      const v = await invoke<{ percent: number; muted: boolean } | null>(getCmd).catch(() => null);
      const pct = v?.percent ?? 0;
      const o = openRef.current;
      if (o) o.volPct = pct;
      return { mtype: "slider", title, value: pct, min: 0, max: 100, step: 2, unit: "%", action: "OK" };
    };
    const startLevelPoll = (kind: "volume" | "mic_level", getCmd: string, title: string) => {
      stopPoll();
      pollRef.current = setInterval(() => {
        void (async () => {
          const o = openRef.current;
          if (o?.kind !== kind) return stopPoll();
          const prev = o.volPct;
          const menu = await levelSlider(getCmd, title);
          if (o.volPct !== prev) sendMenu(menu); // repaint only on external change
        })();
      }, 1000);
    };

    // ---- OBS --------------------------------------------------------------
    const obsCard = (action: string, snap: ObsSnapshot | null) => {
      const spec = OBS_STATUS[action];
      if (!spec) return { mtype: "card", title: "OBS", big: "OBS", hint: "run" };
      const on = !!snap?.[spec.flag];
      return { mtype: "card", title: spec.title, big: on ? spec.on : spec.off, l1: snap?.connected ? "" : "not connected", hint: "toggle" };
    };
    const openObsStatus = async (action: string) => {
      const snap = await invoke<ObsSnapshot | null>("obs_state").catch(() => null);
      sendMenu(obsCard(action, snap));
      // live updates while this card is open
      stopObs();
      const p = listen<ObsSnapshot>("obs:changed", (e) => {
        if (openRef.current?.kind === "obs") sendMenu(obsCard(action, e.payload));
      });
      void p.then((un) => {
        if (openRef.current) obsUnlistenRef.current = un;
        else un();
      });
    };
    const openScenePicker = async (mf: MacroFile | null) => {
      const r = await invoke<{ scenes?: { sceneName: string }[]; currentProgramSceneName?: string }>("obs_request", {
        requestType: "GetSceneList",
        requestData: {},
      }).catch(() => null);
      const scenes = (r?.scenes ?? []).map((s) => s.sceneName);
      if (!scenes.length) {
        sendResult(false, ["OBS", "not connected"]);
        return;
      }
      const live = r?.currentProgramSceneName;
      const assigned = mf?.obs?.sceneName;
      const items = scenes.map((s) => [s, s, s === live ? 1 : 0]);
      const sel = Math.max(0, scenes.indexOf(assigned ?? live ?? ""));
      sendMenu({ mtype: "list", title: "SCENE", items, sel, action: "Pick", hold: true });
    };

    // Reassign the key to a new assignment (wheel "hold"). Profile keys go
    // through the store (keeps profiles.json and the drive in sync); global
    // keys are rewritten straight on the drive.
    const reassignKey = async (o: OpenMenu, assignment: Assignment, toast: [string, string]) => {
      const prof = profRef.current;
      if (prof.active) {
        const next = prof.all.map((p) =>
          p.id === prof.active!.id ? { ...p, keys: { ...p.keys, [String(o.key)]: assignment } } : p,
        );
        await prof.save(next).catch(() => {});
      } else {
        const d = driveRef.current;
        const macro = compileAssignment(assignment);
        if (d && macro) await ipc.driveWrite(d.path, o.file, serializeForDevice(macro, protoRef.current)).catch(() => {});
      }
      // the cached copy predates this rewrite — reopening the menu must re-read
      const d = driveRef.current;
      if (d) macroFileCache.invalidate(d.path, o.file);
      sendResult(true, toast, `/${o.file}`);
    };

    // A list item was chosen: a tap ("pick") uses it live and keeps the menu
    // open; a hold ("assign") reprograms the key.
    const onSelect = async (o: OpenMenu, ev: "pick" | "assign", id: string) => {
      if (o.kind === "obs" && (o.mf?.obs?.action ?? o.sub) === "setScene") {
        if (ev === "assign") {
          await reassignKey(o, { kind: "obs", action: "setScene", sceneName: id }, ["SCENE", id.slice(0, 16)]);
        } else {
          // pick = switch OBS live, then refresh the live marker
          await invoke("obs_action", {
            requestType: "SetCurrentProgramScene",
            requestData: { sceneName: id },
          }).catch(() => {});
          await openScenePicker(o.mf);
        }
      } else if (o.kind === "mic") {
        if (ev === "assign") {
          const mode = id as "toggle" | "mute" | "unmute";
          if (o.mf) o.mf.mic_mode = mode;
          await reassignKey(o, { kind: "mic", mode }, ["MIC", id]);
        } else {
          await invoke("mic_action", { mode: id }).catch(() => {}); // do it now, stay open
        }
      } else if (o.mf && (o.kind === "sound" || o.kind === "launch" || o.kind === "command" || o.kind === "webhook")) {
        // multi-value lists: id is the row index. Tap = use it now (menu stays
        // open); hold = make it the key's default, preserving the whole list.
        const mf = o.mf;
        const i = Number(id);
        const a = parseAssignment(mf);
        if (o.kind === "sound" && a.kind === "sound") {
          const entry = mf.sounds?.[i];
          if (!entry) return;
          if (ev === "assign") {
            await reassignKey(o, { ...a, file: entry.sound }, [
              "SOUND",
              entry.label ? trunc(entry.label) : basename(entry.sound),
            ]);
          } else void playSound(entry.sound).catch(() => {});
        } else if (o.kind === "launch" && a.kind === "launch") {
          const target = mf.targets?.[i];
          if (!target) return;
          if (ev === "assign") await reassignKey(o, { ...a, target }, ["OPEN", basename(target)]);
          else await invoke("open_target", { target }).catch(() => {});
        } else if (o.kind === "command" && a.kind === "command") {
          const entry = mf.commands?.[i];
          if (!entry) return;
          if (ev === "assign") {
            await reassignKey(o, { ...a, command: entry.command }, [
              "COMMAND",
              entry.label ? trunc(entry.label) : trunc(entry.command),
            ]);
          } else await invoke("run_command", { command: entry.command }).catch(() => {});
        } else if (o.kind === "webhook" && a.kind === "webhook") {
          const def: WebhookRequest & { label?: string } = {
            url: a.url,
            ...(a.method ? { method: a.method } : {}),
            ...(a.headers?.length ? { headers: a.headers } : {}),
            ...(a.body ? { body: a.body } : {}),
          };
          const all = [def, ...(a.hooks ?? [])];
          const h = all[i];
          if (!h?.url) return;
          if (ev === "assign") {
            if (i === 0) return sendResult(true, ["WEBHOOK", "default"]);
            // swap: the chosen alternative becomes the default, the old
            // default takes its slot in the list
            const hooks = (a.hooks ?? []).map((x, k) => (k === i - 1 ? def : x));
            await reassignKey(
              o,
              { ...a, url: h.url, method: h.method, headers: h.headers, body: h.body, hooks },
              ["WEBHOOK", hookLabel(h, i)],
            );
          } else {
            await invoke("http_request", {
              url: h.url,
              method: h.method ?? null,
              headers: h.headers ?? null,
              body: h.body ?? null,
            }).catch(() => {});
          }
        }
      }
    };

    const buildMenu = async (o: OpenMenu) => {
      const mf = o.mf;
      // Multi-value keys (several targets/commands/sounds/requests defined in
      // the app) get a list: tap = use one now, hold = make it the default.
      // Single-value keys keep their card, with a line pointing at the app.
      switch (o.kind) {
        case "launch": {
          const m = multiItems(mf?.targets, mf?.target);
          if (m) sendMenu({ mtype: "list", title: "OPEN", items: m.items, sel: m.sel, action: "Open", hold: true });
          else sendMenu({ mtype: "card", title: "OPEN", big: basename(mf?.target) || "OPEN", l1: "add more in app", hint: "open" });
          break;
        }
        case "command": {
          const cmds = mf?.commands;
          if (cmds && cmds.length >= 2) {
            const sel = Math.max(0, cmds.findIndex((c) => c.command === mf?.command));
            const items = cmds.map((c, i) => [String(i), c.label ? trunc(c.label) : trunc(c.command), i === sel ? 1 : 0]);
            sendMenu({ mtype: "list", title: "COMMAND", items, sel, action: "Run", hold: true });
          } else sendMenu({ mtype: "card", title: "COMMAND", big: "RUN", l1: "add more in app", hint: "run" });
          break;
        }
        case "sound": {
          const snds = mf?.sounds;
          if (snds && snds.length >= 2) {
            // per-entry name when the user gave one, else the file name
            const sel = Math.max(0, snds.findIndex((s) => s.sound === mf?.sound));
            const items = snds.map((s, i) => [
              String(i),
              s.label ? trunc(s.label) : basename(s.sound),
              i === sel ? 1 : 0,
            ]);
            sendMenu({ mtype: "list", title: "SOUND", items, sel, action: "Play", hold: true });
          } else sendMenu({ mtype: "card", title: "SOUND", big: basename(mf?.sound) || "SOUND", l1: "add more in app", hint: "play" });
          break;
        }
        case "webhook": {
          const hooks = mf?.webhooks;
          if (hooks?.length && mf?.webhook) {
            // default first, then the alternatives
            const all = [mf.webhook, ...hooks];
            const items = all.map((h, i) => [String(i), hookLabel(h, i), i === 0 ? 1 : 0]);
            sendMenu({ mtype: "list", title: "WEBHOOK", items, sel: 0, action: "Send", hold: true });
          } else sendMenu({ mtype: "card", title: "WEBHOOK", big: "SEND", l1: "add more in app", hint: "run" });
          break;
        }
        case "mic":
          buildMicList(o);
          break;
        case "volume":
          sendMenu(await levelSlider("output_volume_get", "VOLUME"));
          startLevelPoll("volume", "output_volume_get", "VOLUME");
          break;
        case "mic_level":
          sendMenu(await levelSlider("mic_level_get", "MIC LEVEL"));
          startLevelPoll("mic_level", "mic_level_get", "MIC LEVEL");
          break;
        case "obs": {
          const action = mf?.obs?.action ?? o.sub ?? "";
          if (action === "setScene") await openScenePicker(mf);
          else if (OBS_STATUS[action]) await openObsStatus(action);
          else sendMenu({ mtype: "card", title: "OBS", big: action.replace(/([A-Z])/g, " $1").trim().toUpperCase().slice(0, 12) || "OBS", hint: "run" });
          break;
        }
        case "obs_center":
          // the live dashboard: obs-center.ts owns the session and pushes
          // change-gated obsview:"center" updates through sendMenu
          openObsCenter(mf, sendMenu);
          break;
        default:
          sendMenu({ mtype: "card", title: "WHEEL", big: o.kind.toUpperCase(), hint: "run" });
      }
    };

    const onFire = async (o: OpenMenu) => {
      const mf = o.mf;
      switch (o.kind) {
        case "launch":
          if (mf?.target) await invoke("open_target", { target: mf.target }).catch(() => {});
          sendResult(true, ["OPEN", "opened"]);
          break;
        case "command":
          if (mf?.command) await invoke("run_command", { command: mf.command }).catch(() => {});
          sendResult(true, ["COMMAND", "ran"]);
          break;
        case "sound":
          if (mf?.sound) void playSound(mf.sound).catch(() => {});
          sendResult(true, ["SOUND", "playing"]);
          break;
        case "webhook": {
          const w = mf?.webhook;
          if (!w?.url) return sendResult(false, ["WEBHOOK", "no url"]);
          try {
            const st = await invoke<number>("http_request", {
              url: w.url,
              method: w.method ?? null,
              headers: w.headers ?? null,
              body: w.body ?? null,
            });
            sendResult(true, ["WEBHOOK", `${st} OK`]);
          } catch {
            sendResult(false, ["WEBHOOK", "failed"]);
          }
          break;
        }
        case "obs": {
          const req = mf?.obs;
          if (req?.action) {
            const { requestType, requestData } = obsActionToRequest(req);
            await invoke("obs_action", { requestType, requestData }).catch(() => {});
          }
          // status cards stay open (live update repaints them); other OBS
          // actions are one-shot.
          if (!OBS_STATUS[req?.action ?? ""]) sendResult(true, ["OBS", "sent"]);
          break;
        }
        default:
          sendResult(true);
      }
    };

    const onCtx = async (m: Record<string, unknown>) => {
      const d = driveRef.current;
      const file = String(m.file ?? "").replace(/^\//, "");
      let mf: MacroFile | null = null;
      if (d && file) {
        // Cache first — a serial read here blocks the single-threaded keypad
        // (it is literally waiting for this reply to draw the menu) and used
        // to push past its fallback timeout, so sliders never appeared.
        mf = macroFileCache.get(d.path, file) ?? null;
        if (!mf) {
          mf = await ipc.driveRead(d.path, file).then((raw) => parseDeviceMacro(raw)).catch(() => null);
          if (mf) macroFileCache.set(d.path, file, mf);
        }
      }
      openRef.current = {
        key: Number(m.key),
        layer: String(m.layer ?? "a"),
        file,
        kind: String(m.kind ?? ""),
        sub: m.sub == null ? undefined : String(m.sub),
        mf,
      };
      await buildMenu(openRef.current);
    };

    const onEv = async (m: Record<string, unknown>) => {
      const o = openRef.current;
      if (!o) return;
      const ev = String(m.ev);
      if (ev === "close") closeMenu();
      else if (o.kind === "obs_center") {
        if (ev === "fire") obsCenterFire();
        else if (ev === "mode") obsCenterMode();
        else if (ev === "value") obsCenterValue(Number(m.v) || 0);
      } else if (ev === "fire") await onFire(o);
      else if (ev === "pick" || ev === "assign") await onSelect(o, ev, String(m.id ?? ""));
      else if (ev === "value" && (o.kind === "volume" || o.kind === "mic_level")) {
        const pct = Math.max(0, Math.min(100, Number(m.v)));
        o.volPct = pct; // our own change — don't let the poll repaint it
        const cmd = o.kind === "volume" ? "output_volume_set" : "mic_level_set";
        await invoke(cmd, { percent: pct }).catch(() => {});
      }
    };

    const un = onMsg((m) => {
      if (m.t === "ctx") void onCtx(m);
      else if (m.t === "menu_ev") void onEv(m);
      else if (m.t === "btn" && isObsCenterOpen()) {
        // dashboard quick actions: the firmware swallowed the local macro,
        // this edge is the only thing that runs the key
        obsCenterBtn(Number(m.key), String(m.edge));
      }
    });
    return () => {
      un();
      stopPoll();
      stopObs();
      openRef.current = null;
    };
  }, [onMsg, send]);

  // Push the live system output volume to the device while connected, so a
  // volume key can show its % on the grid (the device can't read it itself).
  // Only sends on change; the firmware ignores it unless a volume key exists.
  useEffect(() => {
    if (!port) return;
    let last = -1;
    const push = async () => {
      const v = await invoke<{ percent: number } | null>("output_volume_get").catch(() => null);
      if (v && v.percent !== last) {
        last = v.percent;
        void send({ t: "sysvol", percent: v.percent });
      }
    };
    void push();
    const t = setInterval(() => void push(), 2000);
    return () => clearInterval(t);
  }, [port, send]);

  return <>{children}</>;
}

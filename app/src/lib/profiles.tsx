// Per-application profile engine.
//
// Watches the foreground app; when a profile matches (and a device is
// connected) the device is held in host mode: its key presses stream here and
// are answered with `play` commands referencing profile macros already synced
// to the drive — so playback is still hardware HID. With no match the device
// is released to standalone (the on-device config is the global default).

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";
import { fadeOutSounds, playSound, stopAllSounds } from "./sound";
import { useDevice } from "./device";

/** Holding a sound key this long stops all playing sounds instead of playing. */
const SOUND_HOLD_STOP_MS = 400;

import { ipc } from "./ipc";
import type {
  Assignment,
  DriveInfo,
  ForegroundInfo,
  Hello,
  ModuleSlot,
  Profile,
  SequenceStep,
  SoundHoldAction,
  WebhookRequest,
} from "./types";
import { DOUBLE_MS_DEFAULT, HOLD_MS_DEFAULT, LAYER_NAMES } from "./types";
import {
  AUX_FILE_RE,
  compileAssignment,
  compileSequenceParts,
  compileVariantParts,
  macroFileName,
  parseDeviceMacro,
  profileKeySlot,
  profileMacroFileName,
  sequenceIsPureHid,
  sequencePartFileName,
  stepIsHid,
} from "./macro-model";
import { serializeForDevice } from "./recorder-model";

/** Perform a computer-side key action (Stream Deck style): open an
 *  app/file/URL, run a shell command, play a sound or call a webhook. HID
 *  can't do these, so they only work while the desktop app is running.
 *  Accepts either an Assignment ({file}, top-level webhook fields) or a
 *  MacroFile ({sound}, nested {webhook}) shape. */
function runHostAction(a: {
  kind?: string;
  target?: string;
  command?: string;
  sound?: string;
  file?: string;
  mic_mode?: string;
  mode?: string;
  url?: string;
  method?: string;
  headers?: { name: string; value: string }[];
  body?: string;
  webhook?: WebhookRequest;
}) {
  if (a.kind === "launch" && a.target) {
    // open_target handles URLs and paths alike (plugin-opener's openPath
    // is capability-scoped and silently rejects /Applications/*.app)
    void invoke("open_target", { target: a.target }).catch(() => {});
  } else if (a.kind === "command" && a.command) {
    void invoke("run_command", { command: a.command }).catch(() => {});
  } else if (a.kind === "sound") {
    const path = a.sound ?? a.file;
    if (path) void playSound(path).catch(() => {});
  } else if (a.kind === "mic") {
    // push-to-talk is edge-driven (unmute on down, mute on up) and handled
    // at the down/up dispatch sites instead — nothing to do on a single fire.
    const mode = a.mic_mode ?? a.mode ?? "toggle";
    if (mode !== "push_to_talk") void invoke("mic_action", { mode }).catch(() => {});
  } else if (a.kind === "webhook") {
    const w = a.webhook ?? (a.url ? { url: a.url, method: a.method, headers: a.headers, body: a.body } : null);
    if (w?.url) {
      void invoke("http_request", {
        url: w.url,
        method: w.method ?? null,
        headers: w.headers ?? null,
        body: w.body ?? null,
      }).catch((e) => console.warn("webhook failed:", e));
    }
  }
}

const store = new LazyStore("profiles.json");

interface ProfilesState {
  profiles: Profile[];
  foreground: ForegroundInfo;
  activeProfile: Profile | null;
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  saveProfiles: (profiles: Profile[]) => Promise<void>;
}

const Ctx = createContext<ProfilesState | null>(null);

function matches(p: Profile, fg: ForegroundInfo): boolean {
  if (!p.match.exe) return false;
  if (p.match.exe.toLowerCase() !== fg.exe.toLowerCase()) return false;
  if (p.match.title_contains && !fg.title.toLowerCase().includes(p.match.title_contains.toLowerCase()))
    return false;
  return true;
}

export function ProfilesProvider({ children }: { children: ReactNode }) {
  const { port, drive, hello, send, onBtn, onMsg, updating } = useDevice();
  const driveRef = useRef<DriveInfo | null>(null);
  driveRef.current = drive;
  const helloRef = useRef<Hello | null>(null);
  helloRef.current = hello;
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [foreground, setForeground] = useState<ForegroundInfo>({ exe: "", title: "" });
  const [enabled, setEnabledState] = useState(true);
  // tray "Pause key actions": suspends profiles AND global host actions
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const activeRef = useRef<Profile | null>(null);
  const [activeProfile, setActiveProfile] = useState<Profile | null>(null);

  // load persisted state + start the foreground watcher
  useEffect(() => {
    void (async () => {
      setProfiles(((await store.get<Profile[]>("profiles")) ?? []) as Profile[]);
      setEnabledState((await store.get<boolean>("enabled")) ?? true);
      await invoke("foreground_start");
    })();
    const un = listen("foreground:changed", (e) => setForeground(e.payload as ForegroundInfo));
    const unPause = listen("host:paused", (e) => setPaused(e.payload as boolean));
    return () => {
      un.then((f) => f());
      unPause.then((f) => f());
    };
  }, []);

  // resolve the active profile whenever anything relevant changes
  useEffect(() => {
    const active =
      enabled && !paused && port ? profiles.find((p) => matches(p, foreground)) ?? null : null;
    activeRef.current = active;
    setActiveProfile(active);
  }, [enabled, paused, port, profiles, foreground]);

  // keep the keypad's grid band (config show_profile) naming the active
  // profile; empty text clears it. Since proto v6 the message also carries
  // the profile's six key names — the host-mode screen shows them as a grid
  // instead of the bare "Connected to app" text. Old firmware ignores the
  // message, and the device drops everything on app disconnect.
  useEffect(() => {
    if (!port || updating) return; // a firmware update owns the link
    const keys = activeProfile
      ? [1, 2, 3, 4, 5, 6].map((n) => {
          const a = activeProfile.keys[String(n)];
          return (a && a.kind !== "none" && compileAssignment(a)?.name) || "";
        })
      : undefined;
    void send({
      t: "label",
      text: activeProfile?.name ?? "",
      ...(keys?.some(Boolean) ? { keys } : {}),
    }).catch(() => {});
  }, [port, activeProfile, send, updating]);

  // Activate the profile on the device instead of holding host mode
  // (issue #23): the firmware redirects its macro paths to this profile's
  // files, so the whole on-device UI — grid, wheel, speed editor — runs the
  // profile natively. Un-overridden keys/controls fall back to the standalone
  // config on the device. The 2s re-assert re-arms it after a reconnect (the
  // device clears the profile on disconnect); it's a no-op when unchanged.
  // Suspended during a firmware update (the link is locked).
  useEffect(() => {
    if (!port || updating) return;
    const pid = activeProfile ? `p_${activeProfile.id}` : null;
    void send({ t: "profile", id: pid });
    const tick = setInterval(() => void send({ t: "profile", id: pid }), 2000);
    return () => {
      clearInterval(tick);
      if (pid) void send({ t: "profile", id: null }).catch(() => {});
    };
  }, [port, activeProfile, send, updating]);

  // ---- mixed-sequence orchestration -------------------------------------
  // Pure-HID sequences are one macro file the keypad plays by itself. Mixed
  // ones run here: HID steps as pre-compiled part files played over serial
  // (still hardware HID, awaiting play_done), host steps performed directly.
  const seqActive = useRef(new Map<string, { cancelled: boolean }>());
  const playDoneWaiters = useRef<(() => void)[]>([]);

  useEffect(
    () =>
      onMsg((m) => {
        if (m.t === "play_done") playDoneWaiters.current.shift()?.();
      }),
    [onMsg],
  );

  const waitPlayDone = useCallback((timeoutMs = 60_000) => {
    return new Promise<void>((resolve) => {
      const entry = () => {
        clearTimeout(timer);
        resolve();
      };
      playDoneWaiters.current.push(entry);
      const timer = setTimeout(() => {
        const idx = playDoneWaiters.current.indexOf(entry);
        if (idx >= 0) playDoneWaiters.current.splice(idx, 1);
        resolve();
      }, timeoutMs);
    });
  }, []);

  const runSequence = useCallback(
    async (keyId: string, steps: SequenceStep[], mainFile: string) => {
      const running = seqActive.current.get(keyId);
      if (running) {
        // pressing the key again mid-sequence stops it (on_repress semantics)
        running.cancelled = true;
        void send({ t: "stop" });
        return;
      }
      const state = { cancelled: false };
      seqActive.current.set(keyId, state);
      try {
        for (let i = 0; i < steps.length && !state.cancelled; i++) {
          const step = steps[i];
          if (stepIsHid(step)) {
            const done = waitPlayDone();
            await send({ t: "play", file: sequencePartFileName(mainFile, i) });
            await done;
          } else if (step.a.kind === "sound") {
            void playSound(step.a.file).catch(() => {});
          } else {
            runHostAction(step.a);
          }
          if (!state.cancelled && step.delayMs > 0 && i < steps.length - 1) {
            await new Promise((r) => setTimeout(r, step.delayMs));
          }
        }
      } finally {
        seqActive.current.delete(keyId);
      }
    },
    [send, waitPlayDone],
  );

  // ---- key logic (tap / double / hold) for PROFILE keys ------------------
  // In host mode the device only streams edges — the app is the decider,
  // using the same timing rules as the firmware's standalone resolver.
  // (Global keys: the FIRMWARE decides and announces via "key_action".)
  interface KlState {
    phase: "down" | "wait2";
    holdTimer?: number;
    doubleTimer?: number;
    hasDouble: boolean;
    run: (choice: "tap" | "double" | "hold") => void;
  }
  const klStates = useRef(new Map<string, KlState>());

  const startKeyLogic = useCallback(
    (keyId: string, a: Assignment, run: KlState["run"]) => {
      const st: KlState = {
        phase: "down",
        hasDouble: !!a.variants?.double,
        run,
      };
      if (a.variants?.hold) {
        st.holdTimer = window.setTimeout(() => {
          klStates.current.delete(keyId);
          run("hold");
        }, HOLD_MS_DEFAULT);
      }
      klStates.current.set(keyId, st);
    },
    [],
  );

  // firmware announcements for GLOBAL keys with variants: the device chose
  // tap/double/hold and played any HID events itself; we perform host-side
  // variants (launch/command/sound, mixed sequences)
  useEffect(
    () =>
      onMsg((m) => {
        if (m.t !== "key_action" || pausedRef.current) return;
        const d = driveRef.current;
        if (!d) return;
        const file = String(m.file ?? "").replace(/^\//, "");
        void ipc
          .driveRead(d.path, file)
          .then((raw) => {
            const mf = parseDeviceMacro(raw);
            const variant = String(m.variant ?? "tap");
            const node =
              variant === "tap" ? mf : mf.variants?.[variant as "double" | "hold"];
            if (!node) return;
            if (node.kind === "sound" && node.sound) {
              void playSound(node.sound).catch(() => {});
            } else if (
              node.kind === "launch" ||
              node.kind === "command" ||
              node.kind === "mic" ||
              node.kind === "webhook"
            ) {
              runHostAction(node);
            } else if (node.kind === "sequence" && !node.events?.length && node.seq?.length) {
              void runSequence(`${m.key}:${m.layer}`, node.seq, file);
            }
          })
          .catch(() => {});
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onMsg],
  );

  // Sound keys play on RELEASE: a quick tap plays, holding the key past
  // SOUND_HOLD_STOP_MS stops everything that's playing instead — the escape
  // hatch for a sound started by accident.
  const heldKeys = useRef(new Set<string>());
  const armedSounds = useRef(new Map<string, { timer: number; path: string }>());
  // push-to-talk mic keys currently held down — unmuted on down, muted on up
  const micDownKeys = useRef(new Set<string>());
  // single keys held down as a real-keyboard hold (play {hold:true}): the
  // device keeps the HID key down until we send "stop" on the up edge, and
  // the OS typematic repeat types eeee… at the user's own keyboard rate
  const hidHoldKeys = useRef(new Set<string>());
  const protoRef = useRef(0);
  protoRef.current = hello?.proto ?? 0;

  const armSound = useCallback((keyId: string, path: string, holdAction?: SoundHoldAction) => {
    if (!heldKeys.current.has(keyId)) {
      // released before we even resolved the assignment — that's a tap
      void playSound(path).catch(() => {});
      return;
    }
    const timer = window.setTimeout(() => {
      armedSounds.current.delete(keyId);
      if (holdAction === "fade") fadeOutSounds();
      else if (holdAction === "restart") {
        stopAllSounds();
        void playSound(path).catch(() => {});
      } else stopAllSounds();
    }, SOUND_HOLD_STOP_MS);
    armedSounds.current.set(keyId, { timer, path });
  }, []);

  // answer device key presses: profile overrides in host mode, and global
  // launch/command/sound keys (Keys tab) whenever the app is around to run
  // them — the device stores those as no-op macro files, so standalone they
  // do nothing and here we perform the real action. Numbered keys and the
  // Vision 6 nav buttons (BACK/CONFIRM, issue #17) share this edge handler;
  // only the profile lookup key differs.
  const handleEdge = useCallback(
    (keyId: string, slot: number | ModuleSlot, layer: string, edge: "down" | "up") => {
        if (edge === "up") {
          heldKeys.current.delete(keyId);
          if (hidHoldKeys.current.delete(keyId)) {
            void send({ t: "stop" }); // release a held single key
          }
          if (micDownKeys.current.delete(keyId)) {
            void invoke("mic_action", { mode: "mute" }).catch(() => {});
          }
          // key logic: a release during the "down" phase means tap —
          // immediately, or after the double-press window if one exists
          const kl = klStates.current.get(keyId);
          if (kl && kl.phase === "down") {
            if (kl.holdTimer !== undefined) clearTimeout(kl.holdTimer);
            if (kl.hasDouble) {
              kl.phase = "wait2";
              kl.doubleTimer = window.setTimeout(() => {
                klStates.current.delete(keyId);
                kl.run("tap");
              }, DOUBLE_MS_DEFAULT);
            } else {
              klStates.current.delete(keyId);
              kl.run("tap");
            }
          }
          const armed = armedSounds.current.get(keyId);
          if (armed) {
            clearTimeout(armed.timer);
            armedSounds.current.delete(keyId);
            void playSound(armed.path).catch(() => {});
          }
          return;
        }
        heldKeys.current.add(keyId);
        if (pausedRef.current) return;
        // key logic: a second press inside the double window fires "double"
        const klPending = klStates.current.get(keyId);
        if (klPending?.phase === "wait2") {
          if (klPending.doubleTimer !== undefined) clearTimeout(klPending.doubleTimer);
          klStates.current.delete(keyId);
          klPending.run("double");
          return;
        }
        const profile = activeRef.current;
        if (profile) {
          // A profile is a full, independent config (issue #23): a key it
          // doesn't assign does NOTHING — no fallback to the standalone macro.
          // (Module slots the profile leaves alone keep their built-in nav;
          // that's handled on the device via slot_path's fallback.)
          const a = profile.keys[String(slot)];
          if (!a || a.kind === "none") return; // not assigned in this profile
          // The device runs this profile natively: it plays the HID, resolves
          // variants and applies per-profile speed itself. The app only
          // performs the computer-side kinds. Variant gestures are announced
          // by the firmware as key_action (handled elsewhere).
          if (a.variants?.double || a.variants?.hold) return;
          if (a.kind === "sound") return armSound(keyId, a.file, a.holdAction);
          if (a.kind === "launch" || a.kind === "command" || a.kind === "webhook") {
            return runHostAction(a);
          }
          if (a.kind === "mic") {
            if (a.mode === "push_to_talk") {
              micDownKeys.current.add(keyId);
              void invoke("mic_action", { mode: "unmute" }).catch(() => {});
            } else {
              runHostAction(a);
            }
            return;
          }
          if (a.kind === "sequence" && !sequenceIsPureHid(a.steps)) {
            return void runSequence(keyId, a.steps, profileMacroFileName(profile.id, slot));
          }
          return; // pure-HID override — the device plays it natively
        }
        // No profile active — standalone computer-side actions for numbered
        // keys: the device already played the HID, we perform the
        // launch/command/sound/webhook/mic side from the file it ran.
        if (typeof slot !== "number") return;
        const d = driveRef.current;
        if (!d) return;
        const layerIndex = Math.max(0, LAYER_NAMES.indexOf(layer));
        void ipc
          .driveRead(d.path, macroFileName(slot, layerIndex))
          .then((raw) => {
            const m = parseDeviceMacro(raw);
            // key logic: the firmware resolves tap/double/hold itself and
            // announces the choice as "key_action" — handled elsewhere
            if (m.variants && (m.variants.double || m.variants.hold)) return;
            if (m.kind === "sequence") {
              // pure-HID: the keypad already played it standalone; mixed:
              // the main file is a no-op and the steps run here
              if (!m.events.length && m.seq?.length) {
                void runSequence(keyId, m.seq, macroFileName(slot, layerIndex));
              }
              return;
            }
            if (m.kind === "sound" && m.sound) armSound(keyId, m.sound, m.sound_hold);
            else if (m.kind === "mic" && m.mic_mode === "push_to_talk") {
              micDownKeys.current.add(keyId);
              void invoke("mic_action", { mode: "unmute" }).catch(() => {});
            } else runHostAction(m);
          })
          .catch(() => {}); // unassigned key or drive hiccup — nothing to do
    },
    [send, armSound, runSequence, startKeyLogic],
  );

  useEffect(
    () => onBtn((e) => handleEdge(`${e.key}:${e.layer ?? "a"}`, e.key, e.layer ?? "a", e.edge)),
    [onBtn, handleEdge],
  );

  // ---- Vision 6 module controls under an active profile (issue #23) -------
  // The device runs the profile natively now: the wheel and nav buttons do
  // their built-in navigation (or the profile's own scroll/HID slot) on the
  // device and stream {"t":"enc"} / {"t":"btn"} so the app can perform the
  // computer-side kinds (e.g. wheel = a webhook). Nav buttons ride the same
  // edge handler as numbered keys; only the wheel needs its own here.
  const handleEncoder = useCallback(
    (dir: "enc-cw" | "enc-ccw", _detents: number) => {
      if (pausedRef.current) return;
      const profile = activeRef.current;
      const a = profile?.keys[dir];
      if (!profile || !a || a.kind === "none") return;
      // computer-side kinds fire once per rotation event; scroll/other HID is
      // played by the device natively, so there's nothing to do for those.
      if (a.kind === "sound") return void playSound(a.file).catch(() => {});
      if (a.kind === "launch" || a.kind === "command" || a.kind === "mic" || a.kind === "webhook") {
        return runHostAction(a);
      }
      if (a.kind === "sequence" && !sequenceIsPureHid(a.steps)) {
        return void runSequence(dir, a.steps, profileMacroFileName(profile.id, dir));
      }
    },
    [runSequence],
  );

  useEffect(
    () =>
      onMsg((m) => {
        if (!activeRef.current) return;
        if (m.t === "enc") {
          const d = Number(m.d ?? 0);
          if (!d) return;
          handleEncoder(d > 0 ? "enc-cw" : "enc-ccw", Math.max(1, Number(m.n) || 1));
        } else if (m.t === "btn" && typeof m.slot === "string") {
          const slot =
            m.slot === "back"
              ? "btn-back"
              : m.slot === "confirm"
                ? "btn-confirm"
                : m.slot === "psh"
                  ? "btn-psh"
                  : null;
          if (!slot) return;
          handleEdge(slot, slot, "a", m.down ? "down" : "up");
        }
      }),
    [onMsg, handleEdge, handleEncoder],
  );

  const setEnabled = useCallback((on: boolean) => {
    setEnabledState(on);
    void store.set("enabled", on).then(() => store.save());
  }, []);

  /** Persist profiles and sync their compiled macros to the device drive. */
  const saveProfiles = useCallback(
    async (next: Profile[]) => {
      setProfiles(next);
      await store.set("profiles", next);
      await store.save();
      if (!drive) return;
      for (const p of next) {
        for (const [keyNo, a] of Object.entries(p.keys)) {
          const macro = compileAssignment(a as Assignment);
          const file = profileMacroFileName(p.id, profileKeySlot(keyNo));
          if (macro) {
            await ipc.driveWrite(drive.path, file, serializeForDevice(macro, hello?.proto ?? 0));
          } else {
            await ipc.driveDelete(drive.path, file).catch(() => {});
          }
          // auxiliary files: mixed-sequence steps + key-logic variants the
          // app plays over serial in host mode; sweep stale ones
          const parts = [
            ...compileSequenceParts(a as Assignment, file),
            ...compileVariantParts(a as Assignment, file),
          ];
          for (const part of parts) {
            await ipc.driveWrite(drive.path, part.path, serializeForDevice(part.file, hello?.proto ?? 0));
          }
          const stem = file.split("/").pop()!.replace(/\.json$/, ".");
          const keep = new Set(parts.map((part) => part.path.split("/").pop()));
          const existing = await ipc.driveList(drive.path, "macros").catch(() => [] as string[]);
          for (const f of existing) {
            if (f.startsWith(stem) && AUX_FILE_RE.test(f) && !keep.has(f)) {
              await ipc.driveDelete(drive.path, `macros/${f}`).catch(() => {});
            }
          }
        }
      }
    },
    [drive, hello],
  );

  // Re-sync every profile's macro files to the device when its drive appears.
  // Files are otherwise only written on edit, so a profile configured while
  // the keypad was disconnected — or set up on another machine, or predating a
  // firmware reflash — leaves the device without the override files, and it
  // silently plays the standalone macro for that key instead (issue #23).
  // saveProfiles rewrites the whole set idempotently.
  const syncedDrive = useRef<string | null>(null);
  useEffect(() => {
    if (!drive) {
      syncedDrive.current = null; // reconnect should re-sync
      return;
    }
    if (!hello || updating || profiles.length === 0) return; // wait for proto
    if (syncedDrive.current === drive.path) return;
    syncedDrive.current = drive.path;
    void saveProfiles(profiles);
  }, [drive, hello, profiles, updating, saveProfiles]);

  return (
    <Ctx.Provider value={{ profiles, foreground, activeProfile, enabled, setEnabled, saveProfiles }}>
      {children}
    </Ctx.Provider>
  );
}

export function useProfiles(): ProfilesState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useProfiles outside ProfilesProvider");
  return ctx;
}

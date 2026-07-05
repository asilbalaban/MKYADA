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
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { useDevice } from "./device";
import { ipc } from "./ipc";
import type { Assignment, DriveInfo, ForegroundInfo, MacroFile, Profile } from "./types";
import { LAYER_NAMES } from "./types";
import { compileAssignment, macroFileName, profileMacroFileName } from "./macro-model";

/** Perform a computer-side key action (Stream Deck style): open an
 *  app/file/URL or run a shell command. HID can't do these, so they only
 *  work while the desktop app is running. */
function runHostAction(a: { kind?: string; target?: string; command?: string }) {
  if (a.kind === "launch" && a.target) {
    const t = a.target;
    void (/^https?:\/\//i.test(t) ? openUrl(t) : openPath(t)).catch(() => {});
  } else if (a.kind === "command" && a.command) {
    void invoke("run_command", { command: a.command }).catch(() => {});
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
  const { port, drive, send, onBtn } = useDevice();
  const driveRef = useRef<DriveInfo | null>(null);
  driveRef.current = drive;
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [foreground, setForeground] = useState<ForegroundInfo>({ exe: "", title: "" });
  const [enabled, setEnabledState] = useState(true);
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
    return () => {
      un.then((f) => f());
    };
  }, []);

  // resolve the active profile whenever anything relevant changes
  useEffect(() => {
    const active = enabled && port ? profiles.find((p) => matches(p, foreground)) ?? null : null;
    activeRef.current = active;
    setActiveProfile(active);
  }, [enabled, port, profiles, foreground]);

  // hold host mode while a profile is active; release it otherwise.
  // host_enter doubles as the watchdog ping and re-asserts host mode in case
  // another page (setup/keys test) issued a host_leave meanwhile.
  useEffect(() => {
    if (!port || !activeProfile) return;
    void send({ t: "host_enter" });
    const tick = setInterval(() => void send({ t: "host_enter" }), 2000);
    return () => {
      clearInterval(tick);
      void send({ t: "host_leave" });
    };
  }, [port, activeProfile, send]);

  // answer device key presses: profile overrides in host mode, and global
  // launch/command keys (Keys tab) whenever the app is around to run them —
  // the device stores those as no-op macro files, so standalone they do
  // nothing and here we perform the real action.
  useEffect(
    () =>
      onBtn((e) => {
        if (e.edge !== "down") return;
        const profile = activeRef.current;
        if (profile) {
          const a = profile.keys[String(e.key)];
          if (!a || a.kind === "none") return;
          if (a.kind === "launch" || a.kind === "command") return runHostAction(a);
          void send({ t: "play", file: profileMacroFileName(profile.id, e.key) });
          return;
        }
        const d = driveRef.current;
        if (!d) return;
        const layerIndex = Math.max(0, LAYER_NAMES.indexOf(e.layer ?? "a"));
        void ipc
          .driveRead(d.path, macroFileName(e.key, layerIndex))
          .then((raw) => runHostAction(JSON.parse(raw) as MacroFile))
          .catch(() => {}); // unassigned key or drive hiccup — nothing to do
      }),
    [onBtn, send],
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
          const file = profileMacroFileName(p.id, Number(keyNo));
          if (macro) {
            await ipc.driveWrite(drive.path, file, JSON.stringify(macro));
          } else {
            await ipc.driveDelete(drive.path, file).catch(() => {});
          }
        }
      }
    },
    [drive],
  );

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

// React side of remote playback control (see lib/playback.ts). The provider
// is mounted by DeviceProvider itself, so any component under it can call
// usePlayback() with no extra wiring.

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
import { ipc } from "./ipc";
import {
  EMPTY_TRACK,
  pressErrorText,
  reducePlayback,
  REMOTE_PROTO,
  STOPPED_TTL_MS,
  type PlaybackTrack,
  type PlayingInfo,
  type PressGesture,
  type StoppedInfo,
} from "./playback";
import { sequenceRuns } from "./remote-actions";
import type { Hello } from "./types";

export interface PressOptions {
  /** layer letter ("a") or index (0); default: the keypad's current layer */
  layer?: string | number | null;
  gesture?: PressGesture;
}

/** crd_watch.rs: macros are held while a remote desktop session is open. */
export interface RemoteHold {
  /** the key the connection interrupted; pressed again when it ends */
  resumeKey: number | null;
  resumeLayer: string | null;
}

const HOLD_REASON = "Macros are paused while a remote desktop is connected";

export interface PlaybackState {
  /** the macro the keypad is playing right now, if any */
  playing: PlayingInfo | null;
  /** the last key play the user stopped (for "Run again"); expires */
  lastStopped: StoppedInfo | null;
  dismissStopped: () => void;
  /** a keypad is connected — `stop` works on every firmware */
  canStop: boolean;
  /** remote key presses need firmware proto >= 17 */
  canPress: boolean;
  /** set while a remote desktop session holds playback (see RemoteHold) */
  remoteHold: RemoteHold | null;
  /** why keys can't run right now because of remoteHold (null when free) */
  holdReason: string | null;
  /** why pressKey is unavailable (null when canPress) */
  pressDisabledReason: string | null;
  stopPlayback: () => Promise<void>;
  /** "Press" a numbered key exactly like its physical press. Resolves once
   * the keypad accepts it; rejects with a readable message when refused. */
  pressKey: (key: number, opts?: PressOptions) => Promise<void>;
}

const Ctx = createContext<PlaybackState | null>(null);

/** A stop this app sent counts as the cause of a play_done arriving within
 * this window (labels "Stopped from the hotkey"). */
const VIA_WINDOW_MS = 3000;
const PRESS_REPLY_MS = 2500;

export function PlaybackProvider({
  port,
  hello,
  subscribe,
  children,
}: {
  port: string | null;
  hello: Hello | null;
  /** DeviceProvider's onMsg fan-out */
  subscribe: (cb: (m: Record<string, unknown>) => void) => () => void;
  children: ReactNode;
}) {
  const [track, setTrack] = useState<PlaybackTrack>(EMPTY_TRACK);
  const via = useRef<{ source: string; at: number } | null>(null);

  useEffect(
    () =>
      subscribe((m) => {
        if (m.t !== "play_start" && m.t !== "play_done" && m.t !== "hello") return;
        const now = Date.now();
        const v = via.current && now - via.current.at < VIA_WINDOW_MS ? via.current.source : null;
        if (m.t === "play_done") via.current = null;
        setTrack((s) => reducePlayback(s, m, now, v));
      }),
    [subscribe],
  );

  // The hotkey and the tray stop from Rust (the window may be hidden) and
  // announce it, so the bar can say where the stop came from.
  useEffect(() => {
    let un: (() => void) | undefined;
    let dead = false;
    void listen<{ source?: string }>("playback:stop-request", (e) => {
      via.current = { source: e.payload?.source ?? "app", at: Date.now() };
      // a Stop ends a running multi action too, not just the current step
      sequenceRuns.cancelAll();
    })
      .then((f) => (dead ? f() : (un = f)))
      .catch(() => {});
    return () => {
      dead = true;
      un?.();
    };
  }, []);

  // Remote desktop hold: Rust stops anything that starts while a session is
  // open; the UI mirrors it so Run buttons explain instead of flickering.
  const [remoteHold, setRemoteHold] = useState<RemoteHold | null>(null);
  useEffect(() => {
    type Rd = { active: boolean; resume_key: number | null; resume_layer: string | null };
    const apply = (s: Rd | null | undefined) =>
      setRemoteHold(
        s?.active ? { resumeKey: s.resume_key ?? null, resumeLayer: s.resume_layer ?? null } : null,
      );
    let un: (() => void) | undefined;
    let dead = false;
    void invoke<Rd>("remote_desktop_state").then(apply).catch(() => {});
    void listen<Rd>("remote-desktop:state", (e) => apply(e.payload))
      .then((f) => (dead ? f() : (un = f)))
      .catch(() => {});
    return () => {
      dead = true;
      un?.();
    };
  }, []);
  const holdReason = remoteHold ? HOLD_REASON : null;

  // no keypad, nothing playing
  useEffect(() => {
    if (!port) setTrack(EMPTY_TRACK);
  }, [port]);

  // "Run again" is an offer, not a record: let it lapse
  const stoppedAt = track.lastStopped?.at;
  useEffect(() => {
    if (stoppedAt === undefined) return;
    const t = setTimeout(
      () => setTrack((s) => (s.lastStopped?.at === stoppedAt ? { ...s, lastStopped: null } : s)),
      Math.max(0, stoppedAt + STOPPED_TTL_MS - Date.now()),
    );
    return () => clearTimeout(t);
  }, [stoppedAt]);

  const dismissStopped = useCallback(
    () => setTrack((s) => (s.lastStopped ? { ...s, lastStopped: null } : s)),
    [],
  );

  const stopPlayback = useCallback(async () => {
    via.current = { source: "app", at: Date.now() };
    sequenceRuns.cancelAll();
    await ipc.deviceSend({ t: "stop" });
  }, []);

  const proto = hello?.proto ?? 0;
  const connected = !!port && !!hello && hello.mode !== "rescue";
  const canPress = connected && proto >= REMOTE_PROTO;
  const pressDisabledReason = !connected
    ? "No keypad connected"
    : canPress
      ? null
      : "Update firmware to use remote press";

  const pressKey = useCallback(
    (key: number, opts: PressOptions = {}) => {
      if (pressDisabledReason) return Promise.reject(new Error(pressDisabledReason));
      if (holdReason) return Promise.reject(new Error(holdReason));
      // Re-pressing a key whose multi action the app is running stops it,
      // like the physical re-press (the keypad itself may be between steps,
      // or busy with a step's part file, so it can't decide this).
      if (sequenceRuns.cancelKey(key)) {
        via.current = { source: "app", at: Date.now() };
        return ipc.deviceSend({ t: "stop" }).then(() => undefined);
      }
      const msg: Record<string, unknown> = { t: "press", key };
      if (opts.layer !== undefined && opts.layer !== null) msg.layer = opts.layer;
      if (opts.gesture && opts.gesture !== "tap") msg.gesture = opts.gesture;
      return new Promise<void>((resolve, reject) => {
        let un = () => {};
        const timer = setTimeout(() => {
          un();
          resolve(); // no reply isn't a failure: play_start is the real signal
        }, PRESS_REPLY_MS);
        un = subscribe((m) => {
          if (m.re !== "press" || (m.t !== "ok" && m.t !== "err")) return;
          clearTimeout(timer);
          un();
          if (m.t === "ok") resolve();
          else reject(new Error(pressErrorText(String(m.code ?? ""))));
        });
        ipc.deviceSend(msg).catch((e) => {
          clearTimeout(timer);
          un();
          reject(e instanceof Error ? e : new Error(String(e)));
        });
      });
    },
    [pressDisabledReason, holdReason, subscribe],
  );

  return (
    <Ctx.Provider
      value={{
        playing: track.playing,
        lastStopped: track.lastStopped,
        dismissStopped,
        canStop: connected,
        canPress,
        remoteHold,
        holdReason,
        pressDisabledReason,
        stopPlayback,
        pressKey,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function usePlayback(): PlaybackState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("usePlayback outside DeviceProvider");
  return ctx;
}

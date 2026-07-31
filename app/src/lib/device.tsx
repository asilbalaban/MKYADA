// Device context: owns the serial connection lifecycle, the matched CIRCUITPY
// drive, the last hello, and live button events.

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { ipc, onDeviceDisconnected, onDeviceMsg, onDeviceStatus } from "./ipc";
import { keysCache } from "./keys-cache";
import { loadKeysToCache } from "./keys-loader";
import { rememberDevice, syncNameWithDevice } from "./devnames";
import type { BtnEvent, DeviceInfo, DriveInfo, Hello } from "./types";

/** What the keypad link is doing right now (issue #16), for the sidebar
 * status badge. Derived from serial traffic and drive-op pulses. */
export type DeviceStatus =
  | "disconnected"
  | "connected"
  | "busy" // a macro is playing on the keypad
  | "transfer" // files are streaming to/from the keypad
  | "reloading" // reload/reset sent — the firmware is restarting its config
  | "unresponsive"; // a drive op timed out; the link may be wedged

interface DeviceState {
  scanning: boolean;
  devices: DeviceInfo[];
  port: string | null;
  hello: Hello | null;
  drive: DriveInfo | null;
  /** active layer letter ("a", "b", …) as reported live by the device */
  layer: string;
  status: DeviceStatus;
  /** The link wedged and auto-reopen couldn't recover it — the user needs to
   * physically unplug/replug. Rare; normal stalls self-heal silently. */
  linkWedged: boolean;
  /** The connect-time keys load is still in flight (non-blocking banner). */
  keysLoading: boolean;
  /** A firmware update is running: every other device interaction (profile
   * pings, label pushes, macro saves) must stand down until it finishes. */
  updating: boolean;
  setUpdating: (v: boolean) => void;
  scan: () => Promise<DeviceInfo[]>;
  connect: (info: DeviceInfo) => Promise<void>;
  disconnect: () => Promise<void>;
  send: (msg: Record<string, unknown>) => Promise<void>;
  /** Write a file to the drive and tell the firmware to reload its config. */
  writeAndReload: (files: { path: string; content: string }[]) => Promise<void>;
  onBtn: (cb: (e: BtnEvent) => void) => () => void;
  onMsg: (cb: (m: Record<string, unknown>) => void) => () => void;
}

const Ctx = createContext<DeviceState | null>(null);

/** Stand-in DriveInfo when the keypad's USB drive is hidden on purpose:
 * the Rust backend routes `serial:<uid>` paths over the serial protocol. */
export function serialDrive(uid: string): DriveInfo {
  return { path: `serial:${uid}`, uid, board: "serial" };
}

export function isSerialDrive(drive: DriveInfo | null): boolean {
  return drive?.path.startsWith("serial:") ?? false;
}

export function DeviceProvider({ children }: { children: ReactNode }) {
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [port, setPort] = useState<string | null>(null);
  const [hello, setHello] = useState<Hello | null>(null);
  const [drive, setDrive] = useState<DriveInfo | null>(null);
  const [layer, setLayer] = useState("a");
  const btnSubs = useRef(new Set<(e: BtnEvent) => void>());
  const msgSubs = useRef(new Set<(m: Record<string, unknown>) => void>());

  // Status ingredients (issue #16): macro playing, drive ops in flight,
  // a timed-out op, a reload in progress.
  const [playingBusy, setPlayingBusy] = useState(false);
  const [transferCount, setTransferCount] = useState(0);
  const [stalled, setStalled] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [updating, setUpdating] = useState(false);
  // The link wedged and self-heal (auto port-reopen) couldn't clear it — the
  // one case left where the user must physically replug (a truly hung board).
  const [linkWedged, setLinkWedged] = useState(false);
  const linkWedgedRef = useRef(false);
  linkWedgedRef.current = linkWedged;
  // Connect-time keys load into keysCache — true while the first read is in
  // flight so the shell can show a non-blocking "Loading keys…" banner.
  const [keysLoading, setKeysLoading] = useState(false);
  // Monotonic id of the newest load; an older load noticing a newer id (or a
  // disconnect bump) aborts, and only the newest may clear the banner.
  const loadSeq = useRef(0);
  const recoverAt = useRef(0); // last auto-reopen time (throttle)
  const recoverTries = useRef(0); // consecutive auto-reopens without recovery
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const un1 = onDeviceMsg((msg) => {
      msgSubs.current.forEach((cb) => cb(msg));
      // any message proves the link is alive again
      setStalled(false);
      // Real device traffic (not just a reconnect's own hello) means the link
      // actually recovered — clear the self-heal counters and any "replug" hint.
      if (msg.t !== "hello") {
        recoverTries.current = 0;
        if (linkWedgedRef.current) setLinkWedged(false);
      }
      if (msg.t === "play_start") setPlayingBusy(true);
      if (msg.t === "play_done") setPlayingBusy(false);
      if (msg.t === "hello") {
        setHello(msg as unknown as Hello);
        setLayer(String((msg as { layer?: string }).layer ?? "a"));
        setReloading(false);
        // Advertise wheel-menu support on every hello (connect / reload /
        // reboot). Old firmware ignores the unknown message; the flag it sets
        // is what lets host-kind keys open a menu instead of the "app required"
        // toast (proto v9).
        void ipc.deviceSend({ t: "hostinfo", menus: 1 }).catch(() => {});
      }
      if (msg.t === "layer") setLayer(String((msg as { layer?: string }).layer ?? "a"));
      // the device edited its own settings (Vision 6 menu persists straight
      // into config.json and announces it) — mirror the toggles the
      // Settings page renders from hello
      if (msg.t === "config" && "show_layer" in msg) {
        const c = msg as {
          show_profile?: unknown;
          wheel_layers?: unknown;
          timeout?: unknown;
        };
        setHello((h) =>
          h
            ? {
                ...h,
                show_layer: msg.show_layer === true,
                show_profile: c.show_profile === true,
                // wheel_layers only appears on firmware ≥ 0.25.0; folding an
                // absent field in as `false` would make the Settings switch
                // claim "Off" on a keypad that never reported a state at all,
                // which is what the "needs firmware" badge is there to say.
                ...("wheel_layers" in c ? { wheel_layers: c.wheel_layers === true } : {}),
                // timeout mirrors the on-device Settings menu (firmware
                // ≥ 0.14.0 rewrites config.json + announces it)
                ...(typeof c.timeout === "number" ? { timeout: c.timeout } : {}),
              }
            : h,
        );
      }
      // Key presses carry a numeric `key`; Vision 6 nav buttons reuse t:"btn"
      // with a `slot` instead (and t:"enc" for the wheel) — those only go
      // through the generic fan-out above.
      if (msg.t === "btn" && typeof (msg as { key?: unknown }).key === "number") {
        setLayer(String((msg as unknown as BtnEvent).layer ?? "a"));
        btnSubs.current.forEach((cb) => cb(msg as unknown as BtnEvent));
      }
    });
    const un2 = onDeviceDisconnected(() => {
      setPort(null);
      setHello(null);
      setDrive(null);
      setPlayingBusy(false);
      setTransferCount(0);
      setStalled(false);
      setReloading(false);
      setLinkWedged(false);
      recoverTries.current = 0;
      // abort any in-flight keys load and drop its banner — a fresh connect
      // starts a fresh load
      loadSeq.current += 1;
      setKeysLoading(false);
    });
    const un3 = onDeviceStatus((s) => {
      if (s === "transfer") {
        setTransferCount((n) => n + 1);
        return;
      }
      // terminal pulse of one drive op
      setTransferCount((n) => Math.max(0, n - 1));
      if (s === "busy") setPlayingBusy(true);
      if (s === "unresponsive") {
        setStalled(true);
        if (stallTimer.current) clearTimeout(stallTimer.current);
        // clear on its own — the next successful op or message also clears it
        stallTimer.current = setTimeout(() => setStalled(false), 10_000);
      }
    });
    return () => {
      un1.then((f) => f());
      un2.then((f) => f());
      un3.then((f) => f());
      if (stallTimer.current) clearTimeout(stallTimer.current);
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
    };
  }, []);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const found = await ipc.scanDevices();
      setDevices(found);
      for (const d of found) {
        void rememberDevice(d.hello.uid, { fw: d.hello.fw });
      }
      return found;
    } finally {
      setScanning(false);
    }
  }, []);

  const connect = useCallback(async (info: DeviceInfo) => {
    await ipc.connectDevice(info.port);
    setPort(info.port);
    setHello(info.hello);
    void rememberDevice(info.hello.uid, { fw: info.hello.fw });
    if (info.hello.mode === "rescue") {
      // Rescue console: the main firmware is down. Repair goes over the
      // drive when one is mounted (host owns the filesystem then), or over
      // the rescue console's own fs_* commands when the drive is hidden.
      const drives = await ipc.listDrives().catch(() => []);
      const match = drives.find((d) => d.uid.toLowerCase() === info.hello.uid.toLowerCase());
      setDrive(match ?? serialDrive(info.hello.uid));
      return;
    }
    if (info.hello.usb_drive === false) {
      // The keypad hides its USB drive on purpose — files travel over
      // serial. The `serial:<uid>` sentinel routes every drive_* command
      // to the fs_* protocol in the Rust backend.
      const virtual = serialDrive(info.hello.uid);
      setDrive(virtual);
      // Nickname sync no longer fires here — it used to race the still-settling
      // link at the raw connect instant and wedge it. The connect-time keys
      // loader runs it once the link is proven ready instead.
    } else {
      // Match the CIRCUITPY volume by the UID reported in hello.
      const drives = await ipc.listDrives();
      const match = drives.find((d) => d.uid.toLowerCase() === info.hello.uid.toLowerCase());
      setDrive(match ?? drives[0] ?? null);
    }
    await ipc.deviceSend({ t: "identify" });
  }, []);

  // The CIRCUITPY drive often mounts seconds after the serial port appears
  // (especially on Windows) — keep looking for it instead of making the user
  // unplug and replug the keypad. A deliberately hidden drive never mounts:
  // use the serial-fs sentinel right away.
  useEffect(() => {
    if (!hello || drive) return;
    if (hello.usb_drive === false) {
      const virtual = serialDrive(hello.uid);
      setDrive(virtual);
      return;
    }
    let cancelled = false;
    const find = async () => {
      try {
        const drives = await ipc.listDrives();
        if (cancelled) return;
        const match = drives.find((d) => d.uid.toLowerCase() === hello.uid.toLowerCase());
        if (match) {
          setDrive(match);
        }
      } catch {
        // keep trying on the next tick
      }
    };
    void find();
    const t = setInterval(() => void find(), 2000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [hello, drive]);

  // Auto-connect: scan on launch and every few seconds while disconnected;
  // if exactly one keypad is plugged in, connect to it without asking.
  const portRef = useRef<string | null>(null);
  portRef.current = port;
  useEffect(() => {
    let cancelled = false;
    async function tick() {
      if (cancelled || portRef.current) return;
      try {
        const found = await ipc.scanDevices();
        if (cancelled || portRef.current) return;
        setDevices(found);
        if (found.length === 1) await connect(found[0]);
      } catch {
        // scan errors are non-fatal; retry on the next tick
      }
    }
    void tick();
    const t = setInterval(() => void tick(), 6000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [connect]);

  const disconnect = useCallback(async () => {
    await ipc.disconnectDevice();
    setPort(null);
    setHello(null);
    setDrive(null);
  }, []);

  // Self-heal: reopen the serial port in place — the software equivalent of
  // unplugging and replugging the cable. A wedged link recovers only when the
  // port is reopened (a firmware reload alone doesn't clear it), so instead of
  // making the user pull the cable we do it for them. Reuses the same
  // connect_device path (which closes any old handle first) and re-identifies;
  // the fresh hello flows back through the normal event handler.
  const reconnect = useCallback(async () => {
    const p = portRef.current;
    if (!p) return;
    try {
      await ipc.connectDevice(p);
      await ipc.deviceSend({ t: "identify" });
    } catch {
      // Reopen failed — the port is likely truly gone; the reader thread's
      // disconnect plus the auto-connect loop below take over from here.
    }
  }, []);

  // When a drive op times out (link may be wedged), try one automatic reopen,
  // throttled. If several reopens in a row don't bring real traffic back, the
  // board is genuinely hung — stop and ask the user to replug (linkWedged).
  useEffect(() => {
    if (!stalled || !port) return;
    const now = Date.now();
    if (now - recoverAt.current < 12_000) return;
    recoverAt.current = now;
    recoverTries.current += 1;
    if (recoverTries.current > 4) {
      setLinkWedged(true);
      return;
    }
    void reconnect();
  }, [stalled, port, reconnect]);

  // Handshake: pulse ping until the device answers (any message will do —
  // pong proves the link both ways). Right after a connect the firmware is
  // busy switching modes and redrawing; file requests sent into that window
  // used to be lost to a fragmented heap. Waiting for a pong first means the
  // main loop is demonstrably serving messages before we start reading files.
  const waitForReady = useCallback(async (isCurrent: () => boolean): Promise<boolean> => {
    for (let attempt = 0; attempt < 15 && isCurrent(); attempt++) {
      const answered = await new Promise<boolean>((resolve) => {
        const cb = (m: Record<string, unknown>) => {
          if (m.t === "pong") {
            cleanup();
            resolve(true);
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          resolve(false);
        }, 800);
        const cleanup = () => {
          clearTimeout(timer);
          msgSubs.current.delete(cb);
        };
        msgSubs.current.add(cb);
        void ipc.deviceSend({ t: "ping" }).catch(() => {
          cleanup();
          resolve(false);
        });
      });
      if (answered) return true;
    }
    return false;
  }, []);

  // Fill keysCache once the drive is known, so every consumer (Keys page,
  // native sound-key map, background playback) has the assignments without each
  // re-reading the link. Keyed on hello too: a reload/reboot sends a fresh
  // hello, and if a config rewrite invalidated the cache this re-runs then
  // (after the board is back), not mid-write. A warm cache short-circuits.
  useEffect(() => {
    const d = drive?.path;
    const uid = drive?.uid;
    // Skip in rescue mode: the main firmware is down, so there are no keys to
    // load — fs_* there is for repair, not the config/macros this reads.
    if (!d || !hello || hello.mode === "rescue") return;
    if (keysCache.get(d)) return; // already warm
    const seq = ++loadSeq.current; // supersede any older load
    const isCurrent = () => loadSeq.current === seq && portRef.current !== null;
    setKeysLoading(true);
    void (async () => {
      try {
        // handshake first — no file traffic until the link answers a ping
        if (await waitForReady(isCurrent)) {
          // whole-load retries: an incomplete load (some file kept failing)
          // must end in a complete cache, not a silently half-blank keypad
          let warm = false;
          for (let round = 0; round < 4 && isCurrent() && !warm; round++) {
            if (round) await new Promise((r) => setTimeout(r, 1500));
            warm = await loadKeysToCache(d, isCurrent);
          }
          // Nickname sync piggybacks on the now-ready link (was a connect race).
          if (isCurrent() && uid) await syncNameWithDevice(d, uid).catch(() => {});
        } else if (isCurrent()) {
          // The link never answered a single ping — that's a wedge, and since
          // no fs op ran, the stall watcher can't see it. Software-replug from
          // here: a successful reopen yields a fresh hello, which re-runs this
          // effect for a fresh handshake + load.
          recoverTries.current += 1;
          if (recoverTries.current > 4) setLinkWedged(true);
          else void reconnect();
        }
      } finally {
        // only the newest load owns the banner; a superseded one leaves it to
        // its successor (this is what used to strand the spinner forever)
        if (loadSeq.current === seq) setKeysLoading(false);
      }
    })();
  }, [drive, hello, waitForReady, reconnect]);

  const send = useCallback((msg: Record<string, unknown>) => {
    // reload/reset restart the firmware's config — show it as Reloading
    // until the fresh hello lands (with a timeout fallback)
    if (msg.t === "reload" || msg.t === "reset") {
      setReloading(true);
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(() => setReloading(false), 4000);
    }
    return ipc.deviceSend(msg);
  }, []);

  const writeAndReload = useCallback(
    async (files: { path: string; content: string }[]) => {
      if (!drive) throw new Error("No CIRCUITPY drive found for this device");
      for (const f of files) {
        await ipc.driveWrite(drive.path, f.path, f.content);
      }
      // config rewrites can change key count / layers — drop the Keys
      // page's cached snapshot so it re-reads (issue #14)
      keysCache.invalidate(drive.path);
      // Best-effort: if the write hit a read-only drive, the backend already
      // restarted the keypad (which boots with the fresh files) and the
      // serial port is momentarily down — that's not a failure.
      await ipc.deviceSend({ t: "reload" }).catch(() => {});
    },
    [drive],
  );

  const onBtn = useCallback((cb: (e: BtnEvent) => void) => {
    btnSubs.current.add(cb);
    return () => void btnSubs.current.delete(cb);
  }, []);

  const onMsg = useCallback((cb: (m: Record<string, unknown>) => void) => {
    msgSubs.current.add(cb);
    return () => void msgSubs.current.delete(cb);
  }, []);

  // Worst-first: a wedged link outranks everything, then live transfers,
  // then a restarting firmware, then playback.
  const status: DeviceStatus = !port
    ? "disconnected"
    : stalled
      ? "unresponsive"
      : transferCount > 0
        ? "transfer"
        : reloading
          ? "reloading"
          : playingBusy
            ? "busy"
            : "connected";

  return (
    <Ctx.Provider
      value={{
        scanning,
        devices,
        port,
        hello,
        drive,
        layer,
        status,
        linkWedged,
        keysLoading,
        updating,
        setUpdating,
        scan,
        connect,
        disconnect,
        send,
        writeAndReload,
        onBtn,
        onMsg,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useDevice(): DeviceState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useDevice outside DeviceProvider");
  return ctx;
}

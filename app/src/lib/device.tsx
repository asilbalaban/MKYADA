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
import { ipc, onDeviceDisconnected, onDeviceMsg } from "./ipc";
import { rememberDevice, syncNameWithDevice } from "./devnames";
import type { BtnEvent, DeviceInfo, DriveInfo, Hello } from "./types";

interface DeviceState {
  scanning: boolean;
  devices: DeviceInfo[];
  port: string | null;
  hello: Hello | null;
  drive: DriveInfo | null;
  /** active layer letter ("a", "b", …) as reported live by the device */
  layer: string;
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

  useEffect(() => {
    const un1 = onDeviceMsg((msg) => {
      msgSubs.current.forEach((cb) => cb(msg));
      if (msg.t === "hello") {
        setHello(msg as unknown as Hello);
        setLayer(String((msg as { layer?: string }).layer ?? "a"));
      }
      if (msg.t === "layer") setLayer(String((msg as { layer?: string }).layer ?? "a"));
      if (msg.t === "btn") {
        setLayer(String((msg as unknown as BtnEvent).layer ?? "a"));
        btnSubs.current.forEach((cb) => cb(msg as unknown as BtnEvent));
      }
    });
    const un2 = onDeviceDisconnected(() => {
      setPort(null);
      setHello(null);
      setDrive(null);
    });
    return () => {
      un1.then((f) => f());
      un2.then((f) => f());
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
    if (info.hello.usb_drive === false) {
      // The keypad hides its USB drive on purpose — files travel over
      // serial. The `serial:<uid>` sentinel routes every drive_* command
      // to the fs_* protocol in the Rust backend.
      const virtual = serialDrive(info.hello.uid);
      setDrive(virtual);
      void syncNameWithDevice(virtual.path, info.hello.uid);
    } else {
      // Match the CIRCUITPY volume by the UID reported in hello.
      const drives = await ipc.listDrives();
      const match = drives.find((d) => d.uid.toLowerCase() === info.hello.uid.toLowerCase());
      setDrive(match ?? drives[0] ?? null);
      if (match) void syncNameWithDevice(match.path, info.hello.uid);
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
      void syncNameWithDevice(virtual.path, hello.uid);
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
          void syncNameWithDevice(match.path, hello.uid);
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

  const send = useCallback((msg: Record<string, unknown>) => ipc.deviceSend(msg), []);

  const writeAndReload = useCallback(
    async (files: { path: string; content: string }[]) => {
      if (!drive) throw new Error("No CIRCUITPY drive found for this device");
      for (const f of files) {
        await ipc.driveWrite(drive.path, f.path, f.content);
      }
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

  return (
    <Ctx.Provider
      value={{
        scanning,
        devices,
        port,
        hello,
        drive,
        layer,
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

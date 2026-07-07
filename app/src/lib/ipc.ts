// Thin wrappers around the Rust commands and device events.

import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import type { DeviceInfo, DriveInfo, UpdateInfo } from "./types";

export const ipc = {
  scanDevices: () => invoke<DeviceInfo[]>("scan_devices"),
  connectDevice: (port: string) => invoke<void>("connect_device", { port }),
  disconnectDevice: () => invoke<void>("disconnect_device"),
  deviceSend: (msg: Record<string, unknown>) => invoke<void>("device_send", { msg }),
  connectedPort: () => invoke<string | null>("connected_port"),
  listDrives: () => invoke<DriveInfo[]>("list_drives"),
  driveWrite: (drive: string, path: string, content: string) =>
    invoke<void>("drive_write", { drive, path, content }),
  driveWriteCancel: () => invoke<void>("drive_write_cancel"),
  driveRead: (drive: string, path: string) => invoke<string>("drive_read", { drive, path }),
  driveDelete: (drive: string, path: string) => invoke<void>("drive_delete", { drive, path }),
  driveList: (drive: string, path: string) => invoke<string[]>("drive_list", { drive, path }),
  driveEject: (drive: string) => invoke<void>("drive_eject", { drive }),
  checkUpdate: () => invoke<UpdateInfo>("check_update"),
};

export function onDeviceMsg(cb: (msg: Record<string, unknown>) => void): Promise<UnlistenFn> {
  return listen("device:msg", (e) => cb(e.payload as Record<string, unknown>));
}

/** Chunk-by-chunk progress of a file writing to the keypad over serial. */
export interface WriteProgress {
  file: string;
  written: number;
  total: number;
}

export function onWriteProgress(cb: (p: WriteProgress) => void): Promise<UnlistenFn> {
  return listen("drive:progress", (e) => cb(e.payload as WriteProgress));
}

export function onDeviceDisconnected(cb: (port: string) => void): Promise<UnlistenFn> {
  return listen("device:disconnected", (e) => cb(e.payload as string));
}

/** Link-state pulses around drive operations (issue #16): "transfer" when
 * one starts, then "idle" | "busy" | "unresponsive" when it finishes. */
export function onDeviceStatus(cb: (state: string) => void): Promise<UnlistenFn> {
  return listen("device:status", (e) => cb(e.payload as string));
}

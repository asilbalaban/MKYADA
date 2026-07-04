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
  driveRead: (drive: string, path: string) => invoke<string>("drive_read", { drive, path }),
  driveDelete: (drive: string, path: string) => invoke<void>("drive_delete", { drive, path }),
  driveList: (drive: string, path: string) => invoke<string[]>("drive_list", { drive, path }),
  checkUpdate: () => invoke<UpdateInfo>("check_update"),
};

export function onDeviceMsg(cb: (msg: Record<string, unknown>) => void): Promise<UnlistenFn> {
  return listen("device:msg", (e) => cb(e.payload as Record<string, unknown>));
}

export function onDeviceDisconnected(cb: (port: string) => void): Promise<UnlistenFn> {
  return listen("device:disconnected", (e) => cb(e.payload as string));
}

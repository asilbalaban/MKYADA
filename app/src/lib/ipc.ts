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
  /** Boards in RPI-RP2 bootloader mode (BOOT held while plugging in). */
  listBootloaderDrives: () => invoke<BootloaderDrive[]>("list_bootloader_drives"),
  /** Copy the bundled CircuitPython UF2 onto a bootloader drive. The drive
   * vanishing right after (board reboots into CircuitPython) is expected. */
  provisionFlashUf2: (mount: string) => invoke<void>("provision_flash_uf2", { mount }),
  /** Restart a just-provisioned board over its CircuitPython REPL. boot.py —
   * which creates the data channel the app talks over — only runs on a hard
   * reset, so without this the brand-new keypad stays invisible until the user
   * unplugs and replugs it. Resolves as soon as the reset is sent; the caller
   * waits for the keypad to answer on the other side. */
  provisionReboot: (uid: string) => invoke<void>("provision_reboot", { uid }),
  /** How the board's firmware tree differs from the bundled one. Read-only
   * and cheap (directory listings, not file reads) — safe to run repeatedly. */
  firmwareDiagnose: (drive: string) => invoke<FirmwareDiagnosis>("firmware_diagnose", { drive }),
  /** Rewrite the firmware tree, delete what doesn't belong to it, and stamp
   * the model into config.json. `model` is what the user picked in the
   * recovery wizard — a rescue-mode board can't tell us itself. */
  firmwareRepair: (drive: string, model?: string) =>
    invoke<string[]>("firmware_repair", { drive, model }),
  /** Write a text file where the user pointed a save dialog (keypad backup). */
  fileWriteText: (path: string, content: string) =>
    invoke<void>("file_write_text", { path, content }),
  /** Read a file the user picked in an open dialog (restoring a backup). */
  fileReadText: (path: string) => invoke<string>("file_read_text", { path }),
};

export interface BootloaderDrive {
  path: string;
  boardId: string;
}

/** Result of `firmwareDiagnose` — paths are device-relative ("mkyada/ui.mpy"). */
export interface FirmwareDiagnosis {
  bundle_version: string;
  device_version: string | null;
  /** config.json's model, or null when nothing has ever set it. */
  model: string | null;
  /** bundle files the board doesn't have at all */
  missing: string[];
  /** present, but not the size the bundle's copy has */
  stale: string[];
  /** files in the firmware's directories that the bundle doesn't ship */
  extra: string[];
  matching: number;
  total: number;
}

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

/** Per-file progress of a firmware update (proto v7 locked update mode). */
export interface FirmwareProgress {
  file: string;
  index: number;
  files: number;
  done: number;
  total: number;
}

export function onFirmwareProgress(cb: (p: FirmwareProgress) => void): Promise<UnlistenFn> {
  return listen("firmware:progress", (e) => cb(e.payload as FirmwareProgress));
}

export function onDeviceDisconnected(cb: (port: string) => void): Promise<UnlistenFn> {
  return listen("device:disconnected", (e) => cb(e.payload as string));
}

/** Link-state pulses around drive operations (issue #16): "transfer" when
 * one starts, then "idle" | "busy" | "unresponsive" when it finishes. */
export function onDeviceStatus(cb: (state: string) => void): Promise<UnlistenFn> {
  return listen("device:status", (e) => cb(e.payload as string));
}

// Remembered devices: per-UID nickname + last-seen info, persisted app-side.
// The nickname is also stored on the keypad itself (devname.json on its USB
// drive) so it travels with the hardware between computers.

import { LazyStore } from "@tauri-apps/plugin-store";
import { ipc } from "./ipc";

export interface RememberedDevice {
  uid: string;
  name: string;
  lastSeen: string; // ISO timestamp
  fw?: string;
}

const store = new LazyStore("devices.json");

// lets the shell refresh the sidebar nickname the moment it's saved
const listeners = new Set<() => void>();
export function onDevnamesChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

export async function rememberedDevices(): Promise<Record<string, RememberedDevice>> {
  return ((await store.get<Record<string, RememberedDevice>>("devices")) ?? {}) as Record<
    string,
    RememberedDevice
  >;
}

export async function rememberDevice(uid: string, patch: Partial<RememberedDevice>): Promise<void> {
  const all = await rememberedDevices();
  const prev = all[uid];
  all[uid] = {
    ...prev,
    uid,
    name: patch.name ?? prev?.name ?? "",
    lastSeen: new Date().toISOString(),
    fw: patch.fw ?? prev?.fw,
  };
  await store.set("devices", all);
  await store.save();
  listeners.forEach((cb) => cb());
}

export async function deviceName(uid: string): Promise<string> {
  const all = await rememberedDevices();
  return all[uid]?.name || "";
}

/** Display name: nickname if set, else a short UID tag. */
export function displayName(name: string | undefined, uid: string): string {
  return name?.trim() ? name : `Keypad ${uid.slice(-4).toUpperCase()}`;
}

// ------------------------------------------------- nickname on the device ---

const DEVNAME_FILE = "devname.json";

/** Store the nickname on the keypad's drive so other computers pick it up. */
export async function writeNameToDevice(drivePath: string, name: string): Promise<void> {
  await ipc.driveWrite(
    drivePath,
    DEVNAME_FILE,
    JSON.stringify({ format: "mkyada-devname", version: 1, name }),
  );
}

/**
 * Sync on connect. The device's file wins (it travels with the keypad); a
 * keypad without one inherits the nickname this computer already had for it.
 */
export async function syncNameWithDevice(drivePath: string, uid: string): Promise<void> {
  let onDevice = "";
  try {
    const parsed = JSON.parse(await ipc.driveRead(drivePath, DEVNAME_FILE)) as {
      name?: unknown;
    };
    onDevice = String(parsed.name ?? "").trim();
  } catch {
    // no devname.json on the drive yet
  }
  const local = await deviceName(uid);
  if (onDevice && onDevice !== local) {
    await rememberDevice(uid, { name: onDevice });
  } else if (!onDevice && local) {
    await writeNameToDevice(drivePath, local).catch(() => {});
  }
}

// Remembered devices: per-UID nickname + last-seen info, persisted app-side.

import { LazyStore } from "@tauri-apps/plugin-store";

export interface RememberedDevice {
  uid: string;
  name: string;
  lastSeen: string; // ISO timestamp
  fw?: string;
}

const store = new LazyStore("devices.json");

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
}

export async function deviceName(uid: string): Promise<string> {
  const all = await rememberedDevices();
  return all[uid]?.name || "";
}

/** Display name: nickname if set, else a short UID tag. */
export function displayName(name: string | undefined, uid: string): string {
  return name?.trim() ? name : `Keypad ${uid.slice(-4).toUpperCase()}`;
}

// Whole-keypad backup: one JSON file that carries everything a configured
// keypad is, so it can be put back later or copied onto another one.
//
// What goes in, and why it's this list:
//   config      the keypad's own config.json — key count, layers, layer names,
//               nav wiring, wheel menu, language, screen size
//   macros      every file under macros/ VERBATIM. Stored as raw text, not
//               re-serialized: these files are written in the on-wire macro
//               format the firmware parses, and round-tripping them through
//               the app's model would risk changing bytes the device reads.
//   profiles    the app-side profile definitions. Without them the profile
//               macro files (p_<id>_key1.json) on the keypad are orphans —
//               nothing would know which app they switch for.
//   device      what this backup came off, so a restore can refuse a keypad
//               it doesn't fit and the user can tell two backups apart.
//
// What stays out: the host's own settings (sound output, OBS connection,
// window behaviour) belong to the computer, not the keypad.

import type { DeviceModel, Profile } from "./types";

export const BACKUP_FORMAT = "mkyada-backup";
export const BACKUP_VERSION = 1;

export interface BackupDevice {
  model: DeviceModel;
  /** firmware the backup was taken from — informational */
  fw: string;
  /** board UID it came off — informational; a restore never writes it */
  uid: string;
  name: string;
  key_count: number;
}

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: number;
  created: string;
  /** app version that wrote the file */
  app: string;
  device: BackupDevice;
  config: Record<string, unknown>;
  /** file name (no directory) -> raw file text */
  macros: Record<string, string>;
  profiles: Profile[];
}

/** Fields a restore must NOT take from the backup: they describe the keypad
 *  in front of us, not the one the backup came from. `model` is the hardware
 *  itself (display, encoder, key pins), and `usb_drive` is how this computer
 *  reaches the keypad at all — a backup from a board with its drive visible
 *  would otherwise flip the target's finished-product mode. */
export const DEVICE_OWNED_CONFIG = ["model", "usb_drive"] as const;

export function parseBackup(text: string): Backup {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON — pick a MKYADA backup file.");
  }
  const b = data as Partial<Backup>;
  if (!b || typeof b !== "object" || b.format !== BACKUP_FORMAT) {
    throw new Error("That file isn't a MKYADA keypad backup.");
  }
  if (typeof b.version !== "number" || b.version > BACKUP_VERSION) {
    throw new Error(
      `This backup was written by a newer version of the app (format ${b.version}). Update MKYADA and try again.`,
    );
  }
  if (!b.config || typeof b.config !== "object") {
    throw new Error("This backup has no keypad settings in it — it may be truncated.");
  }
  return {
    format: BACKUP_FORMAT,
    version: b.version,
    created: typeof b.created === "string" ? b.created : "",
    app: typeof b.app === "string" ? b.app : "",
    device: {
      model: b.device?.model === "vision6" ? "vision6" : "core6",
      fw: b.device?.fw ?? "",
      uid: b.device?.uid ?? "",
      name: b.device?.name ?? "",
      key_count: typeof b.device?.key_count === "number" ? b.device.key_count : 0,
    },
    config: b.config as Record<string, unknown>,
    macros: isStringMap(b.macros) ? b.macros : {},
    profiles: Array.isArray(b.profiles) ? (b.profiles as Profile[]) : [],
  };
}

function isStringMap(v: unknown): v is Record<string, string> {
  return (
    !!v && typeof v === "object" && Object.values(v).every((x) => typeof x === "string")
  );
}

/** A filename that says which keypad and when, safe on every platform. */
export function backupFileName(name: string, created = new Date()): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "keypad";
  const d = created;
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
  return `mkyada-${slug}-${stamp}.json`;
}

/** Merge restored profiles into the ones already on this computer: same id
 *  wins from the backup (restoring twice is idempotent), unknown ids are
 *  added, and profiles this computer has that the backup doesn't know about
 *  are left alone — they may belong to another keypad. */
export function mergeProfiles(existing: Profile[], restored: Profile[]): Profile[] {
  const byId = new Map(existing.map((p) => [p.id, p]));
  for (const p of restored) {
    byId.set(p.id, p);
  }
  return [...byId.values()];
}

/** Plain-language summary of what a backup holds, for the confirm dialog. */
export function describeBackup(b: Backup): string {
  const macros = Object.keys(b.macros).length;
  const keys = b.device.key_count;
  const parts = [
    `${macros} macro file${macros === 1 ? "" : "s"}`,
    `${keys} key${keys === 1 ? "" : "s"}`,
  ];
  if (b.profiles.length > 0) {
    parts.push(`${b.profiles.length} profile${b.profiles.length === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
}

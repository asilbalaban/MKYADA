// /macros/meta.json — the device's per-macro sidecar (proto v14).
//
// One small file on the keypad carries what used to require rewriting a whole
// macro on flash: per-stem override fields (s = speed tenths, i = icon,
// n = name) plus a firmware-maintained manifest (c = crc32, z = size) of every
// macro file. Two things follow for the app:
//
//   1. Header-only edits on BIG files (a recorded macro's speed/icon/name)
//      write this sidecar instead of re-uploading hundreds of KB — the edit
//      is milliseconds and the flash-corruption window of a long unattended
//      write is gone (the incident that reformatted a board).
//   2. The manifest gives connect-time sync a way to skip re-reading files
//      whose c/z match a cached copy (used by the per-UID device cache).
//
// The firmware clears a stem's overrides whenever that macro's body is
// rewritten over serial — the body then carries the truth — so a full write
// from this app never needs to clean up after an earlier fast save.

import { ipc } from "./ipc";
import { parseDeviceMacro } from "./macro-model";
import type { Assignment, MacroFile } from "./types";

export interface MetaEntry {
  /** Speed override, integer tenths (25 = 2.5×). */
  s?: number;
  /** Icon override (name or "px:<16hex>"). */
  i?: string;
  /** Name override. */
  n?: string;
  /** CRC32 (IEEE) of the macro file's bytes — firmware-maintained. */
  c?: number;
  /** Size of the macro file in bytes — firmware-maintained. */
  z?: number;
}

export const META_FILE = "macros/meta.json";
/** First protocol version that understands the sidecar. */
export const META_PROTO = 14;
/** Serialized size at which a header-only edit goes through the sidecar
 * instead of a full rewrite. Below it a rewrite is milliseconds anyway, and
 * keeping small files header-authoritative keeps the sidecar (and the
 * firmware's resident override dict) small. */
export const META_BIG_FILE = 32 * 1024;

/** "macros/key3.json" → "key3"; null for meta.json itself / non-.json. */
export function metaStem(file: string): string | null {
  const name = file.split("/").pop() ?? "";
  if (!name.endsWith(".json")) return null;
  const stem = name.slice(0, -5);
  return stem && stem !== "meta" ? stem : null;
}

/** The sidecar's entries, {} when absent/corrupt (self-healing: no entry
 * just means "no override, re-read the file"). */
export async function readMetaEntries(drivePath: string): Promise<Record<string, MetaEntry>> {
  try {
    const data = JSON.parse(await ipc.driveRead(drivePath, META_FILE)) as {
      format?: string;
      entries?: Record<string, MetaEntry>;
    };
    if (data?.format !== "mkyada-meta" || typeof data.entries !== "object" || !data.entries) {
      return {};
    }
    return data.entries;
  } catch {
    return {};
  }
}

/** Overlay a stem's override fields onto a parsed macro — the app-side twin
 * of the firmware's load_layer overlay, so both ends display and play the
 * same effective values. */
export function applyMetaOverrides(m: MacroFile, e?: MetaEntry): MacroFile {
  if (!e) return m;
  const out: MacroFile = { ...m };
  if (typeof e.s === "number" && isFinite(e.s)) {
    out.settings = { ...out.settings, speed: e.s / 10 };
  }
  if (typeof e.i === "string" && e.i) out.icon = e.i;
  if (typeof e.n === "string" && e.n) out.name = e.n;
  return out;
}

/** Overlay override fields onto an already-parsed ASSIGNMENT — used when
 * hydrating from the per-UID content cache, where assignments are stored raw
 * and the sidecar is re-applied fresh on every connect. */
export function overlayAssignment(a: Assignment, e?: MetaEntry): Assignment {
  if (!e) return a;
  let out: Assignment = { ...a };
  if (typeof e.s === "number" && isFinite(e.s)) {
    const speed = e.s / 10;
    if (out.kind === "recorded") {
      out = { ...out, macro: { ...out.macro, settings: { ...out.macro.settings, speed } } };
    } else {
      out = { ...out, speed };
    }
  }
  if (typeof e.i === "string" && e.i && out.kind !== "none") out.icon = e.i;
  if (typeof e.n === "string" && e.n) {
    if (out.kind === "recorded") out = { ...out, name: e.n };
    else if (out.kind !== "none") out = { ...out, label: e.n };
  }
  return out;
}

/** Read one macro off the device with its sidecar overrides applied. */
export async function readMacroWithMeta(drivePath: string, file: string): Promise<MacroFile> {
  const mf = parseDeviceMacro(await ipc.driveRead(drivePath, file));
  const stem = metaStem(file);
  if (!stem) return mf;
  const entries = await readMetaEntries(drivePath);
  return applyMetaOverrides(mf, entries[stem]);
}

/** Set override fields for one stem (read-modify-write of the sidecar).
 * Fields are only ever SET here — clearing happens on the firmware side when
 * a body write makes the header authoritative again. */
export async function writeMetaOverrides(
  drivePath: string,
  stem: string,
  fields: Pick<MetaEntry, "s" | "i" | "n">,
): Promise<void> {
  const entries = await readMetaEntries(drivePath);
  entries[stem] = { ...entries[stem], ...fields };
  await ipc.driveWrite(
    drivePath,
    META_FILE,
    JSON.stringify({ format: "mkyada-meta", version: 1, entries }),
  );
}

/**
 * Decide whether a save can go through the sidecar: both serializations must
 * be stream files with IDENTICAL event bodies, the file must be big enough to
 * be worth it, and the headers may differ ONLY in speed/icon/name. Returns
 * the override fields to write, or null → do a normal full write.
 *
 * `oldSer` is built from the cached assignment (which already includes any
 * earlier overrides), so an unchanged field is left untouched here — never
 * cleared — and an existing override stays in force.
 */
export function metaFastFields(
  oldSer: string,
  newSer: string,
): Pick<MetaEntry, "s" | "i" | "n"> | null {
  if (newSer.length < META_BIG_FILE) return null;
  const nlO = oldSer.indexOf("\n");
  const nlN = newSer.indexOf("\n");
  if (nlO < 0 || nlN < 0) return null;
  if (oldSer.slice(nlO) !== newSer.slice(nlN)) return null; // events differ
  let ho: MacroFile & { stream?: boolean };
  let hn: MacroFile & { stream?: boolean };
  try {
    ho = JSON.parse(oldSer.slice(0, nlO));
    hn = JSON.parse(newSer.slice(0, nlN));
  } catch {
    return null;
  }
  if (!ho?.stream || !hn?.stream) return null;
  // removing a field can't be expressed as an override (the header value
  // would shine through) — that edit takes the full write
  if ((ho.icon && !hn.icon) || (ho.name && !hn.name)) return null;
  // anything beyond speed/icon/name changed → full write
  const strip = (h: MacroFile & { stream?: boolean }) => {
    const { icon: _i, name: _n, settings, ...rest } = h;
    const s = { ...settings };
    delete s.speed;
    return JSON.stringify({ ...rest, settings: s });
  };
  if (strip(ho) !== strip(hn)) return null;
  const fields: Pick<MetaEntry, "s" | "i" | "n"> = {};
  const so = ho.settings?.speed ?? 1;
  const sn = hn.settings?.speed ?? 1;
  if (sn !== so) fields.s = Math.round(sn * 10);
  if (hn.icon && hn.icon !== ho.icon) fields.i = hn.icon;
  if (hn.name && hn.name !== ho.name) fields.n = hn.name;
  if (!Object.keys(fields).length) return null; // nothing changed at all
  return fields;
}

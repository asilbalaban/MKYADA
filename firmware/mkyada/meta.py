# /macros/meta.json — the per-macro sidecar (proto v14).
#
# One small file carries what used to require rewriting a whole macro on
# flash: per-stem override fields plus a firmware-maintained CRC manifest.
#
#   {"format": "mkyada-meta", "version": 1,
#    "entries": {"key3": {"s": 25, "c": 3735928559, "z": 812340}}}
#
# Entry fields, all optional:
#   s  speed override, integer tenths (25 = 2.5x) — replaces the old
#      persist_speed full-file rewrite that could out-run the 8s watchdog on
#      a long recorded macro and corrupt the FAT mid-write
#   i  icon override (name or "px:<16hex>") — big recorded macros only; the
#      app edits small files' headers directly
#   n  name override — same rule as i
#   c  crc32 (IEEE) of the macro file's bytes, kept current by the firmware
#      on every serial write / wheel-menu assign so the app can skip reading
#      unchanged files at connect
#   z  the macro file's size in bytes, same maintenance
#
# The whole file is read-modify-written through .part + rename on every
# update. It stays small (a few KB), so each write is milliseconds — the
# watchdog never comes close. Overrides (s/i/n) are cleared whenever the
# macro file itself is rewritten over serial: the writer bakes current
# values into the header, so a stale override must not shadow them. That
# same rule keeps an OLD app correct against this firmware.
#
# Only the override fields are kept resident (App.meta_ov) — c/z exist for
# the app and are parsed on demand, never held in RAM.

import json
import os

import gc

PATH = "/macros/meta.json"
FORMAT = "mkyada-meta"
OVERRIDE_FIELDS = ("s", "i", "n")


def _read():
    """The parsed entries dict, or {} — tolerant of a missing/corrupt file."""
    try:
        with open(PATH, "rb") as f:
            data = json.load(f)
    except (OSError, ValueError, MemoryError):
        return {}
    if not isinstance(data, dict) or data.get("format") != FORMAT:
        return {}
    entries = data.get("entries")
    return entries if isinstance(entries, dict) else {}


def _write(entries):
    """Atomic whole-file write. Returns "ok" | "readonly" | "error"."""
    tmp = PATH + ".part"
    try:
        with open(tmp, "w") as f:
            json.dump({"format": FORMAT, "version": 1, "entries": entries}, f)
    except (OSError, MemoryError) as e:
        try:
            os.remove(tmp)
        except OSError:
            pass
        if isinstance(e, OSError) and e.args and e.args[0] == 30:
            return "readonly"
        return "error"
    try:
        os.remove(PATH)
    except OSError:
        pass
    try:
        os.rename(tmp, PATH)
    except OSError:
        return "error"
    return "ok"


def load_overrides():
    """{stem: {"s"/"i"/"n": ...}} with only the override fields — the compact
    dict App keeps resident. Entries that are pure manifest (c/z) are skipped
    so a fully synced board costs no RAM here."""
    ov = {}
    for stem, e in _read().items():
        if not isinstance(e, dict):
            continue
        kept = {k: e[k] for k in OVERRIDE_FIELDS if k in e}
        if kept:
            ov[stem] = kept
    gc.collect()
    return ov


def update(stem, fields=None, crc=None, size=None, clear_overrides=False):
    """Read-modify-write one entry. fields sets override values (a None value
    removes that field), crc/size set the manifest c/z, clear_overrides drops
    s/i/n (macro body was rewritten — header now carries the truth). An entry
    left empty is removed. Returns "ok" | "readonly" | "error"."""
    gc.collect()
    entries = _read()
    e = entries.get(stem)
    if not isinstance(e, dict):
        e = {}
    if clear_overrides:
        for k in OVERRIDE_FIELDS:
            e.pop(k, None)
    if fields:
        for k, v in fields.items():
            if v is None:
                e.pop(k, None)
            else:
                e[k] = v
    if crc is not None:
        e["c"] = crc & 0xFFFFFFFF
    if size is not None:
        e["z"] = size
    if e:
        entries[stem] = e
    else:
        entries.pop(stem, None)
    return _write(entries)


def remove(stem):
    """Drop a stem's entry entirely (its macro file was deleted)."""
    entries = _read()
    if stem not in entries:
        return "ok"
    del entries[stem]
    return _write(entries)


def stem_of(path):
    """"/macros/key3.json" -> "key3", or None for meta.json itself, .part
    temps and non-.json files. Directory-agnostic on purpose: the simulator
    tests point macro paths at a tempdir — callers that must stay inside
    /macros/ (fs_write/fs_delete) guard the prefix themselves."""
    name = path.rsplit("/", 1)[-1]
    if not name.endswith(".json"):
        return None
    name = name[:-5]
    if not name or name == "meta":
        return None
    return name

// Main configurator: pick a key on the visual keypad, choose what it does,
// save. Every assignment is compiled to a macro JSON on the device drive.

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRightLeft, ChevronRight, CirclePlay, MousePointerClick, Play, RefreshCw, Square, SquarePen, Usb } from "lucide-react";
import { useDevice } from "../lib/device";
import { usePlayback } from "../lib/playback-context";
import { useTestMode, useWindowFocused } from "../lib/focus";
import { TestModeNotice } from "../components/TestModeBanner";
import { useNav } from "../lib/nav";
import { ipc } from "../lib/ipc";
import type { Assignment, DeviceConfig, MacroFile, ModuleSlot, SlotContext } from "../lib/types";
import { MODULE_SLOTS, MODULE_SLOT_LABELS, deviceModel, layerLabel } from "../lib/types";
import {
  AUX_FILE_RE,
  compileAssignment,
  describeAssignment,
  compileSequenceParts,
  compileSlotAssignment,
  defaultConfig,
  describeSlotAssignment,
  effectiveLayers,
  macroFileName,
  migrateMacro,
  parseAssignment,
  parseDeviceMacro,
  parseMacroFileName,
  slotFileName,
  slotEditValue,
  SLOT_BUILTIN_ACTION,
  SLOT_BUILTINS,
} from "../lib/macro-model";
import { serializeForDevice } from "../lib/recorder-model";
import {
  META_PROTO,
  applyMetaOverrides,
  metaFastFields,
  metaStem,
  readMacroWithMeta,
  readMetaEntries,
  writeMetaOverrides,
} from "../lib/device-meta";
import type { MetaEntry } from "../lib/device-meta";
import { keysCache, slotKey } from "../lib/keys-cache";
import { macroFileCache } from "../lib/macro-cache";
import { stashRecorderEdit } from "../lib/recorder-handoff";
import { undoRedoFromEvent, useHistory } from "../lib/history";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  IconButton,
  Input,
  OverflowMenu,
  SegmentedControl,
  Spinner,
  Tooltip,
} from "../components/ui";
import { isWriteCancelled, useWriteGate, writeCancelledError } from "../components/WriteProgress";
import { useToast } from "../components/toast";
import { Keypad } from "../components/Keypad";
import { AssignmentPanel } from "../components/AssignmentPanel";

/** What can hold a macro: a numbered key, or a Vision 6 module control. */
type SlotId = number | ModuleSlot;

function fileFor(slot: SlotId, layer: number, ctx: SlotContext = "grid"): string {
  return typeof slot === "number" ? macroFileName(slot, layer) : slotFileName(slot, layer, ctx);
}

const FIELD_LABEL = "text-label font-medium tracking-label text-fg [font-stretch:90%]";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Cache/state key: keys ignore ctx; module slots are per-ctx (issue #19). */
function keyOf(slot: SlotId, layer: number, ctx: SlotContext = "grid"): string {
  return typeof slot === "number" ? slotKey(slot, layer) : slotKey(slot, layer, ctx);
}

function slotTitle(slot: SlotId): string {
  return typeof slot === "number" ? `Key ${slot}` : MODULE_SLOT_LABELS[slot];
}

/** Delete the sibling part files (key3.s0.json…) a mixed sequence left behind,
 * except the ones we just wrote. A shorter sequence — or a slot that stopped
 * being a sequence at all — would otherwise keep replaying its old tail. */
async function sweepParts(drivePath: string, file: string, keep: Set<string>) {
  const stem = file.split("/").pop()!.replace(/\.json$/, ".");
  const existing = await ipc.driveList(drivePath, "macros").catch(() => [] as string[]);
  for (const f of existing) {
    if (f.startsWith(stem) && AUX_FILE_RE.test(f) && !keep.has(f)) {
      await ipc.driveDelete(drivePath, `macros/${f}`).catch(() => {});
    }
  }
}

/** Put one assignment on one slot file: the macro itself (verified), the part
 * files a mixed sequence needs, and a sweep of stale ones. A null `macro`
 * means "unassigned" — the file goes away. Shared by Save and by Move/Copy so
 * a moved macro lands byte-for-byte the way a saved one does. */
async function writeSlotFiles(
  drivePath: string,
  file: string,
  a: Assignment,
  macro: MacroFile | null,
  screen: DeviceConfig["screen"],
  proto: number,
  bail: () => void,
) {
  if (macro) {
    macro.screen = screen;
    await ipc.driveWrite(drivePath, file, serializeForDevice(macro, proto));
    bail();
    // verify the write landed before claiming success
    const back = await ipc.driveRead(drivePath, file);
    if (!back.includes("mkyada-macro")) throw new Error("verification read failed");
  } else {
    try {
      await ipc.driveDelete(drivePath, file);
    } catch {
      // was already unassigned
    }
  }
  const parts = a.kind === "sequence" ? compileSequenceParts(a, file) : [];
  for (const p of parts) {
    bail();
    await ipc.driveWrite(drivePath, p.path, serializeForDevice(p.file, proto));
  }
  await sweepParts(drivePath, file, new Set(parts.map((p) => p.path.split("/").pop()!)));
}

/** Where a module-control assignment applies, and what the built-in menu
 * action does there — a slot with no macro file IS the "Built-in menu
 * action" choice, so every control always reads as explicitly set
 * (issue #19). */
const CTX_META: { id: SlotContext; label: string; hint: string }[] = [
  { id: "grid", label: "Key grid", hint: "The resting screen · per layer" },
  { id: "home", label: "Layer screen", hint: "The layer picker · one setting for all layers" },
  { id: "menu", label: "Settings menu", hint: "Settings and its sub-menus · one setting for all layers" },
];

export function KeysPage() {
  const { hello, drive, send, onMsg, setCfg: setDeviceCfg } = useDevice();
  const nav = useNav();
  const toast = useToast();
  const playback = usePlayback();
  const [pressing, setPressing] = useState(false);
  const [stoppingRun, setStoppingRun] = useState(false);
  const { writeToKeypad } = useWriteGate();
  const [cfg, setCfg] = useState<DeviceConfig | null>(null);
  const [layer, setLayer] = useState(0);
  const [selected, setSelected] = useState<SlotId | null>(null);
  // Which context of a module control is being edited (keys are always grid).
  const [slotCtx, setSlotCtx] = useState<SlotContext>("grid");
  const [assignments, setAssignments] = useState<Map<string, Assignment>>(new Map());
  // A macro's settings were edited on the device while that slot had unsaved
  // edits here — offer a reload instead of silently clobbering either side.
  const [changedNotice, setChangedNotice] = useState<{
    slot: SlotId;
    layer: number;
    ctx: SlotContext;
  } | null>(null);
  // Draft edits are undoable (⌘Z); switching key/layer or saving resets the stack.
  const draftHistory = useHistory<Assignment | null>(null);
  const draft = draftHistory.present;
  const setDraft = draftHistory.reset;
  const [saving, setSaving] = useState(false);
  // The "put this macro on another key" picker (issue: moving an assignment
  // used to mean building it again from scratch).
  const [moving, setMoving] = useState(false);
  const [status, setStatus] = useState("");
  // Slots whose macro is still streaming in from the keypad (issue #12) —
  // their keys show a spinner and unlock one by one as reads complete.
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [loadTotal, setLoadTotal] = useState(0);
  // Draft of the currently-edited layer's on-screen nickname (Vision 6). Kept
  // in sync with the active layer; committed on blur.
  const [layerNameDraft, setLayerNameDraft] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const op = undoRedoFromEvent(e);
      if (!op) return;
      e.preventDefault();
      if (op === "undo") draftHistory.undo();
      else draftHistory.redo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // stable callbacks from useHistory
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A reconnect or drive change can start a fresh reload while an old one is
  // still streaming reads — the stale one must stop touching state.
  const reloadSeq = useRef(0);
  // reload() needs the current focus without being re-created on every focus
  // flip (that would restart streaming), so read it through a ref.
  const focused = useWindowFocused();
  const focusedRef = useRef(focused);
  focusedRef.current = focused;

  // Load config + existing assignments from the drive. One directory listing
  // tells us which slots exist (no blind reads on empty slots), then each
  // macro streams in on its own: the keypad renders immediately and keys
  // unlock one by one instead of the page blocking on every read (issue #12).
  // Every macro reaches the keypad through this app, so a snapshot taken
  // once stays valid across tab switches — entering the page again reuses it
  // instead of re-streaming everything (issue #14).
  // Every slot the config implies — what "everything" means for the pending
  // spinners while the central loader is still streaming macros in.
  const allSlotKeys = useCallback((config: DeviceConfig): Set<string> => {
    const out = new Set<string>();
    const layers = effectiveLayers(config);
    const vision6 = deviceModel(config) === "vision6";
    for (let l = 0; l < layers; l++) {
      for (let k = 1; k <= config.key_count; k++) {
        if (config.layer_key !== k) out.add(slotKey(k, l));
      }
      if (vision6) for (const s of MODULE_SLOTS) out.add(slotKey(s, l));
    }
    if (vision6) {
      for (const ctx of ["home", "menu"] as const) {
        for (const s of MODULE_SLOTS) out.add(slotKey(s, 0, ctx));
      }
    }
    return out;
  }, []);

  // Hydrate this page from a cache snapshot. A partial one (the central
  // loader is still running, issue #44) shows everything already read and
  // spins the rest; a complete one clears the spinners.
  const hydrateFromCache = useCallback(
    (snap: NonNullable<ReturnType<typeof keysCache.get>>) => {
      setCfg(snap.config);
      setAssignments(new Map(snap.assignments));
      if (snap.complete) {
        setPending(new Set());
        setLoadTotal(0);
      } else {
        const rest = allSlotKeys(snap.config);
        for (const k of snap.assignments.keys()) rest.delete(k);
        setPending(rest);
        setLoadTotal(rest.size + snap.assignments.size);
      }
    },
    [allSlotKeys],
  );

  const reload = useCallback(async (force = false) => {
    if (!drive) return;
    const seq = ++reloadSeq.current;
    if (!force) {
      const cached = keysCache.get(drive.path);
      if (cached) {
        // complete → open instantly; partial → mirror the central loader's
        // progress (the onChange subscription keeps this page live) instead
        // of starting a second read over the same link
        hydrateFromCache(cached);
        return;
      }
    }
    // Put the keypad in test mode BEFORE streaming macros in — and await it so
    // the device sees it first. Otherwise a key pressed mid-load fires its
    // macro (issue: "cihaz içindeki tuşları yüklerken basınca macro oynuyor"),
    // because test_enter would otherwise race the reads. Focus-gated so a
    // backgrounded app still leaves the keypad working (useTestMode owns the
    // steady state and will leave test mode on blur).
    if (focusedRef.current) {
      await send({ t: "test_enter", ui: "keys" }).catch(() => {});
    }
    // The CIRCUITPY drive can still be settling for a moment right after the
    // board enumerates: reads then fail or the macros dir lists empty. Treated
    // naively that looks like a bare keypad — the page shows (and caches) every
    // key as unassigned until a manual Refresh (issue: "atanmış tuşları
    // göremiyorum ... hep unassigned"). So wait for the drive to actually be
    // readable, and retry an empty listing, before believing it.
    let config = defaultConfig();
    let configOk = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        config = { ...config, ...JSON.parse(await ipc.driveRead(drive.path, "config.json")) };
        configOk = true;
        break;
      } catch {
        // Either the drive isn't ready yet (retry) or this board genuinely has
        // no config. Give the mount a few tries to appear before defaulting.
        if (seq !== reloadSeq.current) return;
        await sleep(200);
        if (seq !== reloadSeq.current) return;
      }
    }
    if (seq !== reloadSeq.current) return;
    setCfg(config);
    const layers = effectiveLayers(config);
    // List the macros dir, retrying while it's empty — a cold/settling drive
    // returns [] before the filesystem is really browsable. `listOk` records
    // whether we ever got a successful listing (empty or not) so we never cache
    // a result produced by a drive that wasn't ready.
    let existing = new Set<string>();
    let listOk = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const list = await ipc.driveList(drive.path, "macros");
        existing = new Set(list);
        listOk = true;
        // Trust the listing as soon as it has files, or once config.json has
        // proven the drive is readable (then an empty dir really is "no
        // macros", not a cold mount). Only keep retrying an empty listing when
        // readiness is still unknown.
        if (list.length || configOk) break;
      } catch {
        // dir not browsable yet — fall through to the wait
      }
      if (seq !== reloadSeq.current) return;
      await sleep(200);
      if (seq !== reloadSeq.current) return;
    }
    if (seq !== reloadSeq.current) return;
    const slots: { k: SlotId; l: number; file: string; ctx: SlotContext }[] = [];
    for (let l = 0; l < layers; l++) {
      for (let k = 1; k <= config.key_count; k++) {
        if (config.layer_key === k) continue;
        const file = macroFileName(k, l);
        if (existing.has(file.split("/").pop()!)) slots.push({ k, l, file, ctx: "grid" });
      }
      if (deviceModel(config) === "vision6") {
        for (const s of MODULE_SLOTS) {
          const file = slotFileName(s, l);
          if (existing.has(file.split("/").pop()!)) slots.push({ k: s, l, file, ctx: "grid" });
        }
      }
    }
    if (deviceModel(config) === "vision6") {
      // per-context nav overrides (layer screen / settings menu) are global
      for (const ctx of ["home", "menu"] as const) {
        for (const s of MODULE_SLOTS) {
          const file = slotFileName(s, 0, ctx);
          if (existing.has(file.split("/").pop()!)) slots.push({ k: s, l: 0, file, ctx });
        }
      }
    }
    setAssignments(new Map());
    setPending(new Set(slots.map((s) => keyOf(s.k, s.l, s.ctx))));
    setLoadTotal(slots.length);
    setStatus("");
    // meta.json sidecar (proto v14): overrides shadow the macro headers,
    // exactly like the firmware's own overlay. One tiny read.
    let metaEntries: Record<string, MetaEntry> = {};
    if (existing.has("meta.json")) metaEntries = await readMetaEntries(drive.path);
    if (seq !== reloadSeq.current) return;
    const snapshot = new Map<string, Assignment>();
    const failed: string[] = [];
    for (const s of slots) {
      let a: Assignment | undefined;
      try {
        const stem = metaStem(s.file);
        a = parseAssignment(
          applyMetaOverrides(
            parseDeviceMacro(await ipc.driveRead(drive.path, s.file)),
            stem ? metaEntries[stem] : undefined,
          ),
        );
      } catch {
        // The file is in the listing but couldn't be read/parsed. It is NOT
        // unassigned — say so instead of silently showing a blank key (a
        // large recorded macro on a screen model used to fail here).
        failed.push(slotTitle(s.k));
      }
      if (seq !== reloadSeq.current) return;
      const loaded = a;
      if (loaded) {
        snapshot.set(keyOf(s.k, s.l, s.ctx), loaded);
        setAssignments((prev) => new Map(prev).set(keyOf(s.k, s.l, s.ctx), loaded));
      }
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(keyOf(s.k, s.l, s.ctx));
        return next;
      });
    }
    if (seq !== reloadSeq.current) return;
    if (failed.length) {
      setStatus(
        `Couldn't read the saved macro for ${failed.join(", ")}. It's still on the keypad. Try Refresh.`,
      );
    }
    // Only cache a snapshot we actually trust: the listing succeeded and we
    // either found macros or read the config cleanly (a truly bare keypad).
    // Never cache an empty result from a drive that wasn't ready — that is the
    // state that used to stick until a manual Refresh.
    const trustworthy = listOk && (snapshot.size > 0 || configOk);
    if (trustworthy) {
      keysCache.set(drive.path, { config, assignments: snapshot });
    } else if (!snapshot.size) {
      setStatus("Still reading the keypad… if keys stay blank, press Refresh.");
    }
  }, [drive, send, hydrateFromCache]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Mirror the shared cache while the central loader streams macros in — the
  // page fills key by key with zero extra link traffic (issue #44).
  useEffect(() => {
    if (!drive) return;
    return keysCache.onChange(() => {
      const snap = keysCache.get(drive.path);
      if (snap) hydrateFromCache(snap);
    });
  }, [drive, hydrateFromCache]);

  // Re-read one slot from the drive (the device rewrote it) and fold the
  // fresh assignment into state + cache.
  const refreshSlot = useCallback(
    async (slot: SlotId, l: number, ctx: SlotContext = "grid") => {
      if (!drive) return;
      let a: Assignment | null = null;
      try {
        a = parseAssignment(await readMacroWithMeta(drive.path, fileFor(slot, l, ctx)));
      } catch {
        a = null; // deleted or unreadable — treat as unassigned
      }
      setAssignments((prev) => {
        const next = new Map(prev);
        if (a) next.set(keyOf(slot, l, ctx), a);
        else next.delete(keyOf(slot, l, ctx));
        return next;
      });
      keysCache.setAssignment(drive.path, keyOf(slot, l, ctx), a);
    },
    [drive],
  );

  // A device-side speed edit (macro_changed reason:"speed", proto v14) only
  // touched the sidecar — fold the new speed in from meta.json (one tiny
  // read) instead of re-reading a possibly huge recorded macro.
  const refreshSlotSpeed = useCallback(
    async (slot: SlotId, l: number, ctx: SlotContext = "grid") => {
      if (!drive) return false;
      const stem = metaStem(fileFor(slot, l, ctx));
      if (!stem) return false;
      const tenths = (await readMetaEntries(drive.path))[stem]?.s;
      if (typeof tenths !== "number" || !isFinite(tenths)) return false;
      const speed = tenths / 10;
      const patch = (a: Assignment): Assignment =>
        a.kind === "recorded"
          ? { ...a, macro: { ...a.macro, settings: { ...a.macro.settings, speed } } }
          : { ...a, speed };
      setAssignments((prev) => {
        const cur = prev.get(keyOf(slot, l, ctx));
        if (!cur) return prev;
        const next = new Map(prev);
        const p = patch(cur);
        next.set(keyOf(slot, l, ctx), p);
        keysCache.setAssignment(drive.path, keyOf(slot, l, ctx), p);
        return next;
      });
      return true;
    },
    [drive],
  );

  // The device can rewrite a macro itself (Vision 6's on-screen speed menu
  // sends macro_changed). Keep our copy fresh — unless that very slot is
  // open with unsaved edits, in which case ask instead of clobbering.
  const editStateRef = useRef({
    selected: null as SlotId | null,
    layer: 0,
    ctx: "grid" as SlotContext,
    dirty: false,
  });
  editStateRef.current = { selected, layer, ctx: slotCtx, dirty: draft !== null };
  useEffect(
    () =>
      onMsg((m) => {
        if (m.t !== "macro_changed") return;
        const parsed = parseMacroFileName(String((m as { file?: unknown }).file ?? ""));
        if (!parsed) return;
        const cur = editStateRef.current;
        if (
          cur.selected === parsed.slot &&
          cur.layer === parsed.layer &&
          cur.ctx === parsed.ctx &&
          cur.dirty
        ) {
          setChangedNotice(parsed);
          return;
        }
        // A speed edit only touched the sidecar (proto v14): read meta.json,
        // not the possibly huge macro body. Fallback to a full re-read when
        // the sidecar has no entry (older firmware, or a real body change).
        if (
          (m as { reason?: string }).reason === "speed" &&
          (hello?.proto ?? 0) >= META_PROTO
        ) {
          void refreshSlotSpeed(parsed.slot, parsed.layer, parsed.ctx).then((ok) => {
            if (!ok) void refreshSlot(parsed.slot, parsed.layer, parsed.ctx);
          });
          return;
        }
        void refreshSlot(parsed.slot, parsed.layer, parsed.ctx);
      }),
    [onMsg, refreshSlot, refreshSlotSpeed, hello?.proto],
  );

  // The Keys tab is a key TEST screen (issue #33): while it's open and the
  // window is focused, a physical press must NOT fire its macro on any model —
  // otherwise trying keys here would trigger real macros. The device goes into
  // test mode (playback suppressed; Vision 6 shows a warning, core6 goes quiet
  // and TestModeNotice explains it under the Keypad card title). Gated on focus: a backgrounded
  // app (e.g. Chrome in front) drops test mode so the keypad keeps working.
  const connected = hello != null;
  useTestMode(send, "keys", connected);

  // Keep the layer-name field showing the active layer's saved nickname.
  useEffect(() => {
    setLayerNameDraft(cfg?.layer_names?.[layer] ?? "");
  }, [cfg, layer]);

  // Surface playback / error feedback from the device.
  useEffect(
    () =>
      onMsg((m) => {
        if (m.t === "play_start") setStatus(`Playing ${m.file}…`);
        if (m.t === "play_done") setStatus(m.stopped ? "Playback stopped." : "Playback finished.");
        if (m.t === "err") setStatus(`Device error: ${m.code} (${m.msg ?? ""})`);
      }),
    [onMsg],
  );

  if (!hello)
    return (
      <Card>
        <EmptyState
          icon={<Usb size={28} />}
          title="No keypad connected"
          description="Connect your MKYADA keypad to assign what each key does."
          action={
            <Button variant="primary" onClick={() => nav("devices")}>
              Go to Devices
            </Button>
          }
        />
      </Card>
    );
  if (!drive)
    return (
      <Card>
        <EmptyState
          icon={<Usb size={28} />}
          title="Waiting for the keypad's USB drive…"
          description="Assignments are saved as files on the keypad's USB drive (CIRCUITPY). It usually mounts a few seconds after the keypad connects, and the app keeps looking automatically. If nothing happens for a while, unplug and replug the keypad."
        />
        <div className="flex justify-center mt-3">
          <Spinner />
        </div>
      </Card>
    );
  if (!cfg)
    return (
      <div className="flex items-center gap-2 text-fg-muted text-sm p-4">
        <Spinner /> Loading key assignments…
      </div>
    );

  const layers = effectiveLayers(cfg);
  const isVision = deviceModel(cfg.model ? cfg : hello) === "vision6";
  const isSlot = selected !== null && typeof selected !== "number";
  const ctx: SlotContext = isSlot ? slotCtx : "grid";
  const current = selected !== null ? assignments.get(keyOf(selected, layer, ctx)) : undefined;
  const fwOk = (() => {
    const [maj = 0, min = 0] = (hello?.fw ?? "0.0").split(".").map((n) => parseInt(n) || 0);
    return maj > 0 || min >= 9; // slot contexts / variants / PSH: firmware 0.9.0
  })();
  // firmware < 0.17.6 has no per-layer nicknames (layer_names)
  const namesSupported = hello?.layer_names !== undefined;

  // Persist the active layer's on-screen nickname. Device-display only — the
  // app keeps labelling layers A/B/C/D; only the Vision 6 band shows the name
  // as "(A) NAME". Blank on every layer stores null. Writes config.json and
  // reloads the firmware so the band updates.
  async function saveLayerName(next: string) {
    if (!cfg || !drive) return;
    const trimmed = next.trim();
    if (trimmed === (cfg.layer_names?.[layer] ?? "")) return; // unchanged
    const names = Array.from(
      { length: cfg.layer_count },
      (_, i) => ((i === layer ? trimmed : cfg.layer_names?.[i]?.trim()) || null),
    );
    const value = names.some(Boolean) ? names : null;
    try {
      // set_cfg (proto v14): the nickname lands live — no reload, no cache
      // drop, no re-read of every macro (issue #45)
      await setDeviceCfg({ layer_names: value });
      setCfg({ ...cfg, layer_names: value });
    } catch (e) {
      toast.error("Could not save the layer name", String(e));
    }
  }

  async function saveDraft() {
    if (selected === null || !draft || !cfg || !drive) return;
    const file = fileFor(selected, layer, ctx);
    // module slots may save "built-in tap + custom hold/double" (issue #19);
    // leaving the concrete built-in action untouched writes no file (issue #26)
    const macro = isSlot
      ? compileSlotAssignment(draft, SLOT_BUILTIN_ACTION[selected as ModuleSlot])
      : compileAssignment(draft);
    // Fast path (proto v14): when only speed/icon/name changed on a big
    // recorded macro, write the meta.json sidecar instead of re-uploading
    // hundreds of KB — the edit lands in milliseconds and the long
    // unattended flash write (the FAT-corruption window) never opens.
    if (macro && (hello?.proto ?? 0) >= META_PROTO) {
      const prev = current;
      const prevMacro = prev
        ? isSlot
          ? compileSlotAssignment(prev, SLOT_BUILTIN_ACTION[selected as ModuleSlot])
          : compileAssignment(prev)
        : null;
      const stem = metaStem(file);
      if (prevMacro && stem) {
        prevMacro.screen = cfg.screen;
        const nextMacro = { ...macro, screen: cfg.screen };
        const fields = metaFastFields(
          serializeForDevice(prevMacro, hello!.proto),
          serializeForDevice(nextMacro, hello!.proto),
        );
        if (fields) {
          setSaving(true);
          try {
            await writeMetaOverrides(drive.path, stem, fields);
            setSaving(false);
            macroFileCache.invalidate(drive.path, file);
            const next = new Map(assignments);
            next.set(keyOf(selected, layer, ctx), draft);
            setAssignments(next);
            keysCache.setAssignment(drive.path, keyOf(selected, layer, ctx), draft);
            setDraft(null);
            setChangedNotice(null);
            toast.success(
              `${slotTitle(selected)} saved to the keypad`,
              typeof selected === "number"
                ? "Press the key (or ▶ Test) to try it."
                : "Use the control on the device (or ▶ Test) to try it.",
            );
            return;
          } catch {
            setSaving(false);
            // sidecar write failed — fall through to the normal full write
          }
        }
      }
    }
    setSaving(true);
    try {
      // The whole save runs under the blocking write modal (issue #15): the
      // bar hits 100% only when the macro is fully written AND verified.
      await writeToKeypad(`${slotTitle(selected)} macro`, async (ctx) => {
        const bail = () => {
          if (ctx.cancelRequested()) throw writeCancelledError();
        };
        // mixed sequences keep their HID steps in sibling part files
        // (key3.s0.json…) the app plays over serial
        await writeSlotFiles(
          drive!.path,
          file,
          draft!,
          macro,
          cfg!.screen,
          hello?.proto ?? 0,
          bail,
        );
      });
    } catch (e) {
      setSaving(false);
      if (isWriteCancelled(e)) {
        // cancelled mid-transfer — the key must not keep a half-written
        // macro, so remove the file and leave the slot unassigned (issue #15)
        await ipc.driveDelete(drive.path, file).catch(() => {});
        macroFileCache.invalidate(drive.path, file);
        const next = new Map(assignments);
        next.delete(keyOf(selected, layer, ctx));
        setAssignments(next);
        keysCache.setAssignment(drive.path, keyOf(selected, layer, ctx), null);
        toast.info("Save cancelled", `${slotTitle(selected)} was left unassigned.`);
        return;
      }
      toast.error(
        "Could not save to the keypad",
        `${e}\n\nCheck that the keypad's USB drive is mounted and writable (unplug/replug if needed).`,
      );
      return;
    }
    setSaving(false);
    // the host-action runner caches parsed macros per file; the file just
    // changed, so drop its entry (else a press replays the old action)
    macroFileCache.invalidate(drive.path, file);
    const next = new Map(assignments);
    if (macro) next.set(keyOf(selected, layer, ctx), draft);
    else next.delete(keyOf(selected, layer, ctx));
    setAssignments(next);
    keysCache.setAssignment(drive.path, keyOf(selected, layer, ctx), macro ? draft : null);
    setDraft(null);
    setChangedNotice(null);
    if (macro) {
      toast.success(
        `${slotTitle(selected)} saved to the keypad`,
        typeof selected === "number" ? "Press the key (or ▶ Test) to try it." : "Use the control on the device (or ▶ Test) to try it.",
      );
    } else {
      toast.info(`${slotTitle(selected)} cleared`);
    }
  }

  /**
   * Put the selected key's assignment on another key (any layer) without
   * building it again — the thing you used to have to redo from scratch just
   * to shift a macro one key over. Moving onto an occupied key SWAPS the two:
   * rearranging a keypad is the whole point, and nothing gets destroyed.
   * Copy leaves the source alone and overwrites the target.
   */
  async function moveAssignment(to: number, toLayer: number, mode: "move" | "copy") {
    if (typeof selected !== "number" || !current || !cfg || !drive) return;
    const srcFile = fileFor(selected, layer);
    const dstFile = fileFor(to, toLayer);
    if (srcFile === dstFile) return;
    const displaced = mode === "move" ? assignments.get(slotKey(to, toLayer)) : undefined;
    const proto = hello?.proto ?? 0;
    setMoving(false);
    setSaving(true);
    try {
      await writeToKeypad(`${slotTitle(selected)} → Key ${to}`, async (wctx) => {
        const bail = () => {
          if (wctx.cancelRequested()) throw writeCancelledError();
        };
        await writeSlotFiles(drive.path, dstFile, current, compileAssignment(current), cfg.screen, proto, bail);
        if (mode === "move") {
          bail();
          if (displaced) {
            await writeSlotFiles(drive.path, srcFile, displaced, compileAssignment(displaced), cfg.screen, proto, bail);
          } else {
            await ipc.driveDelete(drive.path, srcFile).catch(() => {});
            await sweepParts(drive.path, srcFile, new Set());
          }
        }
      });
    } catch (e) {
      setSaving(false);
      if (isWriteCancelled(e)) {
        // A half-finished move would leave the macro on two keys or none —
        // re-read both slots and tell the truth about where it ended up.
        await refreshSlot(selected, layer);
        await refreshSlot(to, toLayer);
        toast.info("Move cancelled", "Both keys were re-read from the keypad.");
        return;
      }
      toast.error("Could not move the macro", String(e));
      return;
    }
    setSaving(false);
    macroFileCache.invalidate(drive.path, srcFile);
    macroFileCache.invalidate(drive.path, dstFile);
    const next = new Map(assignments);
    next.set(slotKey(to, toLayer), current);
    const leftBehind = mode === "copy" ? current : displaced ?? null;
    if (leftBehind) next.set(slotKey(selected, layer), leftBehind);
    else next.delete(slotKey(selected, layer));
    setAssignments(next);
    keysCache.setAssignment(drive.path, slotKey(to, toLayer), current);
    keysCache.setAssignment(drive.path, slotKey(selected, layer), leftBehind);
    setDraft(null);
    setChangedNotice(null);
    if (toLayer !== layer) {
      setLayer(toLayer);
      void send({ t: "set_layer", layer: "abcdefgh"[toLayer] });
    }
    setSelected(to);
    const where = `Key ${to}${layers > 1 ? ` on layer ${layerLabel(toLayer)}` : ""}`;
    toast.success(
      mode === "copy" ? `Copied to ${where}` : displaced ? `Swapped with ${where}` : `Moved to ${where}`,
    );
  }

  async function testPlay(slot: SlotId) {
    await send({ t: "play", file: fileFor(slot, layer, ctx) });
  }

  // "Run on keypad": press the saved key remotely, exactly like its physical
  // press (gestures, repeat, loop and all) — unlike "Play file", which plays
  // the macro file directly. Numbered keys only; the remote press protocol
  // has no module-slot presses.
  const layerLetter = "abcdefgh"[layer];
  const runPlaying =
    typeof selected === "number" &&
    playback.playing?.key === selected &&
    (playback.playing.layer === null || playback.playing.layer === layerLetter);
  const runBlocked =
    typeof selected !== "number"
      ? "Remote press works on numbered keys only"
      : draft
        ? "Save your changes first · this runs what's saved on the keypad"
        : !playback.canPress
          ? (playback.pressDisabledReason ?? "Remote press is unavailable")
          : playback.holdReason;
  const runButton = runPlaying ? (
    <Tooltip side="bottom" content="Stop the macro this key is playing">
      <Button
        size="sm"
        variant="danger-solid"
        loading={stoppingRun}
        onClick={() => {
          setStoppingRun(true);
          playback
            .stopPlayback()
            .catch((e) => toast.error("Could not stop playback", String(e)))
            .finally(() => setStoppingRun(false));
        }}
      >
        <Square size={13} aria-hidden fill="currentColor" /> Stop
      </Button>
    </Tooltip>
  ) : (
    <Tooltip
      side="bottom"
      content={runBlocked ?? "Presses the key on the keypad, exactly like pressing it by hand"}
    >
      <Button
        size="sm"
        variant="primary"
        disabled={!!runBlocked}
        loading={pressing}
        onClick={() => {
          if (typeof selected !== "number") return;
          setPressing(true);
          playback
            .pressKey(selected, { layer })
            .catch((e) => toast.error("The keypad didn't run the key", e instanceof Error ? e.message : String(e)))
            .finally(() => setPressing(false));
        }}
      >
        <CirclePlay size={14} aria-hidden /> Run on keypad
      </Button>
    </Tooltip>
  );

  const visibleAssignments = new Map<number, Assignment>();
  const pendingKeys = new Set<number>();
  for (let k = 1; k <= cfg.key_count; k++) {
    const a = assignments.get(slotKey(k, layer));
    if (a) visibleAssignments.set(k, a);
    if (pending.has(slotKey(k, layer))) pendingKeys.add(k);
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Keypad column fixed and narrow (tiles stay keypad-sized), the editor
          takes the rest — it's where the work happens. */}
      <div className="grid grid-cols-[360px_minmax(0,1fr)] 2xl:grid-cols-[420px_minmax(0,1fr)] gap-4 items-start">
      <Card
        title="Keypad"
        description={<TestModeNotice />}
        actions={
          <IconButton
            label="Re-read every assignment from the keypad · normally not needed, the app remembers them"
            onClick={() => {
              keysCache.invalidate(drive.path);
              void reload(true);
            }}
          >
            <RefreshCw size={16} aria-hidden />
          </IconButton>
        }
      >
        {layers > 1 && (
          // Layer picker + the active layer's on-screen name, one compact row.
          <div className="mb-4 flex items-end gap-2">
            <div className="flex shrink-0 flex-col gap-1.5">
            <span className={FIELD_LABEL}>Layer</span>
            <SegmentedControl
              ariaLabel="Layer"
              value={String(layer)}
              options={Array.from({ length: layers }, (_, i) => ({
                value: String(i),
                label: layerLabel(i),
                title: cfg.layer_names?.[i] ? `Layer ${layerLabel(i)} · ${cfg.layer_names[i]}` : `Layer ${layerLabel(i)}`,
              }))}
              onChange={(v) => {
                const i = Number(v);
                setLayer(i);
                setDraft(null);
                void send({ t: "set_layer", layer: "abcdefgh"[i] });
              }}
              className="[&>button]:min-w-9"
            />
            </div>
            {isVision && namesSupported && (
              <label className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className={FIELD_LABEL}>Name on screen</span>
              <Input
                id="layer-name"
                value={layerNameDraft}
                maxLength={16}
                placeholder={`Layer ${layerLabel(layer)}`}
                className="w-full"
                title="Shown on the keypad's screen · saved when you leave the field"
                aria-label={`On-screen name for layer ${layerLabel(layer)}`}
                onChange={(e) => setLayerNameDraft(e.target.value)}
                onBlur={() => void saveLayerName(layerNameDraft)}
              />
              </label>
            )}
          </div>
        )}
        <Keypad
          config={cfg}
          selected={typeof selected === "number" ? selected : null}
          onSelect={(n) => {
            if (cfg.layer_key === n) return;
            if (pendingKeys.has(n)) return; // still streaming in — not editable yet
            setSelected(n);
            setSlotCtx("grid");
            setDraft(null);
          }}
          assignments={visibleAssignments}
          loading={pendingKeys}
        />
        {isVision && (
          <div className="mt-5 flex flex-col gap-2.5 border-t border-line pt-4">
            <div className="flex flex-col gap-0.5">
              <span className={FIELD_LABEL}>Module controls</span>
              <p className="text-label text-fg-faint">
                Encoder and buttons · set per screen and gesture
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {MODULE_SLOTS.map((s, i) => {
                const a = assignments.get(slotKey(s, layer));
                const overrides = (["home", "menu"] as const).filter((c) =>
                  assignments.get(slotKey(s, layer, c)),
                );
                const isLoading = pending.has(slotKey(s, layer));
                const isSelected = selected === s;
                const odd = MODULE_SLOTS.length % 2 === 1 && i === MODULE_SLOTS.length - 1;
                return (
                  <button
                    key={s}
                    onClick={() => {
                      if (isLoading) return;
                      setSelected(s);
                      setSlotCtx("grid");
                      setDraft(null);
                    }}
                    aria-pressed={isSelected}
                    aria-busy={isLoading}
                    // same surface, border and selection as the key tiles above
                    className={`hz-control relative min-w-0 rounded-card border px-3 py-2.5 flex flex-col items-start gap-0.5 text-left transition-[background-color,border-color,box-shadow] duration-[120ms] ease-standard
                      ${odd ? "col-span-2" : ""}
                      ${isSelected ? "border-accent bg-selected shadow-ring" : "border-line-strong bg-raised hover:border-stone-350"}`}
                  >
                    <span className="text-[13px] font-strong text-fg">{MODULE_SLOT_LABELS[s]}</span>
                    <span className="text-label text-fg-muted leading-tight line-clamp-2">
                      {isLoading ? (
                        <Spinner size={12} className="text-fg-faint" />
                      ) : a ? (
                        describeSlotAssignment(a)
                      ) : (
                        <span className="text-fg-faint">Built-in · {SLOT_BUILTINS.grid[s]}</span>
                      )}
                    </span>
                    {!isLoading && overrides.length > 0 && (
                      <span className="text-label text-fg-faint leading-tight">
                        +{" "}
                        {overrides.map((c) => (c === "home" ? "layer screen" : "settings")).join(", ")}
                      </span>
                    )}
                    {a && (
                      <span
                        aria-hidden
                        title="Customized"
                        className="absolute top-2 right-2 size-1.5 rounded-full bg-accent"
                      />
                    )}
                  </button>
                );
              })}
            </div>
            <details className="group/how">
              <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-control text-label font-medium text-fg-muted hover:text-fg [&::-webkit-details-marker]:hidden">
                <ChevronRight
                  size={13}
                  aria-hidden
                  className="transition-transform duration-[120ms] ease-standard group-open/how:rotate-90"
                />
                How module controls work
              </summary>
              <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-label text-fg-muted marker:text-fg-faint">
                <li>
                  Each control has its own setting per screen (key grid, layer screen, settings
                  menu) and per gesture (tap, double press, long press).
                </li>
                <li>
                  “Built-in” is the on-device menu navigation. Pick “Do nothing” to turn a control off.
                </li>
                {layers > 1 && (
                  <li>A layer without its own key-grid assignment uses Layer A's.</li>
                )}
                <li>
                  Keystroke, media and mouse actions work standalone. Open app, command, sound
                  and webhook actions need the MKYADA app running.
                </li>
              </ul>
            </details>
          </div>
        )}
        {pending.size > 0 && (
          <p className="text-label text-fg-muted mt-3 flex items-center gap-1.5">
            <Spinner size={12} />
            Loading saved macros from the keypad… {loadTotal - pending.size}/{loadTotal}
          </p>
        )}
        {cfg.layer_key ? (
          <p className="text-label text-fg-faint mt-3">Key {cfg.layer_key} is the layer switch.</p>
        ) : null}
      </Card>

      <Card
        title={
          selected === null
            ? "Select a key"
            : ctx !== "grid"
              ? `${slotTitle(selected)} · ${CTX_META.find((c) => c.id === ctx)!.label}`
              : `${slotTitle(selected)}${layers > 1 ? ` · Layer ${layerLabel(layer)}` : ""}`
        }
        actions={
          selected !== null &&
          current && (
            // Run on keypad is the one primary action; Edit in Recorder stays
            // visible on recorded keys, the rest lives in the overflow menu so
            // the header never wraps under the title.
            <div className="flex items-center gap-1.5">
              {current.kind === "recorded" && typeof selected === "number" && (
                <Tooltip side="bottom" content="Open this macro in the Recorder's editor · tweak it and save it back">
                  <Button
                    size="sm"
                    onClick={() => {
                      stashRecorderEdit({
                        macro: migrateMacro(current.macro),
                        key: selected,
                        layer,
                      });
                      nav("recorder");
                    }}
                  >
                    <SquarePen size={14} aria-hidden /> Edit in Recorder
                  </Button>
                </Tooltip>
              )}
              <OverflowMenu
                label={`More actions for ${slotTitle(selected)}`}
                items={[
                  ...(typeof selected === "number"
                    ? [
                        {
                          label: "Move…",
                          icon: <ArrowRightLeft size={15} aria-hidden />,
                          hint: draft
                            ? "Save or revert your edits first"
                            : "Put this action on another key · a used key swaps with it",
                          disabled: !!draft,
                          onSelect: () => setMoving(true),
                        },
                      ]
                    : []),
                  {
                    label: "Play file",
                    icon: <Play size={15} aria-hidden />,
                    hint: "Plays the saved file once from the app · skips double / long press, hold and re-press",
                    onSelect: () => void testPlay(selected),
                  },
                ]}
              />
              {runButton}
            </div>
          )
        }
      >
        {status &&
          (/^(Device error|Couldn't|Still reading)/.test(status) ? (
            <Alert tone="warning" className="mb-4">
              {status}
            </Alert>
          ) : (
            <p className="text-label text-fg-faint mb-3">{status}</p>
          ))}
        {selected === null ? (
          <EmptyState
            icon={<MousePointerClick size={28} aria-hidden />}
            title="Pick a key"
            description="Click a key on the left to choose what it does."
          />
        ) : (
          <div className="flex flex-col gap-4">
            {isSlot && (
              <div className="flex flex-col gap-1.5">
                <SegmentedControl
                  ariaLabel="Where this assignment applies"
                  value={ctx}
                  options={CTX_META.map((c) => ({
                    value: c.id,
                    label: (
                      <>
                        {c.label}
                        {assignments.get(keyOf(selected, layer, c.id)) && (
                          <span
                            aria-label="customized"
                            className="size-1.5 rounded-full bg-accent"
                          />
                        )}
                      </>
                    ),
                  }))}
                  onChange={(id) => {
                    setSlotCtx(id);
                    setDraft(null);
                    setChangedNotice(null);
                  }}
                  className="self-start"
                />
                <p className="text-label text-fg-faint">
                  {CTX_META.find((c) => c.id === ctx)!.hint} · Built-in here:{" "}
                  {SLOT_BUILTINS[ctx][selected as ModuleSlot]}
                </p>
                {!fwOk && (
                  <Alert tone="warning">
                    Per-context overrides, PSH assignments and slot key logic need firmware
                    0.9.0 · update on the Devices page.
                  </Alert>
                )}
              </div>
            )}
            {changedNotice &&
              changedNotice.slot === selected &&
              changedNotice.layer === layer &&
              changedNotice.ctx === ctx && (
              <Alert
                tone="warning"
                title="Speed changed on the keypad"
                actions={
                  <>
                    <Button
                      size="sm"
                      onClick={() => {
                        setDraft(null);
                        setChangedNotice(null);
                        void refreshSlot(selected, layer, ctx);
                      }}
                    >
                      Reload
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setChangedNotice(null)}>
                      Keep my edits
                    </Button>
                  </>
                }
              >
                Reload it here? Your unsaved edits would be discarded.
              </Alert>
            )}
            <AssignmentPanel
              value={
                draft ??
                (isSlot
                  ? slotEditValue(current, SLOT_BUILTIN_ACTION[selected as ModuleSlot])
                  : current ?? { kind: "none" })
              }
              onChange={draftHistory.set}
              onSave={() => void saveDraft()}
              onRevert={() => setDraft(null)}
              dirty={draft !== null}
              saving={saving}
              saveLabel="Save to keypad"
              labelOnScreen={isVision}
              // device-menu nav only exists on a screen model; on module
              // slots it drives the BUILT-IN navigation (issue #19)
              allowMenu={isVision}
              slotMode={isSlot}
              // the "Built-in" choice names the concrete operation, not an
              // abstract "default action"
              builtinDesc={isSlot ? SLOT_BUILTINS[ctx][selected as ModuleSlot] : undefined}
              // rotation has no press to double/hold on
              allowVariants={!isSlot || (selected as string).startsWith("btn-")}
              fwVersion={hello?.fw}
              // offer "Go to layer X" for every configured layer — raw
              // layer_count, not effectiveLayers: a "go to layer B" key is
              // itself a way to reach layers without a dedicated layer key
              layerCount={cfg.layer_count}
            />
          </div>
        )}
      </Card>
      </div>
      {moving && typeof selected === "number" && current && (
        <MoveDialog
          cfg={cfg}
          layers={layers}
          from={{ key: selected, layer }}
          what={current.label || describeAssignment(current)}
          assignments={assignments}
          onClose={() => setMoving(false)}
          onPick={(to, toLayer, mode) => void moveAssignment(to, toLayer, mode)}
        />
      )}
    </div>
  );
}

/** Target picker for "put this macro on another key": the real keypad layout,
 * one layer at a time, with what's already on each key. Occupied targets are
 * labelled as a swap so the outcome is never a surprise. */
function MoveDialog({
  cfg,
  layers,
  from,
  what,
  assignments,
  onClose,
  onPick,
}: {
  cfg: DeviceConfig;
  layers: number;
  from: { key: number; layer: number };
  what: string;
  assignments: Map<string, Assignment>;
  onClose: () => void;
  onPick: (key: number, layer: number, mode: "move" | "copy") => void;
}) {
  const [targetLayer, setTargetLayer] = useState(from.layer);
  const [target, setTarget] = useState<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const shown = new Map<number, Assignment>();
  for (let k = 1; k <= cfg.key_count; k++) {
    const a = assignments.get(slotKey(k, targetLayer));
    if (a) shown.set(k, a);
  }
  const isSelf = target !== null && target === from.key && targetLayer === from.layer;
  const occupied = target !== null && !isSelf && shown.has(target);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Move this action to another key"
        className="bg-panel border border-line rounded-dialog shadow-overlay w-[30rem] max-w-[92vw] p-5 flex flex-col gap-3"
      >
        <h2 className="text-title font-semibold text-fg">
          Move “{what}” to another key
        </h2>
        {layers > 1 && (
          <div className="flex gap-1">
            {Array.from({ length: layers }, (_, i) => (
              <Button
                key={i}
                variant={targetLayer === i ? "primary" : "default"}
                onClick={() => {
                  setTargetLayer(i);
                  setTarget(null);
                }}
              >
                {layerLabel(i)}
              </Button>
            ))}
          </div>
        )}
        <Keypad
          config={cfg}
          selected={target}
          onSelect={(n) => {
            if (cfg.layer_key === n) return;
            setTarget(n);
          }}
          assignments={shown}
        />
        <p className="text-label text-fg-faint min-h-8">
          {target === null
            ? "Pick the key this action should live on."
            : isSelf
              ? "That's the key it's already on."
              : occupied
                ? `Key ${target} already has “${
                    shown.get(target)!.label || describeAssignment(shown.get(target)!)
                  }”. Move swaps the two, Copy replaces it.`
                : `Key ${target}${layers > 1 ? ` on layer ${layerLabel(targetLayer)}` : ""} is empty.`}
        </p>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            disabled={target === null || isSelf}
            onClick={() => target !== null && onPick(target, targetLayer, "copy")}
          >
            Copy here
          </Button>
          <Button
            variant="primary"
            disabled={target === null || isSelf}
            onClick={() => target !== null && onPick(target, targetLayer, "move")}
          >
            {occupied ? "Swap" : "Move here"}
          </Button>
        </div>
      </div>
    </div>
  );
}

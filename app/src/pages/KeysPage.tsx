// Main configurator: pick a key on the visual keypad, choose what it does,
// save. Every assignment is compiled to a macro JSON on the device drive.

import { useCallback, useEffect, useRef, useState } from "react";
import { Play, RefreshCw, SquarePen, Usb } from "lucide-react";
import { useDevice } from "../lib/device";
import { useHostMode } from "../lib/focus";
import { useNav } from "../lib/nav";
import { ipc } from "../lib/ipc";
import type { Assignment, DeviceConfig, ModuleSlot } from "../lib/types";
import { MODULE_SLOTS, deviceModel, layerLabel } from "../lib/types";
import {
  AUX_FILE_RE,
  assignmentComplete,
  compileAssignment,
  compileSequenceParts,
  defaultConfig,
  describeAssignment,
  effectiveLayers,
  macroFileName,
  migrateMacro,
  parseAssignment,
  parseDeviceMacro,
  parseMacroFileName,
  slotFileName,
} from "../lib/macro-model";
import { serializeForDevice } from "../lib/recorder-model";
import { keysCache, slotKey } from "../lib/keys-cache";
import { stashRecorderEdit } from "../lib/recorder-handoff";
import { undoRedoFromEvent, useHistory } from "../lib/history";
import { Button, Card, EmptyState, Spinner } from "../components/ui";
import { isWriteCancelled, useWriteGate, writeCancelledError } from "../components/WriteProgress";
import { useToast } from "../components/toast";
import { Keypad } from "../components/Keypad";
import { AssignmentEditor } from "../components/AssignmentEditor";

/** What can hold a macro: a numbered key, or a Vision 6 module control. */
type SlotId = number | ModuleSlot;

const MODULE_SLOT_LABELS: Record<ModuleSlot, string> = {
  "enc-cw": "Encoder →",
  "enc-ccw": "Encoder ←",
  "btn-back": "BACK button",
  "btn-confirm": "CONFIRM button",
};

function fileFor(slot: SlotId, layer: number): string {
  return typeof slot === "number" ? macroFileName(slot, layer) : slotFileName(slot, layer);
}

function slotTitle(slot: SlotId): string {
  return typeof slot === "number" ? `Key ${slot}` : MODULE_SLOT_LABELS[slot];
}

export function KeysPage() {
  const { hello, drive, send, onMsg } = useDevice();
  const nav = useNav();
  const toast = useToast();
  const { writeToKeypad } = useWriteGate();
  const [cfg, setCfg] = useState<DeviceConfig | null>(null);
  const [layer, setLayer] = useState(0);
  const [selected, setSelected] = useState<SlotId | null>(null);
  const [assignments, setAssignments] = useState<Map<string, Assignment>>(new Map());
  // A macro's settings were edited on the device while that slot had unsaved
  // edits here — offer a reload instead of silently clobbering either side.
  const [changedNotice, setChangedNotice] = useState<{ slot: SlotId; layer: number } | null>(null);
  // Draft edits are undoable (⌘Z); switching key/layer or saving resets the stack.
  const draftHistory = useHistory<Assignment | null>(null);
  const draft = draftHistory.present;
  const setDraft = draftHistory.reset;
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  // Slots whose macro is still streaming in from the keypad (issue #12) —
  // their keys show a spinner and unlock one by one as reads complete.
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [loadTotal, setLoadTotal] = useState(0);

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

  // Load config + existing assignments from the drive. One directory listing
  // tells us which slots exist (no blind reads on empty slots), then each
  // macro streams in on its own: the keypad renders immediately and keys
  // unlock one by one instead of the page blocking on every read (issue #12).
  // Every macro reaches the keypad through this app, so a snapshot taken
  // once stays valid across tab switches — entering the page again reuses it
  // instead of re-streaming everything (issue #14).
  const reload = useCallback(async (force = false) => {
    if (!drive) return;
    const seq = ++reloadSeq.current;
    if (!force) {
      const cached = keysCache.get(drive.path);
      if (cached) {
        setCfg(cached.config);
        setAssignments(new Map(cached.assignments));
        setPending(new Set());
        setLoadTotal(0);
        return;
      }
    }
    let config = defaultConfig();
    try {
      config = { ...config, ...JSON.parse(await ipc.driveRead(drive.path, "config.json")) };
    } catch {
      // no config yet — defaults are fine
    }
    if (seq !== reloadSeq.current) return;
    setCfg(config);
    const layers = effectiveLayers(config);
    const existing = new Set(await ipc.driveList(drive.path, "macros").catch(() => [] as string[]));
    if (seq !== reloadSeq.current) return;
    const slots: { k: SlotId; l: number; file: string }[] = [];
    for (let l = 0; l < layers; l++) {
      for (let k = 1; k <= config.key_count; k++) {
        if (config.layer_key === k) continue;
        const file = macroFileName(k, l);
        if (existing.has(file.split("/").pop()!)) slots.push({ k, l, file });
      }
      if (deviceModel(config) === "vision6") {
        for (const s of MODULE_SLOTS) {
          const file = slotFileName(s, l);
          if (existing.has(file.split("/").pop()!)) slots.push({ k: s, l, file });
        }
      }
    }
    setAssignments(new Map());
    setPending(new Set(slots.map((s) => slotKey(s.k, s.l))));
    setLoadTotal(slots.length);
    const snapshot = new Map<string, Assignment>();
    for (const s of slots) {
      let a: Assignment | undefined;
      try {
        a = parseAssignment(parseDeviceMacro(await ipc.driveRead(drive.path, s.file)));
      } catch {
        // unreadable slot — treat as unassigned
      }
      if (seq !== reloadSeq.current) return;
      const loaded = a;
      if (loaded) {
        snapshot.set(slotKey(s.k, s.l), loaded);
        setAssignments((prev) => new Map(prev).set(slotKey(s.k, s.l), loaded));
      }
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(slotKey(s.k, s.l));
        return next;
      });
    }
    keysCache.set(drive.path, { config, assignments: snapshot });
  }, [drive]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Re-read one slot from the drive (the device rewrote it) and fold the
  // fresh assignment into state + cache.
  const refreshSlot = useCallback(
    async (slot: SlotId, l: number) => {
      if (!drive) return;
      let a: Assignment | null = null;
      try {
        a = parseAssignment(parseDeviceMacro(await ipc.driveRead(drive.path, fileFor(slot, l))));
      } catch {
        a = null; // deleted or unreadable — treat as unassigned
      }
      setAssignments((prev) => {
        const next = new Map(prev);
        if (a) next.set(slotKey(slot, l), a);
        else next.delete(slotKey(slot, l));
        return next;
      });
      keysCache.setAssignment(drive.path, slotKey(slot, l), a);
    },
    [drive],
  );

  // The device can rewrite a macro itself (Vision 6's on-screen speed menu
  // sends macro_changed). Keep our copy fresh — unless that very slot is
  // open with unsaved edits, in which case ask instead of clobbering.
  const editStateRef = useRef({ selected: null as SlotId | null, layer: 0, dirty: false });
  editStateRef.current = { selected, layer, dirty: draft !== null };
  useEffect(
    () =>
      onMsg((m) => {
        if (m.t !== "macro_changed") return;
        const parsed = parseMacroFileName(String((m as { file?: unknown }).file ?? ""));
        if (!parsed) return;
        const cur = editStateRef.current;
        if (cur.selected === parsed.slot && cur.layer === parsed.layer && cur.dirty) {
          setChangedNotice(parsed);
          return;
        }
        void refreshSlot(parsed.slot, parsed.layer);
      }),
    [onMsg, refreshSlot],
  );

  // Keep the live-press highlight working while this page is open — but only
  // while the window is focused, so a backgrounded/tray'd app never blocks
  // standalone playback (issue #8).
  useHostMode(send);

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
          description="Assignments are saved as files on the keypad's USB drive (CIRCUITPY). It usually mounts a few seconds after the keypad connects — the app keeps looking automatically. If nothing happens for a while, unplug and replug the keypad."
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
  const current = selected !== null ? assignments.get(slotKey(selected, layer)) : undefined;

  async function saveDraft() {
    if (selected === null || !draft || !cfg || !drive) return;
    const file = fileFor(selected, layer);
    const macro = compileAssignment(draft);
    setSaving(true);
    try {
      // The whole save runs under the blocking write modal (issue #15): the
      // bar hits 100% only when the macro is fully written AND verified.
      await writeToKeypad(`${slotTitle(selected)} macro`, async (ctx) => {
        const bail = () => {
          if (ctx.cancelRequested()) throw writeCancelledError();
        };
        if (macro) {
          macro.screen = cfg!.screen;
          await ipc.driveWrite(drive.path, file, serializeForDevice(macro, hello?.proto ?? 0));
          bail();
          // verify the write landed before claiming success
          const back = await ipc.driveRead(drive.path, file);
          if (!back.includes("mkyada-macro")) throw new Error("verification read failed");
        } else {
          try {
            await ipc.driveDelete(drive.path, file);
          } catch {
            // was already unassigned
          }
        }
        // mixed sequences keep their HID steps in sibling part files
        // (key3.s0.json…) the app plays over serial; write the current set and
        // sweep any stale ones from a previous, longer sequence
        const parts = draft!.kind === "sequence" ? compileSequenceParts(draft!, file) : [];
        for (const p of parts) {
          bail();
          await ipc.driveWrite(drive.path, p.path, serializeForDevice(p.file, hello?.proto ?? 0));
        }
        const stem = file.split("/").pop()!.replace(/\.json$/, ".");
        const keep = new Set(parts.map((p) => p.path.split("/").pop()));
        const existing = await ipc.driveList(drive.path, "macros").catch(() => [] as string[]);
        for (const f of existing) {
          if (f.startsWith(stem) && AUX_FILE_RE.test(f) && !keep.has(f)) {
            await ipc.driveDelete(drive.path, `macros/${f}`).catch(() => {});
          }
        }
      });
    } catch (e) {
      setSaving(false);
      if (isWriteCancelled(e)) {
        // cancelled mid-transfer — the key must not keep a half-written
        // macro, so remove the file and leave the slot unassigned (issue #15)
        await ipc.driveDelete(drive.path, file).catch(() => {});
        const next = new Map(assignments);
        next.delete(slotKey(selected, layer));
        setAssignments(next);
        keysCache.setAssignment(drive.path, slotKey(selected, layer), null);
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
    const next = new Map(assignments);
    if (macro && draft.kind !== "none") next.set(slotKey(selected, layer), draft);
    else next.delete(slotKey(selected, layer));
    setAssignments(next);
    keysCache.setAssignment(
      drive.path,
      slotKey(selected, layer),
      macro && draft.kind !== "none" ? draft : null,
    );
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

  async function testPlay(slot: SlotId) {
    await send({ t: "play", file: fileFor(slot, layer) });
  }

  const visibleAssignments = new Map<number, Assignment>();
  const pendingKeys = new Set<number>();
  for (let k = 1; k <= cfg.key_count; k++) {
    const a = assignments.get(slotKey(k, layer));
    if (a) visibleAssignments.set(k, a);
    if (pending.has(slotKey(k, layer))) pendingKeys.add(k);
  }

  return (
    <div className="grid grid-cols-[1fr_1fr] gap-4 items-start">
      <Card
        title="Keypad"
        actions={
          <div className="flex gap-1 items-center">
            {layers > 1 &&
              Array.from({ length: layers }, (_, i) => (
                <Button
                  key={i}
                  variant={layer === i ? "primary" : "default"}
                  onClick={() => {
                    setLayer(i);
                    setDraft(null);
                    void send({ t: "set_layer", layer: "abcdefgh"[i] });
                  }}
                >
                  {layerLabel(i)}
                </Button>
              ))}
            <Button
              title="Re-read every assignment from the keypad (normally not needed — the app remembers them)"
              onClick={() => {
                keysCache.invalidate(drive.path);
                void reload(true);
              }}
            >
              <RefreshCw size={14} aria-hidden />
            </Button>
          </div>
        }
      >
        <Keypad
          config={cfg}
          selected={typeof selected === "number" ? selected : null}
          onSelect={(n) => {
            if (cfg.layer_key === n) return;
            if (pendingKeys.has(n)) return; // still streaming in — not editable yet
            setSelected(n);
            setDraft(null);
          }}
          assignments={visibleAssignments}
          loading={pendingKeys}
        />
        {isVision && (
          <div className="mt-4 border-t border-line pt-3">
            <p className="text-xs font-semibold tracking-wide text-fg-muted mb-2">
              Module controls
            </p>
            <div className="grid grid-cols-2 gap-2">
              {MODULE_SLOTS.map((s) => {
                const a = assignments.get(slotKey(s, layer));
                const isLoading = pending.has(slotKey(s, layer));
                const isSelected = selected === s;
                return (
                  <button
                    key={s}
                    onClick={() => {
                      if (isLoading) return;
                      setSelected(s);
                      setDraft(null);
                    }}
                    aria-pressed={isSelected}
                    aria-busy={isLoading}
                    className={`rounded-xl border-2 px-3 py-2 flex flex-col items-start gap-0.5 text-left transition-all
                      ${isSelected ? "border-accent bg-panel2" : "border-line bg-panel2 hover:border-fg-faint"}`}
                  >
                    <span className="text-sm font-semibold text-fg">{MODULE_SLOT_LABELS[s]}</span>
                    <span className="text-[10px] text-fg-muted leading-tight">
                      {isLoading ? (
                        <Spinner size={12} className="text-fg-faint" />
                      ) : a ? (
                        describeAssignment(a)
                      ) : (
                        "device menu"
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-fg-faint mt-2">
              Empty slots keep the built-in menu navigation on the device.
              {layers > 1 && " A layer without its own assignment falls back to Layer A's."}{" "}
              Keystroke/media/mouse assignments work standalone; open/command/sound/webhook ones
              run only while the MKYADA app is connected.
            </p>
          </div>
        )}
        {pending.size > 0 && (
          <p className="text-xs text-fg-muted mt-3 flex items-center gap-1.5">
            <Spinner size={12} />
            Loading saved macros from the keypad… {loadTotal - pending.size}/{loadTotal}
          </p>
        )}
        <p className="text-xs text-fg-faint mt-3">
          Press physical keys to test wiring — they light up live.
          {cfg.layer_key && ` Key ${cfg.layer_key} is the layer switch.`}
        </p>
      </Card>

      <Card
        title={
          selected === null
            ? "Select a key"
            : `${slotTitle(selected)}${layers > 1 ? ` · Layer ${layerLabel(layer)}` : ""}`
        }
        actions={
          selected !== null &&
          current && (
            <div className="flex gap-1.5">
              {current.kind === "recorded" && typeof selected === "number" && (
                <Button
                  title="Open this macro in the Recorder's editor — tweak it and save it back"
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
              )}
              <Button onClick={() => void testPlay(selected)}>
                <Play size={14} aria-hidden /> Test
              </Button>
            </div>
          )
        }
      >
        {selected === null ? (
          <p className="text-fg-faint text-sm">
            Click a key on the left to configure what it does.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {changedNotice && changedNotice.slot === selected && changedNotice.layer === layer && (
              <div className="flex items-center gap-3 bg-warning-bg border border-warning-line rounded-lg px-3 py-2">
                <span className="text-sm text-fg flex-1">
                  This macro's speed was changed on the device — reload it here? Your unsaved
                  edits would be discarded.
                </span>
                <Button
                  onClick={() => {
                    setDraft(null);
                    setChangedNotice(null);
                    void refreshSlot(selected, layer);
                  }}
                >
                  Reload
                </Button>
                <Button variant="ghost" onClick={() => setChangedNotice(null)}>
                  Keep my edits
                </Button>
              </div>
            )}
            <AssignmentEditor
              value={draft ?? current ?? { kind: "none" }}
              onChange={draftHistory.set}
              fwVersion={hello?.fw}
            />
            <div className="flex justify-end gap-2">
              <Button onClick={() => setDraft(null)} disabled={!draft}>
                Revert
              </Button>
              <Button
                variant="primary"
                onClick={() => void saveDraft()}
                disabled={!draft || !assignmentComplete(draft)}
                loading={saving}
              >
                Save to keypad
              </Button>
            </div>
          </div>
        )}
        {status && <p className="text-xs text-fg-faint mt-3">{status}</p>}
      </Card>
    </div>
  );
}

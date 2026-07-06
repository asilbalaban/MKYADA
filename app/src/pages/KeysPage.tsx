// Main configurator: pick a key on the visual keypad, choose what it does,
// save. Every assignment is compiled to a macro JSON on the device drive.

import { useCallback, useEffect, useRef, useState } from "react";
import { Play, SquarePen, Usb } from "lucide-react";
import { useDevice } from "../lib/device";
import { useHostMode } from "../lib/focus";
import { useNav } from "../lib/nav";
import { ipc } from "../lib/ipc";
import type { Assignment, DeviceConfig } from "../lib/types";
import { layerLabel } from "../lib/types";
import {
  AUX_FILE_RE,
  assignmentComplete,
  compileAssignment,
  compileSequenceParts,
  defaultConfig,
  macroFileName,
  migrateMacro,
  parseAssignment,
  parseDeviceMacro,
} from "../lib/macro-model";
import { serializeForDevice } from "../lib/recorder-model";
import { stashRecorderEdit } from "../lib/recorder-handoff";
import { undoRedoFromEvent, useHistory } from "../lib/history";
import { Button, Card, EmptyState, Spinner } from "../components/ui";
import { useToast } from "../components/toast";
import { Keypad } from "../components/Keypad";
import { AssignmentEditor } from "../components/AssignmentEditor";

export function KeysPage() {
  const { hello, drive, send, onMsg } = useDevice();
  const nav = useNav();
  const toast = useToast();
  const [cfg, setCfg] = useState<DeviceConfig | null>(null);
  const [layer, setLayer] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [assignments, setAssignments] = useState<Map<string, Assignment>>(new Map());
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

  const slotKey = (keyNo: number, layerIdx: number) => `${keyNo}:${layerIdx}`;

  // A reconnect or drive change can start a fresh reload while an old one is
  // still streaming reads — the stale one must stop touching state.
  const reloadSeq = useRef(0);

  // Load config + existing assignments from the drive. One directory listing
  // tells us which slots exist (no blind reads on empty slots), then each
  // macro streams in on its own: the keypad renders immediately and keys
  // unlock one by one instead of the page blocking on every read (issue #12).
  const reload = useCallback(async () => {
    if (!drive) return;
    const seq = ++reloadSeq.current;
    let config = defaultConfig();
    try {
      config = { ...config, ...JSON.parse(await ipc.driveRead(drive.path, "config.json")) };
    } catch {
      // no config yet — defaults are fine
    }
    if (seq !== reloadSeq.current) return;
    setCfg(config);
    const layers = config.layer_key ? config.layer_count : 1;
    const existing = new Set(await ipc.driveList(drive.path, "macros").catch(() => [] as string[]));
    if (seq !== reloadSeq.current) return;
    const slots: { k: number; l: number; file: string }[] = [];
    for (let l = 0; l < layers; l++) {
      for (let k = 1; k <= config.key_count; k++) {
        if (config.layer_key === k) continue;
        const file = macroFileName(k, l);
        if (existing.has(file.split("/").pop()!)) slots.push({ k, l, file });
      }
    }
    setAssignments(new Map());
    setPending(new Set(slots.map((s) => slotKey(s.k, s.l))));
    setLoadTotal(slots.length);
    for (const s of slots) {
      let a: Assignment | undefined;
      try {
        a = parseAssignment(parseDeviceMacro(await ipc.driveRead(drive.path, s.file)));
      } catch {
        // unreadable slot — treat as unassigned
      }
      if (seq !== reloadSeq.current) return;
      const loaded = a;
      if (loaded) setAssignments((prev) => new Map(prev).set(slotKey(s.k, s.l), loaded));
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(slotKey(s.k, s.l));
        return next;
      });
    }
  }, [drive]);

  useEffect(() => {
    void reload();
  }, [reload]);

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

  const layers = cfg.layer_key ? cfg.layer_count : 1;
  const current = selected !== null ? assignments.get(slotKey(selected, layer)) : undefined;

  async function saveDraft() {
    if (selected === null || !draft || !cfg || !drive) return;
    const file = macroFileName(selected, layer);
    const macro = compileAssignment(draft);
    setSaving(true);
    try {
      if (macro) {
        macro.screen = cfg.screen;
        await ipc.driveWrite(drive.path, file, serializeForDevice(macro, hello?.proto ?? 0));
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
      const parts = draft.kind === "sequence" ? compileSequenceParts(draft, file) : [];
      for (const p of parts) {
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
    } catch (e) {
      toast.error(
        "Could not save to the keypad",
        `${e}\n\nCheck that the keypad's USB drive is mounted and writable (unplug/replug if needed).`,
      );
      setSaving(false);
      return;
    }
    setSaving(false);
    const next = new Map(assignments);
    if (macro && draft.kind !== "none") next.set(slotKey(selected, layer), draft);
    else next.delete(slotKey(selected, layer));
    setAssignments(next);
    setDraft(null);
    if (macro) {
      toast.success(`Key ${selected} saved to the keypad`, "Press the key (or ▶ Test) to try it.");
    } else {
      toast.info(`Key ${selected} cleared`);
    }
  }

  async function testPlay(keyNo: number) {
    await send({ t: "play", file: macroFileName(keyNo, layer) });
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
          layers > 1 && (
            <div className="flex gap-1">
              {Array.from({ length: layers }, (_, i) => (
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
            </div>
          )
        }
      >
        <Keypad
          config={cfg}
          selected={selected}
          onSelect={(n) => {
            if (cfg.layer_key === n) return;
            if (pendingKeys.has(n)) return; // still streaming in — not editable yet
            setSelected(n);
            setDraft(null);
          }}
          assignments={visibleAssignments}
          loading={pendingKeys}
        />
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
            : `Key ${selected}${layers > 1 ? ` · Layer ${layerLabel(layer)}` : ""}`
        }
        actions={
          selected !== null &&
          current && (
            <div className="flex gap-1.5">
              {current.kind === "recorded" && (
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

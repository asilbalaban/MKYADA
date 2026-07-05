// Main configurator: pick a key on the visual keypad, choose what it does,
// save. Every assignment is compiled to a macro JSON on the device drive.

import { useCallback, useEffect, useState } from "react";
import { Play, SquarePen, Usb } from "lucide-react";
import { useDevice } from "../lib/device";
import { useNav } from "../lib/nav";
import { ipc } from "../lib/ipc";
import type { Assignment, DeviceConfig, MacroFile } from "../lib/types";
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
} from "../lib/macro-model";
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

  // Load config + existing assignments from the drive.
  const reload = useCallback(async () => {
    if (!drive) return;
    let config = defaultConfig();
    try {
      config = { ...config, ...JSON.parse(await ipc.driveRead(drive.path, "config.json")) };
    } catch {
      // no config yet — defaults are fine
    }
    setCfg(config);
    const found = new Map<string, Assignment>();
    const layers = config.layer_key ? config.layer_count : 1;
    for (let k = 1; k <= config.key_count; k++) {
      if (config.layer_key === k) continue;
      for (let l = 0; l < layers; l++) {
        try {
          const raw = await ipc.driveRead(drive.path, macroFileName(k, l));
          found.set(slotKey(k, l), parseAssignment(JSON.parse(raw) as MacroFile));
        } catch {
          // unassigned slot
        }
      }
    }
    setAssignments(found);
  }, [drive]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Keep the live-press highlight working while this page is open.
  useEffect(() => {
    void send({ t: "host_enter" });
    const ping = setInterval(() => void send({ t: "ping" }), 2000);
    return () => {
      clearInterval(ping);
      void send({ t: "host_leave" });
    };
  }, [send]);

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
        await ipc.driveWrite(drive.path, file, JSON.stringify(macro));
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
        await ipc.driveWrite(drive.path, p.path, JSON.stringify(p.file));
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
  for (let k = 1; k <= cfg.key_count; k++) {
    const a = assignments.get(slotKey(k, layer));
    if (a) visibleAssignments.set(k, a);
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
            setSelected(n);
            setDraft(null);
          }}
          assignments={visibleAssignments}
        />
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

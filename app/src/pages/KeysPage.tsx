// Main configurator: pick a key on the visual keypad, choose what it does,
// save. Every assignment is compiled to a macro JSON on the device drive.

import { useCallback, useEffect, useState } from "react";
import { useDevice } from "../lib/device";
import { ipc } from "../lib/ipc";
import type { Assignment, DeviceConfig, MacroFile } from "../lib/types";
import { layerLabel } from "../lib/types";
import {
  compileAssignment,
  defaultConfig,
  macroFileName,
  parseAssignment,
} from "../lib/macro-model";
import { Button, Card } from "../components/ui";
import { Keypad } from "../components/Keypad";
import { AssignmentEditor } from "../components/AssignmentEditor";

export function KeysPage() {
  const { hello, drive, send, onMsg } = useDevice();
  const [cfg, setCfg] = useState<DeviceConfig | null>(null);
  const [layer, setLayer] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [assignments, setAssignments] = useState<Map<string, Assignment>>(new Map());
  const [draft, setDraft] = useState<Assignment | null>(null);
  const [status, setStatus] = useState("");

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

  if (!hello) return <p className="text-slate-400">Connect a device first.</p>;
  if (!drive)
    return (
      <p className="text-amber-400 text-sm">
        Connected, but no CIRCUITPY drive was found — assignments can't be saved. Replug the
        board and make sure its USB drive mounts.
      </p>
    );
  if (!cfg) return <p className="text-slate-400">Loading…</p>;

  const layers = cfg.layer_key ? cfg.layer_count : 1;
  const current = selected !== null ? assignments.get(slotKey(selected, layer)) : undefined;

  async function saveDraft() {
    if (selected === null || !draft || !cfg || !drive) return;
    const file = macroFileName(selected, layer);
    const macro = compileAssignment(draft);
    if (macro) {
      macro.screen = cfg.screen;
      await ipc.driveWrite(drive.path, file, JSON.stringify(macro));
    } else {
      try {
        await ipc.driveDelete(drive.path, file);
      } catch {
        // was already unassigned
      }
    }
    const next = new Map(assignments);
    if (macro && draft.kind !== "none") next.set(slotKey(selected, layer), draft);
    else next.delete(slotKey(selected, layer));
    setAssignments(next);
    setDraft(null);
    setStatus(macro ? `Saved ${file}` : `Cleared ${file}`);
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
        <p className="text-xs text-slate-500 mt-3">
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
            <Button onClick={() => void testPlay(selected)}>▶ Test</Button>
          )
        }
      >
        {selected === null ? (
          <p className="text-slate-500 text-sm">
            Click a key on the left to configure what it does.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <AssignmentEditor
              value={draft ?? current ?? { kind: "none" }}
              onChange={setDraft}
            />
            <div className="flex justify-end gap-2">
              <Button onClick={() => setDraft(null)} disabled={!draft}>
                Revert
              </Button>
              <Button variant="primary" onClick={() => void saveDraft()} disabled={!draft}>
                Save to device
              </Button>
            </div>
          </div>
        )}
        {status && <p className="text-xs text-slate-500 mt-3">{status}</p>}
      </Card>
    </div>
  );
}

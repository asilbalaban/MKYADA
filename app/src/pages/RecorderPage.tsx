// Record keyboard + mouse globally (F8 or button), edit the result, then
// play it through the device (hardware HID), preview locally, export JSON,
// or assign it straight to a key.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { message, open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "../lib/fs";
import { ipc } from "../lib/ipc";
import { useDevice } from "../lib/device";
import type { MacroEvent, MacroFile } from "../lib/types";
import { captureScreen, thinForDevice } from "../lib/recorder-model";
import { macroFileName, migrateMacro } from "../lib/macro-model";
import { Badge, Button, Card, Field, Input, Select } from "../components/ui";
import { MacroEditor } from "../components/MacroEditor";
import { usePermissions, useRecordError } from "../components/Permissions";

export function RecorderPage() {
  const { hello, drive, send } = useDevice();
  const { status: perms } = usePermissions();
  const captureError = useRecordError();
  const canRecord = !perms || perms.platform !== "macos" || perms.input_monitoring === "granted";
  const [recording, setRecording] = useState(false);
  const [count, setCount] = useState(0);
  const [macro, setMacro] = useState<MacroFile | null>(null);
  const [status, setStatus] = useState("");
  const [startDelay, setStartDelay] = useState(3);
  const [assignKey, setAssignKey] = useState(1);
  const [assignLayer, setAssignLayer] = useState(0);
  const raw = useRef<MacroEvent[]>([]);
  const recordingRef = useRef(false);

  const stopRecording = useCallback(async () => {
    await invoke("recorder_stop");
    recordingRef.current = false;
    setRecording(false);
    const events = raw.current;
    // Drop the trailing events from reaching for the stop control (~last 500ms
    // of pure moves) — same trick the tkinter recorder used.
    while (events.length && events[events.length - 1].type === "move") events.pop();
    setMacro({
      format: "mkyada-macro",
      version: 2,
      name: "New macro",
      created: new Date().toISOString(),
      kind: "recorded",
      screen: captureScreen(),
      settings: { speed: 1, repeat: 1 },
      events,
    });
    setStatus(`Recorded ${events.length} events.`);
  }, []);

  const startRecording = useCallback(async () => {
    raw.current = [];
    setCount(0);
    setMacro(null);
    await invoke("recorder_start");
    recordingRef.current = true;
    setRecording(true);
    setStatus("Recording… press F8 to stop.");
  }, []);

  useEffect(() => {
    const un1 = listen("record:event", (e) => {
      raw.current.push(e.payload as MacroEvent);
      setCount(raw.current.length);
    });
    const un2 = listen("record:hotkey", () => {
      if (recordingRef.current) void stopRecording();
      else void startRecording();
    });
    // make sure the OS hook thread exists so F8 works before first arm
    void invoke("recorder_state");
    return () => {
      un1.then((f) => f());
      un2.then((f) => f());
      void invoke("recorder_stop");
    };
  }, [startRecording, stopRecording]);

  async function importJson() {
    const file = await open({ filters: [{ name: "Macro JSON", extensions: ["json"] }] });
    if (!file) return;
    try {
      const parsed = JSON.parse(await readTextFile(file as string)) as MacroFile;
      if (parsed.format !== "mkyada-macro" && parsed.format !== "asil-macro")
        throw new Error(`unknown format: ${parsed.format}`);
      setMacro(migrateMacro(parsed));
      setStatus(`Imported ${(file as string).split(/[\\/]/).pop()}`);
    } catch (e) {
      setStatus(`Import failed: ${e}`);
    }
  }

  async function exportJson(optimize: boolean) {
    if (!macro) return;
    const path = await save({
      defaultPath: `${(macro.name ?? "macro").replace(/[^\w-]+/g, "_")}.json`,
      filters: [{ name: "Macro JSON", extensions: ["json"] }],
    });
    if (!path) return;
    const out = optimize ? { ...macro, events: thinForDevice(macro.events) } : macro;
    await invoke("write_local_file", { path, content: JSON.stringify(out, null, 2) });
    setStatus(`Exported to ${path}`);
  }

  async function playOnDevice() {
    if (!macro || !drive) return;
    const out = { ...macro, events: thinForDevice(macro.events) };
    await ipc.driveWrite(drive.path, "live.json", JSON.stringify(out));
    setStatus(startDelay > 0 ? `Playing on device in ${startDelay}s…` : "Playing on device…");
    setTimeout(() => {
      void send({ t: "play", file: "live.json" });
    }, startDelay * 1000);
  }

  async function previewLocally() {
    if (!macro) return;
    setStatus(startDelay > 0 ? `Local preview in ${startDelay}s…` : "Previewing…");
    setTimeout(() => {
      void invoke("preview_play", {
        events: macro.events,
        speed: macro.settings?.speed ?? 1,
      });
    }, startDelay * 1000);
  }

  async function assignToKey() {
    if (!macro || !drive) return;
    const out = { ...macro, events: thinForDevice(macro.events) };
    const file = macroFileName(assignKey, assignLayer);
    try {
      await ipc.driveWrite(drive.path, file, JSON.stringify(out));
      await send({ t: "reload" });
      setStatus(`Assigned to ${file}`);
      await message(
        `Macro saved to the device ✓\n\nKey ${assignKey} → ${file} (${out.events.length} events)`,
        { title: "Assigned to key", kind: "info" },
      );
    } catch (e) {
      await message(`Could not write to the device:\n${e}`, {
        title: "Assign failed",
        kind: "error",
      });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card title="Recorder">
        <div className="flex items-center gap-3 flex-wrap">
          {recording ? (
            <Button variant="danger" onClick={() => void stopRecording()}>
              ■ Stop (F8)
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void startRecording()} disabled={!canRecord}>
              ● Record (F8)
            </Button>
          )}
          {!canRecord && (
            <Badge tone="amber">grant Input Monitoring in Settings to record</Badge>
          )}
          {recording && <Badge tone="red">REC · {count} events</Badge>}
          <Button onClick={() => void importJson()}>Import JSON…</Button>
          <Field label="Start delay (s)">
            <Input
              type="number" min="0" max="30" className="w-16"
              value={startDelay}
              onChange={(e) => setStartDelay(Math.max(0, parseInt(e.target.value) || 0))}
            />
          </Field>
          <p className="text-xs text-slate-500 max-w-sm">
            F8 starts/stops recording even while another window is focused.
            Mouse moves, clicks, scrolls and keys are captured globally.
          </p>
        </div>
        {status && <p className="text-xs text-slate-400 mt-2">{status}</p>}
        {captureError && (
          <p className="text-xs text-red-400 mt-2">⚠ {captureError}</p>
        )}
      </Card>

      {macro && (
        <>
          <MacroEditor macro={macro} onChange={setMacro} />

          <Card title="Play & save">
            <div className="flex items-center gap-2 flex-wrap">
              <Button variant="primary" onClick={() => void playOnDevice()} disabled={!drive}>
                ▶ Play on device (hardware HID)
              </Button>
              <Button onClick={() => void previewLocally()}>
                Preview locally (may not work in games)
              </Button>
              <Button onClick={() => void invoke("preview_stop").then(() => send({ t: "stop" }))}>
                ■ Stop
              </Button>
              <span className="mx-2 border-l border-line h-6" />
              <Button onClick={() => void exportJson(false)}>Export JSON…</Button>
              <Button onClick={() => void exportJson(true)}>Export optimized…</Button>
              {hello && drive && (
                <>
                  <span className="mx-2 border-l border-line h-6" />
                  <Select value={assignKey} onChange={(e) => setAssignKey(Number(e.target.value))}>
                    {Array.from({ length: hello.key_count }, (_, i) => i + 1)
                      .filter((n) => n !== hello.layer_key)
                      .map((n) => (
                        <option key={n} value={n}>Key {n}</option>
                      ))}
                  </Select>
                  {hello.layer_key && (
                    <Select value={assignLayer} onChange={(e) => setAssignLayer(Number(e.target.value))}>
                      {Array.from({ length: hello.layer_count }, (_, i) => (
                        <option key={i} value={i}>Layer {"ABCDEFGH"[i]}</option>
                      ))}
                    </Select>
                  )}
                  <Button variant="primary" onClick={() => void assignToKey()}>
                    Assign to key
                  </Button>
                </>
              )}
            </div>
            {!hello && (
              <p className="text-xs text-slate-500 mt-2">
                Connect a device to play through hardware or assign to a key.
              </p>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

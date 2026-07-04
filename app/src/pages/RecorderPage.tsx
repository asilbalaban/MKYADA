// Record keyboard + mouse globally (F8 or button), edit the result, then
// play it through the device (hardware HID), preview locally, export JSON,
// or assign it straight to a key.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Circle, FileDown, FileUp, HardDriveDownload, Play, Square } from "lucide-react";
import { readTextFile } from "../lib/fs";
import { ipc } from "../lib/ipc";
import { useDevice } from "../lib/device";
import type { MacroEvent, MacroFile } from "../lib/types";
import { captureScreen, thinForDevice } from "../lib/recorder-model";
import { macroFileName, migrateMacro } from "../lib/macro-model";
import { Badge, Button, Card, Field, Input, Select } from "../components/ui";
import { useToast } from "../components/toast";
import { MacroEditor } from "../components/MacroEditor";
import { usePermissions, useRecordError } from "../components/Permissions";

export function RecorderPage() {
  const { hello, drive, send } = useDevice();
  const { status: perms } = usePermissions();
  const toast = useToast();
  const captureError = useRecordError();
  const canRecord = !perms || perms.platform !== "macos" || perms.input_monitoring === "granted";
  const [recording, setRecording] = useState(false);
  const [count, setCount] = useState(0);
  const [countdown, setCountdown] = useState(0);
  const [macro, setMacro] = useState<MacroFile | null>(null);
  const [status, setStatus] = useState("");
  const [startDelay, setStartDelay] = useState(3);
  const [assignKey, setAssignKey] = useState(1);
  const [assignLayer, setAssignLayer] = useState(0);
  const raw = useRef<MacroEvent[]>([]);
  const recordingRef = useRef(false);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

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

  const cancelCountdown = useCallback(() => {
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    countdownTimer.current = null;
    setCountdown(0);
  }, []);

  /** Record button: honor the start delay so the user can get in position.
   *  (F8 skips it — you're already where you want to be.) */
  const armRecording = useCallback(() => {
    if (startDelay <= 0) return void startRecording();
    cancelCountdown();
    let left = startDelay;
    setCountdown(left);
    setStatus("Get ready…");
    countdownTimer.current = setInterval(() => {
      left -= 1;
      setCountdown(left);
      if (left <= 0) {
        cancelCountdown();
        void startRecording();
      }
    }, 1000);
  }, [startDelay, startRecording, cancelCountdown]);

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
      if (countdownTimer.current) clearInterval(countdownTimer.current);
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
      toast.error("Import failed", String(e));
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
    toast.success("Exported", path);
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
      toast.success(
        `Macro saved to key ${assignKey}`,
        `${out.events.length} events written to the keypad. Press the key to try it.`,
      );
    } catch (e) {
      toast.error("Could not write to the keypad", String(e));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card title="Recorder">
        <div className="flex items-end gap-3 flex-wrap">
          {recording ? (
            <Button variant="danger" onClick={() => void stopRecording()}>
              <Square size={14} aria-hidden /> Stop (F8)
            </Button>
          ) : countdown > 0 ? (
            <Button variant="danger" onClick={cancelCountdown}>
              <Square size={14} aria-hidden /> Starting in {countdown}… (cancel)
            </Button>
          ) : (
            <Button variant="primary" onClick={armRecording} disabled={!canRecord}>
              <Circle size={14} aria-hidden /> Record (F8)
            </Button>
          )}
          <Button onClick={() => void importJson()}>
            <FileUp size={14} aria-hidden /> Import JSON…
          </Button>
          <Field label="Start delay (s)">
            <Input
              type="number" min="0" max="30" className="w-16"
              value={startDelay}
              onChange={(e) => setStartDelay(Math.max(0, parseInt(e.target.value) || 0))}
            />
          </Field>
          <div className="flex items-center gap-2 pb-1">
            {!canRecord && (
              <Badge tone="amber">grant Input Monitoring in Settings to record</Badge>
            )}
            {recording && <Badge tone="red">REC · {count} events</Badge>}
          </div>
        </div>
        <p className="text-xs text-fg-faint mt-3">
          The Record button waits for the start delay so you can get in position; F8 starts and
          stops instantly, even while another window is focused. Mouse moves, clicks, scrolls
          and keys are captured globally.
        </p>
        {status && <p className="text-xs text-fg-muted mt-2">{status}</p>}
        {captureError && (
          <p className="text-xs text-danger mt-2">⚠ {captureError}</p>
        )}
      </Card>

      {macro && (
        <>
          <MacroEditor macro={macro} onChange={setMacro} />

          <div className="grid md:grid-cols-3 gap-3">
            <Card title="1 · Try it">
              <div className="flex flex-col gap-2">
                <Button variant="primary" onClick={() => void playOnDevice()} disabled={!drive}>
                  <Play size={14} aria-hidden /> Play on device (hardware HID)
                </Button>
                <Button onClick={() => void previewLocally()}>
                  Preview locally
                </Button>
                <Button onClick={() => void invoke("preview_stop").then(() => send({ t: "stop" }))}>
                  <Square size={14} aria-hidden /> Stop playback
                </Button>
                <p className="text-xs text-fg-faint">
                  Device playback is real hardware input — it works in games. Local preview may
                  not. Both wait for the start delay ({startDelay}s).
                </p>
              </div>
            </Card>

            <Card title="2 · Put it on a key">
              {hello && drive ? (
                <div className="flex flex-col gap-2">
                  <div className="flex gap-2">
                    <Field label="Key">
                      <Select value={assignKey} onChange={(e) => setAssignKey(Number(e.target.value))}>
                        {Array.from({ length: hello.key_count }, (_, i) => i + 1)
                          .filter((n) => n !== hello.layer_key)
                          .map((n) => (
                            <option key={n} value={n}>Key {n}</option>
                          ))}
                      </Select>
                    </Field>
                    {hello.layer_key && (
                      <Field label="Layer">
                        <Select value={assignLayer} onChange={(e) => setAssignLayer(Number(e.target.value))}>
                          {Array.from({ length: hello.layer_count }, (_, i) => (
                            <option key={i} value={i}>Layer {"ABCDEFGH"[i]}</option>
                          ))}
                        </Select>
                      </Field>
                    )}
                  </div>
                  <Button variant="primary" onClick={() => void assignToKey()}>
                    <HardDriveDownload size={14} aria-hidden /> Save to key {assignKey}
                  </Button>
                  <p className="text-xs text-fg-faint">
                    Writes the macro to the keypad — it then works standalone, no app needed.
                  </p>
                </div>
              ) : (
                <p className="text-sm text-fg-faint">
                  Connect your keypad to save this macro onto a key.
                </p>
              )}
            </Card>

            <Card title="3 · Share it">
              <div className="flex flex-col gap-2">
                <Button onClick={() => void exportJson(false)}>
                  <FileDown size={14} aria-hidden /> Export JSON…
                </Button>
                <Button onClick={() => void exportJson(true)}>
                  <FileDown size={14} aria-hidden /> Export optimized…
                </Button>
                <p className="text-xs text-fg-faint">
                  A macro file works on any MKYADA — drop it onto another keypad's USB drive or
                  share it with a friend.
                </p>
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

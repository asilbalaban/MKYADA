// Record keyboard + mouse globally (F8 or button), edit the result, then
// play it through the device (hardware HID), preview locally, export JSON,
// or assign it straight to a key.
//
// Photoshop-style layout: a thin top toolbar carries every action and global
// setting, the events list fills the center, and a right sidebar holds the
// properties (row editor, playback behaviour, assign-to-key, export).

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  Circle,
  Eye,
  FileDown,
  FileUp,
  HardDriveDownload,
  Package,
  Play,
  Square,
  X,
} from "lucide-react";
import { readTextFile } from "../lib/fs";
import { ipc } from "../lib/ipc";
import { useDevice } from "../lib/device";
import type { MacroEvent, MacroFile } from "../lib/types";
import { captureScreen, serializeForDevice, thinForDevice } from "../lib/recorder-model";
import { macroFileName, migrateMacro, parseAssignment } from "../lib/macro-model";
import { keysCache, slotKey } from "../lib/keys-cache";
import { useHistory } from "../lib/history";
import { takeRecorderEdit } from "../lib/recorder-handoff";
import { Badge, Input, Select } from "../components/ui";
import { ToolButton, ToolField, ToolGroup, ToolUnitInput } from "../components/toolbar";
import { isWriteCancelled, useWriteGate, writeCancelledError } from "../components/WriteProgress";
import { useToast } from "../components/toast";
import { useConfirm } from "../components/dialog";
import { MacroEditor } from "../components/MacroEditor";
import { usePermissions, useRecordError } from "../components/Permissions";

export function RecorderPage({ active = true }: { active?: boolean }) {
  const { hello, drive, send } = useDevice();
  const { status: perms } = usePermissions();
  const toast = useToast();
  const confirm = useConfirm();
  const { writeToKeypad } = useWriteGate();
  const captureError = useRecordError();
  const canRecord = !perms || perms.platform !== "macos" || perms.input_monitoring === "granted";
  const [recording, setRecording] = useState(false);
  const [count, setCount] = useState(0);
  const [countdown, setCountdown] = useState(0);
  // Edits push onto an undo stack; loading a fresh document (record/import/
  // handoff) resets it so ⌘Z can't walk back into the previous macro.
  const macroHistory = useHistory<MacroFile | null>(null);
  const macro = macroHistory.present;
  const setMacro = macroHistory.reset;
  const [status, setStatus] = useState("");
  const [startDelay, setStartDelay] = useState(3);
  // Playback-only replay counter (issue #11): ▶ Play / Preview run the macro
  // this many times back to back. Purely for testing — it never touches the
  // macro's own Repeat-per-key-press setting.
  const [playCount, setPlayCount] = useState(1);
  const [assignKey, setAssignKey] = useState(1);
  const [assignLayer, setAssignLayer] = useState(0);
  const raw = useRef<MacroEvent[]>([]);
  const recordingRef = useRef(false);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // "Edit in Recorder" from the Keys page: load that key's macro into the
  // editor as if it was just recorded, with its key preselected below. The
  // page stays mounted across tab switches, so consume the handoff whenever
  // the page becomes the active tab (not just on first mount).
  useEffect(() => {
    if (!active) return;
    const edit = takeRecorderEdit();
    if (!edit) return;
    setMacro(edit.macro);
    setAssignKey(edit.key);
    setAssignLayer(edit.layer);
    setStatus(
      `Editing the macro from key ${edit.key} — "Save to key ${edit.key}" below writes it back.`,
    );
  }, [active]);

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
    // live.json goes out with repeat overridden to the Playback Times counter
    // — a pure test-run knob. The editor macro (and the Repeat-per-key-press
    // setting saved to keys) stays exactly as the user configured it.
    const test = { ...macro, settings: { ...macro.settings, repeat: playCount } };
    try {
      // the transfer runs under the blocking modal (issue #15) — big macros
      // take a while and pressing Play twice mid-send only makes it worse
      await writeToKeypad("Test playback (live.json)", async (ctx) => {
        await ipc.driveWrite(drive.path, "live.json", serializeForDevice(test, hello?.proto ?? 0));
        if (ctx.cancelRequested()) throw writeCancelledError();
      });
    } catch (e) {
      if (isWriteCancelled(e)) {
        setStatus("Playback cancelled.");
        return;
      }
      toast.error("Could not send the macro to the keypad", String(e));
      return;
    }
    const times = playCount > 1 ? ` ×${playCount}` : "";
    setStatus(startDelay > 0 ? `Playing on device${times} in ${startDelay}s…` : `Playing on device${times}…`);
    setTimeout(() => {
      void send({ t: "play", file: "live.json" });
    }, startDelay * 1000);
  }

  async function previewLocally() {
    if (!macro) return;
    // Honor the Playback Times counter — replay the stream back to back.
    const runs = Math.max(1, playCount);
    const events =
      runs > 1 ? Array.from({ length: runs }, () => macro.events).flat() : macro.events;
    const times = runs > 1 ? ` ×${runs}` : "";
    setStatus(startDelay > 0 ? `Local preview${times} in ${startDelay}s…` : `Previewing${times}…`);
    setTimeout(() => {
      void invoke("preview_play", {
        events,
        speed: macro.settings?.speed ?? 1,
      });
    }, startDelay * 1000);
  }

  function stopPlayback() {
    void invoke("preview_stop").then(() => send({ t: "stop" }));
  }

  /** Clear the editor without saving — a fresh start for the next macro. */
  async function closeWithoutSaving() {
    const ok = await confirm({
      title: "Close without saving",
      message:
        "Discard this macro from the editor? Anything not saved to a key or exported is lost.",
      confirmLabel: "Discard",
    });
    if (!ok) return;
    setMacro(null);
    setStatus("");
  }

  async function assignToKey() {
    if (!macro || !drive) return;
    const file = macroFileName(assignKey, assignLayer);
    try {
      // Same blocking modal as the Keys page (issues #13/#15): the editor is
      // unusable while the macro streams to the keypad, and it closes only
      // once the file is fully written.
      await writeToKeypad(`Macro → key ${assignKey}`, async (ctx) => {
        await ipc.driveWrite(drive.path, file, serializeForDevice(macro, hello?.proto ?? 0));
        if (ctx.cancelRequested()) throw writeCancelledError();
        // Best-effort: a read-only drive makes the backend restart the keypad
        // (it reboots with the new file); the port is briefly down then.
        await send({ t: "reload" }).catch(() => {});
      });
      // the Keys page remembers assignments (issue #14) — keep it in sync
      keysCache.setAssignment(drive.path, slotKey(assignKey, assignLayer), parseAssignment(macro));
      setStatus(`Assigned to ${file}`);
      toast.success(
        `Macro saved to key ${assignKey}`,
        `${macro.events.length} events written to the keypad. Press the key to try it.`,
      );
    } catch (e) {
      if (isWriteCancelled(e)) {
        // a half-written macro must not stay on the key (issue #15)
        await ipc.driveDelete(drive.path, file).catch(() => {});
        keysCache.setAssignment(drive.path, slotKey(assignKey, assignLayer), null);
        setStatus(`Send cancelled — key ${assignKey} was left unassigned.`);
        toast.info("Send cancelled", `Key ${assignKey} was left without a macro.`);
        return;
      }
      toast.error("Could not write to the keypad", String(e));
    }
  }

  // The record control has three faces: idle, counting down, recording.
  const recordButton = recording ? (
    <ToolButton
      label="Stop" tone="danger" icon={<Square size={18} aria-hidden />}
      onClick={() => void stopRecording()} title="Stop recording (F8)"
    />
  ) : countdown > 0 ? (
    <ToolButton
      label={`${countdown}…`} tone="danger" icon={<Square size={18} aria-hidden />}
      onClick={cancelCountdown} title="Cancel the countdown"
    />
  ) : (
    <ToolButton
      label="Record" tone="primary" icon={<Circle size={18} aria-hidden />}
      onClick={armRecording} disabled={!canRecord} title="Record keyboard + mouse (F8)"
    />
  );

  const importButton = (
    <ToolButton
      label="Import" icon={<FileUp size={18} aria-hidden />}
      onClick={() => void importJson()} title="Import a macro JSON file"
    />
  );

  const startDelayControl = (
    <ToolField label="Delay" align="start">
      <ToolUnitInput
        suffix="s"
        type="number" min="0" max="30" className="w-14 text-center"
        value={startDelay}
        onChange={(e) => setStartDelay(Math.max(0, parseInt(e.target.value) || 0))}
        title="Countdown (seconds) before recording or playing"
      />
    </ToolField>
  );

  const recStatus = recording ? (
    <ToolField label="Rec">
      <span className="text-danger text-sm font-semibold tabular-nums">● {count}</span>
    </ToolField>
  ) : null;

  // Everything below only renders once a macro is loaded, so the shell is
  // either the editor (with page actions slotted into its toolbar/sidebar) or
  // an empty "record to begin" state.
  if (!macro) {
    return (
      <div className="h-full flex flex-col">
        <div className="tb flex items-start gap-2 px-3 py-1.5 border-b border-line bg-panel shrink-0 overflow-x-auto [&_input]:h-7 [&_input]:py-0 [&_input]:text-xs [&_select]:h-7 [&_select]:py-0 [&_select]:text-xs">
          <ToolGroup label="Capture">
            {importButton}
            {recordButton}
            {startDelayControl}
            {recStatus}
          </ToolGroup>
          {!canRecord && (
            <div className="ml-auto self-center">
              <Badge tone="amber">grant Input Monitoring in Settings to record</Badge>
            </div>
          )}
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-center gap-3 p-8">
          {recording ? (
            <>
              <div className="text-3xl font-semibold text-danger tabular-nums">● {count}</div>
              <p className="text-fg-muted">Recording events — press F8 (or Stop) when you're done.</p>
            </>
          ) : countdown > 0 ? (
            <>
              <div className="text-5xl font-semibold text-fg tabular-nums">{countdown}</div>
              <p className="text-fg-muted">Get in position…</p>
            </>
          ) : (
            <>
              <Circle size={40} className="text-fg-faint" aria-hidden />
              <p className="text-fg font-medium">Record or import a macro to begin</p>
              <p className="text-sm text-fg-muted max-w-md">
                The Record button waits for the start delay so you can get in position; F8 starts
                and stops instantly, even while another window is focused. Mouse moves, clicks,
                scrolls and keys are captured globally.
              </p>
            </>
          )}
          {status && <p className="text-xs text-fg-muted mt-2">{status}</p>}
          {captureError && <p className="text-xs text-danger mt-1">⚠ {captureError}</p>}
        </div>
      </div>
    );
  }

  return (
    <MacroEditor
      macro={macro}
      onChange={macroHistory.set}
      history={macroHistory}
      toolbarStart={
        <ToolGroup label="Capture">
          {importButton}
          {recordButton}
          {startDelayControl}
          {recStatus}
        </ToolGroup>
      }
      toolbarPlayback={
        <ToolGroup label="Playback">
          <ToolField label="Times" align="start">
            <Input
              type="number" min="1" className="w-14 text-center"
              value={playCount}
              title="Replay count for ▶ Play / Preview — the macro plays this many times back to back. Testing only: the key's own Repeat setting is untouched."
              onChange={(e) => setPlayCount(Math.max(1, parseInt(e.target.value) || 1))}
            />
          </ToolField>
          <ToolButton
            label="Play" tone="primary" icon={<Play size={18} aria-hidden />}
            onClick={() => void playOnDevice()} disabled={!drive}
            title="Play through the keypad's real hardware input (works in games)"
          />
          <ToolButton
            label="Preview" icon={<Eye size={18} aria-hidden />}
            onClick={() => void previewLocally()} title="Preview on this computer"
          />
          <ToolButton
            label="Stop" icon={<Square size={18} aria-hidden />}
            onClick={stopPlayback} title="Stop device + local playback"
          />
        </ToolGroup>
      }
      toolbarEnd={
        <>
          <ToolGroup label="Assign to key">
            {hello && drive ? (
              <>
                <ToolField label="Key" align="start">
                  <Select value={assignKey} onChange={(e) => setAssignKey(Number(e.target.value))}>
                    {Array.from({ length: hello.key_count }, (_, i) => i + 1)
                      .filter((n) => n !== hello.layer_key)
                      .map((n) => (
                        <option key={n} value={n}>Key {n}</option>
                      ))}
                  </Select>
                </ToolField>
                {hello.layer_key ? (
                  <ToolField label="Layer" align="start">
                    <Select value={assignLayer} onChange={(e) => setAssignLayer(Number(e.target.value))}>
                      {Array.from({ length: hello.layer_count }, (_, i) => (
                        <option key={i} value={i}>{"ABCDEFGH"[i]}</option>
                      ))}
                    </Select>
                  </ToolField>
                ) : null}
                <ToolButton
                  label="Save" tone="primary" icon={<HardDriveDownload size={18} aria-hidden />}
                  onClick={() => void assignToKey()} title={`Save this macro onto key ${assignKey}`}
                />
              </>
            ) : (
              <ToolButton
                label="Save" icon={<HardDriveDownload size={18} aria-hidden />}
                disabled title="Connect a keypad to save this macro onto a key"
              />
            )}
          </ToolGroup>
          <ToolGroup label="File">
            <ToolButton
              label="Export" icon={<FileDown size={18} aria-hidden />}
              onClick={() => void exportJson(false)} title="Export macro as JSON…"
            />
            <ToolButton
              label="Optimize" icon={<Package size={18} aria-hidden />}
              onClick={() => void exportJson(true)} title="Export optimized (smaller) JSON…"
            />
            <ToolButton
              label="Close" tone="danger" icon={<X size={18} aria-hidden />}
              onClick={() => void closeWithoutSaving()} title="Close without saving"
            />
          </ToolGroup>
        </>
      }
    />
  );
}

// New-board provisioning: flash CircuitPython onto a blank RP2040 board in
// bootloader mode, install the bundled MKYADA firmware, write a starter
// config, restart the board, then hand the user into the normal Setup flow.
// Resumable: a board that already runs CircuitPython but no MKYADA firmware
// (its drive mounts, but it never shows up as a keypad) can skip straight to
// the install step.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CircleCheck, Usb } from "lucide-react";
import { BootloaderDrive, ipc } from "../lib/ipc";
import type { DeviceModel, DriveInfo } from "../lib/types";
import { MODEL_META } from "../lib/types";
import { compileAssignment, defaultConfig } from "../lib/macro-model";
import { serializeForDevice } from "../lib/recorder-model";
import { useDevice } from "../lib/device";
import { Button, Spinner, Stepper } from "./ui";
import { ProductImage } from "./ProductImage";

/** The wizard writes files for firmware it has just installed itself, so it
 * can count on the bundled build: line-by-line macro streaming landed in
 * protocol 4 and every release since speaks it. */
const STREAM_PROTO = 4;

type Source =
  | { kind: "bootloader"; mount: string }
  | { kind: "circuitpy"; drive: DriveInfo };

export function ProvisionWizard({
  onDone,
  onCancel,
}: {
  /** The board is provisioned — take the user to the Setup page. */
  onDone: () => void;
  onCancel: () => void;
}) {
  const { devices, hello } = useDevice();
  const [step, setStep] = useState(0);
  const [source, setSource] = useState<Source | null>(null);
  const [cpDrives, setCpDrives] = useState<DriveInfo[]>([]);
  const [phase, setPhase] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  /** The board came back from its restart and answered as a keypad. False
   * means the restart couldn't be confirmed and the user has to replug. */
  const [rebooted, setRebooted] = useState(false);
  // provision() runs across many awaits; read the live connection through a
  // ref rather than the value captured when it started.
  const helloRef = useRef(hello);
  helloRef.current = hello;

  // Step 0: poll for a board in bootloader mode (auto-advances) and for
  // CIRCUITPY drives that don't belong to a running keypad (resume path).
  useEffect(() => {
    if (step !== 0) return;
    let cancelled = false;
    const tick = async () => {
      const [boots, drives] = await Promise.all([
        ipc.listBootloaderDrives().catch(() => [] as BootloaderDrive[]),
        ipc.listDrives().catch(() => [] as DriveInfo[]),
      ]);
      if (cancelled) return;
      const knownUids = new Set(devices.map((d) => d.hello.uid.toLowerCase()));
      if (hello) knownUids.add(hello.uid.toLowerCase());
      setCpDrives(drives.filter((d) => !knownUids.has(d.uid.toLowerCase())));
      if (boots.length > 0) {
        setSource({ kind: "bootloader", mount: boots[0].path });
        setStep(1);
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [step, devices, hello]);

  async function waitForNewDrive(before: Set<string>): Promise<DriveInfo> {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const drives = await ipc.listDrives().catch(() => [] as DriveInfo[]);
      const fresh = drives.find((d) => !before.has(d.path));
      if (fresh) return fresh;
    }
    throw new Error("No CIRCUITPY drive appeared. Unplug and replug the board, then try again.");
  }

  /** Restart the board and wait for the keypad to answer on the other side.
   *
   * Copying the firmware isn't enough on a board this fresh: boot.py is what
   * gives the keypad the serial channel the app talks over, and CircuitPython
   * only runs boot.py on a HARD reset. Until then the board sits there running
   * the USB layout stock CircuitPython booted with, and nothing the app scans
   * for is there — which is exactly the "plug it in again once and it appears"
   * that used to end this wizard. Doing the reset here removes that step.
   *
   * Returns false if the restart couldn't be confirmed; the caller then falls
   * back to telling the user to replug, which always works. */
  async function rebootAndWait(uid: string): Promise<boolean> {
    const want = uid.toLowerCase();
    try {
      await ipc.provisionReboot(uid);
    } catch {
      return false;
    }
    // Generous: the board re-enumerates, boot.py runs, then the firmware loads
    // its fonts and macros before it answers. Auto-connect may also grab the
    // port first — then it's `hello` that proves the board is back, not a scan
    // (scan_devices deliberately skips the connected port).
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      if (helloRef.current?.uid.toLowerCase() === want) return true;
      const found = await ipc.scanDevices().catch(() => []);
      if (found.some((d) => String(d.hello.uid ?? "").toLowerCase() === want)) return true;
    }
    return false;
  }

  async function provision(model: DeviceModel, src: Source) {
    setStep(2);
    setError("");
    setRebooted(false);
    try {
      let drive: DriveInfo;
      if (src.kind === "bootloader") {
        setPhase("Copying CircuitPython onto the board…");
        const before = new Set(
          (await ipc.listDrives().catch(() => [] as DriveInfo[])).map((d) => d.path),
        );
        // The RPI-RP2 drive disappears while the board reboots — expected.
        await ipc.provisionFlashUf2(src.mount);
        setPhase("Waiting for the CIRCUITPY drive — the board is rebooting (takes ~15 seconds)…");
        drive = await waitForNewDrive(before);
      } else {
        drive = src.drive;
      }
      setPhase("Installing MKYADA firmware…");
      await invoke<string[]>("firmware_update", { drive: drive.path });
      setPhase("Writing the starter config…");
      // Finished-product defaults on first install: USB drive hidden (the app
      // manages files over serial), a single layer, no layer band, profile
      // band on.
      const cfg = {
        ...defaultConfig(),
        model,
        layer_key: null,
        layer_count: 1,
        usb_drive: false,
        show_layer: false,
        show_profile: true,
      };
      await ipc.driveWrite(drive.path, "config.json", JSON.stringify(cfg, null, 2));
      // Starter macro so key 1 does something out of the box: type the
      // project's releases URL (layout-aware — compiled to the user's layout).
      const starter = compileAssignment(
        { kind: "text", text: "https://github.com/asilbalaban/MKYADA/releases/" },
        "MKYADA releases",
      );
      if (starter) {
        // Serialize it the way every other save does. Pretty-printed, this
        // macro is 10 KB with `{` alone on line 1 — the firmware reads a
        // macro's name from line 1 and only falls back to parsing the whole
        // file under 4 KB, so key 1 came up labelled "K1" on a brand-new
        // keypad. The stream format puts the header (name included) on line 1.
        await ipc.driveWrite(
          drive.path,
          "macros/key1.json",
          serializeForDevice(starter, STREAM_PROTO),
        );
      }
      setPhase("Restarting the keypad…");
      setRebooted(await rebootAndWait(drive.uid));
      setPhase("");
      setDone(true);
    } catch (e) {
      setPhase("");
      setError(String(e));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Stepper steps={["Find the board", "Pick the model", "Install"]} current={step} />

      {step === 0 && (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-fg">
            Hold the <span className="font-semibold">BOOT</span> button on the board while
            plugging it in — it shows up as an <span className="font-mono text-xs">RPI-RP2</span>{" "}
            drive and this wizard continues automatically.
          </p>
          <p className="text-fg-muted text-xs flex items-center gap-1.5">
            <Spinner size={12} /> Looking for a board in bootloader mode…
          </p>
          {cpDrives.length > 0 && (
            <div className="flex flex-col gap-2 border-t border-line pt-3">
              <p className="text-fg-muted text-xs">
                Already flashed CircuitPython? These drives aren't running MKYADA firmware yet —
                you can skip straight to installing it:
              </p>
              {cpDrives.map((d) => (
                <div key={d.path} className="flex items-center justify-between gap-3">
                  <span className="font-mono text-xs text-fg">{d.path}</span>
                  <Button
                    onClick={() => {
                      setSource({ kind: "circuitpy", drive: d });
                      setStep(1);
                    }}
                  >
                    Install firmware on this drive
                  </Button>
                </div>
              ))}
            </div>
          )}
          <div>
            <Button onClick={onCancel}>Cancel</Button>
          </div>
        </div>
      )}

      {step === 1 && source && (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-fg">Which keypad is this board going into?</p>
          <div className="grid grid-cols-2 gap-3 max-w-md">
            {(Object.keys(MODEL_META) as DeviceModel[]).map((m) => (
              <button
                key={m}
                onClick={() => void provision(m, source)}
                className="flex flex-col items-center gap-2 bg-panel2 border-2 border-line hover:border-accent/60 rounded-xl p-4 transition-colors"
              >
                <ProductImage model={m} className="w-24 h-24" />
                <span className="text-sm font-semibold text-fg">{MODEL_META[m].label}</span>
              </button>
            ))}
          </div>
          <div>
            <Button onClick={onCancel}>Cancel</Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="flex flex-col gap-3 text-sm">
          {done ? (
            <>
              <p className="text-fg flex items-center gap-2">
                {rebooted ? (
                  <>
                    <CircleCheck size={16} className="text-success" aria-hidden />
                    Done — the keypad restarted with MKYADA firmware and is connected.
                  </>
                ) : (
                  <>
                    <Usb size={16} className="text-fg-muted shrink-0" aria-hidden />
                    Firmware installed. The keypad didn't come back on its own — unplug it and
                    plug it in again, and it connects within a few seconds.
                  </>
                )}
              </p>
              <div className="flex gap-2">
                <Button variant="primary" onClick={onDone}>
                  Continue to Setup
                </Button>
              </div>
            </>
          ) : error ? (
            <>
              <p className="text-danger text-xs whitespace-pre-wrap">{error}</p>
              <div className="flex gap-2">
                <Button variant="primary" onClick={() => setStep(0)}>
                  Try again
                </Button>
                <Button onClick={onCancel}>Cancel</Button>
              </div>
            </>
          ) : (
            <p className="text-fg-muted flex items-center gap-2">
              <Spinner size={14} /> {phase || "Working…"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// New-board provisioning: flash CircuitPython onto a blank RP2040 board in
// bootloader mode, install the bundled MKYADA firmware, write a starter
// config, then hand the user into the normal Setup flow. Resumable: a board
// that already runs CircuitPython but no MKYADA firmware (its drive mounts,
// but it never shows up as a keypad) can skip straight to the install step.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CircleCheck } from "lucide-react";
import { BootloaderDrive, ipc } from "../lib/ipc";
import type { DeviceModel, DriveInfo } from "../lib/types";
import { MODEL_META } from "../lib/types";
import { defaultConfig } from "../lib/macro-model";
import { useDevice } from "../lib/device";
import { Button, Spinner, Stepper } from "./ui";
import { ProductImage } from "./ProductImage";

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

  async function provision(model: DeviceModel, src: Source) {
    setStep(2);
    setError("");
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
      const cfg = { ...defaultConfig(), model, layer_key: null, usb_drive: true };
      await ipc.driveWrite(drive.path, "config.json", JSON.stringify(cfg, null, 2));
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
                <CircleCheck size={16} className="text-success" aria-hidden />
                Done — the board restarts with MKYADA firmware and connects by itself in a few
                seconds.
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

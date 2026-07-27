// Recovery wizard: takes a keypad whose firmware refuses to start and walks
// the owner back to a working board without a terminal, a BOOT button, or an
// open case.
//
// Why a wizard instead of the old one-shot "Repair firmware" button: a repair
// that only writes files can leave the board holding a MIX of versions (a new
// app.mpy importing a name its stale models.py never defined), and pressing
// the same button again reproduces the same mix. The user saw a success toast
// and a dead keypad, with nothing to tell them which was true. So: look at
// what's actually on the board, say it in plain words, fix it, then PROVE the
// board came back — and if it didn't, show what's still wrong.

import { useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import type { FirmwareDiagnosis } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useDevice } from "../lib/device";
import type { DeviceModel } from "../lib/types";
import { MODEL_META } from "../lib/types";
import { Button, Spinner, Stepper } from "./ui";
import { ProductImage } from "./ProductImage";

/** How long to wait for the board to re-enumerate and answer after the reset.
 *  A CircuitPython reboot is ~5s; USB re-enumeration plus the app's scan loop
 *  put the worst observed case around 20s, so this is generous on purpose —
 *  timing out early would report a healthy repair as a failure. */
const VERIFY_TIMEOUT_MS = 90_000;

type Outcome = "repaired" | "still-rescue" | "no-answer";

export function RecoveryWizard({ onClose }: { onClose: () => void }) {
  const { hello, drive, send, disconnect, setUpdating } = useDevice();
  const [step, setStep] = useState(0);
  const [diag, setDiag] = useState<FirmwareDiagnosis | null>(null);
  const [model, setModel] = useState<DeviceModel | null>(null);
  const [phase, setPhase] = useState("");
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [details, setDetails] = useState(false);
  // The board's identity as it was BEFORE the repair: the reset drops the
  // connection, so neither is readable while we wait for it to come back.
  const target = useRef<{ drive: string; uid: string } | null>(null);

  // Step 0 runs itself — the first thing the user should see is what's wrong,
  // not another button to press.
  useEffect(() => {
    if (step !== 0 || diag || !drive) return;
    let cancelled = false;
    setError("");
    ipc
      .firmwareDiagnose(drive.path)
      .then((d) => {
        if (cancelled) return;
        setDiag(d);
        // A board that already knows what it is doesn't need to be asked.
        if (d.model === "core6" || d.model === "vision6") setModel(d.model);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [step, diag, drive]);

  async function repair(picked: DeviceModel) {
    if (!drive || !hello) return;
    target.current = { drive: drive.path, uid: hello.uid };
    setModel(picked);
    setStep(2);
    setError("");
    setUpdating(true);
    try {
      setPhase("Rewriting the firmware files…");
      await ipc.firmwareRepair(drive.path, picked);
      setPhase("Restarting the keypad…");
      // Unmount before the reset so the drive doesn't come back read-only,
      // then take the board out of update mode (v7) / reset it (older).
      await ipc.driveEject(drive.path).catch(() => {});
      await send({ t: "update_end" }).catch(() => {});
      await send({ t: "reset" }).catch(() => {});
      // Drop the dying connection so auto-connect can reattach cleanly.
      await disconnect().catch(() => {});
      setPhase("");
      setStep(3);
    } catch (e) {
      setPhase("");
      setError(String(e));
    } finally {
      setUpdating(false);
    }
  }

  // Step 3: the actual proof. The board reconnects on its own; what its
  // `hello` says decides whether this repair worked.
  useEffect(() => {
    if (step !== 3 || outcome) return;
    if (hello && (!target.current || hello.uid === target.current.uid)) {
      setOutcome(hello.mode === "rescue" ? "still-rescue" : "repaired");
      return;
    }
    const t = setTimeout(() => setOutcome("no-answer"), VERIFY_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [step, hello, outcome]);

  // A repair that didn't take: re-read the board so the user sees what
  // survived rather than the pre-repair picture.
  useEffect(() => {
    if (outcome !== "still-rescue" || !drive) return;
    ipc.firmwareDiagnose(drive.path).then(setDiag).catch(() => {});
  }, [outcome, drive]);

  function restart() {
    setDiag(null);
    setOutcome(null);
    setError("");
    setStep(0);
  }

  const problems = diag ? diag.missing.length + diag.stale.length + diag.extra.length : 0;

  return (
    <div className="flex flex-col gap-4">
      <Stepper steps={["Check", "Model", "Repair", "Verify"]} current={step} />

      {step === 0 && (
        <div className="flex flex-col gap-3 text-sm">
          {error ? (
            <>
              <p className="text-danger text-xs whitespace-pre-wrap">{error}</p>
              <div className="flex gap-2">
                <Button variant="primary" onClick={restart}>
                  Try again
                </Button>
                <Button onClick={onClose}>Close</Button>
              </div>
            </>
          ) : !drive ? (
            <p className="text-fg-muted flex items-center gap-2">
              <Spinner size={14} /> Waiting for the keypad to connect…
            </p>
          ) : !diag ? (
            <p className="text-fg-muted flex items-center gap-2">
              <Spinner size={14} /> Reading what&apos;s on the keypad…
            </p>
          ) : (
            <>
              {problems === 0 ? (
                <p className="text-fg flex items-start gap-2">
                  <CircleCheck size={16} className="text-success shrink-0 mt-0.5" aria-hidden />
                  Every firmware file matches this app&apos;s v{diag.bundle_version}. The problem is
                  something else — repairing anyway is safe and rewrites all of them.
                </p>
              ) : (
                <div className="flex items-start gap-2">
                  <TriangleAlert size={16} className="text-warning shrink-0 mt-0.5" aria-hidden />
                  <div className="flex flex-col gap-1">
                    <p className="text-fg">
                      The firmware on this keypad is a mix of versions — that&apos;s why it
                      won&apos;t start.
                    </p>
                    <ul className="text-fg-muted text-xs list-disc pl-4">
                      {diag.stale.length > 0 && (
                        <li>
                          {diag.stale.length} files are from an older version — they get replaced
                        </li>
                      )}
                      {diag.missing.length > 0 && (
                        <li>{diag.missing.length} files are missing — they get installed</li>
                      )}
                      {diag.extra.length > 0 && (
                        <li>
                          {diag.extra.length} leftover files aren&apos;t part of this firmware —
                          they get deleted
                        </li>
                      )}
                      <li>{diag.matching} files are already correct</li>
                    </ul>
                  </div>
                </div>
              )}
              <p className="text-fg-muted text-xs">
                Repairing installs v{diag.bundle_version} completely: it rewrites every firmware
                file and removes the leftovers.{" "}
                <span className="text-fg">Your macros, profiles and settings stay untouched.</span>
              </p>
              <button
                className="text-xs text-fg-faint hover:text-fg text-left w-fit underline underline-offset-2"
                onClick={() => setDetails(!details)}
              >
                {details ? "Hide file list" : "Show file list"}
              </button>
              {details && <FileList diag={diag} />}
              <div className="flex gap-2">
                <Button variant="primary" onClick={() => setStep(1)}>
                  Continue
                </Button>
                <Button onClick={onClose}>Cancel</Button>
              </div>
            </>
          )}
        </div>
      )}

      {step === 1 && (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-fg">Which keypad is this?</p>
          <p className="text-fg-muted text-xs">
            In rescue mode the keypad can&apos;t tell the app what it is, so the app has to be
            told. Picking the wrong one leaves the screen blank or the keys on the wrong pins —
            you can come back and change it.
          </p>
          <div className="grid grid-cols-2 gap-3 max-w-md">
            {(Object.keys(MODEL_META) as DeviceModel[]).map((m) => (
              <button
                key={m}
                onClick={() => void repair(m)}
                className={`flex flex-col items-center gap-2 bg-panel2 border-2 rounded-xl p-4 transition-colors ${
                  model === m ? "border-accent" : "border-line hover:border-accent/60"
                }`}
              >
                <ProductImage model={m} className="w-24 h-24" />
                <span className="text-sm font-semibold text-fg">{MODEL_META[m].label}</span>
                {model === m && diag?.model === m && (
                  <span className="text-[11px] text-fg-faint">saved on the keypad</span>
                )}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <Button onClick={() => setStep(0)}>Back</Button>
            <Button onClick={onClose}>Cancel</Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="flex flex-col gap-3 text-sm">
          {error ? (
            <>
              <p className="text-fg flex items-start gap-2">
                <CircleAlert size={16} className="text-danger shrink-0 mt-0.5" aria-hidden />
                The repair stopped before it finished. The keypad still has its rescue console, so
                nothing is lost — try again.
              </p>
              <p className="text-danger text-xs whitespace-pre-wrap font-mono">{error}</p>
              <div className="flex gap-2">
                <Button variant="primary" onClick={restart}>
                  Try again
                </Button>
                <Button onClick={onClose}>Close</Button>
              </div>
            </>
          ) : (
            <p className="text-fg-muted flex items-center gap-2">
              <Spinner size={14} /> {phase || "Working…"}
            </p>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="flex flex-col gap-3 text-sm">
          {!outcome ? (
            <p className="text-fg-muted flex items-center gap-2">
              <Spinner size={14} /> Waiting for the keypad to restart and report back…
            </p>
          ) : outcome === "repaired" ? (
            <>
              <p className="text-fg flex items-start gap-2">
                <CircleCheck size={16} className="text-success shrink-0 mt-0.5" aria-hidden />
                Repaired — the keypad started its firmware and reconnected on its own.
              </p>
              <div>
                <Button variant="primary" onClick={onClose}>
                  Done
                </Button>
              </div>
            </>
          ) : outcome === "still-rescue" ? (
            <>
              <p className="text-fg flex items-start gap-2">
                <CircleAlert size={16} className="text-danger shrink-0 mt-0.5" aria-hidden />
                The files landed, but the firmware still won&apos;t start — so the fault isn&apos;t
                the mixed-up files this repair fixed.
              </p>
              {hello?.err && (
                <p className="text-xs text-fg-faint font-mono break-all">{hello.err}</p>
              )}
              {diag && <FileList diag={diag} />}
              <div className="flex gap-2">
                <Button variant="primary" onClick={restart}>
                  Run it again
                </Button>
                <Button onClick={onClose}>Close</Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-fg flex items-start gap-2">
                <TriangleAlert size={16} className="text-warning shrink-0 mt-0.5" aria-hidden />
                The files landed, but the keypad hasn&apos;t reconnected. Unplug it, plug it back
                in, and give it a few seconds.
              </p>
              <div className="flex gap-2">
                <Button variant="primary" onClick={restart}>
                  Check again
                </Button>
                <Button onClick={onClose}>Close</Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function FileList({ diag }: { diag: FirmwareDiagnosis }) {
  // Labelled by what the repair DOES to each file, not by what's wrong with
  // it: read as a diagnosis ("doesn't belong"), the leftover list looks like
  // a list of things about to be installed — the opposite of the truth.
  const rows: [string, string[]][] = [
    ["Will be replaced — older version", diag.stale],
    ["Will be installed — missing", diag.missing],
    ["Will be deleted — not part of this firmware", diag.extra],
  ];
  return (
    <div className="flex flex-col gap-2 bg-panel2 border border-line rounded-lg p-3 max-h-56 overflow-auto">
      <p className="text-[11px] text-fg-faint">
        Keypad v{diag.device_version ?? "?"} · app v{diag.bundle_version} · model{" "}
        {diag.model ?? "not set"}
      </p>
      {rows
        .filter(([, list]) => list.length > 0)
        .map(([label, list]) => (
          <div key={label} className="flex flex-col gap-0.5">
            <span className="text-[11px] uppercase tracking-wide text-fg-faint">{label}</span>
            {list.map((f) => (
              <span key={f} className="font-mono text-[11px] text-fg-muted">
                {f}
              </span>
            ))}
          </div>
        ))}
    </div>
  );
}

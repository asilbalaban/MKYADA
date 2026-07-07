// "Writing to the keypad" feedback (issues #10, #15).
//
// Macro saves wrap themselves in useWriteGate().writeToKeypad(): a centered
// modal takes over the screen for the WHOLE operation — transfer, verify
// read, sequence part files — so 100% genuinely means "written". The modal
// blocks the app underneath and offers Cancel: the Rust side aborts between
// chunks and the caller removes the half-written file (the key ends up
// unassigned).
//
// Transfers that start outside a gated save (▶ Play's live.json before the
// gate mounts, firmware update) still get the small bottom-right card.

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { HardDriveDownload } from "lucide-react";
import { ipc, onWriteProgress, WriteProgress } from "../lib/ipc";
import { Button } from "./ui";

/** Error marker the Rust side rejects a cancelled write with. */
const CANCELLED_MARKER = "write cancelled";

export function isWriteCancelled(e: unknown): boolean {
  return String(e).includes(CANCELLED_MARKER);
}

/** Throwable from inside writeToKeypad() when ctx.cancelRequested() is set
 * but the transfer itself raced to completion. */
export function writeCancelledError(): Error {
  return new Error(CANCELLED_MARKER);
}

export interface WriteGateCtx {
  /** True once the user hit Cancel — check between steps and bail. */
  cancelRequested: () => boolean;
}

interface WriteGate {
  /** Run a keypad write under the blocking modal. `label` tells the user
   * what is being sent. Rejects with the cancelled marker on user cancel. */
  writeToKeypad<T>(label: string, fn: (ctx: WriteGateCtx) => Promise<T>): Promise<T>;
}

const Ctx = createContext<WriteGate | null>(null);

export function useWriteGate(): WriteGate {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWriteGate outside WriteGateProvider");
  return ctx;
}

export function WriteGateProvider({ children }: { children: ReactNode }) {
  const [task, setTask] = useState<string | null>(null);
  const [progress, setProgress] = useState<WriteProgress | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const cancelled = useRef(false);
  const taskRef = useRef(false);

  useEffect(() => {
    const un = onWriteProgress((e) => {
      if (taskRef.current) setProgress(e);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  const writeToKeypad = useCallback(
    async <T,>(label: string, fn: (ctx: WriteGateCtx) => Promise<T>): Promise<T> => {
      cancelled.current = false;
      setCancelling(false);
      setProgress(null);
      setTask(label);
      taskRef.current = true;
      try {
        const result = await fn({ cancelRequested: () => cancelled.current });
        if (cancelled.current) throw writeCancelledError();
        return result;
      } finally {
        taskRef.current = false;
        setTask(null);
      }
    },
    [],
  );

  const cancel = () => {
    cancelled.current = true;
    setCancelling(true);
    void ipc.driveWriteCancel().catch(() => {});
  };

  const pct =
    progress && progress.total ? Math.round((progress.written / progress.total) * 100) : null;
  // The bar can sit at 100% while the verify read / part files still run —
  // keep the modal (and the promise) honest: it only closes when done.
  const finishing = pct === 100;

  return (
    <Ctx.Provider value={{ writeToKeypad }}>
      {children}
      {task !== null && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-label="Writing to the keypad"
          className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center"
        >
          <div className="w-[26rem] max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-panel shadow-2xl p-5 flex flex-col gap-4">
            <div className="flex items-start gap-3">
              <HardDriveDownload size={22} className="text-accent shrink-0 mt-0.5" aria-hidden />
              <div className="flex-1 min-w-0">
                <p className="text-fg font-medium text-sm">Sending to the keypad…</p>
                <p className="text-xs text-fg-muted truncate">
                  {task}
                  {progress ? ` · ${progress.file.split("/").pop()}` : ""}
                </p>
              </div>
              <span className="text-sm text-fg-muted tabular-nums shrink-0">
                {pct !== null ? `${pct}%` : ""}
              </span>
            </div>
            <div className="h-2 rounded-full bg-panel2 overflow-hidden">
              {pct !== null ? (
                <div
                  className={`h-full bg-accent transition-[width] duration-200 ${finishing ? "animate-pulse" : ""}`}
                  style={{ width: `${pct}%` }}
                />
              ) : (
                <div className="h-full w-1/3 bg-accent/60 animate-pulse" />
              )}
            </div>
            <p className="text-xs text-fg-faint">
              {finishing
                ? "Verifying the write on the keypad…"
                : "Keep the keypad plugged in. This closes only once the macro is fully written."}
            </p>
            <div className="flex justify-end">
              <Button onClick={cancel} disabled={cancelling}>
                {cancelling ? "Cancelling…" : "Cancel"}
              </Button>
            </div>
          </div>
        </div>
      )}
      <WriteProgressCard suppressed={task !== null} />
    </Ctx.Provider>
  );
}

/** Writes of a chunk or so finish instantly — flashing a card for a
 * config.json save is noise, so only multi-chunk transfers show one. */
const MIN_BYTES = 4096;

/** Fallback bottom-right card for transfers that run outside the modal
 * (firmware update, ▶ Play's live.json). */
function WriteProgressCard({ suppressed }: { suppressed: boolean }) {
  const [p, setP] = useState<WriteProgress | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const un = onWriteProgress((e) => {
      if (e.total < MIN_BYTES) return;
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setP(e);
      // Completed → let 100% be seen for a beat, then hide. A failed transfer
      // just stops emitting, so a lingering card times out on its own.
      hideTimer.current = setTimeout(() => setP(null), e.written >= e.total ? 700 : 12000);
    });
    return () => {
      un.then((f) => f());
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  if (!p || suppressed) return null;
  const pct = p.total ? Math.round((p.written / p.total) * 100) : 100;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 w-72 rounded-lg border border-line bg-panel shadow-lg p-3 flex flex-col gap-2"
    >
      <div className="flex items-center gap-2 text-sm text-fg">
        <HardDriveDownload size={15} className="text-accent shrink-0" aria-hidden />
        <span className="flex-1 truncate">
          Writing {p.file.split("/").pop()} to the keypad…
        </span>
        <span className="text-fg-muted tabular-nums">{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-panel2 overflow-hidden">
        <div
          className="h-full bg-accent transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

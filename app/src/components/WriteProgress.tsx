// Floating "writing to the keypad" progress card (issue #10). Large macros
// take seconds to stream over serial; the Rust side emits drive:progress per
// acknowledged chunk and this card shows the transfer no matter where it
// started (Keys save, Recorder assign, ▶ Play's live.json, firmware update).

import { useEffect, useRef, useState } from "react";
import { HardDriveDownload } from "lucide-react";
import { onWriteProgress, WriteProgress } from "../lib/ipc";

/** Writes of a chunk or so finish instantly — flashing a card for a
 * config.json save is noise, so only multi-chunk transfers show one. */
const MIN_BYTES = 4096;

export function WriteProgressCard() {
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

  if (!p) return null;
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

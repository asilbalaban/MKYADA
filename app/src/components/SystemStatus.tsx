// Live feedback widgets: the system status strip (CPU / RAM / mic) and the
// headless LedFeedback rule that mirrors mic mute onto the keypad LED.

import { useEffect, useRef } from "react";
import { Cpu, MemoryStick, Mic, MicOff } from "lucide-react";
import { useDevice } from "../lib/device";
import { useLedMicFeedback } from "../lib/settings";
import { useSystemVars } from "../lib/variables";

/** Compact CPU / RAM / mic readout, refreshed every 2 s from the Rust side. */
export function SystemStatusStrip() {
  const vars = useSystemVars();
  if (!vars) return null;
  const gb = (b: number) => (b / 1024 ** 3).toFixed(1);
  return (
    <div className="flex items-center gap-4 text-xs text-fg-muted">
      <span className="inline-flex items-center gap-1.5">
        <Cpu size={13} aria-hidden /> CPU {Math.round(vars.cpu)}%
      </span>
      <span className="inline-flex items-center gap-1.5">
        <MemoryStick size={13} aria-hidden /> RAM {gb(vars.mem_used)} / {gb(vars.mem_total)} GB
      </span>
      {vars.mic_muted !== null && (
        <span
          className={`inline-flex items-center gap-1.5 ${vars.mic_muted ? "text-danger" : ""}`}
        >
          {vars.mic_muted ? <MicOff size={13} aria-hidden /> : <Mic size={13} aria-hidden />}
          mic {vars.mic_muted ? "muted" : "live"}
        </span>
      )}
    </div>
  );
}

/** Headless rule: while enabled in Settings, a muted microphone turns the
 * keypad LED solid red (serial "led" override; the firmware clears it when
 * the app disconnects, so standalone behavior is untouched). */
export function LedFeedback() {
  const { port, send } = useDevice();
  const vars = useSystemVars();
  const enabled = useLedMicFeedback();
  const lastSent = useRef("");

  useEffect(() => {
    if (!port) {
      lastSent.current = "";
      return;
    }
    const want = enabled && vars?.mic_muted ? "on" : "off";
    if (want === lastSent.current) return;
    lastSent.current = want;
    void send(
      want === "on"
        ? { t: "led", mode: "solid", rgb: [255, 0, 0] }
        : { t: "led", mode: "off" },
    ).catch(() => {
      lastSent.current = ""; // retry on the next change
    });
  }, [port, enabled, vars?.mic_muted, send]);

  return null;
}

// Settings card for the system-wide "stop playback" hotkey (remote.rs).
// Shows the combo in force, records a new one, resets to the default and
// reports when the OS refused to register it.

import { useEffect, useState } from "react";
import { Keyboard, RotateCcw } from "lucide-react";
import { Alert, Button, Card, SettingRow } from "./ui";
import { accelFromEvent, accelParts } from "../lib/playback";
import { isMacPlatform, setStopHotkey, useStopHotkey } from "../lib/stop-hotkey";

function Keys({ accel }: { accel: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {accelParts(accel, isMacPlatform()).map((p, i) => (
        <kbd
          key={i}
          className="rounded-badge border border-line-strong bg-raised px-1.5 py-0.5 font-sans text-label font-medium text-fg"
        >
          {p}
        </kbd>
      ))}
    </span>
  );
}

export function RemoteControlCard() {
  const status = useStopHotkey();
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = (accel: string) => {
    setSaving(true);
    setError(null);
    setStopHotkey(accel)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(false));
  };

  // Record: the next key combo with at least one modifier becomes the hotkey.
  // Capture phase + preventDefault so the combo doesn't also act on the page.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        setRecording(false);
        setHint(null);
        return;
      }
      const accel = accelFromEvent(e);
      if (!accel) return; // only modifiers so far
      if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        setHint("Hold Ctrl, Alt or Shift with the key");
        return;
      }
      setRecording(false);
      setHint(null);
      save(accel);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  const accel = status?.accel ?? "";
  const isDefault = !!status && accel === status.default;
  const usesSuper = /(^|\+)(super|cmd|command|win)(\+|$)/i.test(accel);

  const current = recording ? (
    <span className="text-fg-muted" aria-live="polite">
      {hint ?? "Press the new shortcut… (Esc to cancel)"}
    </span>
  ) : !status ? (
    "Unavailable"
  ) : accel ? (
    <Keys accel={accel} />
  ) : (
    "Off"
  );

  return (
    <Card
      title="Remote control"
      description="Stop a running macro from anywhere, even over remote desktop or with MKYADA in the tray."
    >
      <div className="flex flex-col gap-3">
        <SettingRow
          icon={Keyboard}
          title="Stop hotkey"
          description={<span className="mt-1 inline-flex">{current}</span>}
          control={
            recording ? (
              <Button variant="ghost" onClick={() => setRecording(false)}>
                Cancel
              </Button>
            ) : (
              <>
                {status && !isDefault && (
                  <Button
                    variant="ghost"
                    disabled={saving}
                    onClick={() => save(status.default)}
                    title={`Reset to ${status.default}`}
                  >
                    <RotateCcw size={14} aria-hidden />
                    Reset
                  </Button>
                )}
                <Button
                  disabled={!status}
                  loading={saving}
                  onClick={() => {
                    setError(null);
                    setRecording(true);
                  }}
                >
                  Change
                </Button>
              </>
            )
          }
        />
        {(error || status?.error) && (
          <Alert tone="danger" role="alert">
            {error ??
              `Couldn't turn on ${accel}: ${status?.error}. Another app may be using it, so try a different shortcut.`}
          </Alert>
        )}
        {usesSuper && !recording && (
          <p className="text-label text-fg-faint">
            Remote desktop apps usually keep {isMacPlatform() ? "Cmd" : "Win"} shortcuts for your
            own computer. Ctrl, Alt and Shift pass through.
          </p>
        )}
      </div>
    </Card>
  );
}

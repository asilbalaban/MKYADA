// Playback strip for the top of the main area: what the keypad is playing,
// a prominent Stop, and — after a stop — "Run again". Built for people who
// reach the computer over remote desktop and can't press the keypad itself.
// Renders nothing when idle.

import { useEffect, useState } from "react";
import { CircleStop, MonitorUp, Play, Repeat, Square, X } from "lucide-react";
import { Button, IconButton } from "./ui";
import { useDevice } from "../lib/device";
import { usePlayback } from "../lib/playback-context";
import { accelParts } from "../lib/playback";
import { isMacPlatform, useStopHotkey } from "../lib/stop-hotkey";

/** Short plays (a wheel detent, a one-shot key) finish before the bar would
 * be readable — only show a play that lasts, or any loop, at once. */
const SHOW_AFTER_MS = 700;

function layerLabel(letter: string | null, names?: (string | null)[] | null): string | null {
  if (!letter) return null;
  const i = letter.charCodeAt(0) - 97;
  const nick = names?.[i];
  return nick ? nick : `Layer ${letter.toUpperCase()}`;
}

const VIA_TEXT: Record<string, string> = {
  hotkey: "with the hotkey",
  tray: "from the tray",
  app: "from the app",
};

/** Stopped by crd_watch.rs: someone just connected over remote desktop. */
const VIA_REMOTE_DESKTOP = "remote-desktop";

export function PlaybackBar({ className = "" }: { className?: string }) {
  const { hello } = useDevice();
  const {
    playing,
    lastStopped,
    dismissStopped,
    canStop,
    canPress,
    remoteHold,
    cancelResume,
    pressDisabledReason,
    stopPlayback,
    pressKey,
  } = usePlayback();
  const hotkey = useStopHotkey();
  const [, setTick] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // re-render once the short-play grace period has passed
  const startedAt = playing?.startedAt;
  useEffect(() => {
    if (startedAt === undefined) return;
    const left = startedAt + SHOW_AFTER_MS - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => setTick((n) => n + 1), left);
    return () => clearTimeout(t);
  }, [startedAt]);

  // a fresh play/stop clears stale button state and errors
  useEffect(() => {
    setStopping(false);
    setError(null);
  }, [startedAt, lastStopped?.at]);

  const names = hello?.layer_names;
  const showPlaying =
    playing && (playing.loop || Date.now() - playing.startedAt >= SHOW_AFTER_MS);

  // A rounded strip in the page's banner stack (same rhythm as the Alerts).
  const base =
    "flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 rounded-card py-2.5 pl-4 pr-2.5 text-sm " +
    className;

  // A remote desktop session is open: nothing plays until it ends (Rust
  // stops every start), so this replaces both the playing and stopped strips.
  if (remoteHold) {
    const k = remoteHold.resumeKey;
    return (
      <div
        role="status"
        aria-live="polite"
        className={`${base} border border-warning-line bg-warning-bg`}
      >
        <MonitorUp size={16} aria-hidden className="shrink-0 text-warning" />
        <span className="flex min-w-0 flex-1 flex-col text-fg">
          <span className="font-semibold">Remote desktop connected · macros are paused</span>
          <span className="text-fg-muted">
            {k !== null
              ? `Key ${k} was stopped so you can use this computer. It starts again when the remote session ends.`
              : "Keys won't play macros while someone is connected, so the computer stays usable."}
          </span>
        </span>
        {(playing || k !== null) && (
          <Button
            variant="danger-solid"
            disabled={!!playing && !canStop}
            title={k !== null ? `Key ${k} won't start again when the session ends` : undefined}
            onClick={() => void (playing ? stopPlayback() : cancelResume())}
          >
            <Square size={14} aria-hidden fill="currentColor" />
            Stop
          </Button>
        )}
      </div>
    );
  }

  if (showPlaying) {
    const layer = layerLabel(playing.layer, names);
    const what = playing.key !== null ? `Key ${playing.key}` : "A macro";
    const hint =
      hotkey?.registered && hotkey.accel ? accelParts(hotkey.accel, isMacPlatform()) : null;
    // Charcoal "now playing" strip: the one thing on screen that is live and
    // acting on the computer, so it is the loudest surface in the app.
    return (
      <div role="status" aria-live="polite" className={`${base} bg-inverse text-inverse-fg`}>
        <span className="relative flex size-2.5 shrink-0" aria-hidden>
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-danger-on-dark opacity-60" />
          <span className="relative inline-flex size-2.5 rounded-full bg-danger-on-dark" />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
          <span className="font-semibold">{what}</span>
          {layer && <span className="text-inverse-muted">· {layer}</span>}
          <span className="inline-flex items-center gap-1 text-inverse-muted">
            ·{" "}
            {playing.loop ? (
              <>
                <Repeat size={14} aria-hidden /> Looping
              </>
            ) : (
              "Playing"
            )}
          </span>
        </span>
        {hint && (
          <span className="hidden items-center gap-1 text-label text-inverse-muted sm:inline-flex">
            {hint.map((p, i) => (
              <kbd
                key={i}
                className="rounded-badge border border-inverse-line px-1.5 py-0.5 font-sans text-[11px] text-inverse-fg"
              >
                {p}
              </kbd>
            ))}
            <span className="ml-1">also stops it</span>
          </span>
        )}
        {error && <span className="text-label text-danger-on-dark">{error}</span>}
        <Button
          variant="danger-solid"
          disabled={!canStop}
          loading={stopping}
          onClick={() => {
            setStopping(true);
            setError(null);
            stopPlayback().catch((e) => {
              setStopping(false);
              setError(e instanceof Error ? e.message : String(e));
            });
          }}
        >
          <Square size={14} aria-hidden fill="currentColor" />
          Stop
        </Button>
      </div>
    );
  }

  if (lastStopped) {
    const byRemote = lastStopped.via === VIA_REMOTE_DESKTOP;
    const via = lastStopped.via ? VIA_TEXT[lastStopped.via] : null;
    return (
      <div
        role="status"
        aria-live="polite"
        className={`${base} ${byRemote ? "border border-warning-line bg-warning-bg" : "bg-panel"}`}
      >
        {byRemote ? (
          <MonitorUp size={16} aria-hidden className="shrink-0 text-warning" />
        ) : (
          <CircleStop size={16} aria-hidden className="shrink-0 text-fg-faint" />
        )}
        {byRemote ? (
          <span className="flex min-w-0 flex-1 flex-col text-fg">
            <span className="font-semibold">Stopped key {lastStopped.key}</span>
            <span className="text-fg-muted">
              Stopped because a remote desktop was connected to this computer.
            </span>
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-fg">
            Stopped key {lastStopped.key}
            {via && <span className="text-fg-muted"> {via}</span>}
          </span>
        )}
        {error && <span className="text-label text-danger">{error}</span>}
        {!canPress && pressDisabledReason && (
          <span className="text-label text-fg-faint">{pressDisabledReason}</span>
        )}
        <Button
          variant="primary"
          disabled={!canPress}
          loading={running}
          title={pressDisabledReason ?? `Press key ${lastStopped.key} again`}
          onClick={() => {
            setRunning(true);
            setError(null);
            pressKey(lastStopped.key, { layer: lastStopped.layer })
              .catch((e) => setError(e instanceof Error ? e.message : String(e)))
              .finally(() => setRunning(false));
          }}
        >
          <Play size={14} aria-hidden />
          Run again
        </Button>
        <IconButton label="Dismiss" onClick={dismissStopped}>
          <X size={16} aria-hidden />
        </IconButton>
      </div>
    );
  }

  return null;
}

// macOS permission guidance: unambiguous red/green status, visible re-check
// feedback, and recovery steps for the stale-grant trap (unsigned apps get a
// new code signature on every update, so a grant given to an older version
// no longer applies even though System Settings still shows the toggle on).

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { RefreshCw } from "lucide-react";
import { Badge, Button, Card } from "./ui";

type PermState = "granted" | "denied" | "unknown";

export interface PermissionsStatus {
  platform: "macos" | "windows" | "linux";
  input_monitoring: PermState;
  accessibility: PermState;
}

export function usePermissions(pollWhileMissing = true) {
  const [status, setStatus] = useState<PermissionsStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [lastChecked, setLastChecked] = useState<string>("");

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await invoke<PermissionsStatus>("permissions_status"));
      setLastChecked(new Date().toLocaleTimeString());
    } finally {
      // brief delay so the user *sees* that re-check did something
      setTimeout(() => setChecking(false), 300);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const missing =
    status?.platform === "macos" &&
    (status.input_monitoring !== "granted" || status.accessibility !== "granted");

  // While something is missing, poll so the UI flips green the moment the
  // user grants access in System Settings.
  useEffect(() => {
    if (!pollWhileMissing || !missing) return;
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [pollWhileMissing, missing, refresh]);

  return { status, missing: Boolean(missing), refresh, checking, lastChecked };
}

function StateBadge({ state }: { state: PermState }) {
  if (state === "granted") return <Badge tone="green">✓ granted</Badge>;
  if (state === "denied") return <Badge tone="red">✕ DENIED</Badge>;
  return <Badge tone="amber">? not asked yet</Badge>;
}

function PermRow({
  title, purpose, state, kind,
}: {
  title: string;
  purpose: string;
  state: PermState;
  kind: string;
}) {
  const border =
    state === "granted" ? "border-success-line" : state === "denied" ? "border-danger-line" : "border-warning-line";
  const dot =
    state === "granted" ? "bg-success" : state === "denied" ? "bg-danger" : "bg-warning";
  return (
    <div className={`flex items-center gap-3 bg-panel2 border ${border} rounded-lg px-3 py-2`}>
      <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${dot}`} />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-fg">{title}</p>
        <p className="text-xs text-fg-faint">{purpose}</p>
      </div>
      <StateBadge state={state} />
      {state !== "granted" && (
        <Button variant="primary" onClick={() => void invoke("permissions_request", { kind })}>
          {state === "unknown" ? "Allow…" : "Open Settings"}
        </Button>
      )}
    </div>
  );
}

export function PermissionsCard() {
  const { status, missing, refresh, checking, lastChecked } = usePermissions();
  if (!status) return null;

  if (status.platform !== "macos") {
    return (
      <Card title="Permissions">
        <p className="text-sm text-fg-muted">
          No special OS permissions are required on {status.platform === "windows" ? "Windows" : "Linux"}.
          {status.platform === "linux" && " (Global recording requires an X11 session — Wayland is not supported yet.)"}
        </p>
      </Card>
    );
  }

  return (
    <Card
      title="macOS permissions"
      actions={
        <div className="flex items-center gap-2">
          {lastChecked && (
            <span className="text-[10px] text-fg-faint">checked {lastChecked}</span>
          )}
          <Button onClick={() => void refresh()} disabled={checking}>
            {checking ? "Checking…" : "Re-check"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-2">
        <PermRow
          title="Input Monitoring"
          purpose="Needed to record macros (global keyboard & mouse capture)"
          state={status.input_monitoring}
          kind="input_monitoring"
        />
        <PermRow
          title="Accessibility"
          purpose="Needed for local preview playback on this Mac"
          state={status.accessibility}
          kind="accessibility"
        />

        {missing && (
          <div className="bg-danger-bg border border-danger-line rounded-lg p-3 flex flex-col gap-2">
            <p className="text-sm text-danger font-semibold">
              Already granted it, but it still shows DENIED?
            </p>
            <p className="text-xs text-fg-muted leading-relaxed">
              The app is unsigned, so <span className="text-fg">every update gets a new
              signature</span> and macOS ties permissions to the old one. The toggle in System
              Settings then belongs to the previous version and does nothing. Fix it like this:
            </p>
            <ol className="text-xs text-fg list-decimal list-inside space-y-1">
              <li>Open the pane with the button above (Privacy &amp; Security → Input Monitoring / Accessibility).</li>
              <li><span className="text-fg">Remove MKYADA from the list</span> (select it and press the “−” button) — just toggling it off/on is often not enough.</li>
              <li>Restart MKYADA below, then click <em>Allow…</em> when it asks again.</li>
            </ol>
            <div>
              <Button variant="primary" onClick={() => void invoke("app_restart")}>
                <RefreshCw size={14} aria-hidden /> Restart MKYADA
              </Button>
            </div>
          </div>
        )}

        <p className="text-xs text-fg-faint mt-1">
          Configuring your keypad and playing macros <span className="text-fg">through the device</span> work
          without any permissions. A fresh Input Monitoring grant only takes effect after the app restarts.
        </p>
      </div>
    </Card>
  );
}

/** Slim banner for the app shell — visible on macOS until everything is granted. */
export function PermissionsBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { status, missing } = usePermissions();
  const [dismissed, setDismissed] = useState(false);
  if (!status || !missing || dismissed) return null;
  return (
    <div className="flex items-center justify-between bg-danger-bg border-b border-danger-line px-4 py-2 text-sm">
      <span className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-danger" />
        Recording won't work yet — macOS permissions missing
        {status.input_monitoring !== "granted" && " · Input Monitoring"}
        {status.accessibility !== "granted" && " · Accessibility"}
      </span>
      <div className="flex gap-2">
        <Button variant="primary" onClick={onOpenSettings}>Fix permissions</Button>
        <Button variant="ghost" onClick={() => setDismissed(true)}>Later</Button>
      </div>
    </div>
  );
}

/** Surface capture-start failures (emitted by the Rust tap thread). */
export function useRecordError(): string {
  const [error, setError] = useState("");
  useEffect(() => {
    const un = listen<string>("record:error", (e) => setError(e.payload));
    return () => {
      un.then((f) => f());
    };
  }, []);
  return error;
}

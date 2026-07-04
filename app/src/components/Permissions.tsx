// macOS permission guidance: shows what's missing, triggers the system
// prompt, deep-links into System Settings, and re-checks live.
// Configuring the keypad and hardware-HID playback need no permissions —
// only macro recording and local preview do.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Badge, Button, Card } from "./ui";

type PermState = "granted" | "denied" | "unknown";

export interface PermissionsStatus {
  platform: "macos" | "windows" | "linux";
  input_monitoring: PermState;
  accessibility: PermState;
}

export function usePermissions(pollWhileMissing = true) {
  const [status, setStatus] = useState<PermissionsStatus | null>(null);

  const refresh = useCallback(async () => {
    setStatus(await invoke<PermissionsStatus>("permissions_status"));
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

  return { status, missing: Boolean(missing), refresh };
}

function PermRow({
  title, purpose, state, kind, note,
}: {
  title: string;
  purpose: string;
  state: PermState;
  kind: string;
  note?: string;
}) {
  return (
    <div className="flex items-center gap-3 bg-panel2 border border-line rounded-lg px-3 py-2">
      <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${state === "granted" ? "bg-green-400" : "bg-amber-400"}`} />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-slate-200">{title}</p>
        <p className="text-xs text-slate-500">{purpose}{note ? ` — ${note}` : ""}</p>
      </div>
      {state === "granted" ? (
        <Badge tone="green">granted</Badge>
      ) : (
        <Button variant="primary" onClick={() => void invoke("permissions_request", { kind })}>
          {state === "unknown" ? "Allow…" : "Open Settings"}
        </Button>
      )}
    </div>
  );
}

export function PermissionsCard() {
  const { status, refresh } = usePermissions();
  if (!status) return null;

  if (status.platform !== "macos") {
    return (
      <Card title="Permissions">
        <p className="text-sm text-slate-400">
          No special OS permissions are required on {status.platform === "windows" ? "Windows" : "Linux"}.
          {status.platform === "linux" && " (Global recording requires an X11 session — Wayland is not supported yet.)"}
        </p>
      </Card>
    );
  }

  return (
    <Card
      title="macOS permissions"
      actions={<Button onClick={() => void refresh()}>Re-check</Button>}
    >
      <div className="flex flex-col gap-2">
        <PermRow
          title="Input Monitoring"
          purpose="Needed to record macros (global keyboard & mouse capture)"
          state={status.input_monitoring}
          kind="input_monitoring"
          note="System Settings → Privacy & Security → Input Monitoring"
        />
        <PermRow
          title="Accessibility"
          purpose="Needed for local preview playback on this Mac"
          state={status.accessibility}
          kind="accessibility"
          note="System Settings → Privacy & Security → Accessibility"
        />
        <p className="text-xs text-slate-500 mt-1">
          Configuring your keypad and playing macros <span className="text-slate-300">through the device</span> work
          without any permissions. macOS may also ask once to access files on a removable volume when the app first
          writes to the CIRCUITPY drive — click Allow. If a toggle doesn't stick, quit and reopen MKYADA.
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
    <div className="flex items-center justify-between bg-sky-900/30 border-b border-sky-800 px-4 py-2 text-sm">
      <span>
        macOS permissions needed for macro recording
        {status.input_monitoring !== "granted" && " · Input Monitoring"}
        {status.accessibility !== "granted" && " · Accessibility"}
      </span>
      <div className="flex gap-2">
        <Button variant="primary" onClick={onOpenSettings}>Set up permissions</Button>
        <Button variant="ghost" onClick={() => setDismissed(true)}>Later</Button>
      </div>
    </div>
  );
}

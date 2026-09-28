// macOS permission guidance: unambiguous red/green status, visible re-check
// feedback, and recovery steps for the stale-grant trap (unsigned apps get a
// new code signature on every update, so a grant given to an older version
// no longer applies even though System Settings still shows the toggle on).

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Keyboard, MousePointer2, RefreshCw, type LucideIcon } from "lucide-react";
import { Alert, Badge, Button, Card, SettingRow, Tooltip } from "./ui";

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
  if (state === "granted") return <Badge tone="green" dot>Granted</Badge>;
  if (state === "denied") return <Badge tone="red" dot>Denied</Badge>;
  return <Badge tone="amber" dot>Not asked yet</Badge>;
}

function PermRow({
  title, purpose, state, kind, icon,
}: {
  title: string;
  purpose: string;
  state: PermState;
  kind: string;
  icon: LucideIcon;
}) {
  return (
    <SettingRow
      icon={icon}
      title={title}
      description={purpose}
      control={
        <>
          <StateBadge state={state} />
          {state !== "granted" && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => void invoke("permissions_request", { kind })}
            >
              {state === "unknown" ? "Allow…" : "Open System Settings"}
            </Button>
          )}
        </>
      }
    />
  );
}

export function PermissionsCard() {
  const { status, missing, refresh, checking, lastChecked } = usePermissions();
  if (!status) return null;

  if (status.platform !== "macos") {
    return (
      <Card title="Permissions">
        <p className="text-sm text-fg-muted">
          No special permissions needed on {status.platform === "windows" ? "Windows" : "Linux"}.
          {status.platform === "linux" && " Recording needs an X11 session · Wayland isn't supported yet."}
        </p>
      </Card>
    );
  }

  return (
    <Card
      title="macOS permissions"
      description="Only needed for recording and preview playback · the keypad itself works without them"
      actions={
        <Tooltip side="bottom" content={lastChecked ? `Last checked ${lastChecked}` : "Check again"}>
          <Button size="sm" onClick={() => void refresh()} loading={checking}>
            <RefreshCw size={14} aria-hidden /> Re-check
          </Button>
        </Tooltip>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col divide-y divide-line">
          <PermRow
            icon={Keyboard}
            title="Input Monitoring"
            purpose="Records macros from your keyboard and mouse · takes effect after a restart"
            state={status.input_monitoring}
            kind="input_monitoring"
          />
          <PermRow
            icon={MousePointer2}
            title="Accessibility"
            purpose="Plays macro previews on this Mac"
            state={status.accessibility}
            kind="accessibility"
          />
        </div>

        {missing && (
          <Alert
            tone="warning"
            title="Granted already, but still denied?"
            actions={
              <Button size="sm" onClick={() => void invoke("app_restart")}>
                <RefreshCw size={14} aria-hidden /> Restart MKYADA
              </Button>
            }
          >
            <p>
              Each update gets a new signature, so macOS keeps the grant for the old version.
            </p>
            <ol className="mt-1.5 flex list-decimal flex-col gap-0.5 pl-5">
              <li>In System Settings › Privacy &amp; Security, select MKYADA and remove it with “−”.</li>
              <li>Restart MKYADA, then click Allow… when it asks again.</li>
            </ol>
          </Alert>
        )}
      </div>
    </Card>
  );
}

/** Slim banner for the app shell — visible on macOS until everything is granted. */
export function PermissionsBanner({
  onOpenSettings,
  className,
}: {
  onOpenSettings: () => void;
  className?: string;
}) {
  const { status, missing } = usePermissions();
  const [dismissed, setDismissed] = useState(false);
  if (!status || !missing || dismissed) return null;
  return (
    <Alert
      tone="danger"
      className={className}
      title="Recording won't work yet · macOS permissions missing"
      actions={
        <>
          <Button variant="primary" size="sm" onClick={onOpenSettings}>
            Fix permissions
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDismissed(true)}>
            Later
          </Button>
        </>
      }
    >
      Grant{" "}
      {[
        status.input_monitoring !== "granted" && "Input Monitoring",
        status.accessibility !== "granted" && "Accessibility",
      ]
        .filter(Boolean)
        .join(" and ")}{" "}
      to MKYADA in System Settings.
    </Alert>
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

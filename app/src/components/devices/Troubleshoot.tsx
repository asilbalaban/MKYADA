// One place to repair a keypad. It used to be three unrelated buttons
// (Restart keypad, Reinstall firmware, Recovery) scattered over the Devices
// card; now they're a ladder: try the lightest fix first, and climb only when
// the problem stays.

import type { ReactNode } from "react";
import { ArchiveRestore } from "lucide-react";
import { useNav } from "../../lib/nav";
import { Badge, Button, Card } from "../ui";
import { RecoveryWizard } from "../RecoveryWizard";

export function TroubleshootTab({
  rescue,
  drive,
  deviceFw,
  bundledFw,
  fwOutdated,
  updating,
  recovery,
  onRestart,
  onFirmware,
  onRecovery,
  onCloseRecovery,
}: {
  rescue: boolean;
  drive: boolean;
  deviceFw: string;
  bundledFw: string;
  fwOutdated: boolean;
  updating: boolean;
  recovery: boolean;
  onRestart: () => void;
  onFirmware: () => void;
  onRecovery: () => void;
  onCloseRecovery: () => void;
}) {
  const nav = useNav();
  return (
    <>
      {recovery && (
        <Card title="Recovery" description="Checks the firmware files on the keypad and repairs what doesn't match">
          <RecoveryWizard onClose={onCloseRecovery} />
        </Card>
      )}
      <Card
        title="Something wrong with the keypad?"
        description="Start at step 1 · move on only if the problem stays · your keys and macros are kept"
      >
        <ol className="flex flex-col divide-y divide-line">
          <Step
            n={1}
            title="Restart the keypad"
            description="Keypad frozen, keys not reacting, or its USB drive went read-only. Same as unplugging it and plugging it back in."
            action={<Button onClick={onRestart}>Restart</Button>}
          />
          <Step
            n={2}
            title={fwOutdated ? "Update the firmware" : "Reinstall the firmware"}
            description={
              rescue
                ? "Not available while the keypad is in rescue mode · use recovery instead."
                : fwOutdated
                  ? `Still acting up after a restart, or a feature is missing. Installs v${bundledFw} over v${deviceFw}.`
                  : `Still acting up after a restart. Rewrites every firmware file with v${bundledFw || deviceFw}.`
            }
            action={
              <Button
                variant={fwOutdated && !rescue ? "primary" : "default"}
                onClick={onFirmware}
                disabled={rescue || !drive || !bundledFw}
                loading={updating}
              >
                {fwOutdated ? "Update" : "Reinstall"}
              </Button>
            }
          />
          <Step
            n={3}
            title="Run recovery"
            description="The keypad won't start, or a reinstall didn't help. Checks each firmware file, repairs it and confirms the keypad comes back."
            badge={rescue ? <Badge tone="red">Recommended now</Badge> : undefined}
            action={
              <Button variant={rescue ? "primary" : "default"} onClick={onRecovery} disabled={recovery}>
                {recovery ? "In progress" : "Start recovery"}
              </Button>
            }
          />
        </ol>
      </Card>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 gap-3">
            <ArchiveRestore size={18} aria-hidden className="mt-px shrink-0 text-fg-faint" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-strong text-fg">Back up before a big repair</span>
              <span className="text-[13px] leading-snug text-fg-faint">
                Save every key and macro to a file, or restore one · Settings › Keypad
              </span>
            </div>
          </div>
          <Button variant="ghost" onClick={() => nav("settings", { tab: "keypad" })}>
            Open backups
          </Button>
        </div>
      </Card>
    </>
  );
}

function Step({
  n,
  title,
  description,
  badge,
  action,
}: {
  n: number;
  title: string;
  description: string;
  badge?: ReactNode;
  action: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-1 gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-sunken text-[12px] font-semibold tabular-nums text-fg-muted">
          {n}
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2 text-sm font-strong text-fg">
            {title}
            {badge}
          </span>
          <span className="max-w-2xl text-[13px] leading-snug text-fg-faint">{description}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">{action}</div>
    </li>
  );
}

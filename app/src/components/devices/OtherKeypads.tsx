// Keypads other than the connected one: plugged in right now (Connect),
// remembered from earlier, and a blank board to set up.

import { useState } from "react";
import { CirclePlus, RefreshCw } from "lucide-react";
import type { DeviceInfo } from "../../lib/types";
import { MODEL_META, deviceModel } from "../../lib/types";
import { type RememberedDevice, displayName } from "../../lib/devnames";
import { Badge, Button, Card } from "../ui";
import { ProductImage } from "../ProductImage";
import { ProvisionWizard } from "../ProvisionWizard";

export function OtherKeypads({
  connected,
  scanning,
  pluggedIn,
  offline,
  remembered,
  onScan,
  onConnect,
  onProvisioned,
}: {
  connected: boolean;
  scanning: boolean;
  pluggedIn: DeviceInfo[];
  offline: RememberedDevice[];
  remembered: Record<string, RememberedDevice>;
  onScan: () => void;
  onConnect: (d: DeviceInfo) => void;
  onProvisioned: () => void;
}) {
  const [provisioning, setProvisioning] = useState(false);

  return (
    <>
      <Card
        title="Plugged in"
        description={connected ? "Other keypads on USB right now" : "Keypads on USB right now"}
        actions={
          <Button size="sm" onClick={onScan} loading={scanning}>
            {!scanning && <RefreshCw size={14} aria-hidden />}
            {scanning ? "Scanning…" : "Scan"}
          </Button>
        }
      >
        {pluggedIn.length === 0 ? (
          <p className="text-sm text-fg-faint">
            {scanning
              ? "Looking for keypads…"
              : connected
                ? "No other keypads plugged in."
                : "No keypads found on USB."}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {pluggedIn.map((d) => (
              <li
                key={d.port}
                className="flex items-center justify-between gap-3 rounded-control bg-raised px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <ProductImage model={deviceModel(d.hello)} className="size-10" />
                  <div className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-2 text-sm font-strong text-fg">
                      {displayName(remembered[d.hello.uid]?.name, d.hello.uid)}
                      {d.hello.mode === "rescue" && <Badge tone="red">Rescue mode</Badge>}
                    </span>
                    <span className="truncate text-[13px] text-fg-faint">
                      {MODEL_META[deviceModel(d.hello)].label} · {d.hello.key_count} keys · firmware{" "}
                      {d.hello.fw}
                    </span>
                  </div>
                </div>
                <Button variant="primary" size="sm" onClick={() => onConnect(d)}>
                  Connect
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {offline.length > 0 && (
        <Card title="Remembered" description="Seen on this computer before · not plugged in">
          <ul className="flex flex-col divide-y divide-line">
            {offline.map((r) => (
              <li key={r.uid} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0 text-sm">
                <span className="flex items-center gap-2.5 text-fg-muted">
                  <span aria-hidden className="size-2 shrink-0 rounded-full bg-stone-300" />
                  {displayName(r.name, r.uid)}
                </span>
                <span className="text-[13px] text-fg-faint">
                  Last seen {new Date(r.lastSeen).toLocaleDateString()}
                  {r.fw && ` · firmware ${r.fw}`}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card
        title="Set up a new board"
        description="Turns a blank RP2040-Zero into a MKYADA keypad · no tools needed"
        actions={
          !provisioning && (
            <Button size="sm" onClick={() => setProvisioning(true)}>
              <CirclePlus size={14} aria-hidden /> Set up a new board
            </Button>
          )
        }
      >
        {provisioning ? (
          <ProvisionWizard
            onDone={() => {
              setProvisioning(false);
              onProvisioned();
            }}
            onCancel={() => setProvisioning(false)}
          />
        ) : (
          <p className="text-sm text-fg-muted">
            Plug the board in while holding its BOOT button. The app installs CircuitPython and the
            MKYADA firmware, then walks you through setup.
          </p>
        )}
      </Card>
    </>
  );
}

// Landing page: find and connect a keypad.

import { useEffect } from "react";
import { useDevice } from "../lib/device";
import { Badge, Button, Card } from "../components/ui";

export function DevicesPage({ onConnected }: { onConnected: () => void }) {
  const { scanning, devices, scan, connect, port, hello, drive, disconnect } = useDevice();

  useEffect(() => {
    if (!port) void scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <Card
        title="Connected device"
        actions={
          port && (
            <Button variant="danger" onClick={() => void disconnect()}>
              Disconnect
            </Button>
          )
        }
      >
        {port && hello ? (
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex items-center gap-2">
              <Badge tone="green">connected</Badge>
              <span className="font-mono text-slate-300">{port}</span>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-slate-400">
              <span>Firmware</span>
              <span className="text-slate-200">{hello.fw}</span>
              <span>Keys</span>
              <span className="text-slate-200">{hello.key_count}</span>
              <span>Board UID</span>
              <span className="text-slate-200 font-mono text-xs">{hello.uid}</span>
              <span>USB drive</span>
              <span className="text-slate-200 font-mono text-xs">
                {drive ? drive.path : "not found — file writes unavailable"}
              </span>
            </div>
          </div>
        ) : (
          <p className="text-slate-400 text-sm">
            No device connected. Plug in your MKYADA keypad and scan.
          </p>
        )}
      </Card>

      <Card
        title="Available devices"
        actions={
          <Button onClick={() => void scan()} disabled={scanning}>
            {scanning ? "Scanning…" : "Scan"}
          </Button>
        }
      >
        {devices.length === 0 ? (
          <p className="text-slate-500 text-sm">
            {scanning ? "Looking for MKYADA keypads…" : "No keypads found."}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {devices.map((d) => (
              <li
                key={d.port}
                className="flex items-center justify-between bg-panel2 border border-line rounded-lg px-3 py-2"
              >
                <div className="flex flex-col">
                  <span className="text-sm font-mono">{d.port}</span>
                  <span className="text-xs text-slate-500">
                    fw {d.hello.fw} · {d.hello.key_count} keys · uid {d.hello.uid.slice(0, 8)}…
                  </span>
                </div>
                <Button
                  variant="primary"
                  onClick={async () => {
                    await connect(d);
                    onConnected();
                  }}
                >
                  Connect
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

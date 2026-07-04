// Device management: the connected keypad (with nickname + firmware update),
// keypads plugged in right now (prominent), and remembered ones (dimmed).
// A single plugged-in keypad connects automatically.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { useDevice } from "../lib/device";
import {
  RememberedDevice,
  displayName,
  rememberDevice,
  rememberedDevices,
} from "../lib/devnames";
import { Badge, Button, Card, Field, Input } from "../components/ui";

export function DevicesPage({ onConnected }: { onConnected: () => void }) {
  const { scanning, devices, scan, connect, port, hello, drive, disconnect, send } = useDevice();
  const [remembered, setRemembered] = useState<Record<string, RememberedDevice>>({});
  const [nickname, setNickname] = useState("");
  const [bundledFw, setBundledFw] = useState("");
  const [updating, setUpdating] = useState(false);

  async function refreshRemembered() {
    setRemembered(await rememberedDevices());
  }

  useEffect(() => {
    void refreshRemembered();
    invoke<string>("firmware_bundled_version").then(setBundledFw).catch(() => setBundledFw(""));
  }, []);

  useEffect(() => {
    if (hello) {
      setNickname(remembered[hello.uid]?.name ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hello?.uid, remembered]);

  async function saveNickname() {
    if (!hello) return;
    await rememberDevice(hello.uid, { name: nickname.trim() });
    await refreshRemembered();
  }

  async function updateFirmware() {
    if (!hello || !drive) return;
    const ok = await ask(
      `Update the device firmware from v${hello.fw} to v${bundledFw}?\n\n` +
        "Your key assignments, macros and config stay untouched. " +
        "The keypad restarts and reconnects automatically.",
      { title: "Update firmware", kind: "info" },
    );
    if (!ok) return;
    setUpdating(true);
    try {
      const files = await invoke<string[]>("firmware_update", { drive: drive.path });
      // New firmware supports {"t":"reset"}; older ones auto-reload code.py,
      // which is enough when boot.py didn't change.
      await send({ t: "reset" }).catch(() => {});
      await message(
        `Firmware updated (${files.length} files written).\n` +
          "The keypad is restarting — it will reconnect in a few seconds.",
        { title: "Firmware updated", kind: "info" },
      );
    } catch (e) {
      await message(`Firmware update failed:\n${e}`, { title: "Firmware update", kind: "error" });
    } finally {
      setUpdating(false);
    }
  }

  const fwOutdated =
    hello && bundledFw && hello.fw !== bundledFw ? bundledFw : null;
  const connectedUid = hello?.uid.toLowerCase();
  const pluggedIn = devices.filter((d) => d.hello.uid.toLowerCase() !== connectedUid);
  const pluggedUids = new Set(devices.map((d) => d.hello.uid.toLowerCase()));
  const offline = Object.values(remembered).filter(
    (r) => r.uid.toLowerCase() !== connectedUid && !pluggedUids.has(r.uid.toLowerCase()),
  );

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <Card
        title="Connected"
        actions={
          port && (
            <Button variant="danger" onClick={() => void disconnect()}>
              Disconnect
            </Button>
          )
        }
      >
        {port && hello ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <span className="w-3 h-3 rounded-full bg-green-400 animate-pulse" />
              <span className="text-lg font-semibold text-slate-100">
                {displayName(remembered[hello.uid]?.name, hello.uid)}
              </span>
              <Badge tone="green">USB · connected</Badge>
            </div>
            <div className="flex items-end gap-2">
              <Field label="Nickname (e.g. Klavye 1)">
                <Input
                  value={nickname}
                  placeholder={displayName(undefined, hello.uid)}
                  onChange={(e) => setNickname(e.target.value)}
                />
              </Field>
              <Button onClick={() => void saveNickname()}>Save name</Button>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-slate-400">
              <span>Firmware</span>
              <span className="text-slate-200">
                v{hello.fw}
                {fwOutdated && <Badge tone="amber"> update available</Badge>}
              </span>
              <span>Keys</span>
              <span className="text-slate-200">{hello.key_count}</span>
              <span>Serial port</span>
              <span className="text-slate-200 font-mono text-xs">{port}</span>
              <span>USB drive</span>
              <span className="text-slate-200 font-mono text-xs">
                {drive ? drive.path : "not found"}
              </span>
              <span>Board UID</span>
              <span className="text-slate-200 font-mono text-xs">{hello.uid}</span>
            </div>
            {fwOutdated && (
              <div className="flex items-center gap-3 bg-amber-900/20 border border-amber-800 rounded-lg px-3 py-2">
                <span className="text-sm text-amber-200">
                  This app ships firmware v{bundledFw}; the device runs v{hello.fw}.
                </span>
                <Button variant="primary" onClick={() => void updateFirmware()} disabled={updating || !drive}>
                  {updating ? "Updating…" : "Update firmware"}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <p className="text-slate-400 text-sm">
            No device connected. Plug in your MKYADA keypad — it connects automatically when it's
            the only one.
          </p>
        )}
      </Card>

      <Card
        title="Plugged in — ready to connect"
        actions={
          <Button onClick={() => void scan()} disabled={scanning}>
            {scanning ? "Scanning…" : "Scan"}
          </Button>
        }
      >
        {pluggedIn.length === 0 ? (
          <p className="text-slate-500 text-sm">
            {port ? "No other keypads plugged in." : scanning ? "Looking for keypads…" : "No keypads found on USB."}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {pluggedIn.map((d) => (
              <li
                key={d.port}
                className="flex items-center justify-between bg-panel2 border-2 border-accent/50 rounded-lg px-3 py-2"
              >
                <div className="flex items-center gap-3">
                  <span className="w-2.5 h-2.5 rounded-full bg-sky-400" />
                  <div className="flex flex-col">
                    <span className="text-sm font-semibold text-slate-100">
                      {displayName(remembered[d.hello.uid]?.name, d.hello.uid)}
                    </span>
                    <span className="text-xs text-slate-500">
                      USB · fw v{d.hello.fw} · {d.hello.key_count} keys · {d.port}
                    </span>
                  </div>
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

      {offline.length > 0 && (
        <Card title="Remembered — not plugged in">
          <ul className="flex flex-col gap-1 opacity-60">
            {offline.map((r) => (
              <li key={r.uid} className="flex items-center gap-3 px-3 py-1.5 text-sm">
                <span className="w-2.5 h-2.5 rounded-full bg-slate-600" />
                <span className="text-slate-300">{displayName(r.name, r.uid)}</span>
                <span className="text-xs text-slate-500">
                  last seen {new Date(r.lastSeen).toLocaleString()}
                  {r.fw && ` · fw v${r.fw}`}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

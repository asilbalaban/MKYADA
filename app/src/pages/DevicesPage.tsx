// Device management: the connected keypad (with nickname + firmware update),
// keypads plugged in right now (prominent), and remembered ones (dimmed).
// A single plugged-in keypad connects automatically.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CirclePlus, RotateCcw, Usb } from "lucide-react";
import { ipc } from "../lib/ipc";
import { isSerialDrive, useDevice } from "../lib/device";
import { useNav } from "../lib/nav";
import { MODEL_META, deviceModel } from "../lib/types";
import {
  RememberedDevice,
  displayName,
  rememberDevice,
  rememberedDevices,
  writeNameToDevice,
} from "../lib/devnames";
import { Badge, Button, Card, EmptyState, Field, Input } from "../components/ui";
import { ProductImage } from "../components/ProductImage";
import { ProvisionWizard } from "../components/ProvisionWizard";
import { useToast } from "../components/toast";
import { useConfirm } from "../components/dialog";

export function DevicesPage({ onConnected }: { onConnected: () => void }) {
  const { scanning, devices, scan, connect, port, hello, drive, disconnect, send } = useDevice();
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const [remembered, setRemembered] = useState<Record<string, RememberedDevice>>({});
  const [nickname, setNickname] = useState("");
  const [bundledFw, setBundledFw] = useState("");
  const [updating, setUpdating] = useState(false);
  const [provisioning, setProvisioning] = useState(false);

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
    // Also store it on the keypad itself, so it keeps the name on any computer.
    if (drive) {
      try {
        await writeNameToDevice(drive.path, nickname.trim());
        toast.success("Nickname saved", "Stored on the keypad too — it travels with the device.");
        return;
      } catch {
        toast.success("Nickname saved", "Couldn't write it to the keypad's drive, saved on this computer only.");
        return;
      }
    }
    toast.success("Nickname saved");
  }

  async function updateFirmware(reinstall = false) {
    if (!hello || !drive) return;
    const ok = await confirm({
      title: reinstall ? "Reinstall firmware" : "Update firmware",
      message: reinstall
        ? `Rewrite every firmware file on the keypad with the bundled v${bundledFw}, ` +
          "even though it already reports this version? Use this to repair a broken " +
          "or half-finished install.\n\n" +
          "Your key assignments, macros and config stay untouched. " +
          "The keypad restarts and reconnects automatically."
        : `Update the device firmware from v${hello.fw} to v${bundledFw}?\n\n` +
          "Your key assignments, macros and config stay untouched. " +
          "The keypad restarts and reconnects automatically.",
      confirmLabel: reinstall ? "Reinstall" : "Update",
    });
    if (!ok) return;
    setUpdating(true);
    try {
      const files = await invoke<string[]>("firmware_update", { drive: drive.path });
      // Unmount cleanly before the reset — a reset while mounted leaves the
      // FAT dirty bit set and macOS remounts the drive read-only next time.
      await ipc.driveEject(drive.path).catch(() => {});
      // New firmware supports {"t":"reset"}; older ones auto-reload code.py,
      // which is enough when boot.py didn't change.
      await send({ t: "reset" }).catch(() => {});
      // Drop the now-dead connection so auto-connect reattaches cleanly.
      await disconnect().catch(() => {});
      toast.success(
        `Firmware ${reinstall ? "reinstalled" : "updated"} (${files.length} files written)`,
        "The keypad is restarting — it will reconnect in a few seconds.",
      );
    } catch (e) {
      toast.error("Firmware update failed", String(e));
    } finally {
      setUpdating(false);
    }
  }

  /** Same effect as unplug/replug, without touching the cable: clean unmount
   *  (keeps the drive from remounting read-only) + reset over serial. */
  async function restartKeypad() {
    if (drive) await ipc.driveEject(drive.path).catch(() => {});
    await send({ t: "reset" }).catch(() => {});
    // The port is about to vanish — drop the connection now so the
    // auto-connect loop picks the keypad up as soon as it re-enumerates.
    await disconnect().catch(() => {});
    toast.success("Keypad restarting", "It will reconnect by itself in a few seconds.");
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
    <div className="flex flex-col gap-4 max-w-3xl mx-auto w-full">
      <Card
        title="Connected"
        actions={
          port && (
            <div className="flex gap-2">
              <Button
                onClick={() => void restartKeypad()}
                title="Restart the keypad — fixes a read-only USB drive without replugging"
              >
                <RotateCcw size={14} aria-hidden /> Restart keypad
              </Button>
              <Button variant="danger" onClick={() => void disconnect()}>
                Disconnect
              </Button>
            </div>
          )
        }
      >
        {port && hello ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <ProductImage model={deviceModel(hello)} className="w-16 h-16" />
              <div className="flex items-center gap-3">
                <span className="w-3 h-3 rounded-full bg-success animate-pulse" />
                <span className="text-lg font-semibold text-fg">
                  {displayName(remembered[hello.uid]?.name, hello.uid)}
                </span>
                <Badge tone="green">USB · connected</Badge>
              </div>
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
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-fg-muted">
              <span>Model</span>
              <span className="text-fg">{MODEL_META[deviceModel(hello)].label}</span>
              <span>Firmware</span>
              <span className="text-fg">
                v{hello.fw}
                {fwOutdated && <Badge tone="amber"> update available</Badge>}
              </span>
              <span>Keys</span>
              <span className="text-fg">{hello.key_count}</span>
              <span>Serial port</span>
              <span className="text-fg font-mono text-xs">{port}</span>
              <span>USB drive</span>
              <span className="text-fg font-mono text-xs">
                {isSerialDrive(drive)
                  ? "hidden — managed by the app (Settings)"
                  : drive
                    ? drive.path
                    : "not found"}
              </span>
              <span>Board UID</span>
              <span className="text-fg font-mono text-xs">{hello.uid}</span>
            </div>
            {fwOutdated ? (
              <div className="flex items-center gap-3 bg-warning-bg border border-warning-line rounded-lg px-3 py-2">
                <span className="text-sm text-fg">
                  This app ships firmware v{bundledFw}; the device runs v{hello.fw}.
                </span>
                <Button
                  variant="primary"
                  onClick={() => void updateFirmware()}
                  disabled={!drive}
                  loading={updating}
                >
                  {updating ? "Updating…" : "Update firmware"}
                </Button>
              </div>
            ) : (
              bundledFw && (
                <div className="flex items-center gap-3 text-sm text-fg-faint">
                  <span>Firmware is up to date.</span>
                  <Button
                    onClick={() => void updateFirmware(true)}
                    disabled={!drive}
                    loading={updating}
                    title="Rewrite all firmware files — repairs a broken or half-finished install"
                  >
                    {updating ? "Reinstalling…" : "Reinstall firmware"}
                  </Button>
                </div>
              )
            )}
          </div>
        ) : (
          <EmptyState
            icon={<Usb size={28} />}
            title="No keypad connected"
            description="Plug in your MKYADA keypad — it connects automatically when it's the only one."
          />
        )}
      </Card>

      <Card
        title="Plugged in — ready to connect"
        actions={
          <Button onClick={() => void scan()} loading={scanning}>
            {scanning ? "Scanning…" : "Scan"}
          </Button>
        }
      >
        {pluggedIn.length === 0 ? (
          <p className="text-fg-faint text-sm">
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
                  <span className="w-2.5 h-2.5 rounded-full bg-accent" />
                  <ProductImage model={deviceModel(d.hello)} className="w-9 h-9" />
                  <div className="flex flex-col">
                    <span className="text-sm font-semibold text-fg">
                      {displayName(remembered[d.hello.uid]?.name, d.hello.uid)}
                    </span>
                    <span className="text-xs text-fg-faint">
                      {MODEL_META[deviceModel(d.hello)].label} · fw v{d.hello.fw} ·{" "}
                      {d.hello.key_count} keys · {d.port}
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

      <Card
        title="Set up a new board"
        actions={
          !provisioning && (
            <Button onClick={() => setProvisioning(true)}>
              <CirclePlus size={14} aria-hidden /> Set up a new board
            </Button>
          )
        }
      >
        {provisioning ? (
          <ProvisionWizard
            onDone={() => {
              setProvisioning(false);
              nav("setup");
            }}
            onCancel={() => setProvisioning(false)}
          />
        ) : (
          <p className="text-fg-muted text-sm">
            Got a blank RP2040-Zero? This flashes CircuitPython and the MKYADA firmware onto it —
            no tools needed.
          </p>
        )}
      </Card>

      {offline.length > 0 && (
        <Card title="Remembered — not plugged in">
          <ul className="flex flex-col gap-1 opacity-60">
            {offline.map((r) => (
              <li key={r.uid} className="flex items-center gap-3 px-3 py-1.5 text-sm">
                <span className="w-2.5 h-2.5 rounded-full bg-fg-faint" />
                <span className="text-fg">{displayName(r.name, r.uid)}</span>
                <span className="text-xs text-fg-faint">
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

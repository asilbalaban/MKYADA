// Devices: everything about the keypad itself, on one page. A hero for the
// connected keypad (name, model, firmware, the one thing to do next), then
// tabs for how it's built (Setup, Test keys, Fix wiring), repairs
// (Troubleshoot) and every other keypad. Setup used to be its own page behind
// a button here (issue #42); it lives in the tabs now.

import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Check,
  ChevronDown,
  ClipboardList,
  Hand,
  LifeBuoy,
  Pencil,
  RefreshCw,
  RotateCw,
  Usb,
  Wrench,
  X,
  Keyboard,
} from "lucide-react";
import { FirmwareProgress, ipc, onFirmwareProgress } from "../lib/ipc";
import { isSerialDrive, useDevice } from "../lib/device";
import { useNav } from "../lib/nav";
import { MODEL_META, deviceModel, type DeviceInfo } from "../lib/types";
import {
  RememberedDevice,
  displayName,
  rememberDevice,
  rememberedDevices,
  writeNameToDevice,
} from "../lib/devnames";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
  Input,
  ProgressBar,
  Tabs,
  type Tab,
} from "../components/ui";
import { ProductImage } from "../components/ProductImage";
import { useToast } from "../components/toast";
import { useConfirm } from "../components/dialog";
import {
  FixWiringTab,
  SetupTab,
  TestKeysTab,
  useKeypadConfig,
} from "../components/devices/KeypadSetup";
import { TroubleshootTab } from "../components/devices/Troubleshoot";
import { OtherKeypads } from "../components/devices/OtherKeypads";

type TabId = "setup" | "test" | "wiring" | "troubleshoot" | "others";

export function DevicesPage({ onConnected }: { onConnected: () => void }) {
  const { scanning, devices, scan, connect, port, hello, drive, disconnect, send, updating, setUpdating } =
    useDevice();
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const [remembered, setRemembered] = useState<Record<string, RememberedDevice>>({});
  const [bundledFw, setBundledFw] = useState("");
  const [fwProgress, setFwProgress] = useState<FirmwareProgress | null>(null);
  const [recovery, setRecovery] = useState(false);
  const [tab, setTab] = useState<TabId>("setup");
  const setup = useKeypadConfig();
  const rescue = hello?.mode === "rescue";

  // A keypad that answered from its rescue console is already broken — open
  // the recovery wizard on sight rather than making the owner find it.
  useEffect(() => {
    if (rescue) {
      setRecovery(true);
      setTab("troubleshoot");
    }
  }, [rescue]);

  useEffect(() => {
    const un = onFirmwareProgress(setFwProgress);
    return () => {
      un.then((f) => f());
    };
  }, []);

  async function refreshRemembered() {
    setRemembered(await rememberedDevices());
  }

  useEffect(() => {
    void refreshRemembered();
    invoke<string>("firmware_bundled_version").then(setBundledFw).catch(() => setBundledFw(""));
  }, []);

  async function saveNickname(name: string) {
    if (!hello) return;
    await rememberDevice(hello.uid, { name });
    await refreshRemembered();
    // Also store it on the keypad itself, so it keeps the name on any computer.
    if (drive) {
      try {
        await writeNameToDevice(drive.path, name);
        toast.success("Name saved", "Stored on the keypad too · it travels with the device.");
      } catch {
        toast.success("Name saved", "Saved on this computer only · the keypad's drive wasn't writable.");
      }
      return;
    }
    toast.success("Name saved");
  }

  async function updateFirmware(reinstall = false) {
    if (!hello || !drive) return;
    const ok = await confirm({
      title: reinstall ? "Reinstall firmware" : "Update firmware",
      message: reinstall
        ? `Rewrite every firmware file on the keypad with the bundled v${bundledFw}, ` +
          "even though it already reports this version? Use this to repair a broken " +
          "or half-finished install.\n\n" +
          "Your key assignments, macros and setup stay untouched. " +
          "The keypad restarts and reconnects automatically."
        : `Update the keypad firmware from v${hello.fw} to v${bundledFw}?\n\n` +
          "Your key assignments, macros and setup stay untouched. " +
          "The keypad restarts and reconnects automatically.",
      confirmLabel: reinstall ? "Reinstall" : "Update",
    });
    if (!ok) return;
    setUpdating(true);
    setFwProgress(null);
    try {
      // The backend locks the keypad into update mode (proto v7): its keys
      // and menus freeze, its screen shows transfer progress, and every file
      // is CRC/read-back verified after landing.
      const files = await invoke<string[]>("firmware_update", { drive: drive.path });
      // Unmount cleanly before the reset — a reset while mounted leaves the
      // FAT dirty bit set and macOS remounts the drive read-only next time.
      await ipc.driveEject(drive.path).catch(() => {});
      // update_end reboots a v7 keypad out of update mode; reset covers the
      // older ones (and the rescue console answers both).
      await send({ t: "update_end" }).catch(() => {});
      await send({ t: "reset" }).catch(() => {});
      // Drop the now-dead connection so auto-connect reattaches cleanly.
      await disconnect().catch(() => {});
      toast.success(
        `Firmware ${reinstall ? "reinstalled" : "updated"} · ${files.length} files written`,
        "The keypad is restarting · it reconnects in a few seconds.",
      );
    } catch (e) {
      toast.error("Firmware update failed", String(e));
    } finally {
      setUpdating(false);
      setFwProgress(null);
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
    toast.success("Keypad restarting", "It reconnects by itself in a few seconds.");
  }

  async function connectTo(d: DeviceInfo) {
    await connect(d);
    onConnected();
  }

  const fwOutdated = !!(hello && bundledFw && hello.fw !== bundledFw);
  const connectedUid = hello?.uid.toLowerCase();
  const pluggedIn = devices.filter((d) => d.hello.uid.toLowerCase() !== connectedUid);
  const pluggedUids = new Set(devices.map((d) => d.hello.uid.toLowerCase()));
  const offline = Object.values(remembered).filter(
    (r) => r.uid.toLowerCase() !== connectedUid && !pluggedUids.has(r.uid.toLowerCase()),
  );

  const others = (
    <OtherKeypads
      connected={!!(port && hello)}
      scanning={scanning}
      pluggedIn={pluggedIn}
      offline={offline}
      remembered={remembered}
      onScan={() => void scan()}
      onConnect={(d) => void connectTo(d)}
      onProvisioned={() => setTab("setup")}
    />
  );

  const modal = updating && <FirmwareModal progress={fwProgress} />;

  // ---- nothing connected: say so, then everything that can change that ----
  if (!port || !hello) {
    return (
      <div className="flex w-full flex-col gap-4">
        {modal}
        <Card>
          <EmptyState
            icon={<Usb size={28} />}
            title="No keypad connected"
            description={
              pluggedIn.length > 0
                ? "More than one keypad is plugged in · pick one below to connect."
                : "Plug in your MKYADA keypad · it connects by itself when it's the only one."
            }
            action={
              <Button variant="primary" onClick={() => void scan()} loading={scanning}>
                {!scanning && <RefreshCw size={14} aria-hidden />}
                {scanning ? "Scanning…" : "Scan for keypads"}
              </Button>
            }
          />
        </Card>
        {others}
      </div>
    );
  }

  const model = deviceModel(hello);
  const name = displayName(remembered[hello.uid]?.name, hello.uid);
  const unconfigured = setup.state === "unconfigured";

  // The one thing to do next, most urgent first.
  let primary: ReactNode = null;
  if (rescue) {
    primary = !recovery && (
      <Button
        variant="primary"
        onClick={() => {
          setRecovery(true);
          setTab("troubleshoot");
        }}
      >
        <LifeBuoy size={14} aria-hidden /> Start recovery
      </Button>
    );
  } else if (fwOutdated) {
    primary = (
      <Button variant="primary" onClick={() => void updateFirmware()} disabled={!drive} loading={updating}>
        {updating ? "Updating…" : "Update firmware"}
      </Button>
    );
  } else if (unconfigured) {
    primary = tab !== "setup" && (
      <Button variant="primary" onClick={() => setTab("setup")}>
        Set up keypad
      </Button>
    );
  } else if (setup.state === "configured") {
    primary = (
      <Button variant="primary" onClick={() => nav("keys")}>
        <Keyboard size={14} aria-hidden /> Assign keys
      </Button>
    );
  }

  const tabs: Tab[] = [
    ...(rescue
      ? []
      : [
          {
            id: "setup",
            label: "Setup",
            icon: ClipboardList,
            badge: unconfigured ? <Badge tone="amber">To do</Badge> : undefined,
          },
          { id: "test", label: "Test keys", icon: Hand },
          { id: "wiring", label: "Fix wiring", icon: Wrench },
        ]),
    {
      id: "troubleshoot",
      label: "Troubleshoot",
      icon: LifeBuoy,
      badge: rescue ? <Badge tone="red">Needed</Badge> : undefined,
    },
    {
      id: "others",
      label: "Other keypads",
      icon: Usb,
      badge: pluggedIn.length > 0 ? <Badge tone="blue">{pluggedIn.length}</Badge> : undefined,
    },
  ];
  const active: TabId = tabs.some((t) => t.id === tab) ? tab : (tabs[0].id as TabId);
  // Test keys and Fix wiring read the config — wait until it's known.
  const needsConfig = (active === "test" || active === "wiring") && setup.state !== "configured";

  const bodies: Record<TabId, () => ReactNode> = {
    setup: () => (
      <SetupTab
        cfg={setup.cfg}
        setCfg={setup.setCfg}
        state={setup.state}
        setState={setup.setState}
        onSaved={() => setTab("test")}
        onTest={() => setTab("test")}
        onFixWiring={() => setTab("wiring")}
      />
    ),
    test: () => <TestKeysTab cfg={setup.cfg} onFixWiring={() => setTab("wiring")} />,
    wiring: () => <FixWiringTab cfg={setup.cfg} setCfg={setup.setCfg} />,
    troubleshoot: () => (
      <TroubleshootTab
        rescue={rescue}
        drive={!!drive}
        deviceFw={hello.fw}
        bundledFw={bundledFw}
        fwOutdated={fwOutdated}
        updating={updating}
        recovery={recovery}
        onRestart={() => void restartKeypad()}
        onFirmware={() => void updateFirmware(!fwOutdated)}
        onRecovery={() => setRecovery(true)}
        onCloseRecovery={() => setRecovery(false)}
      />
    ),
    others: () => others,
  };

  return (
    <div className="flex w-full flex-col gap-5">
      {modal}
      <Card>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-5">
            <ProductImage model={model} className="size-20 shrink-0" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <NicknameEditor
                name={name}
                value={remembered[hello.uid]?.name ?? ""}
                placeholder={displayName(undefined, hello.uid)}
                onSave={(n) => void saveNickname(n)}
              />
              <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
                <span>{MODEL_META[model].label}</span>
                <span aria-hidden className="text-fg-faint">·</span>
                <span>{hello.key_count} keys</span>
                <span aria-hidden className="text-fg-faint">·</span>
                <FirmwareBadge rescue={rescue} fw={hello.fw} bundled={bundledFw} outdated={fwOutdated} />
                {!rescue && unconfigured && <Badge tone="amber">Not set up</Badge>}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {primary}
              <Button variant="danger" onClick={() => void disconnect()}>
                Disconnect
              </Button>
            </div>
          </div>

          {rescue && (
            <Alert tone="danger" title="The keypad's firmware didn't start">
              Its rescue console answered instead. Your macros and setup are still on the board ·
              recovery reinstalls only the firmware files and restarts it.
              {hello.err && (
                <span className="mt-1 block truncate font-mono text-xs text-fg-faint" title={hello.err}>
                  {hello.err}
                </span>
              )}
            </Alert>
          )}

          <Details
            rows={[
              ["Firmware", `v${hello.fw}${bundledFw && fwOutdated ? ` · app ships v${bundledFw}` : ""}`],
              ["Serial port", port],
              [
                "USB drive",
                isSerialDrive(drive)
                  ? "Hidden · managed by the app"
                  : drive
                    ? drive.path
                    : "Not found",
              ],
              ["Board ID", hello.uid],
            ]}
          />
        </div>
      </Card>

      <Tabs
        idPrefix="devices"
        label="Keypad sections"
        tabs={tabs}
        value={active}
        onChange={(id) => setTab(id as TabId)}
      >
        {needsConfig ? (
          <Card>
            <p className="text-sm text-fg-muted">
              {setup.state === "loading"
                ? "Reading the keypad's setup…"
                : "Set up the keypad first · the key test needs to know how it's built."}
            </p>
            {setup.state === "unconfigured" && (
              <Button className="mt-3" variant="primary" onClick={() => setTab("setup")}>
                Set up keypad
              </Button>
            )}
          </Card>
        ) : (
          bodies[active]()
        )}
      </Tabs>
    </div>
  );
}

function FirmwareBadge({
  rescue,
  fw,
  bundled,
  outdated,
}: {
  rescue: boolean;
  fw: string;
  bundled: string;
  outdated: boolean;
}) {
  if (rescue) return <Badge tone="red" dot>Rescue mode</Badge>;
  if (outdated)
    return (
      <Badge tone="amber" dot>
        Firmware {fw} · update to {bundled}
      </Badge>
    );
  if (bundled)
    return (
      <Badge tone="green" dot>
        Firmware {fw} · up to date
      </Badge>
    );
  return <Badge>Firmware {fw}</Badge>;
}

/** The keypad's name, editable in place: click the pencil, type, Enter. */
function NicknameEditor({
  name,
  value,
  placeholder,
  onSave,
}: {
  name: string;
  value: string;
  placeholder: string;
  onSave: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  if (!editing) {
    return (
      <div className="flex min-w-0 items-center gap-1.5">
        <h1 className="m-0 truncate text-[22px] font-semibold leading-tight tracking-[-0.01em] text-fg">{name}</h1>
        <IconButton label="Rename keypad" size="sm" onClick={() => setEditing(true)}>
          <Pencil size={14} aria-hidden />
        </IconButton>
      </div>
    );
  }

  const commit = () => {
    onSave(draft.trim());
    setEditing(false);
  };
  return (
    <form
      className="flex max-w-md items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        commit();
      }}
    >
      <Input
        autoFocus
        aria-label="Keypad name"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setEditing(false);
        }}
        className="flex-1"
      />
      <IconButton label="Save name" variant="secondary" type="submit">
        <Check size={16} aria-hidden />
      </IconButton>
      <IconButton label="Cancel" onClick={() => setEditing(false)}>
        <X size={16} aria-hidden />
      </IconButton>
    </form>
  );
}

/** Collapsible technical details under the hero. */
function Details({ rows }: { rows: [string, string][] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex w-max items-center gap-1.5 rounded-control text-[13px] font-strong text-fg-muted hover:text-fg focus-visible:shadow-ring focus-visible:outline-none"
      >
        <ChevronDown
          size={14}
          aria-hidden
          className={`transition-transform duration-[120ms] ease-standard ${open ? "" : "-rotate-90"}`}
        />
        Details
      </button>
      {open && (
        <dl className="grid grid-cols-1 gap-x-8 gap-y-2 pl-5 sm:grid-cols-2 xl:grid-cols-4">
          {rows.map(([k, v]) => (
            <div key={k} className="flex min-w-0 flex-col gap-0.5">
              <dt className="text-label text-fg-faint">{k}</dt>
              <dd className="truncate font-mono text-xs text-fg select-text" title={v}>
                {v}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function FirmwareModal({ progress }: { progress: FirmwareProgress | null }) {
  const pct =
    progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : null;
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Updating firmware"
      className="fixed inset-0 z-[80] flex items-center justify-center bg-scrim"
    >
      <div className="flex w-[26rem] max-w-[calc(100vw-2rem)] flex-col gap-4 rounded-card bg-raised p-5 shadow-float">
        <div className="flex items-start gap-3">
          {/* clockwise arrow so the glyph turns the same way animate-spin
              rotates it (issue #21) */}
          <RotateCw size={22} className="mt-0.5 shrink-0 animate-spin text-accent" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-strong text-fg">Updating firmware…</p>
            <p className="truncate text-xs text-fg-muted">
              {progress?.file
                ? `${progress.file} · ${Math.min(progress.index + 1, progress.files)} of ${progress.files}`
                : "Preparing…"}
            </p>
          </div>
          <span className="shrink-0 text-sm tabular-nums text-fg-muted">{pct !== null ? `${pct}%` : ""}</span>
        </div>
        {pct !== null ? (
          <ProgressBar value={pct} label="Firmware update progress" />
        ) : (
          <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-accent/60" />
          </div>
        )}
        <p className="text-xs text-fg-faint">
          Don't unplug the keypad. Its keys and menus are locked while files transfer, and every file
          is checked after it lands. The keypad restarts by itself when this finishes.
        </p>
      </div>
    </div>
  );
}

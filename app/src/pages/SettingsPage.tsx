import { useEffect, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AppWindow,
  ChevronRight,
  Info,
  Keyboard,
  Plug,
  Video,
  type LucideIcon,
} from "lucide-react";
import { ipc } from "../lib/ipc";
import { keysCache } from "../lib/keys-cache";
import { useDevice } from "../lib/device";
import { deviceModel, type Assignment, type ObsSnapshot, type UpdateInfo } from "../lib/types";
import { allKinds, categoryLabel, wheelPreview } from "../lib/kind-registry";
import { ActionIcon } from "../components/action-icons";
import { OledPreview } from "../components/OledPreview";
import {
  type ObsConfig,
  setAlwaysOnTop,
  setAutostart,
  setObsConfig,
  setRunInBackground,
  setSoundSecondary,
  setWheelAccel,
  useAlwaysOnTop,
  useAutostart,
  useObsConfig,
  useRunInBackground,
  useSoundSecondary,
  useWheelAccel,
} from "../lib/settings";
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  Select,
  SettingRow,
  Spinner,
  Switch,
  Tabs,
} from "../components/ui";
import { PermissionsCard } from "../components/Permissions";
import { RemoteControlCard } from "../components/RemoteControlCard";
import { BackupPanel } from "../components/BackupPanel";
import { useToast } from "../components/toast";
import { useConfirm } from "../components/dialog";

function SoundOutputCard() {
  const secondary = useSoundSecondary();
  const [outputs, setOutputs] = useState<string[]>([]);

  // refresh the device list every time the card mounts — virtual devices
  // (BlackHole, VB-Cable) come and go with their driver/app
  useEffect(() => {
    // Anything but an array is treated as "no devices". A backend that answers
    // null (no audio host, an older build) used to take the whole Settings page
    // down on the next render — `outputs.includes(...)` below.
    void invoke<string[]>("sound_outputs")
      .then((v) => setOutputs(Array.isArray(v) ? v : []))
      .catch(() => setOutputs([]));
  }, []);

  const options = outputs.includes(secondary ?? "")
    ? outputs
    : [...(secondary ? [secondary] : []), ...outputs];

  return (
    <Card
      title="Sound output"
      description="Sound keys always play on your default output"
    >
      <div className="flex max-w-md flex-col gap-2">
        <Field
          label="Also play sound keys into"
          hint="Pick a virtual device (BlackHole, VB-Cable) and route it into OBS or your call, so others hear the soundboard too."
        >
          <Select
            value={secondary ?? ""}
            onChange={(e) => setSoundSecondary(e.target.value || null)}
            aria-label="Secondary output device for sound keys"
          >
            <option value="">Off · default output only</option>
            {options.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Card>
  );
}

function WindowCard() {
  const pinned = useAlwaysOnTop();
  const runBg = useRunInBackground();
  const autostart = useAutostart();
  return (
    <Card title="Window">
      <div className="flex flex-col divide-y divide-line">
        <SettingRow
          title="Always on top"
          description="Keep MKYADA above other windows, like a game, while you fine-tune coordinates."
          control={
            <Switch checked={pinned} onChange={setAlwaysOnTop} aria-label="Always on top" />
          }
        />
        <SettingRow
          title="Keep running in the background"
          description="Closing the window hides MKYADA to the tray, so app-side actions and per-app profiles keep working. Quit from the tray icon."
          control={
            <Switch
              checked={runBg}
              onChange={setRunInBackground}
              aria-label="Keep running in the background"
            />
          }
        />
        <SettingRow
          title="Start at login"
          description="Launch MKYADA when you sign in, so app-side actions are always ready."
          control={<Switch checked={autostart} onChange={setAutostart} aria-label="Start at login" />}
        />
      </div>
    </Card>
  );
}

/** OBS Studio connection (obs-websocket). Keys with an "OBS" action drive
 * scenes / recording / streaming; when connected the keypad OLED band shows
 * the live scene + REC/LIVE status. */
function ObsCard() {
  const cfg = useObsConfig();
  const { hello } = useDevice();
  // the screen band is a Vision 6 thing; say nothing about it on a core6
  const vision = !hello || deviceModel(hello) === "vision6";
  const [form, setForm] = useState<ObsConfig>(cfg);
  const [status, setStatus] = useState<ObsSnapshot | null>(null);

  // reflect stored config into the form when it loads / changes elsewhere
  useEffect(() => setForm(cfg), [cfg]);

  // live connection status from the Rust client
  useEffect(() => {
    void invoke<ObsSnapshot>("obs_state").then(setStatus).catch(() => {});
    const un = listen("obs:changed", (e) => setStatus(e.payload as ObsSnapshot));
    return () => {
      un.then((f) => f());
    };
  }, []);

  const set = (patch: Partial<ObsConfig>) => setForm((f) => ({ ...f, ...patch }));
  const save = (enabled: boolean) => setObsConfig({ ...form, enabled });

  const statusBadge = !cfg.enabled ? (
    <Badge>Off</Badge>
  ) : status?.connected ? (
    <Badge tone="green">Connected{status.currentScene ? ` · ${status.currentScene}` : ""}</Badge>
  ) : status?.error ? (
    <Badge tone="red">{status.error}</Badge>
  ) : (
    <Badge tone="amber">Connecting…</Badge>
  );

  return (
    <Card
      title="OBS Studio"
      description="Switch scenes, record, stream and mute the mic from the keypad"
      actions={statusBadge}
    >
      <div className="flex max-w-xl flex-col gap-4">
        <p className="flex items-center gap-2 text-[13px] text-fg-faint">
          <Video size={15} aria-hidden className="shrink-0" />
          Turn on the WebSocket server in OBS · Tools › WebSocket Server Settings
        </p>

        <div className="grid grid-cols-[1fr_auto] gap-3">
          <Field label="Host">
            <Input
              value={form.host}
              placeholder="localhost"
              onChange={(e) => set({ host: e.target.value })}
            />
          </Field>
          <Field label="Port">
            <Input
              type="number"
              className="w-24"
              value={form.port}
              onChange={(e) => set({ port: Number(e.target.value) || 4455 })}
            />
          </Field>
        </div>
        <Field label="Password">
          <Input
            type="password"
            value={form.password}
            placeholder="From the OBS WebSocket settings"
            onChange={(e) => set({ password: e.target.value })}
          />
        </Field>

        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={() => save(true)}>
            {cfg.enabled ? "Reconnect" : "Connect"}
          </Button>
          {cfg.enabled && (
            <Button variant="default" onClick={() => save(false)}>
              Disconnect
            </Button>
          )}
        </div>

        {vision && (
          <p className="text-label text-fg-faint">
            The live scene shows on the keypad screen when “Show the active profile on screen” is
            on · Keypad tab
          </p>
        )}
      </div>
    </Card>
  );
}

/** The Vision 6 screen settings this card flips straight in config.json.
 * Each one is also reachable from the keypad's own Settings menu, so the
 * names here are exactly the config keys the firmware reads. */
type ScreenToggle = "show_layer" | "show_profile" | "wheel_layers";

/** Device-level settings that live in the keypad's own config.json. */
function KeypadCard() {
  const { hello, drive, send, disconnect, setCfg } = useDevice();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  // A usb-drive toggle restarts the keypad, which briefly drops the
  // connection. Track that so the card shows a calm "restarting" state instead
  // of every row flipping to a "connect a keypad" badge mid-reboot.
  const [restarting, setRestarting] = useState(false);
  useEffect(() => {
    if (hello) setRestarting(false);
  }, [hello]);
  const hidden = hello?.usb_drive === false;
  // firmware < 0.4.0 has no usb_drive support (no fs_* serial commands)
  const supported = hello?.usb_drive !== undefined;
  const midiOn = hello?.midi === true;
  const midiSupported = hello?.midi !== undefined;
  const vision = deviceModel(hello) === "vision6";
  // firmware < 0.9.0 has no grid band (config show_layer / show_profile)
  const bandSupported = hello?.show_layer !== undefined;
  const wheelAccel = useWheelAccel();
  // firmware < 0.25.0 doesn't report the wheel's paging mode, so the switch
  // below would have nothing to show a state from.
  const wheelLayersSupported = hello?.wheel_layers !== undefined;
  const [bandBusy, setBandBusy] = useState<ScreenToggle | null>(null);
  const [fieldBusy, setFieldBusy] = useState<string | null>(null);
  // firmware < 0.14.0 doesn't mirror prefs into config.json. This used to
  // probe `font`, which firmware 0.20.0 dropped along with the setting itself;
  // `timeout` is the field the control below actually needs, so probing for it
  // is both correct and self-explanatory.
  const prefsSupported = hello?.timeout !== undefined;

  /** Patch one display field on the keypad — set_cfg on proto v14 (live, no
   * reload, keys cache untouched — issue #45), config merge + reload before. */
  async function setKeypadField(key: string, value: unknown) {
    if (!hello || !drive) return;
    setFieldBusy(key);
    try {
      await setCfg({ [key]: value });
    } catch (e) {
      toast.error("Could not change the screen setting", String(e));
    } finally {
      setFieldBusy(null);
    }
  }

  /** Flip a screen toggle on the keypad — same live set_cfg path. */
  async function setBand(key: ScreenToggle, value: boolean) {
    if (!hello || !drive) return;
    setBandBusy(key);
    try {
      await setCfg({ [key]: value });
    } catch (e) {
      toast.error("Could not change the screen setting", String(e));
    } finally {
      setBandBusy(null);
    }
  }

  // MIDI is decided in boot.py, so this is the usb_drive dance rather than a
  // live set_cfg patch: merge into the stored config, then restart.
  async function setMidi(on: boolean) {
    if (!hello || !drive) return;
    const ok = await confirm({
      title: on ? "Turn on MIDI" : "Turn off MIDI",
      message: on
        ? "The keypad will also appear as a MIDI device called \"" +
          (deviceModel(hello) === "vision6" ? "MKYADA Vision 6" : "MKYADA Keypad") +
          "\", so MIDI keys can drive a DAW directly with no app in between.\n\n" +
          "The keypad restarts now. Note: MIDI stays off while the USB drive is " +
          "visible, because the two together exceed what the chip can present at once."
        : "The keypad will stop presenting a MIDI port, and MIDI keys will do nothing." +
          "\n\nThe keypad restarts now.",
      confirmLabel: on ? "Turn on MIDI" : "Turn off MIDI",
    });
    if (!ok) return;
    setBusy(true);
    try {
      let cfg: Record<string, unknown> = {};
      try {
        cfg = JSON.parse(await ipc.driveRead(drive.path, "config.json"));
      } catch {
        // fresh board without a config — the firmware defaults the rest
      }
      await ipc.driveWrite(
        drive.path,
        "config.json",
        JSON.stringify({ ...cfg, midi: on }, null, 2),
      );
      await ipc.driveEject(drive.path).catch(() => {});
      setRestarting(true);
      await send({ t: "reset" }).catch(() => {});
      await disconnect().catch(() => {});
      toast.success(
        "Keypad restarting",
        on
          ? "It will reconnect with a MIDI port. In your DAW, enable it as a MIDI input."
          : "It will reconnect without a MIDI port.",
      );
    } catch (e) {
      toast.error("Could not change the MIDI setting", String(e));
    } finally {
      setBusy(false);
    }
  }

  async function setHidden(hide: boolean) {
    if (!hello || !drive) return;
    const ok = await confirm({
      title: hide ? "Hide the USB drive" : "Show the USB drive",
      message: hide
        ? "The keypad will stop showing up as a flash drive. Keys, macros and setup are " +
          "managed entirely from this app, with files travelling over the serial connection, " +
          "like a finished product.\n\nThe keypad restarts now. Recovery: hold key 1 " +
          "while plugging it in to force the drive back on."
        : "The keypad will show up as a USB drive (CIRCUITPY) again, raw JSON files and " +
          "all.\n\nThe keypad restarts now.",
      confirmLabel: hide ? "Hide drive" : "Show drive",
    });
    if (!ok) return;
    setBusy(true);
    try {
      // merge into the stored config so key/layer setup survives the toggle
      let cfg: Record<string, unknown> = {};
      try {
        cfg = JSON.parse(await ipc.driveRead(drive.path, "config.json"));
      } catch {
        // fresh board without a config — the firmware defaults the rest
      }
      await ipc.driveWrite(
        drive.path,
        "config.json",
        JSON.stringify({ ...cfg, usb_drive: !hide }, null, 2),
      );
      // the drive identity flips (mount ↔ serial) — forget every snapshot
      keysCache.invalidate();
      // Same restart dance as the Devices page: clean unmount, reset, drop
      // the dead connection so auto-connect reattaches after the reboot.
      await ipc.driveEject(drive.path).catch(() => {});
      setRestarting(true);
      await send({ t: "reset" }).catch(() => {});
      await disconnect().catch(() => {});
      toast.success(
        "Keypad restarting",
        hide
          ? "It will reconnect without a USB drive. This app keeps full access."
          : "It will reconnect with its USB drive visible.",
      );
    } catch (e) {
      toast.error("Could not change the drive setting", String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!hello) {
    // No device (or one mid-restart): one calm line instead of a column of
    // amber "connect a keypad" / "needs firmware" badges on every row.
    return (
      <Card title="Keypad">
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-fg-muted">
          {restarting ? (
            <>
              <Spinner size={14} /> Keypad is restarting…
            </>
          ) : (
            "Connect a keypad to change its settings."
          )}
        </div>
      </Card>
    );
  }

  /** Firmware too old for a setting: a quiet badge where the switch would be. */
  const needs = (v: string) => <Badge tone="amber">Needs firmware {v}+</Badge>;

  return (
    <Card title="Keypad">
      <div className="flex flex-col divide-y divide-line">
        <SettingRow
          title="Hide the keypad's USB drive"
          description="The keypad stops showing up as a flash drive and this app manages it over the serial link. Hold key 1 while plugging in to bring the drive back."
          control={
            !supported ? (
              needs("0.4.0")
            ) : (
              <Switch
                checked={hidden}
                loading={busy}
                disabled={!drive}
                onChange={(v) => void setHidden(v)}
                aria-label="Hide the keypad's USB drive"
              />
            )
          }
        />

        <SettingRow
          title="Present a MIDI port"
          description="MIDI keys send notes and control changes straight into a DAW, no app needed. Needs the USB drive hidden: the chip can't present both at once."
          control={
            !midiSupported ? (
              needs("0.29.0")
            ) : !hidden ? (
              <Badge>Hide the USB drive first</Badge>
            ) : (
              <Switch
                checked={midiOn}
                loading={busy}
                disabled={!drive}
                onChange={(v) => void setMidi(v)}
                aria-label="Present a MIDI port"
              />
            )
          }
        />

        {vision && (
          <>
            <SettingRow
              title="Show the active layer on screen"
              description="A band above the key grid names the layer you're on. Macro names squeeze a little to make room."
              control={
                !bandSupported ? (
                  needs("0.9.0")
                ) : (
                  <Switch
                    checked={!!hello?.show_layer}
                    loading={bandBusy === "show_layer"}
                    disabled={!drive || bandBusy !== null}
                    onChange={(v) => void setBand("show_layer", v)}
                    aria-label="Show the active layer on screen"
                  />
                )
              }
            />
            <SettingRow
              title="Show the active profile on screen"
              description="The band also names the per-app profile in use and the live OBS scene. Needs this app running."
              control={
                !bandSupported ? (
                  needs("0.9.0")
                ) : (
                  <Switch
                    checked={!!hello?.show_profile}
                    loading={bandBusy === "show_profile"}
                    disabled={!drive || bandBusy !== null}
                    onChange={(v) => void setBand("show_profile", v)}
                    aria-label="Show the active profile on screen"
                  />
                )
              }
            />
            <SettingRow
              title="Wheel walks layers too"
              description="Turning past the last key moves on to the next layer's first key. Also on the keypad: Settings · Wheel layers."
              control={
                !wheelLayersSupported ? (
                  needs("0.25.0")
                ) : (
                  <Switch
                    checked={!!hello?.wheel_layers}
                    loading={bandBusy === "wheel_layers"}
                    disabled={!drive || bandBusy !== null}
                    onChange={(v) => void setBand("wheel_layers", v)}
                    aria-label="Wheel walks layers too"
                  />
                )
              }
            />
            <SettingRow
              title="Auto-return to the key grid"
              description="Idle time before the screen leaves a menu for the key grid. Also on the keypad: Settings · Auto-return."
              control={
                !prefsSupported ? (
                  needs("0.14.0")
                ) : (
                  <Select
                    value={hello?.timeout ?? 10}
                    disabled={!drive || fieldBusy !== null}
                    className="w-36"
                    aria-label="Auto-return idle seconds"
                    onChange={(e) => void setKeypadField("timeout", Number(e.target.value))}
                  >
                    {[3, 4, 5, 10, 15, 20, 30, 45, 60].map((s) => (
                      <option key={s} value={s}>
                        {s} seconds
                      </option>
                    ))}
                  </Select>
                )
              }
            />
          </>
        )}

        {/* core6 has no wheel, so there's nothing to accelerate */}
        {(!hello || vision) && (
          <SettingRow
            title="Wheel acceleration"
            description="For app-side wheel actions like scroll and zoom: a fast spin takes bigger steps. Off is one step per detent."
            control={
              <Switch checked={wheelAccel} onChange={setWheelAccel} aria-label="Wheel acceleration" />
            }
          />
        )}
      </div>
    </Card>
  );
}

/** Vision 6 reference: what pressing the wheel does for each action kind.
 * Generated from the kind registry so it can never drift from the device.
 * Three previews up front; the full per-action list folds away. */
function WheelMenuCard() {
  const { hello } = useDevice();
  if (deviceModel(hello) !== "vision6") return null;
  const examples: { a: Assignment; cap: string }[] = [
    { a: { kind: "text", text: "" }, cap: "Speed" },
    { a: { kind: "keystroke", key: "z" }, cap: "Action card" },
    { a: { kind: "obs", action: "setScene", sceneName: "Live" }, cap: "Scene picker" },
  ];
  const kinds = allKinds().filter((k) => k.id !== "none" && k.id !== "nothing");
  return (
    <Card
      title="Wheel menu"
      description="Press the wheel on a key and the screen opens a menu that fits its action"
    >
      <div className="flex flex-wrap gap-5">
        {examples.map((ex) => (
          <figure key={ex.cap} className="flex flex-col items-center gap-1.5">
            <OledPreview preview={wheelPreview(ex.a)} scale={1.4} />
            <figcaption className="text-label text-fg-faint">{ex.cap}</figcaption>
          </figure>
        ))}
      </div>
      <details className="group/all mt-4 border-t border-line pt-3">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-control text-[13px] font-strong text-fg-muted hover:text-fg [&::-webkit-details-marker]:hidden">
          <ChevronRight
            size={14}
            aria-hidden
            className="transition-transform duration-[120ms] ease-standard group-open/all:rotate-90"
          />
          Show all {kinds.length} actions
        </summary>
        {/* Same order AND the same group headings as the action-type dropdown
          * in the editor: this is that list, annotated. */}
        <div className="mt-2 grid grid-cols-1 gap-x-6 lg:grid-cols-2">
          {kinds.map((k, i) => (
            <div key={k.id} className="contents">
              {k.category !== kinds[i - 1]?.category && (
                <div className="col-span-full pb-1 pt-3 text-label font-medium tracking-label text-fg-faint [font-stretch:90%]">
                  {categoryLabel(k.category)}
                </div>
              )}
              <div className="flex items-start gap-2.5 py-1.5">
                <ActionIcon name={k.icon} size={26} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-strong text-fg">{k.label}</span>
                    {k.host && <Badge tone="amber">Needs app</Badge>}
                  </div>
                  <p className="text-label leading-snug text-fg-faint">{k.wheel.summary}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </details>
    </Card>
  );
}

function AboutCard() {
  const [version, setVersion] = useState("");
  useEffect(() => {
    void getVersion().then(setVersion);
  }, []);
  return (
    <Card title="About">
      <div className="flex items-center gap-4">
        <img src="/mkyada-logo.png" alt="" className="size-14 shrink-0 rounded-card" />
        <div className="flex min-w-0 flex-col gap-1 text-sm">
          <p className="text-title font-semibold text-fg">MKYADA</p>
          <p className="text-fg-muted">Macro Keypad You Always Dream About</p>
          <p className="text-label text-fg-faint tabular-nums">
            App version {version || "…"} ·{" "}
            <button
              type="button"
              className="text-accent underline underline-offset-2 hover:text-fg"
              onClick={() => void openUrl("https://github.com/asilbalaban/MKYADA")}
            >
              github.com/asilbalaban/MKYADA
            </button>
          </p>
        </div>
      </div>
    </Card>
  );
}

function UpdatesCard() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");

  async function check() {
    setChecking(true);
    setError("");
    try {
      setUpdate(await ipc.checkUpdate());
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  }

  return (
    <Card title="Updates">
      <div className="flex flex-col gap-3 text-sm">
        <div className="flex items-center gap-3">
          <Button onClick={() => void check()} loading={checking}>
            {checking ? "Checking…" : "Check for updates"}
          </Button>
          {update &&
            (update.available ? (
              <Badge tone="amber">v{update.latest} available</Badge>
            ) : (
              <Badge tone="green">Up to date · v{update.current}</Badge>
            ))}
        </div>
        {update?.available && (
          <div className="flex items-center gap-2">
            <span className="text-fg-muted">
              v{update.latest} is out · you're on v{update.current}.
            </span>
            <Button variant="primary" onClick={() => void openUrl(update.url)}>
              Open release page
            </Button>
          </div>
        )}
        {error && (
          <Alert tone="danger" title="Could not check for updates">
            {error}
          </Alert>
        )}
      </div>
    </Card>
  );
}

/** The page used to be one column of nine unrelated cards — the keypad's own
 * config sat between an OBS password and a theme picker, and finding anything
 * meant scrolling past everything. Grouped by *what a setting belongs to*: the
 * keypad, another program, this app, the product itself. */
const TABS: { id: string; label: string; icon: LucideIcon; body: () => ReactNode }[] = [
  {
    id: "keypad",
    label: "Keypad",
    icon: Keyboard,
    body: () => (
      <>
        <KeypadCard />
        <WheelMenuCard />
        <BackupPanel />
      </>
    ),
  },
  {
    id: "integrations",
    label: "Integrations",
    icon: Plug,
    body: () => (
      <>
        <ObsCard />
        <SoundOutputCard />
      </>
    ),
  },
  {
    id: "app",
    label: "Application",
    icon: AppWindow,
    body: () => (
      <>
        <PermissionsCard />
        <WindowCard />
        <RemoteControlCard />
      </>
    ),
  },
  {
    id: "about",
    label: "About",
    icon: Info,
    body: () => (
      <>
        <AboutCard />
        <UpdatesCard />
      </>
    ),
  },
];

export function SettingsPage({ openTab }: { openTab?: { id: string } | null }) {
  const [tab, setTab] = useState(openTab?.id ?? TABS[0].id);
  // A fresh object per request, so repeated jumps to the same tab still land
  // even if the user has since switched away.
  useEffect(() => {
    if (openTab) setTab(openTab.id);
  }, [openTab]);
  const active = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <div className="flex flex-col gap-4 w-full">
      <Tabs
        idPrefix="settings"
        label="Settings sections"
        tabs={TABS}
        value={active.id}
        onChange={setTab}
      >
        {active.body()}
      </Tabs>
    </div>
  );
}

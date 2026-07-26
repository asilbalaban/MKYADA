import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AppWindow, Gauge, HardDrive, Layers, Monitor, Moon, Pin, Power, Rocket, Sun, Type, Video } from "lucide-react";
import { ipc } from "../lib/ipc";
import { keysCache } from "../lib/keys-cache";
import { useDevice } from "../lib/device";
import { deviceModel, type Assignment, type ObsSnapshot, type UpdateInfo } from "../lib/types";
import { allKinds, wheelPreview } from "../lib/kind-registry";
import { ActionIcon } from "../components/action-icons";
import { OledPreview } from "../components/OledPreview";
import {
  type ObsConfig,
  setAlwaysOnTop,
  setAutostart,
  setObsConfig,
  setRunInBackground,
  setSoundSecondary,
  setThemePref,
  setWheelAccel,
  ThemePref,
  useAlwaysOnTop,
  useAutostart,
  useObsConfig,
  useRunInBackground,
  useSoundSecondary,
  useThemePref,
  useWheelAccel,
} from "../lib/settings";
import { Badge, Button, Card, Field, Input, Select, Spinner } from "../components/ui";
import { PermissionsCard } from "../components/Permissions";
import { useToast } from "../components/toast";
import { useConfirm } from "../components/dialog";

const THEME_OPTIONS: { value: ThemePref; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

function SoundOutputCard() {
  const secondary = useSoundSecondary();
  const [outputs, setOutputs] = useState<string[]>([]);

  // refresh the device list every time the card mounts — virtual devices
  // (BlackHole, VB-Cable) come and go with their driver/app
  useEffect(() => {
    void invoke<string[]>("sound_outputs")
      .then(setOutputs)
      .catch(() => setOutputs([]));
  }, []);

  const options = outputs.includes(secondary ?? "")
    ? outputs
    : [...(secondary ? [secondary] : []), ...outputs];

  return (
    <Card title="Sound output">
      <div className="flex flex-col gap-2">
        <Field label="Also play sound keys into">
          <Select
            value={secondary ?? ""}
            onChange={(e) => setSoundSecondary(e.target.value || null)}
            aria-label="Secondary output device for sound keys"
          >
            <option value="">Off — default output only</option>
            {options.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
        <p className="text-xs text-fg-faint">
          Sounds always play on your default output. Pick a virtual device
          (e.g. BlackHole or VB-Cable) here and route it into OBS or your
          call, so your audience hears the soundboard at the same time you
          do.
        </p>
      </div>
    </Card>
  );
}

function AppearanceCard() {
  const pref = useThemePref();
  return (
    <Card title="Appearance">
      <div className="flex gap-2" role="radiogroup" aria-label="Theme">
        {THEME_OPTIONS.map((o) => (
          <Button
            key={o.value}
            variant={pref === o.value ? "primary" : "default"}
            role="radio"
            aria-checked={pref === o.value}
            onClick={() => setThemePref(o.value)}
          >
            <o.icon size={14} aria-hidden /> {o.label}
          </Button>
        ))}
      </div>
      <p className="text-xs text-fg-faint mt-2">
        System follows your OS appearance automatically.
      </p>
    </Card>
  );
}

function WindowCard() {
  const pinned = useAlwaysOnTop();
  const runBg = useRunInBackground();
  const autostart = useAutostart();
  return (
    <Card title="Window">
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-0.5 text-sm">
            <span className="text-fg font-medium">Always on top</span>
            <span className="text-xs text-fg-faint">
              Keep MKYADA above other windows (like a game) while you fine-tune macro
              coordinates.
            </span>
          </div>
          <Button
            variant={pinned ? "primary" : "default"}
            role="switch"
            aria-checked={pinned}
            onClick={() => setAlwaysOnTop(!pinned)}
          >
            <Pin size={14} aria-hidden className={pinned ? "" : "rotate-45"} />
            {pinned ? "On" : "Off"}
          </Button>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-0.5 text-sm">
            <span className="text-fg font-medium">Keep running in the background</span>
            <span className="text-xs text-fg-faint">
              Closing the window hides MKYADA to the system tray, so key actions
              (open app, run command, sounds) and per-app profiles keep working.
              Quit for real from the tray icon.
            </span>
          </div>
          <Button
            variant={runBg ? "primary" : "default"}
            role="switch"
            aria-checked={runBg}
            onClick={() => setRunInBackground(!runBg)}
          >
            <Power size={14} aria-hidden />
            {runBg ? "On" : "Off"}
          </Button>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-0.5 text-sm">
            <span className="text-fg font-medium">Start at login</span>
            <span className="text-xs text-fg-faint">
              Launch MKYADA automatically when you sign in, so the keypad's
              computer-side actions are always ready.
            </span>
          </div>
          <Button
            variant={autostart ? "primary" : "default"}
            role="switch"
            aria-checked={autostart}
            onClick={() => setAutostart(!autostart)}
          >
            <Rocket size={14} aria-hidden />
            {autostart ? "On" : "Off"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** OBS Studio connection (obs-websocket). Keys with an "OBS" action drive
 * scenes / recording / streaming; when connected the keypad OLED band shows
 * the live scene + REC/LIVE status. */
function ObsCard() {
  const cfg = useObsConfig();
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
    <Card title="OBS Studio">
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-0.5 text-sm">
            <span className="text-fg font-medium flex items-center gap-2">
              <Video size={15} aria-hidden /> obs-websocket
            </span>
            <span className="text-xs text-fg-faint">
              Control OBS from the keypad — scene switch, record/stream, mic mute — and
              show the live scene on the Vision 6 screen. Enable it in OBS under
              Tools → WebSocket Server Settings.
            </span>
          </div>
          {statusBadge}
        </div>

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
            placeholder="from OBS WebSocket settings"
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

        <p className="text-xs text-fg-faint">
          The live scene / REC / LIVE status shows on the keypad band — turn on
          "Show profile band" (Keypad settings) for it to appear.
        </p>
      </div>
    </Card>
  );
}

/** Device-level settings that live in the keypad's own config.json. */
function KeypadCard() {
  const { hello, drive, send, disconnect, writeAndReload } = useDevice();
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
  const vision = deviceModel(hello) === "vision6";
  // firmware < 0.9.0 has no grid band (config show_layer / show_profile)
  const bandSupported = hello?.show_layer !== undefined;
  const wheelAccel = useWheelAccel();
  const [bandBusy, setBandBusy] = useState<"show_layer" | "show_profile" | null>(null);
  const [fieldBusy, setFieldBusy] = useState<string | null>(null);
  // firmware < 0.14.0 doesn't mirror font/timeout into config.json
  const prefsSupported = hello?.font !== undefined;

  /** Merge one field into the keypad's config.json and reload the firmware. */
  async function setKeypadField(key: string, value: unknown) {
    if (!hello || !drive) return;
    setFieldBusy(key);
    try {
      let cfg: Record<string, unknown> = {};
      try {
        cfg = JSON.parse(await ipc.driveRead(drive.path, "config.json"));
      } catch {
        // fresh board without a config — the firmware defaults the rest
      }
      await writeAndReload([
        { path: "config.json", content: JSON.stringify({ ...cfg, [key]: value }, null, 2) },
      ]);
    } catch (e) {
      toast.error("Could not change the screen setting", String(e));
    } finally {
      setFieldBusy(null);
    }
  }

  /** Flip a band toggle in the keypad's config.json and reload the firmware. */
  async function setBand(key: "show_layer" | "show_profile", value: boolean) {
    if (!hello || !drive) return;
    setBandBusy(key);
    try {
      // merge into the stored config so key/layer setup survives the toggle
      let cfg: Record<string, unknown> = {};
      try {
        cfg = JSON.parse(await ipc.driveRead(drive.path, "config.json"));
      } catch {
        // fresh board without a config — the firmware defaults the rest
      }
      await writeAndReload([
        { path: "config.json", content: JSON.stringify({ ...cfg, [key]: value }, null, 2) },
      ]);
    } catch (e) {
      toast.error("Could not change the screen setting", String(e));
    } finally {
      setBandBusy(null);
    }
  }

  async function setHidden(hide: boolean) {
    if (!hello || !drive) return;
    const ok = await confirm({
      title: hide ? "Hide the USB drive" : "Show the USB drive",
      message: hide
        ? "The keypad will stop showing up as a flash drive. Keys, macros and setup are " +
          "managed entirely from this app — files travel over the serial connection, " +
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
          ? "It will reconnect without a USB drive — this app keeps full access."
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

  return (
    <Card title="Keypad">
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-0.5 text-sm">
            <span className="text-fg font-medium">Hide the keypad's USB drive</span>
            <span className="text-xs text-fg-faint">
              Finished-product mode: the keypad no longer appears as a flash drive full of
              system files — this app manages everything over the serial connection instead.
              Off by default. Hold key 1 while plugging in to force the drive back (recovery).
            </span>
          </div>
          {!hello ? (
            <Badge tone="amber">connect a keypad</Badge>
          ) : !supported ? (
            <Badge tone="amber">needs firmware ≥ 0.4.0</Badge>
          ) : (
            <Button
              variant={hidden ? "primary" : "default"}
              role="switch"
              aria-checked={hidden}
              loading={busy}
              disabled={!drive}
              onClick={() => void setHidden(!hidden)}
            >
              <HardDrive size={14} aria-hidden />
              {hidden ? "Hidden" : "Visible"}
            </Button>
          )}
        </div>

        {vision && (
          <>
            <div className="flex items-center justify-between gap-4">
              <div className="flex flex-col gap-0.5 text-sm">
                <span className="text-fg font-medium">Show the active layer on screen</span>
                <span className="text-xs text-fg-faint">
                  A band above the key grid names the layer you're on (Layer A, B, …),
                  so a glance tells you which six macros are live. Macro names squeeze
                  a little to make room.
                </span>
              </div>
              {!bandSupported ? (
                <Badge tone="amber">needs firmware ≥ 0.9.0</Badge>
              ) : (
                <Button
                  variant={hello?.show_layer ? "primary" : "default"}
                  role="switch"
                  aria-checked={!!hello?.show_layer}
                  loading={bandBusy === "show_layer"}
                  disabled={!drive || bandBusy !== null}
                  onClick={() => void setBand("show_layer", !hello?.show_layer)}
                >
                  <Layers size={14} aria-hidden />
                  {hello?.show_layer ? "On" : "Off"}
                </Button>
              )}
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="flex flex-col gap-0.5 text-sm">
                <span className="text-fg font-medium">Show the active profile on screen</span>
                <span className="text-xs text-fg-faint">
                  The band also shows which per-app profile is driving the keys
                  (Profiles tab), following the app in the foreground. Needs this app
                  running; shares the band with the layer name.
                </span>
              </div>
              {!bandSupported ? (
                <Badge tone="amber">needs firmware ≥ 0.9.0</Badge>
              ) : (
                <Button
                  variant={hello?.show_profile ? "primary" : "default"}
                  role="switch"
                  aria-checked={!!hello?.show_profile}
                  loading={bandBusy === "show_profile"}
                  disabled={!drive || bandBusy !== null}
                  onClick={() => void setBand("show_profile", !hello?.show_profile)}
                >
                  <AppWindow size={14} aria-hidden />
                  {hello?.show_profile ? "On" : "Off"}
                </Button>
              )}
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="flex flex-col gap-0.5 text-sm">
                <span className="text-fg font-medium">Screen font size</span>
                <span className="text-xs text-fg-faint">
                  How big the macro names on the keypad's screen are. Larger fits fewer
                  characters per key. Also changeable on the device (Settings → Font).
                </span>
              </div>
              {!prefsSupported ? (
                <Badge tone="amber">needs firmware ≥ 0.14.0</Badge>
              ) : (
                <div className="flex gap-1.5 shrink-0">
                  {["Small", "Medium", "Large"].map((label, i) => (
                    <Button
                      key={label}
                      variant={hello?.font === i ? "primary" : "default"}
                      loading={fieldBusy === "font"}
                      disabled={!drive || fieldBusy !== null}
                      onClick={() => void setKeypadField("font", i)}
                    >
                      {i === 0 && <Type size={12} aria-hidden />}
                      {label}
                    </Button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="flex flex-col gap-0.5 text-sm">
                <span className="text-fg font-medium">Auto-return to the key grid</span>
                <span className="text-xs text-fg-faint">
                  After this many idle seconds the screen leaves a menu and returns to the
                  key grid. Also changeable on the device (Settings → Auto-return).
                </span>
              </div>
              {!prefsSupported ? (
                <Badge tone="amber">needs firmware ≥ 0.14.0</Badge>
              ) : (
                <Select
                  value={hello?.timeout ?? 10}
                  disabled={!drive || fieldBusy !== null}
                  className="shrink-0"
                  aria-label="Auto-return idle seconds"
                  onChange={(e) => void setKeypadField("timeout", Number(e.target.value))}
                >
                  {[3, 4, 5, 10, 15, 20, 30, 45, 60].map((s) => (
                    <option key={s} value={s}>
                      {s} seconds
                    </option>
                  ))}
                </Select>
              )}
            </div>
          </>
        )}

        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-0.5 text-sm">
            <span className="text-fg font-medium">Wheel acceleration</span>
            <span className="text-xs text-fg-faint">
              Profile wheel actions (scroll, zoom): spinning the wheel fast multiplies
              the step, like a real mouse wheel — a quick flick zooms right in. Off =
              exactly one step per detent, however fast the spin.
            </span>
          </div>
          <Button
            variant={wheelAccel ? "primary" : "default"}
            role="switch"
            aria-checked={wheelAccel}
            onClick={() => setWheelAccel(!wheelAccel)}
          >
            <Gauge size={14} aria-hidden />
            {wheelAccel ? "On" : "Off"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** Vision 6 reference: what pressing the wheel does for each action kind.
 * Generated from the kind registry so it can never drift from the device. */
function WheelMenuCard() {
  const { hello } = useDevice();
  if (deviceModel(hello) !== "vision6") return null;
  const examples: { a: Assignment; cap: string }[] = [
    { a: { kind: "text", text: "" }, cap: "Speed" },
    { a: { kind: "keystroke", key: "z" }, cap: "Action card" },
    { a: { kind: "obs", action: "setScene", sceneName: "Live" }, cap: "Scene picker" },
  ];
  return (
    <Card title="Wheel menu (Vision 6)">
      <p className="text-sm text-fg-muted mb-3">
        Turn the wheel to pick a key, then press it — the screen opens a menu that fits that
        key's action instead of always the speed editor. Here's what each action shows.
      </p>
      <div className="flex flex-wrap gap-4 mb-4">
        {examples.map((ex) => (
          <figure key={ex.cap} className="flex flex-col items-center gap-1.5">
            <OledPreview preview={wheelPreview(ex.a)} scale={1.6} />
            <figcaption className="text-xs text-fg-faint">{ex.cap}</figcaption>
          </figure>
        ))}
      </div>
      <div className="flex flex-col divide-y divide-line">
        {allKinds()
          .filter((k) => k.id !== "none" && k.id !== "nothing")
          .map((k) => (
            <div key={k.id} className="flex items-center gap-3 py-2">
              <ActionIcon name={k.icon} size={30} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-fg">{k.label}</span>
                  <Badge tone={k.host ? "amber" : "green"}>
                    {k.host ? "needs app" : "standalone"}
                  </Badge>
                </div>
                <p className="text-xs text-fg-faint">{k.wheel.summary}</p>
              </div>
            </div>
          ))}
      </div>
    </Card>
  );
}

export function SettingsPage() {
  const [version, setVersion] = useState("");
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void getVersion().then(setVersion);
  }, []);

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
    <div className="flex flex-col gap-4 max-w-3xl mx-auto w-full">
      {/* Info & maintenance first */}
      <Card title="About">
        <div className="flex flex-col gap-2 text-sm text-fg">
          <p>
            <span className="font-semibold">MKYADA</span> — Macro Keypad You Always Dream About
          </p>
          <p className="text-fg-faint">App version {version || "…"}</p>
          <Button variant="ghost" className="self-start px-0 text-accent"
            onClick={() => void openUrl("https://github.com/asilbalaban/MKYADA")}>
            github.com/asilbalaban/MKYADA
          </Button>
        </div>
      </Card>

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
                <Badge tone="green">up to date (v{update.current})</Badge>
              ))}
          </div>
          {update?.available && (
            <div className="flex items-center gap-2">
              <span className="text-fg-muted">
                v{update.latest} is out — you're on v{update.current}.
              </span>
              <Button variant="primary" onClick={() => void openUrl(update.url)}>
                Open release page
              </Button>
            </div>
          )}
          {error && <p className="text-danger text-xs">{error}</p>}
        </div>
      </Card>

      {/* Keypad & system access */}
      <KeypadCard />
      <WheelMenuCard />
      <PermissionsCard />

      {/* Integrations */}
      <ObsCard />
      <SoundOutputCard />

      {/* App look & behavior */}
      <AppearanceCard />
      <WindowCard />
    </div>
  );
}

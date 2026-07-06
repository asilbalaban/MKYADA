import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { HardDrive, MicOff, Monitor, Moon, Pin, Power, Rocket, Sun } from "lucide-react";
import { ipc } from "../lib/ipc";
import { keysCache } from "../lib/keys-cache";
import { useDevice } from "../lib/device";
import type { UpdateInfo } from "../lib/types";
import {
  setAlwaysOnTop,
  setAutostart,
  setLedMicFeedback,
  setRunInBackground,
  setThemePref,
  ThemePref,
  useAlwaysOnTop,
  useAutostart,
  useLedMicFeedback,
  useRunInBackground,
  useThemePref,
} from "../lib/settings";
import { Badge, Button, Card } from "../components/ui";
import { PermissionsCard } from "../components/Permissions";
import { SystemStatusStrip } from "../components/SystemStatus";
import { useToast } from "../components/toast";
import { useConfirm } from "../components/dialog";

const THEME_OPTIONS: { value: ThemePref; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

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

/** Device-level settings that live in the keypad's own config.json. */
function KeypadCard() {
  const { hello, drive, send, disconnect } = useDevice();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const hidden = hello?.usb_drive === false;
  // firmware < 0.4.0 has no usb_drive support (no fs_* serial commands)
  const supported = hello?.usb_drive !== undefined;

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

  return (
    <Card title="Keypad">
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
    </Card>
  );
}

function FeedbackCard() {
  const ledMic = useLedMicFeedback();
  return (
    <Card title="Live feedback">
      <div className="flex flex-col gap-3">
        <SystemStatusStrip />
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-0.5 text-sm">
            <span className="text-fg font-medium">Keypad LED shows mic status</span>
            <span className="text-xs text-fg-faint">
              The keypad's LED turns solid red while your microphone is muted —
              a glance tells you if you're live. Reverts the moment the app
              disconnects.
            </span>
          </div>
          <Button
            variant={ledMic ? "primary" : "default"}
            role="switch"
            aria-checked={ledMic}
            onClick={() => setLedMicFeedback(!ledMic)}
          >
            <MicOff size={14} aria-hidden />
            {ledMic ? "On" : "Off"}
          </Button>
        </div>
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
      <AppearanceCard />
      <WindowCard />
      <KeypadCard />
      <FeedbackCard />
      <PermissionsCard />
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
    </div>
  );
}

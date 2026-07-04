import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Monitor, Moon, Sun } from "lucide-react";
import { ipc } from "../lib/ipc";
import type { UpdateInfo } from "../lib/types";
import { setThemePref, ThemePref, useThemePref } from "../lib/settings";
import { Badge, Button, Card } from "../components/ui";
import { PermissionsCard } from "../components/Permissions";

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
      <PermissionsCard />
      <Card title="About">
        <div className="flex flex-col gap-2 text-sm text-fg">
          <p>
            <span className="font-semibold">MKYADA</span> — Macro Keyboard You Always Dream About
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

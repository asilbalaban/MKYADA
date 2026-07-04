import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { OverlayView } from "./components/OverlayView";
import { DeviceProvider, useDevice } from "./lib/device";
import { ProfilesProvider } from "./lib/profiles";
import { ipc } from "./lib/ipc";
import type { UpdateInfo } from "./lib/types";
import { Badge, Button } from "./components/ui";
import { PermissionsBanner } from "./components/Permissions";
import { DevicesPage } from "./pages/DevicesPage";
import { SetupPage } from "./pages/SetupPage";
import { KeysPage } from "./pages/KeysPage";
import { RecorderPage } from "./pages/RecorderPage";
import { ProfilesPage } from "./pages/ProfilesPage";
import { SettingsPage } from "./pages/SettingsPage";

type Page = "devices" | "setup" | "keys" | "recorder" | "profiles" | "settings";

const NAV: { id: Page; label: string; icon: string }[] = [
  { id: "devices", label: "Devices", icon: "⌨" },
  { id: "setup", label: "Setup", icon: "✦" },
  { id: "keys", label: "Keys", icon: "▦" },
  { id: "recorder", label: "Recorder", icon: "●" },
  { id: "profiles", label: "Profiles", icon: "▤" },
  { id: "settings", label: "Settings", icon: "⚙" },
];

function Shell() {
  const [page, setPage] = useState<Page>("devices");
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const { hello, port } = useDevice();

  // Non-blocking update check on launch.
  useEffect(() => {
    ipc
      .checkUpdate()
      .then((u) => u.available && setUpdate(u))
      .catch(() => {});
  }, []);

  return (
    <div className="flex h-screen">
      <aside className="w-48 shrink-0 border-r border-line bg-panel flex flex-col">
        <div className="px-4 py-4 border-b border-line">
          <h1 className="font-black tracking-widest text-accent">MKYADA</h1>
          <p className="text-[10px] text-slate-500 leading-tight mt-1">
            Macro Keyboard You Always Dream About
          </p>
        </div>
        <nav className="flex-1 py-2">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => setPage(n.id)}
              className={`w-full text-left px-4 py-2 text-sm flex items-center gap-2 transition-colors
                ${page === n.id ? "bg-panel2 text-accent border-r-2 border-accent" : "text-slate-400 hover:text-slate-200"}`}
            >
              <span className="w-4 text-center">{n.icon}</span> {n.label}
            </button>
          ))}
        </nav>
        <div className="px-4 py-3 border-t border-line">
          {port && hello ? (
            <Badge tone="green">● {hello.key_count}-key connected</Badge>
          ) : (
            <Badge>○ no device</Badge>
          )}
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <PermissionsBanner onOpenSettings={() => setPage("settings")} />
        {update && (
          <div className="flex items-center justify-between bg-amber-900/30 border-b border-amber-800 px-4 py-2 text-sm">
            <span>
              MKYADA v{update.latest} is available (you're on v{update.current}).
            </span>
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => void openUrl(update.url)}>
                Open release page
              </Button>
              <Button variant="ghost" onClick={() => setUpdate(null)}>
                Later
              </Button>
            </div>
          </div>
        )}
        <main className="flex-1 overflow-auto p-5">
          {page === "devices" && <DevicesPage onConnected={() => setPage("keys")} />}
          {page === "setup" && <SetupPage onDone={() => setPage("keys")} />}
          {page === "keys" && <KeysPage />}
          {page === "recorder" && <RecorderPage />}
          {page === "profiles" && <ProfilesPage />}
          {page === "settings" && <SettingsPage />}
        </main>
      </div>
    </div>
  );
}

export default function App() {
  // The transparent path-overlay window runs the same bundle with a
  // different window label and renders only the overlay view.
  if (getCurrentWindow().label === "overlay") {
    return <OverlayView />;
  }
  return (
    <DeviceProvider>
      <ProfilesProvider>
        <Shell />
      </ProfilesProvider>
    </DeviceProvider>
  );
}

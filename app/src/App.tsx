import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Circle,
  Keyboard,
  LayoutGrid,
  LucideIcon,
  Settings,
  SlidersHorizontal,
  Wand2,
} from "lucide-react";
import { OverlayView } from "./components/OverlayView";
import { DeviceProvider, useDevice } from "./lib/device";
import { ProfilesProvider } from "./lib/profiles";
import { NavContext, Page } from "./lib/nav";
import { ipc } from "./lib/ipc";
import type { UpdateInfo } from "./lib/types";
import { Badge, Button } from "./components/ui";
import { ToastProvider } from "./components/toast";
import { ConfirmProvider } from "./components/dialog";
import { PermissionsBanner } from "./components/Permissions";
import { DevicesPage } from "./pages/DevicesPage";
import { SetupPage } from "./pages/SetupPage";
import { KeysPage } from "./pages/KeysPage";
import { RecorderPage } from "./pages/RecorderPage";
import { ProfilesPage } from "./pages/ProfilesPage";
import { SettingsPage } from "./pages/SettingsPage";

const NAV: { id: Page; label: string; icon: LucideIcon; needsDevice?: boolean }[] = [
  { id: "devices", label: "Devices", icon: Keyboard },
  { id: "setup", label: "Setup", icon: Wand2, needsDevice: true },
  { id: "keys", label: "Keys", icon: LayoutGrid, needsDevice: true },
  { id: "recorder", label: "Recorder", icon: Circle },
  { id: "profiles", label: "Profiles", icon: SlidersHorizontal },
  { id: "settings", label: "Settings", icon: Settings },
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
    <NavContext.Provider value={setPage}>
      <div className="flex h-screen">
        <aside className="w-48 shrink-0 border-r border-line bg-panel flex flex-col">
          <div className="px-4 py-4 border-b border-line">
            <h1 className="font-black tracking-widest text-accent">MKYADA</h1>
            <p className="text-[10px] text-fg-faint leading-tight mt-1">
              Macro Keyboard You Always Dream About
            </p>
          </div>
          <nav className="flex-1 py-2" aria-label="Main">
            {NAV.map((n) => {
              const missing = n.needsDevice && !hello;
              return (
                <button
                  key={n.id}
                  onClick={() => setPage(n.id)}
                  aria-current={page === n.id ? "page" : undefined}
                  title={missing ? "Connect a keypad first" : undefined}
                  className={`w-full text-left px-4 py-2 text-sm flex items-center gap-2.5 transition-colors
                    ${
                      page === n.id
                        ? "bg-panel2 text-accent border-r-2 border-accent"
                        : missing
                          ? "text-fg-faint hover:text-fg-muted"
                          : "text-fg-muted hover:text-fg"
                    }`}
                >
                  <n.icon size={15} className="shrink-0" aria-hidden />
                  <span className="flex-1">{n.label}</span>
                  {missing && (
                    <span
                      className="w-1.5 h-1.5 rounded-full bg-warning shrink-0"
                      aria-label="Needs a connected keypad"
                    />
                  )}
                </button>
              );
            })}
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
            <div className="flex items-center justify-between bg-warning-bg border-b border-warning-line px-4 py-2 text-sm">
              <span className="text-fg">
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
    </NavContext.Provider>
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
        <ToastProvider>
          <ConfirmProvider>
            <Shell />
          </ConfirmProvider>
        </ToastProvider>
      </ProfilesProvider>
    </DeviceProvider>
  );
}

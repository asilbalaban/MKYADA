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
import { deviceName, onDevnamesChanged } from "./lib/devnames";
import { useLayoutVersion } from "./lib/layout";
import { NavContext, Page } from "./lib/nav";
import { ipc } from "./lib/ipc";
import type { UpdateInfo } from "./lib/types";
import { Badge, Button } from "./components/ui";
import { ToastProvider } from "./components/toast";
import { ConfirmProvider } from "./components/dialog";
import { LedFeedback } from "./components/SystemStatus";
import { WriteProgressCard } from "./components/WriteProgress";
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
  const [nickname, setNickname] = useState("");
  const { hello, port, layer } = useDevice();
  // key labels everywhere show what they type on the user's real keyboard
  // layout; re-render the tree when that map loads or changes
  useLayoutVersion();

  // Sidebar shows the keypad's nickname (set on the Devices page) and follows
  // renames live.
  useEffect(() => {
    if (!hello) {
      setNickname("");
      return;
    }
    const load = () => void deviceName(hello.uid).then(setNickname);
    load();
    return onDevnamesChanged(load);
  }, [hello]);

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
          <div className="px-4 py-4 border-b border-line flex items-center gap-3">
            <img src="/mkyada-logo.png" alt="MKYADA" className="w-14 h-14 rounded-xl shrink-0" />
            <p className="text-xs text-fg-muted leading-snug font-medium">
              Macro Keypad
              <br />
              You Always
              <br />
              Dream About
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
          <div className="px-4 py-3 border-t border-line flex flex-col gap-2">
            {port && hello ? (
              <div className="flex flex-col gap-1 items-start">
                <Badge tone="green">
                  ● {nickname.trim() || `${hello.key_count}-key keypad`} connected
                </Badge>
                {hello.layer_key && (
                  <Badge tone="blue">Layer {layer.toUpperCase()}</Badge>
                )}
              </div>
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
          {/* The Recorder is a full-bleed Photoshop-style workspace (its own
              toolbar + scroll), so it drops the shared padding/scroll. */}
          <main
            className={`flex-1 min-h-0 ${
              page === "recorder" ? "overflow-hidden" : "overflow-auto p-5"
            }`}
          >
            {page === "devices" && <DevicesPage onConnected={() => setPage("keys")} />}
            {page === "setup" && <SetupPage onDone={() => setPage("keys")} />}
            {page === "keys" && <KeysPage />}
            {/* The Recorder stays mounted across page switches (hidden via CSS):
                a recording in progress captures via global hooks and must keep
                collecting events — and the recorded macro + its undo history
                must survive a trip to Keys/Setup and back. */}
            <div className={page === "recorder" ? "h-full" : "hidden"}>
              <RecorderPage active={page === "recorder"} />
            </div>
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
            <LedFeedback />
            <WriteProgressCard />
            <Shell />
          </ConfirmProvider>
        </ToastProvider>
      </ProfilesProvider>
    </DeviceProvider>
  );
}

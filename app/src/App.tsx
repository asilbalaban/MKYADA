import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Circle,
  CirclePlay,
  Keyboard,
  LayoutGrid,
  LucideIcon,
  Settings,
  SlidersHorizontal,
} from "lucide-react";
import { OverlayView } from "./components/OverlayView";
import { DeviceProvider, useDevice } from "./lib/device";
import { ProfilesProvider } from "./lib/profiles";
import { WheelMenuProvider } from "./lib/wheel-menu";
import { deviceName, displayName, onDevnamesChanged } from "./lib/devnames";
import { useLayoutVersion } from "./lib/layout";
import { NavContext, type Navigate, Page } from "./lib/nav";
import { ipc } from "./lib/ipc";
import type { UpdateInfo } from "./lib/types";
import { Alert, Badge, Button, Spinner } from "./components/ui";
import { ToastProvider } from "./components/toast";
import { ConfirmProvider } from "./components/dialog";
import { WriteGateProvider } from "./components/WriteProgress";
import { PermissionsBanner } from "./components/Permissions";
import { PlaybackBar } from "./components/PlaybackBar";
import { DevicesPage } from "./pages/DevicesPage";
import { KeysPage } from "./pages/KeysPage";
import { ControlPage } from "./pages/ControlPage";
import { RecorderPage } from "./pages/RecorderPage";
import { ProfilesPage } from "./pages/ProfilesPage";
import { SettingsPage } from "./pages/SettingsPage";

// Setup has no entry of its own (issue #42): it's a once-per-keypad chore, so it
// lives in the Devices page's tabs instead of pushing Keys down the sidebar.
const NAV: { id: Page; label: string; icon: LucideIcon; needsDevice?: boolean }[] = [
  // Home: run and stop keys without touching the keypad (remote desktop).
  { id: "control", label: "Control", icon: CirclePlay },
  { id: "devices", label: "Devices", icon: Keyboard },
  { id: "keys", label: "Keys", icon: LayoutGrid, needsDevice: true },
  { id: "recorder", label: "Recorder", icon: Circle },
  { id: "profiles", label: "Profiles", icon: SlidersHorizontal },
  { id: "settings", label: "Settings", icon: Settings },
];

function Shell() {
  const [page, setPage] = useState<Page>("control");
  // Set by the permissions banner so Settings opens on the Application tab
  // (where the permissions card lives) instead of the default Keypad tab.
  const [settingsTab, setSettingsTab] = useState<{ id: string } | null>(null);
  // Page switch for the rest of the app; `tab` deep-links into Settings (a
  // fresh object per request so a repeat jump to the same tab still lands).
  const navigate: Navigate = (p, opts) => {
    if (p === "settings" && opts?.tab) setSettingsTab({ id: opts.tab });
    setPage(p);
  };
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [nickname, setNickname] = useState("");
  const { hello, port, layer, status, linkWedged, keysLoading, keysProgress } = useDevice();
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
    <NavContext.Provider value={navigate}>
      <div className="flex h-screen">
        {/* Hezk Sidebar: charcoal rail, cream text, lavender for the active icon. */}
        <aside className="flex w-[232px] shrink-0 flex-col bg-inverse text-inverse-fg">
          <div className="flex items-center gap-3 border-b border-inverse-line px-4 py-4">
            <img src="/mkyada-logo.png" alt="" className="size-10 shrink-0 rounded-control" />
            <div className="flex min-w-0 flex-col">
              <span className="text-[15px] font-semibold leading-tight tracking-[-0.01em]">MKYADA</span>
              <span className="text-[11px] leading-snug text-stone-400 [font-stretch:90%]">
                Macro Keypad You Always Dream About
              </span>
            </div>
          </div>
          <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-4" aria-label="Main">
            {NAV.map((n) => {
              const missing = n.needsDevice && !hello;
              const on = n.id === page;
              return (
                <button
                  key={n.id}
                  onClick={() => setPage(n.id)}
                  aria-current={on ? "page" : undefined}
                  title={missing ? "Connect a keypad first" : undefined}
                  className={`flex h-10 w-full items-center gap-3 rounded-control px-3 text-left text-sm transition-colors duration-[120ms] ease-standard focus-visible:outline-lavender
                    ${
                      on
                        ? "bg-inverse-line font-strong text-inverse-fg"
                        : missing
                          ? "text-stone-500 hover:bg-[rgba(246,243,238,0.05)] hover:text-inverse-muted"
                          : "text-inverse-muted hover:bg-[rgba(246,243,238,0.05)] hover:text-inverse-fg"
                    }`}
                >
                  <n.icon size={18} className={`shrink-0 ${on ? "text-lavender" : ""}`} aria-hidden />
                  <span className="flex-1">{n.label}</span>
                  {missing && (
                    <span
                      className="size-1.5 shrink-0 rounded-full bg-warning-solid"
                      aria-label="Needs a connected keypad"
                    />
                  )}
                </button>
              );
            })}
          </nav>
          <div className="border-t border-inverse-line px-4 py-4">
            {port && hello ? (
              <div className="flex flex-col gap-1.5" title={`Keypad link: ${status}`}>
                {/* live link state (issue #16): what the keypad is doing
                    right now, not just that it exists */}
                <span className="flex items-center gap-2 text-label font-medium tracking-label text-inverse-muted [font-stretch:90%]">
                  <span
                    aria-hidden
                    className={`size-2 shrink-0 rounded-full ${
                      status === "unresponsive"
                        ? "bg-danger-on-dark"
                        : status === "transfer"
                          ? "bg-lavender"
                          : status === "reloading" || status === "busy"
                            ? "bg-warning-on-dark"
                            : "bg-success-on-dark"
                    }`}
                  />
                  {status === "unresponsive"
                    ? "Not responding"
                    : status === "transfer"
                      ? "Transferring data…"
                      : status === "reloading"
                        ? "Reloading…"
                        : status === "busy"
                          ? "Busy · macro playing"
                          : "Connected"}
                </span>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-strong text-inverse-fg">
                    {displayName(nickname, hello.uid)}
                  </span>
                  {hello.layer_key && (
                    <Badge tone="accent" className="shrink-0">
                      Layer {layer.toUpperCase()}
                    </Badge>
                  )}
                </span>
              </div>
            ) : (
              <span className="flex items-center gap-2 text-label font-medium tracking-label text-stone-400 [font-stretch:90%]">
                <span aria-hidden className="size-2 shrink-0 rounded-full border border-stone-500" />
                No keypad
              </span>
            )}
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <PermissionsBanner
            onOpenSettings={() => navigate("settings", { tab: "app" })}
            className="mx-6 mt-4"
          />
          {/* Global strips above every page (the Recorder too). empty:hidden
              drops the wrapper's padding when nothing is showing —
              PlaybackBar renders nothing while the keypad is idle. */}
          <div className="flex flex-col gap-2 px-6 pt-4 empty:hidden">
            <PlaybackBar />
            {update && (
              <Alert
                tone="info"
                title={`MKYADA v${update.latest} is available`}
                actions={
                  <>
                    <Button variant="primary" size="sm" onClick={() => void openUrl(update.url)}>
                      Open release page
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setUpdate(null)}>
                      Later
                    </Button>
                  </>
                }
              >
                You're on v{update.current}.
              </Alert>
            )}
            {linkWedged && (
              <Alert tone="danger" title="The keypad link is stuck">
                It couldn't reconnect on its own. Unplug the cable and plug it back in.
              </Alert>
            )}
            {keysLoading && !linkWedged && (
              <Alert tone="info" icon={<Spinner size={16} />}>
                Loading keys from the keypad
                {keysProgress && keysProgress.total > 0
                  ? ` · ${keysProgress.done} of ${keysProgress.total}`
                  : "…"}
                {" "}· everything else works in the meantime.
              </Alert>
            )}
          </div>
          {/* Every page gets the same p-6 frame. The Recorder is a workspace
              with its own inner scroll areas, so only it drops the page scroll. */}
          <main
            className={`min-h-0 flex-1 p-6 ${
              page === "recorder" ? "overflow-hidden" : "overflow-auto"
            }`}
          >
            {page === "devices" && <DevicesPage onConnected={() => setPage("control")} />}
            {page === "control" && <ControlPage />}
            {page === "keys" && <KeysPage />}
            {/* The Recorder stays mounted across page switches (hidden via CSS):
                a recording in progress captures via global hooks and must keep
                collecting events — and the recorded macro + its undo history
                must survive a trip to Keys/Devices and back. */}
            <div
              className={page === "recorder" ? "h-full" : "hidden"}
              // Dense editor: Hezk compact density (28px controls, 13px text).
              data-hz-density="compact"
            >
              <RecorderPage active={page === "recorder"} />
            </div>
            {page === "profiles" && <ProfilesPage />}
            {page === "settings" && <SettingsPage openTab={settingsTab} />}
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
        <WheelMenuProvider>
          <ToastProvider>
            <ConfirmProvider>
              <WriteGateProvider>
                <Shell />
              </WriteGateProvider>
            </ConfirmProvider>
          </ToastProvider>
        </WheelMenuProvider>
      </ProfilesProvider>
    </DeviceProvider>
  );
}

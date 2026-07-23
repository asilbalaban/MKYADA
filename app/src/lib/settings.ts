// App-level user settings (theme, later: language, first-run, seen version).
// Persisted in the Tauri store; the theme choice is mirrored to localStorage
// so it can be applied synchronously at boot with no flash.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LazyStore } from "@tauri-apps/plugin-store";

const store = new LazyStore("settings.json");

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  return ((await store.get<T>(key)) ?? fallback) as T;
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  await store.set(key, value);
  await store.save();
}

// ---------------------------------------------------------------- theme ---

export type ThemePref = "system" | "light" | "dark";

const THEME_LS_KEY = "mkyada-theme";
let themePref: ThemePref = readInitialPref();
const listeners = new Set<() => void>();

function readInitialPref(): ThemePref {
  const v = typeof localStorage !== "undefined" ? localStorage.getItem(THEME_LS_KEY) : null;
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

function apply() {
  const dark =
    themePref === "dark" ||
    (themePref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

/** Call once at boot (before render) — applies the stored theme immediately. */
export function initTheme() {
  apply();
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => themePref === "system" && apply());
  // The Tauri store is the durable copy; correct localStorage drift silently.
  void getSetting<ThemePref>("theme", themePref).then((stored) => {
    if (stored !== themePref) setThemePref(stored);
  });
}

export function setThemePref(pref: ThemePref) {
  themePref = pref;
  localStorage.setItem(THEME_LS_KEY, pref);
  void setSetting("theme", pref);
  apply();
  listeners.forEach((l) => l());
}

export function useThemePref(): ThemePref {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => themePref,
  );
}

// -------------------------------------------------------- always on top ---
// Keep MKYADA above other windows (games) while fine-tuning macro
// coordinates. Lives in Settings and persists across launches.

let alwaysOnTop = false;
const aotListeners = new Set<() => void>();

// ---------------------------------------------------- background & login ---
// Closing the window hides MKYADA to the system tray so key actions and
// per-app profiles keep working; the Rust side reads "runInBackground" from
// the store on every close request. Autostart is owned by the OS via
// tauri-plugin-autostart — the plugin is the source of truth, not the store.

let runInBackground = true;
const ribListeners = new Set<() => void>();

export function initRunInBackground() {
  void getSetting("runInBackground", true).then((stored) => {
    runInBackground = stored;
    ribListeners.forEach((l) => l());
  });
}

export function setRunInBackground(on: boolean) {
  runInBackground = on;
  void setSetting("runInBackground", on);
  ribListeners.forEach((l) => l());
}

export function useRunInBackground(): boolean {
  return useSyncExternalStore(
    (cb) => {
      ribListeners.add(cb);
      return () => ribListeners.delete(cb);
    },
    () => runInBackground,
  );
}

let autostart = false;
const asListeners = new Set<() => void>();

export function initAutostart() {
  void import("@tauri-apps/plugin-autostart")
    .then((m) => m.isEnabled())
    .then((on) => {
      autostart = on;
      asListeners.forEach((l) => l());
    })
    .catch(() => {});
}

export function setAutostart(on: boolean) {
  autostart = on;
  void import("@tauri-apps/plugin-autostart")
    .then((m) => (on ? m.enable() : m.disable()))
    .catch(() => {});
  asListeners.forEach((l) => l());
}

export function useAutostart(): boolean {
  return useSyncExternalStore(
    (cb) => {
      asListeners.add(cb);
      return () => asListeners.delete(cb);
    },
    () => autostart,
  );
}

/** Call once at boot — re-applies the stored preference to the window. */
export function initAlwaysOnTop() {
  void getSetting("alwaysOnTop", false).then((stored) => {
    if (stored) setAlwaysOnTop(true);
  });
}

export function setAlwaysOnTop(on: boolean) {
  alwaysOnTop = on;
  void setSetting("alwaysOnTop", on);
  void invoke("window_set_pin", { pinned: on });
  aotListeners.forEach((l) => l());
}

export function useAlwaysOnTop(): boolean {
  return useSyncExternalStore(
    (cb) => {
      aotListeners.add(cb);
      return () => aotListeners.delete(cb);
    },
    () => alwaysOnTop,
  );
}

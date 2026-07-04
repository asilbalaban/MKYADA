// App-level user settings (theme, later: language, first-run, seen version).
// Persisted in the Tauri store; the theme choice is mirrored to localStorage
// so it can be applied synchronously at boot with no flash.

import { useSyncExternalStore } from "react";
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

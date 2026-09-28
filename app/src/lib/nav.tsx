// Tiny navigation context so any page can send the user elsewhere
// (e.g. an empty state's "Go to Devices" button) without prop drilling.

import { createContext, useContext } from "react";

export type Page = "control" | "devices" | "keys" | "recorder" | "profiles" | "settings";

/** Settings tabs a caller can deep-link to (ids of SettingsPage's TABS). */
export type SettingsTab = "keypad" | "integrations" | "app" | "about";

export type NavOptions = {
  /** Open Settings on this tab instead of the one that was open last. */
  tab?: SettingsTab;
};

export type Navigate = (p: Page, opts?: NavOptions) => void;

export const NavContext = createContext<Navigate>(() => {});

export function useNav() {
  return useContext(NavContext);
}

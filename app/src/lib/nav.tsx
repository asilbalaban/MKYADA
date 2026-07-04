// Tiny navigation context so any page can send the user elsewhere
// (e.g. an empty state's "Go to Devices" button) without prop drilling.

import { createContext, useContext } from "react";

export type Page = "devices" | "setup" | "keys" | "recorder" | "profiles" | "settings";

export const NavContext = createContext<(p: Page) => void>(() => {});

export function useNav() {
  return useContext(NavContext);
}

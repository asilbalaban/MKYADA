// Window-focus-aware host mode (issue #8).
//
// Keys/Setup hold the keypad in host mode so presses light up in the UI
// instead of firing macros. That must only apply while this window is
// actually the frontmost one: if the app is in the tray or behind another
// window, the keypad has to keep working standalone — even when one of
// those pages happens to be the open tab.

import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** True while the app window is focused (frontmost). */
export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    const win = getCurrentWindow();
    void win.isFocused().then(setFocused);
    const un = win.onFocusChanged((e) => setFocused(e.payload));
    return () => {
      void un.then((f) => f());
    };
  }, []);
  return focused;
}

/**
 * Hold the keypad in host mode (btn events instead of macro playback) while
 * the calling component is mounted AND the app window is focused. Losing
 * focus sends host_leave immediately so keys fire macros again; regaining
 * focus re-enters host mode.
 */
export function useHostMode(send: (msg: Record<string, unknown>) => Promise<void>) {
  const focused = useWindowFocused();
  useEffect(() => {
    if (!focused) return;
    void send({ t: "host_enter" });
    const ping = setInterval(() => void send({ t: "ping" }), 2000);
    return () => {
      clearInterval(ping);
      void send({ t: "host_leave" });
    };
  }, [focused, send]);
}

/**
 * Hold the keypad in "test mode" (macro playback suppressed on EVERY model —
 * issue #33) while the calling component is mounted AND the app window is
 * focused. Losing focus leaves test mode at once so keys fire their macros
 * again; regaining focus re-enters. `ui` picks the on-screen hint the Vision 6
 * shows ("keys" = Keys tab, "wiring" = Setup). No-op until `connected`.
 */
export function useTestMode(
  send: (msg: Record<string, unknown>) => Promise<void>,
  ui: "keys" | "wiring",
  connected = true,
) {
  const focused = useWindowFocused();
  useEffect(() => {
    if (!connected || !focused) return;
    testDepth++;
    void send({ t: "test_enter", ui });
    return () => {
      testDepth = Math.max(0, testDepth - 1);
      void send({ t: "test_leave" });
    };
  }, [connected, focused, ui, send]);
}

// Suppressing playback on the device was only half of it: the computer-side
// half of an assignment (OBS, webhook, launch, command, mic) runs here off the
// same btn event, so keys kept firing while the user was editing them on the
// Keys page (issue #40). One module-level depth counter — no IPC, no context —
// because the check sits on the press path, which must stay instant.
let testDepth = 0;

/** True while any page is holding the keypad in test mode. */
export function testModeActive(): boolean {
  return testDepth > 0;
}

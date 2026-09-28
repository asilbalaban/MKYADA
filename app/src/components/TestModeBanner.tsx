import { Info } from "lucide-react";
import { Alert, Tooltip } from "./ui";

/**
 * App-side "you're in test mode" notice — the on-screen counterpart to the
 * keypad suppressing macro playback while a test screen (Keys / Setup) is open
 * and focused (issue #33). It matters most on Core 6, which has no display to
 * explain why pressing a key does nothing here.
 */
export function TestModeBanner({ what = "key" }: { what?: "key" | "wiring" }) {
  return (
    <Alert tone="info">
      This is a {what === "wiring" ? "wiring" : "key"} <b className="font-strong text-fg">test</b>{" "}
      screen · pressing a key here won't run its macro. Switch to another tab, or click another
      window, and the keypad runs macros normally again.
    </Alert>
  );
}

/**
 * Compact form of the same notice for a card header (Keys page): one quiet
 * line with the details in a tooltip, instead of a full-width Alert on every
 * visit.
 */
export function TestModeNotice() {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>Test mode · macros don't run here</span>
      <Tooltip
        side="bottom"
        content="While this page is focused, pressing a key on the keypad only lights it up here. Switch to another page or window and the keypad runs its macros again."
      >
        <span
          tabIndex={0}
          aria-label="About test mode"
          className="inline-flex cursor-help rounded-full text-fg-faint hover:text-fg"
        >
          <Info size={13} aria-hidden />
        </span>
      </Tooltip>
    </span>
  );
}

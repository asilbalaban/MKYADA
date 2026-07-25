import { Info } from "lucide-react";

/**
 * App-side "you're in test mode" notice — the on-screen counterpart to the
 * keypad suppressing macro playback while a test screen (Keys / Setup) is open
 * and focused (issue #33). It matters most on Core 6, which has no display to
 * explain why pressing a key does nothing here.
 */
export function TestModeBanner({ what = "key" }: { what?: "key" | "wiring" }) {
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-info-line bg-info-bg px-3 py-2 text-sm text-info"
    >
      <Info size={16} className="mt-0.5 shrink-0" aria-hidden />
      <span>
        This is a {what === "wiring" ? "wiring" : "key"} <b>test</b> screen —
        pressing a key here won't run its macro. Switch to another tab, or click
        another window, and the keypad runs macros normally again.
      </span>
    </div>
  );
}

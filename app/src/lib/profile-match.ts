// Which per-app profile is active, given the foreground window (pure — see
// profile-match.test.ts). Used by the profile engine in profiles.tsx.

import type { ForegroundInfo, Profile } from "./types";

export function profileMatches(p: Profile, fg: ForegroundInfo): boolean {
  if (!p.match.exe) return false;
  if (p.match.exe.toLowerCase() !== fg.exe.toLowerCase()) return false;
  if (p.match.title_contains && !fg.title.toLowerCase().includes(p.match.title_contains.toLowerCase()))
    return false;
  return true;
}

/** The profile in force. MKYADA itself in front (`fg.self` — someone is
 * using the Control page, often over remote desktop) keeps the profile of the
 * app they came from, so keys run from here are the ones that app sees; any
 * other app re-matches as usual (no match clears it). `prev` is re-read from
 * `profiles` so an edit or a delete still lands. */
export function resolveActiveProfile(
  prev: Profile | null,
  s: { enabled: boolean; paused: boolean; connected: boolean; profiles: Profile[]; fg: ForegroundInfo },
): Profile | null {
  if (!s.enabled || s.paused || !s.connected) return null;
  if (s.fg.self) return prev ? (s.profiles.find((p) => p.id === prev.id) ?? null) : null;
  return s.profiles.find((p) => profileMatches(p, s.fg)) ?? null;
}

import { describe, expect, it } from "vitest";
import { profileMatches, resolveActiveProfile } from "./profile-match";
import type { Profile } from "./types";

const obs: Profile = { id: "obs", name: "OBS", match: { exe: "obs64.exe" }, keys: {} };
const code: Profile = { id: "code", name: "Code", match: { exe: "Code.exe", title_contains: "mkyada" }, keys: {} };
const base = { enabled: true, paused: false, connected: true, profiles: [obs, code] };

describe("profileMatches", () => {
  it("matches exe case-insensitively and checks the title", () => {
    expect(profileMatches(obs, { exe: "OBS64.EXE", title: "" })).toBe(true);
    expect(profileMatches(code, { exe: "Code.exe", title: "notes — VS Code" })).toBe(false);
    expect(profileMatches(code, { exe: "Code.exe", title: "MKYADA — VS Code" })).toBe(true);
  });
});

describe("resolveActiveProfile", () => {
  it("matches the foreground app", () => {
    expect(resolveActiveProfile(null, { ...base, fg: { exe: "obs64.exe", title: "" } })).toBe(obs);
  });

  it("keeps the last profile while MKYADA itself is in front", () => {
    expect(resolveActiveProfile(obs, { ...base, fg: { exe: "mkyada", title: "MKYADA", self: true } })).toBe(obs);
    expect(resolveActiveProfile(null, { ...base, fg: { exe: "mkyada", title: "MKYADA", self: true } })).toBeNull();
  });

  it("follows an edit or delete of the kept profile", () => {
    const edited = { ...obs, name: "OBS Studio" };
    expect(
      resolveActiveProfile(obs, { ...base, profiles: [edited], fg: { exe: "mkyada", title: "", self: true } }),
    ).toBe(edited);
    expect(resolveActiveProfile(obs, { ...base, profiles: [code], fg: { exe: "mkyada", title: "", self: true } })).toBeNull();
  });

  it("any other app re-matches (no match clears it)", () => {
    expect(resolveActiveProfile(obs, { ...base, fg: { exe: "Finder", title: "" } })).toBeNull();
  });

  it("pause, disabled or no keypad clear it even with MKYADA in front", () => {
    const fg = { exe: "mkyada", title: "", self: true };
    expect(resolveActiveProfile(obs, { ...base, paused: true, fg })).toBeNull();
    expect(resolveActiveProfile(obs, { ...base, enabled: false, fg })).toBeNull();
    expect(resolveActiveProfile(obs, { ...base, connected: false, fg })).toBeNull();
  });
});

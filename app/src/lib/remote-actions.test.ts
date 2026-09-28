import { describe, expect, it } from "vitest";
import { keyOfId, parseRemoteStart, remotePlan, sequenceRuns } from "./remote-actions";
import type { Assignment } from "./types";

describe("parseRemoteStart", () => {
  it("takes only remote play_starts with a key", () => {
    expect(parseRemoteStart({ t: "play_start", file: "/macros/key3-b.json", key: 3, layer: "b", src: "remote" })).toEqual({
      key: 3,
      layer: "b",
      file: "macros/key3-b.json",
      profileId: null,
    });
    expect(parseRemoteStart({ t: "play_start", file: "/macros/key3.json", key: 3, layer: "a", src: "key" })).toBeNull();
    expect(parseRemoteStart({ t: "play_start", file: "/macros/key3.s0.json", key: null, src: "host" })).toBeNull();
    expect(parseRemoteStart({ t: "play_done", file: "/macros/key3.json", key: 3, src: "remote" })).toBeNull();
    expect(parseRemoteStart({ t: "play_start", file: "", key: 3, src: "remote" })).toBeNull();
  });

  it("names the profile of a profile file", () => {
    const r = parseRemoteStart({ t: "play_start", file: "/macros/p_p-obs_key2.json", key: 2, layer: "a", src: "remote" });
    expect(r?.profileId).toBe("p-obs");
    const u = parseRemoteStart({ t: "play_start", file: "/macros/p_my_id_key12.json", key: 12, layer: "a", src: "remote" });
    expect(u?.profileId).toBe("my_id");
  });
});

describe("remotePlan", () => {
  const launch: Assignment = { kind: "launch", target: "https://example.com" };

  it("runs computer-side kinds", () => {
    expect(remotePlan(launch)).toEqual({ type: "host", a: launch });
    for (const a of [
      { kind: "command", command: "ls" },
      { kind: "sound", file: "ding.wav" },
      { kind: "webhook", url: "https://x.test" },
      { kind: "obs", action: "recordToggle" },
      { kind: "mic", mode: "toggle" },
    ] as Assignment[]) {
      expect(remotePlan(a).type).toBe("host");
    }
  });

  it("never doubles a key with variants (key_action runs those)", () => {
    expect(remotePlan({ ...launch, variants: { double: { kind: "command", command: "ls" } } })).toEqual({ type: "none" });
    expect(remotePlan({ ...launch, variants: { hold: { kind: "keystroke", key: "a" } } })).toEqual({ type: "none" });
  });

  it("leaves pure HID and blank keys to the keypad", () => {
    expect(remotePlan(undefined)).toEqual({ type: "none" });
    expect(remotePlan({ kind: "none" })).toEqual({ type: "none" });
    expect(remotePlan({ kind: "keystroke", key: "a" })).toEqual({ type: "none" });
    expect(remotePlan({ kind: "mic", mode: "push_to_talk" })).toEqual({ type: "none" });
    expect(
      remotePlan({ kind: "sequence", steps: [{ a: { kind: "keystroke", key: "a" }, delayMs: 0 }] }),
    ).toEqual({ type: "none" });
  });

  it("runs mixed multi actions with their speed", () => {
    const steps = [
      { a: { kind: "keystroke", key: "a" } as Assignment, delayMs: 100 },
      { a: launch, delayMs: 0 },
    ];
    expect(remotePlan({ kind: "sequence", steps, speed: 2 })).toEqual({ type: "sequence", steps, speed: 2 });
    expect(remotePlan({ kind: "sequence", steps })).toEqual({ type: "sequence", steps, speed: 1 });
  });
});

describe("sequenceRuns", () => {
  it("cancels by key, across layers, and on stop", () => {
    const a = sequenceRuns.start("3:a");
    const b = sequenceRuns.start("4:b");
    expect(keyOfId("enc-cw")).toBeNull();
    expect(sequenceRuns.running()).toEqual(new Set(["3:a", "4:b"]));
    expect(sequenceRuns.cancelKey(3)).toBe(true);
    expect(a.cancelled).toBe(true);
    expect(sequenceRuns.cancelKey(3)).toBe(false);
    sequenceRuns.cancelAll();
    expect(b.cancelled).toBe(true);
    expect(sequenceRuns.running().size).toBe(0);
  });

  it("an ended run does not remove a newer one", () => {
    const old = sequenceRuns.start("5:a");
    const fresh = sequenceRuns.start("5:a");
    sequenceRuns.end("5:a", old);
    expect(sequenceRuns.get("5:a")).toBe(fresh);
    sequenceRuns.end("5:a", fresh);
    expect(sequenceRuns.get("5:a")).toBeUndefined();
  });
});

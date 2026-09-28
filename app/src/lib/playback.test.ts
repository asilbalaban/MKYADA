import { describe, expect, it } from "vitest";
import { accelFromEvent, accelParts, EMPTY_TRACK, keyFromFile, reducePlayback } from "./playback";

describe("keyFromFile", () => {
  it("reads numbered key files", () => {
    expect(keyFromFile("/macros/key3.json")).toEqual({ key: 3, layer: "a" });
    expect(keyFromFile("/macros/key2-c.json")).toEqual({ key: 2, layer: "c" });
    expect(keyFromFile("/macros/p_p123_key4.json")).toEqual({ key: 4, layer: null });
  });
  it("ignores part files and slots", () => {
    expect(keyFromFile("/macros/key3.s1.json")).toBeNull();
    expect(keyFromFile("/macros/enc_cw.json")).toBeNull();
  });
});

describe("reducePlayback", () => {
  const start = { t: "play_start", file: "/macros/key3.json", key: 3, layer: "a", loop: true, src: "remote" };

  it("tracks a v17 play_start", () => {
    const s = reducePlayback(EMPTY_TRACK, start, 100);
    expect(s.playing).toEqual({
      file: "/macros/key3.json",
      key: 3,
      layer: "a",
      loop: true,
      src: "remote",
      startedAt: 100,
    });
  });

  it("offers Run again after a stop, with its source", () => {
    const s1 = reducePlayback(EMPTY_TRACK, start, 100);
    const s2 = reducePlayback(s1, { t: "play_done", file: start.file, stopped: true, reason: "stop" }, 200, "hotkey");
    expect(s2.playing).toBeNull();
    expect(s2.lastStopped).toMatchObject({ key: 3, layer: "a", reason: "stop", via: "hotkey" });
    // a new play clears the offer
    expect(reducePlayback(s2, start, 300).lastStopped).toBeNull();
  });

  it("no offer when a play simply finished or another key took over", () => {
    const s1 = reducePlayback(EMPTY_TRACK, start, 100);
    expect(reducePlayback(s1, { t: "play_done", file: start.file, stopped: false, reason: "done" }, 200).lastStopped).toBeNull();
    expect(reducePlayback(s1, { t: "play_done", file: start.file, stopped: true, reason: "other" }, 200).lastStopped).toBeNull();
  });

  it("no offer for the app's own plays", () => {
    const s1 = reducePlayback(EMPTY_TRACK, { ...start, src: "host", key: null }, 100);
    expect(reducePlayback(s1, { t: "play_done", file: start.file, stopped: true, reason: "stop" }, 200).lastStopped).toBeNull();
  });

  it("falls back to the file name on old firmware", () => {
    const s1 = reducePlayback(EMPTY_TRACK, { t: "play_start", file: "/macros/key5-b.json" }, 100);
    expect(s1.playing).toMatchObject({ key: 5, layer: "b", loop: false, src: "unknown" });
    const s2 = reducePlayback(s1, { t: "play_done", file: "/macros/key5-b.json", stopped: true }, 200);
    expect(s2.lastStopped).toMatchObject({ key: 5, layer: "b", reason: "stop" });
  });

  it("resyncs from hello.playing", () => {
    const pl = { file: "/macros/key1.json", key: 1, layer: "a", loop: true };
    const s1 = reducePlayback(EMPTY_TRACK, { t: "hello", playing: pl }, 100);
    expect(s1.playing).toMatchObject({ key: 1, loop: true, startedAt: 100 });
    // a repeated hello keeps the original start time
    expect(reducePlayback(s1, { t: "hello", playing: pl }, 500).playing?.startedAt).toBe(100);
    expect(reducePlayback(s1, { t: "hello", playing: null }, 600).playing).toBeNull();
    expect(reducePlayback(s1, { t: "hello" }, 600).playing).toBeNull();
  });
});

describe("accelerators", () => {
  const ev = (code: string, m: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) => ({
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    code,
    ...m,
  });
  it("builds the Rust parser's names", () => {
    expect(accelFromEvent(ev("KeyS", { ctrlKey: true, altKey: true, shiftKey: true }))).toBe("Ctrl+Alt+Shift+S");
    expect(accelFromEvent(ev("Digit1", { altKey: true }))).toBe("Alt+1");
    expect(accelFromEvent(ev("F9", { ctrlKey: true }))).toBe("Ctrl+F9");
    expect(accelFromEvent(ev("ShiftLeft", { shiftKey: true }))).toBeNull();
  });
  it("shows platform names", () => {
    expect(accelParts("Ctrl+Alt+Shift+S", false)).toEqual(["Ctrl", "Alt", "Shift", "S"]);
    expect(accelParts("Ctrl+Alt+Super+S", true)).toEqual(["Control", "Option", "Cmd", "S"]);
  });
});

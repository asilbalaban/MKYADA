import { describe, expect, it } from "vitest";
import { META_BIG_FILE, applyMetaOverrides, metaFastFields, metaStem } from "./device-meta";
import type { MacroFile } from "./types";

// A serialized v4 stream file: header line + one event per line, padded past
// the big-file threshold so the fast path is even considered.
function streamSer(header: Record<string, unknown>): string {
  const lines = [JSON.stringify({ format: "mkyada-macro", version: 4, stream: true, ...header })];
  const ev = JSON.stringify({ delay: 2, type: "move", x: 123, y: 456 });
  while (lines.join("\n").length < META_BIG_FILE + 1024) lines.push(ev);
  return lines.join("\n") + "\n";
}

describe("metaStem", () => {
  it("takes the basename minus .json", () => {
    expect(metaStem("macros/key3.json")).toBe("key3");
    expect(metaStem("macros/p_ab12_enc-cw.json")).toBe("p_ab12_enc-cw");
  });
  it("rejects meta.json itself and non-json files", () => {
    expect(metaStem("macros/meta.json")).toBeNull();
    expect(metaStem("macros/key3.json.part")).toBeNull();
    expect(metaStem("config.toml")).toBeNull();
  });
});

describe("applyMetaOverrides", () => {
  const base: MacroFile = {
    format: "mkyada-macro",
    version: 4,
    name: "orig",
    icon: "play",
    settings: { speed: 1.5, repeat: 2 },
    events: [],
  };
  it("shadows speed/icon/name and keeps everything else", () => {
    const out = applyMetaOverrides(base, { s: 30, i: "px:0011223344556677", n: "fast" });
    expect(out.settings?.speed).toBe(3);
    expect(out.settings?.repeat).toBe(2);
    expect(out.icon).toBe("px:0011223344556677");
    expect(out.name).toBe("fast");
    expect(base.settings?.speed).toBe(1.5); // no mutation
  });
  it("no entry / empty entry is a no-op", () => {
    expect(applyMetaOverrides(base, undefined)).toEqual(base);
    expect(applyMetaOverrides(base, {})).toEqual(base);
  });
});

describe("metaFastFields", () => {
  const oldSer = streamSer({ name: "rec", settings: { speed: 1 } });

  it("speed-only change on a big stream file → sidecar fields", () => {
    const newSer = streamSer({ name: "rec", settings: { speed: 2.5 } });
    expect(metaFastFields(oldSer, newSer)).toEqual({ s: 25 });
  });

  it("icon and name changes ride along", () => {
    const newSer = streamSer({ name: "renamed", icon: "play", settings: { speed: 1 } });
    expect(metaFastFields(oldSer, newSer)).toEqual({ i: "play", n: "renamed" });
  });

  it("identical files → null (nothing to write)", () => {
    expect(metaFastFields(oldSer, oldSer)).toBeNull();
  });

  it("changed events → null (full write)", () => {
    const newSer = streamSer({ name: "rec", settings: { speed: 2 } }) + '{"delay":1,"type":"wait"}\n';
    expect(metaFastFields(oldSer, newSer)).toBeNull();
  });

  it("small file → null (header edits just rewrite it)", () => {
    const small = (h: Record<string, unknown>) =>
      JSON.stringify({ format: "mkyada-macro", version: 4, stream: true, ...h }) + "\n" +
      '{"delay":0,"type":"wait"}\n';
    expect(
      metaFastFields(small({ settings: { speed: 1 } }), small({ settings: { speed: 2 } })),
    ).toBeNull();
  });

  it("non-stream file → null", () => {
    const pad = "x".repeat(META_BIG_FILE + 10);
    const whole = (speed: number) =>
      JSON.stringify({ format: "mkyada-macro", version: 2, text: pad, settings: { speed }, events: [] }) + "\n";
    expect(metaFastFields(whole(1), whole(2))).toBeNull();
  });

  it("removing an icon can't be an override → null", () => {
    const withIcon = streamSer({ name: "rec", icon: "play", settings: { speed: 1 } });
    const without = streamSer({ name: "rec", settings: { speed: 1.1 } });
    expect(metaFastFields(withIcon, without)).toBeNull();
  });

  it("any other header change (screen) → null", () => {
    const a = streamSer({ name: "rec", screen: { width: 1920, height: 1080 }, settings: { speed: 1 } });
    const b = streamSer({ name: "rec", screen: { width: 2560, height: 1440 }, settings: { speed: 2 } });
    expect(metaFastFields(a, b)).toBeNull();
  });
});

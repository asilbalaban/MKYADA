// Device serialization contract: proto >= 4 keypads get the full recording
// as a JSONL stream (no thinning); older firmware keeps getting thinned
// whole-file JSON. parseDeviceMacro must read every layout back losslessly.
import { describe, expect, it } from "vitest";
import { serializeForDevice, thinForDevice } from "./recorder-model";
import { parseDeviceMacro } from "./macro-model";
import type { MacroEvent, MacroFile } from "./types";

function recorded(events: MacroEvent[]): MacroFile {
  return {
    format: "mkyada-macro",
    version: 2,
    name: "demo",
    kind: "recorded",
    screen: { width: 1920, height: 1080 },
    settings: { speed: 1, repeat: 1 },
    events,
  };
}

// a ~66Hz diagonal sweep — the shape RDP + resample would decimate hard
const moves: MacroEvent[] = Array.from({ length: 100 }, (_, i) => ({
  delay: 15,
  type: "move" as const,
  x: i * 3,
  y: i * 2,
}));

describe("serializeForDevice", () => {
  it("streams full-rate JSONL for proto >= 4 (no thinning)", () => {
    const out = serializeForDevice(recorded(moves), 4);
    const lines = out.trim().split("\n");
    const header = JSON.parse(lines[0]);
    expect(header.stream).toBe(true);
    expect(header.version).toBe(4);
    expect(header.events).toBeUndefined();
    expect(lines).toHaveLength(1 + moves.length);
  });

  it("round-trips through parseDeviceMacro losslessly", () => {
    const back = parseDeviceMacro(serializeForDevice(recorded(moves), 4));
    expect(back.events).toEqual(moves);
    expect((back as { stream?: boolean }).stream).toBeUndefined();
    expect(back.name).toBe("demo");
    expect(back.screen).toEqual({ width: 1920, height: 1080 });
  });

  it("merges consecutive stationary moves losslessly", () => {
    const evs: MacroEvent[] = [
      { delay: 5, type: "move", x: 1, y: 1 },
      { delay: 7, type: "move", x: 1, y: 1 },
      { delay: 9, type: "move", x: 2, y: 2 },
    ];
    const back = parseDeviceMacro(serializeForDevice(recorded(evs), 4));
    expect(back.events).toEqual([
      { delay: 12, type: "move", x: 1, y: 1 },
      { delay: 9, type: "move", x: 2, y: 2 },
    ]);
  });

  it("falls back to thinned whole-file JSON for proto < 4", () => {
    const out = serializeForDevice(recorded(moves), 3);
    const parsed = JSON.parse(out) as MacroFile; // single JSON document
    expect(parsed.events.length).toBeLessThan(moves.length);
    expect(parsed.events).toEqual(thinForDevice(moves));
  });

  it("keeps variant-carrying files in the legacy whole-file layout", () => {
    const m: MacroFile = {
      ...recorded(moves),
      version: 3,
      variants: { double: recorded([]) },
    };
    const out = serializeForDevice(m, 4);
    expect(() => JSON.parse(out)).not.toThrow();
    expect((JSON.parse(out) as MacroFile).variants).toBeDefined();
  });
});

describe("parseDeviceMacro", () => {
  it("reads classic single-line and pretty-printed JSON", () => {
    const m = recorded(moves.slice(0, 3));
    expect(parseDeviceMacro(JSON.stringify(m)).events).toHaveLength(3);
    expect(parseDeviceMacro(JSON.stringify(m, null, 2)).events).toHaveLength(3);
  });

  it("tolerates a header-only stream file", () => {
    const out = serializeForDevice(recorded([]), 4);
    expect(parseDeviceMacro(out).events).toEqual([]);
  });
});

// Round-trip contract: every assignment kind must survive
// parseAssignment(compileAssignment(a)) with its meaning intact — that pair
// is what moves assignments between the UI and the device drive.
import { describe, expect, it } from "vitest";
import {
  assignmentComplete,
  compileAssignment,
  compileSequenceParts,
  compileVariantParts,
  describeAssignment,
  kindRequiresHost,
  migrateMacro,
  parseAssignment,
  sequencePartFileName,
} from "./macro-model";
import type { Assignment, MacroFile } from "./types";

/** Defaults are dropped at compile time; normalize both sides for comparison. */
function normalize(a: Assignment): Assignment {
  const out = { ...a } as Assignment & { behavior?: { on_repress?: string; hold_repeat?: boolean } };
  if (out.behavior) {
    const b = { ...out.behavior };
    if (b.on_repress === "stop") delete b.on_repress;
    if (!b.hold_repeat) delete b.hold_repeat;
    if (Object.keys(b).length === 0) delete out.behavior;
    else out.behavior = b;
  }
  if (out.kind === "sound" && out.holdAction === "stop") delete out.holdAction;
  return out;
}

function roundtrip(a: Assignment): Assignment {
  const file = compileAssignment(a);
  expect(file).not.toBeNull();
  return parseAssignment(JSON.parse(JSON.stringify(file)) as MacroFile);
}

const recordedMacro: MacroFile = {
  format: "mkyada-macro",
  version: 2,
  name: "demo",
  kind: "recorded",
  screen: { width: 1920, height: 1080 },
  events: [
    { delay: 0, type: "move", x: 100, y: 200 },
    { delay: 10, type: "button", action: "down", button: "left", x: 100, y: 200 },
    { delay: 30, type: "button", action: "up", button: "left", x: 100, y: 200 },
    { delay: 5, type: "key", action: "down", key: "a", vk: 65 },
    { delay: 20, type: "key", action: "up", key: "a", vk: 65 },
    { delay: 0, type: "scroll", dy: -3 },
    { delay: 500, type: "wait" },
  ],
};

const CASES: [string, Assignment][] = [
  ["keystroke", { kind: "keystroke", key: "f5" }],
  ["combo", { kind: "combo", mods: ["CTRL", "SHIFT"], key: "s" }],
  ["text", { kind: "text", text: "Hello, World! 123" }],
  ["media", { kind: "media", usage: "play_pause" }],
  ["scroll up", { kind: "scroll", dir: "up", amount: 3 }],
  ["scroll down", { kind: "scroll", dir: "down", amount: 5 }],
  ["scroll left", { kind: "scroll", dir: "left", amount: 3 }],
  ["scroll right", { kind: "scroll", dir: "right", amount: 2 }],
  ["scroll with modifiers (zoom)", { kind: "scroll", dir: "up", amount: 1, mods: ["ALT"] }],
  ["menu confirm", { kind: "menu", action: "confirm" }],
  ["menu left", { kind: "menu", action: "left" }],
  ["recorded", { kind: "recorded", name: "demo", macro: recordedMacro }],
  ["launch", { kind: "launch", target: "https://example.com" }],
  ["command", { kind: "command", command: "echo hi" }],
  ["sound", { kind: "sound", file: "/tmp/ding.mp3" }],
  ["sound with fade hold", { kind: "sound", file: "/tmp/ding.mp3", holdAction: "fade" }],
  ["webhook GET", { kind: "webhook", url: "https://example.com/hook" }],
  [
    "webhook POST with headers and body",
    {
      kind: "webhook",
      url: "https://discord.com/api/webhooks/123/abc",
      method: "POST",
      headers: [{ name: "Content-Type", value: "application/json" }],
      body: '{"content":"key pressed"}',
    },
  ],
  ["keystroke with restart", { kind: "keystroke", key: "a", behavior: { on_repress: "restart" } }],
  ["combo with hold_repeat", { kind: "combo", mods: ["ALT"], key: "tab", behavior: { hold_repeat: true } }],
  ["launch with both behaviors", { kind: "launch", target: "/Applications/Notes.app", behavior: { on_repress: "restart", hold_repeat: true } }],
  [
    "pure-HID sequence",
    {
      kind: "sequence",
      steps: [
        { a: { kind: "combo", mods: ["CTRL"], key: "c" }, delayMs: 150 },
        { a: { kind: "combo", mods: ["CTRL"], key: "v" }, delayMs: 0 },
      ],
    },
  ],
  [
    "mixed sequence",
    {
      kind: "sequence",
      steps: [
        { a: { kind: "launch", target: "https://example.com" }, delayMs: 500 },
        { a: { kind: "text", text: "hello" }, delayMs: 0 },
      ],
    },
  ],
];

describe("assignment round-trip", () => {
  it.each(CASES)("%s", (_name, a) => {
    expect(normalize(roundtrip(a))).toEqual(normalize(a));
  });

  it("none compiles to null (unassigned key)", () => {
    expect(compileAssignment({ kind: "none" })).toBeNull();
  });

  it("default behaviors leave settings untouched", () => {
    const file = compileAssignment({ kind: "keystroke", key: "a", behavior: { on_repress: "stop" } })!;
    expect(file.settings?.on_repress).toBeUndefined();
    expect(file.settings?.hold_repeat).toBeUndefined();
  });

  it("vertical scroll compiles to a wheel tick", () => {
    const f = compileAssignment({ kind: "scroll", dir: "up", amount: 4 })!;
    expect(f.events).toEqual([{ delay: 0, type: "scroll", dy: 4 }]);
    const down = compileAssignment({ kind: "scroll", dir: "down", amount: 4 })!;
    expect(down.events).toEqual([{ delay: 0, type: "scroll", dy: -4 }]);
  });

  it("horizontal scroll compiles to a pan tick (dx)", () => {
    const right = compileAssignment({ kind: "scroll", dir: "right", amount: 2 })!;
    expect(right.events).toEqual([{ delay: 0, type: "scroll", dy: 0, dx: 2 }]);
    const left = compileAssignment({ kind: "scroll", dir: "left", amount: 2 })!;
    expect(left.events).toEqual([{ delay: 0, type: "scroll", dy: 0, dx: -2 }]);
  });

  it("scroll with a modifier wraps the tick in mod down/up (Alt+wheel zoom)", () => {
    const f = compileAssignment({ kind: "scroll", dir: "up", amount: 1, mods: ["ALT"] })!;
    expect(f.events).toEqual([
      { delay: 0, type: "key", action: "down", key: "alt_l" },
      { delay: 10, type: "scroll", dy: 1 },
      { delay: 10, type: "key", action: "up", key: "alt_l" },
    ]);
  });

  it("menu assignment is device-only with no HID events", () => {
    const f = compileAssignment({ kind: "menu", action: "confirm" })!;
    expect(f.kind).toBe("menu");
    expect(f.menu).toBe("confirm");
    expect(f.events).toEqual([]);
    expect(kindRequiresHost("menu")).toBe(false);
    expect(kindRequiresHost("scroll")).toBe(false);
  });

  it("a user label overrides the auto name and survives the round-trip", () => {
    const file = compileAssignment({ kind: "media", usage: "volume_up", label: "Ses +" })!;
    expect(file.name).toBe("Ses +");
    const back = parseAssignment(file);
    expect(back.label).toBe("Ses +");
    expect(describeAssignment(back)).toBe("Ses +");
  });

  it("auto-generated names parse back without a label", () => {
    const file = compileAssignment({ kind: "media", usage: "volume_up" })!;
    expect(parseAssignment(file).label).toBeUndefined();
  });
});

describe("compiled files are device-playable shapes", () => {
  it("keystroke ends with the key released", () => {
    const f = compileAssignment({ kind: "keystroke", key: "b" })!;
    const last = f.events[f.events.length - 1];
    expect(last).toMatchObject({ type: "key", action: "up", key: "b" });
  });

  it("combo releases modifiers in reverse order", () => {
    const f = compileAssignment({ kind: "combo", mods: ["CTRL", "SHIFT"], key: "s" })!;
    const ups = f.events.filter((e) => e.type === "key" && e.action === "up").map((e) => (e as { key: string }).key);
    expect(ups).toEqual(["s", "shift_l", "ctrl_l"]);
  });

  it("text balances every down with an up", () => {
    const f = compileAssignment({ kind: "text", text: "Aç1!" })!;
    const downs = f.events.filter((e) => e.type === "key" && e.action === "down").length;
    const ups = f.events.filter((e) => e.type === "key" && e.action === "up").length;
    expect(downs).toBe(ups);
  });

  it("host-side kinds ship empty events (no-op on device)", () => {
    for (const a of [
      { kind: "launch", target: "x" },
      { kind: "command", command: "x" },
      { kind: "sound", file: "x" },
      { kind: "webhook", url: "https://example.com" },
    ] as Assignment[]) {
      expect(compileAssignment(a)!.events).toEqual([]);
    }
  });
});

describe("key logic (variants, format v3)", () => {
  const withVariants: Assignment = {
    kind: "keystroke",
    key: "f5",
    variants: {
      double: { kind: "combo", mods: ["CTRL"], key: "r" },
      hold: { kind: "launch", target: "https://example.com" },
    },
  };

  it("round-trips tap + double + hold", () => {
    expect(normalize(roundtrip(withVariants))).toEqual(normalize(withVariants));
  });

  it("bumps the file to version 3 and keeps tap in the top-level events", () => {
    const f = compileAssignment(withVariants)!;
    expect(f.version).toBe(3);
    expect(f.events.length).toBeGreaterThan(0); // tap = f5, playable by old firmware
    expect(f.variants?.double?.events.length).toBeGreaterThan(0);
    expect(f.variants?.hold?.events).toEqual([]); // launch: host-side no-op
  });

  it("drops hold_repeat when variants exist (mutually exclusive)", () => {
    const f = compileAssignment({
      ...withVariants,
      behavior: { hold_repeat: true },
    })!;
    expect(f.settings?.hold_repeat).toBeUndefined();
  });

  it("compileVariantParts emits HID variants only", () => {
    const parts = compileVariantParts(withVariants, "macros/p_x_key2.json");
    expect(parts).toHaveLength(1);
    expect(parts[0].path).toBe("macros/p_x_key2.vd.json");
  });
});

describe("sequences", () => {
  const pure: Assignment = {
    kind: "sequence",
    steps: [
      { a: { kind: "combo", mods: ["CTRL"], key: "c" }, delayMs: 150 },
      { a: { kind: "keystroke", key: "enter" }, delayMs: 0 },
    ],
  };
  const mixed: Assignment = {
    kind: "sequence",
    steps: [
      { a: { kind: "text", text: "hi" }, delayMs: 100 },
      { a: { kind: "command", command: "echo hi" }, delayMs: 0 },
    ],
  };

  it("pure-HID sequences compile to one standalone event stream", () => {
    const f = compileAssignment(pure)!;
    expect(f.events.length).toBeGreaterThan(0);
    // the inter-step delay lands as a wait event between the steps
    expect(f.events.some((e) => e.type === "wait" && e.delay === 150)).toBe(true);
    // ends fully released
    const last = f.events[f.events.length - 1];
    expect(last).toMatchObject({ type: "key", action: "up" });
  });

  it("mixed sequences leave the main file a no-op for the device", () => {
    const f = compileAssignment(mixed)!;
    expect(f.events).toEqual([]);
    expect(f.seq).toHaveLength(2);
  });

  it("compileSequenceParts emits part files only for HID steps of mixed sequences", () => {
    expect(compileSequenceParts(pure, "macros/key1.json")).toEqual([]);
    const parts = compileSequenceParts(mixed, "macros/key2-b.json");
    expect(parts).toHaveLength(1);
    expect(parts[0].path).toBe("macros/key2-b.s0.json");
    expect(parts[0].file.events.length).toBeGreaterThan(0);
  });

  it("sequencePartFileName transforms only the extension", () => {
    expect(sequencePartFileName("macros/p_abc_key4.json", 3)).toBe("macros/p_abc_key4.s3.json");
  });

  it("incomplete steps make the assignment incomplete", () => {
    expect(
      assignmentComplete({
        kind: "sequence",
        steps: [{ a: { kind: "keystroke", key: "" }, delayMs: 0 }],
      }),
    ).toBe(false);
    expect(assignmentComplete({ kind: "sequence", steps: [] })).toBe(false);
    expect(assignmentComplete(pure)).toBe(true);
  });
});

describe("legacy migration", () => {
  it("asil-macro v1 becomes mkyada-macro v2 recorded", () => {
    const legacy = { format: "asil-macro", version: 1, events: [] } as unknown as MacroFile;
    const m = migrateMacro(legacy);
    expect(m.format).toBe("mkyada-macro");
    expect(m.version).toBe(2);
    expect(m.kind).toBe("recorded");
  });
});

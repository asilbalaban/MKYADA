// Round-trip contract: every assignment kind must survive
// parseAssignment(compileAssignment(a)) with its meaning intact — that pair
// is what moves assignments between the UI and the device drive.
import { afterEach, describe, expect, it } from "vitest";
import { serializeForDevice } from "./recorder-model";
import { applyLayoutMap } from "./layout";
import {
  assignmentComplete,
  compileAssignment,
  compileSequenceParts,
  compileSlotAssignment,
  compileVariantParts,
  describeAssignment,
  describeSlotAssignment,
  ENC_LABEL_MAX,
  encSlotComplete,
  holdRepeatDefault,
  isSlotBuiltin,
  kindRequiresHost,
  migrateMacro,
  MODIFIERS,
  parseAssignment,
  sequencePartFileName,
  slotEditValue,
  SLOT_BUILTIN_ACTION,
} from "./macro-model";
import { ENC_PRESETS, encPresetSlots } from "./enc-presets";
import type { Assignment, MacroFile } from "./types";

/** Defaults are dropped at compile time; normalize both sides for comparison. */
function normalize(a: Assignment): Assignment {
  const out = { ...a } as Assignment & { behavior?: { on_repress?: string; hold_repeat?: boolean } };
  if (out.behavior) {
    const b = { ...out.behavior };
    if (b.on_repress === "stop") delete b.on_repress;
    // hold_repeat defaults on for single keys, off elsewhere
    if (b.hold_repeat === undefined || b.hold_repeat === holdRepeatDefault(out.kind)) {
      delete b.hold_repeat;
    }
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
  ["obs scene switch", { kind: "obs", action: "setScene", sceneName: "Kamera 2" }],
  ["obs record toggle (no arg)", { kind: "obs", action: "recordToggle" }],
  ["obs mic toggle", { kind: "obs", action: "micToggle", inputName: "Mic/Aux" }],
  [
    "obs source toggle",
    { kind: "obs", action: "sourceToggle", sourceScene: "Sahne 1", sourceName: "Webcam" },
  ],
  ["obs hotkey", { kind: "obs", action: "hotkey", hotkeyName: "OBSBasic.StartRecording" }],
  ["obs center (bare)", { kind: "obs_center" }],
  [
    "obs center (full config)",
    {
      kind: "obs_center",
      center: {
        micInput: "Mic/Aux",
        encoder: "scene",
        widgets: { status: true, timer: true, scene: false, mic: true, health: false },
        quickKeys: [
          { label: "MUTE", action: { action: "micToggle", inputName: "Mic/Aux" } },
          { label: "CAM", action: { action: "virtualCamToggle" } },
          null,
          null,
          null,
          { label: "REC", action: { action: "recordToggle" } },
        ],
      },
    },
  ],
  [
    "dial (enc_module)",
    {
      kind: "enc_module",
      slots: [
        { l: "JOG", t: "keys", cw: { mods: [], key: "right" }, ccw: { mods: [], key: "left" }, m: 1, b: { t: "combo", mods: [], key: "space" } },
        { l: "ZOOM", t: "scroll", axis: "v", mods: ["WIN"], m: 2 },
        { l: "WHEEL", t: "move", axis: "y", step: 4, drag: true, m: 1, b: { t: "click" } },
        { l: "VOL", t: "consumer", cw: "volume_up", ccw: "volume_down", m: 1, b: { t: "consumer", u: "play_pause" } },
        null,
        null,
      ],
    },
  ],
  ["keystroke with restart", { kind: "keystroke", key: "a", behavior: { on_repress: "restart" } }],
  ["keystroke opted out of hold-repeat", { kind: "keystroke", key: "a", behavior: { hold_repeat: false } }],
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

  // issue #20: single keys hold-repeat by default, like a real keyboard.
  // The firmware applies the default itself, so the file stays silent unless
  // the user deviates from it.
  it("single keys hold-repeat by default (nothing written)", () => {
    expect(holdRepeatDefault("keystroke")).toBe(true);
    expect(holdRepeatDefault("combo")).toBe(false);
    const file = compileAssignment({ kind: "keystroke", key: "e", behavior: { hold_repeat: true } })!;
    expect(file.settings?.hold_repeat).toBeUndefined();
  });

  it("webhook drops blank header rows (an empty name is an invalid header)", () => {
    const f = compileAssignment({
      kind: "webhook",
      url: "https://example.com/hook",
      headers: [
        { name: "", value: "" },
        { name: "Authorization", value: "Bearer x" },
        { name: "   ", value: "ignored" },
      ],
    })!;
    expect(f.webhook?.headers).toEqual([{ name: "Authorization", value: "Bearer x" }]);
  });

  it("webhook with only blank headers omits the headers field entirely", () => {
    const f = compileAssignment({
      kind: "webhook",
      url: "https://example.com/hook",
      headers: [{ name: "", value: "" }],
    })!;
    expect(f.webhook?.headers).toBeUndefined();
  });

  it("single key opted out writes hold_repeat false", () => {
    const file = compileAssignment({ kind: "keystroke", key: "e", behavior: { hold_repeat: false } })!;
    expect(file.settings?.hold_repeat).toBe(false);
  });

  it("legacy keystroke files spelling out hold_repeat true normalize away", () => {
    const a = parseAssignment({
      format: "mkyada-macro",
      version: 2,
      kind: "keystroke",
      combo: { mods: [], key: "e" },
      settings: { hold_repeat: true },
      events: [
        { delay: 0, type: "key", action: "down", key: "e" },
        { delay: 30, type: "key", action: "up", key: "e" },
      ],
    });
    expect(a.behavior?.hold_repeat).toBeUndefined();
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

  it("obs assignment is host-side with no HID events", () => {
    const f = compileAssignment({ kind: "obs", action: "setScene", sceneName: "Cam" })!;
    expect(f.kind).toBe("obs");
    expect(f.obs).toEqual({ action: "setScene", sceneName: "Cam" });
    expect(f.events).toEqual([]);
    expect(kindRequiresHost("obs")).toBe(true);
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

describe("module-slot assignments (issue #19)", () => {
  it("kind none + variants compiles to the concrete built-in carrier (issue #26)", () => {
    const a: Assignment = {
      kind: "none",
      variants: { hold: { kind: "menu", action: "back" } },
    };
    const file = compileSlotAssignment(a, "right");
    expect(file).not.toBeNull();
    expect(file!.kind).toBe("menu");
    expect(file!.menu).toBe("right"); // concrete built-in, not an abstract "default"
    expect(file!.variants?.hold?.kind).toBe("menu");
    expect(file!.variants?.hold?.menu).toBe("back");
    // and parses back to the concrete built-in tap + gesture
    const back = parseAssignment(JSON.parse(JSON.stringify(file)) as MacroFile);
    expect(back).toMatchObject({ kind: "menu", action: "right" });
    expect(back.variants?.hold).toEqual({ kind: "menu", action: "back" });
    expect(back.label).toBeUndefined();
  });

  it("the concrete built-in action with no gestures writes no file (issue #26)", () => {
    expect(compileSlotAssignment({ kind: "menu", action: "right" }, "right")).toBeNull();
    // a different action IS a real override
    expect(compileSlotAssignment({ kind: "menu", action: "confirm" }, "right")).not.toBeNull();
    // isSlotBuiltin backs the same decision
    expect(isSlotBuiltin({ kind: "menu", action: "right" }, "right")).toBe(true);
    expect(isSlotBuiltin({ kind: "menu", action: "confirm" }, "right")).toBe(false);
  });

  it("slotEditValue pre-selects the concrete built-in for an un-overridden slot (issue #26)", () => {
    expect(slotEditValue(undefined, "right")).toEqual({ kind: "menu", action: "right" });
    expect(slotEditValue({ kind: "none" }, "left")).toEqual({ kind: "menu", action: "left" });
    // a legacy built-in-tap-with-gestures keeps its gestures
    expect(
      slotEditValue({ kind: "none", variants: { hold: { kind: "menu", action: "back" } } }, "right"),
    ).toEqual({ kind: "menu", action: "right", variants: { hold: { kind: "menu", action: "back" } } });
    // a real override is left untouched
    expect(slotEditValue({ kind: "scroll", dir: "up" }, "right")).toEqual({ kind: "scroll", dir: "up" });
  });

  it("SLOT_BUILTIN_ACTION maps each module control to its concrete action", () => {
    expect(SLOT_BUILTIN_ACTION["enc-cw"]).toBe("right");
    expect(SLOT_BUILTIN_ACTION["enc-ccw"]).toBe("left");
    expect(SLOT_BUILTIN_ACTION["btn-back"]).toBe("back");
    expect(SLOT_BUILTIN_ACTION["btn-confirm"]).toBe("confirm");
    expect(SLOT_BUILTIN_ACTION["btn-psh"]).toBe("confirm");
  });

  it("kind none without variants stays unassigned (deletes the file)", () => {
    expect(compileSlotAssignment({ kind: "none" }, "right")).toBeNull();
  });

  it("a real tap with a hold variant compiles like a key assignment", () => {
    const a: Assignment = {
      kind: "scroll",
      dir: "up",
      variants: { hold: { kind: "menu", action: "back" } },
    };
    const file = compileSlotAssignment(a, "right");
    expect(file!.kind).toBe("scroll");
    expect(file!.variants?.hold?.menu).toBe("back");
    const back = parseAssignment(JSON.parse(JSON.stringify(file)) as MacroFile);
    expect(back.kind).toBe("scroll");
  });

  it("describeSlotAssignment lists tap and gestures", () => {
    expect(
      describeSlotAssignment({
        kind: "scroll",
        dir: "up",
        variants: { hold: { kind: "menu", action: "back" } },
      }),
    ).toBe("Scroll ↑ · Hold: Menu back");
    expect(
      describeSlotAssignment({
        kind: "none",
        variants: { double: { kind: "media", usage: "mute" } },
      }),
    ).toBe("Built-in · 2×: mute");
  });

  it('"nothing" compiles to a menu:none carrier and round-trips', () => {
    const file = compileSlotAssignment({ kind: "nothing" }, "right");
    expect(file).not.toBeNull();
    expect(file!.kind).toBe("menu");
    expect(file!.menu).toBe("none");
    expect(file!.events).toEqual([]);
    const back = parseAssignment(JSON.parse(JSON.stringify(file)) as MacroFile);
    expect(back.kind).toBe("nothing");
    expect(back.label).toBeUndefined();
    expect(describeAssignment(back)).toBe("Do nothing");
  });

  it("direct-jump menu actions (home/settings) round-trip", () => {
    const settings = compileAssignment({ kind: "menu", action: "settings" });
    expect(settings!.menu).toBe("settings");
    expect(describeAssignment(parseAssignment(settings!))).toBe("Open settings");
    const home = compileAssignment({ kind: "menu", action: "home" });
    expect(home!.menu).toBe("home");
    expect(describeAssignment(parseAssignment(home!))).toBe("Open layer screen");
  });

  it('"nothing" tap can still carry gestures', () => {
    const file = compileSlotAssignment({
      kind: "nothing",
      variants: { hold: { kind: "menu", action: "back" } },
    }, "right");
    expect(file!.menu).toBe("none");
    expect(file!.variants?.hold?.menu).toBe("back");
    const back = parseAssignment(JSON.parse(JSON.stringify(file)) as MacroFile);
    expect(back.kind).toBe("nothing");
    expect(back.variants?.hold).toEqual({ kind: "menu", action: "back" });
    expect(describeSlotAssignment(back)).toBe("Do nothing · Hold: Menu back");
  });
});

// The very first thing a new keypad ever shows. It is written by the setup
// wizard (ProvisionWizard) with an explicit name, and it has to survive the
// trip back: an unnamed starter would leave key 1 blank on the device's grid
// and its Display name box empty in the editor.
describe("first-run starter macro", () => {
  const STARTER_NAME = "MKYADA releases";
  const starter = compileAssignment(
    { kind: "text", text: "https://github.com/asilbalaban/MKYADA/releases/" },
    STARTER_NAME,
  );

  it("carries the name the wizard gave it", () => {
    expect(starter?.name).toBe(STARTER_NAME);
  });

  // The firmware reads a macro's name from LINE 1 and only parses a whole
  // pretty-printed file below 4 KB (ui.py META_MAX_WHOLE). This one is 10 KB,
  // so writing it pretty-printed made a brand-new keypad label key 1 "K1".
  it("puts its name on line 1, where the device looks for it", () => {
    const line1 = serializeForDevice(starter!, 4).split("\n")[0];
    expect((JSON.parse(line1) as MacroFile).name).toBe(STARTER_NAME);
  });

  it("comes back as an editable display name, not a blank field", () => {
    const back = parseAssignment(JSON.parse(JSON.stringify(starter)) as MacroFile);
    expect(back.kind).toBe("text");
    expect(back.label).toBe(STARTER_NAME);
    // and re-saving it keeps the name — no silent rename to "Type: https://…"
    expect(compileAssignment(back)?.name).toBe(STARTER_NAME);
  });
});

describe("dial (enc_module)", () => {
  it("is device-native — never requires the host", () => {
    expect(kindRequiresHost("enc_module")).toBe(false);
  });

  it("labels are clamped to the OLED tile width, slots padded to 6", () => {
    const file = compileAssignment({
      kind: "enc_module",
      slots: [{ l: "TIMELINE", t: "scroll", axis: "h" }],
    })!;
    expect(file.enc_module?.slots).toHaveLength(6);
    expect(file.enc_module?.slots[0]?.l).toBe("TIMELI");
    expect(file.enc_module?.slots[5]).toBeNull();
  });

  it("incomplete slots compile to null (dead keys on the device)", () => {
    const file = compileAssignment({
      kind: "enc_module",
      slots: [
        { l: "X", t: "keys" }, // no cw/ccw — nothing to do
        { l: "OK", t: "scroll", axis: "v" },
      ],
    })!;
    expect(file.enc_module?.slots[0]).toBeNull();
    expect(file.enc_module?.slots[1]).not.toBeNull();
  });

  it("needs at least one working slot to be saveable", () => {
    expect(assignmentComplete({ kind: "enc_module" })).toBe(false);
    expect(assignmentComplete({ kind: "enc_module", slots: [] })).toBe(false);
    expect(assignmentComplete({ kind: "enc_module", slots: [{ l: "X", t: "keys" }] })).toBe(false);
    expect(
      assignmentComplete({ kind: "enc_module", slots: [{ l: "S", t: "scroll", axis: "v" }] }),
    ).toBe(true);
  });

  it("presets are sane: ≤6 slots, tile-sized labels, valid mods & multipliers", () => {
    for (const p of ENC_PRESETS) {
      expect(p.slots.length).toBeLessThanOrEqual(6);
      let working = 0;
      for (const s of encPresetSlots(p)) {
        if (!s) continue;
        working++;
        expect(encSlotComplete(s)).toBe(true);
        expect(s.l.length).toBeGreaterThan(0);
        expect(s.l.length).toBeLessThanOrEqual(ENC_LABEL_MAX);
        expect(s.l).toBe(s.l.toUpperCase());
        expect(s.m ?? 1).toBeGreaterThanOrEqual(1);
        expect(s.m ?? 1).toBeLessThanOrEqual(10);
        const mods: string[] = [];
        if (s.t === "keys") mods.push(...(s.cw?.mods ?? []), ...(s.ccw?.mods ?? []));
        if (s.t === "scroll") mods.push(...(s.mods ?? []));
        if (s.b?.t === "combo") mods.push(...s.b.mods);
        for (const m of mods) expect(MODIFIERS).toContain(m);
      }
      expect(working).toBeGreaterThan(0);
    }
  });

  it("editing a preset's slots never mutates the preset", () => {
    const p = ENC_PRESETS[0];
    const a = encPresetSlots(p);
    const b = encPresetSlots(p);
    a.forEach((s) => s && (s.l = "EDITED"));
    expect(b).toEqual(encPresetSlots(p));
  });
});

describe("dial presets resolve through the keyboard layout", () => {
  // A Turkish-Q-style fixture: the characters the presets mean live on
  // different physical keys than on US (the field bug: "zoom out" pressed
  // the US "-" position, which types another character on Turkish-Q).
  const TRQ = {
    "0": { base: "0", shift: "=", altgr: "}" },
    "-": { base: "*", shift: "?", altgr: "\\" },
    "=": { base: "-", shift: "_", altgr: "" },
    "[": { base: "ğ", shift: "Ğ", altgr: "¨" },
    "]": { base: "ü", shift: "Ü", altgr: "~" },
    "8": { base: "8", shift: "(", altgr: "[" },
    "9": { base: "9", shift: ")", altgr: "]" },
    z: { base: "z", shift: "Z", altgr: "" },
  };

  afterEach(() => applyLayoutMap({}));

  it("character shortcuts land on the key that types them", () => {
    applyLayoutMap(TRQ);
    const prem = ENC_PRESETS.find((p) => p.id === "premiere")!;
    const zoom = encPresetSlots(prem).find((s) => s?.l === "ZOOM");
    if (zoom?.t !== "keys") throw new Error("zoom slot missing");
    // "=" is shift+0 on this layout; "-" sits on the US "=" position
    expect(zoom.cw).toEqual({ mods: ["SHIFT"], key: "0" });
    expect(zoom.ccw).toEqual({ mods: [], key: "=" });
  });

  it("altgr characters carry the alt_gr modifier", () => {
    applyLayoutMap(TRQ);
    const prem = ENC_PRESETS.find((p) => p.id === "premiere")!;
    const gain = encPresetSlots(prem).find((s) => s?.l === "GAIN");
    if (gain?.t !== "keys") throw new Error("gain slot missing");
    // "[" / "]" are AltGr+8 / AltGr+9 on this layout
    expect(gain.cw).toEqual({ mods: ["ALT_GR"], key: "9" });
    expect(gain.ccw).toEqual({ mods: ["ALT_GR"], key: "8" });
  });

  it("photoshop brush rides the scrub HUD, not the layout-hostile brackets", () => {
    applyLayoutMap(TRQ);
    const ps = ENC_PRESETS.find((p) => p.id === "photoshop")!;
    const brush = encPresetSlots(ps).find((s) => s?.l === "BRUSH");
    if (brush?.t !== "move") throw new Error("brush slot missing");
    expect(brush.drag).toBe(true);
    expect(brush.mods).toEqual(["CTRL", "ALT"]);
  });

  it("named keys (arrows, space) pass through untouched", () => {
    applyLayoutMap(TRQ);
    const prem = ENC_PRESETS.find((p) => p.id === "premiere")!;
    const jog = encPresetSlots(prem).find((s) => s?.l === "JOG");
    if (jog?.t !== "keys") throw new Error("jog slot missing");
    expect(jog.cw).toEqual({ mods: [], key: "right" });
    expect(jog.b).toEqual({ t: "combo", mods: [], key: "space" });
  });

  it("US fallback keeps the original keys", () => {
    const prem = ENC_PRESETS.find((p) => p.id === "premiere")!;
    const zoom = encPresetSlots(prem).find((s) => s?.l === "ZOOM");
    if (zoom?.t !== "keys") throw new Error("zoom slot missing");
    expect(zoom.cw).toEqual({ mods: [], key: "=" });
    expect(zoom.ccw).toEqual({ mods: [], key: "-" });
  });
});

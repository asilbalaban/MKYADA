// Core 6 / Vision 6 model split: model resolution, layer math, slot file
// naming (and its reverse, used for macro_changed), default key wiring.
import { describe, expect, it } from "vitest";
import {
  EDGE_PINS,
  MODEL_META,
  RESERVED_PINS,
  VISION6_DEFAULT_PINS,
  assignablePins,
  defaultPins,
  deviceModel,
} from "./types";
import {
  effectiveLayers,
  macroFileName,
  parseMacroFileName,
  profileKeySlot,
  profileMacroFileName,
  slotFileName,
} from "./macro-model";

describe("deviceModel", () => {
  it("defaults to core6 when the field is missing (old firmware)", () => {
    expect(deviceModel(null)).toBe("core6");
    expect(deviceModel(undefined)).toBe("core6");
    expect(deviceModel({})).toBe("core6");
    expect(deviceModel({ model: null })).toBe("core6");
  });

  it("recognizes vision6, treats unknown strings as core6", () => {
    expect(deviceModel({ model: "vision6" })).toBe("vision6");
    expect(deviceModel({ model: "core6" })).toBe("core6");
    expect(deviceModel({ model: "vision7" })).toBe("core6");
  });

  it("has label + image metadata for both models", () => {
    expect(MODEL_META.core6.label).toBe("MKYADA Core 6");
    expect(MODEL_META.vision6.label).toBe("MKYADA Vision 6");
    expect(MODEL_META.core6.image).toBe("/devices/core6.png");
    expect(MODEL_META.vision6.image).toBe("/devices/vision6.png");
  });
});

describe("effectiveLayers", () => {
  it("core6 needs a layer key to reach extra layers", () => {
    expect(effectiveLayers({ layer_key: null, layer_count: 4 })).toBe(1);
    expect(effectiveLayers({ layer_key: 6, layer_count: 4 })).toBe(4);
    expect(effectiveLayers({ model: "core6", layer_key: null, layer_count: 8 })).toBe(1);
  });

  it("vision6 layers stand alone (picked with the wheel, layer_key null)", () => {
    expect(effectiveLayers({ model: "vision6", layer_key: null, layer_count: 3 })).toBe(3);
    expect(effectiveLayers({ model: "vision6", layer_key: null, layer_count: 1 })).toBe(1);
    expect(effectiveLayers({ model: "vision6", layer_key: null, layer_count: 8 })).toBe(8);
  });
});

describe("slot file naming", () => {
  it("module slots follow the same layer-suffix rule as keys", () => {
    expect(slotFileName("enc-cw", 0)).toBe("macros/enc-cw.json");
    expect(slotFileName("enc-ccw", 0)).toBe("macros/enc-ccw.json");
    expect(slotFileName("enc-cw", 1)).toBe("macros/enc-cw-b.json");
    expect(slotFileName("btn-back", 2)).toBe("macros/btn-back-c.json");
    expect(slotFileName("btn-confirm", 7)).toBe("macros/btn-confirm-h.json");
  });

  it("parseMacroFileName inverts key and slot names", () => {
    expect(parseMacroFileName(macroFileName(3, 0))).toEqual({ slot: 3, layer: 0 });
    expect(parseMacroFileName(macroFileName(12, 4))).toEqual({ slot: 12, layer: 4 });
    expect(parseMacroFileName(slotFileName("enc-ccw", 0))).toEqual({ slot: "enc-ccw", layer: 0 });
    expect(parseMacroFileName(slotFileName("btn-confirm", 1))).toEqual({
      slot: "btn-confirm",
      layer: 1,
    });
  });

  it("profile macros cover key numbers and module slots (issue #17)", () => {
    expect(profileMacroFileName("abc", 3)).toBe("macros/p_abc_key3.json");
    expect(profileMacroFileName("abc", "enc-cw")).toBe("macros/p_abc_enc-cw.json");
    expect(profileMacroFileName("abc", "btn-confirm")).toBe("macros/p_abc_btn-confirm.json");
    expect(profileKeySlot("3")).toBe(3);
    expect(profileKeySlot("enc-ccw")).toBe("enc-ccw");
  });

  it("accepts device-style absolute paths (macro_changed messages)", () => {
    expect(parseMacroFileName("/macros/key3-b.json")).toEqual({ slot: 3, layer: 1 });
    expect(parseMacroFileName("/macros/enc-cw.json")).toEqual({ slot: "enc-cw", layer: 0 });
  });

  it("rejects aux part files, profile macros and junk", () => {
    expect(parseMacroFileName("macros/key3-b.s2.json")).toBeNull();
    expect(parseMacroFileName("macros/key3.vd.json")).toBeNull();
    expect(parseMacroFileName("macros/key3.vh.json")).toBeNull();
    expect(parseMacroFileName("macros/p_abc_key4.json")).toBeNull();
    expect(parseMacroFileName("config.json")).toBeNull();
    expect(parseMacroFileName("")).toBeNull();
  });
});

describe("default key wiring", () => {
  it("vision6 factory order matches the firmware", () => {
    expect(defaultPins("vision6", 6)).toEqual(["GP29", "GP28", "GP27", "GP26", "GP15", "GP14"]);
    expect(defaultPins("vision6", 6)).toEqual(VISION6_DEFAULT_PINS);
  });

  it("core6 walks GP0..GP15 then GP26..GP29", () => {
    expect(defaultPins("core6", 6)).toEqual(["GP0", "GP1", "GP2", "GP3", "GP4", "GP5"]);
    expect(defaultPins("core6", 20).slice(16)).toEqual(["GP26", "GP27", "GP28", "GP29"]);
    expect(defaultPins("core6", 20)).toHaveLength(20);
  });

  it("reserved pins never show up as assignable", () => {
    for (const p of RESERVED_PINS.vision6) {
      expect(assignablePins("vision6")).not.toContain(p);
    }
    expect(assignablePins("vision6")).not.toContain("GP0");
    expect(assignablePins("vision6")).not.toContain("GP6");
    expect(assignablePins("core6")).not.toContain("GP16");
    // GP16 isn't an edge pin at all
    expect(EDGE_PINS).not.toContain("GP16");
  });

  it("edge pin list is GP0..GP15 + GP26..GP29", () => {
    expect(EDGE_PINS).toHaveLength(20);
    expect(EDGE_PINS[0]).toBe("GP0");
    expect(EDGE_PINS[15]).toBe("GP15");
    expect(EDGE_PINS.slice(16)).toEqual(["GP26", "GP27", "GP28", "GP29"]);
  });
});

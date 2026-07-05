// Layout resolution: US fallback plus injected TR-Q / QWERTZ / AZERTY maps.
// The Rust side owns *reading* the OS layout; these tests pin down how the
// TS side resolves characters to positional keystrokes once a map is loaded.
import { beforeEach, describe, expect, it } from "vitest";
import { applyLayoutMap, charToKeystroke, displayKey, untypeableChars, type KeyChars } from "./layout";

const k = (base: string, shift = "", altgr = ""): KeyChars => ({ base, shift, altgr });

// Positional-label subsets of real layouts (label = what the key is on US).
const TR_Q: Record<string, KeyChars> = {
  q: k("q", "Q", "@"),
  i: k("ı", "I", "i"),
  "'": k("i", "İ"),
  ";": k("ş", "Ş"),
  ",": k("ö", "Ö"),
  ".": k("ç", "Ç"),
  "/": k(".", ":"),
  "[": k("ğ", "Ğ"),
  "]": k("ü", "Ü"),
  "3": k("3", "^", "#"),
  a: k("a", "A"),
};

const QWERTZ: Record<string, KeyChars> = {
  y: k("z", "Z"),
  z: k("y", "Y"),
  "[": k("ü", "Ü"),
  ";": k("ö", "Ö"),
  "'": k("ä", "Ä"),
  "-": k("ß", "?", "\\"),
  q: k("q", "Q", "@"),
};

const AZERTY: Record<string, KeyChars> = {
  q: k("a", "A"),
  a: k("q", "Q"),
  w: k("z", "Z"),
  z: k("w", "W"),
  m: k(",", "?"),
  ";": k("m", "M"),
  "0": k("à", "0", "@"),
};

beforeEach(() => applyLayoutMap({}));

describe("US fallback (no map loaded)", () => {
  it("resolves plain and shifted letters", () => {
    expect(charToKeystroke("a")).toEqual({ key: "a", shift: false });
    expect(charToKeystroke("A")).toEqual({ key: "a", shift: true });
  });
  it("resolves shifted symbols", () => {
    expect(charToKeystroke("@")).toEqual({ key: "2", shift: true });
    expect(charToKeystroke("?")).toEqual({ key: "/", shift: true });
  });
  it("reports non-US characters as untypeable", () => {
    expect(charToKeystroke("ç")).toBeNull();
    expect(untypeableChars("açık")).toEqual(["ç", "ı"]);
  });
  it("skips whitespace in untypeableChars (compiled separately)", () => {
    expect(untypeableChars("a b\tc\nd")).toEqual([]);
  });
});

describe("Turkish Q", () => {
  beforeEach(() => applyLayoutMap(TR_Q));
  it.each([
    ["ç", { key: ".", shift: false }],
    ["Ç", { key: ".", shift: true }],
    ["ş", { key: ";", shift: false }],
    ["ğ", { key: "[", shift: false }],
    ["ü", { key: "]", shift: false }],
    ["ö", { key: ",", shift: false }],
    ["ı", { key: "i", shift: false }],
  ])("%s -> positional key", (ch, want) => {
    expect(charToKeystroke(ch)).toEqual(want);
  });
  it("reaches @ via AltGr+Q", () => {
    expect(charToKeystroke("@")).toEqual({ key: "q", shift: false, altgr: true });
  });
  it("prefers base over altgr when a char is on both ('i' is base of US-quote, altgr of I)", () => {
    expect(charToKeystroke("i")).toEqual({ key: "'", shift: false });
  });
  it("dotted/dotless capitals resolve to their own keys", () => {
    expect(charToKeystroke("İ")).toEqual({ key: "'", shift: true });
    expect(charToKeystroke("I")).toEqual({ key: "i", shift: true });
  });
  it("displayKey shows what the key types locally", () => {
    expect(displayKey("/")).toBe(".");
    expect(displayKey(";")).toBe("ş");
  });
  it("flags chars absent from the layout", () => {
    expect(untypeableChars("çş €")).toEqual(["€"]);
  });
});

describe("QWERTZ", () => {
  beforeEach(() => applyLayoutMap(QWERTZ));
  it("swaps y/z positions", () => {
    expect(charToKeystroke("z")).toEqual({ key: "y", shift: false });
    expect(charToKeystroke("y")).toEqual({ key: "z", shift: false });
  });
  it("umlauts and ß on their German keys", () => {
    expect(charToKeystroke("ö")).toEqual({ key: ";", shift: false });
    expect(charToKeystroke("ß")).toEqual({ key: "-", shift: false });
    expect(charToKeystroke("Ä")).toEqual({ key: "'", shift: true });
  });
  it("@ via AltGr+Q", () => {
    expect(charToKeystroke("@")).toEqual({ key: "q", shift: false, altgr: true });
  });
});

describe("AZERTY", () => {
  beforeEach(() => applyLayoutMap(AZERTY));
  it("a/q and z/w swaps", () => {
    expect(charToKeystroke("a")).toEqual({ key: "q", shift: false });
    expect(charToKeystroke("q")).toEqual({ key: "a", shift: false });
    expect(charToKeystroke("z")).toEqual({ key: "w", shift: false });
  });
  it("m sits on the US semicolon key", () => {
    expect(charToKeystroke("m")).toEqual({ key: ";", shift: false });
  });
  it("digits are shifted, @ via AltGr", () => {
    expect(charToKeystroke("0")).toEqual({ key: "0", shift: true });
    expect(charToKeystroke("à")).toEqual({ key: "0", shift: false });
    expect(charToKeystroke("@")).toEqual({ key: "0", shift: false, altgr: true });
  });
});

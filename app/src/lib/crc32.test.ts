import { describe, expect, it } from "vitest";
import { crc32Bytes, crc32Text, utf8Length } from "./crc32";

// Reference values computed with CPython's binascii.crc32 — the exact
// implementation CircuitPython uses for the meta.json manifest. If these
// match, the app-side diff can trust the firmware's `c` values.
describe("crc32 parity with binascii.crc32", () => {
  it("standard check vector", () => {
    expect(crc32Bytes(new TextEncoder().encode("123456789"))).toBe(3421780262);
  });
  it("multi-byte UTF-8 goes through the same bytes", () => {
    expect(crc32Text("şğüö MKYADA")).toBe(754009680);
    expect(utf8Length("şğüö MKYADA")).toBe(15);
  });
  it("empty input", () => {
    expect(crc32Text("")).toBe(0);
    expect(utf8Length("")).toBe(0);
  });
});

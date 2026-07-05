// Guards the committed contract corpus (tests/fixtures/*.json) against
// drifting from what compileAssignment actually produces. The firmware sim
// (tests/firmware_sim_test.py) plays those same files through the engine, so
// together the two suites prove app-compiled JSON runs on the device.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CANONICAL, compileFixture } from "../../../tests/fixtures_src";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "tests", "fixtures");

describe("contract fixtures", () => {
  it("every canonical assignment has a committed fixture and vice versa", () => {
    const onDisk = readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
    expect(onDisk).toEqual(Object.keys(CANONICAL).sort());
  });

  it.each(Object.keys(CANONICAL))("%s matches compileAssignment output (else: npx tsx tests/gen_fixtures.ts)", (name) => {
    const committed = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
    expect(compileFixture(CANONICAL[name])).toEqual(committed);
  });
});

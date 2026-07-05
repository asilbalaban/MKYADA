// Writes the app↔firmware contract corpus to tests/fixtures/.
// Run after changing compileAssignment output: npx tsx tests/gen_fixtures.ts
// (app/src/lib/fixtures.test.ts fails when the committed files go stale.)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CANONICAL, compileFixture } from "./fixtures_src";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
mkdirSync(dir, { recursive: true });
for (const [name, assignment] of Object.entries(CANONICAL)) {
  const file = compileFixture(assignment);
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(file, null, 2) + "\n");
  console.log("wrote", `fixtures/${name}.json`);
}

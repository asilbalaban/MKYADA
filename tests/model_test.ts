// Logic tests for the app's recorder model: group/flatten roundtrip, RDP
// thinning, resampling. Run: npx tsx tests/model_test.ts
import {
  flattenItems,
  groupDuration,
  groupEvents,
  isMoveGroup,
  rdpSimplify,
  resample,
  setGroupDuration,
  straighten,
  thinForDevice,
} from "../app/src/lib/recorder-model";
import type { MacroEvent } from "../app/src/lib/types";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(cond ? "PASS" : "FAIL", name, cond ? "" : detail);
  if (!cond) failed++;
}

// straight-line path with 15ms sampling, 100 points
const moves: MacroEvent[] = Array.from({ length: 100 }, (_, i) => ({
  delay: i === 0 ? 200 : 15,
  type: "move" as const,
  x: 100 + i * 5,
  y: 200 + i * 3,
}));
const events: MacroEvent[] = [
  { delay: 0, type: "key", action: "down", key: "a" },
  { delay: 30, type: "key", action: "up", key: "a" },
  ...moves,
  { delay: 10, type: "button", action: "down", button: "left", x: 595, y: 497 },
  { delay: 40, type: "button", action: "up", button: "left", x: 595, y: 497 },
];

const items = groupEvents(events);
check("grouping shape", items.length === 5, String(items.length));
const g = items[2];
check("movegroup present", isMoveGroup(g));
if (isMoveGroup(g)) {
  check("group delay = first move delay", g.delay === 200);
  check("group points", g.points.length === 100);
  check("group duration", groupDuration(g) === 99 * 15, String(groupDuration(g)));

  const flat = flattenItems(items);
  check("roundtrip length", flat.length === events.length);
  check("roundtrip equality", JSON.stringify(flat) === JSON.stringify(events));

  const rescaled = setGroupDuration(g, Math.round(99 * 15 * 2));
  check("rescale 2x", Math.abs(groupDuration(rescaled) - 99 * 15 * 2) < 100, String(groupDuration(rescaled)));

  const st = straighten(g);
  check(
    "straighten keeps endpoints+duration",
    st.points.length === 2 && groupDuration(st) === 99 * 15 && st.points[1].x === g.points[99].x,
  );

  const simplified = rdpSimplify(g, 3);
  check("rdp collapses straight line", simplified.points.length === 2, String(simplified.points.length));
  check("rdp preserves total duration", groupDuration(simplified) === 99 * 15, String(groupDuration(simplified)));

  // 30/s is an upper bound: 15ms samples merge into >=33ms buckets
  const rs = resample(g, 30);
  const rate = rs.points.length / (groupDuration(rs) / 1000);
  check("resample caps rate <=30/s", rate <= 31 && rs.points.length > 20, `pts=${rs.points.length} rate=${rate.toFixed(1)}`);
  check("resample preserves duration", Math.abs(groupDuration(rs) - 99 * 15) <= 20, String(groupDuration(rs)));
}

const thinned = thinForDevice(events);
check(
  "thin keeps keys/buttons",
  thinned.filter((e) => e.type === "key").length === 2 && thinned.filter((e) => e.type === "button").length === 2,
);
check("thin reduces straight moves to 2", thinned.filter((e) => e.type === "move").length === 2,
  String(thinned.filter((e) => e.type === "move").length));

// zigzag path should NOT collapse
const zig: MacroEvent[] = Array.from({ length: 50 }, (_, i) => ({
  delay: i === 0 ? 0 : 15,
  type: "move" as const,
  x: i * 10,
  y: i % 2 === 0 ? 100 : 200,
}));
check("zigzag survives rdp", thinForDevice(zig).length > 10, String(thinForDevice(zig).length));

console.log(failed ? `\n${failed} FAILED` : "\nALL MODEL TESTS PASSED");
process.exit(failed ? 1 : 0);

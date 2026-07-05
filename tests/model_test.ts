// Logic tests for the app's recorder model: group/flatten roundtrip, RDP
// thinning, resampling. Run: npx tsx tests/model_test.ts
import {
  dragDuration,
  flattenItems,
  groupDuration,
  groupEvents,
  isClickGroup,
  isDragGroup,
  isMoveGroup,
  itemLabel,
  MOVE_SPLIT_MS,
  rdpSimplify,
  remapDrag,
  resample,
  setGroupDuration,
  setItemLabel,
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

// down + up with no moves between → one Click row
const items = groupEvents(events);
check("grouping shape", items.length === 4, String(items.length));
check("click grouped", isClickGroup(items[3]));
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

// down → moves → up becomes one Drag row; roundtrip stays byte-identical
const dragEvents: MacroEvent[] = [
  { delay: 5, type: "button", action: "down", button: "left", x: 10, y: 10 },
  { delay: 20, type: "move", x: 50, y: 50 },
  { delay: 20, type: "move", x: 90, y: 90 },
  { delay: 30, type: "button", action: "up", button: "left", x: 90, y: 90 },
];
const dragItems = groupEvents(dragEvents);
check("drag grouped", dragItems.length === 1 && isDragGroup(dragItems[0]), String(dragItems.length));
check(
  "drag roundtrip",
  JSON.stringify(flattenItems(dragItems)) === JSON.stringify(dragEvents),
);
if (isDragGroup(dragItems[0])) {
  const d = dragItems[0];
  check("drag duration", dragDuration(d) === 70, String(dragDuration(d)));
  const remapped = remapDrag(d, { x: 110, y: 110 }, { x: 190, y: 190 });
  check(
    "drag remap moves endpoints",
    remapped.down.x === 110 && remapped.up.x === 190 && remapped.moves[0].x === 150,
    JSON.stringify([remapped.down.x, remapped.moves[0].x, remapped.up.x]),
  );
}

// an unmatched down (up interrupted by a key event) stays ungrouped
const unmatched: MacroEvent[] = [
  { delay: 0, type: "button", action: "down", button: "left", x: 1, y: 1 },
  { delay: 10, type: "key", action: "down", key: "a" },
  { delay: 10, type: "button", action: "up", button: "left", x: 1, y: 1 },
];
check("unmatched down stays raw", groupEvents(unmatched).length === 3);
check(
  "unmatched roundtrip",
  JSON.stringify(flattenItems(groupEvents(unmatched))) === JSON.stringify(unmatched),
);

// long uninterrupted mouse travel splits into ~MOVE_SPLIT_MS rows
const longMoves: MacroEvent[] = Array.from({ length: 100 }, (_, i) => ({
  delay: i === 0 ? 0 : 50, // 99 * 50ms = 4950ms of travel
  type: "move" as const,
  x: i,
  y: i,
}));
const longItems = groupEvents(longMoves);
check("long travel splits", longItems.length === 3, String(longItems.length));
check(
  "split respects cap",
  longItems.every((it) => isMoveGroup(it) && groupDuration(it) <= MOVE_SPLIT_MS),
);
check(
  "split roundtrip",
  JSON.stringify(flattenItems(longItems)) === JSON.stringify(longMoves),
);

// row titles survive the flatten/group roundtrip (stored on the first event)
const titled = setItemLabel(dragItems[0], "Item seçme tıklaması");
const titledFlat = flattenItems([titled]);
check("label lands on down event", titledFlat[0].label === "Item seçme tıklaması");
check("label roundtrip", itemLabel(groupEvents(titledFlat)[0]) === "Item seçme tıklaması");

console.log(failed ? `\n${failed} FAILED` : "\nALL MODEL TESTS PASSED");
process.exit(failed ? 1 : 0);

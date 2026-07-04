// Recorder/editor data model, ported from the tkinter recorder
// (group_events / flatten_items / straighten / set_group_duration) plus
// Ramer–Douglas–Peucker thinning for the device's RAM budget.

import type { MacroEvent, MacroFile } from "./types";

export interface MovePoint {
  x: number;
  y: number;
  dt: number; // ms since previous point (first point: 0, lead time in delay)
}

export interface MoveGroup {
  type: "movegroup";
  delay: number;
  points: MovePoint[];
}

export type EditorItem = MacroEvent | MoveGroup;

export function isMoveGroup(item: EditorItem): item is MoveGroup {
  return item.type === "movegroup";
}

/** Collapse consecutive move events into editable movegroups. */
export function groupEvents(events: MacroEvent[]): EditorItem[] {
  const items: EditorItem[] = [];
  let group: MoveGroup | null = null;
  for (const ev of events) {
    if (ev.type === "move") {
      if (!group) {
        group = { type: "movegroup", delay: ev.delay, points: [{ x: ev.x, y: ev.y, dt: 0 }] };
        items.push(group);
      } else {
        group.points.push({ x: ev.x, y: ev.y, dt: ev.delay });
      }
    } else {
      group = null;
      items.push({ ...ev });
    }
  }
  return items;
}

/** Expand movegroups back to flat move events (the saved format). */
export function flattenItems(items: EditorItem[]): MacroEvent[] {
  const out: MacroEvent[] = [];
  for (const item of items) {
    if (isMoveGroup(item)) {
      item.points.forEach((p, i) => {
        out.push({ delay: i === 0 ? item.delay : p.dt, type: "move", x: p.x, y: p.y });
      });
    } else {
      out.push({ ...item });
    }
  }
  return out;
}

export function groupDuration(g: MoveGroup): number {
  return g.points.reduce((sum, p) => sum + p.dt, 0);
}

/** Proportionally rescale a movegroup's internal timing to a new duration. */
export function setGroupDuration(g: MoveGroup, ms: number): MoveGroup {
  const current = groupDuration(g);
  if (current <= 0 || ms < 0) return g;
  const factor = ms / current;
  return {
    ...g,
    points: g.points.map((p, i) => (i === 0 ? p : { ...p, dt: Math.max(1, Math.round(p.dt * factor)) })),
  };
}

/** Drop intermediate points, keeping the endpoints and total duration. */
export function straighten(g: MoveGroup): MoveGroup {
  if (g.points.length <= 2) return g;
  const duration = groupDuration(g);
  const first = g.points[0];
  const last = g.points[g.points.length - 1];
  return { ...g, points: [{ ...first, dt: 0 }, { ...last, dt: duration }] };
}

// --- Ramer–Douglas–Peucker on the mouse path ---

function perpDistance(p: MovePoint, a: MovePoint, b: MovePoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
}

function rdpIndices(points: MovePoint[], tolerance: number, lo: number, hi: number, keep: Set<number>) {
  if (hi <= lo + 1) return;
  let maxDist = -1;
  let index = -1;
  for (let i = lo + 1; i < hi; i++) {
    const d = perpDistance(points[i], points[lo], points[hi]);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist > tolerance) {
    keep.add(index);
    rdpIndices(points, tolerance, lo, index, keep);
    rdpIndices(points, tolerance, index, hi, keep);
  }
}

/** Simplify a movegroup path; retained points keep their cumulative timing. */
export function rdpSimplify(g: MoveGroup, tolerancePx = 3): MoveGroup {
  if (g.points.length <= 2) return g;
  const keep = new Set<number>([0, g.points.length - 1]);
  rdpIndices(g.points, tolerancePx, 0, g.points.length - 1, keep);
  const kept = [...keep].sort((a, b) => a - b);
  // cumulative time at each original index
  const cum: number[] = [];
  let t = 0;
  g.points.forEach((p) => {
    t += p.dt;
    cum.push(t);
  });
  let prevT = 0;
  const points = kept.map((idx, i) => {
    const p = g.points[idx];
    const dt = i === 0 ? 0 : Math.max(1, Math.round(cum[idx] - prevT));
    prevT = cum[idx];
    return { x: p.x, y: p.y, dt };
  });
  return { ...g, points };
}

/** Cap the sample rate of a movegroup (merge points closer than minIntervalMs). */
export function resample(g: MoveGroup, maxPerSecond = 30): MoveGroup {
  const minInterval = 1000 / maxPerSecond;
  if (g.points.length <= 2) return g;
  const points: MovePoint[] = [g.points[0]];
  let acc = 0;
  for (let i = 1; i < g.points.length - 1; i++) {
    acc += g.points[i].dt;
    if (acc >= minInterval) {
      points.push({ ...g.points[i], dt: Math.round(acc) });
      acc = 0;
    }
  }
  const last = g.points[g.points.length - 1];
  points.push({ ...last, dt: Math.round(acc + last.dt) });
  return { ...g, points };
}

/** "Optimize for device": resample + RDP every movegroup. */
export function thinForDevice(events: MacroEvent[], tolerancePx = 3, maxPerSecond = 30): MacroEvent[] {
  const items = groupEvents(events).map((item) =>
    isMoveGroup(item) ? rdpSimplify(resample(item, maxPerSecond), tolerancePx) : item,
  );
  return flattenItems(items);
}

export function describeItem(item: EditorItem): string {
  if (isMoveGroup(item)) {
    const first = item.points[0];
    const last = item.points[item.points.length - 1];
    return `Mouse path · ${item.points.length} pts · (${first.x},${first.y}) → (${last.x},${last.y}) · ${groupDuration(item)} ms`;
  }
  switch (item.type) {
    case "key":
      return `Key ${item.action}: ${item.key}`;
    case "button":
      return `${item.button} ${item.action} @ (${item.x},${item.y})`;
    case "scroll":
      return `Scroll ${item.dy > 0 ? "up" : "down"} (${item.dy})`;
    case "move":
      return `Move to (${item.x},${item.y})`;
    case "wait":
      return "Wait";
    default:
      return item.type;
  }
}

export function macroStats(m: MacroFile): { events: number; bytes: number; tooBig: boolean } {
  const bytes = new TextEncoder().encode(JSON.stringify(m)).length;
  return { events: m.events.length, bytes, tooBig: m.events.length > 2000 || bytes > 120_000 };
}

export function captureScreen(): { width: number; height: number } {
  return {
    width: Math.round(screen.width * devicePixelRatio),
    height: Math.round(screen.height * devicePixelRatio),
  };
}

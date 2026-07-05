// Recorder/editor data model, ported from the tkinter recorder
// (group_events / flatten_items / straighten / set_group_duration) plus
// Ramer–Douglas–Peucker thinning for the device's RAM budget.

import type { MacroEvent, MacroFile } from "./types";
import { IS_MAC } from "./macro-model";
import { displayKey } from "./layout";

export interface MovePoint {
  x: number;
  y: number;
  dt: number; // ms since previous point (first point: 0, lead time in delay)
}

export interface MoveGroup {
  type: "movegroup";
  delay: number;
  label?: string;
  points: MovePoint[];
}

type MoveEvent = Extract<MacroEvent, { type: "move" }>;
type ButtonEvent = Extract<MacroEvent, { type: "button" }>;

/** button down + up at (roughly) the same spot, edited as one "Click" row. */
export interface ClickGroup {
  type: "clickgroup";
  down: ButtonEvent;
  up: ButtonEvent;
}

/** button down → mouse path → button up, edited as one "Drag" row. */
export interface DragGroup {
  type: "draggroup";
  down: ButtonEvent;
  moves: MovePoint[]; // dt = each move event's delay
  up: ButtonEvent;
}

export type EditorItem = MacroEvent | MoveGroup | ClickGroup | DragGroup;

export function isMoveGroup(item: EditorItem): item is MoveGroup {
  return item.type === "movegroup";
}

export function isClickGroup(item: EditorItem): item is ClickGroup {
  return item.type === "clickgroup";
}

export function isDragGroup(item: EditorItem): item is DragGroup {
  return item.type === "draggroup";
}

/** Long uninterrupted mouse travel is cut into rows of at most this much
 * time, so a later edit (fix one coordinate mid-flight) doesn't force the
 * user to dissect a single 6-second path. */
export const MOVE_SPLIT_MS = 2000;

/**
 * Collapse the flat event list into editable rows:
 * - button down [+ moves] + matching up  →  one Click / Drag row
 * - consecutive moves                    →  movegroups, split every ~2s
 * Grouping is a pure view transform: flattenItems() restores the exact list.
 */
export function groupEvents(events: MacroEvent[]): EditorItem[] {
  const items: EditorItem[] = [];
  let i = 0;
  while (i < events.length) {
    const ev = events[i];
    if (ev.type === "button" && ev.action === "down") {
      // look ahead: only moves until the matching up → click/drag group
      let j = i + 1;
      while (j < events.length && events[j].type === "move") j++;
      const end = events[j];
      if (end && end.type === "button" && end.action === "up" && end.button === ev.button) {
        const moves = events.slice(i + 1, j) as MoveEvent[];
        if (moves.length === 0) {
          items.push({ type: "clickgroup", down: { ...ev }, up: { ...end } });
        } else {
          items.push({
            type: "draggroup",
            down: { ...ev },
            moves: moves.map((m) => ({ x: m.x, y: m.y, dt: m.delay })),
            up: { ...end },
          });
        }
        i = j + 1;
        continue;
      }
    }
    if (ev.type === "move") {
      let group: MoveGroup = {
        type: "movegroup",
        delay: ev.delay,
        points: [{ x: ev.x, y: ev.y, dt: 0 }],
      };
      if (ev.label) group.label = ev.label;
      items.push(group);
      let dur = 0;
      i++;
      while (i < events.length && events[i].type === "move") {
        const m = events[i] as MoveEvent;
        if (dur + m.delay > MOVE_SPLIT_MS && group.points.length > 1) {
          group = { type: "movegroup", delay: m.delay, points: [{ x: m.x, y: m.y, dt: 0 }] };
          if (m.label) group.label = m.label;
          items.push(group);
          dur = 0;
        } else {
          group.points.push({ x: m.x, y: m.y, dt: m.delay });
          dur += m.delay;
        }
        i++;
      }
      continue;
    }
    items.push({ ...ev });
    i++;
  }
  return items;
}

/** Expand grouped rows back to flat events (the saved format). */
export function flattenItems(items: EditorItem[]): MacroEvent[] {
  const out: MacroEvent[] = [];
  for (const item of items) {
    if (isMoveGroup(item)) {
      item.points.forEach((p, i) => {
        const ev: MacroEvent = { delay: i === 0 ? item.delay : p.dt, type: "move", x: p.x, y: p.y };
        if (i === 0 && item.label) ev.label = item.label;
        out.push(ev);
      });
    } else if (isClickGroup(item)) {
      out.push({ ...item.down }, { ...item.up });
    } else if (isDragGroup(item)) {
      out.push({ ...item.down });
      for (const p of item.moves) out.push({ delay: p.dt, type: "move", x: p.x, y: p.y });
      out.push({ ...item.up });
    } else {
      out.push({ ...item });
    }
  }
  return out;
}

/** Ungroup a Click/Drag row back into its raw down/move/up events. */
export function splitGroup(item: ClickGroup | DragGroup): MacroEvent[] {
  return flattenItems([item]);
}

/** Delay before the row starts (groups: delay of their first event). */
export function itemDelay(item: EditorItem): number {
  if (isClickGroup(item) || isDragGroup(item)) return item.down.delay;
  return item.delay ?? 0;
}

export function setItemDelay(item: EditorItem, ms: number): EditorItem {
  const delay = Math.max(0, ms);
  if (isClickGroup(item) || isDragGroup(item)) {
    return { ...item, down: { ...item.down, delay } };
  }
  return { ...item, delay };
}

/** User-given row title (groups keep it on their first event). */
export function itemLabel(item: EditorItem): string | undefined {
  if (isClickGroup(item) || isDragGroup(item)) return item.down.label;
  return item.label;
}

export function setItemLabel(item: EditorItem, label: string): EditorItem {
  const trimmed = label.trimStart();
  if (isClickGroup(item) || isDragGroup(item)) {
    const down = { ...item.down };
    if (trimmed) down.label = trimmed;
    else delete down.label;
    return { ...item, down };
  }
  const next = { ...item };
  if (trimmed) next.label = trimmed;
  else delete next.label;
  return next;
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

// --- drag helpers: treat down-position + moves as one editable path ---

/** The drag's path as a movegroup anchored at the press position, or null
 * when the press carries no coordinates (can't anchor the path). */
function dragPseudo(g: DragGroup): MoveGroup | null {
  if (g.down.x == null || g.down.y == null) return null;
  return {
    type: "movegroup",
    delay: 0,
    points: [{ x: g.down.x, y: g.down.y, dt: 0 }, ...g.moves.map((p) => ({ ...p }))],
  };
}

function dragFromPseudo(g: DragGroup, pg: MoveGroup): DragGroup {
  const pts = pg.points;
  const last = pts[pts.length - 1];
  return {
    ...g,
    down: { ...g.down, x: pts[0].x, y: pts[0].y },
    moves: pts.slice(1),
    up: { ...g.up, x: last.x, y: last.y },
  };
}

/** Time from the press to the release (path time + release delay). */
export function dragDuration(g: DragGroup): number {
  return g.moves.reduce((sum, p) => sum + p.dt, 0) + (g.up.delay ?? 0);
}

/** Proportionally rescale the drag's path timing (release delay included). */
export function setDragDuration(g: DragGroup, ms: number): DragGroup {
  const current = dragDuration(g);
  if (current <= 0 || ms < 0) return g;
  const factor = ms / current;
  return {
    ...g,
    moves: g.moves.map((p) => ({ ...p, dt: Math.max(1, Math.round(p.dt * factor)) })),
    up: { ...g.up, delay: Math.round((g.up.delay ?? 0) * factor) },
  };
}

export function straightenDrag(g: DragGroup): DragGroup {
  const p = dragPseudo(g);
  return p ? dragFromPseudo(g, straighten(p)) : g;
}

export function simplifyDrag(g: DragGroup, tolerancePx = 3): DragGroup {
  const p = dragPseudo(g);
  return p ? dragFromPseudo(g, rdpSimplify(p, tolerancePx)) : g;
}

export function thinDrag(g: DragGroup, tolerancePx = 3, maxPerSecond = 30): DragGroup {
  const p = dragPseudo(g);
  return p ? dragFromPseudo(g, rdpSimplify(resample(p, maxPerSecond), tolerancePx)) : g;
}

/** Give the drag a new start/end; the path scales to fit (see remapGroup). */
export function remapDrag(
  g: DragGroup,
  newStart: { x: number; y: number },
  newEnd: { x: number; y: number },
): DragGroup {
  const p = dragPseudo(g);
  return p ? dragFromPseudo(g, remapGroup(p, newStart, newEnd)) : g;
}

/** Multiply every temporal value of a row by `factor` ("All delays ×"). */
export function scaleItemTiming(item: EditorItem, factor: number): EditorItem {
  const scale = (ms: number) => Math.round(ms * factor);
  if (isMoveGroup(item)) {
    return setGroupDuration(
      { ...item, delay: scale(item.delay) },
      scale(groupDuration(item)),
    );
  }
  if (isClickGroup(item)) {
    return {
      ...item,
      down: { ...item.down, delay: scale(item.down.delay) },
      up: { ...item.up, delay: scale(item.up.delay) },
    };
  }
  if (isDragGroup(item)) {
    return setDragDuration(
      { ...item, down: { ...item.down, delay: scale(item.down.delay) } },
      scale(dragDuration(item)),
    );
  }
  return { ...item, delay: scale(item.delay ?? 0) };
}

/** "Optimize for device": resample + RDP every mouse path (drags included). */
export function thinForDevice(events: MacroEvent[], tolerancePx = 3, maxPerSecond = 30): MacroEvent[] {
  const items = groupEvents(events).map((item) => {
    if (isMoveGroup(item)) return rdpSimplify(resample(item, maxPerSecond), tolerancePx);
    if (isDragGroup(item)) return thinDrag(item, tolerancePx, maxPerSecond);
    return item;
  });
  return flattenItems(items);
}

/** Every row reads the same way: `Category Action · detail · detail`. */
export function describeItem(item: EditorItem): string {
  const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  if (isMoveGroup(item)) {
    const first = item.points[0];
    const last = item.points[item.points.length - 1];
    return `Mouse Path · ${item.points.length} pts · (${first.x},${first.y}) → (${last.x},${last.y}) · ${groupDuration(item)} ms`;
  }
  if (isClickGroup(item)) {
    const hold = item.up.delay >= 250 ? ` · hold ${item.up.delay} ms` : "";
    return `Mouse ${cap(item.down.button)} Click · (${item.down.x ?? 0},${item.down.y ?? 0})${hold}`;
  }
  if (isDragGroup(item)) {
    const last = item.moves[item.moves.length - 1];
    return `Mouse ${cap(item.down.button)} Drag · (${item.down.x ?? 0},${item.down.y ?? 0}) → (${item.up.x ?? last.x},${item.up.y ?? last.y}) · ${item.moves.length + 1} pts · ${dragDuration(item)} ms`;
  }
  switch (item.type) {
    case "key":
      return `Keyboard Key ${cap(item.action)} · "${displayKey(item.key)}"`;
    case "button":
      return `Mouse ${cap(item.button)} ${cap(item.action)} · (${item.x},${item.y})`;
    case "scroll":
      return `Scroll ${item.dy > 0 ? "Up" : "Down"} · ${item.dy}`;
    case "move":
      return `Mouse Move · (${item.x},${item.y})`;
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

/**
 * Screen size in the same coordinate space the capture hooks report:
 * Windows low-level hooks give physical pixels; macOS CGEvent locations are
 * points (CSS pixels). Mixing them up makes device playback land at the
 * wrong position on HiDPI screens.
 */
export function captureScreen(): { width: number; height: number } {
  const scale = IS_MAC ? 1 : devicePixelRatio;
  return {
    width: Math.round(screen.width * scale),
    height: Math.round(screen.height * scale),
  };
}

/**
 * 4-coordinate movegroup editing (port of the old recorder): give the path a
 * new start and end; every point is translated/scaled linearly per axis so
 * the shape is preserved.
 */
export function remapGroup(
  g: MoveGroup,
  newStart: { x: number; y: number },
  newEnd: { x: number; y: number },
): MoveGroup {
  const first = g.points[0];
  const last = g.points[g.points.length - 1];
  const axis = (p: number, s: number, e: number, ns: number, ne: number) => {
    if (e === s) return ns + (p - s); // degenerate: pure translation
    return ns + ((p - s) * (ne - ns)) / (e - s);
  };
  return {
    ...g,
    points: g.points.map((p) => ({
      ...p,
      x: Math.round(axis(p.x, first.x, last.x, newStart.x, newEnd.x)),
      y: Math.round(axis(p.y, first.y, last.y, newStart.y, newEnd.y)),
    })),
  };
}

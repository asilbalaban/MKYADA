// Macro editor with full field-level editing (the old tkinter recorder's
// feature set): every x/y/dx/dy/delay/key is editable, movegroups support
// 4-coordinate start/end remapping, straighten, duration rescale and RDP
// simplification — with clearly labeled buttons instead of cryptic icons,
// plus a full-screen on-monitor path overlay.

import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Keyboard,
  Monitor,
  MonitorOff,
  MousePointerClick,
  MoveRight,
  Music,
  Scissors,
  Spline,
  Timer,
  Trash2,
  UnfoldVertical,
} from "lucide-react";
import type { MacroEvent, MacroFile } from "../lib/types";
import {
  EditorItem,
  MoveGroup,
  describeItem,
  flattenItems,
  groupDuration,
  groupEvents,
  isMoveGroup,
  macroStats,
  rdpSimplify,
  remapGroup,
  resample,
  setGroupDuration,
  straighten,
} from "../lib/recorder-model";
import { IS_MAC } from "../lib/macro-model";
import { displayKey } from "../lib/layout";
import { Button, Card, Field, Input, Select } from "./ui";
import { KeyCapture } from "./AssignmentEditor";
import { useToast } from "./toast";

interface Props {
  macro: MacroFile;
  onChange: (m: MacroFile) => void;
}

export function MacroEditor({ macro, onChange }: Props) {
  const items = useMemo(() => groupEvents(macro.events), [macro.events]);
  // Multi-select: click = single, shift+click = range from anchor,
  // cmd/ctrl+click = toggle. Sorted list of row indices.
  const [selected, setSelected] = useState<number[]>([]);
  const anchor = useRef<number | null>(null);
  const [bulkFactor, setBulkFactor] = useState("1.0");
  const [overlayOn, setOverlayOn] = useState(false);
  const [overlayOnlySelected, setOverlayOnlySelected] = useState(false);
  const stats = macroStats(macro);
  const overlayRef = useRef(overlayOn);
  overlayRef.current = overlayOn;
  const toast = useToast();

  function commit(newItems: EditorItem[]) {
    onChange({ ...macro, events: flattenItems(newItems) });
  }

  function rowClick(e: React.MouseEvent, i: number) {
    if (e.shiftKey && anchor.current !== null) {
      const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)];
      setSelected(Array.from({ length: b - a + 1 }, (_, k) => a + k));
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      setSelected((cur) =>
        cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i].sort((x, y) => x - y),
      );
      anchor.current = i;
      return;
    }
    anchor.current = i;
    setSelected((cur) => (cur.length === 1 && cur[0] === i ? [] : [i]));
  }

  function updateItem(idx: number, item: EditorItem) {
    const next = [...items];
    next[idx] = item;
    commit(next);
  }

  function removeSelected() {
    const dead = new Set(selected);
    commit(items.filter((_, i) => !dead.has(i)));
    setSelected([]);
    anchor.current = null;
    if (dead.size > 1) toast.info(`${dead.size} rows deleted`);
  }

  function duplicateItem(idx: number) {
    const next = [...items];
    next.splice(idx + 1, 0, JSON.parse(JSON.stringify(items[idx])));
    commit(next);
  }

  function moveItem(idx: number, dir: -1 | 1) {
    const j = idx + dir;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[idx], next[j]] = [next[j], next[idx]];
    commit(next);
    setSelected([j]);
    anchor.current = j;
  }

  function applyBulk() {
    const f = parseFloat(bulkFactor);
    if (!isFinite(f) || f <= 0) return;
    commit(
      items.map((item) => {
        const scaled = { ...item, delay: Math.round((item.delay ?? 0) * f) };
        if (isMoveGroup(scaled)) {
          return setGroupDuration(scaled, Math.round(groupDuration(scaled) * f));
        }
        return scaled;
      }),
    );
  }

  // keep the on-screen overlay in sync while it's open, and heartbeat so the
  // overlay can close itself if we disappear (it's a topmost window)
  useEffect(() => {
    if (!overlayOn) return;
    void emit("overlay:data", { macro, selected, onlySelected: overlayOnlySelected });
    const ping = setInterval(() => void emit("overlay:ping"), 1000);
    return () => clearInterval(ping);
  }, [overlayOn, macro, selected, overlayOnlySelected]);

  useEffect(
    () => () => {
      if (overlayRef.current) void invoke("overlay_hide");
    },
    [],
  );

  async function toggleOverlay() {
    if (overlayOn) {
      await invoke("overlay_hide");
      setOverlayOn(false);
    } else {
      await invoke("overlay_show");
      setOverlayOn(true);
      setTimeout(
        () => void emit("overlay:data", { macro, selected, onlySelected: overlayOnlySelected }),
        400,
      );
    }
  }

  /** Thin mouse paths so the macro fits the keypad's RAM; report the result. */
  function optimizeForDevice() {
    const before = macroStats(macro);
    const next = items.map((it) => (isMoveGroup(it) ? rdpSimplify(resample(it, 30), 3) : it));
    const events = flattenItems(next);
    onChange({ ...macro, events });
    const after = macroStats({ ...macro, events });
    if (after.events === before.events) {
      toast.info("Already optimized", "Mouse paths are as small as they can get.");
    } else {
      toast.success(
        "Optimized for the keypad",
        `${before.events} → ${after.events} events (${(before.bytes / 1024).toFixed(1)} → ${(after.bytes / 1024).toFixed(1)} KB). The path shape is preserved.`,
      );
    }
  }

  const single = selected.length === 1 ? selected[0] : null;
  const current = single !== null ? items[single] : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3 items-end">
        <Field label="Name">
          <Input value={macro.name ?? ""} onChange={(e) => onChange({ ...macro, name: e.target.value })} />
        </Field>
        <Field label="Speed ×">
          <Input
            type="number" step="0.1" min="0.1" className="w-20"
            value={macro.settings?.speed ?? 1}
            onChange={(e) =>
              onChange({ ...macro, settings: { ...macro.settings, speed: parseFloat(e.target.value) || 1 } })
            }
          />
        </Field>
        <Field label="Repeat (0 = loop until key)">
          <Input
            type="number" min="0" className="w-20"
            value={macro.settings?.repeat ?? 1}
            onChange={(e) =>
              onChange({ ...macro, settings: { ...macro.settings, repeat: Math.max(0, parseInt(e.target.value) || 0) } })
            }
          />
        </Field>
        <Field label="Press key again while playing">
          <Select
            value={macro.settings?.on_repress ?? "stop"}
            onChange={(e) =>
              onChange({
                ...macro,
                settings: { ...macro.settings, on_repress: e.target.value as "stop" | "restart" },
              })
            }
          >
            <option value="stop">Stop the macro</option>
            <option value="restart">Restart it</option>
          </Select>
        </Field>
        <Field label="While key is held">
          <Select
            value={macro.settings?.hold_repeat ? "repeat" : "once"}
            onChange={(e) =>
              onChange({
                ...macro,
                settings: { ...macro.settings, hold_repeat: e.target.value === "repeat" },
              })
            }
          >
            <option value="once">Play once</option>
            <option value="repeat">Repeat while held</option>
          </Select>
        </Field>
        <Field label="All delays ×">
          <div className="flex gap-1">
            <Input value={bulkFactor} onChange={(e) => setBulkFactor(e.target.value)} className="w-16" />
            <Button onClick={applyBulk}>Apply</Button>
          </div>
        </Field>
      </div>

      <div className="grid grid-cols-[1.2fr_1fr] gap-3 items-start">
        <Card
          title={`Events (${items.length} rows / ${stats.events} events)`}
          actions={
            <div className="flex gap-1.5">
              <Button
                variant={overlayOn ? "primary" : "default"}
                title="Draw the mouse path 1:1 on your real monitor (click-through)"
                onClick={() => void toggleOverlay()}
              >
                {overlayOn ? (
                  <>
                    <MonitorOff size={14} aria-hidden /> Hide overlay
                  </>
                ) : (
                  <>
                    <Monitor size={14} aria-hidden /> Show on screen
                  </>
                )}
              </Button>
              {overlayOn && (
                <Button
                  variant={overlayOnlySelected ? "primary" : "default"}
                  title="Draw only the selected rows instead of the whole macro"
                  onClick={() => setOverlayOnlySelected(!overlayOnlySelected)}
                >
                  Selected rows only
                </Button>
              )}
              <Button onClick={() => commit([...items, { type: "wait", delay: 500 } as MacroEvent])}>
                + Add wait
              </Button>
            </div>
          }
        >
          <div className="max-h-96 overflow-y-auto flex flex-col gap-1 pr-1 select-none">
            {items.map((item, i) => (
              <button
                key={i}
                onClick={(e) => rowClick(e, i)}
                aria-pressed={selected.includes(i)}
                className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-left border
                  ${selected.includes(i) ? "border-accent bg-accent/10" : "border-line bg-panel2 hover:border-fg-faint"}`}
              >
                <span className="w-6 flex justify-center text-fg-muted">{itemIcon(item)}</span>
                <span className="w-8 text-fg-faint">#{i + 1}</span>
                <span className="flex-1 text-fg truncate">{describeItem(item)}</span>
                <span className="text-fg-faint">{item.delay ?? 0} ms</span>
              </button>
            ))}
            {items.length === 0 && <p className="text-fg-faint text-sm">No events.</p>}
          </div>
          <p className="text-[11px] text-fg-faint mt-1.5">
            Shift+click selects a range, {IS_MAC ? "⌘" : "Ctrl"}+click adds/removes single rows.
          </p>
          <div className="flex items-center justify-between gap-3 mt-2 border-t border-line pt-2">
            <div className={`text-xs ${stats.tooBig ? "text-warning" : "text-fg-faint"}`}>
              {stats.events} events · {(stats.bytes / 1024).toFixed(1)} KB
              {stats.tooBig
                ? " — too large for the keypad's memory. Optimize to shrink it."
                : " — fits on the keypad."}
            </div>
            <Button
              title="Thins dense mouse paths (max 30 points/second) while keeping their shape, so the macro fits the keypad's memory"
              onClick={optimizeForDevice}
            >
              <Scissors size={14} aria-hidden /> Optimize for device
            </Button>
          </div>
        </Card>

        <div className="flex flex-col gap-3">
          <Card
            title={
              selected.length > 1
                ? `${selected.length} rows selected`
                : current
                  ? `Edit row #${(single ?? 0) + 1}`
                  : "Row editor"
            }
          >
            {selected.length > 1 ? (
              <div className="flex flex-col gap-3">
                <p className="text-fg-muted text-sm">
                  Rows #{selected[0] + 1}…#{selected[selected.length - 1] + 1} selected
                  ({selected.length} rows).
                </p>
                <div>
                  <Button variant="danger" onClick={removeSelected}>
                    <Trash2 size={14} aria-hidden /> Delete {selected.length} rows
                  </Button>
                </div>
              </div>
            ) : !current ? (
              <p className="text-fg-faint text-sm">Click a row on the left to edit every value.</p>
            ) : (
              <div className="flex flex-col gap-3">
                <RowFields item={current} onChange={(it) => updateItem(single!, it)} />
                <div className="flex flex-wrap gap-2 border-t border-line pt-3">
                  <Button onClick={() => moveItem(single!, -1)}>
                    <ArrowUp size={14} aria-hidden /> Move up
                  </Button>
                  <Button onClick={() => moveItem(single!, 1)}>
                    <ArrowDown size={14} aria-hidden /> Move down
                  </Button>
                  <Button onClick={() => duplicateItem(single!)}>
                    <Copy size={14} aria-hidden /> Duplicate
                  </Button>
                  <Button variant="danger" onClick={removeSelected}>
                    <Trash2 size={14} aria-hidden /> Delete row
                  </Button>
                </div>
              </div>
            )}
          </Card>

        </div>
      </div>
    </div>
  );
}

function itemIcon(item: EditorItem): ReactNode {
  if (isMoveGroup(item)) return <Spline size={14} aria-hidden />;
  const icons: Record<string, ReactNode> = {
    key: <Keyboard size={14} aria-hidden />,
    button: <MousePointerClick size={14} aria-hidden />,
    scroll: <UnfoldVertical size={14} aria-hidden />,
    wait: <Timer size={14} aria-hidden />,
    move: <MoveRight size={14} aria-hidden />,
    consumer: <Music size={14} aria-hidden />,
  };
  return icons[item.type] ?? "·";
}

function Num({
  label, value, onChange, width = "w-20",
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  width?: string;
}) {
  return (
    <Field label={label}>
      <Input
        type="number"
        className={width}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value) || 0)}
      />
    </Field>
  );
}

/** Type-specific numeric/field editing — everything the old EditDialog had. */
function RowFields({ item, onChange }: { item: EditorItem; onChange: (i: EditorItem) => void }) {
  const delayField = (
    <Num label="Delay before (ms)" value={item.delay ?? 0} onChange={(n) => onChange({ ...item, delay: Math.max(0, n) })} />
  );

  if (isMoveGroup(item)) {
    const g = item as MoveGroup;
    const first = g.points[0];
    const last = g.points[g.points.length - 1];
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-3">
          {delayField}
          <Num label="Duration (ms)" value={groupDuration(g)} onChange={(n) => onChange(setGroupDuration(g, Math.max(1, n)))} />
          <Field label="Points">
            <span className="text-sm text-fg py-1.5">{g.points.length}</span>
          </Field>
        </div>
        <p className="text-xs text-fg-faint -mb-1">Start / end coordinates (path scales to fit):</p>
        <div className="flex flex-wrap gap-3">
          <Num label="Start X" value={first.x} onChange={(n) => onChange(remapGroup(g, { x: n, y: first.y }, last))} />
          <Num label="Start Y" value={first.y} onChange={(n) => onChange(remapGroup(g, { x: first.x, y: n }, last))} />
          <Num label="End X" value={last.x} onChange={(n) => onChange(remapGroup(g, first, { x: n, y: last.y }))} />
          <Num label="End Y" value={last.y} onChange={(n) => onChange(remapGroup(g, first, { x: last.x, y: n }))} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => onChange(straighten(g))}>
            <MoveRight size={14} aria-hidden /> Straighten (keep endpoints)
          </Button>
          <Button onClick={() => onChange(rdpSimplify(g, 3))}>
            <Scissors size={14} aria-hidden /> Simplify path
          </Button>
        </div>
      </div>
    );
  }

  const ev = item as MacroEvent;
  switch (ev.type) {
    case "key":
      return (
        <div className="flex flex-wrap gap-3">
          {delayField}
          <Field label="Key">
            <KeyCapture
              value={displayKey(ev.key)}
              captureModifiers
              onCapture={(key) => onChange({ ...ev, key })}
            />
          </Field>
          <Field label="Action">
            <Select value={ev.action} onChange={(e) => onChange({ ...ev, action: e.target.value as "down" | "up" })}>
              <option value="down">press (down)</option>
              <option value="up">release (up)</option>
            </Select>
          </Field>
        </div>
      );
    case "button":
      return (
        <div className="flex flex-wrap gap-3">
          {delayField}
          <Field label="Button">
            <Select value={ev.button} onChange={(e) => onChange({ ...ev, button: e.target.value })}>
              <option value="left">left</option>
              <option value="right">right</option>
              <option value="middle">middle</option>
            </Select>
          </Field>
          <Field label="Action">
            <Select value={ev.action} onChange={(e) => onChange({ ...ev, action: e.target.value as "down" | "up" })}>
              <option value="down">press (down)</option>
              <option value="up">release (up)</option>
            </Select>
          </Field>
          <Num label="X" value={ev.x ?? 0} onChange={(n) => onChange({ ...ev, x: n })} />
          <Num label="Y" value={ev.y ?? 0} onChange={(n) => onChange({ ...ev, y: n })} />
        </div>
      );
    case "move":
      return (
        <div className="flex flex-wrap gap-3">
          {delayField}
          <Num label="X" value={ev.x} onChange={(n) => onChange({ ...ev, x: n })} />
          <Num label="Y" value={ev.y} onChange={(n) => onChange({ ...ev, y: n })} />
        </div>
      );
    case "scroll":
      return (
        <div className="flex flex-wrap gap-3">
          {delayField}
          <Num label="Scroll dy (+up/−down)" value={ev.dy} onChange={(n) => onChange({ ...ev, dy: n })} />
          <Num label="X" value={ev.x ?? 0} onChange={(n) => onChange({ ...ev, x: n })} />
          <Num label="Y" value={ev.y ?? 0} onChange={(n) => onChange({ ...ev, y: n })} />
        </div>
      );
    case "consumer":
      return (
        <div className="flex flex-wrap gap-3">
          {delayField}
          <Field label="Media action">
            <Input value={ev.usage} onChange={(e) => onChange({ ...ev, usage: e.target.value })} />
          </Field>
        </div>
      );
    default: // wait
      return <div className="flex flex-wrap gap-3">{delayField}</div>;
  }
}

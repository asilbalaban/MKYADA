// Macro editor with full field-level editing (the old tkinter recorder's
// feature set): every x/y/dx/dy/delay/key is editable, movegroups support
// 4-coordinate start/end remapping, straighten, duration rescale and RDP
// simplification — with clearly labeled buttons instead of cryptic icons,
// plus a full-screen on-monitor path overlay.

import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Grab,
  Keyboard,
  Monitor,
  MonitorOff,
  MousePointerClick,
  MoveRight,
  Music,
  Redo2,
  Scissors,
  Spline,
  Timer,
  Trash2,
  Undo2,
  UnfoldVertical,
} from "lucide-react";
import type { MacroEvent, MacroFile } from "../lib/types";
import { useDevice } from "../lib/device";
import {
  ClickGroup,
  DragGroup,
  EditorItem,
  describeItem,
  dragDuration,
  flattenItems,
  groupDuration,
  groupEvents,
  isClickGroup,
  isDragGroup,
  isMoveGroup,
  itemDelay,
  itemLabel,
  macroStats,
  MoveGroup,
  rdpSimplify,
  remapDrag,
  remapGroup,
  resample,
  scaleItemTiming,
  setDragDuration,
  setGroupDuration,
  setItemDelay,
  setItemLabel,
  simplifyDrag,
  straighten,
  straightenDrag,
  thinDrag,
} from "../lib/recorder-model";
import { IS_MAC } from "../lib/macro-model";
import { displayKey } from "../lib/layout";
import { undoRedoFromEvent, type History } from "../lib/history";
import { Button, Card, Field, Input, Select } from "./ui";
import { KeyCapture } from "./AssignmentEditor";
import { useToast } from "./toast";

interface Props {
  macro: MacroFile;
  onChange: (m: MacroFile) => void;
  /** When the owner keeps the macro in a useHistory stack, the editor shows
   * undo/redo buttons and answers ⌘Z/⇧⌘Z (Ctrl+Z/Ctrl+Y). */
  history?: Pick<History<unknown>, "canUndo" | "canRedo" | "undo" | "redo">;
}

export function MacroEditor({ macro, onChange, history }: Props) {
  // proto >= 4 firmware streams macro files line by line, so the old
  // 2000-event RAM ceiling (and its warning) only applies to older keypads
  const { hello } = useDevice();
  const streaming = (hello?.proto ?? 0) >= 4;
  const items = useMemo(() => groupEvents(macro.events), [macro.events]);
  // Multi-select: click = single, shift+click = range from anchor,
  // cmd/ctrl+click = toggle. Sorted list of row indices.
  const [selected, setSelected] = useState<number[]>([]);
  const anchor = useRef<number | null>(null);
  const [bulkFactor, setBulkFactor] = useState("1.0");
  const [bulkWaitMs, setBulkWaitMs] = useState("100");
  const [overlayOn, setOverlayOn] = useState(false);
  const [overlayOnlySelected, setOverlayOnlySelected] = useState(false);
  const stats = macroStats(macro);
  const overlayRef = useRef(overlayOn);
  overlayRef.current = overlayOn;
  const toast = useToast();
  const historyRef = useRef(history);
  historyRef.current = history;

  // ⌘Z / ⇧⌘Z while the editor is on screen (text fields keep their own undo)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const h = historyRef.current;
      if (!h) return;
      const op = undoRedoFromEvent(e);
      if (!op) return;
      e.preventDefault();
      if (op === "undo") h.undo();
      else h.redo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    commit(items.map((item) => scaleItemTiming(item, f)));
  }

  /** Set every Wait row to the same duration in one go. */
  function applyBulkWaits() {
    const ms = parseInt(bulkWaitMs);
    if (!isFinite(ms) || ms < 0) return;
    const count = items.filter((it) => it.type === "wait").length;
    if (count === 0) {
      toast.info("No waits", "This macro has no Wait rows to change.");
      return;
    }
    commit(items.map((it) => (it.type === "wait" ? { ...it, delay: ms } : it)));
    toast.success(`${count} wait${count > 1 ? "s" : ""} set to ${ms} ms`);
  }

  // keep the on-screen overlay in sync while it's open, and heartbeat so the
  // overlay can close itself if we disappear (it's a topmost window)
  useEffect(() => {
    if (!overlayOn) return;
    const push = () =>
      void emit("overlay:data", { macro, selected, onlySelected: overlayOnlySelected });
    push();
    // The overlay webview can finish loading long after our first push
    // (WebView2 cold start on Windows) — it announces itself, we push again.
    const ready = listen("overlay:ready", push);
    const ping = setInterval(() => void emit("overlay:ping"), 1000);
    return () => {
      ready.then((f) => f());
      clearInterval(ping);
    };
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
      // the sync effect pushes data now and again when the overlay window
      // reports in with overlay:ready
      setOverlayOn(true);
    }
  }

  /** Thin mouse paths so the macro fits the keypad's RAM; report the result. */
  function optimizeForDevice() {
    const before = macroStats(macro);
    const next = items.map((it) => {
      if (isMoveGroup(it)) return rdpSimplify(resample(it, 30), 3);
      if (isDragGroup(it)) return thinDrag(it);
      return it;
    });
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
        {history && (
          <div className="flex gap-1 pb-0.5">
            <Button onClick={history.undo} disabled={!history.canUndo} title={IS_MAC ? "Undo (⌘Z)" : "Undo (Ctrl+Z)"}>
              <Undo2 size={14} aria-hidden /> Undo
            </Button>
            <Button onClick={history.redo} disabled={!history.canRedo} title={IS_MAC ? "Redo (⇧⌘Z)" : "Redo (Ctrl+Y)"}>
              <Redo2 size={14} aria-hidden /> Redo
            </Button>
          </div>
        )}
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
        <Field label="All delays ×">
          <div className="flex gap-1">
            <Input value={bulkFactor} onChange={(e) => setBulkFactor(e.target.value)} className="w-16" />
            <Button onClick={applyBulk}>Apply</Button>
          </div>
        </Field>
        <Field label="All waits (ms)">
          <div className="flex gap-1">
            <Input
              type="number" min="0" className="w-20"
              value={bulkWaitMs}
              onChange={(e) => setBulkWaitMs(e.target.value)}
            />
            <Button onClick={applyBulkWaits} title="Set every Wait row to this duration">
              Set
            </Button>
          </div>
        </Field>
      </div>

      <Card title="When the key is pressed">
        <div className="grid sm:grid-cols-3 gap-4 items-start">
          <div className="flex flex-col gap-1">
            <Field label="Play the macro">
              <Select
                value={(macro.settings?.repeat ?? 1) === 0 ? "loop" : "count"}
                onChange={(e) =>
                  onChange({
                    ...macro,
                    settings: {
                      ...macro.settings,
                      repeat: e.target.value === "loop" ? 0 : 1,
                    },
                  })
                }
              >
                <option value="count">A number of times</option>
                <option value="loop">In a loop, until stopped</option>
              </Select>
            </Field>
            {(macro.settings?.repeat ?? 1) !== 0 ? (
              <div className="flex items-center gap-2 mt-1">
                <Input
                  type="number" min="1" className="w-20"
                  value={macro.settings?.repeat ?? 1}
                  onChange={(e) =>
                    onChange({
                      ...macro,
                      settings: {
                        ...macro.settings,
                        repeat: Math.max(1, parseInt(e.target.value) || 1),
                      },
                    })
                  }
                />
                <span className="text-xs text-fg-faint">time(s) per press</span>
              </div>
            ) : (
              <p className="text-xs text-fg-faint">
                Loops forever — press the key again to stop it.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <Field label="Pressing the key again, while playing">
              <Select
                className="w-full"
                value={macro.settings?.on_repress ?? "stop"}
                onChange={(e) =>
                  onChange({
                    ...macro,
                    settings: { ...macro.settings, on_repress: e.target.value as "stop" | "restart" },
                  })
                }
              >
                <option value="stop">Stops the macro</option>
                <option value="restart">Restarts it from the top</option>
              </Select>
            </Field>
            <p className="text-xs text-fg-faint">
              What a second press of the same key does mid-playback.
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <Field label="Holding the key down">
              <Select
                className="w-full"
                value={macro.settings?.hold_repeat ? "repeat" : "once"}
                onChange={(e) =>
                  onChange({
                    ...macro,
                    settings: { ...macro.settings, hold_repeat: e.target.value === "repeat" },
                  })
                }
              >
                <option value="once">Plays it once</option>
                <option value="repeat">Replays it while held</option>
              </Select>
            </Field>
            <p className="text-xs text-fg-faint">
              "Replays" works like holding a letter key on a keyboard.
            </p>
          </div>
        </div>
      </Card>

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
                <span className="flex-1 text-fg truncate">
                  {itemLabel(item) ? (
                    <>
                      <span className="font-semibold">{itemLabel(item)}</span>
                      <span className="text-fg-faint"> · {describeItem(item)}</span>
                    </>
                  ) : (
                    describeItem(item)
                  )}
                </span>
                <span className="text-fg-faint">{itemDelay(item)} ms</span>
              </button>
            ))}
            {items.length === 0 && <p className="text-fg-faint text-sm">No events.</p>}
          </div>
          <p className="text-[11px] text-fg-faint mt-1.5">
            Shift+click selects a range, {IS_MAC ? "⌘" : "Ctrl"}+click adds/removes single rows.
          </p>
          <div className="flex items-center justify-between gap-3 mt-2 border-t border-line pt-2">
            <div className={`text-xs ${stats.tooBig && !streaming ? "text-warning" : "text-fg-faint"}`}>
              {stats.events} events · {(stats.bytes / 1024).toFixed(1)} KB
              {stats.tooBig && !streaming
                ? " — too large for the keypad's memory. Optimize to shrink it."
                : " — fits on the keypad."}
            </div>
            <Button
              title={
                streaming
                  ? "Simplifies dense mouse paths (max 30 points/second) while keeping their shape. Your keypad plays full recordings as-is — this is only an editing convenience."
                  : "Thins dense mouse paths (max 30 points/second) while keeping their shape, so the macro fits the keypad's memory"
              }
              onClick={optimizeForDevice}
            >
              <Scissors size={14} aria-hidden /> {streaming ? "Simplify paths" : "Optimize for device"}
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
  if (isClickGroup(item)) return <MousePointerClick size={14} aria-hidden />;
  if (isDragGroup(item)) return <Grab size={14} aria-hidden />;
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
    <Num label="Delay before (ms)" value={itemDelay(item)} onChange={(n) => onChange(setItemDelay(item, n))} />
  );
  // A custom title makes long macros navigable ("Select first slot"…)
  const titleField = (
    <Field label="Title (optional)">
      <Input
        value={itemLabel(item) ?? ""}
        placeholder="e.g. Select first slot"
        onChange={(e) => onChange(setItemLabel(item, e.target.value))}
      />
    </Field>
  );

  if (isClickGroup(item)) {
    const g = item as ClickGroup;
    const setPos = (x: number, y: number) =>
      onChange({ ...g, down: { ...g.down, x, y }, up: { ...g.up, x, y } });
    return (
      <div className="flex flex-col gap-3">
        {titleField}
        <div className="flex flex-wrap gap-3">
          {delayField}
          <Field label="Button">
            <Select
              value={g.down.button}
              onChange={(e) =>
                onChange({
                  ...g,
                  down: { ...g.down, button: e.target.value },
                  up: { ...g.up, button: e.target.value },
                })
              }
            >
              <option value="left">left</option>
              <option value="right">right</option>
              <option value="middle">middle</option>
            </Select>
          </Field>
          <Num label="X" value={g.down.x ?? 0} onChange={(n) => setPos(n, g.down.y ?? 0)} />
          <Num label="Y" value={g.down.y ?? 0} onChange={(n) => setPos(g.down.x ?? 0, n)} />
          <Num
            label="Held for (ms)"
            value={g.up.delay}
            onChange={(n) => onChange({ ...g, up: { ...g.up, delay: Math.max(0, n) } })}
          />
        </div>
        <p className="text-xs text-fg-faint">
          One press + release at this position. "Held for" is the time between them.
        </p>
      </div>
    );
  }

  if (isDragGroup(item)) {
    const g = item as DragGroup;
    const start = { x: g.down.x ?? g.moves[0].x, y: g.down.y ?? g.moves[0].y };
    const last = g.moves[g.moves.length - 1];
    const end = { x: g.up.x ?? last.x, y: g.up.y ?? last.y };
    return (
      <div className="flex flex-col gap-3">
        {titleField}
        <div className="flex flex-wrap gap-3">
          {delayField}
          <Field label="Button">
            <Select
              value={g.down.button}
              onChange={(e) =>
                onChange({
                  ...g,
                  down: { ...g.down, button: e.target.value },
                  up: { ...g.up, button: e.target.value },
                })
              }
            >
              <option value="left">left</option>
              <option value="right">right</option>
              <option value="middle">middle</option>
            </Select>
          </Field>
          <Num label="Duration (ms)" value={dragDuration(g)} onChange={(n) => onChange(setDragDuration(g, Math.max(1, n)))} />
          <Field label="Points">
            <span className="text-sm text-fg py-1.5">{g.moves.length + 1}</span>
          </Field>
        </div>
        <p className="text-xs text-fg-faint -mb-1">
          Press → path → release. Start / end coordinates (path scales to fit):
        </p>
        <div className="flex flex-wrap gap-3">
          <Num label="Start X" value={start.x} onChange={(n) => onChange(remapDrag(g, { x: n, y: start.y }, end))} />
          <Num label="Start Y" value={start.y} onChange={(n) => onChange(remapDrag(g, { x: start.x, y: n }, end))} />
          <Num label="End X" value={end.x} onChange={(n) => onChange(remapDrag(g, start, { x: n, y: end.y }))} />
          <Num label="End Y" value={end.y} onChange={(n) => onChange(remapDrag(g, start, { x: end.x, y: n }))} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => onChange(straightenDrag(g))}>
            <MoveRight size={14} aria-hidden /> Straighten (keep endpoints)
          </Button>
          <Button onClick={() => onChange(simplifyDrag(g))}>
            <Scissors size={14} aria-hidden /> Simplify path
          </Button>
        </div>
      </div>
    );
  }

  if (isMoveGroup(item)) {
    const g = item as MoveGroup;
    const first = g.points[0];
    const last = g.points[g.points.length - 1];
    return (
      <div className="flex flex-col gap-3">
        {titleField}
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
  const fields = (() => {
    switch (ev.type) {
      case "key":
        return (
          <>
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
          </>
        );
      case "button":
        return (
          <>
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
          </>
        );
      case "move":
        return (
          <>
            {delayField}
            <Num label="X" value={ev.x} onChange={(n) => onChange({ ...ev, x: n })} />
            <Num label="Y" value={ev.y} onChange={(n) => onChange({ ...ev, y: n })} />
          </>
        );
      case "scroll":
        return (
          <>
            {delayField}
            <Num label="Scroll dy (+up/−down)" value={ev.dy} onChange={(n) => onChange({ ...ev, dy: n })} />
            <Num label="X" value={ev.x ?? 0} onChange={(n) => onChange({ ...ev, x: n })} />
            <Num label="Y" value={ev.y ?? 0} onChange={(n) => onChange({ ...ev, y: n })} />
          </>
        );
      case "consumer":
        return (
          <>
            {delayField}
            <Field label="Media action">
              <Input value={ev.usage} onChange={(e) => onChange({ ...ev, usage: e.target.value })} />
            </Field>
          </>
        );
      default: // wait
        return delayField;
    }
  })();
  return (
    <div className="flex flex-col gap-3">
      {titleField}
      <div className="flex flex-wrap gap-3">{fields}</div>
    </div>
  );
}

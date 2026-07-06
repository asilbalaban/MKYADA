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
  Check,
  Copy,
  Eye,
  EyeOff,
  Filter,
  Grab,
  Keyboard,
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
import { Button, Field, Input, Select } from "./ui";
import { ToolButton, ToolField, ToolGroup, ToolMini, ToolUnitInput } from "./toolbar";
import { KeyCapture } from "./AssignmentEditor";
import { useToast } from "./toast";

interface Props {
  macro: MacroFile;
  onChange: (m: MacroFile) => void;
  /** When the owner keeps the macro in a useHistory stack, the editor shows
   * undo/redo buttons and answers ⌘Z/⇧⌘Z (Ctrl+Z/Ctrl+Y). */
  history?: Pick<History<unknown>, "canUndo" | "canRedo" | "undo" | "redo">;
  /** Photoshop-style toolbar/sidebar slots filled by the owning page with the
   * device- and file-level actions. Group order across the bar is:
   * Capture → Playback → [Macro · Edit · Bulk · On key press] → File. */
  toolbarStart?: ReactNode; // Capture: delay + record + import
  toolbarPlayback?: ReactNode; // Playback: times + play / preview / stop
  toolbarEnd?: ReactNode; // File: export / optimize / close
  sidebarPanels?: ReactNode; // sidebar bottom: assign to key
}

export function MacroEditor({
  macro,
  onChange,
  history,
  toolbarStart,
  toolbarPlayback,
  toolbarEnd,
  sidebarPanels,
}: Props) {
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
  const [bulkDelayMs, setBulkDelayMs] = useState("100");
  const [overlayOn, setOverlayOn] = useState(false);
  const [overlayOnlySelected, setOverlayOnlySelected] = useState(false);
  const stats = macroStats(macro);
  const overlayRef = useRef(overlayOn);
  overlayRef.current = overlayOn;
  const toast = useToast();
  const historyRef = useRef(history);
  historyRef.current = history;
  // Delete/Backspace removes the selected rows ("layers"); a ref keeps the
  // mount-only key handler pointed at the latest selection + remover.
  const deleteRef = useRef<() => void>(() => {});
  // ⌘A / Ctrl+A selects every row (unless a text field is focused, where it
  // keeps its native select-all-text meaning).
  const selectAllRef = useRef<() => void>(() => {});

  // Keyboard: ⌘Z / ⇧⌘Z undo-redo, and Delete/Backspace to remove selected rows.
  // Text fields keep their own editing keys — we bail when a form control has
  // focus so typing a value never nukes a row.
  useEffect(() => {
    const typingInField = () => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return (
        tag === "INPUT" ||
        tag === "SELECT" ||
        tag === "TEXTAREA" ||
        el.isContentEditable
      );
    };
    const onKey = (e: KeyboardEvent) => {
      const op = undoRedoFromEvent(e);
      if (op && historyRef.current) {
        e.preventDefault();
        if (op === "undo") historyRef.current.undo();
        else historyRef.current.redo();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && !typingInField()) {
        e.preventDefault();
        deleteRef.current();
        return;
      }
      if ((e.key === "a" || e.key === "A") && (e.metaKey || e.ctrlKey) && !typingInField()) {
        e.preventDefault();
        selectAllRef.current();
      }
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
    if (selected.length === 0) return;
    const dead = new Set(selected);
    commit(items.filter((_, i) => !dead.has(i)));
    setSelected([]);
    anchor.current = null;
    if (dead.size > 1) toast.info(`${dead.size} rows deleted`);
  }
  deleteRef.current = removeSelected;

  function selectAll() {
    if (items.length === 0) return;
    setSelected(items.map((_, i) => i));
    anchor.current = 0;
  }
  selectAllRef.current = selectAll;

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

  /** Set the "delay before" of every row (or just the selected rows, if any)
   *  to one value — e.g. type 100 and every delay-before becomes 100 ms. */
  function applyBulkDelay() {
    const ms = parseInt(bulkDelayMs);
    if (!isFinite(ms) || ms < 0) return;
    const target = selected.length ? new Set(selected) : null;
    const count = target ? target.size : items.length;
    if (count === 0) return;
    commit(items.map((it, i) => (!target || target.has(i) ? setItemDelay(it, ms) : it)));
    toast.success(
      `Delay before set to ${ms} ms`,
      target ? `${count} selected row${count > 1 ? "s" : ""}` : `all ${count} rows`,
    );
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

  const rowEditorTitle =
    selected.length > 1
      ? `${selected.length} rows selected`
      : current
        ? `Edit row #${(single ?? 0) + 1}`
        : "Properties";

  return (
    <div className="h-full flex flex-col">
      {/* TOOLBAR — Illustrator-style: captioned controls in stroked groups.
          The [&_…] rules keep every input/select the same compact height. */}
      <div className="tb flex items-start gap-2 px-3 py-1.5 border-b border-line bg-panel shrink-0 overflow-x-auto [&_input]:h-7 [&_input]:py-0 [&_input]:text-xs [&_select]:h-7 [&_select]:py-0 [&_select]:text-xs">
        {toolbarStart}
        {toolbarPlayback}

        <ToolGroup label="Macro">
          <ToolField label="Name" align="start">
            <Input
              className="w-36"
              value={macro.name ?? ""}
              placeholder="Macro name"
              onChange={(e) => onChange({ ...macro, name: e.target.value })}
            />
          </ToolField>
          <ToolField label="Speed" align="start">
            <ToolUnitInput
              suffix="×"
              type="number" step="0.1" min="0.1" className="w-14 text-center"
              value={macro.settings?.speed ?? 1}
              onChange={(e) =>
                onChange({ ...macro, settings: { ...macro.settings, speed: parseFloat(e.target.value) || 1 } })
              }
            />
          </ToolField>
        </ToolGroup>

        {history && (
          <ToolGroup label="Edit">
            <ToolButton
              label="Undo" icon={<Undo2 size={18} aria-hidden />}
              onClick={history.undo} disabled={!history.canUndo}
              title={IS_MAC ? "Undo (⌘Z)" : "Undo (Ctrl+Z)"}
            />
            <ToolButton
              label="Redo" icon={<Redo2 size={18} aria-hidden />}
              onClick={history.redo} disabled={!history.canRedo}
              title={IS_MAC ? "Redo (⇧⌘Z)" : "Redo (Ctrl+Y)"}
            />
          </ToolGroup>
        )}

        <ToolGroup label="Bulk edit">
          <ToolField label="Delay before ms" align="start">
            <Input
              type="number" min="0" className="w-16"
              value={bulkDelayMs}
              onChange={(e) => setBulkDelayMs(e.target.value)}
            />
            <ToolMini
              onClick={applyBulkDelay}
              title="Set the delay-before of every row (or the selected rows) to this value"
            >
              <Check size={15} aria-hidden />
            </ToolMini>
          </ToolField>
          <ToolField label="Delays ×" align="start">
            <Input className="w-14" value={bulkFactor} onChange={(e) => setBulkFactor(e.target.value)} />
            <ToolMini onClick={applyBulk} title="Multiply every delay in the macro by this factor">
              <Check size={15} aria-hidden />
            </ToolMini>
          </ToolField>
          <ToolField label="Waits ms" align="start">
            <Input
              type="number" min="0" className="w-16"
              value={bulkWaitMs}
              onChange={(e) => setBulkWaitMs(e.target.value)}
            />
            <ToolMini onClick={applyBulkWaits} title="Set every Wait row to this duration">
              <Check size={15} aria-hidden />
            </ToolMini>
          </ToolField>
        </ToolGroup>

        <ToolGroup label="On key press">
          <ToolField label="Repeat" align="start">
            <Select
              title="How many times the macro plays per key press"
              value={(macro.settings?.repeat ?? 1) === 0 ? "loop" : "count"}
              onChange={(e) =>
                onChange({
                  ...macro,
                  settings: { ...macro.settings, repeat: e.target.value === "loop" ? 0 : 1 },
                })
              }
            >
              <option value="count">N times</option>
              <option value="loop">Loop</option>
            </Select>
            {(macro.settings?.repeat ?? 1) !== 0 && (
              <Input
                type="number" min="1" className="w-14"
                value={macro.settings?.repeat ?? 1}
                title="Times to play per press"
                onChange={(e) =>
                  onChange({
                    ...macro,
                    settings: { ...macro.settings, repeat: Math.max(1, parseInt(e.target.value) || 1) },
                  })
                }
              />
            )}
          </ToolField>
          <ToolField label="Re-press" align="start">
            <Select
              title="Pressing the key again mid-playback"
              value={macro.settings?.on_repress ?? "stop"}
              onChange={(e) =>
                onChange({
                  ...macro,
                  settings: { ...macro.settings, on_repress: e.target.value as "stop" | "restart" },
                })
              }
            >
              <option value="stop">Stop</option>
              <option value="restart">Restart</option>
            </Select>
          </ToolField>
          <ToolField label="Hold" align="start">
            <Select
              title="Holding the key down"
              value={macro.settings?.hold_repeat ? "repeat" : "once"}
              onChange={(e) =>
                onChange({
                  ...macro,
                  settings: { ...macro.settings, hold_repeat: e.target.value === "repeat" },
                })
              }
            >
              <option value="once">Once</option>
              <option value="repeat">While held</option>
            </Select>
          </ToolField>
        </ToolGroup>

        {toolbarEnd}
      </div>

      {/* BODY — events fill the center; properties live in the right sidebar */}
      <div className="flex-1 flex min-h-0">
        {/* CENTER: the events list, taking almost the whole screen */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-line shrink-0">
            <h2 className="text-sm font-semibold text-fg-muted">
              Events{" "}
              <span className="text-fg-faint font-normal">
                · {items.length} rows / {stats.events} events
              </span>
            </h2>
            <div className="flex items-center gap-1.5">
              <Button
                variant={overlayOn ? "primary" : "default"}
                title="Draw the mouse path 1:1 on your real monitor (click-through)"
                onClick={() => void toggleOverlay()}
              >
                {overlayOn ? (
                  <>
                    <EyeOff size={14} aria-hidden /> Hide overlay
                  </>
                ) : (
                  <>
                    <Eye size={14} aria-hidden /> Show on screen
                  </>
                )}
              </Button>
              {overlayOn && (
                <Button
                  variant={overlayOnlySelected ? "primary" : "default"}
                  title="Draw only the selected rows instead of the whole macro"
                  onClick={() => setOverlayOnlySelected(!overlayOnlySelected)}
                >
                  <Filter size={14} aria-hidden /> Selected only
                </Button>
              )}
              <Button onClick={() => commit([...items, { type: "wait", delay: 500 } as MacroEvent])}>
                + Add wait
              </Button>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1 p-3 select-none">
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
            {items.length === 0 && (
              <p className="text-fg-faint text-sm p-2">
                No events yet. Record or import a macro to fill this in.
              </p>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 px-3 py-2 border-t border-line shrink-0">
            <div className={`text-xs ${stats.tooBig && !streaming ? "text-warning" : "text-fg-faint"}`}>
              {stats.events} events · {(stats.bytes / 1024).toFixed(1)} KB
              {stats.tooBig && !streaming
                ? " — too large for the keypad's memory. Optimize to shrink it."
                : " — fits on the keypad."}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-fg-faint hidden xl:inline">
                Shift+click range · {IS_MAC ? "⌘" : "Ctrl"}+click toggle · {IS_MAC ? "⌘" : "Ctrl"}+A all · Del removes
              </span>
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
          </div>
        </div>

        {/* RIGHT: properties sidebar */}
        <aside className="w-[340px] shrink-0 border-l border-line bg-panel overflow-y-auto flex flex-col">
          <Section title={rowEditorTitle}>
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
              <p className="text-fg-faint text-sm">
                Click a row to edit every value. Press Delete to remove the selected row.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                <RowFields item={current} onChange={(it) => updateItem(single!, it)} />
                <div className="flex gap-1.5 border-t border-line pt-3">
                  <Button className="w-10 justify-center px-0" title="Move up" onClick={() => moveItem(single!, -1)}>
                    <ArrowUp size={16} aria-hidden />
                  </Button>
                  <Button className="w-10 justify-center px-0" title="Move down" onClick={() => moveItem(single!, 1)}>
                    <ArrowDown size={16} aria-hidden />
                  </Button>
                  <Button className="w-10 justify-center px-0" title="Duplicate" onClick={() => duplicateItem(single!)}>
                    <Copy size={16} aria-hidden />
                  </Button>
                  <Button variant="danger" className="w-10 justify-center px-0" title="Delete row" onClick={removeSelected}>
                    <Trash2 size={16} aria-hidden />
                  </Button>
                </div>
              </div>
            )}
          </Section>

          {sidebarPanels}
        </aside>
      </div>
    </div>
  );
}

/** A titled block in the properties sidebar. */
function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="border-b border-line p-3 flex flex-col gap-3">
      <h3 className="text-xs font-semibold tracking-wide text-fg-muted">{title}</h3>
      {children}
    </div>
  );
}

/** A stroked sub-group of related properties (Figma-style): a small caption
 *  over one column, or two columns (e.g. X · Y side by side). */
function PropGroup({
  label,
  cols = 1,
  children,
}: {
  label: string;
  cols?: 1 | 2;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line p-2.5">
      <span className="text-[10px] uppercase tracking-wider text-fg-faint leading-none">{label}</span>
      <div className={cols === 2 ? "grid grid-cols-2 gap-2" : "flex flex-col gap-2"}>{children}</div>
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

/** Type-specific field editing, laid out as Figma-style property groups. */
function RowFields({ item, onChange }: { item: EditorItem; onChange: (i: EditorItem) => void }) {
  const delayField = (
    <Num label="Delay before (ms)" width="w-full" value={itemDelay(item)} onChange={(n) => onChange(setItemDelay(item, n))} />
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
  const buttonSelect = (value: string, set: (v: string) => void) => (
    <Field label="Button">
      <Select value={value} onChange={(e) => set(e.target.value)}>
        <option value="left">left</option>
        <option value="right">right</option>
        <option value="middle">middle</option>
      </Select>
    </Field>
  );
  const actionSelect = (value: "down" | "up", set: (v: "down" | "up") => void) => (
    <Field label="Action">
      <Select value={value} onChange={(e) => set(e.target.value as "down" | "up")}>
        <option value="down">press (down)</option>
        <option value="up">release (up)</option>
      </Select>
    </Field>
  );

  if (isClickGroup(item)) {
    const g = item as ClickGroup;
    const setPos = (x: number, y: number) =>
      onChange({ ...g, down: { ...g.down, x, y }, up: { ...g.up, x, y } });
    return (
      <div className="flex flex-col gap-2.5">
        {titleField}
        <PropGroup label="Timing" cols={2}>
          {delayField}
          <Num
            label="Held for (ms)" width="w-full"
            value={g.up.delay}
            onChange={(n) => onChange({ ...g, up: { ...g.up, delay: Math.max(0, n) } })}
          />
        </PropGroup>
        <PropGroup label="Button">
          {buttonSelect(g.down.button, (button) =>
            onChange({ ...g, down: { ...g.down, button }, up: { ...g.up, button } }),
          )}
        </PropGroup>
        <PropGroup label="Position" cols={2}>
          <Num label="X" width="w-full" value={g.down.x ?? 0} onChange={(n) => setPos(n, g.down.y ?? 0)} />
          <Num label="Y" width="w-full" value={g.down.y ?? 0} onChange={(n) => setPos(g.down.x ?? 0, n)} />
        </PropGroup>
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
      <div className="flex flex-col gap-2.5">
        {titleField}
        <PropGroup label="Timing" cols={2}>
          {delayField}
          <Num label="Duration (ms)" width="w-full" value={dragDuration(g)} onChange={(n) => onChange(setDragDuration(g, Math.max(1, n)))} />
        </PropGroup>
        <PropGroup label="Button">
          {buttonSelect(g.down.button, (button) =>
            onChange({ ...g, down: { ...g.down, button }, up: { ...g.up, button } }),
          )}
        </PropGroup>
        <PropGroup label={`Path · ${g.moves.length + 1} points`}>
          <div className="grid grid-cols-2 gap-2">
            <Num label="Start X" width="w-full" value={start.x} onChange={(n) => onChange(remapDrag(g, { x: n, y: start.y }, end))} />
            <Num label="Start Y" width="w-full" value={start.y} onChange={(n) => onChange(remapDrag(g, { x: start.x, y: n }, end))} />
            <Num label="End X" width="w-full" value={end.x} onChange={(n) => onChange(remapDrag(g, start, { x: n, y: end.y }))} />
            <Num label="End Y" width="w-full" value={end.y} onChange={(n) => onChange(remapDrag(g, start, { x: end.x, y: n }))} />
          </div>
          <div className="flex gap-2">
            <Button className="flex-1 justify-center" onClick={() => onChange(straightenDrag(g))} title="Straighten (keep endpoints)">
              <MoveRight size={14} aria-hidden /> Straighten
            </Button>
            <Button className="flex-1 justify-center" onClick={() => onChange(simplifyDrag(g))} title="Simplify path">
              <Spline size={14} aria-hidden /> Simplify
            </Button>
          </div>
        </PropGroup>
      </div>
    );
  }

  if (isMoveGroup(item)) {
    const g = item as MoveGroup;
    const first = g.points[0];
    const last = g.points[g.points.length - 1];
    return (
      <div className="flex flex-col gap-2.5">
        {titleField}
        <PropGroup label="Timing" cols={2}>
          {delayField}
          <Num label="Duration (ms)" width="w-full" value={groupDuration(g)} onChange={(n) => onChange(setGroupDuration(g, Math.max(1, n)))} />
        </PropGroup>
        <PropGroup label={`Path · ${g.points.length} points`}>
          <div className="grid grid-cols-2 gap-2">
            <Num label="Start X" width="w-full" value={first.x} onChange={(n) => onChange(remapGroup(g, { x: n, y: first.y }, last))} />
            <Num label="Start Y" width="w-full" value={first.y} onChange={(n) => onChange(remapGroup(g, { x: first.x, y: n }, last))} />
            <Num label="End X" width="w-full" value={last.x} onChange={(n) => onChange(remapGroup(g, first, { x: n, y: last.y }))} />
            <Num label="End Y" width="w-full" value={last.y} onChange={(n) => onChange(remapGroup(g, first, { x: last.x, y: n }))} />
          </div>
          <div className="flex gap-2">
            <Button className="flex-1 justify-center" onClick={() => onChange(straighten(g))} title="Straighten (keep endpoints)">
              <MoveRight size={14} aria-hidden /> Straighten
            </Button>
            <Button className="flex-1 justify-center" onClick={() => onChange(rdpSimplify(g, 3))} title="Simplify path">
              <Spline size={14} aria-hidden /> Simplify
            </Button>
          </div>
        </PropGroup>
      </div>
    );
  }

  const ev = item as MacroEvent;
  const groups = (() => {
    switch (ev.type) {
      case "key":
        return (
          <>
            <PropGroup label="Timing">{delayField}</PropGroup>
            <PropGroup label="Key">
              <Field label="Key">
                <KeyCapture
                  value={displayKey(ev.key)}
                  captureModifiers
                  onCapture={(key) => onChange({ ...ev, key })}
                />
              </Field>
              {actionSelect(ev.action, (action) => onChange({ ...ev, action }))}
            </PropGroup>
          </>
        );
      case "button":
        return (
          <>
            <PropGroup label="Timing">{delayField}</PropGroup>
            <PropGroup label="Button" cols={2}>
              {buttonSelect(ev.button, (button) => onChange({ ...ev, button }))}
              {actionSelect(ev.action, (action) => onChange({ ...ev, action }))}
            </PropGroup>
            <PropGroup label="Position" cols={2}>
              <Num label="X" width="w-full" value={ev.x ?? 0} onChange={(n) => onChange({ ...ev, x: n })} />
              <Num label="Y" width="w-full" value={ev.y ?? 0} onChange={(n) => onChange({ ...ev, y: n })} />
            </PropGroup>
          </>
        );
      case "move":
        return (
          <>
            <PropGroup label="Timing">{delayField}</PropGroup>
            <PropGroup label="Position" cols={2}>
              <Num label="X" width="w-full" value={ev.x} onChange={(n) => onChange({ ...ev, x: n })} />
              <Num label="Y" width="w-full" value={ev.y} onChange={(n) => onChange({ ...ev, y: n })} />
            </PropGroup>
          </>
        );
      case "scroll":
        return (
          <>
            <PropGroup label="Timing">{delayField}</PropGroup>
            <PropGroup label="Scroll">
              <Num label="dy (+up / −down)" width="w-full" value={ev.dy} onChange={(n) => onChange({ ...ev, dy: n })} />
            </PropGroup>
            <PropGroup label="Position" cols={2}>
              <Num label="X" width="w-full" value={ev.x ?? 0} onChange={(n) => onChange({ ...ev, x: n })} />
              <Num label="Y" width="w-full" value={ev.y ?? 0} onChange={(n) => onChange({ ...ev, y: n })} />
            </PropGroup>
          </>
        );
      case "consumer":
        return (
          <>
            <PropGroup label="Timing">{delayField}</PropGroup>
            <PropGroup label="Media">
              <Field label="Media action">
                <Input value={ev.usage} onChange={(e) => onChange({ ...ev, usage: e.target.value })} />
              </Field>
            </PropGroup>
          </>
        );
      default: // wait
        return <PropGroup label="Timing">{delayField}</PropGroup>;
    }
  })();
  return (
    <div className="flex flex-col gap-2.5">
      {titleField}
      {groups}
    </div>
  );
}

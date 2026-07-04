// Macro editor: feature-parity port of the tkinter editor — event table with
// movegroup tooling (straighten, duration rescale), row ops, bulk delay
// scaling, and a mini screen-path preview.

import { useMemo, useState } from "react";
import type { MacroEvent, MacroFile } from "../lib/types";
import {
  EditorItem,
  describeItem,
  flattenItems,
  groupDuration,
  groupEvents,
  isMoveGroup,
  macroStats,
  rdpSimplify,
  resample,
  setGroupDuration,
  straighten,
} from "../lib/recorder-model";
import { Button, Card, Field, Input } from "./ui";

interface Props {
  macro: MacroFile;
  onChange: (m: MacroFile) => void;
}

export function MacroEditor({ macro, onChange }: Props) {
  const items = useMemo(() => groupEvents(macro.events), [macro.events]);
  const [bulkFactor, setBulkFactor] = useState("1.0");
  const stats = macroStats(macro);

  function commit(newItems: EditorItem[]) {
    onChange({ ...macro, events: flattenItems(newItems) });
  }

  function updateItem(idx: number, item: EditorItem) {
    const next = [...items];
    next[idx] = item;
    commit(next);
  }

  function removeItem(idx: number) {
    commit(items.filter((_, i) => i !== idx));
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
  }

  function addWait() {
    commit([...items, { type: "wait", delay: 500 } as MacroEvent]);
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

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-4 gap-3">
        <Field label="Name">
          <Input value={macro.name ?? ""} onChange={(e) => onChange({ ...macro, name: e.target.value })} />
        </Field>
        <Field label="Speed ×">
          <Input
            type="number" step="0.1" min="0.1"
            value={macro.settings?.speed ?? 1}
            onChange={(e) =>
              onChange({ ...macro, settings: { ...macro.settings, speed: parseFloat(e.target.value) || 1 } })
            }
          />
        </Field>
        <Field label="Repeat (0 = loop until key)">
          <Input
            type="number" min="0"
            value={macro.settings?.repeat ?? 1}
            onChange={(e) =>
              onChange({ ...macro, settings: { ...macro.settings, repeat: Math.max(0, parseInt(e.target.value) || 0) } })
            }
          />
        </Field>
        <Field label="Bulk delay ×">
          <div className="flex gap-1">
            <Input value={bulkFactor} onChange={(e) => setBulkFactor(e.target.value)} className="w-16" />
            <Button onClick={applyBulk}>Apply</Button>
          </div>
        </Field>
      </div>

      <div className="grid grid-cols-[1.4fr_1fr] gap-3 items-start">
        <Card title={`Events (${items.length} rows / ${stats.events} events)`}
          actions={<Button onClick={addWait}>+ Wait</Button>}>
          <div className="max-h-80 overflow-y-auto flex flex-col gap-1 pr-1">
            {items.map((item, i) => (
              <Row
                key={i}
                item={item}
                onUpdate={(it) => updateItem(i, it)}
                onDelete={() => removeItem(i)}
                onDuplicate={() => duplicateItem(i)}
                onMoveUp={() => moveItem(i, -1)}
                onMoveDown={() => moveItem(i, 1)}
              />
            ))}
            {items.length === 0 && <p className="text-slate-500 text-sm">No events.</p>}
          </div>
        </Card>

        <div className="flex flex-col gap-3">
          <PathPreview macro={macro} />
          <div className={`text-xs ${stats.tooBig ? "text-amber-400" : "text-slate-500"}`}>
            {stats.events} events · {(stats.bytes / 1024).toFixed(1)} KB
            {stats.tooBig && " — large for the device; use “Optimize for device” below."}
          </div>
          <Button
            onClick={() =>
              commit(
                items.map((it) => (isMoveGroup(it) ? rdpSimplify(resample(it, 30), 3) : it)),
              )
            }
          >
            Optimize for device (thin mouse paths)
          </Button>
        </div>
      </div>
    </div>
  );
}

function Row({
  item, onUpdate, onDelete, onDuplicate, onMoveUp, onMoveDown,
}: {
  item: EditorItem;
  onUpdate: (i: EditorItem) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const icon = isMoveGroup(item)
    ? "〰"
    : { key: "⌨", button: "🖱", scroll: "↕", wait: "⏱", move: "→", consumer: "♪" }[item.type] ?? "·";

  return (
    <div className="flex items-center gap-2 bg-panel2 border border-line rounded-md px-2 py-1 text-xs">
      <span className="w-5 text-center">{icon}</span>
      <span className="flex-1 text-slate-300 truncate" title={describeItem(item)}>
        {describeItem(item)}
      </span>
      <label className="flex items-center gap-1 text-slate-500">
        delay
        <input
          type="number"
          className="w-16 bg-panel border border-line rounded px-1 py-0.5"
          value={item.delay ?? 0}
          onChange={(e) => onUpdate({ ...item, delay: Math.max(0, parseInt(e.target.value) || 0) })}
        />
      </label>
      {isMoveGroup(item) && (
        <>
          <label className="flex items-center gap-1 text-slate-500">
            dur
            <input
              type="number"
              className="w-16 bg-panel border border-line rounded px-1 py-0.5"
              value={groupDuration(item)}
              onChange={(e) => onUpdate(setGroupDuration(item, Math.max(1, parseInt(e.target.value) || 1)))}
            />
          </label>
          <button className="text-slate-400 hover:text-accent" title="Straighten (keep endpoints)"
            onClick={() => onUpdate(straighten(item))}>⤢</button>
        </>
      )}
      <button className="text-slate-400 hover:text-accent" title="Move up" onClick={onMoveUp}>↑</button>
      <button className="text-slate-400 hover:text-accent" title="Move down" onClick={onMoveDown}>↓</button>
      <button className="text-slate-400 hover:text-accent" title="Duplicate" onClick={onDuplicate}>⎘</button>
      <button className="text-slate-400 hover:text-red-400" title="Delete" onClick={onDelete}>✕</button>
    </div>
  );
}

/** Mini map of the recorded mouse path and clicks (port of ScreenPreview). */
function PathPreview({ macro }: { macro: MacroFile }) {
  const sw = macro.screen?.width ?? 1920;
  const sh = macro.screen?.height ?? 1080;
  const W = 280;
  const H = Math.round((W * sh) / sw);

  const { path, clicks } = useMemo(() => {
    const path: { x: number; y: number }[] = [];
    const clicks: { x: number; y: number; button: string }[] = [];
    for (const ev of macro.events) {
      if (ev.type === "move") path.push({ x: (ev.x / sw) * W, y: (ev.y / sh) * H });
      if (ev.type === "button" && ev.action === "down" && ev.x !== undefined) {
        clicks.push({ x: ((ev.x ?? 0) / sw) * W, y: ((ev.y ?? 0) / sh) * H, button: ev.button });
      }
    }
    return { path, clicks };
  }, [macro.events, sw, sh, H]);

  return (
    <div className="bg-panel2 border border-line rounded-lg p-2">
      <p className="text-[10px] text-slate-500 mb-1">
        Screen preview ({sw}×{sh})
      </p>
      <svg width={W} height={H} className="bg-black/40 rounded">
        {path.length > 1 && (
          <polyline
            points={path.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none" stroke="#38bdf8" strokeWidth="1" opacity="0.8"
          />
        )}
        {clicks.map((c, i) => (
          <circle key={i} cx={c.x} cy={c.y} r="3"
            fill={c.button === "right" ? "#f87171" : "#4ade80"} />
        ))}
      </svg>
    </div>
  );
}

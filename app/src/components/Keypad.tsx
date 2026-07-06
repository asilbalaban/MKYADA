// Visual keypad: shows the physical keys, live press highlights, the layer
// key, and per-key assignment summaries. Click a key (or use arrow keys) to
// select it.

import { useEffect, useRef, useState } from "react";
import { useDevice } from "../lib/device";
import type { Assignment, DeviceConfig } from "../lib/types";
import { assignmentRequiresHost, describeAssignment } from "../lib/macro-model";
import { Spinner } from "./ui";

interface Props {
  config: DeviceConfig;
  selected: number | null;
  onSelect: (keyNo: number) => void;
  assignments?: Map<number, Assignment>;
  /** Keys whose saved macro is still being read from the device — they show
   * a spinner and stay unselectable until loaded. */
  loading?: Set<number>;
}

export function Keypad({ config, selected, onSelect, assignments, loading }: Props) {
  const { onBtn } = useDevice();
  const [pressed, setPressed] = useState<Set<number>>(new Set());
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(
    () =>
      onBtn((e) => {
        setPressed((prev) => {
          const next = new Set(prev);
          if (e.edge === "down") next.add(e.key);
          else next.delete(e.key);
          return next;
        });
      }),
    [onBtn],
  );

  const keys = Array.from({ length: config.key_count }, (_, i) => i + 1);
  // Grid shape: small counts stay one row, 3x2 stays the reference layout,
  // bigger builds get wider rows (8 → 4×2, 9 → 3×3, 12 → 4×3, 20 → 5×4).
  const n = config.key_count;
  const cols = n <= 3 ? n : n <= 6 ? 3 : n === 9 ? 3 : n <= 12 ? 4 : 5;

  // Roving tabindex: the grid is one tab stop; arrows move between keys.
  function onKeyDown(e: React.KeyboardEvent, n: number) {
    const delta =
      e.key === "ArrowRight" ? 1
      : e.key === "ArrowLeft" ? -1
      : e.key === "ArrowDown" ? cols
      : e.key === "ArrowUp" ? -cols
      : 0;
    if (!delta) return;
    e.preventDefault();
    const target = n + delta;
    if (target < 1 || target > config.key_count) return;
    const el = gridRef.current?.querySelector<HTMLButtonElement>(`[data-key="${target}"]`);
    el?.focus();
  }

  const focusKey = selected ?? 1;

  return (
    <div
      ref={gridRef}
      role="group"
      aria-label="Keypad keys"
      className="grid gap-3"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` }}
    >
      {keys.map((n) => {
        const isLayer = config.layer_key === n;
        const isPressed = pressed.has(n);
        const isSelected = selected === n;
        const isLoading = !isLayer && (loading?.has(n) ?? false);
        const a = assignments?.get(n);
        const needsHost = !isLayer && a && assignmentRequiresHost(a);
        const summary = isLayer
          ? "layer switch"
          : isLoading
            ? "loading…"
            : a
              ? describeAssignment(a) + (needsHost ? " — needs the MKYADA app running" : "")
              : "not assigned";
        return (
          <button
            key={n}
            data-key={n}
            tabIndex={n === focusKey ? 0 : -1}
            onClick={() => onSelect(n)}
            onKeyDown={(e) => onKeyDown(e, n)}
            aria-label={`Key ${n} — ${summary}`}
            aria-pressed={isSelected}
            aria-busy={isLoading}
            className={`relative aspect-square rounded-xl border-2 flex flex-col items-center justify-center gap-1 transition-all
              ${isPressed ? "border-accent bg-accent/20 scale-95" : isSelected ? "border-accent bg-panel2" : "border-line bg-panel2 hover:border-fg-faint"}`}
          >
            <span className="text-2xl font-bold text-fg">{n}</span>
            <span className="text-[10px] text-fg-muted px-1 text-center leading-tight">
              {isLayer ? (
                "LAYER"
              ) : isLoading ? (
                <Spinner size={12} className="text-fg-faint" />
              ) : a ? (
                describeAssignment(a)
              ) : (
                ""
              )}
            </span>
            {isLayer && (
              <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-layer" />
            )}
            {needsHost && (
              <span
                className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-warning"
                title="Needs the MKYADA app running on this computer"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

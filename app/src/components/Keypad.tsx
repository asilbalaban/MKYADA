// Visual keypad: shows the physical keys, live press highlights, the layer
// key, and per-key assignment summaries. Click a key to select it.

import { useEffect, useState } from "react";
import { useDevice } from "../lib/device";
import type { Assignment, DeviceConfig } from "../lib/types";
import { describeAssignment } from "../lib/macro-model";

interface Props {
  config: DeviceConfig;
  selected: number | null;
  onSelect: (keyNo: number) => void;
  assignments?: Map<number, Assignment>;
}

export function Keypad({ config, selected, onSelect, assignments }: Props) {
  const { onBtn } = useDevice();
  const [pressed, setPressed] = useState<Set<number>>(new Set());

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
  const cols = config.key_count <= 3 ? config.key_count : 3;

  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` }}>
      {keys.map((n) => {
        const isLayer = config.layer_key === n;
        const isPressed = pressed.has(n);
        const isSelected = selected === n;
        const a = assignments?.get(n);
        return (
          <button
            key={n}
            onClick={() => onSelect(n)}
            className={`relative aspect-square rounded-xl border-2 flex flex-col items-center justify-center gap-1 transition-all
              ${isPressed ? "border-accent bg-accent/20 scale-95" : isSelected ? "border-accent bg-panel2" : "border-line bg-panel2 hover:border-slate-500"}`}
          >
            <span className="text-2xl font-bold text-slate-200">{n}</span>
            <span className="text-[10px] text-slate-400 px-1 text-center leading-tight">
              {isLayer ? "LAYER" : a ? describeAssignment(a) : ""}
            </span>
            {isLayer && (
              <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-purple-400" />
            )}
          </button>
        );
      })}
    </div>
  );
}

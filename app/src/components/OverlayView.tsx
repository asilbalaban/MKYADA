// Rendered inside the transparent, click-through, always-on-top overlay
// window: draws the macro's mouse path 1:1 on the real screen so the user can
// verify exactly where clicks will land (port of the old tkinter overlay).

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { MacroFile } from "../lib/types";
import { EditorItem, groupEvents, isMoveGroup } from "../lib/recorder-model";

interface OverlayData {
  macro: MacroFile;
  selected: number | null;
  /** Draw only the selected row instead of the whole macro. */
  onlySelected?: boolean;
}

export function OverlayView() {
  const [data, setData] = useState<OverlayData | null>(null);

  useEffect(() => {
    // the shell paints a dark background; the overlay must be see-through
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const un = listen<OverlayData>("overlay:data", (e) => setData(e.payload));
    return () => {
      un.then((f) => f());
    };
  }, []);

  if (!data) return null;
  const { macro, selected, onlySelected } = data;
  const sw = Math.max(1, macro.screen?.width ?? screen.width);
  const sh = Math.max(1, macro.screen?.height ?? screen.height);
  // overlay window covers the screen; scale recorded coords to viewport
  const sx = window.innerWidth / sw;
  const sy = window.innerHeight / sh;

  const items = groupEvents(macro.events);
  const paths: { d: string; hot: boolean }[] = [];
  const clicks: { x: number; y: number; button: string; hot: boolean; n: number }[] = [];
  let clickNo = 0;
  items.forEach((item: EditorItem, idx) => {
    const hot = idx === selected;
    if (onlySelected && !hot) return;
    if (isMoveGroup(item)) {
      const d = item.points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x * sx},${p.y * sy}`).join(" ");
      paths.push({ d, hot });
    } else if (item.type === "button" && item.action === "down") {
      clickNo += 1;
      clicks.push({
        x: (item.x ?? 0) * sx,
        y: (item.y ?? 0) * sy,
        button: item.button,
        hot,
        n: clickNo,
      });
    }
  });

  return (
    <svg
      width="100%"
      height="100%"
      style={{ position: "fixed", inset: 0, pointerEvents: "none" }}
    >
      {paths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill="none"
          stroke={p.hot ? "#fbbf24" : "#38bdf8"}
          strokeWidth={p.hot ? 4 : 2.5}
          opacity={p.hot ? 1 : 0.85}
        />
      ))}
      {clicks.map((c, i) => (
        <g key={i}>
          <circle
            cx={c.x}
            cy={c.y}
            r={c.hot ? 14 : 11}
            fill="none"
            stroke={c.hot ? "#fbbf24" : c.button === "right" ? "#f87171" : "#4ade80"}
            strokeWidth={3}
          />
          <circle cx={c.x} cy={c.y} r={2.5} fill={c.hot ? "#fbbf24" : "#ffffff"} />
          <text
            x={c.x + 16}
            y={c.y - 10}
            fill={c.hot ? "#fbbf24" : "#e2e8f0"}
            fontSize={14}
            fontWeight={700}
            style={{ paintOrder: "stroke", stroke: "rgba(0,0,0,0.8)", strokeWidth: 3 }}
          >
            {c.n} · {c.button}
          </text>
        </g>
      ))}
      <text
        x={window.innerWidth / 2}
        y={28}
        textAnchor="middle"
        fill="#e2e8f0"
        fontSize={14}
        style={{ paintOrder: "stroke", stroke: "rgba(0,0,0,0.85)", strokeWidth: 4 }}
      >
        MKYADA path overlay — close it from the editor (“Hide screen overlay”)
      </text>
    </svg>
  );
}

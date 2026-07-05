// Rendered inside the transparent, click-through, always-on-top overlay
// window: draws the macro's mouse path 1:1 on the real screen so the user can
// verify exactly where clicks will land (port of the old tkinter overlay).

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import type { MacroFile } from "../lib/types";
import { EditorItem, groupEvents, isMoveGroup } from "../lib/recorder-model";

interface OverlayData {
  macro: MacroFile;
  /** selected row indices (multi-select) */
  selected: number[] | number | null;
  /** Draw only the selected rows instead of the whole macro. */
  onlySelected?: boolean;
}

export function OverlayView() {
  const [data, setData] = useState<OverlayData | null>(null);
  const lastPing = useRef(Date.now());

  useEffect(() => {
    // the shell paints a dark background; the overlay must be see-through
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const un = listen<OverlayData>("overlay:data", (e) => {
      lastPing.current = Date.now();
      setData(e.payload);
    });
    const unPing = listen("overlay:ping", () => {
      lastPing.current = Date.now();
    });
    // Tell the editor we're ready to draw. This window can finish loading
    // well after the editor's first overlay:data emit (WebView2 cold start
    // on Windows) — without the handshake we'd sit blank forever.
    void emit("overlay:ready");

    // FAILSAFE 1: this window is supposed to be click-through. If any input
    // reaches us, click-through is broken (seen on Windows) and we'd be a
    // fullscreen topmost click trap — close immediately.
    const bail = () => void invoke("overlay_hide");
    window.addEventListener("mousedown", bail, true);
    window.addEventListener("keydown", bail, true);

    // FAILSAFE 2: if the editor stops sending heartbeats (main window died),
    // don't stay on top of the user's screen forever.
    const watchdog = setInterval(() => {
      if (Date.now() - lastPing.current > 5000) void invoke("overlay_hide");
    }, 1000);

    return () => {
      un.then((f) => f());
      unPing.then((f) => f());
      window.removeEventListener("mousedown", bail, true);
      window.removeEventListener("keydown", bail, true);
      clearInterval(watchdog);
    };
  }, []);

  if (!data) return null;
  const { macro, onlySelected } = data;
  const selectedSet = new Set(
    Array.isArray(data.selected) ? data.selected : data.selected !== null ? [data.selected] : [],
  );
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
    const hot = selectedSet.has(idx);
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

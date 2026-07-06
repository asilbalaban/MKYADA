// Rendered inside the transparent, click-through, always-on-top overlay
// window: draws the macro's mouse path 1:1 on the real screen so the user can
// verify exactly where clicks will land (port of the old tkinter overlay).

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import type { MacroFile } from "../lib/types";
import {
  EditorItem,
  groupEvents,
  isClickGroup,
  isDragGroup,
  isMoveGroup,
} from "../lib/recorder-model";

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

    // Proof-of-life from THIS window's JS. The Rust side force-hides the
    // overlay if it's visible but these stop arriving — so a webview that
    // died/hung while topmost (which would otherwise be an inescapable black
    // full-screen trap, since none of the failsafes below can run) tears
    // itself down within a couple of seconds instead.
    void emit("overlay:alive");
    const alive = setInterval(() => void emit("overlay:alive"), 500);

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
      clearInterval(alive);
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
  // Each path also carries its start point + editor row number so the overlay
  // can label where a movement begins and show its travel direction. `drag`
  // distinguishes a button-held drag from a plain cursor move (different hue).
  const paths: { d: string; hot: boolean; drag: boolean; x0: number; y0: number; n: number }[] = [];
  const clicks: {
    x: number;
    y: number;
    button: string;
    hot: boolean;
    n: number;
    up: boolean;
  }[] = [];
  let clickNo = 0;
  items.forEach((item: EditorItem, idx) => {
    const hot = selectedSet.has(idx);
    if (onlySelected && !hot) return;
    if (isMoveGroup(item)) {
      const first = item.points[0];
      const d = item.points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x * sx},${p.y * sy}`).join(" ");
      paths.push({ d, hot, drag: false, x0: first.x * sx, y0: first.y * sy, n: idx + 1 });
    } else if (isClickGroup(item) || isDragGroup(item)) {
      // one editor row = press (+ path) + release; draw all of it
      if (isDragGroup(item)) {
        const pts = [{ x: item.down.x ?? 0, y: item.down.y ?? 0 }, ...item.moves];
        const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x * sx},${p.y * sy}`).join(" ");
        paths.push({ d, hot, drag: true, x0: pts[0].x * sx, y0: pts[0].y * sy, n: idx + 1 });
      }
      clickNo += 1;
      clicks.push({
        x: (item.down.x ?? 0) * sx,
        y: (item.down.y ?? 0) * sy,
        button: item.down.button,
        hot,
        n: clickNo,
        up: false,
      });
      clicks.push({
        x: (item.up.x ?? 0) * sx,
        y: (item.up.y ?? 0) * sy,
        button: item.up.button,
        hot,
        n: clickNo,
        up: true,
      });
    } else if (item.type === "button") {
      // down = green/red ring (by button) with the click number; up = smaller
      // yellow ring, so where the button was RELEASED (end of a drag) is
      // visible too.
      if (item.action === "down") clickNo += 1;
      clicks.push({
        x: (item.x ?? 0) * sx,
        y: (item.y ?? 0) * sy,
        button: item.button,
        hot,
        n: clickNo,
        up: item.action === "up",
      });
    }
  });

  // Left = emerald, right = rose, middle = violet; the selected row is amber.
  const btnColor = (button: string, hot: boolean) =>
    hot ? "#fbbf24" : button === "right" ? "#fb7185" : button === "middle" ? "#c084fc" : "#34d399";
  // Plain cursor moves are blue; button-held drags are orange.
  const MOVE = "#38bdf8";
  const DRAG = "#fb923c";
  const pathColor = (p: { hot: boolean; drag: boolean }) =>
    p.hot ? "#fbbf24" : p.drag ? DRAG : MOVE;

  return (
    <svg
      width="100%"
      height="100%"
      style={{ position: "fixed", inset: 0, pointerEvents: "none" }}
    >
      <defs>
        {/* auto-oriented arrowhead; `context-stroke` makes it inherit each
            path's own colour so hot (amber) and normal (blue) both work. */}
        <marker
          id="mk-arrow" viewBox="0 0 10 10" refX="8" refY="5"
          markerUnits="userSpaceOnUse" markerWidth="14" markerHeight="14" orient="auto"
        >
          <path d="M0,1 L9,5 L0,9 z" fill="context-stroke" />
        </marker>
      </defs>
      {paths.map((p, i) => (
        <g key={i}>
          <path
            d={p.d}
            fill="none"
            stroke={pathColor(p)}
            strokeWidth={p.hot ? 4 : 2.5}
            opacity={p.hot ? 1 : 0.9}
            markerEnd="url(#mk-arrow)"
          />
          {/* row number where the movement starts */}
          <text
            x={p.x0 + 7}
            y={p.y0 - 7}
            fill={pathColor(p)}
            fontSize={12}
            fontWeight={700}
            style={{ paintOrder: "stroke", stroke: "rgba(0,0,0,0.85)", strokeWidth: 3.5 }}
          >
            #{p.n}
          </text>
        </g>
      ))}
      {clicks.map((c, i) => {
        const col = btnColor(c.button, c.hot);
        return (
          <g key={i}>
            <circle
              cx={c.x}
              cy={c.y}
              r={c.up ? (c.hot ? 10 : 8) : c.hot ? 15 : 12}
              fill={col}
              fillOpacity={c.up ? 0 : 0.18}
              stroke={col}
              strokeWidth={c.up ? 2.5 : 3}
              strokeDasharray={c.up ? "3 4" : undefined}
            />
            <circle cx={c.x} cy={c.y} r={2.5} fill={col} />
            {!c.up && (
              <text
                x={c.x + 16}
                y={c.y - 10}
                fill={col}
                fontSize={13}
                fontWeight={700}
                style={{ paintOrder: "stroke", stroke: "rgba(0,0,0,0.85)", strokeWidth: 3 }}
              >
                {c.n} · {c.button}
              </text>
            )}
          </g>
        );
      })}
      {/* Legend so a glance explains every colour. */}
      <g transform="translate(16,16)">
        <rect x={0} y={0} width={168} height={128} rx={10} fill="rgba(10,14,20,0.72)" />
        {[
          { c: MOVE, kind: "line", label: "Move" },
          { c: DRAG, kind: "line", label: "Drag" },
          { c: "#34d399", kind: "dot", label: "Left click" },
          { c: "#fb7185", kind: "dot", label: "Right click" },
          { c: "#c084fc", kind: "dot", label: "Middle click" },
        ].map((e, i) => {
          const y = 22 + i * 21;
          return (
            <g key={e.label}>
              {e.kind === "line" ? (
                <line x1={12} y1={y} x2={36} y2={y} stroke={e.c} strokeWidth={3} markerEnd="url(#mk-arrow)" />
              ) : (
                <circle cx={24} cy={y} r={7} fill={e.c} fillOpacity={0.25} stroke={e.c} strokeWidth={2.5} />
              )}
              <text x={48} y={y + 4} fill="#e2e8f0" fontSize={13} fontWeight={600}>
                {e.label}
              </text>
            </g>
          );
        })}
      </g>
      <text
        x={window.innerWidth / 2}
        y={28}
        textAnchor="middle"
        fill="#e2e8f0"
        fontSize={14}
        style={{ paintOrder: "stroke", stroke: "rgba(0,0,0,0.85)", strokeWidth: 4 }}
      >
        MKYADA path overlay — close it from the editor (“Hide overlay”)
      </text>
    </svg>
  );
}

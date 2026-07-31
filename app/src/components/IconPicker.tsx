// Pick the 8×8 picture that sits above a key's name in the Vision 6 grid.
//
// The swatches are not lookalikes: they are drawn from the same packed bytes
// the firmware ships (lib/oled-icons.ts, generated from icons/src/icons.txt by
// scripts/build-icons.mjs), so what you choose here is pixel-for-pixel what
// lights up on the glass. The tile beside the grid is the real cell renderer
// from lib/oled-draw, so a name too long for one line visibly drops its icon
// exactly as the device does.
//
// Choice is stored by NAME, never by index — names are permanent, so growing
// or reordering the family can never repoint an existing macro at a different
// picture, and a name we later drop simply falls back to the kind's default.

import { useMemo, useRef, useState, useEffect } from "react";
import {
  CUSTOM_ICON_PREFIX,
  ICON_CATEGORIES,
  iconBytes,
  packCustomIcon,
} from "../lib/oled-icons";
import { drawIconSwatch, renderWheelScreen, OLED_W, OLED_H } from "../lib/oled-draw";
import type { Assignment } from "../lib/types";
import { Input } from "./ui";

/** What the firmware falls back to when a macro carries no icon.
 * Mirrors KIND_ICON in firmware/mkyada/ui.py — if that map changes, this one
 * has to move with it or the "Automatic" swatch lies about what you'll get. */
const KIND_ICON: Record<string, string> = {
  keystroke: "keyboard",
  combo: "keyboard",
  text: "text",
  recorded: "record",
  media: "play",
  volume: "volume",
  scroll: "scroll-v",
  menu: "layers",
  sequence: "sequence",
  launch: "rocket",
  command: "terminal",
  sound: "music",
  mic: "mic",
  mic_level: "mic",
  webhook: "webhook",
  obs: "camera",
};

export function defaultIconFor(kind: string): string | null {
  return KIND_ICON[kind] ?? null;
}

/** The reserved icon name meaning "draw no icon at all", as opposed to an
 *  absent field, which means "let the action family choose". Read the same way
 *  by Ui._grid_icons in firmware/mkyada/ui.py. */
export const NO_ICON = "none";

/** One icon drawn at `scale`, straight from the packed bytes.
 *
 * Drawn in the surrounding text colour, not the display's own near-white blue
 * (#eaf3ff). That blue is right on the black glass and right in the OLED
 * preview beside this list, but on the app's panel it is a pale wash that
 * barely registers as a shape — 270 of them side by side were unreadable.
 * Reading the computed colour off the canvas keeps it correct in both
 * themes without hard-coding either one. */
function Swatch({ name, scale = 2, title }: { name: string | null; scale?: number; title?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = ref.current;
    const c = el?.getContext("2d");
    if (el && c) drawIconSwatch(c, name ?? "", scale, getComputedStyle(el).color);
  }, [name, scale]);
  return (
    <canvas
      ref={ref}
      width={8 * scale}
      height={8 * scale}
      title={title ?? name ?? undefined}
      style={{ display: "block", imageRendering: "pixelated" }}
    />
  );
}

/** The grid cell as the device draws it, so the choice is judged in context. */
function CellPreview({ name, icon }: { name: string; icon: string | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current?.getContext("2d");
    if (!c) return;
    const fb = renderWheelScreen({ screen: "cell", name, icon, selected: true });
    const img = c.createImageData(OLED_W, OLED_H);
    for (let i = 0; i < fb.px.length; i++) {
      const o = i * 4;
      if (fb.px[i]) {
        img.data[o] = 0xea;
        img.data[o + 1] = 0xf3;
        img.data[o + 2] = 0xff;
      }
      img.data[o + 3] = 255;
    }
    c.putImageData(img, 0, 0);
  }, [name, icon]);
  // Only the first tile is drawn, so show that corner rather than a mostly
  // empty 128×64 — the cell is 41×23 at (0,11).
  return (
    <div
      style={{
        width: 41 * 3,
        height: 23 * 3,
        overflow: "hidden",
        borderRadius: 4,
        background: "#000",
      }}
    >
      <canvas
        ref={ref}
        width={OLED_W}
        height={OLED_H}
        style={{
          display: "block",
          width: OLED_W * 3,
          height: OLED_H * 3,
          marginTop: -11 * 3,
          imageRendering: "pixelated",
        }}
      />
    </div>
  );
}

/** Draw the eight rows by hand.
 *
 * The canvas is the real thing, not a sketch of it: the grid below is the same
 * 8×8 the glass lights up, and what it packs is the exact byte string the
 * firmware decodes (icons.py get(), "px:" + 16 hex). There is no upload step
 * and no second file — the picture rides inside the macro's own json, so it
 * travels with a backup and vanishes with a delete.
 *
 * A click toggles its pixel. Dragging keeps doing whatever the first pixel
 * did, so a stroke paints or erases as a whole rather than flickering under
 * the pointer. */
function IconDrawer({
  rows,
  onRows,
}: {
  rows: Uint8Array;
  onRows: (rows: Uint8Array) => void;
}) {
  // null while the pointer is up; true = the stroke is painting, false = erasing
  const stroke = useRef<boolean | null>(null);

  function apply(x: number, y: number, on: boolean) {
    const bit = 0x80 >> x;
    const cur = (rows[y] & bit) !== 0;
    if (cur === on) return;
    const next = new Uint8Array(rows);
    next[y] = on ? next[y] | bit : next[y] & ~bit;
    onRows(next);
  }

  useEffect(() => {
    const up = () => {
      stroke.current = null;
    };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);

  return (
    <div className="flex flex-col gap-2">
      <div
        className="grid w-max touch-none select-none gap-px rounded bg-line p-px"
        style={{ gridTemplateColumns: "repeat(8, 22px)" }}
      >
        {Array.from({ length: 64 }, (_, i) => {
          const x = i % 8;
          const y = (i / 8) | 0;
          const on = (rows[y] & (0x80 >> x)) !== 0;
          return (
            <button
              key={i}
              type="button"
              aria-label={`Pixel ${x + 1}, ${y + 1}`}
              aria-pressed={on}
              className={`h-[22px] w-[22px] ${on ? "bg-accent" : "bg-panel2 hover:bg-panel"}`}
              onPointerDown={(e) => {
                // Touch implicitly captures the pointer on the cell the stroke
                // started in, so every later move is delivered there and a drag
                // across the grid paints exactly one pixel. Releasing hands the
                // moves back to whatever is under the finger. Chromium ignores
                // a release with nothing captured, but the spec lets an engine
                // throw, and losing this handler would mean a click that draws
                // nothing — cheap to guard, expensive to debug.
                try {
                  e.currentTarget.releasePointerCapture(e.pointerId);
                } catch {
                  /* nothing was captured — a mouse, nothing to hand back */
                }
                stroke.current = !on;
                apply(x, y, !on);
              }}
              onPointerEnter={() => {
                if (stroke.current !== null) apply(x, y, stroke.current);
              }}
            />
          );
        })}
      </div>
      <div className="flex items-center gap-3 text-xs">
        <button
          type="button"
          className="text-fg-faint underline hover:text-fg-muted"
          onClick={() => onRows(new Uint8Array(8))}
        >
          Clear
        </button>
        <button
          type="button"
          className="text-fg-faint underline hover:text-fg-muted"
          onClick={() => onRows(rows.map((b) => ~b & 0xff))}
        >
          Invert
        </button>
        <span className="text-fg-faint">
          Click a pixel to light it, click again to clear. Drag to draw.
        </span>
      </div>
    </div>
  );
}

/** Eight editable rows seeded from an existing icon, blank if there is none. */
function seedRows(icon: string | null | undefined): Uint8Array {
  const b = iconBytes(icon);
  return b ? new Uint8Array(b) : new Uint8Array(8);
}

/** Firmware that decodes a "px:" icon name instead of looking it up. Below it
 *  a drawing is silently ignored and the tile shows the kind's default, so the
 *  drawer is not offered rather than offered and quietly dropped. */
function fwDrawsCustomIcons(fw: string | undefined): boolean {
  if (!fw) return true; // nothing connected — don't hide a feature on a guess
  const [maj = 0, min = 0] = fw.split(".").map((n) => parseInt(n) || 0);
  return maj > 0 || min >= 25;
}

export function IconPicker({
  value,
  onChange,
  assignment,
  name,
  fwVersion,
}: {
  /** The chosen icon name, or undefined for the kind's default. */
  value: string | undefined;
  onChange: (icon: string | undefined) => void;
  assignment: Assignment;
  /** The name that will sit under the icon on the glass. */
  name: string;
  /** The connected keypad's firmware, for the hand-drawn icon gate. */
  fwVersion?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const fallback = defaultIconFor(assignment.kind);
  // Three distinct states, not two: no field at all means "the action family
  // picks", which is why asking for a bare cell needs a name of its own.
  // NO_ICON is that name, and the firmware reads it the same way (_grid_icons).
  const none = value === NO_ICON;
  const effective = none ? null : (value ?? fallback);
  const custom = !!value?.startsWith(CUSTOM_ICON_PREFIX);
  // An icon already drawn stays editable even on firmware that can't show it —
  // hiding the way back in would strand the drawing inside the macro file.
  const canDraw = custom || fwDrawsCustomIcons(fwVersion);
  const [drawing, setDrawing] = useState(false);
  // Opening the drawer on an icon that already exists starts from its pixels
  // rather than from a blank grid — tracing one of the 270 is how most
  // hand-drawn icons actually begin.
  const [rows, setRows] = useState<Uint8Array>(() => seedRows(effective));

  // Mid-stroke the saved value and `rows` are the same picture; before the
  // first stroke they aren't, so the preview follows the grid, not the macro.
  const shown = drawing ? packCustomIcon(rows) : effective;

  function openDrawer() {
    setRows(seedRows(effective));
    setDrawing(true);
    setOpen(false);
  }

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return ICON_CATEGORIES.map(([label, names]) => [
      label,
      needle ? names.filter((n) => n.includes(needle)) : names,
    ] as const).filter(([, names]) => names.length > 0);
  }, [q]);

  const total = groups.reduce((n, [, names]) => n + names.length, 0);

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-fg-muted">Screen icon</span>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => {
            setDrawing(false);
            setOpen((o) => !o);
          }}
          aria-expanded={open}
          className="flex items-center gap-2 rounded-md border border-line bg-panel2 px-2.5 py-1.5 text-sm text-fg outline-none focus:border-accent"
        >
          <Swatch name={shown} scale={2} />
          <span className="text-fg-muted">
            {custom
              ? "Drawn by you"
              : none
                ? "No icon"
                : (value ?? `Automatic${fallback ? ` (${fallback})` : ""}`)}
          </span>
        </button>
        <button
          type="button"
          aria-pressed={none}
          onClick={() => {
            setDrawing(false);
            // Clicking it again is the way back to automatic, the same rule
            // the swatches follow — otherwise "no icon" is a one-way door.
            onChange(none ? undefined : NO_ICON);
          }}
          className={`text-xs underline ${none ? "text-fg" : "text-fg-faint hover:text-fg-muted"}`}
        >
          No icon
        </button>
        {canDraw && (
          <button
            type="button"
            onClick={() => (drawing ? setDrawing(false) : openDrawer())}
            aria-expanded={drawing}
            className="text-xs text-fg-faint underline hover:text-fg-muted"
          >
            {drawing ? "Close" : custom ? "Edit drawing" : "Draw your own"}
          </button>
        )}
        {value && (
          <button
            type="button"
            onClick={() => {
              setDrawing(false);
              onChange(undefined);
            }}
            className="text-xs text-fg-faint underline hover:text-fg-muted"
          >
            Use automatic
          </button>
        )}
        <CellPreview name={name} icon={shown} />
      </div>

      {drawing && (
        <div className="flex flex-col gap-2 rounded-md border border-line p-2">
          <IconDrawer
            rows={rows}
            onRows={(r) => {
              setRows(r);
              // Save on every stroke rather than behind a button: the cell
              // preview beside it is the point, and a drawing you have to
              // confirm before you can judge it is a drawing you judge twice.
              onChange(packCustomIcon(r));
            }}
          />
        </div>
      )}

      {open && (
        <div className="flex flex-col gap-2 rounded-md border border-line p-2">
          <Input
            value={q}
            placeholder={`Search ${ICON_CATEGORIES.reduce((n, [, c]) => n + c.length, 0)} icons…`}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="flex max-h-72 flex-col gap-3 overflow-y-auto">
            {groups.map(([label, names]) => (
              <div key={label} className="flex flex-col gap-1">
                <span className="text-[11px] uppercase tracking-wide text-fg-faint">{label}</span>
                <div className="flex flex-wrap gap-1">
                  {names.map((n) => {
                    const picked = n === value;
                    return (
                      <button
                        key={n}
                        type="button"
                        title={n}
                        aria-pressed={picked}
                        // Clicking the chosen one again clears back to the
                        // automatic icon — otherwise there is no way out of a
                        // choice except finding the kind's default by eye.
                        onClick={() => onChange(picked ? undefined : n)}
                        // text-fg is not decoration: Swatch draws the icon in
                        // its own computed colour, so this is what makes the
                        // pixels legible on the panel.
                        className={`rounded border p-1 text-fg ${
                          picked ? "border-accent bg-panel2" : "border-transparent hover:border-line"
                        }`}
                      >
                        <Swatch name={n} scale={2} />
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            {total === 0 && <p className="text-xs text-fg-faint">No icon matches “{q}”.</p>}
          </div>
        </div>
      )}
      <span className="text-[11px] text-fg-faint">
        {none
          ? "No picture on this key — the cell is the name alone, on two lines if it needs them."
          : iconBytes(effective)
            ? "Shown above the name in the key grid. A name that needs two lines drops the icon."
            : "This action has no default icon; the cell shows the name alone."}
      </span>
    </div>
  );
}

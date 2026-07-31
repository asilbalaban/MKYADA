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
import { ICON_CATEGORIES, iconBytes } from "../lib/oled-icons";
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

/** One icon drawn at `scale`, straight from the packed bytes. */
function Swatch({ name, scale = 2, title }: { name: string | null; scale?: number; title?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current?.getContext("2d");
    if (c) drawIconSwatch(c, name ?? "", scale);
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

export function IconPicker({
  value,
  onChange,
  assignment,
  name,
}: {
  /** The chosen icon name, or undefined for the kind's default. */
  value: string | undefined;
  onChange: (icon: string | undefined) => void;
  assignment: Assignment;
  /** The name that will sit under the icon on the glass. */
  name: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const fallback = defaultIconFor(assignment.kind);
  const effective = value ?? fallback;

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
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-2 rounded-md border border-line bg-panel2 px-2.5 py-1.5 text-sm text-fg outline-none focus:border-accent"
        >
          <Swatch name={effective} scale={2} />
          <span className="text-fg-muted">{value ?? `Automatic${fallback ? ` (${fallback})` : ""}`}</span>
        </button>
        {value && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="text-xs text-fg-faint underline hover:text-fg-muted"
          >
            Use automatic
          </button>
        )}
        <CellPreview name={name} icon={effective} />
      </div>

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
                        className={`rounded border p-1 ${
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
        {iconBytes(effective)
          ? "Shown above the name in the key grid. A name that needs two lines drops the icon."
          : "This action has no default icon; the cell shows the name alone."}
      </span>
    </div>
  );
}

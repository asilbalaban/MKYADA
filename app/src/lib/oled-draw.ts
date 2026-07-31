// The editor's OLED preview: which screen an assignment produces, and how to
// get it onto a canvas.
//
// This file used to hold a second drawing of the Vision 6's screens. It does
// not any more — every pixel comes from oled-screens.ts, the one JavaScript
// implementation, which the published demo page is also built from. What is
// left here is the mapping from "this key does X" to "so the wheel shows Y",
// plus the canvas plumbing.
//
// oled-draw.test.ts renders these against the FIRMWARE's own golden images
// (tests/golden/*.txt), so a layout change that reaches oled.py and not
// oled-screens.ts — or the other way round — fails there.

import { Fb } from "./oled-fb";
import { iconBytes } from "./oled-icons";
import { OledScreens } from "./oled-screens";

export const OLED_W = 128;
export const OLED_H = 64;

export {
  BAR_H,
  ROW_H,
  ROW_TOP,
  VIS,
  SB_X,
  SB_Y,
  SB_H,
  PBAR_Y,
  PBAR_H,
  PBAR_FOOT,
  TILE_X,
  TILE_W,
  HERO_SCALE,
} from "./oled-screens";

/** One preview screen. Each variant carries what the matching oled-screens
 * method takes, rather than a pre-composed picture — that is what lets the
 * test feed the firmware's own golden inputs through this renderer. */
export type WheelPreview =
  | { screen: "speed"; layer: string; key: number; t: number; lo?: number; hi?: number }
  | { screen: "slider"; title: string; hero: string; frac: number; action?: string }
  | { screen: "card"; title: string; big: string; line?: string; hint?: string }
  | {
      screen: "picker";
      title: string;
      items: { label: string; mark?: "dot" | "cursor" }[];
      action?: string;
      /** Centre hint, e.g. "hold: assign" — shown when a hold on the highlighted
       * item reassigns the key (media / OBS scene / mic mode). */
      hold?: string;
    }
  | { screen: "toast"; title: string; line1?: string; line2?: string; ok?: boolean }
  /** A single macro-grid tile: what the icon picker is really choosing. */
  | { screen: "cell"; name: string; icon?: string | null; selected?: boolean };

/** Render a preview into a framebuffer — 1 byte per pixel, 128×64. */
export function renderWheelScreen(p: WheelPreview): Fb {
  const o = new OledScreens(new Fb(OLED_W, OLED_H));

  if (p.screen === "speed") {
    o.show_speed(p.layer, p.key, p.t, p.lo, p.hi);
  } else if (p.screen === "slider") {
    o.show_adjust(p.title, p.hero, p.frac, p.action);
  } else if (p.screen === "card") {
    o.show_card(p.title, p.big, p.line, p.hint);
  } else if (p.screen === "picker") {
    const cursor = p.items.findIndex((i) => i.mark === "cursor");
    const dot = p.items.findIndex((i) => i.mark === "dot");
    o.show_menu(
      p.title,
      p.items.map((i) => i.label),
      Math.max(0, cursor),
      dot >= 0 ? dot : null,
      p.action,
      p.hold,
    );
  } else if (p.screen === "toast") {
    o.show_toast(p.title, p.line1, p.line2, p.ok);
  } else if (p.screen === "cell") {
    // One tile of a banded grid, in the first slot. Drawing the whole grid and
    // cropping keeps the cell's geometry honest: the same split_name, the same
    // "a two-line name drops its icon" rule the device applies.
    const pair = o.split_name(p.name);
    const labels: [string, string][] = [pair, ["", ""], ["", ""], ["", ""], ["", ""], ["", ""]];
    const icons = [iconBytes(p.icon), null, null, null, null, null];
    o.show_grid(labels, p.selected === false ? null : 0, true, " ", icons);
  }
  return o.fb;
}

/** Paint a preview onto a canvas 2D context (already sized 128×64). */
export function drawWheelScreen(c: CanvasRenderingContext2D, p: WheelPreview) {
  paintFb(c, renderWheelScreen(p));
}

/** Blit a framebuffer onto a 2D context at 1:1 — the SH1106's lit pixel is a
 * cold white, not pure white, which is most of why the preview reads as a
 * screen rather than a drawing. */
export function paintFb(c: CanvasRenderingContext2D, fb: Fb) {
  const img = c.createImageData(fb.W, fb.H);
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
}

/** Draw a single 8x8 icon scaled up, for the picker's swatches. Not a screen —
 * just the glyph, so the grid of choices is the same pixels the tile will get. */
export function drawIconSwatch(
  c: CanvasRenderingContext2D,
  name: string,
  scale: number,
  lit = "#eaf3ff",
) {
  const data = iconBytes(name);
  c.clearRect(0, 0, 8 * scale, 8 * scale);
  if (!data) return;
  c.fillStyle = lit;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      if (data[row] & (0x80 >> col)) c.fillRect(col * scale, row * scale, scale, scale);
    }
  }
}

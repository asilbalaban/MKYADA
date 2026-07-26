// The Vision 6 wheel-menu screens, drawn the way the device draws them.
//
// This used to be Courier text on a canvas at hand-guessed coordinates — a
// picture of a keypad that doesn't exist. It now runs the real font
// (oled-fb.ts) through the real geometry (the constants below are
// firmware/mkyada/oled.py's), so what the editor shows is what the wheel
// shows: same glyphs, same proportional widths, same truncation point, Turkish
// included.
//
// oled-draw.test.ts renders three of these against the FIRMWARE's own golden
// images. If a constant here drifts from oled.py, that test fails.

import { Fb, oledFont } from "./oled-fb";

export const OLED_W = 128;
export const OLED_H = 64;

// --- firmware/mkyada/oled.py layout constants ---
export const BAR_H = 11; // inverted title strip
export const BAR_Y = 5; // cap-centre of the title text
export const BOT_SEP = 53; // hairline above the bottom bar
export const BOT_Y = 58; // cap-centre of the bottom bar text
export const HBAR_Y = 41;
export const HBAR_H = 5;
export const HERO_Y = 27;
export const HERO_SCALE = 3;
export const ROW_H = 10; // menu row pitch
export const MENU_TOP = 15; // cap-centre of the first menu row
export const MENU_VIS = 4; // rows between the bars

/** One preview screen — the shapes the firmware can render for a wheel menu. */
export type WheelPreview =
  | { screen: "speed"; title: string; value: string; frac: number; action: string }
  | { screen: "slider"; title: string; value: string; frac: number; action: string }
  | { screen: "card"; title: string; big: string; line?: string; hint?: string }
  | {
      screen: "picker";
      title: string;
      items: { label: string; mark?: "dot" | "cursor" }[];
      action: string;
      /** Centre bottom-bar hint, e.g. "hold: assign" — shown when a hold on the
       * highlighted item reassigns the key (media / OBS scene / mic mode). */
      hold?: string;
    }
  | { screen: "toast"; title: string; line1: string; line2?: string };

const CX = OLED_W >> 1;

function topBar(fb: Fb, title: string, hint?: string) {
  fb.rect(0, 0, OLED_W, BAR_H);
  if (hint) {
    fb.text(title, 2, BAR_Y, 0, true);
    fb.text(hint, OLED_W - 2, BAR_Y, 1, true);
  } else {
    fb.text(title, CX, BAR_Y, 0.5, true);
  }
}

function bottomBar(fb: Fb, action?: string, back = true) {
  fb.hline(0, BOT_SEP, OLED_W);
  // "< back", not "Back" — the device's own English string (i18n.py).
  if (back) fb.text("< back", 2, BOT_Y, 0);
  if (action) fb.text(action, OLED_W - 2, BOT_Y, 1);
}

function hbar(fb: Fb, frac: number) {
  const bx = 8;
  const bw = OLED_W - 16;
  fb.hline(bx, HBAR_Y + (HBAR_H >> 1), bw);
  fb.rect(bx, HBAR_Y, Math.trunc(frac * bw), HBAR_H);
}

/** oled.py's show_menu, minus the incremental-repaint cache (a still picture
 * has no previous frame to spare work against). */
function menu(
  fb: Fb,
  title: string,
  items: string[],
  sel: number,
  marked: number | null,
  action: string,
  hold?: string,
) {
  const font = oledFont();
  const n = items.length;
  const top = sel >= MENU_VIS ? sel - MENU_VIS + 1 : 0;
  const rw = n > MENU_VIS ? OLED_W - 8 : OLED_W;
  topBar(fb, title, hold);
  if (top > 0) fb.tri(OLED_W - 7, BAR_H + 2, 7, 4, false);
  if (top + MENU_VIS < n) fb.tri(OLED_W - 7, BOT_SEP - 6, 7, 4, true);
  bottomBar(fb, action);
  for (let row = 0; row < Math.min(MENU_VIS, n); row++) {
    const i = top + row;
    const label = marked === null ? items[i] : `${i === marked ? ">" : " "} ${items[i]}`;
    const on = i === sel;
    const y = MENU_TOP + row * ROW_H;
    fb.rect(0, y - 4, rw, ROW_H, on ? 1 : 0);
    fb.text(font.fit(label, rw - 4), CX, y, 0.5, on);
  }
}

/** Render a preview into a framebuffer — 1 byte per pixel, 128×64. */
export function renderWheelScreen(p: WheelPreview): Fb {
  const fb = new Fb(OLED_W, OLED_H);
  const font = fb.font;

  if (p.screen === "speed" || p.screen === "slider") {
    // oled.py's _value_screen: title bar, hero, slider, action.
    topBar(fb, p.title);
    bottomBar(fb, p.action);
    fb.big(p.value, CX, HERO_Y, HERO_SCALE);
    hbar(fb, Math.max(0, Math.min(1, p.frac)));
  } else if (p.screen === "card") {
    topBar(fb, p.title);
    // The device fits the hero to half the glass at scale 2 rather than
    // trusting a character count — 12 wide characters overflow both edges.
    fb.big(font.fit(p.big, OLED_W >> 1), CX, 27, 2);
    if (p.line) fb.text(p.line, CX, 44);
    bottomBar(fb, p.hint);
  } else if (p.screen === "picker") {
    const cursor = p.items.findIndex((i) => i.mark === "cursor");
    const dot = p.items.findIndex((i) => i.mark === "dot");
    menu(
      fb,
      p.title,
      p.items.map((i) => i.label),
      Math.max(0, cursor),
      dot >= 0 ? dot : null,
      p.action,
      p.hold,
    );
  } else if (p.screen === "toast") {
    topBar(fb, p.title);
    fb.text(p.line1, CX, 30);
    if (p.line2) fb.text(p.line2, CX, 42);
  }
  return fb;
}

/** Paint a preview onto a canvas 2D context (already sized 128×64). */
export function drawWheelScreen(c: CanvasRenderingContext2D, p: WheelPreview) {
  const fb = renderWheelScreen(p);
  const img = c.createImageData(OLED_W, OLED_H);
  for (let i = 0; i < fb.px.length; i++) {
    const o = i * 4;
    if (fb.px[i]) {
      // lit SH1106 pixel
      img.data[o] = 0xea;
      img.data[o + 1] = 0xf3;
      img.data[o + 2] = 0xff;
    }
    img.data[o + 3] = 255;
  }
  c.putImageData(img, 0, 0);
}

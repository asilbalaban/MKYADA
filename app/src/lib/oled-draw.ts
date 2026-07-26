// Draws the Vision 6 wheel-menu screens onto a 128×64 canvas, mirroring
// firmware/mkyada/oled.py (show_card / show_speed / show_menu). Used by the
// in-app OledPreview so the editor and Settings show exactly what pressing the
// wheel on a key looks like on the real device. Ported from the geometry in
// app/screenshots/oled.html.

export const OLED_W = 128;
export const OLED_H = 64;
const CX = OLED_W / 2;
const INK = "#eaf3ff"; // lit SH1106 pixel
const FONT = "'Courier New', monospace";

const font = (px: number, bold = false) => (bold ? "bold " : "") + px + "px " + FONT;

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

function rect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  c.fillRect(x, y, Math.max(1, w), Math.max(1, h));
}

function text(
  c: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  opt: { align?: CanvasTextAlign; color?: string; px?: number; bold?: boolean } = {},
) {
  c.font = font(opt.px ?? 8, opt.bold);
  c.textAlign = opt.align ?? "center";
  c.fillStyle = opt.color ?? INK;
  c.fillText(s, x, y);
}

function topBar(c: CanvasRenderingContext2D, title: string) {
  c.fillStyle = INK;
  rect(c, 0, 0, OLED_W, 13);
  text(c, title, CX, 6, { color: "#000", px: 7 });
}

function bottomBar(c: CanvasRenderingContext2D, action?: string, back = true, hold?: string) {
  c.fillStyle = INK;
  rect(c, 0, OLED_H - 13, OLED_W, 1);
  if (back) text(c, "Back", 2, OLED_H - 6, { align: "left" });
  if (hold) text(c, hold, CX, OLED_H - 6, { align: "center" });
  if (action) text(c, action, OLED_W - 2, OLED_H - 6, { align: "right" });
}

function hbar(c: CanvasRenderingContext2D, frac: number) {
  const bx = 8, by = 39, bw = OLED_W - 16;
  c.fillStyle = INK;
  rect(c, bx, by + 2, bw, 1);
  rect(c, bx, by, Math.round(Math.max(0, Math.min(1, frac)) * bw), 4);
}

/** Paint a preview onto a canvas 2D context (already sized 128×64). */
export function drawWheelScreen(c: CanvasRenderingContext2D, p: WheelPreview) {
  c.imageSmoothingEnabled = false;
  c.textBaseline = "middle";
  c.fillStyle = "#000";
  c.fillRect(0, 0, OLED_W, OLED_H);
  c.fillStyle = INK;

  if (p.screen === "speed" || p.screen === "slider") {
    topBar(c, p.title);
    text(c, p.value, CX, 26, { px: 17, bold: true });
    hbar(c, p.frac);
    bottomBar(c, p.action);
  } else if (p.screen === "card") {
    topBar(c, p.title);
    text(c, p.big, CX, p.line ? 28 : 32, { px: 13, bold: true });
    if (p.line) text(c, p.line, CX, 44);
    bottomBar(c, p.hint);
  } else if (p.screen === "picker") {
    topBar(c, p.title);
    const rows = p.items.slice(0, 3);
    rows.forEach((it, row) => {
      const y = 20 + row * 12;
      let col = INK;
      if (it.mark === "cursor") {
        c.fillStyle = INK;
        rect(c, 0, y - 6, OLED_W - 8, 12);
        col = "#000";
      }
      const prefix = it.mark === "cursor" ? "▸ " : "  ";
      text(c, prefix + it.label, 6, y, { align: "left", color: col });
      if (it.mark === "dot") {
        c.fillStyle = INK;
        c.beginPath();
        c.arc(OLED_W - 12, y, 2, 0, 7);
        c.fill();
      }
    });
    if (p.items.length > 3) {
      c.fillStyle = INK;
      c.beginPath();
      c.moveTo(OLED_W - 7, 45);
      c.lineTo(OLED_W - 1, 45);
      c.lineTo(OLED_W - 4, 49);
      c.fill();
    }
    bottomBar(c, p.action, true, p.hold);
  } else if (p.screen === "toast") {
    topBar(c, p.title);
    text(c, p.line1, CX, p.line2 ? 30 : 34);
    if (p.line2) text(c, p.line2, CX, 42);
  }
}

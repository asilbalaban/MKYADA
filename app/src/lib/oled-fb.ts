// A port of firmware/mkyada/font.py: the MKYADA bitmap font and the 128×64
// framebuffer it draws into.
//
// The app shows little previews of the device's screens. They used to be
// Courier text on a canvas, which was a guess at the real thing and started
// drifting the day the firmware got its own 5×8 proportional font — different
// widths, different baselines, no Turkish. This reads the SAME font bytes the
// device flashes (oled-font.ts, generated from firmware/fonts/mkyada.fnt) with
// the same layout rules, so a preview is a picture of the glass rather than an
// impression of it. oled-draw.test.ts holds it to that claim by diffing
// against the firmware's own golden renders.
//
// Deliberately a transcription, not an improvement: where the firmware rounds
// with int(), so does this.

import { FONT_B64 } from "./oled-font";

/** Last resort for characters the font doesn't draw — same table as font.py. */
const FOLD: Record<string, string> = {
  á: "a", à: "a", â: "a", ä: "a", å: "a", ã: "a",
  é: "e", è: "e", ê: "e", ë: "e",
  í: "i", ì: "i", î: "i", ï: "i",
  ó: "o", ò: "o", ô: "o", õ: "o",
  ú: "u", ù: "u", û: "u",
  ñ: "n", ý: "y", ÿ: "y", æ: "a", ø: "o", ß: "s",
  Á: "A", À: "A", Â: "A", Ä: "A", Å: "A", Ã: "A",
  É: "E", È: "E", Ê: "E", Ë: "E",
  Í: "I", Ì: "I", Î: "I", Ï: "I",
  Ó: "O", Ò: "O", Ô: "O", Õ: "O",
  Ú: "U", Ù: "U", Û: "U",
  Ñ: "N", Æ: "A", Ø: "O",
  "–": "-", "—": "-", "‘": "'", "’": "'",
  "“": '"', "”": '"', "…": ".",
};

function decodeBase64(b64: string): Uint8Array {
  // atob in the browser, Buffer under vitest/node — both are always present in
  // the environments this module runs in.
  if (typeof atob === "function") {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** The glyph atlas: every glyph side by side in one 1-bit bitmap. */
export class OledFont {
  readonly boxW: number;
  readonly boxH: number;
  readonly first: number;
  readonly last: number;
  readonly adv: Uint8Array;
  /** atlas[y * atlasW + x] — 1 where a glyph pixel is lit. */
  readonly atlas: Uint8Array;
  readonly atlasW: number;
  private readonly extra = new Map<number, number>();

  constructor(data: Uint8Array) {
    if (String.fromCharCode(...data.subarray(0, 4)) !== "MKF2") throw new Error("bad font");
    this.boxW = data[4];
    this.boxH = data[5];
    this.first = data[6];
    const nAscii = data[7];
    const nExtra = data[8];
    const n = nAscii + nExtra;
    this.last = this.first + nAscii - 1;

    let off = 10;
    this.adv = data.subarray(off, off + n);
    off += n;
    for (let i = 0; i < nExtra; i++) {
      this.extra.set(data[off] | (data[off + 1] << 8), nAscii + i);
      off += 2;
    }

    const bpc = this.boxH >> 3; // bytes per column, LSB = topmost row
    const aw = n * this.boxW;
    this.atlasW = aw;
    this.atlas = new Uint8Array(aw * this.boxH);
    for (let col = 0; col < aw; col++) {
      for (let b = 0; b < bpc; b++) {
        const bits = data[off + col * bpc + b];
        if (!bits) continue;
        for (let bit = 0; bit < 8; bit++) {
          if (bits & (1 << bit)) this.atlas[((b << 3) + bit) * aw + col] = 1;
        }
      }
    }
  }

  /** Glyph index for a character. Never -1: unknown characters fold (é → e)
   * and whatever is left becomes '?', so a name is never silently shortened. */
  index(ch: string): number {
    const c = ch.codePointAt(0) ?? 0x3f;
    if (c >= this.first && c <= this.last) return c - this.first;
    const i = this.extra.get(c);
    if (i !== undefined) return i;
    const f = FOLD[ch];
    if (f !== undefined) return f.charCodeAt(0) - this.first;
    return 0x3f - this.first; // '?'
  }

  /** Every codepoint the font actually draws, in glyph-index order: the ASCII
   * run first, then the extras (the Turkish letters). The font tab on the demo
   * page enumerates the specimen from this rather than guessing the range. */
  chars(): number[] {
    const nAscii = this.last - this.first + 1;
    const out: number[] = [];
    for (let c = this.first; c <= this.last; c++) out.push(c);
    const extras: number[] = new Array(this.extra.size);
    for (const [cp, i] of this.extra) extras[i - nAscii] = cp;
    return out.concat(extras);
  }

  /** True when the font has a glyph of its own for `cp` — as opposed to
   * folding it (é → e) or falling back to '?'. */
  has(cp: number): boolean {
    return (cp >= this.first && cp <= this.last) || this.extra.has(cp);
  }

  /** Pixel width of a string — proportional, so 'IIII' and 'WWWW' differ. */
  measure(s: string): number {
    let w = 0;
    for (const ch of s) w += this.adv[this.index(ch)];
    return w;
  }

  /** The longest prefix of `s` that fits in `px` pixels. */
  fit(s: string, px: number): string {
    let w = 0;
    let n = 0;
    for (const ch of s) {
      w += this.adv[this.index(ch)];
      if (w > px) return [...s].slice(0, n).join("");
      n += 1;
    }
    return s;
  }
}

let cached: OledFont | null = null;
export function oledFont(): OledFont {
  if (!cached) cached = new OledFont(decodeBase64(FONT_B64));
  return cached;
}

/** The screen: one 1-byte-per-pixel buffer, exactly as the device's Bitmap. */
export class Fb {
  readonly W: number;
  readonly H: number;
  readonly CX: number;
  readonly font: OledFont;
  readonly px: Uint8Array;

  constructor(w = 128, h = 64, font = oledFont()) {
    this.W = w;
    this.H = h;
    this.CX = w >> 1;
    this.font = font;
    this.px = new Uint8Array(w * h);
  }

  clear() {
    this.px.fill(0);
  }

  rect(x: number, y: number, w: number, h: number, c = 1) {
    let x2 = x + w;
    let y2 = y + h;
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x2 > this.W) x2 = this.W;
    if (y2 > this.H) y2 = this.H;
    for (let yy = y; yy < y2; yy++) this.px.fill(c, yy * this.W + x, yy * this.W + x2);
  }

  hline(x: number, y: number, w: number, c = 1) {
    this.rect(x, y, w, 1, c);
  }

  vline(x: number, y: number, h: number, c = 1) {
    this.rect(x, y, 1, h, c);
  }

  /** Solid triangle — the menu's scroll arrows. */
  tri(x: number, y: number, w: number, h: number, down = true, c = 1) {
    for (let row = 0; row < h; row++) {
      const span = down ? w - 2 * row : 2 * row + 1;
      if (span <= 0) continue;
      this.rect(x + ((w - span) >> 1), y + row, span, 1, c);
    }
  }

  // --- v2 chrome ----------------------------------------------------------
  // Everything below mirrors firmware/mkyada/font.py primitive for primitive,
  // and is built on rect() there for the same reason it is here: the device
  // allocates nothing per frame. Keep the two in step — oled-draw.test.ts
  // compares the result against the firmware's own golden images.

  /** Whole screen to one value. clear() is fill(0); the boot screen is fill(1)
   * with everything carved out of it. */
  fill(c = 1) {
    this.px.fill(c);
  }

  /** Plain rectangle outline. */
  frame(x: number, y: number, w: number, h: number, c = 1) {
    this.hline(x, y, w, c);
    this.hline(x, y + h - 1, w, c);
    this.vline(x, y, h, c);
    this.vline(x + w - 1, y, h, c);
  }

  /** Filled block with its four corner pixels punched back to `bg` — at this
   * size that reads as a rounded block. */
  rfill(x: number, y: number, w: number, h: number, c = 1, bg = 0) {
    this.rect(x, y, w, h, c);
    this.rect(x, y, 1, 1, bg);
    this.rect(x + w - 1, y, 1, 1, bg);
    this.rect(x, y + h - 1, 1, 1, bg);
    this.rect(x + w - 1, y + h - 1, 1, 1, bg);
  }

  /** rfill's outline: edges drawn, corners left empty. */
  rframe(x: number, y: number, w: number, h: number, c = 1) {
    this.hline(x + 1, y, w - 2, c);
    this.hline(x + 1, y + h - 1, w - 2, c);
    this.vline(x, y + 1, h - 2, c);
    this.vline(x + w - 1, y + 1, h - 2, c);
  }

  /** 17x8 on/off switch. `c` is the drawing colour: a selected settings row is
   * an inverted block, so its switch has to be carved out of it (0). */
  sw(x: number, y: number, on: boolean, c = 1) {
    const b = c ? 0 : 1;
    if (on) {
      this.rfill(x, y, 17, 8, c, b);
      this.rect(x + 10, y + 2, 5, 4, b);
    } else {
      this.rframe(x, y, 17, 8, c);
      this.rect(x + 3, y + 2, 5, 4, c);
    }
  }

  /** Thin vertical scrollbar: dotted track one pixel to the right, a 3px wide
   * thumb over it. */
  sbarv(x: number, y: number, h: number, ty: number, th: number) {
    for (let yy = y; yy < y + h; yy += 2) this.rect(x + 1, yy, 1, 1);
    this.rect(x, ty, 3, th);
  }

  /** Segmented value bar: `n` segments, the first `f` filled, the rest showing
   * only their baseline. */
  segbar(x: number, y: number, w: number, h: number, n: number, f: number) {
    const step = Math.trunc((w + 1) / n);
    const sw = step - 1;
    for (let i = 0; i < n; i++) {
      const sx = x + i * step;
      if (i < f) this.rect(sx, y, sw, h);
      else this.rect(sx, y + h - 1, sw, 1);
    }
  }

  /** 8x8 icon from 8 packed bytes, one per row, bit 7 = leftmost pixel. */
  icon(x: number, y: number, data: Uint8Array | null | undefined, c = 1) {
    if (!data) return;
    for (let row = 0; row < 8; row++) {
      const bits = data[row];
      if (!bits) continue;
      let run = 0;
      for (let col = 0; col < 8; col++) {
        if (bits & (0x80 >> col)) {
          run += 1;
          continue;
        }
        if (run) {
          this.rect(x + col - run, y + row, run, 1, c);
          run = 0;
        }
      }
      if (run) this.rect(x + 8 - run, y + row, run, 1, c);
    }
  }

  /** Same icon at 2x — the dialog and alert screens. */
  icon2(x: number, y: number, data: Uint8Array | null | undefined, c = 1) {
    if (!data) return;
    for (let row = 0; row < 8; row++) {
      const bits = data[row];
      if (!bits) continue;
      let run = 0;
      for (let col = 0; col < 8; col++) {
        if (bits & (0x80 >> col)) {
          run += 1;
          continue;
        }
        if (run) {
          this.rect(x + (col - run) * 2, y + row * 2, run * 2, 2, c);
          run = 0;
        }
      }
      if (run) this.rect(x + (8 - run) * 2, y + row * 2, run * 2, 2, c);
    }
  }

  /** 50% checkerboard — the backdrop the saved/toast dialogs sit on. */
  dither() {
    for (let y = 0; y < this.H; y++) {
      for (let x = y & 1; x < this.W; x += 2) this.rect(x, y, 1, 1);
    }
  }

  /** Draw `s` with its box-left at x (anchor 0), centred (0.5) or right-
   * aligned (1). y is the cap-centre when vcenter, else the box top. */
  text(s: string, x: number, y: number, anchor = 0.5, invert = false, vcenter = true): number {
    if (!s) return x;
    const f = this.font;
    if (anchor) x -= Math.trunc(f.measure(s) * anchor);
    // rows 0..6 hold the caps; centring on the cap rather than the 8px box is
    // what keeps text optically level inside the 11px bars.
    if (vcenter) y -= 3;
    for (const ch of s) {
      const i = f.index(ch);
      const a = f.adv[i];
      if (x + a > 0 && x < this.W) {
        const w = x + f.boxW <= this.W ? f.boxW : this.W - x;
        for (let gy = 0; gy < f.boxH; gy++) {
          const dy = y + gy;
          if (dy < 0 || dy >= this.H) continue;
          for (let gx = 0; gx < w; gx++) {
            const lit = f.atlas[gy * f.atlasW + i * f.boxW + gx];
            // The device blits an inverted copy of the atlas with
            // skip_source_index=1, which lands glyph pixels as 0 and leaves
            // the background alone. Same result, one branch.
            if (invert) {
              if (!lit) continue;
              this.px[dy * this.W + x + gx] = 0;
            } else if (lit) {
              this.px[dy * this.W + x + gx] = 1;
            }
          }
        }
      }
      x += a;
    }
    return x;
  }

  /** Scaled text for the hero numbers, by expanding lit pixels.
   *
   * `c` is the drawing colour. The boot splash is an inverted field, so its
   * wordmark is carved out of it with c=0 rather than blitted onto it. */
  big(s: string, x: number, y: number, scale = 2, anchor = 0.5, c = 1): number {
    if (!s) return x;
    const f = this.font;
    if (anchor) x -= Math.trunc(f.measure(s) * scale * anchor);
    y -= Math.trunc((7 * scale) / 2);
    for (const ch of s) {
      const i = f.index(ch);
      for (let cy = 0; cy < f.boxH; cy++) {
        let run = 0;
        for (let cx = 0; cx < f.boxW; cx++) {
          if (f.atlas[cy * f.atlasW + i * f.boxW + cx]) {
            run += 1;
            continue;
          }
          if (run) {
            this.rect(x + (cx - run) * scale, y + cy * scale, run * scale, scale, c);
            run = 0;
          }
        }
        if (run) this.rect(x + (f.boxW - run) * scale, y + cy * scale, run * scale, scale, c);
      }
      x += f.adv[i] * scale;
    }
    return x;
  }

  /** ASCII picture, the format tests/golden/*.txt uses. */
  rows(): string[] {
    const out: string[] = [];
    for (let y = 0; y < this.H; y++) {
      let line = "";
      for (let x = 0; x < this.W; x++) line += this.px[y * this.W + x] ? "#" : ".";
      out.push(line);
    }
    return out;
  }
}

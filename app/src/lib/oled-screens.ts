// Every screen the Vision 6's SH1106 can show — the ONE JavaScript drawing of
// them.
//
// There used to be three: this file's ancestor in the app, a second copy inside
// docs/simulator.html, and a third inside the font viewer. They drifted, which
// is the failure mode that matters: a demo page that quietly stops matching the
// device is worse than no demo page, because people trust it. Now the demo page
// is built from this module (scripts/build-demo.mjs) and so is the app's editor
// preview, so a layout change lands in both at once or in neither.
//
// The remaining second implementation is deliberate and unavoidable:
// firmware/mkyada/oled.py, which runs on the board. It is held to this one by
// tests/golden/*.txt — the firmware renders them, oled-draw.test.ts demands the
// same pixels from here. So the two are checked against each other on every
// commit rather than trusted to stay in step.
//
// ── WHY THE NAMES LOOK LIKE PYTHON ────────────────────────────────────────
// The methods keep the firmware's names and argument order (show_grid, _bar9,
// _hdr9) instead of being renamed to camelCase. That is on purpose: the whole
// value of this file is that a reviewer can put it beside oled.py and diff it
// by eye. Idiomatic naming would cost that and buy nothing.
//
// ── COORDINATES ───────────────────────────────────────────────────────────
// Every y below is the TOP of the glyph box, which is how the design source
// anchors text. Fb.text treats y as the cap centre by default, so _txt/_hero
// convert once and the screens read exactly like oled.py, number for number.
// If a screen ever looks a few pixels off, that conversion is the first thing
// to check.

import { Fb, type OledFont } from "./oled-fb";
import { iconBytes } from "./oled-icons";
import { tr, upper } from "./oled-i18n";

export const BAR_H = 9; // inverted title strip
export const ROW_H = 13; // list row pitch
export const ROW_TOP = 12; // first list row
export const VIS = 4; // list rows that fit
export const SB_X = 125; // scrollbar column
export const SB_Y = 11;
export const SB_H = 52;
// Boot and firmware-update share one progress bar: same size, same place, so
// the two "the keypad is busy with itself" screens read as one thing.
export const PBAR_Y = 43;
export const PBAR_H = 8;
export const PBAR_FOOT = 53;
// Grid tiles. Columns are 41px with a 2px gutter, which is what leaves the
// dividers out of the picture entirely — a tile can clear its own box without
// ever touching its neighbour or the chrome.
export const TILE_X = [0, 43, 86] as const;
export const TILE_W = 41;
export const HERO_SCALE = 3;
// The overlay box behind the saved / toast dialogs.
export const DLG_Y = 10;
export const DLG_H = 44;

export const SPEED_MIN_T = 1;
export const SPEED_MAX_T = 100;

export type SettingsItem = {
  label: string;
  kind: "text" | "toggle" | "none";
  value?: string | boolean;
};
export type GridPage = { sel: number; n: number } | null;
export type BandState = { rec?: boolean; live?: boolean; blink?: boolean } | null;
export type KeytestState = { cnt: number[]; nav: number[]; enc: number; last: number };
export type ObsState = {
  rec?: boolean;
  live?: boolean;
  blink?: boolean;
  mic?: number;
  time?: string;
  scene?: string;
  hint?: string;
  keyNo?: number;
};

export function fmtSpeed(t: number): string {
  return `${(t / 10).toFixed(1)}x`;
}

export function fmtHero(t: number): string {
  const v = t / 10;
  return v >= 10 ? String(Math.trunc(v)) : v.toFixed(1);
}

export function fmtBytes(done: number, total: number): string {
  if (total) return `${(done / 1024).toFixed(1)} / ${(total / 1024).toFixed(1)} KB`;
  return `${(done / 1024).toFixed(1)} KB`;
}


export class OledScreens {
  readonly W = 128;
  readonly H = 64;
  readonly CX = 64;
  readonly fb: Fb;
  readonly font: OledFont;
  /** Printed in the boot splash's corner. */
  fw = "";

  constructor(fb: Fb = new Fb(128, 64)) {
    this.fb = fb;
    this.font = fb.font;
  }

  // --- coordinate helpers -------------------------------------------------
  /** Text with y = TOP of the glyph box. */
  private _txt(s: string, x: number, y: number, anchor = 0.5, invert = false) {
    this.fb.text(s, x, y, anchor, invert, false);
  }

  /** Scaled text with y = TOP of the glyph box.
   *
   * `fit` is the room the hero has, in SCREEN pixels. It is applied here rather
   * than at the call sites because it has to be measured against the SCALED
   * advance: fitting at scale 1 and drawing at 2x or 3x is how a long macro
   * name used to run off both edges of the glass instead of being cut. */
  private _hero(s: string, x: number, y: number, scale = 2, anchor = 0.5, c = 1, fit?: number) {
    const str = fit === undefined ? s : this.font.fit(String(s), Math.trunc(fit / scale));
    this.fb.big(str, x, y + Math.trunc((7 * scale) / 2), scale, anchor, c);
  }

  /** Position dots. The selected one is a 3x3 square, the rest single pixels —
   * three rects for the whole row instead of n circle objects. */
  private _dots(y: number, n: number, sel: number) {
    const x0 = this.CX - Math.trunc((n * 8 - 8) / 2) - 1;
    for (let i = 0; i < n; i++) {
      const x = x0 + i * 8;
      if (i === sel) this.fb.rect(x, y, 3, 3);
      else this.fb.rect(x + 1, y + 1, 1, 1);
    }
  }

  clear() {
    this.fb.clear();
  }

  /** Break a macro name into the (line1, line2) a grid cell shows.
   *
   * Splitting is by PIXELS, not characters. A fixed character count was wrong
   * in both directions: "IIIIIIIIII" left half the cell empty and "WWWWWWWWWW"
   * ran over its divider. */
  split_name(name: string, cols = 3): [string, string] {
    const f = this.font;
    const s = String(name ?? "").trim();
    const cell = Math.trunc(this.W / cols) - 2;
    if (f.measure(s) <= cell) return [s, ""];
    // Prefer breaking on a space, so "Stop recording" stacks as two words
    // rather than mid-word.
    const head = f.fit(s, cell);
    const cut = head.lastIndexOf(" ");
    if (cut > 0) return [s.slice(0, cut), f.fit(s.slice(cut + 1), cell)];
    return [head, f.fit(s.slice(head.length), cell)];
  }

  // --- chrome -------------------------------------------------------------
  /** The design's bar(): 9px inverted strip, title left, optional label right. */
  private _bar9(left: string, right?: string | null) {
    this.fb.rect(0, 0, this.W, BAR_H);
    this._txt(left, 2, 1, 0, true);
    if (right) this._txt(right, this.W - 2, 1, 1, true);
  }

  /** The design's hdr(): back chevron, title, hairline at y=9. The old bottom
   * bar is gone in this design, so the action / "hold" hint moved up here —
   * which is what buys the list its fourth row back at 13px pitch. */
  private _hdr9(title: string, hint?: string | null) {
    const f = this.font;
    this.fb.icon(1, 1, iconBytes("chevron-left"));
    let rw = 0;
    if (hint) {
      const s = f.fit(String(hint), 52);
      rw = f.measure(s) + 3;
      this._txt(s, this.W - 2, 1, 1);
    }
    this._txt(f.fit(String(title), 115 - rw), 11, 1, 0);
    this.fb.hline(0, 9, this.W);
  }

  /** The corner badge on the editors: a carved box with lit text. Its width
   * follows the text — the design's was a fixed 29px because it always said
   * "EDIT", and ours says SEC / SN / SPEED. */
  private _badge(s: string) {
    const f = this.font;
    const t = f.fit(String(s), 44);
    const w = f.measure(t) + 6;
    const x = this.W - 2 - w;
    this.fb.rfill(x, 1, w, 7, 0, 1);
    this._txt(t, x + 3, 1, 0);
  }

  /** The progress bar boot and update share. `c` is 0 on boot (an inverted
   * field, so it is carved) and 1 on update. */
  private _pbar(frac: number, c: number) {
    const p = Math.min(1, Math.max(0, frac));
    this.fb.frame(4, PBAR_Y, 120, PBAR_H, c);
    this.fb.rect(6, PBAR_Y + 2, Math.trunc(116 * p), PBAR_H - 4, c);
  }

  /** The dithered backdrop plus the rounded box both overlays sit in. */
  private _dialog(art: Uint8Array | null) {
    const y = DLG_Y;
    const h = DLG_H;
    this.fb.dither();
    this.fb.rfill(8, y, 112, h, 0);
    this.fb.rframe(8, y, 112, h, 1);
    this.fb.icon2(14, y + Math.trunc((h - 16) / 2), art);
  }

  // --- screens ------------------------------------------------------------
  /** Inverted splash: the whole panel lights and everything is carved out of
   * it. The phase line under the wordmark says which third of the boot we are
   * in. */
  show_boot(frac = 0) {
    const fb = this.fb;
    const p = Math.min(1, Math.max(0, frac));
    fb.fill(1);
    this._hero("MKYADA", this.CX, 11, 2, 0.5, 0);
    fb.hline(29, 29, 70, 0);
    const phase = p < 0.33 ? tr("boot_disp") : p < 0.66 ? tr("boot_cfg") : tr("boot_hid");
    this._txt(phase, this.CX, 34, 0.5, true);
    this._pbar(p, 0);
    this._txt("RP2040", 4, PBAR_FOOT, 0, true);
    if (this.fw) this._txt(this.fw, this.W - 4, PBAR_FOOT, 1, true);
  }

  /** Locked firmware-update screen. Where the design source showed a version
   * transition we show a byte counter instead: update_begin carries the total
   * size and nothing else, so a version line would be invented. */
  show_update(frac: number, restarting = false, done = 0, total = 0) {
    const fb = this.fb;
    const p = Math.min(1, Math.max(0, frac));
    this.clear();
    this._bar9(tr("update_title"));
    fb.rect(0, 12, this.W, 11);
    this._txt(tr("updating2"), this.CX, 14, 0.5, true);
    this._txt(restarting ? tr("restarting") : fmtBytes(done, total), this.CX, 29);
    this._pbar(p, 1);
    this._txt(tr("updating"), 4, PBAR_FOOT, 0);
    this._txt(`${Math.trunc(p * 100)}%`, this.W - 4, PBAR_FOOT, 1);
  }

  /** The app is reading or writing files and the keypad is held still for the
   * duration. Sibling of show_update; no progress bar, because a save is a run
   * of independent file transfers and nothing says how many. */
  show_transfer() {
    const fb = this.fb;
    this.clear();
    this._bar9(tr("transfer_title"));
    fb.rect(0, 12, this.W, 11);
    this._txt(tr("transfer2"), this.CX, 14, 0.5, true);
    fb.icon2(this.CX - 8, 30, iconBytes("upload"));
    this._txt(tr("transfer"), this.CX, 50, 0.5);
  }

  /** Settings list. The state used to be baked into the label ("Layer band:
   * on"); it is a column of its own now. */
  show_settings(title: string, items: SettingsItem[], sel: number) {
    const fb = this.fb;
    const f = this.font;
    const n = items.length;
    const top = sel >= VIS ? Math.min(sel - VIS + 1, Math.max(0, n - VIS)) : 0;
    this.clear();
    this._hdr9(title);
    for (let i = 0; i < VIS; i++) {
      const idx = top + i;
      if (idx >= n) break;
      const y = ROW_TOP + i * ROW_H;
      const on = idx === sel;
      const it = items[idx];
      fb.rect(0, y, 124, 12, on ? 1 : 0);
      this._txt(f.fit(it.label, 95), 4, y + 3, 0, on);
      if (it.kind === "toggle") fb.sw(103, y + 2, !!it.value, on ? 0 : 1);
      else if (it.kind === "text") this._txt(String(it.value ?? ""), 120, y + 3, 1, on);
    }
    const th = n ? Math.max(8, Math.trunc((SB_H * VIS + Math.trunc(n / 2)) / n)) : SB_H;
    const ty = SB_Y + Math.trunc(((SB_H - th) * top) / Math.max(1, n - VIS));
    fb.sbarv(SB_X, SB_Y, SB_H, ty, th);
  }

  /** Generic list — language, wheel menus, host lists. Same frame as the
   * settings list. The device's old ">" marker for the assigned option is a
   * tick icon on the right now, so the label stays left-aligned. */
  show_menu(
    title: string,
    items: string[],
    sel: number,
    marked: number | null = null,
    action?: string | null,
    hold?: string | null,
  ) {
    const fb = this.fb;
    const f = this.font;
    const n = items.length;
    const top = sel >= VIS ? Math.min(sel - VIS + 1, Math.max(0, n - VIS)) : 0;
    this.clear();
    this._hdr9(title, hold || action || null);
    const wide = marked === null || marked === undefined ? 115 : 95;
    const tick = iconBytes("check");
    for (let i = 0; i < VIS; i++) {
      const idx = top + i;
      if (idx >= n) break;
      const y = ROW_TOP + i * ROW_H;
      const on = idx === sel;
      fb.rect(0, y, 124, 12, on ? 1 : 0);
      this._txt(f.fit(String(items[idx]), wide), 4, y + 3, 0, on);
      if (idx === marked) fb.icon(112, y + 2, tick, on ? 0 : 1);
    }
    // The settings list is always full so it draws its bar unconditionally;
    // here a two-item language list must not show one.
    if (n > VIS) {
      const th = Math.max(8, Math.trunc((SB_H * VIS + Math.trunc(n / 2)) / n));
      const ty = SB_Y + Math.trunc(((SB_H - th) * top) / Math.max(1, n - VIS));
      fb.sbarv(SB_X, SB_Y, SB_H, ty, th);
    }
  }

  /** Speed editor: badged title, hero number, 15 segments, the range below. */
  show_speed(layerName: string, keyNo: number, t: number, lo = SPEED_MIN_T, hi = SPEED_MAX_T) {
    const fb = this.fb;
    this.clear();
    fb.rect(0, 0, this.W, BAR_H);
    fb.icon(1, 1, iconBytes("chevron-left"), 0);
    this._txt(`${upper(layerName)} > K${keyNo}`, 11, 1, 0, true);
    this._badge(upper(tr("speed")));
    this._hero(fmtHero(t), this.CX, 13, HERO_SCALE);
    fb.segbar(4, 38, 120, 10, 15, Math.max(1, Math.trunc((t * 15 + Math.trunc(hi / 2)) / hi)));
    this._txt(fmtHero(lo), 4, 52, 0);
    this._txt(tr("save"), this.CX, 52);
    this._txt(fmtHero(hi), this.W - 4, 52, 1);
  }

  /** Auto-return editor: hero + unit, a centre sight, and a notched ruler that
   * slides with the value. */
  show_timeout(sec: number, _lo: number, _hi: number) {
    const fb = this.fb;
    const f = this.font;
    this.clear();
    fb.rect(0, 0, this.W, BAR_H);
    fb.icon(1, 1, iconBytes("chevron-left"), 0);
    this._txt(tr("auto_return_title"), 11, 1, 0, true);
    const unit = tr("sec_unit");
    this._badge(unit);
    const bv = String(sec);
    const bw = f.measure(bv) * HERO_SCALE;
    const gx = Math.trunc((this.W - (bw + 4 + f.measure(unit))) / 2);
    this._hero(bv, gx, 13, HERO_SCALE, 0);
    this._txt(unit, gx + bw + 4, 27, 0);
    fb.rect(64, 39, 1, 1);
    fb.rect(63, 40, 3, 1);
    fb.rect(62, 41, 5, 1);
    const off = (sec * 2) % 18;
    const major = Math.trunc((sec * 2) / 18) * 3;
    for (let i = -1; i < 24; i++) {
      const x = 4 + i * 6 - off;
      if (x < 1 || x > 126) continue;
      const maj = (i + major) % 3 === 0;
      fb.vline(x, maj ? 44 : 48, maj ? 8 : 4);
    }
    fb.hline(0, 52, this.W);
    this._txt(tr("save"), this.CX, 55);
  }

  /** The grid's status band. Indicators are laid out right to left: page
   * position, a LIVE pill, then the blinking record dot with a STEADY label
   * beside it — the eye should not have to wait out the dark phase to read
   * "recording". The layer/profile text takes whatever is left. */
  private _grid_bar(band: string | null, page: GridPage, st: BandState) {
    const fb = this.fb;
    const f = this.font;
    fb.rect(0, 0, this.W, BAR_H);
    let rx = this.W - 2;
    if (page) {
      const s = `${page.sel + 1}/${page.n}`;
      this._txt(s, rx, 1, 1, true);
      rx -= f.measure(s) + 4;
    }
    if (st && st.live) {
      const lab = upper(tr("live_t"));
      const w = f.measure(lab) + 6;
      const x = rx - w + 1;
      fb.rfill(x, 1, w, 7, 0, 1);
      this._txt(lab, x + 3, 1, 0);
      rx = x - 3;
    }
    if (st && st.rec) {
      const lab = upper(tr("rec_t"));
      this._txt(lab, rx, 1, 1, true);
      rx -= f.measure(lab) + 3;
      if (st.blink) fb.rect(rx - 4, 3, 4, 4, 0);
      rx -= 7;
    }
    if (band) this._txt(f.fit(String(band), Math.max(0, rx - 3)), 2, 1, 0, true);
  }

  /** 3x2 macro grid. Rounded tiles with a 2px gutter, the selected one filled;
   * the action icon sits above the name.
   *
   * `page` turns on wheel paging: a dot row appears at y=60 and the tiles are
   * the design's 23px. Without it the dot row's pixels go back to the tiles. */
  show_grid(
    labels: [string, string][],
    active: number | null,
    invert = true,
    band: string | null = null,
    icons: (Uint8Array | null)[] | null = null,
    page: GridPage = null,
    st: BandState = null,
  ) {
    const fb = this.fb;
    const f = this.font;
    this.clear();
    const hasSt = !!(st && (st.rec || st.live));
    // The bar follows the BAND, not the paging. With the layer band off there
    // is nothing worth spending a 9px strip on, and the page counter goes with
    // it — the dot row already says which page you are on. The tiles take the
    // space instead, which is the whole point of turning the band off. A live
    // REC/LIVE marker still earns the strip on its own.
    const bar = !!band || hasSt;
    const top = bar ? 11 : 2;
    const bot = page ? 59 : 62; // the dot row owns 59..63
    const h = Math.trunc((bot - top - 1) / 2);
    const blockH = 2 * h + 1;
    const ytop = top + Math.trunc((bot - top - blockH) / 2);
    const pad = Math.trunc((h - 23) / 2);
    if (bar) this._grid_bar(band, band ? page : null, st);
    for (let k = 0; k < 6; k++) {
      const x = TILE_X[k % 3];
      const y = ytop + Math.trunc(k / 3) * (h + 1);
      const on = k === active && invert;
      const art = icons ? icons[k] : null;
      const pair = labels[k] || ["", ""];
      if (on) fb.rfill(x, y, TILE_W, h, 1, 0);
      else fb.rframe(x, y, TILE_W, h, 1);
      const mid = x + 20;
      if (pair[1]) {
        // The design's tiles hold one-line constants; ours hold user macro
        // names. An icon plus two lines does not fit in 23px, so a name that
        // needs two lines drops the icon and stays whole — the other way round
        // would cut the name.
        this._txt(f.fit(pair[0], 37), mid, y + 4 + pad, 0.5, on);
        this._txt(f.fit(pair[1], 37), mid, y + 12 + pad, 0.5, on);
      } else if (art) {
        fb.icon(x + 17, y + 4 + pad, art, on ? 0 : 1);
        this._txt(f.fit(pair[0], 37), mid, y + 14 + pad, 0.5, on);
      } else {
        this._txt(f.fit(pair[0], 37), mid, y + 8 + pad, 0.5, on);
      }
    }
    if (page) this._dots(60, page.n, page.sel);
  }

  /** Layer picker: arrows either side, a 2x letter, the layer's name under it
   * when it has one, position dots at the bottom.
   *
   * The design source puts a 2x icon above the letter; it is dropped here
   * because on this device the letter IS the layer — the icon added no
   * information. The hero sits at the same y on every page so neither it nor
   * the arrows jump as the wheel moves through them. */
  show_home(
    pos: number,
    layerCount: number,
    layerNames: (string | null)[],
    nick?: string | null,
    active = false,
  ) {
    const fb = this.fb;
    this.clear();
    const n = layerCount + 1;
    this._bar9(tr("menu_t"), `${pos + 1}/${n}`);
    const isSet = pos >= layerCount;
    const hero = isSet ? tr("settings") : upper(layerNames[pos] ?? "");
    const sub = isSet ? "" : nick || (active ? upper(tr("on")) : "");
    if (pos > 0) fb.icon(1, 26, iconBytes("chevron-left"));
    if (!isSet) fb.icon(this.W - 9, 26, iconBytes("chevron-right"));
    // The arrows own the outer 11px on each side; the hero gets the rest.
    this._hero(hero, this.CX, 23, 2, 0.5, 1, 106);
    if (sub) this._txt(sub, this.CX, 42);
    this._dots(57, n, pos);
  }

  /** All six keys at once with a press counter each, wheel and module buttons
   * underneath. The old screen showed one control at a time, so finding the
   * silent key meant pressing them in turn. */
  show_keytest(s: KeytestState) {
    const fb = this.fb;
    this.clear();
    this._bar9(tr("keys_test"), tr("hold_exit"));
    for (let k = 0; k < 6; k++) {
      const x = TILE_X[k % 3];
      const y = 11 + Math.trunc(k / 3) * 16;
      const on = s.last === k;
      if (on) fb.rfill(x, y, TILE_W, 15, 1, 0);
      else fb.rframe(x, y, TILE_W, 15, 1);
      this._txt(`K${k + 1}`, x + 3, y + 4, 0, on);
      this._txt(String(s.cnt[k]), x + 38, y + 4, 1, on);
    }
    fb.hline(0, 44, this.W);
    this._txt(`ENC ${s.enc >= 0 ? "+" : ""}${s.enc}`, 3, 46, 0);
    this._txt(`PSH ${s.nav[0]}`, this.W - 2, 46, 1);
    this._txt(`BACK ${s.nav[1]}`, 3, 55, 0);
    this._txt(`CONFIRM ${s.nav[2]}`, this.W - 2, 55, 1);
  }

  /** Every pixel lit. A dead column or a stuck row is invisible on a normal
   * screen — most of it is dark anyway — but obvious against a solid field.
   * Any button leaves, so there is no way to get stuck here. */
  show_pixels() {
    this.fb.fill(1);
  }

  /** Device info: a 9px title over label/value rows at 10px pitch. */
  show_about(rows: [string, string][]) {
    this.clear();
    for (let i = 0; i < rows.length && i < 5; i++) {
      const y = 11 + i * 10;
      this._txt(rows[i][0], 3, y + 2, 0);
      this._txt(this.font.fit(String(rows[i][1]), 86), this.W - 2, y + 2, 1);
    }
    this._bar9(tr("about_title"));
  }

  show_saved(layerName: string, keyNo: number, t: number) {
    this._dialog(iconBytes("check"));
    this._hero(upper(tr("save")), 34, 19, 2, 0, 1, 90);
    this._txt(
      this.font.fit(`${upper(layerName)} > K${keyNo}  ${fmtSpeed(t)}`, 84),
      34,
      36,
      0,
    );
  }

  /** Same box, but a toast has three pieces and our glyph box is a row taller
   * than the design's — a 2x title plus two lines does not fit, so all three
   * are one scale, at an even 11px pitch. */
  show_toast(title: string, line1 = "", line2 = "", ok = false) {
    const f = this.font;
    this._dialog(iconBytes(ok ? "check" : "warning"));
    this._txt(f.fit(title, 84), 34, 18, 0);
    if (line1) this._txt(f.fit(line1, 84), 34, 29, 0);
    if (line2) this._txt(f.fit(line2, 84), 34, 40, 0);
  }

  /** Action card for the wheel menu: 9px bar, a 2x hero, an optional status
   * line, and the design's plain hint row instead of a filled bar. */
  show_card(title: string, big: string, line?: string | null, hint?: string | null) {
    const f = this.font;
    this.clear();
    this._bar9(title);
    const hy = line ? 20 : 25;
    this._hero(String(big ?? ""), this.CX, hy, 2, 0.5, 1, 124);
    if (line) this._txt(f.fit(String(line), 124), this.CX, 38);
    if (hint) this._txt(f.fit(String(hint), 124), this.CX, 56);
  }

  /** Host-driven slider — the speed editor's frame. No min/max labels: the
   * protocol does not carry them for a slider. */
  show_adjust(title: string, hero: string, frac: number, action?: string | null) {
    const fb = this.fb;
    const f = this.font;
    const p = Math.max(0, Math.min(1, frac));
    this.clear();
    fb.rect(0, 0, this.W, BAR_H);
    fb.icon(1, 1, iconBytes("chevron-left"), 0);
    this._txt(f.fit(String(title), 80), 11, 1, 0, true);
    if (action) this._badge(upper(action));
    this._hero(String(hero), this.CX, 13, HERO_SCALE, 0.5, 1, 124);
    fb.segbar(4, 38, 120, 10, 15, Math.max(1, Math.trunc(p * 15 + 0.5)));
    this._txt(tr("back"), 4, 52, 0);
    this._txt(`${Math.trunc(p * 100 + 0.5)}%`, this.W - 4, 52, 1);
  }

  /** OBS record card. The bar is the design's recorder strip: a blinking dot
   * with a steady REC beside it on the left, the key on the right. */
  show_obsrec(o: ObsState) {
    const fb = this.fb;
    const f = this.font;
    this.clear();
    fb.rect(0, 0, this.W, BAR_H);
    if (o.rec) {
      if (o.blink) fb.rect(3, 3, 4, 4, 0);
      this._txt(upper(tr("rec_t")), 10, 1, 0, true);
    } else {
      this._txt(upper(tr("idle_t")), 3, 1, 0, true);
    }
    if (o.keyNo) this._txt(`${upper(tr("key_t"))} ${o.keyNo}`, this.W - 2, 1, 1, true);
    this._hero(String(o.time || "00:00"), this.CX, 16, 2, 0.5, 1, 124);
    if (o.scene) this._txt(f.fit(String(o.scene), 124), this.CX, 36);
    if (o.hint) this._txt(f.fit(String(o.hint), 124), this.CX, 56);
  }

  /** OBS status screen: a state chip top right, the elapsed time, the scene as
   * a pill and the mic level as segments. The design source ends with a
   * CPU / DROP / FPS row; we do not have those numbers, so that row carries
   * the action hint instead. */
  show_obs(o: ObsState) {
    const fb = this.fb;
    const f = this.font;
    this.clear();
    fb.rect(0, 0, this.W, BAR_H);
    this._txt("OBS", 2, 1, 0, true);
    const rec = !!o.rec;
    const lab = rec ? upper(tr("rec_t")) : o.live ? upper(tr("live_t")) : upper(tr("idle_t"));
    const dot = rec ? 5 : 0;
    const bw = f.measure(lab) + 6 + dot;
    const bx = this.W - 2 - bw;
    fb.rfill(bx, 1, bw, 7, 0, 1);
    if (rec && o.blink) fb.rect(bx + 3, 3, 3, 3);
    this._txt(lab, bx + 3 + dot, 1, 0);
    this._hero(String(o.time || "00:00"), this.CX, 12, 2, 0.5, 1, 124);
    // Turkish labels are wider, so the pill and the segment bar start after the
    // label instead of at the design's fixed x.
    const sl = upper(tr("scene_t"));
    const sx = Math.max(38, 2 + f.measure(sl) + 4);
    this._txt(sl, 2, 30, 0);
    const sn = f.fit(String(o.scene ?? ""), this.W - sx - 6);
    fb.rfill(sx, 29, f.measure(sn) + 6, 9, 1);
    this._txt(sn, sx + 3, 30, 0, true);
    const ml = upper(tr("mic_t"));
    const mx = Math.max(24, 2 + f.measure(ml) + 4);
    this._txt(ml, 2, 42, 0);
    fb.segbar(mx, 42, this.W - 6 - mx, 7, 14, Math.max(0, Math.trunc((o.mic ?? 0) * 14 / 100 + 0.5)));
    fb.hline(0, 51, this.W);
    if (o.hint) this._txt(f.fit(String(o.hint), 124), this.CX, 54);
  }

  /** The design's fault screen: a 2x warning icon with two lines beside it.
   * Theirs sits high because an error code and a retry line follow; we have
   * neither, so the block is centred between bar and bottom. */
  private _alert(title: string, l1: string, l2?: string | null, art?: Uint8Array | null) {
    this.clear();
    this._bar9(title);
    this.fb.icon2(6, 27, art ?? iconBytes("warning"));
    this._txt(this.font.fit(String(l1 ?? ""), 96), 28, 29, 0);
    if (l2) this._txt(this.font.fit(String(l2), 96), 28, 39, 0);
  }

  /** The menu module could not load. Keys and serial still work; show why
   * instead of leaving the boot splash frozen, which reads as a brick. */
  show_headless() {
    this._alert("MKYADA", tr("menu_fail"), tr("menu_fail_hint"));
  }

  show_error(msg: string) {
    const s = String(msg);
    const head = this.font.fit(s, 96);
    this._alert(upper(tr("err_title")), head, s.slice(head.length) || null);
  }

  /** Host mode with no key names yet: the app drives the menu but has not said
   * what the keys are. */
  show_host() {
    this.clear();
    this._bar9("MKYADA");
    this._hero("HOST", this.CX, 22, 2);
    this._txt(this.font.fit(tr("host"), 124), this.CX, 44);
  }

  /** The framebuffer as an ASCII picture — the format tests/golden/*.txt uses. */
  rows(): string[] {
    return this.fb.rows();
  }
}

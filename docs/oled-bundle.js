/* OLED_BUNDLE_BEGIN — ÜRETİLMİŞTİR, elle düzenlemeyin.
   Kaynak: app/src/lib/oled-bundle.ts (+ oled-fb / oled-screens / oled-icons /
           oled-i18n / oled-font — uygulamanın kullandığı modüllerin aynısı)
   Üreten: node scripts/build-demo.mjs

   Bu sayfa ile uygulama aynı çizim kodunu çalıştırır; bir ekran burada
   düzelip orada bozuk kalamaz. Cihazdaki Python uygulamasıyla arasındaki
   uyum da tests/golden/*.txt üzerinden her commit'te denetlenir. */
"use strict";
var MKOLED = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // app/src/lib/oled-bundle.ts
  var oled_bundle_exports = {};
  __export(oled_bundle_exports, {
    BAR_H: () => BAR_H,
    DEFAULT_LANG: () => DEFAULT_LANG,
    DLG_H: () => DLG_H,
    DLG_Y: () => DLG_Y,
    Fb: () => Fb,
    HERO_SCALE: () => HERO_SCALE,
    ICON_CATEGORIES: () => ICON_CATEGORIES,
    ICON_NAMES: () => ICON_NAMES,
    LANGS: () => LANGS,
    LANG_DESC: () => LANG_DESC,
    OledFont: () => OledFont,
    OledScreens: () => OledScreens,
    PBAR_FOOT: () => PBAR_FOOT,
    PBAR_H: () => PBAR_H,
    PBAR_Y: () => PBAR_Y,
    ROW_H: () => ROW_H,
    ROW_TOP: () => ROW_TOP,
    SB_H: () => SB_H,
    SB_X: () => SB_X,
    SB_Y: () => SB_Y,
    SPEED_MAX_T: () => SPEED_MAX_T,
    SPEED_MIN_T: () => SPEED_MIN_T,
    STRINGS: () => STRINGS,
    TILE_W: () => TILE_W,
    TILE_X: () => TILE_X,
    VIS: () => VIS,
    drawIconSwatch: () => drawIconSwatch,
    fmtBytes: () => fmtBytes,
    fmtHero: () => fmtHero,
    fmtSpeed: () => fmtSpeed,
    getLang: () => getLang,
    iconBytes: () => iconBytes,
    oledFont: () => oledFont,
    paintFb: () => paintFb,
    setLang: () => setLang,
    tr: () => tr
  });

  // app/src/lib/oled-font.ts
  var FONT_B64 = "TUtGMgUIIF8RAAMCBAUFBgUCAwMEBAMEAgUFBAUFBQUFBQUFAgMEBQQFBQUFBQUFBQUFBAUFBQYFBQUFBQUGBQYGBgYFAwUDBAUDBAQEBAQEBAQCAwQCBgQEBAQEBAQEBAYEBAQEAgQFBQUEBQUFBAQCBAQEBQQGBgbHAB4BMAHWAF4B3ADnAB8BMQH2AF8B/ADPJbglEyeyJbwlAAAAAABfAAAAAAMAAwAAFH8UfwAkKn8SAAMzCGZhNklZZgADAAAAAD5BAAAAQT4AAAAqHCoAAAgcCAAAgGAAAAAICAgAAEAAAAAAYBAMAwA+SUU+AEJ/QAAAYlFJRgAhSU0zAAwKfwgAJ0VFOQA+SUkyAAFxDQMANklJNgAmSUk+AEQAAAAAgGQAAAAIFCIAABQUFBQAIhQIAAACUQkGAD5BTS4AfgkJfgB/SUk2AD5BQSIAf0FBPgB/SUlBAH8JCQEAPkFJegB/CAh/AEF/QQAAIEBBPwB/DBJhAH9AQEAAfwIMAn9/Bhh/AD5BQT4AfwkJBgA+QXFeAH8JGWYARklJMQABAX8BAT9AQD8ADzBAMA9/IBggf2MUCBRjAwR4BANxSUVDAH9BAAAAAwwQYABBfwAAAAIBAgAAgICAgAABAgAAADRUeAAAf0Q4AAA4REQAADhEfwAAOFRYAAAEfgUAAJikfAAAfwR4AAB9AAAAAIB9AAAAfxhkAAB/AAAAAHwEeAR4fAR4AAA4RDgAAPwkGAAAGCT8AAB8CAQAAEhUJAAABD9EAAA8QHwAADxAPAAAfCAQIHxsEGwAAJygfAAAZFRMAAAIf0EAAH8AAAAAQX8IAAAIBAgEAD5BwSIAOEVVcABEfUQAADlERDkARknJMQA9QEA9ADjERAAAmaV9AAB8AAAAADlEOQAASNQkAAA9QH0AABg8PBgAPhwIAAAQIEAwDBAYHBgQBAwcDAQ=";

  // app/src/lib/oled-fb.ts
  var FOLD = {
    á: "a",
    à: "a",
    â: "a",
    ä: "a",
    å: "a",
    ã: "a",
    é: "e",
    è: "e",
    ê: "e",
    ë: "e",
    í: "i",
    ì: "i",
    î: "i",
    ï: "i",
    ó: "o",
    ò: "o",
    ô: "o",
    õ: "o",
    ú: "u",
    ù: "u",
    û: "u",
    ñ: "n",
    ý: "y",
    ÿ: "y",
    æ: "a",
    ø: "o",
    ß: "s",
    Á: "A",
    À: "A",
    Â: "A",
    Ä: "A",
    Å: "A",
    Ã: "A",
    É: "E",
    È: "E",
    Ê: "E",
    Ë: "E",
    Í: "I",
    Ì: "I",
    Î: "I",
    Ï: "I",
    Ó: "O",
    Ò: "O",
    Ô: "O",
    Õ: "O",
    Ú: "U",
    Ù: "U",
    Û: "U",
    Ñ: "N",
    Æ: "A",
    Ø: "O",
    "–": "-",
    "—": "-",
    "‘": "'",
    "’": "'",
    "“": '"',
    "”": '"',
    "…": "."
  };
  function decodeBase64(b64) {
    if (typeof atob === "function") {
      const s = atob(b64);
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  var OledFont = class {
    constructor(data) {
      __publicField(this, "boxW");
      __publicField(this, "boxH");
      __publicField(this, "first");
      __publicField(this, "last");
      __publicField(this, "adv");
      /** atlas[y * atlasW + x] — 1 where a glyph pixel is lit. */
      __publicField(this, "atlas");
      __publicField(this, "atlasW");
      __publicField(this, "extra", /* @__PURE__ */ new Map());
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
        this.extra.set(data[off] | data[off + 1] << 8, nAscii + i);
        off += 2;
      }
      const bpc = this.boxH >> 3;
      const aw = n * this.boxW;
      this.atlasW = aw;
      this.atlas = new Uint8Array(aw * this.boxH);
      for (let col = 0; col < aw; col++) {
        for (let b = 0; b < bpc; b++) {
          const bits = data[off + col * bpc + b];
          if (!bits) continue;
          for (let bit = 0; bit < 8; bit++) {
            if (bits & 1 << bit) this.atlas[((b << 3) + bit) * aw + col] = 1;
          }
        }
      }
    }
    /** Glyph index for a character. Never -1: unknown characters fold (é → e)
     * and whatever is left becomes '?', so a name is never silently shortened. */
    index(ch) {
      const c = ch.codePointAt(0) ?? 63;
      if (c >= this.first && c <= this.last) return c - this.first;
      const i = this.extra.get(c);
      if (i !== void 0) return i;
      const f = FOLD[ch];
      if (f !== void 0) return f.charCodeAt(0) - this.first;
      return 63 - this.first;
    }
    /** Every codepoint the font actually draws, in glyph-index order: the ASCII
     * run first, then the extras (the Turkish letters). The font tab on the demo
     * page enumerates the specimen from this rather than guessing the range. */
    chars() {
      const nAscii = this.last - this.first + 1;
      const out = [];
      for (let c = this.first; c <= this.last; c++) out.push(c);
      const extras = new Array(this.extra.size);
      for (const [cp, i] of this.extra) extras[i - nAscii] = cp;
      return out.concat(extras);
    }
    /** True when the font has a glyph of its own for `cp` — as opposed to
     * folding it (é → e) or falling back to '?'. */
    has(cp) {
      return cp >= this.first && cp <= this.last || this.extra.has(cp);
    }
    /** Pixel width of a string — proportional, so 'IIII' and 'WWWW' differ. */
    measure(s) {
      let w = 0;
      for (const ch of s) w += this.adv[this.index(ch)];
      return w;
    }
    /** The longest prefix of `s` that fits in `px` pixels. */
    fit(s, px) {
      let w = 0;
      let n = 0;
      for (const ch of s) {
        w += this.adv[this.index(ch)];
        if (w > px) return [...s].slice(0, n).join("");
        n += 1;
      }
      return s;
    }
  };
  var cached = null;
  function oledFont() {
    if (!cached) cached = new OledFont(decodeBase64(FONT_B64));
    return cached;
  }
  var Fb = class {
    constructor(w = 128, h = 64, font = oledFont()) {
      __publicField(this, "W");
      __publicField(this, "H");
      __publicField(this, "CX");
      __publicField(this, "font");
      __publicField(this, "px");
      this.W = w;
      this.H = h;
      this.CX = w >> 1;
      this.font = font;
      this.px = new Uint8Array(w * h);
    }
    clear() {
      this.px.fill(0);
    }
    rect(x, y, w, h, c = 1) {
      let x2 = x + w;
      let y2 = y + h;
      if (x < 0) x = 0;
      if (y < 0) y = 0;
      if (x2 > this.W) x2 = this.W;
      if (y2 > this.H) y2 = this.H;
      for (let yy = y; yy < y2; yy++) this.px.fill(c, yy * this.W + x, yy * this.W + x2);
    }
    hline(x, y, w, c = 1) {
      this.rect(x, y, w, 1, c);
    }
    vline(x, y, h, c = 1) {
      this.rect(x, y, 1, h, c);
    }
    /** Solid triangle — the menu's scroll arrows. */
    tri(x, y, w, h, down = true, c = 1) {
      for (let row = 0; row < h; row++) {
        const span = down ? w - 2 * row : 2 * row + 1;
        if (span <= 0) continue;
        this.rect(x + (w - span >> 1), y + row, span, 1, c);
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
    frame(x, y, w, h, c = 1) {
      this.hline(x, y, w, c);
      this.hline(x, y + h - 1, w, c);
      this.vline(x, y, h, c);
      this.vline(x + w - 1, y, h, c);
    }
    /** Filled block with its four corner pixels punched back to `bg` — at this
     * size that reads as a rounded block. */
    rfill(x, y, w, h, c = 1, bg = 0) {
      this.rect(x, y, w, h, c);
      this.rect(x, y, 1, 1, bg);
      this.rect(x + w - 1, y, 1, 1, bg);
      this.rect(x, y + h - 1, 1, 1, bg);
      this.rect(x + w - 1, y + h - 1, 1, 1, bg);
    }
    /** rfill's outline: edges drawn, corners left empty. */
    rframe(x, y, w, h, c = 1) {
      this.hline(x + 1, y, w - 2, c);
      this.hline(x + 1, y + h - 1, w - 2, c);
      this.vline(x, y + 1, h - 2, c);
      this.vline(x + w - 1, y + 1, h - 2, c);
    }
    /** 17x8 on/off switch. `c` is the drawing colour: a selected settings row is
     * an inverted block, so its switch has to be carved out of it (0). */
    sw(x, y, on, c = 1) {
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
    sbarv(x, y, h, ty, th) {
      for (let yy = y; yy < y + h; yy += 2) this.rect(x + 1, yy, 1, 1);
      this.rect(x, ty, 3, th);
    }
    /** Segmented value bar: `n` segments, the first `f` filled, the rest showing
     * only their baseline. */
    segbar(x, y, w, h, n, f) {
      const step = Math.trunc((w + 1) / n);
      const sw = step - 1;
      for (let i = 0; i < n; i++) {
        const sx = x + i * step;
        if (i < f) this.rect(sx, y, sw, h);
        else this.rect(sx, y + h - 1, sw, 1);
      }
    }
    /** 8x8 icon from 8 packed bytes, one per row, bit 7 = leftmost pixel. */
    icon(x, y, data, c = 1) {
      if (!data) return;
      for (let row = 0; row < 8; row++) {
        const bits = data[row];
        if (!bits) continue;
        let run = 0;
        for (let col = 0; col < 8; col++) {
          if (bits & 128 >> col) {
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
    icon2(x, y, data, c = 1) {
      if (!data) return;
      for (let row = 0; row < 8; row++) {
        const bits = data[row];
        if (!bits) continue;
        let run = 0;
        for (let col = 0; col < 8; col++) {
          if (bits & 128 >> col) {
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
    text(s, x, y, anchor = 0.5, invert = false, vcenter = true) {
      if (!s) return x;
      const f = this.font;
      if (anchor) x -= Math.trunc(f.measure(s) * anchor);
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
    big(s, x, y, scale = 2, anchor = 0.5, c = 1) {
      if (!s) return x;
      const f = this.font;
      if (anchor) x -= Math.trunc(f.measure(s) * scale * anchor);
      y -= Math.trunc(7 * scale / 2);
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
    rows() {
      const out = [];
      for (let y = 0; y < this.H; y++) {
        let line = "";
        for (let x = 0; x < this.W; x++) line += this.px[y * this.W + x] ? "#" : ".";
        out.push(line);
      }
      return out;
    }
  };

  // app/src/lib/oled-icons.ts
  var ICON_CATEGORIES = [
    ["navigasyon", ["arrow-up", "arrow-down", "arrow-left", "arrow-right", "chevron-up", "chevron-down", "chevron-left", "chevron-right", "home", "back", "refresh", "external", "expand", "collapse"]],
    ["medya", ["play", "pause", "stop", "record", "next", "prev", "forward", "rewind", "shuffle", "repeat", "repeat-one", "eject", "volume", "mute", "volume-up", "volume-down"]],
    ["ses", ["mic", "mic-off", "headphones", "speaker", "wave", "note", "music", "equalizer", "metronome", "podcast"]],
    ["video ve yayın", ["camera", "webcam", "film", "clapper", "live", "broadcast", "scene", "monitor", "screen-share", "tv", "stream"]],
    ["düzenleme", ["copy", "paste", "cut", "undo", "redo", "save", "trash", "duplicate", "select-all", "replace", "new", "open", "rename", "edit"]],
    ["metin", ["bold", "italic", "underline", "strikethrough", "align-left", "align-center", "align-right", "list", "indent", "quote", "link", "code", "text"]],
    ["dosya", ["file", "folder", "folder-open", "archive", "download", "upload", "cloud", "cloud-up", "cloud-down", "print", "disk"]],
    ["sistem", ["power", "restart", "sleep", "settings", "wrench", "tools", "cpu", "memory", "usb", "battery", "plug", "bug", "terminal", "database", "server"]],
    ["ağ", ["globe", "wifi", "signal", "share", "send", "mail", "chat", "bell", "at", "user", "users"]],
    ["durum", ["check", "cross", "warning", "info", "question", "plus", "minus", "star", "heart", "flag", "lock", "unlock", "eye", "eye-off", "shield", "tag"]],
    ["zaman", ["clock", "timer", "alarm", "calendar", "hourglass", "history"]],
    ["pencere ve düzen", ["window", "windows", "tabs", "split", "layout", "grid", "layers", "pin", "minimize", "maximize", "close", "fullscreen"]],
    ["grafik ve tasarım", ["brush", "pen", "pencil", "eraser", "palette", "crop", "zoom-in", "zoom-out", "move", "rotate", "ruler", "shapes"]],
    ["oyun ve akış", ["gamepad", "dice", "target", "trophy", "rocket", "lightning", "fire", "sparkle"]],
    ["çeşitli", ["search", "filter", "sort", "bookmark", "key", "gift", "coffee", "bulb", "magnet", "map-pin", "calculator", "chart", "percent", "hash", "keyboard", "mouse", "scroll-v", "scroll-h", "sequence", "webhook", "macro"]],
    ["profil ve ekran", ["brightness-low", "brightness-high", "contrast", "screen-lock", "profile-switch", "cube", "bezier", "workspace"]],
    ["3d ve cad", ["sketch", "extrude", "revolve", "fillet", "chamfer", "split-body", "view-top", "view-front", "view-side", "view-iso", "hide-body", "show-body", "measure-dist", "measure-angle", "constraint", "origin"]],
    ["vektorel cizim", ["pen-tool", "select-arrow", "select-direct", "node-add", "node-remove", "path-union", "path-subtract", "path-intersect", "path-exclude", "align-l", "align-c", "align-r", "align-t", "align-b", "distribute-h", "distribute-v", "layer-lock", "mask", "artboard"]],
    ["pencere ve sistem", ["clipboard", "clipboard-history", "snap-left", "snap-right", "snap-max", "task-manager", "app-switch", "always-on-top", "screen-record"]],
    ["3d baski", ["printer-3d", "preheat", "auto-home", "bed-level", "filament", "nozzle", "fan", "print-pause"]],
    ["eglence ve retro", ["ghost", "pacman", "invader", "invader2", "alien", "skull", "robot", "mushroom", "sword", "coin", "bomb", "ufo", "cat", "smiley", "joystick", "arcade", "tetromino", "crown", "potion", "chest"]]
  ];
  var ICON_NAMES = [
    "arrow-up",
    "arrow-down",
    "arrow-left",
    "arrow-right",
    "chevron-up",
    "chevron-down",
    "chevron-left",
    "chevron-right",
    "home",
    "back",
    "refresh",
    "external",
    "expand",
    "collapse",
    "play",
    "pause",
    "stop",
    "record",
    "next",
    "prev",
    "forward",
    "rewind",
    "shuffle",
    "repeat",
    "repeat-one",
    "eject",
    "volume",
    "mute",
    "volume-up",
    "volume-down",
    "mic",
    "mic-off",
    "headphones",
    "speaker",
    "wave",
    "note",
    "music",
    "equalizer",
    "metronome",
    "podcast",
    "camera",
    "webcam",
    "film",
    "clapper",
    "live",
    "broadcast",
    "scene",
    "monitor",
    "screen-share",
    "tv",
    "stream",
    "copy",
    "paste",
    "cut",
    "undo",
    "redo",
    "save",
    "trash",
    "duplicate",
    "select-all",
    "replace",
    "new",
    "open",
    "rename",
    "edit",
    "bold",
    "italic",
    "underline",
    "strikethrough",
    "align-left",
    "align-center",
    "align-right",
    "list",
    "indent",
    "quote",
    "link",
    "code",
    "text",
    "file",
    "folder",
    "folder-open",
    "archive",
    "download",
    "upload",
    "cloud",
    "cloud-up",
    "cloud-down",
    "print",
    "disk",
    "power",
    "restart",
    "sleep",
    "settings",
    "wrench",
    "tools",
    "cpu",
    "memory",
    "usb",
    "battery",
    "plug",
    "bug",
    "terminal",
    "database",
    "server",
    "globe",
    "wifi",
    "signal",
    "share",
    "send",
    "mail",
    "chat",
    "bell",
    "at",
    "user",
    "users",
    "check",
    "cross",
    "warning",
    "info",
    "question",
    "plus",
    "minus",
    "star",
    "heart",
    "flag",
    "lock",
    "unlock",
    "eye",
    "eye-off",
    "shield",
    "tag",
    "clock",
    "timer",
    "alarm",
    "calendar",
    "hourglass",
    "history",
    "window",
    "windows",
    "tabs",
    "split",
    "layout",
    "grid",
    "layers",
    "pin",
    "minimize",
    "maximize",
    "close",
    "fullscreen",
    "brush",
    "pen",
    "pencil",
    "eraser",
    "palette",
    "crop",
    "zoom-in",
    "zoom-out",
    "move",
    "rotate",
    "ruler",
    "shapes",
    "gamepad",
    "dice",
    "target",
    "trophy",
    "rocket",
    "lightning",
    "fire",
    "sparkle",
    "search",
    "filter",
    "sort",
    "bookmark",
    "key",
    "gift",
    "coffee",
    "bulb",
    "magnet",
    "map-pin",
    "calculator",
    "chart",
    "percent",
    "hash",
    "keyboard",
    "mouse",
    "scroll-v",
    "scroll-h",
    "sequence",
    "webhook",
    "macro",
    "brightness-low",
    "brightness-high",
    "contrast",
    "screen-lock",
    "profile-switch",
    "cube",
    "bezier",
    "workspace",
    "sketch",
    "extrude",
    "revolve",
    "fillet",
    "chamfer",
    "split-body",
    "view-top",
    "view-front",
    "view-side",
    "view-iso",
    "hide-body",
    "show-body",
    "measure-dist",
    "measure-angle",
    "constraint",
    "origin",
    "pen-tool",
    "select-arrow",
    "select-direct",
    "node-add",
    "node-remove",
    "path-union",
    "path-subtract",
    "path-intersect",
    "path-exclude",
    "align-l",
    "align-c",
    "align-r",
    "align-t",
    "align-b",
    "distribute-h",
    "distribute-v",
    "layer-lock",
    "mask",
    "artboard",
    "clipboard",
    "clipboard-history",
    "snap-left",
    "snap-right",
    "snap-max",
    "task-manager",
    "app-switch",
    "always-on-top",
    "screen-record",
    "printer-3d",
    "preheat",
    "auto-home",
    "bed-level",
    "filament",
    "nozzle",
    "fan",
    "print-pause",
    "ghost",
    "pacman",
    "invader",
    "invader2",
    "alien",
    "skull",
    "robot",
    "mushroom",
    "sword",
    "coin",
    "bomb",
    "ufo",
    "cat",
    "smiley",
    "joystick",
    "arcade",
    "tetromino",
    "crown",
    "potion",
    "chest"
  ];
  var PIX_HEX = "183c7eff18181800181818ff7e3c1800103070ff70301000080c0eff0e0c080000183c66c30000000000c3663c1800000c18306030180c0030180c060c183000183c66c3dbdbdb00002060fe632303003e63c0c0c3663c087f434549d1b08ff0e7818100008181e7007e424242427e00c0f0fcfffcf0c0006666666666666600007e7e7e7e7e7e003c7effffffff7e3cc3e3f3fbf3e3c300c3c7cfdfcfc7c30088cceeffeecc8800113377ff7733110083452911294583007ec3c0c3fd0f0d007ec3c8d8fc0f0d00183c7eff00ffff0008183af2f23a1808081a3af2f438180808183af5f53a1808001838f0f0381800383838baba827c10393a38b2a5857d123c7ec3c3dbdbdb007e425a425a5a427e002476f7f77624000f090808083878303f212121e7f7630000a5b5b5b6b6a60018183c246642ff003c425a423c183c0000f88a8c8c8af8003c4299bd99423c18ffa5ff81ffa5ff0055aaff818181ff0000327a79797a320002020a0a2a2aaaaaf8888f89f9090f00ff818181ff183c00ff99bd9981ff183c2418ff818181ff00ff81b1bdb181ff187c445e5272121e003c5ac3dbc3dbc37ec34224183c66663c2060fe6323030e0004067fc6c4c07000ffc3c3c381bdbdff3cff007e5a5a7e007c44445f5171111fdb008181818100db78849e9272121e007c4642424a5e4a7e00e09f8181427e007c46424e5c48407c070f1d3870c000ff78444478444478003e0c0c181830f80066666666663c00ff3c66603806663c78ff00f800ff00f800ff007e00ff007e00ff001f00ff001f009f009f009f009f00c767e7c700ff00ff66666622440000003e63c10083c67c002263c18080c16322ffe7181818183c007c46424242427e00e09f81818181ff00e09f81ff42241800ff81ff998181ff0018181899fe7c381010387cfe99181818003c42c181817f00183c5ad981817f00003c42c199bd6d183c24ff8181ff3c3cff81bda5bd8185ff18185adbc3c37e003e63c2c0c3663c087c0c183764fa020724bd7e66667ebd24070f1d70e0c08000c76f3a182c46c3005affbdc3c3bdff5affaaaaaaaaff4242183c18185a5a7a0e00fd85bdbd85fd002424ff81817e1818bd7e7effff7ebd81ff81a191a181bdff7ec37ec37ec37e00ffa3ff00ffa3ff003c5a99ff995a3c00003c42992418000003030f0f3f3fffff07053d42819e90f080e0f8fef8e08000ffc3a5998181ff007e8181817e306000183c424242ff00183c429da5a59c403e3c42423c7e81810066999966fd858500010386ccec7c3810c3e77e3c3c7ee7c31824245a5a9981ff1818003818183c003c4283060c0c000c181818ffff181800000000ffff0000001818fe7c386cc60066ffffff7e3c1800c0dededec0c0c0003c4242ffdbc3ff003c4240ffdbc3ff00003c429999423c00033d439ab2443cc07ec3c3c3663c18007fc1a191898583ff3c4289898e81423c247ec3cbcbc37e00c37e99999d817ec342ff81a981a9ff00ff422418182442ff3e63d3ddc3663c08ffff81818181ff00efef81bfa1e1213fe79981818181ff00ff9999999999ff00ff81ff999999ff00cccc00cccc00cccc183c7eff007e3c1818183c7e7e3c18180000000000ffff00ffffc3c3c3c3ffff7ec3a59999a5c37ee7819918189981e7070f1d3878783800070f1d3870e0c08003070e1c3870e0c0070d1b366c6878003c5ac399a5c37c1c3030ff3033330f037c92ba927c0c06037c82ba827c0c0603183c66dbdb663c183c66c3c2c0663c40ffa981a981a9ff003c42818181817e007ea5e781a5e7817eff81b1818d81ff003c4299bd99423c00ffbdbd7e3c183c7e183c5a5a7e5ac3810e1c387c0c183060081c3a766e4e6c3810387cfe7c3810007c8282827c0c0603ff7e3c18181818002672f826222622007e424242425a66003c429999423c0c0f247eff819999ff0000fc8586868578ff3c4281995a3c183cc3c3c3c3c37e00003c429999423c1808ff81ffa981a9ff0000030f3fff00ff00c1c20408102043832424ff24ff242400ff81ab81b581ff003c5a99818181423c183c660000663c18002466c3c3662400dfc000dfc000dfc0fc8485878584fc00bdc3bd81bdc3bd0000003c7e7e3c000018813c66663c81183c7af9f9f9f97a3cff99a5bd9981ff3c3f21e19f8181ff003f43c2868484fc00c0c0301c06030300ffa1a1a1a1a1ff00ff83868d99b1ff00183c7e18ff8181ff10362321212336103f4181818181ff001f3161c18181ff00e7a5a5a5a5a5e700ffffff818181ff00ff81bdbdbd81ff00ff8787878787ff001824428181422418e7810081810081e77effffffffff7e008181a5ffa5818100808098848281ff003c427e7e00ff0000808080808698b0ff387c6c7c38101000c0e0f0f8fce0b00cc0a09088849ca0203c243c00187e18003c243c00007e0000fc84878181e1213ffc84849e90f00000fc84bdbdbd3d013ffc84a5a5a525213f80be80b880be8000107c1038107c1000017d011d017d0100ffdadad8d8c0c000c0c0d8d8dadaff009999999999999900ff0000ff0000ff003c427e00183c7efff5f2f5f2f5f2f50042bd3c3c3c3cbd423c5ac3c3c3c3c37e3c5ac3dbd3dec37efff1f1f1f1f1f1ffff8f8f8f8f8f8fffff81bdbdbdbd81ffff818595a5a5ff00f88888fb09090f0018183cff818181ffff8199bd9981ff18ff81bd81c3423c181818242424667e3c82c6aa10aac6820000030f3fff003c663c4299bd99423c0f7e427e3c3c1818083c64c4999123263cff81b5b5b581ff003c7edbffffffffb63c7ef8f0f0f87e3c24183c66ffbd8142183c7edbff245aa53c7edbff7e2442817effdbdbff7e5a5a187ebddbff7e42663c7edbff7e3c243c03060c1830f830503c7edbdbdbdb7e3c060c3c7effff7e3c3c42ffaa7e24428181c3ffa5ff997e3c3c7edbffbdc37e3c183c18187effff7eff81bdbd81dbff81c0c0c0c0f0f0000099dbffffff7e7e00423c24247effff7e7ec3ffdbffc3ff00";
  var PIX = new Uint8Array(PIX_HEX.length / 2);
  for (let i = 0; i < PIX.length; i++) {
    PIX[i] = parseInt(PIX_HEX.slice(i * 2, i * 2 + 2), 16);
  }
  var IDX = new Map(ICON_NAMES.map((n, i) => [n, i]));
  var CUSTOM_ICON_PREFIX = "px:";
  function iconBytes(name) {
    if (!name) return null;
    if (name.startsWith(CUSTOM_ICON_PREFIX)) {
      const h = name.slice(CUSTOM_ICON_PREFIX.length);
      if (!/^[0-9a-fA-F]{16}$/.test(h)) return null;
      const b = new Uint8Array(8);
      for (let i2 = 0; i2 < 8; i2++) b[i2] = parseInt(h.slice(i2 * 2, i2 * 2 + 2), 16);
      return b;
    }
    const i = IDX.get(name);
    if (i === void 0) return null;
    return PIX.subarray(i * 8, i * 8 + 8);
  }

  // app/src/lib/oled-i18n.ts
  var LANGS = ["en", "tr"];
  var LANG_DESC = {
    en: "English",
    tr: "Türkçe"
  };
  var DEFAULT_LANG = "en";
  var STRINGS = {
    en: {
      "loading": "loading",
      "back": "< back",
      "save": "save",
      "select": "select",
      "settings": "SETTINGS",
      "auto_return": "Auto return",
      "language": "Language",
      "show_layer": "Layer band",
      "show_profile": "Profile band",
      "on": "on",
      "off": "off",
      "layer_band": "Layer %s",
      "about": "About",
      "about_title": "ABOUT",
      "model": "Model",
      "firmware": "Firmware",
      "device_id": "Device ID",
      "restart": "Restart",
      "wheel_layers": "Wheel layers",
      "boot_disp": "display",
      "boot_cfg": "profiles",
      "boot_hid": "USB HID",
      "update_title": "FIRMWARE UPDATE",
      "sec_unit": "SEC",
      "idle_t": "IDLE",
      "live_t": "LIVE",
      "rec_t": "REC",
      "scene_t": "SCENE",
      "speed": "speed",
      "auto_return_title": "AUTO RETURN",
      "lang_title": "SETTINGS > LANGUAGE",
      "host": "Connected to app",
      "menu_fail": "menu unavailable",
      "menu_fail_hint": "reinstall from app",
      "err_title": "error - see serial log",
      "no_macro": "no macro on this key",
      "assign_app": "assign one in the app",
      "usb_on": "USB drive is on",
      "read_only": "read-only - use the app",
      "save_fail": "could not save",
      "updating": "updating",
      "updating2": "do not unplug",
      "restarting": "restarting...",
      "transfer_title": "DATA TRANSFER",
      "transfer": "app is writing files",
      "transfer2": "keys paused",
      "setup_test": "SETUP - TEST",
      "press_key": "press a key",
      "keys_test": "KEY TEST",
      "pixel_test": "Pixel test",
      "pixel_hint": "any button: back",
      "keys_test_paused": "Macros paused",
      "keys_test_switch": "Use another tab",
      "key_test": "Key test",
      "test_press": "press a key or turn",
      "hold_exit": "hold PSH: exit",
      "wheel": "WHEEL",
      "key_t": "KEY",
      "media": "MEDIA",
      "volume": "VOLUME",
      "bright": "BRIGHTNESS",
      "scroll_t": "SCROLL",
      "run_t": "ACTION",
      "run": "run",
      "hint_repeat": "turn: repeat",
      "hint_track": "turn: track",
      "hint_vol": "turn: volume",
      "hint_bright": "turn: bright",
      "hint_scroll": "turn: scroll",
      "app_needed": "MKYADA app required",
      "open_app": "open it on the computer",
      "no_assign": "no action here",
      "assigned": "assigned",
      "hold_set": "hold: assign",
      "menu_t": "LAYER",
      "mic_t": "MIC"
    },
    tr: {
      "loading": "yükleniyor",
      "back": "< geri",
      "save": "kaydet",
      "select": "seç",
      "settings": "AYARLAR",
      "auto_return": "Otomatik Dönüş",
      "language": "Dil",
      "show_layer": "Katman bandı",
      "show_profile": "Profil bandı",
      "on": "açık",
      "off": "kapalı",
      "layer_band": "Katman %s",
      "about": "Hakkında",
      "about_title": "HAKKINDA",
      "model": "Model",
      "firmware": "Yazılım",
      "device_id": "Cihaz No",
      "restart": "Yeniden Başlat",
      "wheel_layers": "Tekerle katman",
      "boot_disp": "ekran",
      "boot_cfg": "profiller",
      "boot_hid": "USB HID",
      "update_title": "YAZILIM GÜNCELLEME",
      "sec_unit": "SN",
      "idle_t": "BOŞTA",
      "live_t": "YAYINDA",
      "rec_t": "KAYIT",
      "scene_t": "SAHNE",
      "speed": "hız",
      "auto_return_title": "OTOMATİK DÖNÜŞ",
      "lang_title": "AYARLAR > DİL",
      "host": "Uygulamaya bağlı",
      "menu_fail": "menü yüklenemedi",
      "menu_fail_hint": "uygulamadan yükleyin",
      "err_title": "hata - seri kayda bak",
      "no_macro": "bu tuşta makro yok",
      "assign_app": "uygulamadan atayın",
      "usb_on": "USB disk açık",
      "read_only": "salt okunur - uygulamayı kullan",
      "save_fail": "kaydedilemedi",
      "updating": "güncelleniyor",
      "updating2": "fişi çekmeyin",
      "restarting": "yeniden başlatılıyor",
      "transfer_title": "VERİ AKTARIMI",
      "transfer": "uygulama yazıyor",
      "transfer2": "tuşlar duraklatıldı",
      "setup_test": "KURULUM - TEST",
      "press_key": "bir tuşa bas",
      "keys_test": "TUŞ TESTİ",
      "pixel_test": "Piksel testi",
      "pixel_hint": "herhangi bir tuş: geri",
      "keys_test_paused": "Makrolar durduruldu",
      "keys_test_switch": "Başka sekme kullan",
      "key_test": "Tuş testi",
      "test_press": "tuşa bas veya çevir",
      "hold_exit": "PSH tut: çık",
      "wheel": "TEKER",
      "key_t": "TUŞ",
      "media": "MEDYA",
      "volume": "SES",
      "bright": "PARLAKLIK",
      "scroll_t": "KAYDIR",
      "run_t": "EYLEM",
      "run": "çalıştır",
      "hint_repeat": "çevir: tekrarla",
      "hint_track": "çevir: parça",
      "hint_vol": "çevir: ses",
      "hint_bright": "çevir: parlaklık",
      "hint_scroll": "çevir: kaydır",
      "app_needed": "MKYADA uygulaması gerekli",
      "open_app": "bilgisayarda aç",
      "no_assign": "burada atama yok",
      "assigned": "atandı",
      "hold_set": "tut: ata",
      "menu_t": "KATMAN",
      "mic_t": "MİKROFON"
    }
  };
  var current = DEFAULT_LANG;
  function setLang(l) {
    current = LANGS.includes(l ?? "") ? l : DEFAULT_LANG;
    return current;
  }
  function getLang() {
    return current;
  }
  function tr(key) {
    return STRINGS[current][key] ?? STRINGS[DEFAULT_LANG][key] ?? key;
  }
  function upper(s) {
    let t = String(s);
    if (current === "tr") t = t.replace(/i/g, "İ").replace(/\u0131/g, "I");
    return t.toUpperCase();
  }

  // app/src/lib/oled-screens.ts
  var BAR_H = 9;
  var ROW_H = 13;
  var ROW_TOP = 12;
  var VIS = 4;
  var SB_X = 125;
  var SB_Y = 11;
  var SB_H = 52;
  var PBAR_Y = 43;
  var PBAR_H = 8;
  var PBAR_FOOT = 53;
  var TILE_X = [0, 43, 86];
  var TILE_W = 41;
  var HERO_SCALE = 3;
  var DLG_Y = 10;
  var DLG_H = 44;
  var SPEED_MIN_T = 1;
  var SPEED_MAX_T = 100;
  function fmtSpeed(t) {
    return `${(t / 10).toFixed(1)}x`;
  }
  function fmtHero(t) {
    const v = t / 10;
    return v >= 10 ? String(Math.trunc(v)) : v.toFixed(1);
  }
  function fmtBytes(done, total) {
    if (total) return `${(done / 1024).toFixed(1)} / ${(total / 1024).toFixed(1)} KB`;
    return `${(done / 1024).toFixed(1)} KB`;
  }
  var OledScreens = class {
    constructor(fb = new Fb(128, 64)) {
      __publicField(this, "W", 128);
      __publicField(this, "H", 64);
      __publicField(this, "CX", 64);
      __publicField(this, "fb");
      __publicField(this, "font");
      /** Printed in the boot splash's corner. */
      __publicField(this, "fw", "");
      this.fb = fb;
      this.font = fb.font;
    }
    // --- coordinate helpers -------------------------------------------------
    /** Text with y = TOP of the glyph box. */
    _txt(s, x, y, anchor = 0.5, invert = false) {
      this.fb.text(s, x, y, anchor, invert, false);
    }
    /** Scaled text with y = TOP of the glyph box.
     *
     * `fit` is the room the hero has, in SCREEN pixels. It is applied here rather
     * than at the call sites because it has to be measured against the SCALED
     * advance: fitting at scale 1 and drawing at 2x or 3x is how a long macro
     * name used to run off both edges of the glass instead of being cut. */
    _hero(s, x, y, scale = 2, anchor = 0.5, c = 1, fit) {
      const str = fit === void 0 ? s : this.font.fit(String(s), Math.trunc(fit / scale));
      this.fb.big(str, x, y + Math.trunc(7 * scale / 2), scale, anchor, c);
    }
    /** Position dots. The selected one is a 3x3 square, the rest single pixels —
     * three rects for the whole row instead of n circle objects. */
    _dots(y, n, sel) {
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
    split_name(name, cols = 3) {
      const f = this.font;
      const s = String(name ?? "").trim();
      const cell = Math.trunc(this.W / cols) - 2;
      if (f.measure(s) <= cell) return [s, ""];
      const head = f.fit(s, cell);
      const cut = head.lastIndexOf(" ");
      if (cut > 0) return [s.slice(0, cut), f.fit(s.slice(cut + 1), cell)];
      return [head, f.fit(s.slice(head.length), cell)];
    }
    // --- chrome -------------------------------------------------------------
    /** The design's bar(): 9px inverted strip, title left, optional label right. */
    _bar9(left, right) {
      this.fb.rect(0, 0, this.W, BAR_H);
      this._txt(left, 2, 1, 0, true);
      if (right) this._txt(right, this.W - 2, 1, 1, true);
    }
    /** The design's hdr(): back chevron, title, hairline at y=9. The old bottom
     * bar is gone in this design, so the action / "hold" hint moved up here —
     * which is what buys the list its fourth row back at 13px pitch. */
    _hdr9(title, hint) {
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
    _badge(s) {
      const f = this.font;
      const t = f.fit(String(s), 44);
      const w = f.measure(t) + 6;
      const x = this.W - 2 - w;
      this.fb.rfill(x, 1, w, 7, 0, 1);
      this._txt(t, x + 3, 1, 0);
    }
    /** The progress bar boot and update share. `c` is 0 on boot (an inverted
     * field, so it is carved) and 1 on update. */
    _pbar(frac, c) {
      const p = Math.min(1, Math.max(0, frac));
      this.fb.frame(4, PBAR_Y, 120, PBAR_H, c);
      this.fb.rect(6, PBAR_Y + 2, Math.trunc(116 * p), PBAR_H - 4, c);
    }
    /** The dithered backdrop plus the rounded box both overlays sit in. */
    _dialog(art) {
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
    show_update(frac, restarting = false, done = 0, total = 0) {
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
      fb.icon2(this.CX - 8, 30, iconBytes("database"));
      this._txt(tr("transfer"), this.CX, 50, 0.5);
    }
    /** Settings list. The state used to be baked into the label ("Layer band:
     * on"); it is a column of its own now. */
    show_settings(title, items, sel) {
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
      const ty = SB_Y + Math.trunc((SB_H - th) * top / Math.max(1, n - VIS));
      fb.sbarv(SB_X, SB_Y, SB_H, ty, th);
    }
    /** Generic list — language, wheel menus, host lists. Same frame as the
     * settings list. The device's old ">" marker for the assigned option is a
     * tick icon on the right now, so the label stays left-aligned. */
    show_menu(title, items, sel, marked = null, action, hold) {
      const fb = this.fb;
      const f = this.font;
      const n = items.length;
      const top = sel >= VIS ? Math.min(sel - VIS + 1, Math.max(0, n - VIS)) : 0;
      this.clear();
      this._hdr9(title, hold || action || null);
      const wide = marked === null || marked === void 0 ? 115 : 95;
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
      if (n > VIS) {
        const th = Math.max(8, Math.trunc((SB_H * VIS + Math.trunc(n / 2)) / n));
        const ty = SB_Y + Math.trunc((SB_H - th) * top / Math.max(1, n - VIS));
        fb.sbarv(SB_X, SB_Y, SB_H, ty, th);
      }
    }
    /** Speed editor: badged title, hero number, 15 segments, the range below. */
    show_speed(layerName, keyNo, t, lo = SPEED_MIN_T, hi = SPEED_MAX_T) {
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
    show_timeout(sec, _lo, _hi) {
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
      const off = sec * 2 % 18;
      const major = Math.trunc(sec * 2 / 18) * 3;
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
    _grid_bar(band, page, st) {
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
    show_grid(labels, active, invert = true, band = null, icons = null, page = null, st = null) {
      const fb = this.fb;
      const f = this.font;
      this.clear();
      const hasSt = !!(st && (st.rec || st.live));
      const bar = !!band || hasSt;
      const top = bar ? 11 : 2;
      const bot = page ? 59 : 62;
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
    show_home(pos, layerCount, layerNames, nick, active = false) {
      const fb = this.fb;
      this.clear();
      const n = layerCount + 1;
      this._bar9(tr("menu_t"), `${pos + 1}/${n}`);
      const isSet = pos >= layerCount;
      const hero = isSet ? tr("settings") : upper(layerNames[pos] ?? "");
      const sub = isSet ? "" : nick || (active ? upper(tr("on")) : "");
      if (pos > 0) fb.icon(1, 26, iconBytes("chevron-left"));
      if (!isSet) fb.icon(this.W - 9, 26, iconBytes("chevron-right"));
      this._hero(hero, this.CX, 23, 2, 0.5, 1, 106);
      if (sub) this._txt(sub, this.CX, 42);
      this._dots(57, n, pos);
    }
    /** All six keys at once with a press counter each, wheel and module buttons
     * underneath. The old screen showed one control at a time, so finding the
     * silent key meant pressing them in turn. */
    show_keytest(s) {
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
    show_about(rows) {
      this.clear();
      for (let i = 0; i < rows.length && i < 5; i++) {
        const y = 11 + i * 10;
        this._txt(rows[i][0], 3, y + 2, 0);
        this._txt(this.font.fit(String(rows[i][1]), 86), this.W - 2, y + 2, 1);
      }
      this._bar9(tr("about_title"));
    }
    show_saved(layerName, keyNo, t) {
      this._dialog(iconBytes("check"));
      this._hero(upper(tr("save")), 34, 19, 2, 0, 1, 90);
      this._txt(
        this.font.fit(`${upper(layerName)} > K${keyNo}  ${fmtSpeed(t)}`, 84),
        34,
        36,
        0
      );
    }
    /** Same box, but a toast has three pieces and our glyph box is a row taller
     * than the design's — a 2x title plus two lines does not fit, so all three
     * are one scale, at an even 11px pitch. */
    show_toast(title, line1 = "", line2 = "", ok = false) {
      const f = this.font;
      this._dialog(iconBytes(ok ? "check" : "warning"));
      this._txt(f.fit(title, 84), 34, 18, 0);
      if (line1) this._txt(f.fit(line1, 84), 34, 29, 0);
      if (line2) this._txt(f.fit(line2, 84), 34, 40, 0);
    }
    /** Action card for the wheel menu: 9px bar, a 2x hero, an optional status
     * line, and the design's plain hint row instead of a filled bar. */
    show_card(title, big, line, hint) {
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
    show_adjust(title, hero, frac, action) {
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
    show_obsrec(o) {
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
    show_obs(o) {
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
    /** OBS Center dashboard (proto v13). Every widget is optional — a None
     * field means the app turned it off — and the enabled ones reflow top-down,
     * vertically centred in whatever room the quick-key row leaves. The timer
     * drops from 2x to 1x only when the stack would not fit, which is the
     * everything-on + six-labels case. Mirrors oled.py show_obscenter. */
    show_obscenter(o) {
      const fb = this.fb;
      const f = this.font;
      this.clear();
      fb.rect(0, 0, this.W, BAR_H);
      this._txt("OBS", 2, 1, 0, true);
      const rec = o.rec ?? null;
      const live = o.live ?? null;
      if (rec !== null || live !== null) {
        const lab = rec ? upper(tr("rec_t")) : live ? upper(tr("live_t")) : upper(tr("idle_t"));
        const dot = rec ? 5 : 0;
        const bw = f.measure(lab) + 6 + dot;
        const bx = this.W - 2 - bw;
        fb.rfill(bx, 1, bw, 7, 0, 1);
        if (rec && o.blink) fb.rect(bx + 3, 3, 3, 3);
        this._txt(lab, bx + 3 + dot, 1, 0);
      }
      const t = o.time ?? null;
      const sc = o.scene ?? null;
      const mic = o.mic ?? null;
      const cpu = o.cpu ?? null;
      const fps = o.fps ?? null;
      const drop = o.drop ?? null;
      const health = cpu !== null || fps !== null || drop !== null;
      const kl = o.klabels ?? null;
      const bot = kl !== null ? 50 : 62;
      const avail = bot - 11;
      let th = 16;
      let total = (t !== null ? th + 2 : 0) + (sc !== null ? 11 : 0) + (mic !== null ? 9 : 0) + (health ? 10 : 0);
      if (total) total -= 2;
      if (t !== null && total > avail) {
        total -= 8;
        th = 8;
      }
      let y = 11 + Math.max(0, Math.trunc((avail - total) / 2));
      if (t !== null) {
        if (th === 16) this._hero(String(t || "00:00"), this.CX, y, 2, 0.5, 1, 124);
        else this._txt(f.fit(String(t || "00:00"), 124), this.CX, y);
        y += th + 2;
      }
      const focus = o.focus ?? null;
      if (sc !== null) {
        const sl = upper(tr("scene_t"));
        const sx = Math.max(38, 2 + f.measure(sl) + 4);
        this._txt(sl, 2, y + 1, 0);
        if (focus === "scene") {
          fb.frame(0, y, f.measure(sl) + 5, 9);
        }
        const sn = f.fit(String(sc), this.W - sx - 6);
        fb.rfill(sx, y, f.measure(sn) + 6, 9, 1);
        this._txt(sn, sx + 3, y + 1, 0, true);
        y += 11;
      }
      if (mic !== null) {
        const ml = upper(tr("mic_t"));
        const mx = Math.max(24, 2 + f.measure(ml) + 4);
        if (o.mute) {
          fb.rect(0, y, f.measure(ml) + 4, 7);
          this._txt(ml, 2, y, 0, true);
        } else {
          this._txt(ml, 2, y, 0);
        }
        if (focus === "mic") {
          fb.frame(0, y - 1, f.measure(ml) + 6, 9);
        }
        fb.segbar(mx, y, this.W - 6 - mx, 7, 14, Math.max(0, Math.trunc(mic * 14 / 100 + 0.5)));
        y += 9;
      }
      if (health) {
        if (cpu !== null) this._txt(`CPU ${cpu}%`, 2, y, 0);
        if (drop !== null) this._txt(`DROP ${drop}`, this.CX, y, 0.5);
        if (fps !== null) this._txt(`${fps} FPS`, this.W - 2, y, 1);
        y += 10;
      }
      if (kl !== null) {
        fb.hline(0, 52, this.W);
        for (let i = 0; i < 6; i++) {
          const s = i < kl.length && kl[i] ? String(kl[i]) : "";
          if (s) this._txt(f.fit(s, 20), 11 + i * 21, 55, 0.5);
        }
      }
    }
    /** The design's fault screen: a 2x warning icon with two lines beside it.
     * Theirs sits high because an error code and a retry line follow; we have
     * neither, so the block is centred between bar and bottom. */
    _alert(title, l1, l2, art) {
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
    show_error(msg) {
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
    rows() {
      return this.fb.rows();
    }
  };

  // app/src/lib/oled-draw.ts
  function paintFb(c, fb) {
    const img = c.createImageData(fb.W, fb.H);
    for (let i = 0; i < fb.px.length; i++) {
      const o = i * 4;
      if (fb.px[i]) {
        img.data[o] = 234;
        img.data[o + 1] = 243;
        img.data[o + 2] = 255;
      }
      img.data[o + 3] = 255;
    }
    c.putImageData(img, 0, 0);
  }
  function drawIconSwatch(c, name, scale, lit = "#eaf3ff") {
    const data = iconBytes(name);
    c.clearRect(0, 0, 8 * scale, 8 * scale);
    if (!data) return;
    c.fillStyle = lit;
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        if (data[row] & 128 >> col) c.fillRect(col * scale, row * scale, scale, scale);
      }
    }
  }
  return __toCommonJS(oled_bundle_exports);
})();
/* OLED_BUNDLE_END */

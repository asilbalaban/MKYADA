// Hold the web side's OLED drawing to the firmware's own pixels.
//
// oled-screens.ts is a second implementation of a screen that already exists in
// firmware/mkyada/oled.py, and a second implementation drifts — the Courier
// mockup this replaced drifted so far it was drawing a different font. So the
// test doesn't check the port against itself: it renders the same inputs the
// firmware's golden images were rendered from (tests/oled_render_test.py) and
// demands the same picture, pixel for pixel.
//
// A failure here means one of two things, both worth knowing: the port drifted,
// or the firmware's layout changed and the web side never noticed.
//
// The goldens cover the whole screen set, not a sample, because the published
// demo page is built from this module too — an untested screen there is a
// picture of a keypad nobody has checked.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { renderWheelScreen, type WheelPreview } from "./oled-draw";
import { OledScreens, type SettingsItem } from "./oled-screens";
import { oledFont } from "./oled-fb";
import { iconBytes, packCustomIcon } from "./oled-icons";
import { setLang } from "./oled-i18n";

const GOLDEN = resolve(__dirname, "../../../tests/golden");

function golden(name: string): string[] {
  // Tolerate CRLF: the goldens are written by a Python test that may run on
  // Windows, and a stray "\r" would fail every row for the wrong reason.
  return readFileSync(resolve(GOLDEN, `${name}.txt`), "utf8")
    .replace(/\r/g, "")
    .trimEnd()
    .split("\n");
}

/** Where the two pictures first differ — a row number alone is unreadable. */
function diff(got: string[], want: string[]): string {
  const y = got.findIndex((r, i) => r !== want[i]);
  if (y < 0) return "";
  return `row ${y}\n  got  ${got[y]}\n  want ${want[y]}`;
}

// The exact arguments tests/oled_render_test.py blesses each golden from.
const SET_ITEMS: SettingsItem[] = [
  { label: "Auto return", kind: "text", value: "10s" },
  { label: "Language", kind: "text", value: "English" },
  { label: "Layer band", kind: "toggle", value: true },
  { label: "Profile band", kind: "toggle", value: false },
  { label: "Wheel layers", kind: "toggle", value: true },
  { label: "Key test", kind: "none" },
  { label: "About", kind: "none" },
  { label: "Restart", kind: "none" },
];
const MENU_ITEMS = ["Play/Pause", "Next", "Prev", "Stop", "Mute", "Rewind"];
const KEYTEST = { cnt: [1, 0, 3, 0, 0, 2], nav: [1, 0, 4], enc: -3, last: 2 };
const OBS = {
  rec: true,
  blink: true,
  live: false,
  mic: 64,
  time: "01:35",
  scene: "Intro",
  hint: "stop",
};

const SCREENS: { name: string; lang: "en" | "tr"; paint: (o: OledScreens) => void }[] = [
  { name: "boot", lang: "en", paint: (o) => o.show_boot() },
  { name: "update", lang: "en", paint: (o) => o.show_update(0.42, false, 26000, 62914) },
  { name: "transfer", lang: "en", paint: (o) => o.show_transfer() },
  { name: "home", lang: "en", paint: (o) => o.show_home(0, 3, ["A", "B", "C"], "Main", true) },
  { name: "settings", lang: "en", paint: (o) => o.show_settings("SETTINGS", SET_ITEMS, 1) },
  { name: "menu", lang: "en", paint: (o) => o.show_menu("MEDIA", MENU_ITEMS, 1, 0, "run") },
  { name: "speed", lang: "en", paint: (o) => o.show_speed("A", 3, 15) },
  { name: "timeout", lang: "en", paint: (o) => o.show_timeout(24, 3, 60) },
  { name: "keytest", lang: "en", paint: (o) => o.show_keytest(KEYTEST) },
  { name: "saved", lang: "en", paint: (o) => o.show_saved("A", 1, 15) },
  {
    name: "about",
    lang: "en",
    paint: (o) =>
      o.show_about([
        ["Model", "vision6"],
        ["Firmware", "0.23.1"],
        ["Device ID", "5035586072b9"],
      ]),
  },
  { name: "card", lang: "en", paint: (o) => o.show_card("WHEEL", "Next layer", null, "run") },
  {
    name: "toast",
    lang: "en",
    paint: (o) => o.show_toast("USB", "USB drive is on", "read-only"),
  },
  { name: "obs", lang: "en", paint: (o) => o.show_obs(OBS) },
  { name: "obsrec", lang: "en", paint: (o) => o.show_obsrec({ ...OBS, keyNo: 2 }) },
  { name: "host", lang: "en", paint: (o) => o.show_host() },
  {
    // Turkish is not decoration here: the labels are wider, so this is the case
    // that catches a screen laid out around English string widths.
    name: "settings_tr",
    lang: "tr",
    paint: (o) =>
      o.show_settings(
        "AYARLAR",
        [
          { label: "Otomatik Dönüş", kind: "text", value: "10sn" },
          { label: "Dil", kind: "text", value: "Türkçe" },
          { label: "Katman bandı", kind: "toggle", value: true },
          { label: "Profil bandı", kind: "toggle", value: false },
        ],
        0,
      ),
  },
  {
    name: "grid_banded",
    lang: "tr",
    paint: (o) =>
      o.show_grid(
        [
          ["Kamera", ""],
          ["Masaüstü", ""],
          ["Masaüstü ve", "Kamera"],
          ["Kayıt", ""],
          ["Yayın", ""],
          ["Next layer", ""],
        ],
        0,
        true,
        "Katman A",
      ),
  },
];

describe("every screen matches the firmware, pixel for pixel", () => {
  beforeEach(() => setLang("en"));

  for (const s of SCREENS) {
    it(`${s.name} is identical to tests/golden/${s.name}.txt`, () => {
      setLang(s.lang);
      const o = new OledScreens();
      o.fw = "0.0.0"; // the harness's value, printed on the boot splash
      s.paint(o);
      expect(diff(o.rows(), golden(s.name))).toBe("");
    });
  }
});

describe("the editor's preview mapping", () => {
  beforeEach(() => setLang("en"));

  const CASES: { name: string; golden: string; preview: WheelPreview }[] = [
    {
      name: "card",
      golden: "card",
      preview: { screen: "card", title: "WHEEL", big: "Next layer", hint: "run" },
    },
    {
      name: "toast",
      golden: "toast",
      preview: { screen: "toast", title: "USB", line1: "USB drive is on", line2: "read-only" },
    },
    {
      name: "speed editor",
      golden: "speed",
      preview: { screen: "speed", layer: "A", key: 3, t: 15 },
    },
    {
      name: "menu",
      golden: "menu",
      preview: {
        screen: "picker",
        title: "MEDIA",
        items: [
          { label: "Play/Pause", mark: "dot" },
          { label: "Next", mark: "cursor" },
          { label: "Prev" },
          { label: "Stop" },
          { label: "Mute" },
          { label: "Rewind" },
        ],
        action: "run",
      },
    },
  ];

  for (const c of CASES) {
    it(`${c.name} routes to tests/golden/${c.golden}.txt`, () => {
      expect(diff(renderWheelScreen(c.preview).rows(), golden(c.golden))).toBe("");
    });
  }

  it("a cell preview draws the chosen icon, and a two-line name drops it", () => {
    const withIcon = renderWheelScreen({ screen: "cell", name: "Paste", icon: "paste" }).rows();
    const noIcon = renderWheelScreen({ screen: "cell", name: "Paste", icon: null }).rows();
    expect(withIcon.join("\n")).not.toBe(noIcon.join("\n"));
    // A name that needs two lines has no room for the icon, so asking for one
    // changes nothing.
    const long = "Masaüstü ve Kamera";
    const a = renderWheelScreen({ screen: "cell", name: long, icon: "paste" }).rows();
    const b = renderWheelScreen({ screen: "cell", name: long, icon: null }).rows();
    expect(a.join("\n")).toBe(b.join("\n"));
  });
});

describe("the font", () => {
  it("draws Turkish rather than folding it", () => {
    const f = oledFont();
    for (const ch of "ÇĞİÖŞÜçğıöşü") {
      expect(f.index(ch), ch).not.toBe(0x3f - f.first); // not the '?' glyph
    }
  });

  it("is proportional, so a name's width depends on its letters", () => {
    const f = oledFont();
    expect(f.measure("IIII")).toBeLessThan(f.measure("WWWW"));
  });

  it("renders an unknown character rather than dropping it", () => {
    const f = oledFont();
    expect(f.measure("Café")).toBe(f.measure("Cafe")); // é folds to e
    expect(f.fit("Kamera", 1000)).toBe("Kamera");
  });
});

describe("the icon family", () => {
  it("resolves by name and refuses an unknown one", () => {
    expect(iconBytes("rocket")).not.toBeNull();
    expect(iconBytes("no-such-icon")).toBeNull();
    expect(iconBytes(null)).toBeNull();
  });

  it("packs eight rows per icon", () => {
    expect(iconBytes("ghost")?.length).toBe(8);
  });

  it("carries the chrome icons the screens draw", () => {
    for (const n of ["chevron-left", "chevron-right", "check", "warning"]) {
      expect(iconBytes(n), n).not.toBeNull();
    }
  });

  // A hand-drawn icon isn't a lookup: the eight rows travel inside the macro's
  // own json as "px:" + 16 hex. This side packs them and the firmware decodes
  // them (icons.py get()), so the two spellings have to agree exactly — the
  // round-trip below is the whole contract between the drawing grid and the
  // glass.
  it("packs and unpacks a drawn icon", () => {
    const rows = [0x18, 0x3c, 0x7e, 0xff, 0xc3, 0xc3, 0x00, 0x00];
    const name = packCustomIcon(rows);
    expect(name).toBe("px:183c7effc3c30000");
    expect(Array.from(iconBytes(name)!)).toEqual(rows);
  });

  it("round-trips a named icon through the drawn form", () => {
    const src = iconBytes("rocket")!;
    expect(Array.from(iconBytes(packCustomIcon(src))!)).toEqual(Array.from(src));
  });

  it("reads a malformed drawn icon as no icon", () => {
    // Falling back to "no icon" is what keeps a bad hand-edit from blanking a
    // tile in a way that looks like the icon family lost a name.
    expect(iconBytes("px:1234")).toBeNull();
    expect(iconBytes("px:zzzzzzzzzzzzzzzz")).toBeNull();
    expect(iconBytes("px:")).toBeNull();
  });
});

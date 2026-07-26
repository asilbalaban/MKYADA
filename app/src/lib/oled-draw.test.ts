// Hold the app's OLED preview to the firmware's own pixels.
//
// The preview is a second implementation of a screen that already exists in
// firmware/mkyada/oled.py, and a second implementation drifts — the Courier
// mockup this replaced drifted so far it was drawing a different font. So the
// test doesn't check the port against itself: it renders the same inputs the
// firmware's golden images were rendered from (tests/oled_render_test.py) and
// demands the same picture, pixel for pixel.
//
// A failure here means one of two things, both worth knowing: the port drifted,
// or the firmware's layout changed and the app never noticed.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderWheelScreen, type WheelPreview } from "./oled-draw";
import { oledFont } from "./oled-fb";

const GOLDEN = resolve(__dirname, "../../../tests/golden");

function golden(name: string): string[] {
  return readFileSync(resolve(GOLDEN, `${name}.txt`), "utf8").trimEnd().split("\n");
}

/** Where the two pictures first differ — a row number alone is unreadable. */
function diff(got: string[], want: string[]): string {
  const y = got.findIndex((r, i) => r !== want[i]);
  if (y < 0) return "";
  return `row ${y}\n  got  ${got[y]}\n  want ${want[y]}`;
}

const CASES: { name: string; golden: string; preview: WheelPreview }[] = [
  {
    // firmware: show_card("WHEEL", "Next layer", None, "run")
    name: "card",
    golden: "card",
    preview: { screen: "card", title: "WHEEL", big: "Next layer", hint: "run" },
  },
  {
    // firmware: show_toast("USB", "USB drive is on", "read-only")
    name: "toast",
    golden: "toast",
    preview: { screen: "toast", title: "USB", line1: "USB drive is on", line2: "read-only" },
  },
  {
    // firmware: show_speed("A", 3, 15) — title, hero and frac as _value_screen
    // computes them, so the port is checked on the numbers too.
    name: "speed editor",
    golden: "speed",
    preview: {
      screen: "speed",
      title: "A > K3  speed",
      value: "1.5",
      frac: (15 - 1) / 99,
      action: "save",
    },
  },
  {
    // firmware: show_menu("SETTINGS", [...6 items], 1) — six items, so this
    // exercises the scroll arrows and the narrowed row width as well.
    name: "menu",
    golden: "menu",
    preview: {
      screen: "picker",
      title: "SETTINGS",
      items: [
        { label: "Auto return" },
        { label: "Language", mark: "cursor" },
        { label: "Layer band" },
        { label: "Profile band" },
        { label: "About" },
        { label: "Restart" },
      ],
      action: "select",
    },
  },
];

describe("the wheel-menu preview matches the firmware", () => {
  for (const c of CASES) {
    it(`${c.name} is pixel-identical to tests/golden/${c.golden}.txt`, () => {
      const got = renderWheelScreen(c.preview).rows();
      const want = golden(c.golden);
      expect(diff(got, want)).toBe("");
    });
  }
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

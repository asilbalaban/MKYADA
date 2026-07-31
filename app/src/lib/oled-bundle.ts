// The entry point scripts/build-demo.mjs bundles into docs/simulator.html.
//
// The demo page is a plain static HTML file — no build step of its own, no
// module server — so everything it needs to draw the device arrives as one
// pre-bundled blob on `window.MKOLED`. This file is only the list of what that
// blob contains; the code lives in the modules beside it, which the app imports
// directly. That is the whole point: the page and the app draw from the same
// source, so a screen cannot be fixed in one and stay broken in the other.
//
// Nothing app-specific belongs here. The demo page has no React, no Tauri and
// no assignment model — if something needs those, it is not part of the
// drawing layer and should stay in the app.

export { Fb, OledFont, oledFont } from "./oled-fb";
export {
  OledScreens,
  fmtBytes,
  fmtHero,
  fmtSpeed,
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
  DLG_Y,
  DLG_H,
  SPEED_MIN_T,
  SPEED_MAX_T,
} from "./oled-screens";
export type {
  SettingsItem,
  GridPage,
  BandState,
  KeytestState,
  ObsState,
} from "./oled-screens";
export { ICON_CATEGORIES, ICON_NAMES, iconBytes } from "./oled-icons";
export {
  LANGS,
  LANG_DESC,
  DEFAULT_LANG,
  STRINGS,
  setLang,
  getLang,
  tr,
} from "./oled-i18n";
export { paintFb, drawIconSwatch } from "./oled-draw";

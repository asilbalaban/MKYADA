// Ready-made Dial slot sets for the programs colorists, editors, musicians
// and players actually drive with an encoder. Defined macOS-first (the
// shortcuts below are the
// stock macOS bindings); encPresetSlots() swaps Cmd for Ctrl on Windows,
// which lands on the stock Windows bindings for every set here (Photoshop's
// history pair included). Labels are OLED tile text: ≤6 chars, uppercase.
//
// Single-character keys below are the CHARACTER the target app's shortcut
// wants ("-" for zoom out), not a physical key: encPresetSlots() resolves
// each one through the user's active keyboard layout (layout.ts) into the
// positional key that actually types it. Without this, HID being positional
// meant "zoom out" on a Turkish-Q layout pressed the US "-" position — which
// types a different character there — and the shortcut fired as a stray
// letter instead (field bug: zoom out typed "ü"). Named keys (right, space,
// f5) are the same position on every layout and pass through untouched.
//
// These are STARTING POINTS — the editor copy says so and every slot stays
// editable after applying one.

import type { EncModuleBtn, EncModuleSlot } from "./types";
import { IS_MAC } from "./macro-model";
import { charToKeystroke } from "./layout";

export interface EncPreset {
  id: string;
  label: string;
  /** Picker section. Video and music sets want different shelves once there
   * are more than a handful. */
  group: "video" | "music" | "read";
  /** One-line "who is this for" note under the picker. */
  note: string;
  slots: (EncModuleSlot | null)[];
}

const combo = (mods: string[], key: string) => ({ mods, key });
const BTN_SPACE: EncModuleBtn = { t: "combo", mods: [], key: "space" };
const BTN_ENTER: EncModuleBtn = { t: "combo", mods: [], key: "enter" };
const BTN_CLICK: EncModuleBtn = { t: "click" };
const BTN_PLAY: EncModuleBtn = { t: "consumer", u: "play_pause" };

/** Jog one frame per detent (arrow keys) — the classic editing wheel. */
const JOG: EncModuleSlot = {
  l: "JOG", t: "keys", cw: combo([], "right"), ccw: combo([], "left"), m: 1, b: BTN_SPACE,
};
const SCRL_H: EncModuleSlot = { l: "SCRL", t: "scroll", axis: "h", m: 1 };
const SCRL_V: EncModuleSlot = { l: "SCRL", t: "scroll", axis: "v", m: 1 };
const PAN_H: EncModuleSlot = { l: "PAN", t: "scroll", axis: "h", m: 1 };
const VOL: EncModuleSlot = {
  l: "VOL", t: "consumer", cw: "volume_up", ccw: "volume_down", m: 1, b: BTN_PLAY,
};
/** CW = redo, CCW = undo. */
const UNDO: EncModuleSlot = {
  l: "UNDO", t: "keys", cw: combo(["SHIFT", "WIN"], "z"), ccw: combo(["WIN"], "z"), m: 1,
};

/** Picker sections, in the order they should appear. */
export const ENC_PRESET_GROUPS: { id: EncPreset["group"]; label: string }[] = [
  { id: "video", label: "Video & photo" },
  { id: "music", label: "Music & audio" },
  { id: "read", label: "Reading" },
];

export const ENC_PRESETS: EncPreset[] = [
  {
    id: "davinci",
    group: "video",
    label: "DaVinci Resolve — Color",
    note: "Hover a color wheel or slider, turn to drag it — plus jog, zoom and scroll.",
    slots: [
      // Resolve's color controls have no shortcuts: the drag slots ARE the
      // encoder ring. Hover lift/gamma/gain (or any slider), turn the wheel.
      { l: "WHEEL", t: "move", axis: "y", step: 4, drag: true, m: 1, b: BTN_CLICK },
      { l: "FINE", t: "move", axis: "y", step: 1, drag: true, m: 1, b: BTN_CLICK },
      JOG,
      { l: "ZOOM", t: "keys", cw: combo(["WIN"], "="), ccw: combo(["WIN"], "-"), m: 1 },
      SCRL_H,
      VOL,
    ],
  },
  {
    id: "premiere",
    group: "video",
    label: "Premiere Pro — Edit",
    note: "Jog & shuttle the timeline, zoom, nudge clips, ride clip gain.",
    slots: [
      JOG,
      { l: "SHTL", t: "keys", cw: combo(["SHIFT"], "right"), ccw: combo(["SHIFT"], "left"), m: 1, b: BTN_SPACE },
      { l: "ZOOM", t: "keys", cw: combo([], "="), ccw: combo([], "-"), m: 1 },
      { l: "NUDGE", t: "keys", cw: combo(["ALT"], "right"), ccw: combo(["ALT"], "left"), m: 1 },
      { l: "GAIN", t: "keys", cw: combo([], "]"), ccw: combo([], "["), m: 1 },
      SCRL_H,
    ],
  },
  {
    id: "finalcut",
    group: "video",
    label: "Final Cut Pro",
    note: "Jog, nudge, zoom, clip volume and undo — all on the wheel.",
    slots: [
      JOG,
      { l: "NUDGE", t: "keys", cw: combo([], "."), ccw: combo([], ","), m: 1 },
      { l: "ZOOM", t: "keys", cw: combo(["WIN"], "="), ccw: combo(["WIN"], "-"), m: 1 },
      { l: "VOL", t: "keys", cw: combo(["CTRL"], "="), ccw: combo(["CTRL"], "-"), m: 1 },
      UNDO,
      SCRL_H,
    ],
  },
  {
    id: "photoshop",
    group: "video",
    label: "Photoshop",
    note: "Brush size (scrub HUD), wheel zoom, scroll, pan and multi-step undo.",
    slots: [
      // Brush size rides Photoshop's scrubby HUD (Ctrl+Opt+drag left/right),
      // NOT the [ ] shortcuts: on Turkish-Q and friends the brackets need
      // AltGr and Photoshop refuses them as shortcuts — the field bug where
      // BRUSH did nothing. The HUD is layout-proof and previews the tip live.
      // step 10: a single detent must travel far enough to read as a DRAG —
      // macOS turns a short Ctrl+click into a right click (context menu).
      // no wheel-press action: with a brush tool a bare click paints a dab
      { l: "BRUSH", t: "move", axis: "x", step: 10, drag: true, mods: ["CTRL", "ALT"], m: 1 },
      // Zoom is Opt+wheel (a Photoshop default on every layout and OS) —
      // the Cmd+= route lands on the wrong key on non-US layouts.
      { l: "ZOOM", t: "scroll", axis: "v", mods: ["ALT"], m: 1 },
      SCRL_V,
      PAN_H,
      // Plain Cmd+Z is MULTI-step undo since Photoshop 2019; Opt+Cmd+Z is
      // now "Toggle Last State" (the old one-step flip-flop — the field bug
      // where HIST undid one step and then redid it).
      UNDO,
      VOL,
    ],
  },
  {
    id: "timeline",
    group: "video",
    label: "Timeline basics (any editor)",
    note: "Jog, zoom, scroll both ways, volume and undo — works almost everywhere.",
    slots: [
      JOG,
      { l: "ZOOM", t: "keys", cw: combo(["WIN"], "="), ccw: combo(["WIN"], "-"), m: 1 },
      SCRL_V,
      PAN_H,
      VOL,
      UNDO,
    ],
  },

  // --- Music ---
  // Every shortcut below is a FACTORY default read off the vendor's own
  // manual. Deliberate omissions, so nobody "fixes" them back in:
  // - Ableton has no stock key for Tap Tempo or for launching the next scene
  //   (arrows select, Enter launches) — both are Key/MIDI-map only.
  // - Ableton's Redo is Ctrl+Y on Windows, NOT Ctrl+Shift+Z: the one place
  //   the Cmd->Ctrl swap breaks, so this set carries no undo pair at all.
  // - Logic has no factory key command for track/region volume.
  // - FL's Ctrl+Z toggles between the last two states instead of walking
  //   back, so it is not a repeatable encoder action.
  // - FL's pattern +/- live on the NUMPAD, which hidmap.py cannot address;
  //   the manual's Shift+wheel over the Channel Rack does the same job.
  {
    id: "ableton",
    group: "music",
    label: "Ableton Live — Session",
    note: "Walk clips and scenes, launch with a press, zoom and scroll the grid.",
    slots: [
      { l: "CLIP", t: "keys", cw: combo([], "right"), ccw: combo([], "left"), m: 1, b: BTN_ENTER },
      // Up/down steps one scene; Enter launches the selected one. With
      // "Select Next Scene on Launch" on, that press also walks the list.
      { l: "SCENE", t: "keys", cw: combo([], "down"), ccw: combo([], "up"), m: 1, b: BTN_ENTER },
      { l: "PAGE", t: "keys", cw: combo([], "page_down"), ccw: combo([], "page_up"), m: 1, b: BTN_ENTER },
      // Live's zoom is the bare +/- pair on the time ruler. Cmd +/- rescales
      // the whole GUI instead — wrong control for a dial.
      { l: "ZOOM", t: "keys", cw: combo([], "+"), ccw: combo([], "-"), m: 1 },
      // Shift+wheel is Live's documented horizontal scroll.
      { l: "SCRL", t: "scroll", axis: "v", mods: ["SHIFT"], m: 1 },
      VOL,
    ],
  },
  {
    id: "logic",
    group: "music",
    label: "Logic Pro",
    note: "Wheel-zoom the tracks area, step markers, nudge regions and undo.",
    slots: [
      // Apple documents Opt+Cmd+wheel as horizontal zoom — a real wheel
      // gesture, so it beats the key pair on an encoder.
      { l: "ZOOM", t: "scroll", axis: "v", mods: ["ALT", "WIN"], m: 1, b: BTN_SPACE },
      { l: "MARKER", t: "keys", cw: combo(["ALT"], "."), ccw: combo(["ALT"], ","), m: 1 },
      { l: "NUDGE", t: "keys", cw: combo(["ALT"], "right"), ccw: combo(["ALT"], "left"), m: 1 },
      UNDO,
      SCRL_V,
      VOL,
    ],
  },
  {
    id: "reaper",
    group: "music",
    label: "REAPER",
    note: "Edit cursor, zoom, track select, track volume and markers.",
    slots: [
      { l: "CURSOR", t: "keys", cw: combo([], "right"), ccw: combo([], "left"), m: 1, b: BTN_SPACE },
      { l: "ZOOM", t: "keys", cw: combo([], "="), ccw: combo([], "-"), m: 1 },
      { l: "TRACK", t: "keys", cw: combo([], "down"), ccw: combo([], "up"), m: 1 },
      // Reaper is the one DAW with a factory volume-nudge pair — this rides
      // the SELECTED track's fader, not the system volume.
      { l: "VOL", t: "keys", cw: combo(["ALT"], "up"), ccw: combo(["ALT"], "down"), m: 1 },
      { l: "MARKER", t: "keys", cw: combo([], "'"), ccw: combo([], ";"), m: 1 },
      UNDO,
    ],
  },
  {
    id: "flstudio",
    group: "music",
    label: "FL Studio",
    note: "Zoom, step patterns and channels, nudge notes in the piano roll.",
    slots: [
      { l: "ZOOM", t: "keys", cw: combo([], "page_up"), ccw: combo([], "page_down"), m: 1, b: BTN_SPACE },
      // Shift+wheel over the Channel Rack title bar changes pattern.
      { l: "PTRN", t: "scroll", axis: "v", mods: ["SHIFT"], m: 1 },
      { l: "CHAN", t: "keys", cw: combo([], "down"), ccw: combo([], "up"), m: 1 },
      { l: "NUDGE", t: "keys", cw: combo(["ALT"], "right"), ccw: combo(["ALT"], "left"), m: 1 },
      SCRL_V,
      VOL,
    ],
  },

  {
    id: "midimix",
    group: "music",
    label: "MIDI mixer (any DAW)",
    note: "Six MIDI-learnable knobs — wiggle one, click the parameter, done. Needs MIDI on.",
    slots: [
      // General MIDI's conventional controller numbers. With MIDI-learn the
      // exact number rarely matters; what matters is that the six are
      // DISTINCT, so each tile learns a different parameter. Relative by
      // default: an absolute knob jumps the moment the DAW disagrees with it.
      { l: "CUT", t: "midi_cc", cc: 74, ch: 0, mode: "rel_2c", m: 1 },
      { l: "RES", t: "midi_cc", cc: 71, ch: 0, mode: "rel_2c", m: 1 },
      { l: "VOL", t: "midi_cc", cc: 7, ch: 0, mode: "rel_2c", m: 1 },
      { l: "PAN", t: "midi_cc", cc: 10, ch: 0, mode: "rel_2c", m: 1 },
      { l: "VERB", t: "midi_cc", cc: 91, ch: 0, mode: "rel_2c", m: 1 },
      { l: "CHOR", t: "midi_cc", cc: 93, ch: 0, mode: "rel_2c", m: 1 },
    ],
  },

  // --- Reading ---
  {
    id: "pageturn",
    group: "read",
    label: "Sheet music page turner",
    note: "forScore and MobileSheets: turn the wheel to change page, press for next.",
    slots: [
      // Both apps ship with the arrow pairs bound to next/previous page, so
      // one encoder covers them with no setup. Space is forScore's next-page
      // key and has no previous counterpart, which is why it is the BUTTON
      // and not half of a turn pair.
      { l: "PAGE", t: "keys", cw: combo([], "right"), ccw: combo([], "left"), m: 1, b: BTN_SPACE },
      // For oversized scores shown taller than the screen.
      SCRL_V,
      VOL,
      null,
      null,
      null,
    ],
  },
];

/** A preset combo, resolved for the user's machine: the character it means
 * becomes the positional key that types it on the ACTIVE keyboard layout
 * (plus Shift/AltGr when the layout needs them to reach it). Multi-char
 * names (right, space, f5) are already positional and pass through. */
function resolveCombo(c: { mods: string[]; key: string }): { mods: string[]; key: string } {
  if ([...c.key].length !== 1) return c;
  const ks = charToKeystroke(c.key);
  if (!ks) return c; // not on this layout: keep the US position as a fallback
  const mods = [...c.mods];
  if (ks.shift && !mods.includes("SHIFT")) mods.push("SHIFT");
  // firmware MOD_NAME knows alt_gr; how Turkish-style layouts reach some chars
  if (ks.altgr && !mods.includes("ALT_GR")) mods.push("ALT_GR");
  return { mods, key: ks.key };
}

/** The preset's slots as an editable copy, resolved for this machine: Cmd
 * swapped for Ctrl on Windows/Linux, and every character shortcut translated
 * through the active keyboard layout (see resolveCombo). Deep-copied so
 * editing a slot never mutates the preset itself. */
export function encPresetSlots(p: EncPreset): (EncModuleSlot | null)[] {
  const fix = (mods: string[]) => mods.map((m) => (!IS_MAC && m === "WIN" ? "CTRL" : m));
  const combo = (c: { mods: string[]; key: string }) => resolveCombo({ ...c, mods: fix(c.mods) });
  return p.slots.map((s) => {
    if (!s) return null;
    const c = JSON.parse(JSON.stringify(s)) as EncModuleSlot;
    if (c.t === "keys") {
      if (c.cw) c.cw = combo(c.cw);
      if (c.ccw) c.ccw = combo(c.ccw);
    } else if ((c.t === "scroll" || c.t === "move") && c.mods) {
      c.mods = fix(c.mods);
    }
    if (c.b?.t === "combo") c.b = { t: "combo", ...combo(c.b) };
    return c;
  });
}

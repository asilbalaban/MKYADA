// Canonical assignments behind tests/fixtures/*.json — the app↔firmware
// contract corpus. Each entry is compiled by the real compileAssignment and
// must play cleanly in the firmware engine (firmware_sim_test.py section 5).
// Regenerate the JSON files with: npx tsx tests/gen_fixtures.ts
import { compileAssignment } from "../app/src/lib/macro-model";
import type { Assignment, MacroFile } from "../app/src/lib/types";

const recordedMacro: MacroFile = {
  format: "mkyada-macro",
  version: 2,
  name: "click-and-type",
  kind: "recorded",
  screen: { width: 1920, height: 1080 },
  events: [
    { delay: 0, type: "move", x: 960, y: 540 },
    { delay: 10, type: "button", action: "down", button: "left", x: 960, y: 540 },
    { delay: 30, type: "button", action: "up", button: "left", x: 960, y: 540 },
    { delay: 5, type: "key", action: "down", key: "m", vk: 77 },
    { delay: 20, type: "key", action: "up", key: "m", vk: 77 },
    { delay: 0, type: "scroll", dy: -2 },
    { delay: 50, type: "wait" },
  ],
};

export const CANONICAL: Record<string, Assignment> = {
  keystroke_f5: { kind: "keystroke", key: "f5" },
  combo_ctrl_shift_s: { kind: "combo", mods: ["CTRL", "SHIFT"], key: "s" },
  text_hello: { kind: "text", text: "Hello 123!" },
  media_play_pause: { kind: "media", usage: "play_pause" },
  recorded_click_type: { kind: "recorded", name: "click-and-type", macro: recordedMacro },
  launch_url: { kind: "launch", target: "https://example.com" },
  command_echo: { kind: "command", command: "echo hi" },
  sound_ding: { kind: "sound", file: "sounds/ding.mp3" },
  webhook_post: {
    kind: "webhook",
    url: "https://example.com/hook",
    method: "POST",
    headers: [{ name: "Content-Type", value: "application/json" }],
    body: '{"on":true}',
  },
  keystroke_restart_hold: {
    kind: "keystroke",
    key: "a",
    behavior: { on_repress: "restart", hold_repeat: true },
  },
  sequence_copy_paste: {
    kind: "sequence",
    steps: [
      { a: { kind: "combo", mods: ["CTRL"], key: "c" }, delayMs: 150 },
      { a: { kind: "combo", mods: ["CTRL"], key: "v" }, delayMs: 0 },
    ],
  },
};

/** Compile deterministically: the `created` timestamp is stripped. */
export function compileFixture(a: Assignment): MacroFile {
  const file = compileAssignment(a);
  if (!file) throw new Error("canonical fixture compiled to null");
  delete file.created;
  return file;
}

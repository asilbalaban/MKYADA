// Tracks whether a Dial module (kind "enc_module") is open on the device.
//
// The module is fully device-native: the firmware runs every slot as plain
// HID and swallows the local key macros while it owns the keypad. The app's
// only job is to do the same on its side — the btn stream keeps flowing, and
// without this flag profiles.tsx would run each slot-select press's
// computer-side assignment (launch apps, switch OBS scenes) on top of the
// module. Set from the device's ctx announce, cleared on menu_ev "close" and
// on disconnect (wheel-menu.tsx owns both edges).

let open = false;

export function setEncModuleOpen(v: boolean) {
  open = v;
}

export function isEncModuleOpen(): boolean {
  return open;
}

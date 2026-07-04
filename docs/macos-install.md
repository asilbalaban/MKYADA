# macOS installation

## Install

1. Download `MKYADA_<version>_universal.dmg` from the
   [latest release](https://github.com/asilbalaban/MKYADA/releases/latest)
   (one build for both Intel and Apple Silicon).
2. Open the DMG and drag **MKYADA** into **Applications**.

## First launch (unsigned app)

The app is not notarized with Apple (no paid developer certificate), so on
first launch macOS shows *"Apple could not verify MKYADA is free of malware"*
with only **Move to Trash / Done** buttons. Don't move it to trash — pick one
of these instead:

- Click **Done**, then open **System Settings → Privacy & Security**, scroll
  down to *"MKYADA was blocked…"* and click **Open Anyway** (recent macOS
  versions removed the old right-click → Open shortcut), **or**
- clear the quarantine flag once in Terminal:

  ```sh
  xattr -cr /Applications/MKYADA.app
  ```

## Permissions

The app guides you through this on first launch (a banner appears until
everything is set; full status lives in **Settings → macOS permissions** with
one-click buttons into System Settings):

| Permission | Needed for | Where |
|---|---|---|
| **Input Monitoring** | Recording macros (global keyboard/mouse capture) | System Settings → Privacy & Security → Input Monitoring |
| **Accessibility** | Local preview playback on this Mac | System Settings → Privacy & Security → Accessibility |
| Removable volume access | Writing configs/macros to the CIRCUITPY drive — macOS asks by itself on first write; click **Allow** | (automatic prompt) |

Notes:

- **No permissions are needed** to configure the keypad or to play macros
  through the device — hardware HID playback comes from the board itself.
- After flipping a toggle in System Settings, quit and reopen MKYADA if the
  status doesn't turn green by itself.
- macOS ties permissions to the app bundle: after updating to a new version
  you may need to re-approve Input Monitoring.

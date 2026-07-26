# Screenshot harness

Automated, hardware-free screenshots of every app screen for the docs pages and
the landing site — for **both** models (Core 6 and Vision 6), plus the Vision 6's
on-device OLED screens rendered by the firmware itself.

## Run

```bash
cd app
npx playwright install chromium   # one-time
npm run screenshots
```

Output:

- `docs/images/screens/<model>-<page>.png` — Devices, Setup, Keys, Recorder,
  Profiles and every Settings tab, for `core6` and `vision6` (+ `-wizard` when
  reachable). Settings' first tab keeps the plain `-settings` name the docs
  already link to; the rest are `-settings-<tab>`.
- `docs/images/oled/<screen>.png` — the nine device screens.

## How it works

The app is a Tauri desktop app: the frontend calls a Rust backend over
`invoke()` and can't render without it. Instead of driving a real device, the
harness boots the **Vite dev server** against a mock:

- [`mock-tauri.ts`](mock-tauri.ts) installs `window.__TAURI_INTERNALS__` via the
  official `@tauri-apps/api/mocks` and answers every `invoke()` with fixture
  data — a single keypad that auto-connects on launch.
- [`fixtures.ts`](fixtures.ts) builds a fully-populated Core 6 / Vision 6 config
  and compiles its key macros through the **same** compiler the app uses
  (`compileAssignment` / `serializeForDevice`), so the mocked drive serves
  exactly what a real device would.
- [`entry.html`](entry.html) loads the mock **before** `/src/main.tsx`, so the
  app's top-level `getCurrentWindow()` finds the internals it needs.
- [`capture.mjs`](capture.mjs) starts Vite, drives each screen with Playwright,
  and writes the PNGs. The Recorder shot arrives through the Keys page's "Edit
  in Recorder" button, so the editor is photographed with a macro in it rather
  than showing its empty state.

The OLED pictures do not go through the app at all.
[`scripts/render-oled.py`](../../scripts/render-oled.py) runs
`firmware/mkyada/oled.py` against the shipped `mkyada.fnt` through the software
displayio in `tests/`, writes the bitmaps to `oled-frames.js`, and
[`oled.html`](oled.html) only enlarges them behind a bezel. They were a
hand-drawn Courier mockup until v0.27.0, which stopped being honest the day the
firmware got its own font. CI re-runs the renderer and fails on a diff.

## Never shipped

This folder is dev-only scaffolding. `tsconfig` only includes `src`, and the
production build's HTML entry is `app/index.html`, so `mock-tauri` never reaches
`dist`. A CI guard (`.github/workflows/ci.yml`) fails the build if it ever does.

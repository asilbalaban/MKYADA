# Screenshot harness

Automated, hardware-free screenshots of every app screen for the docs pages and
the landing site — for **both** models (Core 6 and Vision 6), plus CSS mockups of
the Vision 6 on-device OLED screens.

## Run

```bash
cd app
npx playwright install chromium   # one-time
npm run screenshots
```

Output:

- `docs/images/screens/<model>-<page>.png` — Devices, Setup, Keys, Recorder,
  Profiles, Settings for `core6` and `vision6` (+ `-wizard` when reachable).
- `docs/images/oled/<screen>.png` — Home, Grid, Speed, Settings, About.

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
  and writes the PNGs.

## Never shipped

This folder is dev-only scaffolding. `tsconfig` only includes `src`, and the
production build's HTML entry is `app/index.html`, so `mock-tauri` never reaches
`dist`. A CI guard (`.github/workflows/ci.yml`) fails the build if it ever does.

// Automated screenshot harness. Boots a Vite dev server that serves the app
// against the mock-tauri IPC layer (a fully-populated fake keypad, no hardware),
// drives each screen with Playwright, and writes PNGs into docs/images/ for the
// docs pages and the landing site.
//
// Usage:  npm run screenshots            (both models + OLED mockups)
// Deps:   playwright (chromium).  Run `npx playwright install chromium` once.
//
// The harness is dev-only: it runs the Vite DEV server (which serves
// screenshots/entry.html + the mock), never a production build, so the
// "mock-tauri" scaffolding never touches dist. See the CI guard in ci.yml.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
const REPO = resolve(APP_DIR, "..");
const SCREENS_DIR = resolve(REPO, "docs/images/screens");
const OLED_DIR = resolve(REPO, "docs/images/oled");
const PORT = 1420;
const BASE = `http://localhost:${PORT}`;

const MODELS = ["core6", "vision6"];
// nav label -> extra settle for pages that stream data in
const PAGES = [
  { id: "devices", label: "Devices", settle: 500 },
  // Setup left the sidebar (issue #42); it opens from a button on Devices, and
  // like Settings it's tabbed — every tab gets its own shot.
  { id: "setup", label: "Setup", settle: 600, viaDevices: true, tabs: true },
  { id: "keys", label: "Keys", settle: 1400, selectKey: true },
  // The Recorder opens on an empty "record or import a macro to begin" state,
  // which is a poor advertisement for the page people are most curious about.
  // Hand it the fixture's recorded macro the way a user would — from the Keys
  // page's "Edit in Recorder" — so the shot shows the editor with events in it.
  { id: "recorder", label: "Recorder", settle: 700, viaHandoff: true },
  { id: "profiles", label: "Profiles", settle: 500 },
  // Settings is tabbed; every tab gets its own shot so the docs can walk the
  // whole page. The first one keeps the plain `-settings` name that README,
  // docs/ and the landing page already link to.
  { id: "settings", label: "Settings", settle: 500, tabs: true },
];
/** The fixture key whose assignment is a recorded macro (fixtures.ts). */
const RECORDED_KEY = /Post the clip/;
// Rendered by scripts/render-oled.py into screenshots/oled-frames.js — the
// firmware's own drawing code, so these are photographs of the device rather
// than an artist's impression of it.
const OLED_SHOTS = ["home", "grid", "speed", "settings", "about",
  "wheel-scene", "wheel-status", "wheel-volume", "menu-tr", "transfer"];

async function waitForServer(url, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error(`dev server never came up at ${url}`);
}

async function main() {
  await mkdir(SCREENS_DIR, { recursive: true });
  await mkdir(OLED_DIR, { recursive: true });

  console.log("· starting vite dev server…");
  // Run Vite's own JS entry under this node rather than going through `npx`.
  // On Windows npx is a .cmd, which spawn() either can't find (ENOENT) or
  // since Node 22 refuses outright (EINVAL) — the harness died before drawing
  // a single pixel, which is a good part of why the published shots went
  // stale. This path needs no shell and no PATH lookup at all.
  const vite = spawn(
    process.execPath,
    [
      resolve(APP_DIR, "node_modules/vite/bin/vite.js"),
      "--port",
      String(PORT),
      "--strictPort",
      "--clearScreen",
      "false",
    ],
    { cwd: APP_DIR, stdio: "inherit" },
  );
  const stopVite = () => {
    try {
      vite.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  };
  process.on("exit", stopVite);
  process.on("SIGINT", () => {
    stopVite();
    process.exit(1);
  });

  try {
    await waitForServer(BASE);
    const browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });

    for (const model of MODELS) {
      const page = await context.newPage();
      console.log(`\n· ${model}: loading app…`);
      await page.goto(`${BASE}/screenshots/entry.html?model=${model}`, {
        waitUntil: "networkidle",
      });
      // wait for the keypad to auto-connect (sidebar "connected" badge)
      await page.getByText("connected", { exact: false }).first().waitFor({ timeout: 20000 });

      for (const p of PAGES) {
        try {
          if (p.viaHandoff) {
            // Keys → the recorded key → "Edit in Recorder", which is exactly
            // the route a user takes and leaves the editor populated.
            await page.locator('nav[aria-label="Main"] button', { hasText: "Keys" }).click();
            await page.waitForTimeout(600);
            await page.getByRole("button", { name: RECORDED_KEY }).first().click();
            await page.waitForTimeout(300);
            await page.getByRole("button", { name: /Edit in Recorder/i }).click();
          } else if (p.viaDevices) {
            await page
              .locator('nav[aria-label="Main"] button', { hasText: "Devices" })
              .click();
            await page.waitForTimeout(400);
            await page.getByRole("button", { name: /^Setup$/ }).first().click();
          } else {
            await page
              .locator('nav[aria-label="Main"] button', { hasText: p.label })
              .click();
          }
          await page.waitForTimeout(p.settle);
          if (p.selectKey) {
            // open the assignment editor on key 1 for the richest single shot
            await page
              .getByRole("button", { name: /^Key 1 —/ })
              .first()
              .click()
              .catch(() => {});
            await page.waitForTimeout(400);
          }
          if (p.tabs) {
            const tabs = page.locator('[role="tab"]');
            const n = await tabs.count();
            for (let i = 0; i < n; i++) {
              const tab = tabs.nth(i);
              // ids are `<page>-tab-<section>` (the Tabs component's idPrefix)
              const id = (await tab.getAttribute("id"))?.replace(`${p.id}-tab-`, "") ?? String(i);
              await tab.click();
              await page.waitForTimeout(350);
              const name = i === 0 ? `${model}-${p.id}` : `${model}-${p.id}-${id}`;
              await page.screenshot({ path: resolve(SCREENS_DIR, `${name}.png`) });
              console.log(`  ✓ ${name}.png`);
            }
            continue;
          }
          const out = resolve(SCREENS_DIR, `${model}-${p.id}.png`);
          await page.screenshot({ path: out });
          console.log(`  ✓ ${model}-${p.id}.png`);
        } catch (e) {
          console.warn(`  ✗ ${model}-${p.id}: ${e.message}`);
        }
      }

      // best-effort: the "set up a new board" provisioning wizard
      try {
        await page.locator('nav[aria-label="Main"] button', { hasText: "Devices" }).click();
        await page.waitForTimeout(300);
        await page.getByRole("button", { name: /set up a new board/i }).first().click();
        await page.waitForTimeout(600);
        await page.screenshot({ path: resolve(SCREENS_DIR, `${model}-wizard.png`) });
        console.log(`  ✓ ${model}-wizard.png`);
      } catch (e) {
        console.warn(`  ✗ ${model}-wizard (optional): ${e.message}`);
      }

      await page.close();
    }

    // Vision 6 on-device screens, straight from the firmware renderer
    console.log(`\n· OLED screens…`);
    const oled = await context.newPage();
    await oled.goto(`${BASE}/screenshots/oled.html`, { waitUntil: "networkidle" });
    // the bitmaps are decoded with createImageBitmap, which resolves a tick
    // after load — wait for the last one to actually be on its canvas
    await oled.locator(`#oled-${OLED_SHOTS[OLED_SHOTS.length - 1]} canvas`).waitFor();
    await oled.waitForTimeout(600);
    for (const id of OLED_SHOTS) {
      try {
        const el = oled.locator(`#oled-${id}`);
        await el.screenshot({ path: resolve(OLED_DIR, `${id}.png`) });
        console.log(`  ✓ oled/${id}.png`);
      } catch (e) {
        console.warn(`  ✗ oled/${id}: ${e.message}`);
      }
    }
    await oled.close();

    await browser.close();
    console.log("\n✓ screenshots written to docs/images/{screens,oled}/");
  } finally {
    stopVite();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

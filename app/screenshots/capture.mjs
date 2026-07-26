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
  { id: "setup", label: "Setup", settle: 600 },
  { id: "keys", label: "Keys", settle: 1400, selectKey: true },
  { id: "recorder", label: "Recorder", settle: 500 },
  { id: "profiles", label: "Profiles", settle: 500 },
  { id: "settings", label: "Settings", settle: 500 },
];
const OLED_SHOTS = ["home", "grid", "speed", "settings", "about",
  "wheel-scene", "wheel-status", "wheel-volume"];

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
  const vite = spawn(
    "npx",
    ["vite", "--port", String(PORT), "--strictPort", "--clearScreen", "false"],
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
          await page
            .locator('nav[aria-label="Main"] button', { hasText: p.label })
            .click();
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

    // OLED mockups (Vision 6 on-device screens)
    console.log(`\n· OLED mockups…`);
    const oled = await context.newPage();
    await oled.goto(`${BASE}/screenshots/oled.html`, { waitUntil: "networkidle" });
    await oled.waitForTimeout(300);
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

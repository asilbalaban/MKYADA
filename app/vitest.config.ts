import { defineConfig } from "vitest/config";

// Standalone vitest config: the lib tests are pure TypeScript, so we skip
// the React/Tailwind plugins (and the Tauri dev-server constraints) that
// vite.config.ts carries.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

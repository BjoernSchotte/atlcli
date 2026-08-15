import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "action-palette.e2e.ts",
  outputDir: join(tmpdir(), "atlcli-action-palette-playwright"),
  timeout: 120_000,
  workers: 1,
  retries: 0,
  projects: [
    { name: "production", grepInvert: /capability-missing/u },
    { name: "missing-capability", grep: /capability-missing/u },
  ],
  use: { trace: "retain-on-failure" },
});

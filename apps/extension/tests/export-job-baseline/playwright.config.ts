import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "baseline.e2e.ts",
  outputDir: join(tmpdir(), "atlcli-export-job-baseline-playwright"),
  timeout: 45 * 60_000,
  workers: 1,
  retries: 0,
  reporter: "line",
});

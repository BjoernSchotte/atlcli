import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "raster-quality.e2e.ts",
  outputDir: process.env.ATLCLI_RASTER_QUALITY_OUTPUT_DIR
    ?? join(tmpdir(), "atlcli-raster-quality-playwright"),
  timeout: 180_000,
  workers: 1,
  retries: 0,
  reporter: "line",
});

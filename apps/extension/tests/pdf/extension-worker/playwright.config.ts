import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "worker.e2e.ts",
  outputDir: join(tmpdir(), "atlcli-extension-worker-playwright"),
  timeout: 120_000,
  workers: 1,
});

import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "memory.e2e.ts",
  outputDir: join(tmpdir(), "atlcli-extension-memory-playwright"),
  timeout: 240_000,
  workers: 1,
  retries: 0,
  reporter: "line",
});

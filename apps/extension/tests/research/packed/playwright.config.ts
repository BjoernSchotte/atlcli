import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "research.e2e.ts",
  outputDir: join(tmpdir(), "atlcli-research-playwright"),
  timeout: 180_000,
  workers: 1,
  retries: 0,
  use: { trace: "retain-on-failure" },
});

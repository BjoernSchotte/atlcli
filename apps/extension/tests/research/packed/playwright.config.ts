import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import { browserEvidenceSuiteDir } from "../../support/packed-browser-evidence.js";

export default defineConfig({
  testDir: ".",
  testMatch: "research.e2e.ts",
  outputDir: join(tmpdir(), "atlcli-research-playwright"),
  timeout: 180_000,
  workers: 1,
  retries: 0,
  reporter: [
    ["line"],
    ["junit", { outputFile: join(browserEvidenceSuiteDir("research"), "junit.xml") }],
  ],
});

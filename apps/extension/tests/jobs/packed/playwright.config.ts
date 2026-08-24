import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import { browserEvidenceSuiteDir } from "../../support/packed-browser-evidence.js";

export default defineConfig({
  testDir: ".",
  testMatch: "job-recovery.e2e.ts",
  outputDir: join(tmpdir(), "atlcli-export-jobs-playwright"),
  timeout: 180_000,
  workers: 1,
  retries: 0,
  reporter: [
    ["line"],
    ["junit", { outputFile: join(browserEvidenceSuiteDir("jobs"), "junit.xml") }],
  ],
});

import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "viewer.e2e.ts",
  outputDir: join(tmpdir(), "atlcli-extension-viewer-playwright"),
  timeout: 120_000,
  use: {
    baseURL: "http://127.0.0.1:4181/",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "bunx vite --config vite.config.ts --host 127.0.0.1 --port 4181",
    cwd: import.meta.dirname,
    url: "http://127.0.0.1:4181/",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

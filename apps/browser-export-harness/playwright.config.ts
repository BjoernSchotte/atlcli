import { defineConfig, devices } from "@playwright/test";

const port = 4179;
const mountUrl = `http://127.0.0.1:${port}/browser-export-harness/`;
const browserChannel = process.env.ATLCLI_PLAYWRIGHT_CHANNEL as
  | "chrome"
  | "chromium"
  | undefined;

export default defineConfig({
  testDir: "./tests",
  testMatch: ["exports.e2e.ts", "highlight-performance.e2e.ts"],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 60_000 },
  reporter: "line",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: mountUrl,
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun scripts/serve-dist.ts",
    url: mountUrl,
    timeout: 30_000,
    reuseExistingServer: false,
    env: { ATLCLI_HARNESS_PORT: String(port) },
  },
  projects: [{
    name: "chromium",
    use: {
      browserName: "chromium",
      ...(browserChannel ? { channel: browserChannel } : {}),
    },
  }],
});

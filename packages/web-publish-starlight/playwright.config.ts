import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.ATLCLI_WEB_PUBLISH_VISUAL_PORT ?? "4387");
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("ATLCLI_WEB_PUBLISH_VISUAL_PORT must be a valid TCP port.");
}

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: "line",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${port}/`,
    headless: true,
    trace: "off",
  },
  webServer: {
    command: "bun scripts/serve-visual-fixtures.ts",
    url: `http://127.0.0.1:${port}/starlight/`,
    timeout: 30_000,
    reuseExistingServer: false,
    env: { ATLCLI_WEB_PUBLISH_VISUAL_PORT: String(port) },
  },
});

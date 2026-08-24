import { join, resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.ATLCLI_HARNESS_PORT ?? "4179");
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("ATLCLI_HARNESS_PORT must be a valid TCP port.");
}
const mountUrl = `http://127.0.0.1:${port}/browser-export-harness/`;
const browserChannel = process.env.ATLCLI_PLAYWRIGHT_CHANNEL as
  | "chrome"
  | "chromium"
  | undefined;
const evidenceDir = resolve(
  process.env.ATLCLI_BROWSER_EVIDENCE_DIR ??
    join(import.meta.dirname, "../../.artifacts/browser-evidence/neutral"),
);

export default defineConfig({
  testDir: "./tests",
  testMatch: ["exports.e2e.ts", "highlight-performance.e2e.ts"],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 60_000 },
  reporter: [
    ["line"],
    ["junit", { outputFile: join(evidenceDir, "junit.xml") }],
  ],
  outputDir: join(evidenceDir, ".playwright"),
  use: {
    ...devices["Desktop Chrome"],
    baseURL: mountUrl,
    headless: true,
    trace: {
      mode: "retain-on-failure",
      screenshots: true,
      snapshots: true,
      sources: false,
    },
    screenshot: "only-on-failure",
    video: "retain-on-failure",
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
